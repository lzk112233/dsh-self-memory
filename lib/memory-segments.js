// 增量段：每次推送只写"上次之后新增的那点东西"，而不是把整包重加密一遍。
//
// 原来的做法是整包 vault.enc 全量覆盖，记忆一多，每次 push 都要重传几百 KB 到几 MB，
// git 里也全是同一份文件的完整副本。改成 append-only 段之后：
//   - 每次 push 只产生一个新段，体积 = 新增对话的大小
//   - pull 只解密"本地还没应用过"的段
//   - 仓库历史天然是增量，不会因为全量覆盖而膨胀
//
// 段里放的是 events 增量；facts / selfNotes / env 很小（几十条），
// 仍然走整文件覆盖，够用且省事。
import fs from 'node:fs'
import path from 'node:path'
import { encryptJson, decryptJson } from './memory-crypto.js'

export const SEG_DIR = 'segments'
export const SEG_RE = /^seg-(\d{8}T\d{6}Z)-([a-z0-9]{6})\.enc$/

export function segmentDir(repoDir) {
  return path.join(repoDir, SEG_DIR)
}

export function segmentName(at = new Date()) {
  const stamp = at.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
  const rand = Math.random().toString(36).slice(2, 8).padEnd(6, '0')
  return `seg-${stamp}-${rand}.enc`
}

/** 列出远端（本地 repo 工作区）里所有段文件名，按时间升序。 */
export function listSegments(repoDir) {
  const dir = segmentDir(repoDir)
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((n) => SEG_RE.test(n))
    .sort()
}

export function writeSegment(repoDir, name, key, payload) {
  const dir = segmentDir(repoDir)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, name)
  const blob = encryptJson(key, payload)
  fs.writeFileSync(file, blob)
  return { file, name, bytes: blob.length }
}

export function readSegment(repoDir, name, key) {
  const file = path.join(segmentDir(repoDir), name)
  return decryptJson(key, fs.readFileSync(file))
}

/** 小文件（facts / selfNotes / env）走整文件覆盖，比较内容决定要不要重写。 */
export function writeSmall(repoDir, name, key, payload) {
  const file = path.join(repoDir, name)
  const body = JSON.stringify(payload ?? null)
  let prev = null
  try {
    prev = JSON.stringify(decryptJson(key, fs.readFileSync(file)))
  } catch {
    prev = null
  }
  if (prev === body && fs.existsSync(file)) return { file, name, bytes: fs.statSync(file).size, changed: false }
  const blob = encryptJson(key, payload ?? null)
  fs.writeFileSync(file, blob)
  return { file, name, bytes: blob.length, changed: true }
}

export function readSmall(repoDir, name, key) {
  const file = path.join(repoDir, name)
  if (!fs.existsSync(file)) return null
  try {
    return decryptJson(key, fs.readFileSync(file))
  } catch {
    return null
  }
}
