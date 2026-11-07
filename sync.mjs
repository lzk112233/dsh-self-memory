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
import { spawnSync } from 'node:child_process'
import { loadOrCreateKey } from './lib/memory-crypto.js'
import {
  syncPaths, initSync, pushSync, pullSync, statusSync, readSyncConfig, connectGithub, applyJoinCode
} from './lib/memory-sync.js'
import { buildEnv, readEnv } from './lib/memory-env.js'
import { sessionsStatus } from './lib/memory-sessions.js'

const ROOT = process.env.SM_ROOT || path.join(os.homedir(), '.dsh', 'self-memory')

// 手机上最常见的一堵墙：没有 git。与其让调用方对着一串 ENOENT 发呆，不如直接说人话。
function ensureGit() {
  const r = spawnSync('git', ['--version'], { encoding: 'utf8', timeout: 8000 })
  if (r.status === 0) return true
  console.error([
    '这台机器上没有 git，云端同步和设备网都跑不起来。',
    process.platform === 'android'
      ? 'Android 上的做法：装个 Termux（pkg install git nodejs），用它来跑这些命令；'
      : '先装 git（macOS: brew install git；Debian: apt install git）。',
    '插件本体在 DSH 里照常工作，只是没有云同步——本地记忆仍然会写。'
  ].join('\n'))
  process.exitCode = 3
  return false
}

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
    if (!ensureGit()) return
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
    if (r.sessions?.uploaded) {
      console.log(`会话本体：上传 ${r.sessions.uploaded} 个，${(r.sessions.bytes / 1048576).toFixed(2)} MB（云端共 ${r.sessions.remoteTotal} 个）`)
    }
    if (r.sessions?.skipped?.length) {
      console.log(`跳过 ${r.sessions.skipped.length} 个（${[...new Set(r.sessions.skipped.map((s) => s.reason))].join('/')}）`)
    }
  },

  pull() {
    if (!ensureGit()) return
    const r = pullSync(ROOT)
    if (!r.pulled) { console.log(`未拉取：${r.reason}`); return }
    console.log(`下载 ${r.segments} 个段（云端共 ${r.totalSegments} 个）${r.segments === 0 ? '——已是最新' : ''}`)
    console.log(`本地：${r.before.events} → ${r.after.events} 条原文（新增 ${r.added}）`)
    console.log(`事实 ${r.after.facts} / 自我认知 ${r.after.selfNotes}`)
    if (r.migrated) console.log('已把旧的整包 vault.enc 迁移为增量段')
    if (r.sessions) {
      const s = r.sessions
      console.log(`会话本体：新增 ${s.added} 个、更新 ${s.updated} 个、本地更新保留 ${s.skipped} 个（云端共 ${s.sessions} 个）`)
      if (s.workspaces && (s.workspaces.added || s.workspaces.updated)) {
        console.log(`已把 ${s.workspaces.added + s.workspaces.updated} 个工作区登记回侧栏，重启 DSH 后可见`)
      }
      if (s.conflicts?.length) console.log(`有 ${s.conflicts.length} 个会话本地比云端大，按本地为准（没覆盖）`)
    }
  },

  sync() {
    actions.pull()
    actions.push()
  },

  status() {
    if (!ensureGit()) return
    const s = statusSync(ROOT)
    console.log(`本地：${s.local.events} 条原文 / ${s.local.facts} 条事实 / ${s.local.selfNotes} 条自我认知`)
    console.log(`远端：${s.remoteUrl ?? '(未绑定)'}`)
    if (s.remote) console.log(`云端段：${s.remote.segments} 个，待拉取 ${s.remote.pending} 个${s.remote.legacy ? '（另有旧整包待迁移）' : ''}`)
    console.log(`已推送至：${s.upToT ? new Date(s.upToT).toLocaleString() : '从未'}`)
    console.log(`最近推送：${s.lastPushAt ? new Date(s.lastPushAt).toLocaleString() : '从未'}`)
    console.log(`最近拉取：${s.lastPullAt ? new Date(s.lastPullAt).toLocaleString() : '从未'}`)
    if (s.sessions) {
      const x = s.sessions
      console.log(`会话：本地 ${x.local} 个（${(x.localBytes / 1048576).toFixed(1)} MB，${x.projects} 个项目）/ 云端 ${x.remote} 个`)
      console.log(`  只在本机 ${x.onlyLocal} 个，只在云端 ${x.onlyRemote} 个，工作区记录 ${x.workspaces} 条`)
    }
  },

  key() {
    const { keyPath } = syncPaths(ROOT)
    console.log(loadOrCreateKey(keyPath).toString('base64'))
  },

  /**
   * 把「绑定一台新设备」需要的全部东西压成一行，方便用微信/QQ 发给自己再复制粘贴。
   * 里面是明文的 master.key 和 GitHub token —— 发给自己可以，发群里等于把记忆全送出去。
   */
  bundle() {
    const cfg = readSyncConfig(ROOT)
    if (!cfg.remote) throw new Error('还没绑定远端：先 node sync.mjs connect <pat> 或 init <url>')
    const key = loadOrCreateKey(syncPaths(ROOT).keyPath)
    const tokenPath = path.join(syncPaths(ROOT).syncDir, 'token')
    let token = ''
    try { token = fs.readFileSync(tokenPath, 'utf8').trim() } catch {}
    const payload = { v: 1, remote: cfg.remote, key: key.toString('base64'), token }
    const code = 'SMBJOIN1.' + Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
    console.log(code)
    console.error(`（这行码含 master.key${token ? ' 和 GitHub token' : ''}，只发给自己。长度 ${code.length}）`)
  },

  /** 在另一台设备上还原：写 key、写 token、绑远端。 */
  join(code) {
    if (!code) throw new Error('用法：node sync.mjs join <SMBJOIN1.xxx>')
    const r = applyJoinCode(ROOT, code)
    console.log(`已套用导入码：${r.remote}`)
    console.log(`key 指纹：${r.keyFingerprint}${r.hasToken ? '（token 已写入）' : '（没有 token，私有仓库会拉不动）'}`)
    console.log('下一步：node sync.mjs pull')
  },

  /**
   * 会话本体单干：只关心"另一台机器能不能看见这些对话"时用它。
   * push / pull 内部已经包含这一步，这里的 status 是给自己看的体检。
   */
  sessions(sub = 'status') {
    const p = syncPaths(ROOT)
    const dshRoot = path.dirname(ROOT)
    if (sub === 'push') return actions.push()
    if (sub === 'pull') return actions.pull()
    if (!fs.existsSync(p.repoDir)) throw new Error('同步仓库还没建立：先 node sync.mjs init <url> 或 connect <pat>')
    const x = sessionsStatus({ root: ROOT, repoDir: p.repoDir, key: loadOrCreateKey(p.keyPath), dshRoot })
    console.log(`本地会话：${x.local} 个，${(x.localBytes / 1048576).toFixed(1)} MB，跨 ${x.projects} 个项目`)
    console.log(`云端会话：${x.remote} 个（工作区记录 ${x.workspaces} 条）`)
    console.log(`只在本机：${x.onlyLocal} 个${x.onlyLocal ? '  ← 还没推上去' : ''}`)
    console.log(`只在云端：${x.onlyRemote} 个${x.onlyRemote ? '  ← 还没拉下来' : ''}`)
    if (x.updatedAt) console.log(`云端清单更新于：${new Date(x.updatedAt).toLocaleString()}`)
    if (!x.onlyLocal && !x.onlyRemote) console.log('两边的会话清单一致。')
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
    '  import-key <base64>               写入 master.key',
    '  bundle                            输出一行导入码（含 key 与 token，只发给自己）',
    '  join <SMBJOIN1.xxx>               在新设备上套用导入码',
    '  sessions [status|push|pull]       只处理会话本体（另一台机器要能看见之前的对话）'
  ].join('\n'))
  process.exit(1)
}

try {
  await actions[action](arg, arg2)
} catch (error) {
  console.error(`错误：${error?.message ?? error}`)
  process.exitCode = 1
}
