// 同步互斥：插件里有三条路会碰同一个 Git 仓库——10 分钟的归档检查、
// 30 分钟的例行推送、以及你手动喊一声"推一下"。它们要是撞在一起，
// git 会因为 index.lock 直接报错，所以先抢一把文件锁，抢不到就安静跳过，
// 下一个周期再试。
import fs from 'node:fs'
import path from 'node:path'

const STALE_MS = 10 * 60 * 1000

export function lockPath(root) {
  return path.join(root, '.sync', 'lock')
}

function alive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function acquire(file) {
  const fd = fs.openSync(file, 'wx')
  fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }))
  fs.closeSync(fd)
}

/**
 * 抢锁执行 fn。抢不到返回 { skipped: true, holder }，不抛错。
 * 锁持有者进程已死或锁太老（>10 分钟）时视为残留，直接接管。
 */
export function withSyncLock(root, fn, { staleMs = STALE_MS } = {}) {
  const file = lockPath(root)
  fs.mkdirSync(path.dirname(file), { recursive: true })

  try {
    acquire(file)
  } catch {
    let holder = null
    try {
      holder = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      holder = null
    }
    // 同一进程重入（pushSync 内部会调 pullSync）：锁本来就是自己拿的，直接执行
    if (holder && Number(holder.pid) === process.pid) {
      return { skipped: false, result: fn(), reentrant: true }
    }
    const age = Date.now() - Number(holder?.at ?? 0)
    const usable = holder && age < staleMs && alive(holder.pid)
    if (usable) return { skipped: true, holder }
    try {
      fs.unlinkSync(file)
    } catch {}
    try {
      acquire(file)
    } catch (e) {
      return { skipped: true, holder: null, busy: String(e?.message ?? e) }
    }
  }

  try {
    return { skipped: false, result: fn() }
  } finally {
    try {
      fs.unlinkSync(file)
    } catch {}
  }
}

export function isLocked(root, { staleMs = STALE_MS } = {}) {
  try {
    const holder = JSON.parse(fs.readFileSync(lockPath(root), 'utf8'))
    const age = Date.now() - Number(holder?.at ?? 0)
    return Boolean(holder && age < staleMs && alive(holder.pid))
  } catch {
    return false
  }
}
