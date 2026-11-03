// 云端同步核心：加密 vault → git 私有仓库；拉取 → 解密 → 与本地合并。
// 插件与 CLI 共用这一份逻辑，仓库里永远只有密文。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { loadOrCreateKey, encryptJson, decryptJson } from './memory-crypto.js'
import { collectVault, mergeVault, applyVault, applyIncremental, countVault } from './memory-vault.js'
import { listSegments, segmentName, writeSegment, readSegment, writeSmall, readSmall, segmentDir, SEG_RE } from './memory-segments.js'
import { ARCHIVE_SMALL, readArchive, writeArchive, mergeArchive, syncFromDsh } from './memory-archive.js'
import { withSyncLock } from './memory-lock.js'

const README = `# self-memory vault

这份仓库里只有密文（SMB1 / AES-256-GCM），没有任何可读的对话内容。

- \`segments/*.enc\` = 每次推送新增的那部分对话（一个段一次增量，不会重传历史）
- \`facts.enc\` = 长期事实库
- \`self-notes.enc\` = 自我认知
- \`env.enc\` = 插件环境清单（换机器时靠它把插件补回来）

密钥只存在于写入方的本机：\`~/.dsh/self-memory/.sync/master.key\`。
没有这把 key，clone 下来也只是一串二进制。唯一的读取途径：DSH 的 \`dsh-self-memory\` 插件执行 \`pull\` 解密。
`

const GITIGNORE = [
  '# 任何明文都不许进仓库',
  '*.jsonl',
  'master.key',
  '*.key',
  'node_modules/',
  ''
].join('\n')

export function syncPaths(root) {
  const syncDir = path.join(root, '.sync')
  return {
    syncDir,
    repoDir: path.join(syncDir, 'repo'),
    keyPath: path.join(syncDir, 'master.key'),
    configPath: path.join(syncDir, 'config.json'),
    vaultFile: path.join(syncDir, 'repo', 'vault.enc'),
    readmeFile: path.join(syncDir, 'repo', 'README.md'),
    gitignoreFile: path.join(syncDir, 'repo', '.gitignore')
  }
}

export function readSyncConfig(root) {
  const { configPath } = syncPaths(root)
  try { return JSON.parse(fs.readFileSync(configPath, 'utf8')) } catch { return {} }
}

export function writeSyncConfig(root, patch) {
  const { configPath, syncDir } = syncPaths(root)
  const next = { ...readSyncConfig(root), ...patch }
  fs.mkdirSync(syncDir, { recursive: true })
  fs.writeFileSync(configPath, JSON.stringify(next, null, 2), 'utf8')
  return next
}

function git(cwd, args, { allowFail = false, timeout = 0 } = {}) {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: timeout || undefined,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo' }
  })
  // 超时/没网时别让它挂几分钟：spawnSync 杀掉进程后 status 为 null，error.code = ETIMEDOUT
  if (r.error && (r.error.code === 'ETIMEDOUT' || r.error.code === 'ENOENT')) {
    const out = r.error.code === 'ENOENT' ? 'git 不可用' : `ETIMEDOUT 超时（${Math.round((timeout || 0) / 1000)}s）`
    if (allowFail) return { ok: false, out }
    throw new Error(`git ${args.join(' ')} 失败：${out}`)
  }
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim()
  if (r.status !== 0 && !allowFail) {
    throw new Error(`git ${args.join(' ')} 失败（${r.status}）：${out || '无输出'}`)
  }
  return { ok: r.status === 0, out }
}

// ── 同步失败提示：网络类 vs 其他 ────────────────────────────────
// 用户没开代理时最常见，要跟"key 不对/仓库权限"区分开，提示才有意义。
const NETWORK_HINT = /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|could not resolve|failed to connect|connection reset|connection refused|network is unreachable|timed out|TLS|SSL|handshake|proxy|socket hang up|unable to access|early EOF|RPC failed/i

export function noticePath(root) {
  return path.join(syncPaths(root).syncDir, 'notice.json')
}

export function readNotice(root) {
  try {
    const rec = JSON.parse(fs.readFileSync(noticePath(root), 'utf8'))
    return rec && rec.at ? rec : null
  } catch {
    return null
  }
}

export function clearNotice(root) {
  try { fs.rmSync(noticePath(root), { force: true }) } catch {}
}

export function writeNotice(root, { error, phase, kind }) {
  const file = noticePath(root)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const message = String(error?.message ?? error ?? 'unknown error')
  const rec = {
    at: Date.now(),
    phase,
    kind: kind || (NETWORK_HINT.test(message) ? 'network' : 'error'),
    message: message.slice(0, 300)
  }
  try { fs.writeFileSync(file, JSON.stringify(rec, null, 2), 'utf8') } catch {}
  return rec
}

// PAT 只存在 .sync/token（600），运行时拼进推送 URL，不写进 .git/config，也不进仓库。
export function authedRemote(root, remote) {
  const { syncDir } = syncPaths(root)
  const tokenPath = path.join(syncDir, 'token')
  if (!remote || !fs.existsSync(tokenPath)) return remote
  if (!/^https:\/\/github\.com\//.test(remote)) return remote
  const token = fs.readFileSync(tokenPath, 'utf8').trim()
  if (!token) return remote
  return remote.replace('https://github.com/', `https://x-access-token:${token}@github.com/`)
}

export async function connectGithub(root, pat, repoName = 'dsh-memory-vault') {
  const headers = {
    authorization: `Bearer ${pat}`,
    'user-agent': 'dsh-self-memory',
    accept: 'application/vnd.github+json'
  }
  const me = await fetch('https://api.github.com/user', { headers })
  if (!me.ok) throw new Error(`PAT 校验失败（HTTP ${me.status}）：${(await me.text()).slice(0, 200)}`)
  const { login } = await me.json()

  const created = await fetch('https://api.github.com/user/repos', {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({
      name: repoName,
      private: true,
      auto_init: true,
      description: 'encrypted self-memory vault (ciphertext only)'
    })
  })
  if (!created.ok && created.status !== 422) {
    throw new Error(`建仓库失败（HTTP ${created.status}）：${(await created.text()).slice(0, 200)}`)
  }
  const repo = created.ok ? await created.json() : null

  const p = syncPaths(root)
  fs.mkdirSync(p.syncDir, { recursive: true })
  fs.writeFileSync(path.join(p.syncDir, 'token'), pat.trim() + '\n', { mode: 0o600 })
  try { fs.chmodSync(path.join(p.syncDir, 'token'), 0o600) } catch {}

  const remote = repo?.clone_url ?? `https://github.com/${login}/${repoName}.git`
  const init = initSync(root, remote)
  return { login, remote, repoName, existed: created.status === 422, ...init }
}

function ensureRepoScaffold(p) {
  fs.mkdirSync(p.repoDir, { recursive: true })
  if (!fs.existsSync(p.readmeFile)) fs.writeFileSync(p.readmeFile, README, 'utf8')
  if (!fs.existsSync(p.gitignoreFile)) fs.writeFileSync(p.gitignoreFile, GITIGNORE, 'utf8')
  git(p.repoDir, ['config', 'user.name', 'self-memory'], { allowFail: true })
  git(p.repoDir, ['config', 'user.email', 'self-memory@localhost'], { allowFail: true })
}

export function initSync(root, remote) {
  if (!remote) throw new Error('需要远端地址')
  const p = syncPaths(root)
  fs.mkdirSync(p.syncDir, { recursive: true })

  if (!fs.existsSync(path.join(p.repoDir, '.git'))) {
    const clone = spawnSync('git', ['clone', remote, p.repoDir], {
      encoding: 'utf8',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
    })
    if (clone.status !== 0) {
      fs.mkdirSync(p.repoDir, { recursive: true })
      git(p.repoDir, ['init', '-q'], { allowFail: true })
      git(p.repoDir, ['remote', 'remove', 'origin'], { allowFail: true })
      git(p.repoDir, ['remote', 'add', 'origin', remote])
    }
  } else {
    git(p.repoDir, ['remote', 'remove', 'origin'], { allowFail: true })
    git(p.repoDir, ['remote', 'add', 'origin', remote])
  }

  ensureRepoScaffold(p)
  writeSyncConfig(root, { remote, initializedAt: Date.now(), device: os.hostname() })
  const key = loadOrCreateKey(p.keyPath)
  return { remote, repoDir: p.repoDir, keyPath: p.keyPath, keyFingerprint: key.subarray(0, 4).toString('hex') }
}

// 多端同时推会撞车：远端领先时 push 会被拒（non-fast-forward）。
// 这里不是报错退出，而是先把远端合并进来，重新加密提交再推，最多重试 3 轮。
const CONFLICT_HINT = /rejected|non-fast-forward|fetch first|behind|failed to push|out of date/i

// 语义指纹：忽略 updatedAt / device 这类每次都变的元数据，只比内容本身。
// 不这么做的话，每次 push 都会因为时间戳不同而生成一个内容相同的新密文提交，仓库迅速膨胀。
function stableOf(vault) {
  const events = {}
  for (const k of Object.keys(vault?.events ?? {}).sort()) {
    events[k] = [...(vault.events[k] ?? [])].sort((a, b) => String(a?.id).localeCompare(String(b?.id)))
  }
  const byId = (a, b) => String(a?.id).localeCompare(String(b?.id))
  return JSON.stringify({
    events,
    facts: [...(vault?.facts ?? [])].sort(byId),
    selfNotes: [...(vault?.selfNotes ?? [])].sort(byId)
  })
}

// 记账：upToT = "时间戳 ≤ 这个值的记录都已经在远端了"，下次只推更新的。
// 用时间戳而不是 id 集合，是为了不让记账文件本身随对话量线性膨胀。
function readState(root) {
  try {
    return JSON.parse(fs.readFileSync(path.join(syncPaths(root).syncDir, 'state.json'), 'utf8')) ?? {}
  } catch {
    return {}
  }
}

function writeState(root, patch) {
  const file = path.join(syncPaths(root).syncDir, 'state.json')
  const next = { ...readState(root), ...patch }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(next, null, 2), 'utf8')
  return next
}

function readApplied(root) {
  try {
    return JSON.parse(fs.readFileSync(path.join(syncPaths(root).syncDir, 'applied.json'), 'utf8')) ?? {}
  } catch {
    return {}
  }
}

function writeApplied(root, map) {
  const file = path.join(syncPaths(root).syncDir, 'applied.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(map, null, 2), 'utf8')
}

/** 删掉工作区里还没被 git 记录、也不是这一轮刚写的段文件。
 *  冲突重试时 git reset --hard 不会清掉未跟踪文件，不清理就会把同一个段重复提交上去。 */
export function pruneUntrackedSegments(repoDir, keep = new Set()) {
  const dir = segmentDir(repoDir)
  if (!fs.existsSync(dir)) return 0
  const tracked = new Set(
    git(repoDir, ['ls-files', 'segments'], { allowFail: true })
      .out.split('\n')
      .map((l) => path.basename(l.trim()))
      .filter(Boolean)
  )
  let removed = 0
  for (const name of fs.readdirSync(dir).filter((n) => SEG_RE.test(n))) {
    if (tracked.has(name) || keep.has(name)) continue
    try {
      fs.unlinkSync(path.join(dir, name))
      removed++
    } catch {}
  }
  return removed
}

export function pushSync(root, opts = {}) {
  const r = withSyncLock(root, () => pushSyncUnlocked(root, opts))
  if (r.skipped) {
    return {
      pushed: false,
      reason: 'locked',
      detail: '另一个同步任务正在跑，这次跳过（下一个周期会自己补上）',
      holder: r.holder ?? null
    }
  }
  return r.result
}

function pushSyncUnlocked(root, { retries = 3 } = {}) {
  const p = syncPaths(root)
  const cfg = readSyncConfig(root)
  if (!cfg.remote) throw new Error('还没绑定远端：先跑 node sync.mjs init <git-remote-url>')
  if (!fs.existsSync(path.join(p.repoDir, '.git'))) throw new Error('同步仓库不完整，请重跑 init')

  ensureRepoScaffold(p)
  const key = loadOrCreateKey(p.keyPath)

  let lastDetail = ''
  let counts = { events: 0, facts: 0, selfNotes: 0 }
  let bytes = 0
  let uploaded = 0

  for (let attempt = 1; attempt <= retries; attempt++) {
    // 每次推送前先吸收一下 DSH 当前的归档状态：你在界面里归档了会话，
    // 下一次推送就会把"这条会话已归档"一起带上去。
    try {
      syncFromDsh(root)
    } catch {
      /* workspace.json 读不到不影响推送 */
    }
    const local = collectVault(root, cfg.device)
    counts = countVault(local)
    const state = readState(root)
    const upToT = Number(state.upToT ?? 0)

    // 只挑"上次推送之后新写的"记录：这就是逐条增量上传
    const fresh = []
    for (const list of Object.values(local.events ?? {})) {
      for (const r of list) if (Number(r?.t ?? 0) > upToT) fresh.push(r)
    }
    fresh.sort((a, b) => Number(a?.t ?? 0) - Number(b?.t ?? 0))
    uploaded = fresh.length
    bytes = 0

    let changed = false
    let segName = null
    if (fresh.length) {
      // 上一轮被拒后 pullSync 做过 reset --hard，未跟踪的段文件还留在工作区里，
      // 不清掉就会把这批数据重复提交一次。每轮只保留本轮新写的段。
      const pruned = pruneUntrackedSegments(p.repoDir)
      if (pruned) console.log(`[self-memory] 清理 ${pruned} 个残留段文件`)
      segName = segmentName()
      const w = writeSegment(p.repoDir, segName, key, {
        v: 1,
        at: Date.now(),
        device: cfg.device,
        events: fresh
      })
      bytes += w.bytes
      changed = true
    }

    // facts / selfNotes / env / 归档清单只有几十条，整文件覆盖；内容没变不重写
    for (const s of [
      writeSmall(p.repoDir, 'facts.enc', key, local.facts ?? []),
      writeSmall(p.repoDir, 'self-notes.enc', key, local.selfNotes ?? []),
      writeSmall(p.repoDir, 'env.enc', key, local.env ?? null),
      writeSmall(p.repoDir, ARCHIVE_SMALL, key, readArchive(root))
    ]) {
      if (s.changed) {
        changed = true
        bytes += s.bytes
      }
    }

    if (!changed) {
      // 本地没新东西：远端若领先就顺手拉一把，然后按无事可做返回
      const behind = git(p.repoDir, ['rev-list', '--count', 'HEAD..@{u}'], { allowFail: true })
      if (behind.ok && Number(behind.out) > 0) {
        try { pullSync(root); continue } catch { /* 拉不动就下次再试 */ }
      }
      writeSyncConfig(root, { lastPushAt: Date.now() })
      return { pushed: false, reason: 'no-change', counts, bytes, attempts: attempt, uploaded: 0 }
    }

    git(p.repoDir, ['add', '-A'])
    const staged = git(p.repoDir, ['diff', '--cached', '--name-only'], { allowFail: true })
    const msg = `sync ${new Date().toISOString()} +${fresh.length} events events=${counts.events} facts=${counts.facts} notes=${counts.selfNotes}`
    if (staged.out) git(p.repoDir, ['commit', '-q', '-m', msg], { allowFail: true })

    const push = git(p.repoDir, ['push', '-q', authedRemote(root, cfg.remote), 'HEAD:main'], { allowFail: true, timeout: 45000 })
    if (push.ok) {
      const maxT = fresh.reduce((m, r) => Math.max(m, Number(r?.t ?? 0)), upToT)
      writeState(root, { upToT: maxT, lastPushAt: Date.now() })
      // 自己写的段内容已经在本地了，标记成已应用，别在下次 pull 时又下载回来
      if (segName) {
        const applied = readApplied(root)
        applied[segName] = Date.now()
        writeApplied(root, applied)
      }
      writeSyncConfig(root, { lastPushAt: Date.now() })
      clearNotice(root)
      return {
        pushed: true,
        message: msg,
        counts,
        bytes,
        uploaded,
        attempts: attempt,
        mergedRemote: attempt > 1
      }
    }

    lastDetail = push.out
    if (!CONFLICT_HINT.test(push.out)) {
      return { pushed: false, reason: 'push-failed', detail: push.out, counts, bytes, attempts: attempt }
    }

    // 远端有新东西：先合并回来，再重来一遍切片与提交
    try {
      pullSync(root)
    } catch (error) {
      return { pushed: false, reason: 'pull-failed', detail: String(error?.message ?? error), counts, bytes, attempts: attempt }
    }
  }

  return { pushed: false, reason: 'retry-exhausted', detail: lastDetail, counts, bytes, attempts: retries }
}

export function pullSync(root) {
  const r = withSyncLock(root, () => pullSyncUnlocked(root))
  if (r.skipped) return { pulled: false, reason: 'locked', detail: '另一个同步任务正在跑，这次跳过' }
  return r.result
}

function pullSyncUnlocked(root) {
  const p = syncPaths(root)
  const cfg = readSyncConfig(root)
  if (!cfg.remote) throw new Error('还没绑定远端：先跑 node sync.mjs init <git-remote-url>')
  if (!fs.existsSync(path.join(p.repoDir, '.git'))) throw new Error('同步仓库不完整，请重跑 init')

  const fetch = git(p.repoDir, ['fetch', '-q', authedRemote(root, cfg.remote)], { allowFail: true, timeout: 20000 })
  if (!fetch.ok) throw new Error(`拉取失败：${fetch.out}`)
  // 能 fetch 通就说明网络和凭据都没问题，之前那条"没同步上"的提示可以撤了
  clearNotice(root)

  const head = git(p.repoDir, ['rev-parse', '--verify', 'FETCH_HEAD'], { allowFail: true })
  if (!head.ok) return { pulled: false, reason: 'remote-empty' }

  git(p.repoDir, ['reset', '-q', '--hard', 'FETCH_HEAD'], { allowFail: true })

  const key = loadOrCreateKey(p.keyPath)
  const before = countVault(collectVault(root, cfg.device))
  const applied = readApplied(root)

  // ① 兼容旧仓库：整包 vault.enc 还没迁移过就先整包解一次
  let migrated = false
  if (fs.existsSync(p.vaultFile) && !applied['vault.enc']) {
    let legacy
    try {
      legacy = decryptJson(key, fs.readFileSync(p.vaultFile))
    } catch (e) {
      throw new Error(`解密失败（master.key 不匹配？）：${e.message}`)
    }
    applyVault(root, mergeVault(collectVault(root, cfg.device), legacy))
    applied['vault.enc'] = Date.now()
    migrated = true
  }

  // ② 只解"本地还没应用过"的段：没下过才下载，这是省流量的一半
  const segs = listSegments(p.repoDir)
  const freshSegs = segs.filter((n) => !applied[n])
  const events = []
  for (const name of freshSegs) {
    let payload
    try {
      payload = readSegment(p.repoDir, name, key)
    } catch (e) {
      throw new Error(`解密失败（master.key 不匹配？）：${e.message}`)
    }
    if (payload?.events?.length) events.push(...payload.events)
    applied[name] = Date.now()
  }

  // ③ 小文件（facts / 自我认知 / 环境清单 / 归档清单）整文件读，几 KB
  let facts = null
  let notes = null
  let env = null
  let remoteArchive = null
  try {
    facts = readSmall(p.repoDir, 'facts.enc', key)
    notes = readSmall(p.repoDir, 'self-notes.enc', key)
    env = readSmall(p.repoDir, 'env.enc', key)
    remoteArchive = readSmall(p.repoDir, ARCHIVE_SMALL, key)
  } catch (e) {
    throw new Error(`解密失败（master.key 不匹配？）：${e.message}`)
  }

  if (events.length || facts?.length || notes?.length) {
    applyIncremental(root, { events, facts: facts ?? [], selfNotes: notes ?? [] })
  }

  // 归档清单取并集、且不可逆：别的设备归档过的会话，本地也跟着标记归档
  let archivedAdded = 0
  if (remoteArchive?.sessions) {
    const beforeArchive = readArchive(root)
    const merged = mergeArchive(beforeArchive, remoteArchive)
    const w = writeArchive(root, merged)
    archivedAdded = Math.max(0, w.count - Object.keys(beforeArchive.sessions).length)
  }

  writeApplied(root, applied)
  writeSyncConfig(root, { lastPullAt: Date.now() })
  clearNotice(root)

  // 远端环境清单顺手落到本地：这样"后台 detached 拉取"也能让插件稍后比对补装，
  // 不用非得在主线程里阻塞着等 pullSync 返回。
  try {
    if (env) {
      fs.writeFileSync(
        path.join(p.syncDir, 'remote-env.json'),
        JSON.stringify({ at: Date.now(), env }, null, 2),
        'utf8'
      )
    }
  } catch {}

  const after = countVault(collectVault(root, cfg.device))
  return {
    pulled: true,
    before,
    after,
    added: Math.max(0, after.events - before.events),
    segments: freshSegs.length,
    totalSegments: segs.length,
    migrated,
    archived: archivedAdded,
    // 远端带来的环境清单：调用方拿它跟本机实装比对，决定补装什么
    remoteEnv: env ?? null
  }
}

/** 上一次 pull 下来的远端环境清单（detached 拉取后靠它补装插件）。 */
export function readRemoteEnv(root) {
  try {
    const p = syncPaths(root)
    const d = JSON.parse(fs.readFileSync(path.join(p.syncDir, 'remote-env.json'), 'utf8'))
    return d?.env ?? null
  } catch {
    return null
  }
}

export function statusSync(root) {
  const cfg = readSyncConfig(root)
  const p = syncPaths(root)
  const local = countVault(collectVault(root, cfg.device))
  let remote = null
  if (cfg.remote && fs.existsSync(p.repoDir)) {
    try {
      const applied = readApplied(root)
      const segs = listSegments(p.repoDir)
      remote = {
        segments: segs.length,
        pending: segs.filter((n) => !applied[n]).length,
        legacy: fs.existsSync(p.vaultFile) && !applied['vault.enc']
      }
    } catch {}
  }
  return {
    local,
    remote,
    remoteUrl: cfg.remote ?? null,
    lastPushAt: cfg.lastPushAt ?? null,
    lastPullAt: cfg.lastPullAt ?? null,
    upToT: readState(root).upToT ?? 0
  }
}
