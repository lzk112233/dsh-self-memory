// 环境清单：把"这台机器上装了哪些插件"变成可同步的数据。
//
// 为什么不用记忆文本去猜插件名：自然语言的"我装了 mnemon"没法可靠地变成安装命令。
// 所以单独存一份结构化清单 env.json，跟记忆一起加密同步。新机器拉下记忆后，
// 比对清单与本机实际安装情况，缺的自动补上——换设备就不再需要手动重装一遍环境。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'

export const ENV_FILE = 'env.json'

// 宿主自带的和插件自己（自己不用再装一遍）
const SKIP_NAMES = new Set(['dsh-self-memory'])
const SKIP_PREFIX = ['@deepseek-ai/']
// 本地路径/工作区链接的包换了机器就失效，同步过去也没意义
const SKIP_SPEC = /^(file:|link:|workspace:|portal:|\.|\/|[A-Za-z]:[\\/])/

export function defaultProfileDir() {
  const home = process.env.USERPROFILE || os.homedir()
  return path.join(home, '.dsh', 'profiles', 'desktop')
}

export function envPath(root) {
  return path.join(root, ENV_FILE)
}

export function readEnv(root) {
  try {
    const env = JSON.parse(fs.readFileSync(envPath(root), 'utf8'))
    if (!env || !Array.isArray(env.plugins)) return null
    return env
  } catch {
    return null
  }
}

export function writeEnv(root, env) {
  const file = envPath(root)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(env, null, 2), 'utf8')
  return env
}

function installedVersion(profileDir, name) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(profileDir, 'node_modules', name, 'package.json'), 'utf8'))
    return pkg.version ?? null
  } catch {
    return null
  }
}

/** 扫 profile 的 dependencies，只留下"换机器也装得回来"的 registry 包。 */
export function scanPlugins(profileDir = defaultProfileDir()) {
  let pkg = {}
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'))
  } catch {
    return []
  }
  const deps = pkg.dependencies ?? {}
  const out = []
  for (const [name, spec] of Object.entries(deps)) {
    if (SKIP_NAMES.has(name)) continue
    if (SKIP_PREFIX.some((p) => name.startsWith(p))) continue
    if (SKIP_SPEC.test(String(spec))) continue
    out.push({ name, spec: String(spec), version: installedVersion(profileDir, name) })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

export function buildEnv(root, profileDir = defaultProfileDir()) {
  const env = {
    version: 1,
    updatedAt: Date.now(),
    device: (() => {
      try { return `${process.platform}-${process.env.COMPUTERNAME ?? os.hostname()}` } catch { return 'host' }
    })(),
    profile: path.basename(profileDir),
    plugins: scanPlugins(profileDir)
  }
  // 内容没变就别改 updatedAt，否则每次启动都会让 vault 变脏
  const prev = readEnv(root)
  if (prev && JSON.stringify(prev.plugins) === JSON.stringify(env.plugins) && prev.profile === env.profile) {
    return prev
  }
  return writeEnv(root, env)
}

/** 远端清单里、本机没装的（本地实际安装情况才算数，不以 env.json 为准）。 */
export function diffEnv(localPlugins, remotePlugins) {
  const have = new Set((localPlugins ?? []).map((p) => p?.name).filter(Boolean))
  const seen = new Set()
  const missing = []
  for (const p of remotePlugins ?? []) {
    if (!p || !p.name) continue
    if (have.has(p.name) || seen.has(p.name)) continue
    if (SKIP_NAMES.has(p.name) || SKIP_PREFIX.some((x) => p.name.startsWith(x))) continue
    if (SKIP_SPEC.test(String(p.spec ?? ''))) continue
    seen.add(p.name)
    missing.push(p)
  }
  return missing
}

/** 找出 dsh 可执行文件（Electron 打包环境里和源码环境里位置不同）。 */
export function findDshBin() {
  const candidates = []
  const exeDir = path.dirname(process.execPath || '')
  candidates.push(path.join(exeDir, 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'))
  candidates.push(path.join(exeDir, '..', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'))
  const home = process.env.USERPROFILE || os.homedir()
  candidates.push(path.join(home, 'AppData', 'Local', 'Programs', 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'))
  for (const c of candidates) {
    try { if (fs.statSync(c).isFile()) return c } catch {}
  }
  return null
}

/**
 * 串行安装缺失插件。故意不并发：pnpm 改的是同一个 node_modules，并发会打架。
 * 返回每个包的 {name, ok, code, out}，失败不抛，交给调用方决定怎么提示。
 */
export function installPlugins({ plugins, dshBin, profile = 'desktop', timeoutMs = 600000, onLog = () => {} }) {
  return new Promise((resolve) => {
    const results = []
    if (!plugins?.length) return resolve({ results, installed: [] })
    if (!dshBin) {
      for (const p of plugins) results.push({ name: p.name, ok: false, out: '找不到 dsh 可执行文件' })
      return resolve({ results, installed: [] })
    }

    let i = 0
    const next = () => {
      if (i >= plugins.length) return resolve({ results, installed: results.filter((r) => r.ok).map((r) => r.name) })
      const p = plugins[i++]
      const spec = p.version ? `${p.name}@${p.version}` : p.spec ? `${p.name}@${p.spec}` : p.name
      onLog(`安装 ${spec} …`)
      const child = spawn(dshBin, ['plugin', '--profile', profile, 'add', spec], {
        shell: true,
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
      })
      let out = ''
      const cap = (b) => { out = (out + b.toString()).slice(-4000) }
      child.stdout?.on('data', cap)
      child.stderr?.on('data', cap)
      const timer = setTimeout(() => { try { child.kill() } catch {} }, timeoutMs)
      child.on('close', (code) => {
        clearTimeout(timer)
        const ok = code === 0
        results.push({ name: p.name, ok, code, out: out.trim().slice(-800) })
        onLog(`${ok ? '装好' : '失败'} ${p.name}${ok ? '' : '（' + out.trim().slice(-160) + '）'}`)
        next()
      })
      child.on('error', (error) => {
        clearTimeout(timer)
        results.push({ name: p.name, ok: false, out: String(error?.message ?? error) })
        next()
      })
    }
    next()
  })
}
