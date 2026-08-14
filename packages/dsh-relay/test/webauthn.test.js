// WebAuthn passkey tests — offline, zero deps. Exercises the CBOR decoder,
// authData/COSE parsing, and the register/login endpoints using a hand-built
// fake authenticator backed by an ephemeral P-256 (ES256) keypair.

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { generateKeyPairSync, sign, createHash, randomBytes } from 'node:crypto'

import {
  b64urlEncode,
  b64urlDecode,
  decodeCbor,
  parseAttestationObject,
  parseAuthData,
  cosePublicKeyToJwk,
  jwkToPublicKeyPem,
  verifyAssertionSignature,
} from '../src/webauthn.js'
import { createRelayServer } from '../src/server.js'

// --- helpers ----------------------------------------------------------------

function sha256(buf) {
  return createHash('sha256').update(buf).digest()
}

async function tmpDataDir() {
  return fs.promises.mkdtemp(path.join(os.tmpdir(), 'dsh-relay-webauthn-'))
}

// Minimal HTTP client (node:http), no keep-alive pooling.
function request(baseUrl, pathname, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl)
    const req = http.request(
      { hostname: u.hostname, port: Number(u.port), path: pathname, method, headers, agent: false },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const buf = Buffer.concat(chunks)
          resolve({
            status: res.statusCode,
            headers: res.headers,
            text: () => buf.toString('utf8'),
            json() {
              return JSON.parse(buf.toString('utf8'))
            },
          })
        })
      },
    )
    req.on('error', reject)
    if (body != null) req.write(body)
    req.end()
  })
}

// --- minimal CBOR encoder (test only) --------------------------------------

function cborEncodeHead(major, info) {
  if (info < 24) return Buffer.from([(major << 5) | info])
  if (info < 256) return Buffer.from([(major << 5) | 24, info])
  if (info < 65536) {
    const out = Buffer.alloc(3)
    out[0] = (major << 5) | 25
    out.writeUInt16BE(info, 1)
    return out
  }
  const out = Buffer.alloc(5)
  out[0] = (major << 5) | 26
  out.writeUInt32BE(info, 1)
  return out
}

function cborEncode(val) {
  if (val === null) return Buffer.from([0xf6])
  if (val === false) return Buffer.from([0xf4])
  if (val === true) return Buffer.from([0xf5])
  if (typeof val === 'number') {
    if (Number.isInteger(val)) {
      return val >= 0 ? cborEncodeHead(0, val) : cborEncodeHead(1, -1 - val)
    }
    throw new Error('float encoding not needed in tests')
  }
  if (Buffer.isBuffer(val)) {
    return Buffer.concat([cborEncodeHead(2, val.length), val])
  }
  if (typeof val === 'string') {
    const buf = Buffer.from(val, 'utf8')
    return Buffer.concat([cborEncodeHead(3, buf.length), buf])
  }
  if (Array.isArray(val)) {
    const parts = val.map(cborEncode)
    return Buffer.concat([cborEncodeHead(4, val.length), ...parts])
  }
  if (typeof val === 'object') {
    const entries = Object.entries(val)
    const parts = []
    for (const [k, v] of entries) {
      // Map keys may be numeric strings (COSE) or plain strings (attestation).
      parts.push(/^-?\d+$/.test(k) ? cborEncode(Number(k)) : cborEncode(k))
      parts.push(cborEncode(v))
    }
    return Buffer.concat([cborEncodeHead(5, entries.length), ...parts])
  }
  throw new Error('unsupported CBOR value in test encoder')
}

// --- fake authenticator -----------------------------------------------------

function makeFakeAuthenticator(rpId, origin) {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const jwk = publicKey.export({ format: 'jwk' })
  const credentialId = randomBytes(16)
  const credentialIdB64 = b64urlEncode(credentialId)
  const coseKey = cborEncode({
    1: 2,
    3: -7,
    '-1': 1,
    '-2': Buffer.from(jwk.x, 'base64url'),
    '-3': Buffer.from(jwk.y, 'base64url'),
  })

  function clientData(type, challenge) {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }))
  }

  function registrationAuthData(counter = 0) {
    const rpIdHash = sha256(Buffer.from(rpId))
    const header = Buffer.alloc(37)
    rpIdHash.copy(header, 0)
    header[32] = 0x41 // UP | AT
    header.writeUInt32BE(counter, 33)
    const aaguid = Buffer.alloc(16)
    const len = Buffer.alloc(2)
    len.writeUInt16BE(credentialId.length, 0)
    return Buffer.concat([header, aaguid, len, credentialId, coseKey])
  }

  function attestationObject(counter = 0) {
    return cborEncode({ fmt: 'none', attStmt: {}, authData: registrationAuthData(counter) })
  }

  function loginAuthData(counter = 0) {
    const rpIdHash = sha256(Buffer.from(rpId))
    const buf = Buffer.alloc(37)
    rpIdHash.copy(buf, 0)
    buf[32] = 0x01 // UP
    buf.writeUInt32BE(counter, 33)
    return buf
  }

  function loginAssertion(challenge, counter = 0) {
    const cd = clientData('webauthn.get', challenge)
    const authenticatorData = loginAuthData(counter)
    const signedData = Buffer.concat([authenticatorData, sha256(cd)])
    const signature = sign('sha256', signedData, privateKey)
    return { clientDataJSON: cd, authenticatorData, signature }
  }

  return {
    publicKey,
    privateKey,
    jwk,
    credentialId,
    credentialIdB64,
    coseKey,
    clientData,
    registrationAuthData,
    attestationObject,
    loginAssertion,
  }
}

// --- unit tests: CBOR decoder ----------------------------------------------

describe('webauthn CBOR decoder', () => {
  test('decodes known vectors', () => {
    assert.strictEqual(decodeCbor(Buffer.from([0x00])).value, 0)
    assert.strictEqual(decodeCbor(Buffer.from([0x01])).value, 1)
    assert.strictEqual(decodeCbor(Buffer.from([0x0a])).value, 10)
    assert.strictEqual(decodeCbor(Buffer.from([0x18, 0x64])).value, 100)
    assert.strictEqual(decodeCbor(Buffer.from([0x19, 0x03, 0xe8])).value, 1000)
    assert.strictEqual(decodeCbor(Buffer.from([0x20])).value, -1)
    assert.strictEqual(decodeCbor(Buffer.from([0x38, 0x63])).value, -100)
    assert.strictEqual(decodeCbor(Buffer.from([0x61, 0x61])).value, 'a')
    assert.deepStrictEqual(decodeCbor(Buffer.from([0x41, 0x61])).value, Buffer.from('a'))
    assert.deepStrictEqual(decodeCbor(Buffer.from([0x82, 0x01, 0x02])).value, [1, 2])
    assert.deepStrictEqual(decodeCbor(Buffer.from([0xa1, 0x01, 0x02])).value, { 1: 2 })
    assert.strictEqual(decodeCbor(Buffer.from([0xf5])).value, true)
    assert.strictEqual(decodeCbor(Buffer.from([0xf4])).value, false)
    assert.strictEqual(decodeCbor(Buffer.from([0xf6])).value, null)
    assert.strictEqual(decodeCbor(Buffer.from([0xc0, 0x00])).value, 0) // tag 0 -> 0
    // `next` points past the decoded item
    assert.strictEqual(decodeCbor(Buffer.from([0x00, 0x01])).next, 1)
    assert.strictEqual(decodeCbor(Buffer.from([0x82, 0x01, 0x02])).next, 3)
  })

  test('decodes a COSE EC key round-trip', () => {
    const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    const jwk = publicKey.export({ format: 'jwk' })
    const x = Buffer.from(jwk.x, 'base64url')
    const y = Buffer.from(jwk.y, 'base64url')
    const key = { 1: 2, 3: -7, '-1': 1, '-2': x, '-3': y }
    const decoded = decodeCbor(cborEncode(key)).value
    const { alg, jwk: parsed } = cosePublicKeyToJwk(decoded)
    assert.strictEqual(alg, -7)
    assert.strictEqual(parsed.kty, 'EC')
    assert.strictEqual(parsed.crv, 'P-256')
    assert.strictEqual(parsed.x, b64urlEncode(x))
    assert.strictEqual(parsed.y, b64urlEncode(y))
    const pem = jwkToPublicKeyPem(parsed)
    assert.ok(pem.includes('BEGIN PUBLIC KEY'))
  })
})

// --- unit tests: authData + signature --------------------------------------

describe('webauthn authData + signature', () => {
  test('parseAuthData extracts rpIdHash/flags/counter/credentialId/COSE key', () => {
    const auth = makeFakeAuthenticator('rp.example', 'https://rp.example')
    const authData = auth.registrationAuthData(7)
    const parsed = parseAuthData(authData)
    assert.ok(parsed.rpIdHash.equals(sha256(Buffer.from('rp.example'))))
    assert.strictEqual(parsed.flags, 0x41)
    assert.strictEqual(parsed.counter, 7)
    assert.ok(parsed.credentialId.equals(auth.credentialId))
    const { alg } = cosePublicKeyToJwk(parsed.cosePublicKey)
    assert.strictEqual(alg, -7)
  })

  test('parseAuthData without AT flag has no credential', () => {
    const buf = Buffer.alloc(37)
    buf[32] = 0x01
    buf.writeUInt32BE(3, 33)
    const parsed = parseAuthData(buf)
    assert.strictEqual(parsed.credentialId, null)
    assert.strictEqual(parsed.cosePublicKey, null)
    assert.strictEqual(parsed.counter, 3)
  })

  test('verifyAssertionSignature ES256 accepts a valid signature', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    const pem = publicKey.export({ type: 'spki', format: 'pem' })
    const authenticatorData = Buffer.from('0123456789abcdef')
    const clientDataJSON = Buffer.from('{"type":"webauthn.get"}')
    const signedData = Buffer.concat([authenticatorData, sha256(clientDataJSON)])
    const signature = sign('sha256', signedData, privateKey)
    assert.strictEqual(
      verifyAssertionSignature({ publicKeyPem: pem, alg: -7, authenticatorData, clientDataJSON, signature }),
      true,
    )
    // tampered signature fails
    assert.strictEqual(
      verifyAssertionSignature({ publicKeyPem: pem, alg: -7, authenticatorData, clientDataJSON, signature: Buffer.from([1, 2, 3]) }),
      false,
    )
  })
})

// --- endpoint integration with a fake authenticator -------------------------

describe('webauthn passkey endpoints', () => {
  const RP_ID = 'relay.example.com'
  const ORIGIN = 'https://relay.example.com'
  let relay
  let base
  let ownerCookie

  before(async () => {
    relay = createRelayServer({
      port: 0,
      dataDir: await tmpDataDir(),
      rpId: RP_ID,
      origin: ORIGIN,
      rpName: 'dsh-relay',
    })
    await relay.start()
    base = 'http://127.0.0.1:' + relay.port

    const bootstrap = await relay.ensureBootstrap()
    const setupRes = await request(base, '/relay/api/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bootstrapToken: bootstrap }),
    })
    assert.strictEqual(setupRes.status, 200)
    const sid = /dsh_relay_owner=([^;]+)/.exec(setupRes.headers['set-cookie'])[1]
    ownerCookie = 'dsh_relay_owner=' + sid
  })

  after(async () => {
    await relay.close()
  })

  test('register-options requires owner session', async () => {
    const res = await request(base, '/relay/api/passkey/register-options', { method: 'POST' })
    assert.strictEqual(res.status, 401)
  })

  test('registration then login round-trip succeeds', async () => {
    const auth = makeFakeAuthenticator(RP_ID, ORIGIN)

    // register-options
    const regOpts = await request(base, '/relay/api/passkey/register-options', {
      method: 'POST',
      headers: { cookie: ownerCookie },
    })
    assert.strictEqual(regOpts.status, 200)
    const o = regOpts.json()
    assert.strictEqual(o.rp.name, 'dsh-relay')
    assert.strictEqual(o.rp.id, RP_ID)
    assert.ok(o.challenge && o.challenge.length > 0)
    assert.ok(o.user.id)

    // register-verify
    const clientDataJSON = auth.clientData('webauthn.create', o.challenge)
    const regRes = await request(base, '/relay/api/passkey/register-verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: ownerCookie },
      body: JSON.stringify({
        id: auth.credentialIdB64,
        rawId: auth.credentialIdB64,
        response: {
          clientDataJSON: b64urlEncode(clientDataJSON),
          attestationObject: b64urlEncode(auth.attestationObject(0)),
        },
      }),
    })
    assert.strictEqual(regRes.status, 200)
    assert.strictEqual(regRes.json().ok, true)

    // the credential is persisted (public key only)
    assert.ok(relay.passkeyStore.findByCredentialId(auth.credentialIdB64))

    // login-options
    const loginOpts = await request(base, '/relay/api/passkey/login-options', { method: 'POST' })
    assert.strictEqual(loginOpts.status, 200)
    const challenge = loginOpts.json().challenge
    assert.ok(challenge && challenge.length > 0)

    // login-verify
    const assertion = auth.loginAssertion(challenge, 0)
    const loginRes = await request(base, '/relay/api/passkey/login-verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: auth.credentialIdB64,
        rawId: auth.credentialIdB64,
        response: {
          clientDataJSON: b64urlEncode(assertion.clientDataJSON),
          authenticatorData: b64urlEncode(assertion.authenticatorData),
          signature: b64urlEncode(assertion.signature),
          userHandle: null,
        },
      }),
    })
    assert.strictEqual(loginRes.status, 200)
    assert.strictEqual(loginRes.json().ok, true)
    assert.ok(loginRes.headers['set-cookie'])
  })

  test('wrong challenge fails with passkey-invalid', async () => {
    const auth = makeFakeAuthenticator(RP_ID, ORIGIN)
    // register
    const regOpts = await request(base, '/relay/api/passkey/register-options', {
      method: 'POST',
      headers: { cookie: ownerCookie },
    })
    const regRes = await request(base, '/relay/api/passkey/register-verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: ownerCookie },
      body: JSON.stringify({
        id: auth.credentialIdB64,
        rawId: auth.credentialIdB64,
        response: {
          clientDataJSON: b64urlEncode(auth.clientData('webauthn.create', regOpts.json().challenge)),
          attestationObject: b64urlEncode(auth.attestationObject(0)),
        },
      }),
    })
    assert.strictEqual(regRes.status, 200)

    // login with a challenge that was never issued
    const bogusChallenge = b64urlEncode(randomBytes(32))
    const assertion = auth.loginAssertion(bogusChallenge, 0)
    const res = await request(base, '/relay/api/passkey/login-verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: auth.credentialIdB64,
        rawId: auth.credentialIdB64,
        response: {
          clientDataJSON: b64urlEncode(assertion.clientDataJSON),
          authenticatorData: b64urlEncode(assertion.authenticatorData),
          signature: b64urlEncode(assertion.signature),
          userHandle: null,
        },
      }),
    })
    assert.strictEqual(res.status, 401)
    assert.strictEqual(res.json().error, 'passkey-invalid')
  })

  test('unknown credential fails with passkey-invalid', async () => {
    const auth = makeFakeAuthenticator(RP_ID, ORIGIN)
    const loginOpts = await request(base, '/relay/api/passkey/login-options', { method: 'POST' })
    const challenge = loginOpts.json().challenge
    const assertion = auth.loginAssertion(challenge, 0)
    const res = await request(base, '/relay/api/passkey/login-verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: auth.credentialIdB64, // never registered
        rawId: auth.credentialIdB64,
        response: {
          clientDataJSON: b64urlEncode(assertion.clientDataJSON),
          authenticatorData: b64urlEncode(assertion.authenticatorData),
          signature: b64urlEncode(assertion.signature),
          userHandle: null,
        },
      }),
    })
    assert.strictEqual(res.status, 401)
    assert.strictEqual(res.json().error, 'passkey-invalid')
  })

  test('a challenge is single-use', async () => {
    const auth = makeFakeAuthenticator(RP_ID, ORIGIN)
    // register
    const regOpts = await request(base, '/relay/api/passkey/register-options', {
      method: 'POST',
      headers: { cookie: ownerCookie },
    })
    await request(base, '/relay/api/passkey/register-verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: ownerCookie },
      body: JSON.stringify({
        id: auth.credentialIdB64,
        rawId: auth.credentialIdB64,
        response: {
          clientDataJSON: b64urlEncode(auth.clientData('webauthn.create', regOpts.json().challenge)),
          attestationObject: b64urlEncode(auth.attestationObject(0)),
        },
      }),
    })
    // login twice with the SAME challenge
    const loginOpts = await request(base, '/relay/api/passkey/login-options', { method: 'POST' })
    const challenge = loginOpts.json().challenge
    const assertion = auth.loginAssertion(challenge, 0)
    const payload = {
      id: auth.credentialIdB64,
      rawId: auth.credentialIdB64,
      response: {
        clientDataJSON: b64urlEncode(assertion.clientDataJSON),
        authenticatorData: b64urlEncode(assertion.authenticatorData),
        signature: b64urlEncode(assertion.signature),
        userHandle: null,
      },
    }
    const first = await request(base, '/relay/api/passkey/login-verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    assert.strictEqual(first.status, 200)
    const second = await request(base, '/relay/api/passkey/login-verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    assert.strictEqual(second.status, 401)
    assert.strictEqual(second.json().error, 'passkey-invalid')
  })
})
