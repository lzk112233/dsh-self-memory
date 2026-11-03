#!/usr/bin/env node
// self-memory 云端同步 CLI（薄壳，逻辑在 lib/memory-sync.js，插件共用同一份）
//
//   node sync.mjs init <git-remote-url>   绑定远端（首次）
//   node sync.mjs push                    加密并推送
//   node sync.mjs pull                    拉取、解密、与本地合并
//   node sync.mjs sync                    pull + push
//   node sync.mjs status                  本地/远端计数
//   node sync.mjs key                     打印 master.key（换机器时导入用）
//   node sync.mjs import-key <base64>     写入 master.key
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadOrCreateKey } from './lib/memory-crypto.js'
import {
  syncPaths, initSync, pushSync, pullSync, statusSync, readSyncConfig, connectGithub
} from './lib/memory-sync.js'
import { buildEnv, readEnv } from './lib/memory-env.js'

const ROOT = process.env.SM_ROOT || path.join(os.homedir(), '.dsh', 'self-memory')

const actions = {
  async connect(pat, repoName) {
    const token = (pat || process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '').trim()
    if (!token) {
      throw new Error('用法：node sync.mjs connect <github_pat> [repo-name]\n也可以先设 GITHUB_TOKEN 环境变量。\nPAT 需要 repo 权限（classic）或 Contents+Pull requests 读写（fine-grained）')
    }
    const r = await connectGithub(ROOT, token, repoName || 'dsh-memory-vault')
    console.log(`账号：${r.login}`)
    console.log(`仓库：${r.remote}${r.existed ? '（已存在，直接复用）' : '（已新建，私有）'}`)
    console.log(`master.key：${r.keyPath}`)
    console.log(`key 指纹：${r.keyFingerprint}`)
    console.log('下一步：node sync.mjs push')
  },

  init(remote) {
    const r = initSync(ROOT, remote)
    console.log(`已绑定远端：${r.remote}`)
    console.log(`仓库目录：${r.repoDir}`)
    console.log(`master.key：${r.keyPath}（只在本机，绝不入仓）`)
    console.log(`key 指纹：${r.keyFingerprint}…`)
  },

  push() {
    // 推送前顺手刷新一次本机插件清单：后台 detached 推送时插件主线程不在场，
    // 这一步得 CLI 自己做，否则新装的插件永远上不了云。
    try {
      const before = readEnv(ROOT)?.plugins?.length ?? 0
      const env = buildEnv(ROOT)
      const after = env?.plugins?.length ?? 0
      if (after !== before) console.log(`环境清单已更新：${before} → ${after} 个插件`)
    } catch (error) {
      console.warn(`刷新环境清单失败（不影响推送）：${error?.message ?? error}`)
    }
    const r = pushSync(ROOT)
    if (r.pushed) {
      console.log(`已推送：新增 ${r.uploaded} 条，上传 ${r.bytes} B`)
    } else if (r.reason === 'no-change') {
      console.log('没有新内容，跳过提交')
    } else if (r.reason === 'locked') {
      console.log(`跳过：${r.detail}`)
    } else {
      console.log(`推送失败：${r.detail}`)
      console.log('凭据问题：先在 Windows 凭据管理器写入 GitHub PAT，或改用 SSH 远端（git@github.com:user/repo.git）')
      process.exitCode = 2
    }
    console.log(`累计 ${r.counts?.events ?? '?'} 条原文 / ${r.counts?.facts ?? '?'} 条事实 / ${r.counts?.selfNotes ?? '?'} 条自我认知`)
  },

  pull() {
    const r = pullSync(ROOT)
    if (!r.pulled) { console.log(`未拉取：${r.reason}`); return }
    console.log(`下载 ${r.segments} 个段（云端共 ${r.totalSegments} 个）${r.segments === 0 ? '——已是最新' : ''}`)
    console.log(`本地：${r.before.events} → ${r.after.events} 条原文（新增 ${r.added}）`)
    console.log(`事实 ${r.after.facts} / 自我认知 ${r.after.selfNotes}`)
    if (r.migrated) console.log('已把旧的整包 vault.enc 迁移为增量段')
  },

  sync() {
    actions.pull()
    actions.push()
  },

  status() {
    const s = statusSync(ROOT)
    console.log(`本地：${s.local.events} 条原文 / ${s.local.facts} 条事实 / ${s.local.selfNotes} 条自我认知`)
    console.log(`远端：${s.remoteUrl ?? '(未绑定)'}`)
    if (s.remote) console.log(`云端段：${s.remote.segments} 个，待拉取 ${s.remote.pending} 个${s.remote.legacy ? '（另有旧整包待迁移）' : ''}`)
    console.log(`已推送至：${s.upToT ? new Date(s.upToT).toLocaleString() : '从未'}`)
    console.log(`最近推送：${s.lastPushAt ? new Date(s.lastPushAt).toLocaleString() : '从未'}`)
    console.log(`最近拉取：${s.lastPullAt ? new Date(s.lastPullAt).toLocaleString() : '从未'}`)
  },

  key() {
    const { keyPath } = syncPaths(ROOT)
    console.log(loadOrCreateKey(keyPath).toString('base64'))
  },

  'import-key'(base64) {
    if (!base64) throw new Error('用法：node sync.mjs import-key <base64>')
    const key = Buffer.from(base64.trim(), 'base64')
    if (key.length !== 32) throw new Error('key 必须是 32 字节 base64')
    const { keyPath, syncDir } = syncPaths(ROOT)
    fs.mkdirSync(syncDir, { recursive: true })
    fs.writeFileSync(keyPath, key.toString('base64') + '\n', { mode: 0o600 })
    try { fs.chmodSync(keyPath, 0o600) } catch {}
    console.log(`已导入 key：${keyPath}`)
  }
}

const argv = process.argv.slice(2)
const action = argv[0]
const arg = argv[1]
const arg2 = argv[2]

if (!actions[action]) {
  console.log([
    '用法：node sync.mjs <command> [args]',
    '',
    '  connect <github_pat> [repo-name]  建私有仓库 + 绑定 + 存 token（一条命令接上 GitHub）',
    '  init <git-remote-url>             绑定已有远端',
    '  push                              加密并推送',
    '  pull                              拉取、解密、与本地合并',
    '  sync                              pull + push',
    '  status                            本地/远端计数',
    '  key                               打印 master.key（换机器时导入用）',
    '  import-key <base64>               写入 master.key'
  ].join('\n'))
  process.exit(1)
}

try {
  await actions[action](arg, arg2)
} catch (error) {
  console.error(`错误：${error?.message ?? error}`)
  process.exitCode = 1
}
