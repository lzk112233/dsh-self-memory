// AES-256-GCM 封装：仓库里只放密文，没有本地 master.key 就解不开。
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const MAGIC = Buffer.from('SMB1', 'ascii')
const IV_LEN = 12
const TAG_LEN = 16
const KEY_LEN = 32

export function loadOrCreateKey(keyPath) {
  if (fs.existsSync(keyPath)) {
    const raw = fs.readFileSync(keyPath, 'utf8').trim()
    const key = Buffer.from(raw, 'base64')
    if (key.length !== KEY_LEN) throw new Error(`master.key 长度异常（${key.length}），应为 ${KEY_LEN}`)
    return key
  }
  const key = crypto.randomBytes(KEY_LEN)
  fs.mkdirSync(path.dirname(keyPath), { recursive: true })
  fs.writeFileSync(keyPath, key.toString('base64') + '\n', { mode: 0o600 })
  try { fs.chmodSync(keyPath, 0o600) } catch {}
  return key
}

// 字节级：会话文件本来就是 zstd，不需要再 JSON 化，直接整块加密
export function encryptBytes(key, plain) {
  const iv = crypto.randomBytes(IV_LEN)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const body = Buffer.concat([cipher.update(plain), cipher.final()])
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body])
}

export function decryptBytes(key, buf) {
  if (!Buffer.isBuffer(buf) || buf.length < MAGIC.length + IV_LEN + TAG_LEN) {
    throw new Error('密文长度不足')
  }
  if (!buf.subarray(0, 4).equals(MAGIC)) throw new Error('不是 self-memory vault 文件')
  const iv = buf.subarray(4, 4 + IV_LEN)
  const tag = buf.subarray(4 + IV_LEN, 4 + IV_LEN + TAG_LEN)
  const body = buf.subarray(4 + IV_LEN + TAG_LEN)
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(body), decipher.final()])
}

export function encryptJson(key, value) {
  return encryptBytes(key, Buffer.from(JSON.stringify(value), 'utf8'))
}

export function decryptJson(key, buf) {
  return JSON.parse(decryptBytes(key, buf).toString('utf8'))
}
