// 归档联动：DSH 里把某个会话归档之后，那条会话的历史记忆也不该再被注入/检索，
// 但记录本身要留在库里（归档 ≠ 删除）。同时这件事要能跨端同步——
// 所以归档清单单独存一份 archive.json，并作为小数件 archived.enc 推到仓库。
//
// DSH 的归档状态在 C:\Users\lzk11\.dsh\storages\workspace.json 的
// global.archivedSessionIds 数组里（元素形如 session-<uuid>，与 L0 记录的 sid 完全一致）。
import fs from 'node:fs'
import path from 'node:path'

export const ARCHIVE_FILE = 'archive.json'
export const ARCHIVE_SMALL = 'archived.enc'

/** DSH 记录会话归档状态的那个文件。 */
export function defaultWorkspaceFile() {
  const home = process.env.USERPROFILE || process.env.HOME || ''
  return path.join(home, '.dsh', 'storages', 'workspace.json')
}

/** 从 workspace.json 里读出已归档的会话 id 列表。读不到就返回空数组，不抛错。 */
export function readDshArchived(file = defaultWorkspaceFile()) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    const ids = raw?.global?.archivedSessionIds
    return Array.isArray(ids) ? ids.filter((x) => typeof x === 'string' && x) : []
  } catch {
    return []
  }
}

export function archivePath(root) {
  return path.join(root, ARCHIVE_FILE)
}

function normalize(data) {
  const sessions = {}
  for (const [sid, v] of Object.entries(data?.sessions ?? {})) {
    if (typeof sid !== 'string' || !sid) continue
    const at = typeof v === 'number' ? v : Number(v?.at) || 0
    sessions[sid] = { at }
  }
  return { version: 1, sessions }
}

// 归档清单会被 recall 每次检索都读一遍，加一层 mtime 缓存：没变就不重复解析。
// 约定：调用方只读，不要直接改返回的对象（要改先自己复制一份）。
let archiveCache = { mtime: 0, data: null }

export function readArchive(root) {
  const file = archivePath(root)
  let mtime = 0
  try {
    mtime = fs.statSync(file).mtimeMs
  } catch {
    return { version: 1, sessions: {} }
  }
  if (archiveCache.data && archiveCache.mtime === mtime) return archiveCache.data
  try {
    const data = normalize(JSON.parse(fs.readFileSync(file, 'utf8')))
    archiveCache = { mtime, data }
    return data
  } catch {
    return { version: 1, sessions: {} }
  }
}

export function writeArchive(root, data) {
  const clean = normalize(data)
  const file = archivePath(root)
  const body = JSON.stringify(clean)
  let prev = ''
  try {
    prev = fs.readFileSync(file, 'utf8')
  } catch {
    prev = ''
  }
  const count = Object.keys(clean.sessions).length
  if (prev === body) return { changed: false, count }
  fs.writeFileSync(file, body, 'utf8')
  return { changed: true, count }
}

/** 并集合并：任一端归档过就算归档，at 取更早的那个（更接近真实归档时间）。 */
export function mergeArchive(a, b) {
  const out = { version: 1, sessions: {} }
  for (const src of [a, b]) {
    for (const [sid, v] of Object.entries(src?.sessions ?? {})) {
      const at = Number(v?.at) || 0
      const prev = out.sessions[sid]
      if (!prev) out.sessions[sid] = { at }
      else if (at && (!prev.at || at < prev.at)) prev.at = at
    }
  }
  return out
}

/** 把 DSH 当前的归档状态吸收进 archive.json（只增不减：取消归档不会复活旧记忆）。 */
export function syncFromDsh(root, { file } = {}) {
  const ids = readDshArchived(file)
  // 复制一份再改：readArchive 返回的是缓存对象，直接改会污染缓存
  const cur = normalize(readArchive(root))
  const before = Object.keys(cur.sessions).length
  const added = []
  const now = Date.now()
  for (const sid of ids) {
    if (!cur.sessions[sid]) {
      cur.sessions[sid] = { at: now }
      added.push(sid)
    }
  }
  const w = writeArchive(root, cur)
  return { added, addedCount: added.length, total: w.count, before, changed: w.changed }
}

export function archivedSet(root) {
  return new Set(Object.keys(readArchive(root).sessions))
}

export function isArchived(root, sid) {
  if (!sid) return false
  return Boolean(readArchive(root).sessions?.[sid])
}

export function archiveStats(root) {
  const a = readArchive(root)
  const sids = Object.keys(a.sessions)
  return { total: sids.length, sids }
}
