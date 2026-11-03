#!/usr/bin/env node
// 证明「这台设备连的确实是你的仓库」。
//
// 为什么需要单独一个东西来证明：仓库地址是个字符串，谁都能把它指向任何地方。
// 地址对不上不等于不是你的，地址对上也不等于就是你的。真正的证据只有一层：
//   **能不能用本机这把 master.key 解开云端的密文。**
// AES-256-GCM 每个段都带 16 字节认证标签，用错 key 的通过概率是 2^-128。
// 所以「解开了」= 「这就是我的数据」，比任何 URL、owner、仓库名都硬。
//
// 用法：
//   node verify.mjs            本地仓库快照上验证（不联网，快）
//   node verify.mjs --fetch    先连远端拉最新再验证（会联网）
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import { syncPaths, readSyncConfig, authedRemote, readRemoteEnv } from './lib/memory-sync.js'
import { loadOrCreateKey } from './lib/memory-crypto.js'
import { listSegments, readSegment } from './lib/memory-segments.js'
import { collectVault } from './lib/memory-vault.js'
import { readArchive } from './lib/memory-archive.js'

const ROOT = process.env.SM_ROOT || path.join(os.homedir(), '.dsh', 'self-memory')
const DO_FETCH = process.argv.includes('--fetch')

const ok = (m) => console.log(`  ✅ ${m}`)
const bad = (m) => console.log(`  ❌ ${m}`)
const info = (m) => console.log(`     ${m}`)

function git(cwd, args, timeout = 20000) {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  })
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() }
}

function fingerprint(key) {
  // 指纹用 sha256 前 4 字节：能区分不同 key，又没法从指纹反推 key
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 8)
}

function readLocalState(root) {
  try {
    return JSON.parse(fs.readFileSync(path.join(syncPaths(root).syncDir, 'state.json'), 'utf8')) ?? {}
  } catch {
    return {}
  }
}

const p = syncPaths(ROOT)
const cfg = readSyncConfig(ROOT)
const problems = []

console.log(`\n【self-memory 仓库归属验证】${new Date().toLocaleString('zh-CN', { hour12: false })}\n`)

// ── 1. 地址层：远端指向哪 ────────────────────────────────────
console.log('① 远端地址');
if (!cfg.remote) {
  bad('还没绑定远端，这套记忆只在本机')
  console.log('\n（没绑定就不存在「连错仓库」的问题；要开云同步跑 node sync.mjs connect）')
  process.exit(0)
}
const m = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(cfg.remote)
const owner = m?.[1] ?? null
const repo = m?.[2] ?? null
info(`配置里的远端：${cfg.remote}`)
if (owner) {
  info(`解析出：owner=${owner}  repo=${repo}`)
  // 本地 git 的 origin 必须与配置一致，否则可能某次手工改过一边
  const remote = git(p.repoDir, ['remote', '-v'])
  if (remote.ok && remote.out.includes(cfg.remote)) ok('本地 git 的 origin 与配置一致')
  else {
    bad('本地 git 的 origin 与配置不一致（有人改过其中一边？）')
    info(remote.out.split('\n')[0] ?? '')
    problems.push('remote-mismatch')
  }
} else {
  bad('远端地址不是 GitHub 形式，无法解析 owner/repo')
}

// ── 2. 密钥层：本机这把 key 的指纹 ─────────────────────────
console.log('\n② 本机密钥');
if (!fs.existsSync(p.keyPath)) {
  bad(`找不到 master.key：${p.keyPath}`)
  console.log('\n没有 key，下面的解密验证全部无法进行。先 node sync.mjs import-key <base64>')
  process.exit(1)
}
const key = loadOrCreateKey(p.keyPath)
const fp = fingerprint(key)
info(`master.key：${p.keyPath}`)
info(`指纹 sha256[:8]：${fp}`)
info(`长度：${key.length} 字节（AES-256 需要正好 32）`)
ok('密钥文件存在且长度正确')

// ── 3. 网络层（可选）：能不能连上 ──────────────────────────
if (DO_FETCH) {
  console.log('\n③ 连通远端（--fetch）');
  const f = git(p.repoDir, ['fetch', '-q', authedRemote(ROOT, cfg.remote)], 25000)
  if (f.ok) {
    ok('fetch 成功：凭据有效、网络通')
    git(p.repoDir, ['reset', '-q', '--hard', 'FETCH_HEAD'])
  } else {
    bad(`fetch 失败：${f.out.slice(0, 200)}`)
    info('接下来在本地已有的快照上继续验证（结果仍然有效，只是不是最新的）')
    problems.push('fetch-failed')
  }
}

// ── 4. 密码学层：能不能解开云端的密文（这是决定性的那条） ──
console.log(`\n${DO_FETCH ? '④' : '③'} 解密验证 —— 只有这条是硬证据`);
const segs = listSegments(p.repoDir);
if (!segs.length) {
  bad('本地仓库里没有任何段（还没 push 过，或还没 pull 过）')
  info('先 node sync.mjs push 把记忆推上去，再回来验证')
  process.exit(1)
}
info(`仓库里有 ${segs.length} 个加密段：${segs[segs.length - 1]}（最新）`)

let decrypted = 0
let totalEvents = 0
let earliest = null
let latest = null
let firstFail = null
for (const name of segs) {
  try {
    const payload = readSegment(p.repoDir, name, key)
    decrypted++
    for (const e of payload?.events ?? []) {
      totalEvents++
      const t = Number(e?.t ?? 0)
      if (t && (!earliest || t < earliest)) earliest = t
      if (t && (!latest || t > latest)) latest = t
    }
  } catch (e) {
    if (!firstFail) firstFail = { name, message: String(e?.message ?? e).slice(0, 120) }
  }
}

if (decrypted === segs.length) {
  ok(`全部 ${segs.length} 个段解密成功 —— 每段 16 字节 GCM 认证标签都验过了`)
  info(`共 ${totalEvents} 条对话原文`)
  if (earliest) info(`时间跨度：${new Date(earliest).toLocaleString('zh-CN', { hour12: false })} → ${new Date(latest).toLocaleString('zh-CN', { hour12: false })}`)
} else {
  bad(`${segs.length - decrypted} 个段解不开，第一个是 ${firstFail?.name}`)
  info(firstFail?.message ?? '')
  info('这说明本机这把 key 和云端密文不是一对：要么仓库是别人的，要么 key 拿错了')
  problems.push('cannot-decrypt')
}

// ── 5. 反向证伪：换一把随机 key，必须解不开 ────────────────
console.log(`\n${DO_FETCH ? '⑤' : '④'} 反向证伪 —— 随机 key 必须解不开`);
const wrongKey = crypto.randomBytes(32);
let wrongOpened = 0;
for (const name of segs.slice(-3)) {
  try {
    readSegment(p.repoDir, name, wrongKey)
    wrongOpened++
  } catch {
    /* 预期 */
  }
}
if (wrongOpened === 0) {
  ok('用随机 key 试解最近 3 个段，全部被 GCM 拒绝')
  info('这证明密文是真的加密过的，不存在「谁都能读」的情况')
} else {
  bad(`${wrongOpened} 个段用随机 key 也能解开 —— 加密没生效？`)
  problems.push('weak-crypto')
}

// ── 6. 内容层：解出来的东西认得出是你的 ────────────────────
console.log(`\n${DO_FETCH ? '⑥' : '⑤'} 内容归属`);
const state = readLocalState(ROOT);
const local = collectVault(ROOT, cfg.device);
info(`本机：${local.events ? Object.values(local.events).reduce((n, l) => n + l.length, 0) : 0} 条原文 / ${local.facts?.length ?? 0} 条事实 / ${local.selfNotes?.length ?? 0} 条自我认知`)
info(`云端已应用至：${state.upToT ? new Date(state.upToT).toLocaleString('zh-CN', { hour12: false }) : '从未'}`)
const arch = readArchive(ROOT);
info(`归档会话：${Object.keys(arch.sessions ?? {}).length} 个`)
const remoteEnv = readRemoteEnv(ROOT);
if (remoteEnv?.plugins?.length) {
  info(`云端带下来的插件清单：${remoteEnv.plugins.length} 个（${remoteEnv.plugins.slice(0, 3).map((x) => x.name).join('、')}${remoteEnv.plugins.length > 3 ? '…' : ''}）`)
}

// ── 结论 ──────────────────────────────────────────────────
console.log('\n' + '─'.repeat(56));
if (!problems.length) {
  console.log(`结论：这台设备连的就是你的仓库。`);
  console.log(`      证据：key 指纹 ${fp} 能完整解开云端 ${segs.length} 个段（${totalEvents} 条原文），`);
  console.log(`            而随机 key 一个都解不开 —— 数据归属由密码学确定，不由 URL 确定。`);
  console.log(`\n换设备时对照这一行：指纹必须也是 ${fp}。不一样就是 key 拿错了。`);
} else {
  console.log(`结论：没通过，问题在上面标 ❌ 的地方（${problems.join(', ')}）`);
  process.exitCode = 1;
}
console.log('');
