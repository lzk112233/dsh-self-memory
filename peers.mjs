#!/usr/bin/env node
// 设备网的命令行壳。插件里所有会连网的设备网操作都走这个子进程，
// 因为心跳 fetch 是 spawnSync（最长 15 秒），放在主线程里会把你打字的那一下冻住。
//
//   node peers.mjs tick      推一次心跳 + 拉一次所有设备，写 .sync/peers-snapshot.json
//   node peers.mjs devices   拉一次并打印设备列表（人类可读）
//   node peers.mjs send <to> <task...>
//   node peers.mjs result <taskId>
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { peersPush, peersFetch, sendTask, peerHint } from './lib/memory-peers.js'
import { syncPaths } from './lib/memory-sync.js'

const ROOT = process.env.SM_ROOT || path.join(os.homedir(), '.dsh', 'self-memory')
const cmd = process.argv[2] ?? 'tick'

function snapshotFile() {
  return path.join(syncPaths(ROOT).syncDir, 'peers-snapshot.json')
}

function writeSnapshot(data) {
  const file = snapshotFile()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8')
}

function say(line) {
  process.stdout.write(`${line}\n`)
}

try {
  if (cmd === 'tick') {
    const ttl = Number(process.env.SM_PRESENCE_TTL) || 300
    const push = peersPush(ROOT, { ttlSeconds: ttl })
    const r = peersFetch(ROOT, { ttlSeconds: ttl })
    writeSnapshot({
      at: Date.now(),
      offline: Boolean(r.offline),
      peers: r.peers ?? [],
      inbox: r.inbox ?? [],
      results: r.results ?? [],
      push: push?.pushed ? 'pushed' : push?.reason ?? 'no-push'
    })
    say(`tick ok offline=${Boolean(r.offline)} peers=${(r.peers ?? []).length} inbox=${(r.inbox ?? []).length}`)
    process.exit(0)
  }

  if (cmd === 'devices') {
    const r = peersFetch(ROOT, { ttlSeconds: Number(process.env.SM_PRESENCE_TTL) || 300 })
    if (r.reason === 'no-remote') { say('还没绑定云端仓库。'); process.exit(0) }
    say(r.offline ? '（网络没通，下面是本地缓存的最后一次结果）' : '')
    say(peerHint(r.peers) || '（没有别的设备）')
    for (const p of r.peers) {
      say(`- ${p.device}${p.self ? '（本机）' : ''} ${p.online ? '在线' : '离线'} ${p.host} ${p.platform}`)
    }
    process.exit(0)
  }

  if (cmd === 'send') {
    const to = process.argv[3] ?? '*'
    const task = process.argv.slice(4).join(' ').trim()
    if (!task) { say('用法：node peers.mjs send <目标设备|*> <任务内容>'); process.exit(2) }
    const r = sendTask(ROOT, { to, task })
    writeSnapshot({ at: Date.now(), peers: [], inbox: [], results: [] })
    say(`已下发 ${r.id} → ${r.to}`)
    process.exit(0)
  }

  if (cmd === 'result') {
    const id = process.argv[3]
    const r = peersFetch(ROOT, {})
    const hit = (r.results ?? []).find((x) => String(x.taskId) === String(id))
    if (!hit) { say('还没有结果（或者任务还没被在线设备领走）。'); process.exit(1) }
    say(hit.out || '(空)')
    process.exit(0)
  }

  say(`未知子命令：${cmd}`)
  process.exit(2)
} catch (error) {
  say(`peers ${cmd} 失败：${error?.message ?? error}`)
  process.exit(1)
}
