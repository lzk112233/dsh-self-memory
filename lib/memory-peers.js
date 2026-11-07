// 设备网：知道"另一台机器现在在不在线"，以及"让它替我干活，把结果拿回来"。
//
// 为什么不用主仓库：vault 是数据面（对话原文、事实、归档），量小但内容重要，
// 每推一次都是一个真提交。而在线心跳是控制面，几十秒一次，如果也进主仓库，
// 一天就是上千个提交，历史立刻烂掉。
//
// 所以这里另开一个极小的 git 仓库（.sync/peers），规则只有一条：
//   **每个设备只写自己的一条分支，永远单提交，永远 force push。**
//   refs/heads/peer/<deviceId>
//     peers/<deviceId>.json   心跳：我是谁、什么时候还活着（在线判定就靠它）
//     tasks/<deviceId>.json   我发出去、等别人执行的任务
//     done/<deviceId>.json    我替别人执行完的结果
//
// 这样：分支数恒定 = 设备数，每个分支永远 1 个提交，仓库不会随心跳膨胀；
// 谁也写不到别人的分支，所以不存在 push 冲突，不需要合并、不需要重试。
// 读取 = fetch 所有 peer/* 分支，各自解自己那三个文件。
//
// 内容全部用 master.key 加密（SMB1 / AES-256-GCM）：能解开 = 是自己人，
// 解不开 = 别人的仓库或者 key 不对。选哪台、信哪条，由密码学判定，不由分支名判定。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn, spawnSync } from 'node:child_process'
import { loadOrCreateKey, encryptJson, decryptJson } from './memory-crypto.js'
import { syncPaths, readSyncConfig, writeSyncConfig, authedRemote } from './memory-sync.js'
import { withSyncLock } from './memory-lock.js'

const PEER_PREFIX = 'peer/'
const FETCH_TIMEOUT = 15000
const PUSH_TIMEOUT = 30000
const RESULT_KEEP_MS = 7 * 24 * 3600 * 1000
const TASK_KEEP_MS = 7 * 24 * 3600 * 1000
const OUT_MAX = 20000

export const DEFAULT_PRESENCE_TTL = 300 // 5 分钟内算在线
export const DEFAULT_PEER_INTERVAL = 90 // 心跳/轮询间隔（秒）

export function peerPaths(root) {
  const { syncDir } = syncPaths(root)
  const dir = path.join(syncDir, 'peers')
  return {
    dir,
    stateFile: path.join(syncDir, 'peers-state.json'),
    idFile: path.join(syncDir, 'device-id'),
    dirOf: (kind, id) => path.join(dir, kind, `${id}.json`)
  }
}

function git(cwd, args, { timeout = FETCH_TIMEOUT, buffer = false } = {}) {
  const r = spawnSync('git', args, {
    cwd,
    timeout,
    encoding: buffer ? 'buffer' : 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  })
  return {
    ok: r.status === 0,
    out: buffer ? r.stdout : `${r.stdout ?? ''}${r.stderr ?? ''}`.trim()
  }
}

/** 稳定设备 id：主机名 + 一次性后缀，存本地，换了也不会漂。 */
export function deviceId(root) {
  const p = peerPaths(root)
  try {
    const saved = fs.readFileSync(p.idFile, 'utf8').trim()
    if (saved) return saved
  } catch {}
  const host = String(os.hostname() || 'host')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 20) || 'host'
  const id = `${host}-${Math.random().toString(36).slice(2, 6)}`
  fs.mkdirSync(path.dirname(p.idFile), { recursive: true })
  fs.writeFileSync(p.idFile, id, 'utf8')
  writeSyncConfig(root, { deviceId: id })
  return id
}

function ensureRepo(root) {
  const p = peerPaths(root)
  if (!fs.existsSync(path.join(p.dir, '.git'))) {
    fs.mkdirSync(p.dir, { recursive: true })
    git(p.dir, ['init', '-q'])
    git(p.dir, ['checkout', '-q', '-b', 'main'])
  }
  return p
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8')
}

function readState(root) {
  return readJson(peerPaths(root).stateFile) ?? { peers: {}, executed: {}, seen: {} }
}

function writeState(root, patch) {
  const next = { ...readState(root), ...patch }
  writeJson(peerPaths(root).stateFile, next)
  return next
}

// ── 本机自己那份：心跳 / 我发出去的任务 / 我执行完的结果 ──────────
function readEnc(root, file, key) {
  try {
    return decryptJson(key, fs.readFileSync(file))
  } catch {
    return null
  }
}

function writeEnc(file, key, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, encryptJson(key, value))
}

function selfSnapshot(root, key, { ttlSeconds = DEFAULT_PRESENCE_TTL, note = '' } = {}) {
  const me = deviceId(root)
  const p = peerPaths(root)
  const presence = readEnc(root, p.dirOf('peers', me), key) ?? {
    v: 1,
    device: me,
    createdAt: Date.now()
  }
  // at 按 30 秒取整：同一次心跳周期内不重复写，省一次 push
  const bucket = Math.floor(Date.now() / 30000) * 30000
  const next = {
    ...presence,
    v: 1,
    device: me,
    host: os.hostname(),
    platform: `${os.platform()} ${os.release()}`,
    node: process.version,
    ttl: Math.max(60, Number(ttlSeconds) || DEFAULT_PRESENCE_TTL),
    at: bucket,
    note: String(note ?? '').slice(0, 120)
  }
  const tasks = readEnc(root, p.dirOf('tasks', me), key) ?? { v: 1, device: me, tasks: [] }
  const done = readEnc(root, p.dirOf('done', me), key) ?? { v: 1, device: me, results: [] }
  return { me, presence: next, tasks, done }
}

/** 把本机三份文件落盘并推到自己那条分支。内容没变就不推。 */
export function peersPush(root, { ttlSeconds, note, reason = 'heartbeat' } = {}) {
  const cfg = readSyncConfig(root)
  if (!cfg.remote) return { pushed: false, reason: 'no-remote' }
  const key = loadOrCreateKey(syncPaths(root).keyPath)

  const run = () => {
    const p = ensureRepo(root)
    const snap = selfSnapshot(root, key, { ttlSeconds, note })
    const now = Date.now()

    // 结果和任务只留 7 天，否则这份分支会一直长大（虽然只有一个提交，但内容会膨胀）
    snap.tasks.tasks = (snap.tasks.tasks ?? []).filter((t) => now - Number(t?.createdAt ?? now) < TASK_KEEP_MS)
    snap.done.results = (snap.done.results ?? []).filter(
      (r) => now - Number(r?.finishedAt ?? r?.createdAt ?? now) < RESULT_KEEP_MS
    )

    const files = [
      [p.dirOf('peers', snap.me), snap.presence],
      [p.dirOf('tasks', snap.me), snap.tasks],
      [p.dirOf('done', snap.me), snap.done]
    ]
    let changed = false
    for (const [file, value] of files) {
      const body = JSON.stringify(value)
      let prev = null
      try {
        prev = JSON.stringify(decryptJson(key, fs.readFileSync(file)))
      } catch {
        prev = null
      }
      if (prev === body) continue // 工作区里已经是这个内容，不用重写（密文带随机 IV，重写会白造一次变更）
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, encryptJson(key, value))
      changed = true
    }

    // 注意：即使这里 changed=false 也要往下走。发任务时文件是调用方先写的，
    // 工作区已经是新内容 → "要不要推" 只有和 HEAD 比才判得出来。
    void changed
    git(p.dir, ['add', '-A'])
    // 工作区变了不等于和 HEAD 有差异（比如发任务时外面已经写过盘）：让 git 自己判
    const staged = git(p.dir, ['diff', '--cached', '--name-only'])
    if (!staged.out) return { pushed: false, reason: 'no-change', device: snap.me }
    const hasHead = git(p.dir, ['rev-parse', '--verify', '-q', 'HEAD']).ok
    // 永远单提交：有 HEAD 就 amend，历史恒定 1 个
    const commitArgs = hasHead
      ? ['-c', 'user.name=self-memory', '-c', 'user.email=memory@localhost', 'commit', '-q', '--amend', '--no-edit']
      : ['-c', 'user.name=self-memory', '-c', 'user.email=memory@localhost', 'commit', '-q', '-m', `peer ${snap.me}`]
    const c = git(p.dir, commitArgs)
    if (!c.ok && !/nothing to commit|no changes/i.test(c.out)) {
      return { pushed: false, reason: 'commit-failed', message: c.out.slice(0, 200), device: snap.me }
    }

    const push = git(
      p.dir,
      ['push', '-q', '--force', authedRemote(root, cfg.remote), `HEAD:refs/heads/${PEER_PREFIX}${snap.me}`],
      { timeout: PUSH_TIMEOUT }
    )
    if (!push.ok) return { pushed: false, reason: 'push-failed', message: push.out.slice(0, 200), device: snap.me }
    return { pushed: true, reason, device: snap.me, at: snap.presence.at }
  }

  const locked = withSyncLock(root, run)
  return locked.skipped ? { pushed: false, reason: 'locked' } : locked.result
}

/**
 * 拉所有设备的分支，解出各自的心跳 / 任务 / 结果。
 * 别人的密文解不开就说明那条不是我们的（或者 key 不对），直接跳过，不抛错。
 */
export function peersFetch(root, { ttlSeconds } = {}) {
  const cfg = readSyncConfig(root)
  if (!cfg.remote) return { ok: false, reason: 'no-remote', peers: [] }
  const key = loadOrCreateKey(syncPaths(root).keyPath)
  const me = deviceId(root)
  const p = ensureRepo(root)

  const run = () => {
    const url = authedRemote(root, cfg.remote)
    const fetch = git(p.dir, ['fetch', '-q', '--prune', url, `+refs/heads/${PEER_PREFIX}*:refs/remotes/peers/*`], {
      timeout: FETCH_TIMEOUT
    })
    const offline = !fetch.ok

    const refs = git(p.dir, ['for-each-ref', '--format=%(refname)', 'refs/remotes/peers/'])
    const branches = refs.ok
      ? refs.out.split('\n').map((s) => s.trim()).filter(Boolean)
      : []

    const peers = []
    const inbox = []
    const results = []
    const now = Date.now()

    for (const ref of branches) {
      // refs/remotes/peers/<deviceId>
      const id = ref.slice('refs/remotes/peers/'.length)
      if (!id) continue
      const pick = (kind) => {
        const r = git(p.dir, ['cat-file', '-p', `${ref}:${kind}/${id}.json`], { buffer: true })
        if (!r.ok || !r.out?.length) return null
        try {
          return decryptJson(key, r.out)
        } catch {
          return null // 别人的仓库 / key 不匹配
        }
      }
      const presence = pick('peers')
      const tasks = pick('tasks')
      const done = pick('done')
      if (presence) {
        const ttl = Number(ttlSeconds) || Number(presence.ttl) || DEFAULT_PRESENCE_TTL
        const age = now - Number(presence.at ?? 0)
        peers.push({
          device: presence.device ?? id,
          host: presence.host ?? '',
          platform: presence.platform ?? '',
          node: presence.node ?? '',
          at: Number(presence.at ?? 0),
          ageMs: age,
          ttlMs: ttl * 1000,
          online: age < ttl * 1000,
          self: (presence.device ?? id) === me,
          note: presence.note ?? ''
        })
      }
      for (const t of tasks?.tasks ?? []) {
        if (!t?.id) continue
        const to = String(t.to ?? '*')
        if (to !== '*' && to !== me) continue
        if (to === me && t.from === me) continue
        inbox.push({ ...t, from: t.from ?? id })
      }
      for (const r of done?.results ?? []) {
        if (r?.taskId) results.push({ ...r, by: r.by ?? id })
      }
    }

    // 本机自己那条也可能在 refs 里（fetch 自己的分支），上面已按 self 标记
    const state = writeState(root, { lastFetchAt: now, offline })
    const executed = state.executed ?? {}
    const doneIds = new Set(results.map((r) => String(r.taskId)))
    const pending = inbox.filter((t) => {
      if (doneIds.has(String(t.id))) return false
      const startedAt = Number(executed[t.id] ?? 0)
      if (!startedAt) return true
      // 已经开始跑但一直没结果：过了它自己的超时预算还空着，就当那次执行已经死了，允许重跑
      const budget = (Number(t.timeoutSeconds) || 900) * 1000 + 120000
      return now - startedAt > budget
    })

    return {
      ok: !offline,
      offline,
      peers: peers.sort((a, b) => Number(b.online) - Number(a.online) || b.at - a.at),
      inbox: pending.sort((a, b) => Number(a.createdAt ?? 0) - Number(b.createdAt ?? 0)),
      results: results.sort((a, b) => Number(b.finishedAt ?? 0) - Number(a.finishedAt ?? 0)),
      at: now
    }
  }

  const locked = withSyncLock(root, run)
  return locked.skipped
    ? { ok: false, reason: 'locked', peers: [], inbox: [], results: [] }
    : locked.result
}

// ── 任务：我发出去 / 我执行 ─────────────────────────────────────

export function sendTask(root, { to = '*', task, timeoutSeconds = 900, mode = 'headless' } = {}) {
  const text = String(task ?? '').trim()
  if (!text) throw new Error('task 不能为空')
  const cfg = readSyncConfig(root)
  if (!cfg.remote) throw new Error('还没绑定云端仓库：多设备协同要靠它当中转，先 node sync.mjs connect 或 init')

  const me = deviceId(root)
  const key = loadOrCreateKey(syncPaths(root).keyPath)
  const p = ensureRepo(root)
  const file = p.dirOf('tasks', me)
  const box = readEnc(root, file, key) ?? { v: 1, device: me, tasks: [] }
  const id = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const rec = {
    id,
    from: me,
    to: String(to ?? '*').trim() || '*',
    task: text.slice(0, 8000),
    mode: mode === 'inbox' ? 'inbox' : 'headless',
    timeoutSeconds: Math.max(30, Math.min(3600, Number(timeoutSeconds) || 900)),
    createdAt: Date.now(),
    state: 'sent'
  }
  box.tasks = [...(box.tasks ?? []), rec]
  writeEnc(file, key, box)
  // 立刻推一次，别等下一个心跳周期
  const pushed = peersPush(root, { reason: 'task-sent' })
  return { ...rec, pushed }
}

export function tasksOf(root) {
  const me = deviceId(root)
  const key = loadOrCreateKey(syncPaths(root).keyPath)
  const box = readEnc(root, peerPaths(root).dirOf('tasks', me), key) ?? { tasks: [] }
  const done = readEnc(root, peerPaths(root).dirOf('done', me), key) ?? { results: [] }
  const state = readState(root)
  return (box.tasks ?? []).map((t) => ({
    ...t,
    state: (done.results ?? []).some((r) => r.taskId === t.id) ? 'done' : state.executed?.[t.id] ? 'running' : t.state
  }))
}

export function recordResult(root, result) {
  const me = deviceId(root)
  const key = loadOrCreateKey(syncPaths(root).keyPath)
  const p = ensureRepo(root)
  const file = p.dirOf('done', me)
  const box = readEnc(root, file, key) ?? { v: 1, device: me, results: [] }
  box.results = [
    ...(box.results ?? []).filter((r) => r.taskId !== result.taskId),
    { v: 1, by: me, finishedAt: Date.now(), ...result }
  ]
  writeEnc(file, key, box)
  const state = readState(root)
  writeState(root, { executed: { ...(state.executed ?? {}), [result.taskId]: Date.now() } })
  return peersPush(root, { reason: 'result-ready' })
}

export function markRunning(root, taskId) {
  const state = readState(root)
  writeState(root, { executed: { ...(state.executed ?? {}), [taskId]: Date.now() } })
}

/** 结果按 taskId 索引；超过 7 天的忽略。 */
export function resultsByTask(root, peersResult) {
  const map = new Map()
  for (const r of peersResult?.results ?? []) map.set(String(r.taskId), r)
  return map
}

// ── 执行：在目标机器上真跑一次 headless 会话 ───────────────────
// 这里不用主线程 spawnSync：一次 headless 跑几分钟，spawnSync 会把整个事件循环冻住。
// 用异步 spawn，随时可被超时杀掉。
/**
 * headless profile 起不来最常见的原因不是模型不对，而是拿不到 key：
 * 桌面端着的是 GUI 会话里的凭据服务，`dsh --profile headless` 读不到。
 * 所以这里把 ~/.dsh/.credentials.yaml 的 refs 段直接读成环境变量传下去
 * （同一台机器、同一个用户，本来就是这份进程能读到的东西）。
 */
export function credentialEnv(file) {
  const out = {}
  let raw = ''
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return out
  }
  let inRefs = false
  for (const line of raw.split('\n')) {
    if (/^refs:\s*$/.test(line)) {
      inRefs = true
      continue
    }
    if (!inRefs) continue
    if (/^\S/.test(line)) break // 出了 refs 段
    const m = /^\s+([A-Z0-9_]+):\s*(.+)$/.exec(line)
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
  }
  return out
}

/**
 * dsh.cmd 在 Windows 上只是个壳：它用 install 目录下的 "DeepSeek Harness.exe"
 * 加上 ELECTRON_RUN_AS_NODE=1 去跑 app.asar 里的 cli.js。
 * 直接 spawn 那个 exe 就绕开了 cmd 的引号地狱（安装路径里带空格，交给 cmd /c 很容易被截断）。
 */
export function resolveDshLaunch(dshBin) {
  const bin = String(dshBin ?? '')
  if (!/\.(cmd|bat)$/i.test(bin)) return { exe: bin, prefix: [] }
  const binDir = path.dirname(bin)
  const exe = path.resolve(binDir, '../../../../DeepSeek Harness.exe')
  // app.asar 是归档文件：cli.js 在里面，只有 Electron 自己（RUN_AS_NODE）能读，
  // 普通 Node 的 fs.existsSync 对这条路径永远返回 false，所以只校验 exe。
  const cliJs = path.resolve(binDir, '../../../app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js')
  if (fs.existsSync(exe)) {
    return { exe, prefix: ['--expose-internals', cliJs], runAsNode: true }
  }
  return { exe: bin, prefix: [], shell: true }
}

export function runHeadless(task, { dshBin, profile = 'headless', timeoutMs = 900000, cwd, extraEnv = {} } = {}) {
  return new Promise((resolve) => {
    const started = Date.now()
    let out = ''
    let err = ''
    let settled = false
    const finish = (payload) => {
      if (settled) return
      settled = true
      resolve({ ...payload, startedAt: started, finishedAt: Date.now(), durationMs: Date.now() - started })
    }

    if (!dshBin) return finish({ ok: false, exitCode: null, out: '', err: '找不到 dsh 可执行文件' })

    let child
    try {
      const launch = resolveDshLaunch(dshBin)
      const safeProfile = String(profile).replace(/[^a-zA-Z0-9._-]/g, '') || 'headless'
      const childEnv = { ...process.env, ...extraEnv }
      if (launch.runAsNode) childEnv.ELECTRON_RUN_AS_NODE = '1'
      child = spawn(launch.exe, [...(launch.prefix ?? []), '--profile', safeProfile, '-'], {
        cwd,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: launch.shell === true,
        env: childEnv
      })
    } catch (error) {
      return finish({ ok: false, exitCode: null, out: '', err: String(error?.message ?? error) })
    }

    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch {}
      finish({
        ok: false,
        exitCode: null,
        out: out.slice(0, OUT_MAX),
        err: `${err}\n[超时 ${Math.round(timeoutMs / 1000)}s，已终止]`.trim().slice(0, OUT_MAX)
      })
    }, timeoutMs)

    child.stdout?.on('data', (d) => {
      if (out.length < OUT_MAX) out += d.toString('utf8')
    })
    child.stderr?.on('data', (d) => {
      if (err.length < 8000) err += d.toString('utf8')
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      finish({ ok: false, exitCode: null, out: out.slice(0, OUT_MAX), err: String(e?.message ?? e) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      finish({
        ok: code === 0,
        exitCode: code,
        out: out.slice(0, OUT_MAX),
        err: err.slice(0, 8000)
      })
    })

    try {
      child.stdin?.write(String(task))
      child.stdin?.end()
    } catch {}
  })
}

export function peerHint(peers) {
  const others = (peers ?? []).filter((p) => !p.self)
  if (!others.length) return ''
  const online = others.filter((p) => p.online)
  if (!online.length) {
    const last = others.map((p) => p.at).sort((a, b) => b - a)[0]
    const mins = Math.round((Date.now() - last) / 60000)
    return `【设备】${others.length} 台设备在这个仓库里，但现在都不在线（最近一次心跳在 ${mins} 分钟前）。`
  }
  return [
    `【设备】在线 ${online.length} 台：`,
    ...online.map((p) => {
      const secs = Math.max(0, Math.round(p.ageMs / 1000))
      return `- ${p.device}（${p.host}，${p.platform}）心跳 ${secs} 秒前`
    }),
    '要让它们干活用 self_memory_remote action=send target=<device> task=<话>；结果用 action=result 取。'
  ].join('\n')
}
