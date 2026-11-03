// vault 打包 / 合并 / 落盘：把四层记忆压成一个 JSON，合并靠 id 去重 + 时间戳取新。
import fs from 'node:fs'
import path from 'node:path'
import { readEnv } from './memory-env.js'
import { createStore } from './memory-store.js'

export function readJsonl(file) {
  if (!fs.existsSync(file)) return []
  const out = []
  let raw = ''
  try { raw = fs.readFileSync(file, 'utf8') } catch { return [] }
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try { out.push(JSON.parse(t)) } catch {}
  }
  return out
}

export function writeJsonl(file, records) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const body = records.map((r) => JSON.stringify(r)).join('\n')
  fs.writeFileSync(file, body ? body + '\n' : '', 'utf8')
}

export function collectVault(root, device = os_device()) {
  const memDir = path.join(root, 'memory')
  const eventsDir = path.join(memDir, 'events')
  const events = {}
  if (fs.existsSync(eventsDir)) {
    for (const f of fs.readdirSync(eventsDir).filter((n) => n.endsWith('.jsonl'))) {
      events[f.replace(/\.jsonl$/, '')] = readJsonl(path.join(eventsDir, f))
    }
  }
  return {
    version: 1,
    device,
    updatedAt: Date.now(),
    events,
    facts: readJsonl(path.join(memDir, 'facts', 'global.jsonl')),
    selfNotes: readJsonl(path.join(root, 'self-notes.jsonl')),
    // 环境清单跟着记忆一起走：换机器拉下来就知道要装哪些插件
    env: readEnv(root) ?? null
  }
}

function os_device() {
  try { return `${process.platform}-${process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? 'host'}` } catch { return 'host' }
}

export function mergeById(local, remote, newer) {
  const map = new Map()
  for (const r of local) if (r && r.id) map.set(r.id, r)
  for (const r of remote) {
    if (!r || !r.id) continue
    const prev = map.get(r.id)
    if (!prev) { map.set(r.id, r); continue }
    if (newer(r, prev)) map.set(r.id, r)
  }
  return [...map.values()]
}

// 归档是单向门：任何一端口归档过，合并结果就是归档，不会「复活」被忘掉的东西。
export function mergeFacts(local, remote) {
  const map = new Map()
  const put = (r) => {
    if (!r || !r.id) return
    const prev = map.get(r.id)
    if (!prev) { map.set(r.id, { ...r }); return }
    const newer = Number(r.lastHit ?? 0) > Number(prev.lastHit ?? 0)
    const base = newer ? { ...prev, ...r } : { ...r, ...prev }
    if (prev.archived || r.archived) {
      base.archived = true
      base.archivedAt = prev.archivedAt ?? r.archivedAt
    }
    map.set(r.id, base)
  }
  for (const r of local) put(r)
  for (const r of remote) put(r)
  return [...map.values()]
}

export function mergeVault(local, remote) {
  const a = local ?? {}
  const b = remote ?? {}
  const events = {}
  const shards = new Set([...Object.keys(a.events ?? {}), ...Object.keys(b.events ?? {})])
  for (const shard of shards) {
    const merged = mergeById(
      a.events?.[shard] ?? [],
      b.events?.[shard] ?? [],
      (x, y) => Number(x.t ?? 0) > Number(y.t ?? 0)
    )
    merged.sort((x, y) => Number(x.t ?? 0) - Number(y.t ?? 0))
    if (merged.length) events[shard] = merged
  }
  return {
    version: 1,
    device: a.device ?? b.device ?? os_device(),
    updatedAt: Date.now(),
    events,
    facts: mergeFacts(a.facts ?? [], b.facts ?? []),
    selfNotes: mergeById(
      a.selfNotes ?? [],
      b.selfNotes ?? [],
      (x, y) => Number(x.lastTouchedAt ?? 0) > Number(y.lastTouchedAt ?? 0)
    ),
    // env 代表"本机环境"，合并时保留本地那份；真正安装什么由 pullSync 拿远端清单去比对
    env: a.env ?? b.env ?? null
  }
}

export function countVault(vault) {
  const events = Object.values(vault.events ?? {}).reduce((n, list) => n + list.length, 0)
  return { events, facts: (vault.facts ?? []).length, selfNotes: (vault.selfNotes ?? []).length }
}

export function applyVault(root, vault) {
  const memDir = path.join(root, 'memory')
  const eventsDir = path.join(memDir, 'events')
  fs.mkdirSync(eventsDir, { recursive: true })

  // 按 shard 覆盖写：vault 是合并后的全量真相
  const existing = fs.existsSync(eventsDir) ? fs.readdirSync(eventsDir).filter((n) => n.endsWith('.jsonl')) : []
  for (const f of existing) {
    const shard = f.replace(/\.jsonl$/, '')
    if (!vault.events?.[shard]) fs.rmSync(path.join(eventsDir, f), { force: true })
  }
  for (const [shard, records] of Object.entries(vault.events ?? {})) {
    writeJsonl(path.join(eventsDir, `${shard}.jsonl`), records)
  }

  writeJsonl(path.join(memDir, 'facts', 'global.jsonl'), vault.facts ?? [])
  writeJsonl(path.join(root, 'self-notes.jsonl'), vault.selfNotes ?? [])

  rebuildIndex(root)
  return countVault(vault)
}

export function rebuildIndex(root) {
  const memDir = path.join(root, 'memory')
  const eventsDir = path.join(memDir, 'events')
  const idxDir = path.join(memDir, 'index')
  fs.mkdirSync(idxDir, { recursive: true })

  const shards = {}
  const ids = []
  const files = fs.existsSync(eventsDir) ? fs.readdirSync(eventsDir).filter((n) => n.endsWith('.jsonl')) : []
  for (const f of files) {
    const full = path.join(eventsDir, f)
    const records = readJsonl(full)
    for (const r of records) if (r?.id) ids.push(r.id)
    shards[f.replace(/\.jsonl$/, '')] = { count: records.length, bytes: fs.statSync(full).size }
  }
  const total = Object.values(shards).reduce((n, s) => n + s.count, 0)

  const manPath = path.join(memDir, 'manifest.json')
  let createdAt = Date.now()
  try { createdAt = JSON.parse(fs.readFileSync(manPath, 'utf8')).createdAt ?? createdAt } catch {}
  fs.writeFileSync(manPath, JSON.stringify({
    version: 1, createdAt, updatedAt: Date.now(), counts: { dsh: total }, shards
  }, null, 2), 'utf8')

  fs.writeFileSync(path.join(idxDir, 'ids.txt'), ids.join('\n') + (ids.length ? '\n' : ''), 'utf8')
  return { total, shards }
}

/**
 * 增量落盘：只把新记录 append 进去，不重写整个分片。
 * facts / selfNotes 是"有状态的短句"（会被更新、归档），所以走合并而不是追加。
 */
export function applyIncremental(root, { events = [], facts = [], selfNotes = [] } = {}) {
  const memDir = path.join(root, 'memory')
  let added = 0
  if (events.length) {
    // 先把索引跟文件对齐，否则 append 的去重会失效（外部写过文件时索引可能是旧的）
    rebuildIndex(root)
    const store = createStore({ dir: root, maxTextChars: 4000 })
    added = store.append(events).added
    if (added) rebuildIndex(root)
  }
  if (facts.length) {
    const file = path.join(memDir, 'facts', 'global.jsonl')
    writeJsonl(file, mergeFacts(readJsonl(file), facts))
  }
  if (selfNotes.length) {
    const file = path.join(root, 'self-notes.jsonl')
    writeJsonl(
      file,
      mergeById(readJsonl(file), selfNotes, (x, y) => Number(x.lastTouchedAt ?? 0) > Number(y.lastTouchedAt ?? 0))
    )
  }
  return { added }
}
