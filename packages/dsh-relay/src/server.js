// dsh-relay server: an HTTP + WebSocket relay that fans many local dsh
// instances in over outbound WebSocket tunnels and multiplexes client HTTP
// requests over those tunnels. Zero runtime dependencies (Node >= 22).

import http from 'node:http'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { randomBytes, createHash } from 'node:crypto'
import { TokenStore } from './tokens.js'
import { Registry } from './registry.js'
import { WSSocket, acceptKey } from './ws.js'
import { connect } from './ws-client.js'
import {
  b64urlEncode,
  b64urlDecode,
  parseAttestationObject,
  parseAuthData,
  cosePublicKeyToJwk,
  jwkToPublicKeyPem,
  decodeClientDataJSON,
  verifyAssertionSignature,
} from './webauthn.js'

// --- Limits / defaults -------------------------------------------------------

const MAX_BODY_BYTES = 4 * 1024 * 1024 // cap request body forwarded through the tunnel
const MAX_HEADERS_BYTES = 64 * 1024 // cap serialized forwarded request headers
const MAX_JSON_BODY = 64 * 1024 // cap API JSON bodies (setup / create token)
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000 // owner session expiry
const TUNNEL_REGISTER_TIMEOUT_MS = 10_000 // tunnel registration handshake bound
const OWNER_COOKIE = 'dsh_relay_owner'
const INSTANCE_COOKIE = 'dsh_instance'
const CHALLENGE_TTL_MS = 5 * 60 * 1000 // WebAuthn challenge lifetime
const MAX_PASSKEY_BODY = 16 * 1024 // cap register/login-verify JSON bodies
const OWNER_USER_ID = b64urlEncode(Buffer.from('dsh-relay-owner', 'utf8'))

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
  'access-control-allow-headers': 'Authorization, Content-Type',
}

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length',
  'x-relay-instance', 'x-relay-latency-ms',
])
// Note: `authorization` is intentionally NOT stripped — the instance-side
// gateway is the device-auth boundary for both transports, so the client's
// device credential travels verbatim through the relay (see protocol §6).
// Request-side x-relay-* headers are stripped to prevent spoofing.

// --- Small helpers ----------------------------------------------------------

class RateLimiter {
  constructor(perMinute) {
    this.capacity = perMinute
    this.rate = perMinute / 60
    this.buckets = new Map()
    this._ops = 0
  }

  allow(key) {
    const now = Date.now()
    let b = this.buckets.get(key)
    if (!b) {
      b = { tokens: this.capacity, ts: now }
      this.buckets.set(key, b)
    } else {
      const elapsed = (now - b.ts) / 1000
      b.tokens = Math.min(this.capacity, b.tokens + elapsed * this.rate)
      b.ts = now
    }
    if (b.tokens >= 1) {
      b.tokens -= 1
      return true
    }
    return false
  }
}

// Persists WebAuthn credentials (public keys only) to <data-dir>/passkeys.json.
class PasskeyStore {
  constructor(filePath) {
    this.filePath = filePath
    this.credentials = []
    this._loaded = false
  }

  async load() {
    if (this._loaded) return
    this._loaded = true
    try {
      const text = await fs.readFile(this.filePath, 'utf8')
      const parsed = JSON.parse(text)
      if (Array.isArray(parsed)) this.credentials = parsed
      else if (parsed && Array.isArray(parsed.credentials)) this.credentials = parsed.credentials
      else this.credentials = []
    } catch (err) {
      if (err.code !== 'ENOENT' && !(err instanceof SyntaxError)) throw err
      this.credentials = []
    }
  }

  async _persist() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    const tmp = this.filePath + '.' + process.pid + '.tmp'
    await fs.writeFile(tmp, JSON.stringify({ version: 1, credentials: this.credentials }, null, 2), 'utf8')
    await fs.rename(tmp, this.filePath)
  }

  async save(credential) {
    this.credentials.push(credential)
    await this._persist()
  }

  findByCredentialId(credentialId) {
    return this.credentials.find((c) => c.credentialId === credentialId) || null
  }

  async updateCounter(credential, counter) {
    if (counter > credential.counter) {
      credential.counter = counter
      await this._persist()
    }
  }
}

function parseCookies(req) {
  const out = {}
  const header = req.headers.cookie
  if (!header) return out
  for (const part of String(header).split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim()
  }
  return out
}

function getClientIp(req) {
  const xff = req.headers['x-forwarded-for']
  if (typeof xff === 'string' && xff.length) return xff.split(',')[0].trim()
  return req.socket.remoteAddress || 'unknown'
}

function getBearer(req) {
  const h = req.headers.authorization
  if (typeof h !== 'string') return null
  const m = /^Bearer\s+(.+)$/i.exec(h)
  return m ? m[1].trim() : null
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    const done = (err, buf) => {
      if (settled) return
      settled = true
      if (err) reject(err)
      else resolve(buf)
    }
    req.on('data', (c) => {
      size += c.length
      if (size > maxBytes) {
        const err = new Error('body too large')
        err.tooLarge = true
        done(err)
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => done(null, Buffer.concat(chunks)))
    req.on('error', (e) => done(e))
    req.on('aborted', () => done(new Error('aborted')))
  })
}

async function readJson(req, maxBytes) {
  const buf = await readBody(req, maxBytes)
  if (!buf.length) return {}
  try {
    return JSON.parse(buf.toString('utf8'))
  } catch (err) {
    err.invalidJson = true
    throw err
  }
}

function stripRelayCookies(cookieHeader) {
  const kept = String(cookieHeader).split(';')
    .map((s) => s.trim())
    .filter((s) => {
      if (!s.length) return false
      // relay-private cookies never enter the tunnel
      if (s.startsWith(OWNER_COOKIE + '=')) return false
      if (s.startsWith(INSTANCE_COOKIE + '=')) return false
      return true
    })
  return kept.join('; ')
}

function sanitizeHeaders(headers) {
  const out = {}
  for (const [k, v] of Object.entries(headers)) {
    const lk = k.toLowerCase()
    if (HOP_BY_HOP.has(lk)) continue
    if (lk.startsWith('x-relay-')) continue // prevent spoofing relay response headers
    if (Array.isArray(v)) out[k] = v.join(', ')
    else if (v != null) out[k] = String(v)
  }
  if (out.cookie !== undefined) {
    const stripped = stripRelayCookies(out.cookie)
    if (stripped) out.cookie = stripped
    else delete out.cookie
  }
  return out
}

// --- Server factory ---------------------------------------------------------

export function createRelayServer(options = {}) {
  const opts = {
    host: options.host ?? '127.0.0.1',
    port: options.port ?? 4097,
    dataDir: options.dataDir ?? './data',
    rateLimitPerMin: options.rateLimitPerMin ?? 120,
    rpName: options.rpName ?? 'dsh-relay',
    rpId: options.rpId ?? null, // null -> derive from request host
    origin: options.origin ?? null, // null -> derive from request headers
    // e.g. '.dsh.bb84.ai': requests to <instance-id>.dsh.bb84.ai route to that
    // instance with the FULL path (no /relay/instance prefix) — the official
    // web frontend's absolute /api paths then work unchanged. OPTIONAL: needs
    // DNS + edge certs that cover multi-level subdomains (free Cloudflare
    // Universal SSL does NOT); the cookie router below is the primary mode.
    wildcardHost: options.wildcardHost ?? '',
    // e.g. 'dsh.bb84.ai': the public hostname of the picker. Non-/relay paths
    // on this host route by the `dsh_instance` cookie (set by the picker's
    // /relay/api/select links) — instance-as-origin behavior on ONE hostname,
    // fully compatible with the official frontend and free Cloudflare.
    publicHost: options.publicHost ?? '',
  }

  const tokenStore = new TokenStore(path.join(opts.dataDir, 'tokens.json'))
  const passkeyStore = new PasskeyStore(path.join(opts.dataDir, 'passkeys.json'))
  const registry = new Registry()
  const sessions = new Map() // sessionId -> expiry epoch ms
  const challenges = new Map() // WebAuthn challenge (b64url) -> expiry epoch ms
  const pendingMap = new Map() // streamId -> pending request record
  const clientRequests = new Map() // token hash -> Set<streamId>
  const rateLimiter = new RateLimiter(opts.rateLimitPerMin)
  let streamSeq = 0
  let startedAt = 0

  // --- auth -----------------------------------------------------------------

  function getSessionId(req) {
    return parseCookies(req)[OWNER_COOKIE] || null
  }

  function isOwner(req) {
    const sid = getSessionId(req)
    if (!sid) return false
    const exp = sessions.get(sid)
    if (!exp) return false
    if (Date.now() > exp) {
      sessions.delete(sid)
      return false
    }
    return true
  }

  function createOwnerSession() {
    const sid = randomBytes(32).toString('hex')
    sessions.set(sid, Date.now() + SESSION_TTL_MS)
    return sid
  }

  function setOwnerCookie(res, sid, req) {
    const secure = req && req.headers['x-forwarded-proto'] === 'https'
    let cookie = `${OWNER_COOKIE}=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`
    if (secure) cookie += '; Secure'
    res.setHeader('Set-Cookie', cookie)
  }

  function authenticateClientOrOwner(req) {
    if (isOwner(req)) return { type: 'owner' }
    const raw = getBearer(req)
    if (!raw) return null
    const entry = tokenStore.verify(raw)
    if (!entry || entry.kind !== 'client') return null
    return { type: 'client', entry }
  }

  // --- WebAuthn (owner passkey) ---------------------------------------------

  function expectedOrigin(req) {
    if (opts.origin) return opts.origin
    const proto = (req.headers['x-forwarded-proto'] || 'http').toString()
    const host = (req.headers['x-forwarded-host'] || req.headers.host || 'localhost').toString()
    return `${proto}://${host}`
  }

  function expectedRpId(req) {
    if (opts.rpId) return opts.rpId
    const host = (req.headers['x-forwarded-host'] || req.headers.host || 'localhost').toString()
    return host.split(':')[0]
  }

  function createChallenge() {
    if (challenges.size >= 100) {
      const now = Date.now()
      for (const [c, exp] of challenges) {
        if (now > exp) challenges.delete(c)
      }
    }
    const c = randomBytes(32).toString('base64url')
    challenges.set(c, Date.now() + CHALLENGE_TTL_MS)
    return c
  }

  function consumeChallenge(c) {
    const exp = challenges.get(c)
    if (exp === undefined) return false
    challenges.delete(c)
    if (Date.now() > exp) return false
    return true
  }

  function handlePasskeyRegisterOptions(req, res) {
    if (!isOwner(req)) return sendJson(res, 401, { error: 'unauthorized' })
    return sendJson(res, 200, {
      challenge: createChallenge(),
      rp: { name: opts.rpName, id: expectedRpId(req) },
      user: { id: OWNER_USER_ID, name: 'owner', displayName: 'Owner' },
    })
  }

  async function handlePasskeyRegisterVerify(req, res) {
    if (!isOwner(req)) return sendJson(res, 401, { error: 'unauthorized' })
    let body
    try {
      body = await readJson(req, MAX_PASSKEY_BODY)
    } catch {
      return sendJson(res, 400, { error: 'invalid-json' })
    }
    try {
      if (!body || !body.id || !body.response) throw new Error('bad request')
      const clientData = decodeClientDataJSON(b64urlDecode(body.response.clientDataJSON))
      if (clientData.type !== 'webauthn.create') throw new Error('bad type')
      if (clientData.origin !== expectedOrigin(req)) throw new Error('bad origin')
      if (!consumeChallenge(clientData.challenge)) throw new Error('bad challenge')
      const attObj = parseAttestationObject(b64urlDecode(body.response.attestationObject))
      const authData = parseAuthData(attObj.authData)
      if (!authData.credentialId || !authData.cosePublicKey) throw new Error('no attested credential')
      const expectedHash = createHash('sha256').update(expectedRpId(req)).digest()
      if (!authData.rpIdHash.equals(expectedHash)) throw new Error('bad rpIdHash')
      if (!b64urlDecode(body.id).equals(authData.credentialId)) throw new Error('credential id mismatch')
      const { alg, jwk } = cosePublicKeyToJwk(authData.cosePublicKey)
      const publicKeyPem = jwkToPublicKeyPem(jwk)
      await passkeyStore.save({
        credentialId: String(body.id),
        publicKeyPem,
        alg,
        counter: authData.counter,
        createdAt: Date.now(),
      })
      return sendJson(res, 200, { ok: true })
    } catch {
      return sendJson(res, 401, { error: 'passkey-invalid' })
    }
  }

  function handlePasskeyLoginOptions(req, res) {
    return sendJson(res, 200, { challenge: createChallenge() })
  }

  async function handlePasskeyLoginVerify(req, res) {
    let body
    try {
      body = await readJson(req, MAX_PASSKEY_BODY)
    } catch {
      return sendJson(res, 400, { error: 'invalid-json' })
    }
    try {
      if (!body || !body.id || !body.response) throw new Error('bad request')
      const clientDataJSON = b64urlDecode(body.response.clientDataJSON)
      const clientData = decodeClientDataJSON(clientDataJSON)
      if (clientData.type !== 'webauthn.get') throw new Error('bad type')
      if (clientData.origin !== expectedOrigin(req)) throw new Error('bad origin')
      if (!consumeChallenge(clientData.challenge)) throw new Error('bad challenge')
      const credentialId = String(body.id)
      const cred = passkeyStore.findByCredentialId(credentialId)
      if (!cred) throw new Error('unknown credential')
      const authenticatorData = b64urlDecode(body.response.authenticatorData)
      const authData = parseAuthData(authenticatorData)
      const signature = b64urlDecode(body.response.signature)
      if (!verifyAssertionSignature({
        publicKeyPem: cred.publicKeyPem,
        alg: cred.alg,
        authenticatorData,
        clientDataJSON,
        signature,
      })) {
        throw new Error('bad signature')
      }
      if (authData.counter > 0 && cred.counter > 0 && authData.counter <= cred.counter) {
        throw new Error('counter regression')
      }
      await passkeyStore.updateCounter(cred, authData.counter)
      const sid = createOwnerSession()
      setOwnerCookie(res, sid, req)
      return sendJson(res, 200, { ok: true })
    } catch {
      return sendJson(res, 401, { error: 'passkey-invalid' })
    }
  }

  // --- response helpers -----------------------------------------------------

  function sendJson(res, status, obj) {
    const body = JSON.stringify(obj)
    res.writeHead(status, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
    })
    res.end(body)
  }

  function sendHtml(res, status, html) {
    res.writeHead(status, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': Buffer.byteLength(html),
    })
    res.end(html)
  }

  function sendEmpty(res, status) {
    res.writeHead(status, { 'content-length': '0' })
    res.end()
  }

  // --- forwarding -----------------------------------------------------------

  function trackClientRequest(auth, streamId) {
    if (!auth || auth.type !== 'client') return
    const hash = auth.entry.hash
    let set = clientRequests.get(hash)
    if (!set) {
      set = new Set()
      clientRequests.set(hash, set)
    }
    set.add(streamId)
  }

  function cleanupPending(streamId) {
    const p = pendingMap.get(streamId)
    if (!p) return
    pendingMap.delete(streamId)
    registry.closeStream(p.instanceId, streamId)
    if (p.auth && p.auth.type === 'client') {
      const set = clientRequests.get(p.auth.entry.hash)
      if (set) {
        set.delete(streamId)
        if (set.size === 0) clientRequests.delete(p.auth.entry.hash)
      }
    }
  }

  function abortPending(p, status, errorObj) {
    if (p.started) {
      p.res.destroy()
    } else {
      try {
        sendJson(p.res, status, errorObj)
      } catch {
        try {
          p.res.destroy()
        } catch {
          /* ignore */
        }
      }
    }
  }

  function failPending(instanceId) {
    for (const p of [...pendingMap.values()]) {
      if (p.instanceId !== instanceId) continue
      abortPending(p, 502, { error: 'instance-offline' })
      cleanupPending(p.id)
    }
  }

  function handleInstanceMessage(instanceId, data, isBinary) {
    if (isBinary) return
    let msg
    try {
      msg = JSON.parse(data.toString('utf8'))
    } catch {
      return
    }
    if (!msg || msg.v !== 1 || typeof msg.id !== 'number') return
    const p = pendingMap.get(msg.id)
    if (!p || p.instanceId !== instanceId) return

    if (msg.t === 'res') {
      if (p.started) return
      p.started = true
      const status = Number.isInteger(msg.status) ? msg.status : 502
      const headers = {}
      if (msg.headers && typeof msg.headers === 'object') {
        for (const [k, v] of Object.entries(msg.headers)) {
          if (v == null) continue
          headers[k] = Array.isArray(v) ? v.join(', ') : String(v)
        }
      }
      headers['x-relay-instance'] = instanceId
      headers['x-relay-latency-ms'] = String(Date.now() - p.start)
      try {
        p.res.writeHead(status, headers)
      } catch {
        /* headers already sent */
      }
      p.stream.reset()
    } else if (msg.t === 'chunk') {
      if (!p.started) return
      let buf = Buffer.alloc(0)
      if (typeof msg.bodyBase64 === 'string' && msg.bodyBase64.length) {
        buf = Buffer.from(msg.bodyBase64, 'base64')
      }
      if (buf.length) p.res.write(buf)
      p.stream.reset()
    } else if (msg.t === 'end') {
      p.stream.reset()
      p.res.end()
      cleanupPending(msg.id)
    }
  }

  async function handleForward(req, res, id, forwardUrl, auth) {
    if (!registry.has(id)) return sendJson(res, 404, { error: 'unknown-instance' })
    const inst = registry.get(id)
    if (!inst) return sendJson(res, 502, { error: 'instance-offline' })

    const headers = sanitizeHeaders(req.headers)
    if (Buffer.byteLength(JSON.stringify(headers)) > MAX_HEADERS_BYTES) {
      return sendJson(res, 431, { error: 'headers-too-large' })
    }

    let bodyBuf
    try {
      bodyBuf = await readBody(req, MAX_BODY_BYTES)
    } catch (err) {
      if (err.tooLarge) return sendJson(res, 413, { error: 'body-too-large' })
      return
    }

    const streamId = ++streamSeq
    const opened = registry.openStream(id, streamId, () => {
      const p = pendingMap.get(streamId)
      if (!p) return
      abortPending(p, 504, { error: 'request-timeout' })
      cleanupPending(streamId)
    })
    if (opened.error) {
      if (opened.error === 'stream-limit') return sendJson(res, 503, { error: 'stream-limit' })
      return sendJson(res, 502, { error: 'instance-offline' })
    }

    const pending = {
      res,
      id: streamId,
      instanceId: id,
      auth,
      start: Date.now(),
      started: false,
      stream: opened.stream,
    }
    pendingMap.set(streamId, pending)
    trackClientRequest(auth, streamId)

    res.on('close', () => {
      if (pendingMap.has(streamId)) cleanupPending(streamId)
    })
    req.on('aborted', () => {
      if (pendingMap.has(streamId)) cleanupPending(streamId)
    })

    const frame = {
      v: 1,
      t: 'req',
      id: streamId,
      method: req.method,
      url: forwardUrl,
      headers,
    }
    if (bodyBuf.length) frame.bodyBase64 = bodyBuf.toString('base64')

    if (!inst.socket.sendText(JSON.stringify(frame))) {
      cleanupPending(streamId)
      return sendJson(res, 502, { error: 'instance-offline' })
    }
  }

  // --- API handlers ---------------------------------------------------------

  async function handleSetup(req, res) {
    let body
    try {
      body = await readJson(req, MAX_JSON_BODY)
    } catch (err) {
      return sendJson(res, err.tooLarge ? 413 : 400, {
        error: err.tooLarge ? 'body-too-large' : 'invalid-json',
      })
    }
    if (!body || typeof body.bootstrapToken !== 'string' || !body.bootstrapToken) {
      return sendJson(res, 400, { error: 'missing-bootstrap-token' })
    }
    const entry = tokenStore.verify(body.bootstrapToken)
    if (!entry || entry.kind !== 'owner-bootstrap') {
      return sendJson(res, 401, { error: 'invalid-bootstrap-token' })
    }
    entry.revoked = true
    await tokenStore.flush()
    const sid = createOwnerSession()
    setOwnerCookie(res, sid, req)
    return sendJson(res, 200, { ok: true })
  }

  function handleLogout(req, res) {
    const sid = getSessionId(req)
    if (sid) sessions.delete(sid)
    res.setHeader('Set-Cookie', `${OWNER_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`)
    return sendJson(res, 200, { ok: true })
  }

  async function handleCreateToken(req, res) {
    let body
    try {
      body = await readJson(req, MAX_JSON_BODY)
    } catch (err) {
      return sendJson(res, err.tooLarge ? 413 : 400, {
        error: err.tooLarge ? 'body-too-large' : 'invalid-json',
      })
    }
    const label = typeof body.label === 'string' ? body.label : ''
    const kind = body.kind
    if (kind !== 'instance' && kind !== 'client') {
      return sendJson(res, 400, { error: 'invalid-kind' })
    }
    const { raw, entry } = await tokenStore.create(label, kind)
    return sendJson(res, 201, {
      token: raw,
      hashPrefix: entry.hash.slice(0, 12),
      label: entry.label,
      kind: entry.kind,
      createdAt: entry.createdAt,
      revoked: entry.revoked,
    })
  }

  async function handleRevokeToken(req, res, prefix) {
    const entry = await tokenStore.revoke(prefix)
    if (!entry) return sendJson(res, 404, { error: 'token-not-found' })
    if (entry.kind === 'instance') registry.dropByToken(entry.hash)
    const set = clientRequests.get(entry.hash)
    if (set) {
      for (const sid of [...set]) {
        const p = pendingMap.get(sid)
        if (p) {
          abortPending(p, 503, { error: 'token-revoked' })
          cleanupPending(sid)
        }
      }
      clientRequests.delete(entry.hash)
    }
    return sendJson(res, 200, { ok: true, revoked: entry.hash.slice(0, 12) })
  }

  // --- router ---------------------------------------------------------------

  async function handleRequest(req, res) {
    res.setHeader('access-control-allow-origin', CORS_HEADERS['access-control-allow-origin'])
    res.setHeader('access-control-allow-methods', CORS_HEADERS['access-control-allow-methods'])
    res.setHeader('access-control-allow-headers', CORS_HEADERS['access-control-allow-headers'])

    if (!rateLimiter.allow(getClientIp(req))) {
      return sendJson(res, 429, { error: 'rate-limited' })
    }

    let u
    try {
      u = new URL(req.url, 'http://relay.local')
    } catch {
      return sendJson(res, 400, { error: 'bad-request' })
    }
    const pathname = u.pathname
    const method = req.method

    if (method === 'OPTIONS') return sendEmpty(res, 204)

    // Primary instance entry: /instance/<id>/<path...>. Sets (refreshes) the
    // routing cookie, then forwards the path minus the prefix — the official
    // frontend's later ABSOLUTE /api and /mobile paths ride the cookie.
    if (pathname.startsWith('/instance/')) {
      const after = pathname.slice('/instance/'.length)
      const slash = after.indexOf('/')
      const id = decodeURIComponent(slash === -1 ? after : after.slice(0, slash))
      if (!/^[a-z0-9-]{1,64}$/.test(id)) return sendJson(res, 400, { error: 'bad-instance' })
      const secure = req.headers['x-forwarded-proto'] === 'https'
      res.setHeader(
        'set-cookie',
        `dsh_instance=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secure ? '; Secure' : ''}`,
      )
      const restPath = slash === -1 ? '/' : after.slice(slash)
      return handleForward(req, res, id, restPath + u.search, null)
    }

    // Wildcard subdomain routing (OPTIONAL extra): <instance-id><wildcardHost>
    // -> that instance, full path forwarded (no prefix stripping).
    if (opts.wildcardHost && typeof req.headers.host === 'string') {
      const host = req.headers.host.split(':')[0].toLowerCase()
      const suffix = opts.wildcardHost.toLowerCase()
      if (host.length > suffix.length && host.endsWith(suffix)) {
        const id = host.slice(0, -suffix.length)
        if (/^[a-z0-9-]{1,64}$/.test(id)) {
          return handleForward(req, res, id, u.pathname + u.search, null)
        }
      }
    }

    // Cookie routing on the public host: /relay/* stays relay-local; everything
    // else routes to the instance named by the dsh_instance cookie.
    if (opts.publicHost && typeof req.headers.host === 'string') {
      const host = req.headers.host.split(':')[0].toLowerCase()
      if (host === opts.publicHost.toLowerCase() && !pathname.startsWith('/relay/')) {
        const selected = parseCookies(req)['dsh_instance'] || null
        if (selected && /^[a-z0-9-]{1,64}$/.test(selected)) {
          return handleForward(req, res, selected, u.pathname + u.search, null)
        }
        res.writeHead(302, { location: '/relay/' })
        res.end()
        return
      }
    }

    if (method === 'GET' && pathname === '/relay/api/select') {
      const id = u.searchParams.get('instance') || ''
      if (!/^[a-z0-9-]{1,64}$/.test(id)) return sendJson(res, 400, { error: 'bad-instance' })
      let next = u.searchParams.get('next') || '/instance/' + encodeURIComponent(id) + '/'
      if (!next.startsWith('/') || next.startsWith('//')) next = '/'
      const secure = req.headers['x-forwarded-proto'] === 'https'
      res.setHeader(
        'set-cookie',
        `dsh_instance=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secure ? '; Secure' : ''}`,
      )
      res.writeHead(302, { location: next })
      res.end()
      return
    }

    if (method === 'GET' && pathname === '/relay/health') {
      return sendJson(res, 200, {
        ok: true,
        uptime: Math.floor((Date.now() - startedAt) / 1000),
        instances: registry.list().filter((i) => i.online).length,
      })
    }

    if (method === 'GET' && (pathname === '/relay/' || pathname === '/relay')) {
      return sendHtml(res, 200, DASHBOARD_HTML.replaceAll('__WILDCARD__', JSON.stringify(opts.wildcardHost)))
    }

    if (method === 'POST' && pathname === '/relay/api/setup') {
      return handleSetup(req, res)
    }

    if (method === 'POST' && pathname === '/relay/api/passkey/register-options') {
      return handlePasskeyRegisterOptions(req, res)
    }
    if (method === 'POST' && pathname === '/relay/api/passkey/register-verify') {
      return handlePasskeyRegisterVerify(req, res)
    }
    if (method === 'POST' && pathname === '/relay/api/passkey/login-options') {
      return handlePasskeyLoginOptions(req, res)
    }
    if (method === 'POST' && pathname === '/relay/api/passkey/login-verify') {
      return handlePasskeyLoginVerify(req, res)
    }

    if (method === 'POST' && pathname === '/relay/api/logout') {
      return handleLogout(req, res)
    }

    if (pathname === '/relay/api/tokens') {
      if (!isOwner(req)) {
        if (getBearer(req)) return sendJson(res, 403, { error: 'forbidden' })
        return sendJson(res, 401, { error: 'unauthorized' })
      }
      if (method === 'GET') return sendJson(res, 200, tokenStore.list())
      if (method === 'POST') return handleCreateToken(req, res)
      return sendJson(res, 405, { error: 'method-not-allowed' })
    }

    if (method === 'DELETE' && pathname.startsWith('/relay/api/tokens/')) {
      if (!isOwner(req)) {
        if (getBearer(req)) return sendJson(res, 403, { error: 'forbidden' })
        return sendJson(res, 401, { error: 'unauthorized' })
      }
      const prefix = decodeURIComponent(pathname.slice('/relay/api/tokens/'.length))
      return handleRevokeToken(req, res, prefix)
    }

    if (method === 'GET' && pathname === '/relay/api/targets') {
      // Public directory: ids + names + online state only. The picker page
      // needs it without credentials; instance access itself is authenticated
      // by each instance's gateway.
      return sendJson(res, 200, registry.list())
    }

    if (pathname.startsWith('/relay/instance/')) {
      // Transport-only path: the relay does NOT authenticate here. The
      // instance-side gateway authenticates the client (Authorization passes
      // through verbatim). Relay client tokens guard the directory only.
      const after = pathname.slice('/relay/instance/'.length)
      const slash = after.indexOf('/')
      let id
      let restPath
      if (slash === -1) {
        id = after
        restPath = '/'
      } else {
        id = after.slice(0, slash)
        restPath = after.slice(slash)
      }
      id = decodeURIComponent(id)
      return handleForward(req, res, id, restPath + u.search, null)
    }

    return sendJson(res, 404, { error: 'not-found' })
  }

  function rejectUpgrade(socket, status, text) {
    try {
      socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
    } catch {
      /* ignore */
    }
    socket.destroy()
  }

  function handleUpgrade(req, socket, head) {
    let u
    try {
      u = new URL(req.url, 'http://relay.local')
    } catch {
      return rejectUpgrade(socket, 400, 'Bad Request')
    }
    if (u.pathname !== '/relay/instance-tunnel') {
      return rejectUpgrade(socket, 404, 'Not Found')
    }

    // Tunnel registration is synchronous (query params on the upgrade request);
    // TUNNEL_REGISTER_TIMEOUT_MS documents the handshake bound. The node 'upgrade'
    // event only fires once the full request is in, so this is effectively instant.
    void TUNNEL_REGISTER_TIMEOUT_MS

    const instanceToken = u.searchParams.get('instanceToken') || ''
    const id = u.searchParams.get('id') || ''
    const name = u.searchParams.get('name') || ''

    const entry = tokenStore.verify(instanceToken)
    if (!entry || entry.kind !== 'instance') {
      return rejectUpgrade(socket, 401, 'Unauthorized')
    }
    if (!registry.validateId(id) || !registry.validateName(name)) {
      return rejectUpgrade(socket, 400, 'Bad Request')
    }
    const key = req.headers['sec-websocket-key']
    if (typeof key !== 'string' || !key) {
      return rejectUpgrade(socket, 400, 'Bad Request')
    }

    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Accept: ' + acceptKey(key),
      '',
      '',
    ].join('\r\n'))
    socket.setNoDelay(true)

    const ws = new WSSocket(socket, { requireMasked: true, maskOutgoing: false })
    const inst = registry.register(id, name, ws, entry.hash)
    ws.on('message', (data, isBinary) => {
      // Ignore frames from a replaced (stale) tunnel socket.
      if (registry.get(id)?.socket !== ws) return
      registry.touch(id)
      handleInstanceMessage(id, data, isBinary)
    })
    ws.on('close', (code, reason) => {
      console.log(`[dsh-relay] tunnel close id=${id} code=${code} reason=${JSON.stringify(reason)}`)
      // Guard against a delayed close event from a replaced tunnel: skip only
      // when a DIFFERENT socket already owns the id (the new tunnel is live
      // and its in-flight streams must not be killed). When the id is already
      // unregistered (e.g. token revocation), still abort its in-flight streams.
      const current = registry.get(id)
      if (current && current.socket !== ws) return
      registry.unregister(id)
      failPending(id)
    })
    ws.on('error', () => {})
    if (head && head.length) ws.feed(head)
  }

  const httpServer = http.createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      // A rejected handler must never leave the client with an empty reply
      // (proxies upstream translate that into 502). Log the real cause and
      // answer with a 500 when nothing has been written yet.
      console.error('[dsh-relay] request failed:', err?.stack || err)
      try {
        if (!res.headersSent) sendJson(res, 500, { error: 'internal-error' })
        else res.destroy()
      } catch {
        try {
          res.destroy()
        } catch {
          /* ignore */
        }
      }
    })
  })
  httpServer.on('upgrade', handleUpgrade)

  const relay = {
    httpServer,
    tokenStore,
    passkeyStore,
    registry,
    options: opts,
    port: null,

    async start() {
      await tokenStore.load()
      await passkeyStore.load()
      startedAt = Date.now()
      await new Promise((resolve, reject) => {
        const onError = (err) => reject(err)
        httpServer.once('error', onError)
        httpServer.listen(opts.port, opts.host, () => {
          httpServer.removeListener('error', onError)
          resolve()
        })
      })
      relay.port = httpServer.address().port
      // Keepalive: Cloudflare (and other proxies) drop idle WebSockets after
      // ~100s. Ping every online tunnel well below that; instances auto-pong.
      relay._keepalive = setInterval(() => {
        for (const socket of registry.onlineSockets()) {
          try {
            socket?.ping?.()
          } catch {
            /* a dead socket closes itself via its own error path */
          }
        }
      }, 30000)
      if (relay._keepalive.unref) relay._keepalive.unref()
      return relay
    },

    // Ensure an active owner-bootstrap token exists. Returns the raw token when
    // one was newly created/imported, or null when an active one already exists.
    async ensureBootstrap(rawArg) {
      await tokenStore.load()
      if (tokenStore.findActive('owner-bootstrap')) return null
      if (rawArg) {
        await tokenStore.importToken(rawArg, { label: 'owner-bootstrap', kind: 'owner-bootstrap' })
        return rawArg
      }
      const created = await tokenStore.create('owner-bootstrap', 'owner-bootstrap')
      return created.raw
    },

    async close() {
      if (relay._keepalive) {
        clearInterval(relay._keepalive)
        relay._keepalive = null
      }
      registry.closeAll()
      for (const p of [...pendingMap.values()]) {
        abortPending(p, 503, { error: 'relay-closing' })
        cleanupPending(p.id)
      }
      sessions.clear()
      await tokenStore.flush()
      await new Promise((resolve) => {
        httpServer.close(() => resolve())
        if (typeof httpServer.closeAllConnections === 'function') {
          httpServer.closeAllConnections()
        } else if (typeof httpServer.closeIdleConnections === 'function') {
          httpServer.closeIdleConnections()
        }
      })
    },
  }

  return relay
}

// --- Fake instance (tests only) ---------------------------------------------
// A minimal instance-side tunnel endpoint: connects outbound like a real dsh
// instance, and answers "req" frames by emitting res -> chunk -> end.

function defaultEcho(msg) {
  const body = JSON.stringify({
    method: msg.method,
    url: msg.url,
    headers: msg.headers || {},
    bodyBase64: msg.bodyBase64 || null,
  })
  return { status: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from(body) }
}

export async function createFakeInstance({ url, token, id, name, handler } = {}) {
  const u = new URL(url)
  u.pathname = '/relay/instance-tunnel'
  u.search = `?instanceToken=${encodeURIComponent(token)}&id=${encodeURIComponent(id)}&name=${encodeURIComponent(name)}`
  const ws = await connect(u.toString())

  ws.on('message', async (data, isBinary) => {
    if (isBinary) return
    let msg
    try {
      msg = JSON.parse(data.toString('utf8'))
    } catch {
      return
    }
    if (!msg || msg.v !== 1 || msg.t !== 'req') return
    let result
    try {
      result = handler
        ? await handler({ method: msg.method, url: msg.url, headers: msg.headers || {}, bodyBase64: msg.bodyBase64 })
        : defaultEcho(msg)
    } catch {
      result = {
        status: 500,
        headers: { 'content-type': 'application/json' },
        body: Buffer.from(JSON.stringify({ error: 'internal' })),
      }
    }
    const body = Buffer.isBuffer(result.body)
      ? result.body
      : Buffer.from(String(result.body == null ? '' : result.body))
    const status = result.status ?? 200
    const headers = { ...(result.headers || {}) }
    headers['content-length'] = String(body.length)
    ws.sendText(JSON.stringify({ v: 1, t: 'res', id: msg.id, status, headers }))
    if (body.length) {
      ws.sendText(JSON.stringify({ v: 1, t: 'chunk', id: msg.id, bodyBase64: body.toString('base64') }))
    }
    ws.sendText(JSON.stringify({ v: 1, t: 'end', id: msg.id }))
  })

  return {
    ws,
    id,
    name,
    close() {
      ws.close(1000, 'bye')
    },
  }
}

// --- Owner dashboard (plain, dark, no frameworks) ---------------------------

const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>dsh-relay owner</title>
<style>
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; background: #0f1115; color: #e6e8eb; padding: 24px; }
header { display: flex; align-items: center; gap: 16px; margin-bottom: 24px; flex-wrap: wrap; }
h1 { font-size: 20px; margin: 0; }
h2 { font-size: 15px; margin: 28px 0 8px; }
#status { color: #8b949e; font-size: 13px; flex: 1; }
button, input, select { background: #1c2128; color: #e6e8eb; border: 1px solid #30363d; border-radius: 6px; padding: 7px 12px; font-size: 13px; }
button { cursor: pointer; }
button:hover { background: #262c34; }
table { border-collapse: collapse; width: 100%; margin: 12px 0; }
th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #21262d; font-size: 13px; }
th { color: #8b949e; font-weight: 600; }
form { display: flex; gap: 8px; align-items: center; margin: 12px 0; flex-wrap: wrap; }
#newToken { font-family: ui-monospace, "Cascadia Mono", monospace; color: #7ee787; word-break: break-all; }
#setupMsg { color: #f85149; }
.on { color: #7ee787; }
.off { color: #8b949e; }
</style>
</head>
<body>
<header>
  <h1>dsh-relay</h1>
  <span id="status">…</span>
  <button id="logout" style="display:none">Log out</button>
</header>

<section id="picker">
  <h2>Instances</h2>
  <p style="color:#8b949e;font-size:13px">Pick a machine — device authentication happens on the machine itself.</p>
  <table id="instances">
    <thead><tr><th>ID</th><th>Name</th><th>Online</th><th>Last seen</th></tr></thead>
    <tbody></tbody>
  </table>
</section>

<section id="setup" style="display:none">
  <h2>Set up owner access</h2>
  <p>Enter the one-time bootstrap token printed by the relay at startup.</p>
  <form id="setupForm">
    <input id="bootstrap" type="password" placeholder="bootstrap token" size="70">
    <button type="submit">Set up owner session</button>
  </form>
  <p id="setupMsg"></p>
  <p><button id="loginPasskey">Sign in with passkey</button></p>
</section>

<section id="panel" style="display:none">
  <h2>Tokens</h2>
  <form id="createToken">
    <input id="label" placeholder="label" size="20">
    <select id="kind">
      <option value="client">client</option>
      <option value="instance">instance</option>
    </select>
    <button type="submit">Create token</button>
  </form>
  <p id="newToken"></p>
  <table id="tokens">
    <thead><tr><th>Hash</th><th>Label</th><th>Kind</th><th>Created</th><th>Last used</th><th>State</th></tr></thead>
    <tbody></tbody>
  </table>

  <h2>Security</h2>
  <p><button id="registerPasskey">Register passkey</button> <span id="passkeyMsg"></span></p>
</section>

<script>
const WILDCARD_HOST = __WILDCARD__;
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
async function api(path, opts) {
  const res = await fetch(path, opts);
  let body = null;
  try { body = await res.json(); } catch (e) {}
  return { status: res.status, body: body };
}
async function loadTokens() {
  const res = await api('/relay/api/tokens');
  const tbody = document.querySelector('#tokens tbody');
  tbody.innerHTML = '';
  const rows = Array.isArray(res.body) ? res.body : [];
  for (const t of rows) {
    const tr = document.createElement('tr');
    const created = new Date(t.createdAt).toLocaleString();
    const last = t.lastUsedAt ? new Date(t.lastUsedAt).toLocaleString() : '-';
    const state = t.revoked ? 'revoked' : '<button data-prefix="' + esc(t.hashPrefix) + '">revoke</button>';
    tr.innerHTML = '<td>' + esc(t.hashPrefix) + '</td><td>' + esc(t.label || '') + '</td><td>' + esc(t.kind) + '</td><td>' + created + '</td><td>' + last + '</td><td>' + state + '</td>';
    tbody.appendChild(tr);
  }
}
async function loadTargets() {
  const res = await api('/relay/api/targets');
  const tbody = document.querySelector('#instances tbody');
  tbody.innerHTML = '';
  const rows = Array.isArray(res.body) ? res.body : [];
  for (const t of rows) {
    const tr = document.createElement('tr');
    const last = t.lastSeenMs ? new Date(t.lastSeenMs).toLocaleString() : '-';
    const state = t.online ? '<span class="on">● online</span>' : '<span class="off">○ offline</span>';
    const idCell = '<a href="/instance/' + esc(t.id) + '/" style="color:#7ee787">' + esc(t.id) + '</a>';
    tr.innerHTML = '<td>' + idCell + '</td><td>' + esc(t.name) + '</td><td>' + state + '</td><td>' + last + '</td>';
    tbody.appendChild(tr);
  }
}
async function refresh() {
  const tokensRes = await api('/relay/api/tokens');
  if (tokensRes.status === 200) {
    document.getElementById('setup').style.display = 'none';
    document.getElementById('panel').style.display = 'block';
    document.getElementById('logout').style.display = 'inline-block';
    document.getElementById('status').textContent = 'owner session active';
    await loadTokens();
    await loadTargets();
  } else {
    document.getElementById('setup').style.display = 'block';
    document.getElementById('panel').style.display = 'none';
    document.getElementById('logout').style.display = 'none';
    document.getElementById('status').textContent = 'not authenticated';
    await loadTargets();
  }
}
document.addEventListener('click', async function (e) {
  if (e.target && e.target.tagName === 'BUTTON' && e.target.dataset.prefix) {
    await api('/relay/api/tokens/' + encodeURIComponent(e.target.dataset.prefix), { method: 'DELETE' });
    await loadTokens();
  }
});
document.getElementById('logout').addEventListener('click', async function () {
  await api('/relay/api/logout', { method: 'POST' });
  location.reload();
});
document.getElementById('setupForm').addEventListener('submit', async function (e) {
  e.preventDefault();
  const token = document.getElementById('bootstrap').value.trim();
  const res = await api('/relay/api/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bootstrapToken: token })
  });
  const msg = document.getElementById('setupMsg');
  if (res.status === 200) {
    msg.textContent = 'Owner session created.';
    await refresh();
  } else {
    msg.textContent = 'Setup failed: ' + (res.body && res.body.error ? res.body.error : res.status);
  }
});
document.getElementById('createToken').addEventListener('submit', async function (e) {
  e.preventDefault();
  const label = document.getElementById('label').value.trim();
  const kind = document.getElementById('kind').value;
  const res = await api('/relay/api/tokens', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label: label, kind: kind })
  });
  const el = document.getElementById('newToken');
  if (res.status === 201) {
    el.textContent = 'Token (shown once, copy it now): ' + res.body.token;
  } else {
    el.textContent = 'Failed: ' + (res.body && res.body.error ? res.body.error : res.status);
  }
  await loadTokens();
});
function bufToB64url(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlToBuf(s) {
  let t = String(s).replace(/-/g, '+').replace(/_/g, '/');
  while (t.length % 4) t += '=';
  const bin = atob(t);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}
async function registerPasskey() {
  const el = document.getElementById('passkeyMsg');
  el.textContent = '';
  const opts = await api('/relay/api/passkey/register-options', { method: 'POST' });
  if (opts.status !== 200) { el.textContent = 'Could not start registration.'; return; }
  const o = opts.body;
  let credential;
  try {
    credential = await navigator.credentials.create({
      publicKey: {
        challenge: b64urlToBuf(o.challenge),
        rp: o.rp,
        user: { id: b64urlToBuf(o.user.id), name: o.user.name, displayName: o.user.displayName },
        pubKeyCredParams: [
          { type: 'public-key', alg: -7 },
          { type: 'public-key', alg: -257 }
        ],
        timeout: 60000,
        attestation: 'none'
      }
    });
  } catch (err) {
    el.textContent = 'Registration cancelled or failed.';
    return;
  }
  const res = await api('/relay/api/passkey/register-verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: credential.id,
      rawId: bufToB64url(credential.rawId),
      response: {
        clientDataJSON: bufToB64url(credential.response.clientDataJSON),
        attestationObject: bufToB64url(credential.response.attestationObject)
      }
    })
  });
  el.textContent = res.status === 200 ? 'Passkey registered.' : 'Registration failed.';
}
async function loginPasskey() {
  const opts = await api('/relay/api/passkey/login-options', { method: 'POST' });
  if (opts.status !== 200) { document.getElementById('setupMsg').textContent = 'Could not start sign-in.'; return; }
  let assertion;
  try {
    assertion = await navigator.credentials.get({
      publicKey: { challenge: b64urlToBuf(opts.body.challenge), timeout: 60000 }
    });
  } catch (err) {
    document.getElementById('setupMsg').textContent = 'Sign-in cancelled or failed.';
    return;
  }
  const res = await api('/relay/api/passkey/login-verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: assertion.id,
      rawId: bufToB64url(assertion.rawId),
      response: {
        clientDataJSON: bufToB64url(assertion.response.clientDataJSON),
        authenticatorData: bufToB64url(assertion.response.authenticatorData),
        signature: bufToB64url(assertion.response.signature),
        userHandle: assertion.response.userHandle ? bufToB64url(assertion.response.userHandle) : null
      }
    })
  });
  if (res.status === 200) {
    location.reload();
  } else {
    document.getElementById('setupMsg').textContent = 'Passkey sign-in failed.';
  }
}
document.getElementById('loginPasskey').addEventListener('click', loginPasskey);
document.getElementById('registerPasskey').addEventListener('click', registerPasskey);
refresh();
setInterval(loadTargets, 5000);
</script>
</body>
</html>
`
