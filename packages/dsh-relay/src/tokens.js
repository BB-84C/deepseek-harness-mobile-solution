// Token store: issues opaque tokens, persists only their SHA-256 hashes.
// A raw token is 32 random bytes (64 hex chars) and is shown exactly once.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

export const TOKEN_KINDS = ['instance', 'client', 'owner-bootstrap']

export function sha256hex(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

export class TokenStore {
  constructor(filePath) {
    this.filePath = filePath
    this.entries = []
    this._loaded = false
    this._saveTimer = null
  }

  async load() {
    if (this._loaded) return
    this._loaded = true
    try {
      const text = await fs.readFile(this.filePath, 'utf8')
      const parsed = JSON.parse(text)
      if (Array.isArray(parsed)) this.entries = parsed
      else if (parsed && Array.isArray(parsed.tokens)) this.entries = parsed.tokens
      else this.entries = []
    } catch (err) {
      if (err.code !== 'ENOENT' && !(err instanceof SyntaxError)) throw err
      this.entries = []
    }
  }

  async _persist() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    const tmp = this.filePath + '.' + process.pid + '.tmp'
    await fs.writeFile(tmp, JSON.stringify({ version: 1, tokens: this.entries }, null, 2), 'utf8')
    await fs.rename(tmp, this.filePath)
  }

  // Immediate, awaited write for create/import/revoke (rare, important events).
  async _save() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer)
      this._saveTimer = null
    }
    await this._persist()
  }

  // Debounced write for lastUsedAt bumps (frequent, low importance).
  _saveSoon() {
    if (this._saveTimer) return
    this._saveTimer = setTimeout(async () => {
      this._saveTimer = null
      try {
        await this._persist()
      } catch {
        /* best effort */
      }
    }, 500)
    if (this._saveTimer.unref) this._saveTimer.unref()
  }

  async flush() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer)
      this._saveTimer = null
    }
    await this._persist()
  }

  // Import a known raw token (e.g. a bootstrap secret supplied on the CLI).
  async importToken(raw, { label = '', kind = 'client' } = {}) {
    if (typeof raw !== 'string' || !/^[0-9a-f]{64}$/i.test(raw)) {
      throw new Error('token must be 64 hex chars (32 bytes)')
    }
    if (!TOKEN_KINDS.includes(kind)) throw new Error('unknown token kind: ' + kind)
    const hash = sha256hex(raw)
    if (this.entries.some((e) => e.hash === hash && !e.revoked)) {
      throw new Error('token already exists')
    }
    const entry = {
      hash,
      label,
      kind,
      createdAt: Date.now(),
      revoked: false,
      lastUsedAt: null,
    }
    this.entries.push(entry)
    await this._save()
    return { raw, entry }
  }

  // Create a new random token.
  async create(label = '', kind = 'client') {
    return this.importToken(randomBytes(32).toString('hex'), { label, kind })
  }

  // Verify a raw token; returns the live entry or null. Updates lastUsedAt.
  // Constant-time: hashes the presented token, then compares against every
  // stored hash with timingSafeEqual (never short-circuits on the first match,
  // so lookup time leaks nothing about which prefix matched).
  verify(raw) {
    if (typeof raw !== 'string' || raw.length === 0) return null
    const hash = sha256hex(raw)
    const presented = Buffer.from(hash, 'hex')
    let matched = null
    for (const entry of this.entries) {
      if (entry.revoked) continue
      if (Buffer.byteLength(entry.hash, 'hex') !== presented.length) continue
      if (timingSafeEqual(Buffer.from(entry.hash, 'hex'), presented)) {
        matched = entry
        break
      }
    }
    if (!matched) return null
    matched.lastUsedAt = Date.now()
    this._saveSoon()
    return matched
  }

  // Revoke by unique hash prefix; returns the live entry or null.
  // Awaits persistence so revocation is durable before the caller proceeds.
  async revoke(hashPrefix) {
    if (typeof hashPrefix !== 'string' || hashPrefix.length === 0) return null
    const prefix = hashPrefix.toLowerCase()
    const entry = this.entries.find(
      (e) => e.hash.startsWith(prefix) && !e.revoked,
    )
    if (!entry) return null
    entry.revoked = true
    await this._save()
    return entry
  }

  // Find the first active (non-revoked) entry of a kind.
  findActive(kind) {
    return this.entries.find((e) => e.kind === kind && !e.revoked) || null
  }

  // Public listing: never exposes full hashes.
  list() {
    return this.entries.map((e) => ({
      hashPrefix: e.hash.slice(0, 12),
      label: e.label,
      kind: e.kind,
      createdAt: e.createdAt,
      lastUsedAt: e.lastUsedAt,
      revoked: e.revoked,
    }))
  }
}
