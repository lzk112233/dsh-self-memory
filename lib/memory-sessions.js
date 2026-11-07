// 会话同步：把 DSH 的 sessions/ 目录当文件库整体搬过去。
//
// 为什么需要这一层：记忆库（facts / selfNotes / L0 片段）只是「我记得的事」，
// 另一台机器上看不到原来的对话本身。要「A 关机，B 接着干」，就得把 DSH 真正
// 落盘的会话文件搬过去，并让它在 B 的侧栏里出现。
//
// 关键事实（本机实测）：
//   C:\Users\<u>\.dsh\sessions\--D-ai-dfy--\session-<uuid>\session.v4.jsonl.zstd
//   ↑ 目录名 = '--' + cwd 编码 + '--'（冒号删掉、反斜杠→'-'、空格→~0020、非 ASCII→~大写hex）
//   ↑ 文件 = 追加式 zstd（多个 frame 拼接，所以只能整块搬，不能随便解析）
//   ↑ 会话归属靠 storages/workspace.json 的 tables.workspaces[<id>].sessionIds
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import { encryptBytes, decryptBytes } from './memory-crypto.js'

export const SESSION_FILE = 'session.v4.jsonl.zstd'
export const SESSION_SUBDIR = 'sessions'
export const SESSION_INDEX = 'sessions.enc'
export const MAX_SESSION_BYTES = 16 * 1024 * 1024

export function defaultDshRoot() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

export function defaultSessionsDir(dshRoot = defaultDshRoot()) {
  return path.join(dshRoot, 'sessions')
}

export function workspaceFile(dshRoot = defaultDshRoot()) {
  return path.join(dshRoot, 'storages', 'workspace.json')
}

// '--D-ai-dfy--' 这套编码，7/7 与磁盘上的真实目录名对得上
export function encodeCwd(p) {
  const body = String(p)
    .replace(/^([A-Za-z]):/, '$1')
    .replace(/\\/g, '-')
    .replace(/ /g, '~0020')
    .replace(/[^\x20-\x7E]/g, (ch) => '~' + ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0'))
  return `--${body}--`
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

// 会话文件的第一帧就是 header，里面写着真实 cwd。
// 有了它就不用靠目录名反推路径（'--D-ai-dfy--' 反推不出 D:\ai\dfy 还是 D:\ai-dfy）。
export function readSessionHeader(file) {
  try {
    const raw = fs.readFileSync(file)
    const first = zlib.zstdDecompressSync(raw).toString('utf8').split('\n')[0]
    const o = JSON.parse(first)
    if (o?.type !== 'session') return null
    return { id: o.id ?? null, cwd: o.cwd ?? null, createdAt: o.createdAt ?? null, parentSession: o.parentSession ?? null }
  } catch {
    return null
  }
}

function atomicWrite(file, buf) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, buf)
  fs.renameSync(tmp, file)
}

// ── 本地清点 ────────────────────────────────────────────────────
export function listLocalSessions(dshRoot = defaultDshRoot()) {
  const base = defaultSessionsDir(dshRoot)
  const out = []
  if (!fs.existsSync(base)) return out
  for (const proj of fs.readdirSync(base)) {
    const pdir = path.join(base, proj)
    let st
    try { st = fs.statSync(pdir) } catch { continue }
    if (!st.isDirectory()) continue
    for (const sid of fs.readdirSync(pdir)) {
      const file = path.join(pdir, sid, SESSION_FILE)
      let fst
      try { fst = fs.statSync(file) } catch { continue }
      if (!fst.isFile()) continue
      out.push({ sid, proj, file, size: fst.size, mtimeMs: Math.round(fst.mtimeMs) })
    }
  }
  return out
}

// ── 推送状态（记哪些会话已经推过，避免每次重算 sha）────────────────
export function sessionStatePath(root) {
  return path.join(root, '.sync', 'sessions-state.json')
}

export function readSessionState(root) {
  const f = sessionStatePath(root)
  if (!fs.existsSync(f)) return { version: 1, sessions: {} }
  try {
    const j = JSON.parse(fs.readFileSync(f, 'utf8'))
    return { version: 1, sessions: j?.sessions ?? {} }
  } catch {
    return { version: 1, sessions: {} }
  }
}

export function writeSessionState(root, state) {
  atomicWrite(sessionStatePath(root), Buffer.from(JSON.stringify(state, null, 2), 'utf8'))
}

// ── 云端索引（小文件，含会话清单 + 工作区归属）──────────────────────
export function readSessionIndex(repoDir, key) {
  const f = path.join(repoDir, SESSION_INDEX)
  if (!fs.existsSync(f)) return null
  try {
    const j = decryptBytes(key, fs.readFileSync(f))
    return JSON.parse(j.toString('utf8'))
  } catch {
    return null
  }
}

export function writeSessionIndex(repoDir, key, idx) {
  atomicWrite(path.join(repoDir, SESSION_INDEX), encryptBytes(key, Buffer.from(JSON.stringify(idx), 'utf8')))
}

// ── 工作区归属快照 ──────────────────────────────────────────────
export function collectWorkspaces(dshRoot = defaultDshRoot(), keepSids = null) {
  const f = workspaceFile(dshRoot)
  if (!fs.existsSync(f)) return []
  let j
  try { j = JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return [] }
  const table = j?.tables?.workspaces ?? {}
  const out = []
  for (const [id, w] of Object.entries(table)) {
    if (!w?.path) continue
    const sids = (w.sessionIds ?? []).filter((s) => (keepSids ? keepSids.has(s) : true))
    if (!sids.length) continue
    out.push({ id, path: w.path, title: w.title ?? path.basename(w.path), sessionIds: sids })
  }
  return out
}

// 按会话 header 里的 cwd 分组，而不是按 workspace.json 的 sessionIds。
// 原因：DSH 的 workspace 表里并不一定登记了磁盘上所有会话（本机实测 116 个会话，
// 表里只有 52 个），只信那张表会让一半会话在另一台机器上"看不见"。
export function buildWorkspaces(dshRoot = defaultDshRoot(), sessions = {}) {
  const real = collectWorkspaces(dshRoot, null)
  const byPath = new Map(real.map((w) => [w.path.toLowerCase(), w]))
  const groups = new Map()
  for (const [sid, meta] of Object.entries(sessions)) {
    const cwd = meta?.cwd
    if (!cwd) continue
    const k = cwd.toLowerCase()
    if (!groups.has(k)) groups.set(k, { path: cwd, sids: [] })
    groups.get(k).sids.push(sid)
  }
  const out = []
  for (const [k, g] of groups) {
    const hit = byPath.get(k)
    // 没有对应工作区时用一个由路径派生的稳定 id：同一台设备反复推送不会换 id
    const id = hit?.id ?? 'ws-' + sha256(Buffer.from(k)).slice(0, 16)
    out.push({
      id,
      path: g.path,
      title: hit?.title ?? (path.basename(g.path) || g.path),
      sessionIds: g.sids.sort()
    })
  }
  return out
}

// 把远端的工作区并进本地 workspace.json。DSH 运行时也会写这个文件，
// 所以只在 pull 之后写一次，并留 .bak；重启 DSH 后侧栏才会重新读。
export function registerWorkspaces(dshRoot = defaultDshRoot(), workspaces = []) {
  const f = workspaceFile(dshRoot)
  if (!workspaces.length || !fs.existsSync(f)) return { added: 0, updated: 0 }
  let j
  try { j = JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return { added: 0, updated: 0 } }
  j.tables ??= {}
  j.tables.workspaces ??= {}
  j.global ??= {}
  j.global.workspaceIds ??= []
  const table = j.tables.workspaces
  let added = 0
  let updated = 0
  for (const w of workspaces) {
    const hit = Object.entries(table).find(([, v]) => v?.path === w.path)
    if (hit) {
      const [id, v] = hit
      const before = new Set(v.sessionIds ?? [])
      let touched = false
      for (const sid of w.sessionIds) {
        if (!before.has(sid)) { v.sessionIds.push(sid); touched = true }
        if (!j.global.workspaceIds.includes(id)) j.global.workspaceIds.push(id)
      }
      if (touched) { v.updatedAt = new Date().toISOString(); updated++ }
      continue
    }
    const id = table[w.id] ? crypto.randomUUID() : w.id
    table[id] = {
      path: w.path,
      title: w.title,
      sessionIds: [...new Set(w.sessionIds)],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
    if (!j.global.workspaceIds.includes(id)) j.global.workspaceIds.push(id)
    added++
  }
  if (!added && !updated) return { added, updated }
  try { fs.copyFileSync(f, `${f}.bak`) } catch {}
  atomicWrite(f, Buffer.from(JSON.stringify(j, null, 2), 'utf8'))
  return { added, updated }
}

// ── push：只推变化过的会话 ──────────────────────────────────────
export function pushSessions({ root, repoDir, key, dshRoot = defaultDshRoot(), maxBytes = MAX_SESSION_BYTES, maxAgeDays = 0, dryRun = false }) {
  const idx = readSessionIndex(repoDir, key) ?? { version: 1, sessions: {}, workspaces: [] }
  idx.sessions ??= {}
  const beforeJson = JSON.stringify(idx)
  const state = readSessionState(root)
  const local = listLocalSessions(dshRoot)
  const now = Date.now()
  const cutoff = maxAgeDays > 0 ? now - maxAgeDays * 86400000 : 0

  let uploaded = 0
  let bytes = 0
  const skipped = []
  for (const s of local) {
    if (cutoff && s.mtimeMs < cutoff) continue
    if (s.size > maxBytes) { skipped.push({ sid: s.sid, reason: 'too-big', size: s.size }); continue }
    const prev = state.sessions[s.sid]
    const same = prev && prev.size === s.size && prev.mtimeMs === s.mtimeMs
    const remoteSame = idx.sessions[s.sid]?.size === s.size && idx.sessions[s.sid]?.mtimeMs === s.mtimeMs
    if (same && remoteSame) {
      // 内容没变，但索引里可能还缺 cwd（老版本推上去的）：补一次，不重新加密
      const m = idx.sessions[s.sid]
      if (m && !m.cwd) {
        const hdr = readSessionHeader(s.file)
        if (hdr?.cwd) {
          m.cwd = hdr.cwd
          m.proj = encodeCwd(hdr.cwd)
          m.createdAt ??= hdr.createdAt ?? null
        }
      }
      continue
    }
    if (dryRun) { uploaded++; continue }
    const plain = fs.readFileSync(s.file)
    if (plain.length === 0) { skipped.push({ sid: s.sid, reason: 'empty' }); continue }
    const enc = encryptBytes(key, plain)
    atomicWrite(path.join(repoDir, SESSION_SUBDIR, `${s.sid}.enc`), enc)
    const hdr = readSessionHeader(s.file)
    state.sessions[s.sid] = { size: s.size, mtimeMs: s.mtimeMs, sha: sha256(plain).slice(0, 16) }
    idx.sessions[s.sid] = {
      proj: hdr?.cwd ? encodeCwd(hdr.cwd) : s.proj,
      cwd: hdr?.cwd ?? null,
      size: plain.length,
      mtimeMs: s.mtimeMs,
      createdAt: hdr?.createdAt ?? null,
      updatedAt: now
    }
    uploaded++
    bytes += enc.length
  }

  let indexChanged = false
  if (!dryRun) {
    idx.workspaces = buildWorkspaces(dshRoot, idx.sessions)
    idx.updatedAt = now
    indexChanged = JSON.stringify(idx) !== beforeJson
    if (indexChanged) writeSessionIndex(repoDir, key, idx)
    writeSessionState(root, state)
  }
  return {
    uploaded,
    indexChanged,
    skipped,
    bytes,
    localTotal: local.length,
    remoteTotal: Object.keys(idx.sessions).length,
    workspaces: idx.workspaces?.length ?? 0
  }
}

// 路径重映射：另一台机器没有 D:\xxx 时，把远端 cwd 换成本机真实存在的目录。
// 配法（cordis.patch.yml）：pathMap: { 'D:\\Stablediffusion\\dfh': 'E:\\dfh' }
export function remapCwd(cwd, map) {
  if (!cwd || !map) return cwd
  if (map[cwd]) return map[cwd]
  const lower = cwd.toLowerCase()
  for (const [k, v] of Object.entries(map)) if (k.toLowerCase() === lower) return v
  return cwd
}

// ── pull：把远端有、本地没有（或本地更旧）的会话写回去 ───────────────
export function pullSessions({ root, repoDir, key, dshRoot = defaultDshRoot(), pathMap = null }) {
  const idx = readSessionIndex(repoDir, key)
  if (!idx?.sessions) return { added: 0, updated: 0, skipped: 0, missingBlob: 0, workspaces: null, sessions: 0 }

  const base = defaultSessionsDir(dshRoot)
  let added = 0
  let updated = 0
  let keptLocal = 0
  let missingBlob = 0
  const conflicts = []
  const absentPaths = new Set()

  for (const [sid, meta] of Object.entries(idx.sessions)) {
    const blob = path.join(repoDir, SESSION_SUBDIR, `${sid}.enc`)
    if (!fs.existsSync(blob)) { missingBlob++; continue }
    // 目录名按 header 里的 cwd 现算：这台机器上就算换了盘符/目录，也会落到对的位置
    const cwd = remapCwd(meta.cwd, pathMap)
    if (cwd && !fs.existsSync(cwd)) absentPaths.add(cwd)
    const projDir = cwd ? encodeCwd(cwd) : meta.proj
    const target = path.join(base, projDir, sid, SESSION_FILE)
    let localSize = -1
    try { localSize = fs.statSync(target).size } catch {}
    if (localSize >= (meta.size ?? 0) && localSize >= 0) {
      // 本地不比他小：本地就是新的（或一样），不覆盖
      if (localSize > meta.size) conflicts.push({ sid, local: localSize, remote: meta.size })
      keptLocal++
      continue
    }
    const plain = decryptBytes(key, fs.readFileSync(blob))
    if (localSize >= 0) {
      // 保留一份本地旧版，万一覆盖错了还能捞回来
      try { fs.copyFileSync(target, `${target}.bak`); } catch {}
      updated++
    } else {
      added++
    }
    atomicWrite(target, plain)
  }

  const remappedWs = (idx.workspaces ?? []).map((w) => ({ ...w, path: remapCwd(w.path, pathMap) ?? w.path }))
  const ws = registerWorkspaces(dshRoot, remappedWs)
  return {
    added,
    updated,
    skipped: keptLocal,
    missingBlob,
    conflicts,
    workspaces: ws,
    // 这些 cwd 在这台机器上不存在：会话能读，但对应工作区点开建新会话会失败
    absentPaths: [...absentPaths],
    sessions: Object.keys(idx.sessions).length
  }
}

// ── 概览 ──────────────────────────────────────────────────────
export function sessionsStatus({ root, repoDir, key, dshRoot = defaultDshRoot() }) {
  const local = listLocalSessions(dshRoot)
  const idx = readSessionIndex(repoDir, key)
  const remote = idx?.sessions ?? {}
  const localIds = new Set(local.map((s) => s.sid))
  const onlyLocal = [...localIds].filter((s) => !remote[s])
  const onlyRemote = Object.keys(remote).filter((s) => !localIds.has(s))
  return {
    local: local.length,
    localBytes: local.reduce((n, s) => n + s.size, 0),
    remote: Object.keys(remote).length,
    onlyLocal: onlyLocal.length,
    onlyRemote: onlyRemote.length,
    projects: [...new Set(local.map((s) => s.proj))].length,
    workspaces: idx?.workspaces?.length ?? 0,
    updatedAt: idx?.updatedAt ?? null
  }
}
