#!/usr/bin/env node
// 体检：这台机器能不能跑 dsh-self-memory，缺什么、下一步该敲什么。
// 专为"手机上装同一个插件"这种场景写：先把环境看清，别一上来就传 key。
//
//   node doctor.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { syncPaths, readSyncConfig, readRemoteEnv } from './lib/memory-sync.js'
import { loadOrCreateKey } from './lib/memory-crypto.js'
import { listSegments } from './lib/memory-segments.js'
import { findDshBin, defaultProfileDir, scanPlugins } from './lib/memory-env.js'

const ROOT = process.env.SM_ROOT || path.join(os.homedir(), '.dsh', 'self-memory')
const ok = (m) => console.log(`  ✅ ${m}`)
const warn = (m) => console.log(`  ⚠️  ${m}`)
const bad = (m) => console.log(`  ❌ ${m}`)
const info = (m) => console.log(`     ${m}`)

const todo = []

function has(cmd, args = ['--version']) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 8000 })
  return r.status === 0 ? `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n')[0] : null
}

console.log('\n【dsh-self-memory 体检】' + new Date().toLocaleString('zh-CN', { hour12: false }))

console.log('\n① 运行环境')
info(`平台：${process.platform} ${process.arch}`)
info(`Node：${process.version}（插件要求 ≥ 20）`)
info(`HOME：${os.homedir()}`)
info(`数据目录：${ROOT}${fs.existsSync(ROOT) ? '' : '（还不存在，第一次运行会建）'}`)
if (Number(process.versions.node.split('.')[0]) < 20) {
  bad('Node 版本太低，插件用到了 ESM 与较新的 crypto API')
  todo.push('升级 Node 到 20 以上')
} else ok('Node 版本够用')

console.log('\n② git —— 同步和设备网都靠它')
const gitVersion = has('git')
if (gitVersion) ok(gitVersion)
else {
  bad('找不到 git。记忆的云端同步、设备在线感知、远程派活全部依赖 git 命令')
  if (process.platform === 'android') {
    todo.push('装一个带 git 的终端（Termux: pkg install git），并让 dsh 能调用到它')
  } else {
    todo.push('装 git')
  }
}

console.log('\n③ dsh 可执行文件 —— 远程任务要靠它起 headless 会话')
const dshBin = findDshBin()
if (dshBin) {
  ok(dshBin)
  const v = has(dshBin, ['--version'])
  info(`版本：${v ?? '（读不到版本，不影响同步）'}`)
} else {
  warn('没找到 dsh 命令。同步和在线感知照常，只是不能自动执行别人派来的活')
  todo.push('把 dsh 放到 PATH 里，或把 allowRemote 设为 false')
}

console.log('\n④ 插件环境')
const profileDir = defaultProfileDir()
info(`profile：${profileDir}`)
try {
  const plugins = scanPlugins(profileDir)
  info(`已装插件 ${plugins.length} 个`)
  const self = plugins.find((p) => p.name === 'dsh-self-memory')
  if (self) ok(`dsh-self-memory ${self.version ?? ''}`)
  else warn('当前 profile 里没看到 dsh-self-memory 自己（通过 file: 链接装的会看不到，正常）')
} catch (error) {
  warn(`读 profile 失败：${error?.message ?? error}`)
}

console.log('\n⑤ 云端绑定')
const cfg = readSyncConfig(ROOT)
if (!cfg.remote) {
  warn('还没绑定远端——纯本地模式')
  todo.push('node sync.mjs join <导入码>   或者   node sync.mjs connect <github-pat>')
} else {
  ok(`远端：${cfg.remote}`)
  const p = syncPaths(ROOT)
  const tokenFile = path.join(p.syncDir, 'token')
  const hasToken = fs.existsSync(tokenFile) && fs.readFileSync(tokenFile, 'utf8').trim().length > 0
  if (hasToken) ok('GitHub token 已就位')
  else if (/^https:\/\/github\.com\//.test(cfg.remote)) {
    warn('私有仓库但没有 token，拉取会失败')
    todo.push('写入 token：node sync.mjs join <导入码>，或重新 connect')
  }
  if (fs.existsSync(p.repoDir)) {
    const segs = listSegments(p.repoDir)
    info(`本地已有 ${segs.length} 个加密段`)
  }
}

console.log('\n⑥ 密钥')
const p = syncPaths(ROOT)
if (fs.existsSync(p.keyPath)) {
  try {
    const key = loadOrCreateKey(p.keyPath)
    ok(`master.key 就位，指纹 ${key.subarray(0, 4).toString('hex')}`)
    info('这个指纹必须和另一台设备一致，否则解不开对方的密文')
  } catch (error) {
    bad(`master.key 有问题：${error?.message ?? error}`)
    todo.push('删掉 .sync/master.key 重新 join')
  }
} else {
  warn('还没有 master.key（第一次 join / connect 时会生成或导入）')
}

const remoteEnv = readRemoteEnv(ROOT)
if (remoteEnv?.plugins?.length) {
  console.log('\n⑦ 记忆里记着的插件')
  info(`${remoteEnv.plugins.length} 个：${remoteEnv.plugins.slice(0, 6).map((x) => x.name).join('、')}${remoteEnv.plugins.length > 6 ? '…' : ''}`)
  info('拉取之后可以用 self_memory_env action=apply 自动补装')
}

console.log('\n' + '─'.repeat(56))
if (!todo.length) {
  console.log('结论：这台机器可以直接用。')
} else {
  console.log('还差这些：')
  todo.forEach((t, i) => console.log(`  ${i + 1}. ${t}`))
}
console.log('')
