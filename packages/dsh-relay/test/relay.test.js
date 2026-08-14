// Offline test suite for @bb-84c/dsh-relay. No dependencies, no network.

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { WSSocket, OP, acceptKey } from '../src/ws.js'
import { connect } from '../src/ws-client.js'
import { TokenStore, sha256hex } from '../src/tokens.js'
import { Registry } from '../src/registry.js'
import { createRelayServer, createFakeInstance } from '../src/server.js'

// --- helpers ----------------------------------------------------------------

function makePair() {
  return new Promise((resolve) => {
    let clientSock
    const server = net.createServer((serverSock) => {
      resolve({ serverSock, clientSock, server })
    })
    server.listen(0, '127.0.0.1', () => {
      clientSock = net.connect(server.address().port, '127.0.0.1')
    })
  })
}

function closePair(pair) {
  try {
    pair.serverSock.destroy()
  } catch {}
  try {
    pair.clientSock.destroy()
  } catch {}
  pair.server.close()
}

async function tmpDataDir() {
  return fs.promises.mkdtemp(path.join(os.tmpdir(), 'dsh-relay-'))
}

// Minimal HTTP client (node:http) so we can set arbitrary headers (cookies).
// `agent: false` opts out of keep-alive pooling (Connection: close), so no idle
// socket is left behind to keep the test process's event loop alive.
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

async function waitFor(fn, timeout = 3000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (fn()) return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('waitFor timed out')
}

// --- ws.js unit tests -------------------------------------------------------

describe('ws.js', () => {
  test('acceptKey RFC 6455 vector', () => {
    assert.strictEqual(
      acceptKey('dGhlIHNhbXBsZSBub25jZQ=='),
      's3pPLMBiTxaQ9kYGzzhZRbK+xOo=',
    )
  })

  test('text/binary round-trip', async () => {
    const pair = await makePair()
    const s = new WSSocket(pair.serverSock, { requireMasked: true, maskOutgoing: false })
    const c = new WSSocket(pair.clientSock, { maskOutgoing: true, requireMasked: false })
    s.on('error', () => {})
    c.on('error', () => {})

    const got1 = new Promise((r) => c.once('message', (d, b) => r({ d, b })))
    s.sendText('hello')
    const r1 = await got1
    assert.strictEqual(r1.d.toString(), 'hello')
    assert.strictEqual(r1.b, false)

    const got2 = new Promise((r) => s.once('message', (d, b) => r({ d, b })))
    c.sendBinary(Buffer.from([1, 2, 3]))
    const r2 = await got2
    assert.strictEqual(r2.b, true)
    assert.deepStrictEqual([...r2.d], [1, 2, 3])

    closePair(pair)
  })

  test('ping auto-pong both directions', async () => {
    const pair = await makePair()
    const s = new WSSocket(pair.serverSock, { requireMasked: true, maskOutgoing: false })
    const c = new WSSocket(pair.clientSock, { maskOutgoing: true, requireMasked: false })
    s.on('error', () => {})
    c.on('error', () => {})

    // c -> s ping: s receives 'ping' and auto-replies; c receives the 'pong'.
    const sGotPing = new Promise((r) => s.once('ping', (d) => r(d.toString())))
    const cGotPong = new Promise((r) => c.once('pong', (d) => r(d.toString())))
    c.ping('ping-client')
    assert.strictEqual(await sGotPing, 'ping-client')
    assert.strictEqual(await cGotPong, 'ping-client')

    // s -> c ping: c receives 'ping' and auto-replies; s receives the 'pong'.
    const cGotPing = new Promise((r) => c.once('ping', (d) => r(d.toString())))
    const sGotPong = new Promise((r) => s.once('pong', (d) => r(d.toString())))
    s.ping('ping-server')
    assert.strictEqual(await cGotPing, 'ping-server')
    assert.strictEqual(await sGotPong, 'ping-server')

    closePair(pair)
  })

  test('fragmented message reassembly', async () => {
    const pair = await makePair()
    const s = new WSSocket(pair.serverSock, { requireMasked: true, maskOutgoing: false })
    const c = new WSSocket(pair.clientSock, { maskOutgoing: true, requireMasked: false })
    s.on('error', () => {})
    c.on('error', () => {})

    const got = new Promise((r) => s.once('message', (d) => r(d.toString())))
    c.send('Hel', { opcode: OP.TEXT, fin: false })
    c.send('lo ', { opcode: OP.CONT, fin: false })
    c.send('world', { opcode: OP.CONT, fin: true })
    assert.strictEqual(await got, 'Hello world')

    closePair(pair)
  })

  test('close handshake propagates code', async () => {
    const pair = await makePair()
    const s = new WSSocket(pair.serverSock, { requireMasked: true, maskOutgoing: false })
    const c = new WSSocket(pair.clientSock, { maskOutgoing: true, requireMasked: false })
    s.on('error', () => {})
    c.on('error', () => {})

    const serverClose = new Promise((r) => s.once('close', (code) => r(code)))
    c.close(1000, 'bye')
    assert.strictEqual(await serverClose, 1000)

    closePair(pair)
  })

  test('server rejects unmasked client frame', async () => {
    const pair = await makePair()
    const s = new WSSocket(pair.serverSock, { requireMasked: true, maskOutgoing: false })
    s.on('error', () => {})
    const closed = new Promise((r) => s.once('close', (code) => r(code)))
    // Raw unmasked text frame "hi": 0x81 0x02 0x68 0x69
    pair.clientSock.write(Buffer.from([0x81, 0x02, 0x68, 0x69]))
    assert.strictEqual(await closed, 1002)
    closePair(pair)
  })
})

// --- tokens.js / registry.js unit tests ------------------------------------

describe('tokens.js', () => {
  test('create/verify/revoke/list + persistence', async () => {
    const dir = await tmpDataDir()
    const file = path.join(dir, 'tokens.json')
    const store = new TokenStore(file)
    await store.load()

    const { raw, entry } = await store.create('lbl', 'client')
    assert.match(raw, /^[0-9a-f]{64}$/)
    assert.strictEqual(entry.hash, sha256hex(raw))
    assert.notStrictEqual(entry.hash, raw)

    const verified = store.verify(raw)
    assert.ok(verified)
    assert.strictEqual(verified.kind, 'client')

    const list = store.list()
    assert.strictEqual(list.length, 1)
    assert.strictEqual(list[0].hashPrefix.length, 12)
    assert.strictEqual(list[0].hash, undefined)
    assert.strictEqual(list[0].revoked, false)

    const revoked = await store.revoke(list[0].hashPrefix)
    assert.ok(revoked)
    assert.strictEqual(store.verify(raw), null)

    const store2 = new TokenStore(file)
    await store2.load()
    assert.strictEqual(store2.list().length, 1)
    assert.strictEqual(store2.list()[0].revoked, true)
  })

  test('verify rejects unknown and revoked', async () => {
    const store = new TokenStore(path.join(await tmpDataDir(), 'tokens.json'))
    await store.load()
    assert.strictEqual(store.verify('nope'), null)
    assert.strictEqual(store.verify(''), null)
  })
})

describe('registry.js', () => {
  test('register/list/offline/streams', () => {
    const reg = new Registry()
    assert.throws(() => reg.register('BAD_ID', 'n', {}, 'h'))
    assert.throws(() => reg.register('ok-id', 'Bad Name!', {}, 'h'))

    const inst = reg.register('abc-1', 'name', { close() {} }, 'h1')
    assert.ok(reg.get('abc-1'))
    assert.strictEqual(reg.list()[0].online, true)
    assert.strictEqual(reg.list()[0].name, 'name')

    // stream open + 32 cap
    const opened = reg.openStream('abc-1', 1, () => {})
    assert.ok(opened.stream)
    for (let i = 2; i <= 32; i++) reg.openStream('abc-1', i, () => {})
    assert.strictEqual(reg.openStream('abc-1', 33, () => {}).error, 'stream-limit')
    reg.closeStream('abc-1', 1)

    // unregister -> offline, still known
    reg.unregister('abc-1')
    assert.strictEqual(reg.get('abc-1'), null)
    assert.strictEqual(reg.has('abc-1'), true)
    assert.strictEqual(reg.list()[0].online, false)
    assert.strictEqual(reg.openStream('abc-1', 1, () => {}).error, 'instance-offline')

    // unknown
    assert.strictEqual(reg.has('nope'), false)
    assert.strictEqual(reg.get('nope'), null)
  })
})

// --- integration ------------------------------------------------------------

describe('relay integration', () => {
  let relay
  let base
  let wsBase
  let ownerCookie
  let clientToken
  let clientPrefix
  let instanceToken
  let instanceId

  before(async () => {
    relay = createRelayServer({ port: 0, dataDir: await tmpDataDir(), wildcardHost: '.inst.example.com', publicHost: 'relay.example.com' })
    await relay.start()
    base = 'http://127.0.0.1:' + relay.port
    wsBase = 'ws://127.0.0.1:' + relay.port

    // owner setup
    const bootstrapRaw = await relay.ensureBootstrap()
    assert.ok(bootstrapRaw)
    const setupRes = await request(base, '/relay/api/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bootstrapToken: bootstrapRaw }),
    })
    assert.strictEqual(setupRes.status, 200)
    const sid = /dsh_relay_owner=([^;]+)/.exec(setupRes.headers['set-cookie'])[1]
    ownerCookie = 'dsh_relay_owner=' + sid

    // tokens
    const clientRes = await request(base, '/relay/api/tokens', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: ownerCookie },
      body: JSON.stringify({ label: 'client', kind: 'client' }),
    })
    const clientBody = clientRes.json()
    clientToken = clientBody.token
    clientPrefix = clientBody.hashPrefix

    const instanceRes = await request(base, '/relay/api/tokens', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: ownerCookie },
      body: JSON.stringify({ label: 'instance', kind: 'instance' }),
    })
    instanceToken = instanceRes.json().token
    instanceId = 'test-' + Date.now()
  })

  after(async () => {
    await relay.close()
  })

  test('health endpoint shape', async () => {
    const res = await request(base, '/relay/health')
    assert.strictEqual(res.status, 200)
    const body = res.json()
    assert.strictEqual(body.ok, true)
    assert.strictEqual(typeof body.uptime, 'number')
    assert.strictEqual(typeof body.instances, 'number')
  })

  test('dashboard HTML is served', async () => {
    const res = await request(base, '/relay/')
    assert.strictEqual(res.status, 200)
    assert.ok(res.headers['content-type'].includes('text/html'))
    const html = res.text()
    assert.ok(html.includes('dsh hosts'))
    assert.ok(html.includes('createToken'))
  })

  test('targets list shape', async () => {
    const res = await request(base, '/relay/api/targets', {
      headers: { authorization: 'Bearer ' + clientToken },
    })
    assert.strictEqual(res.status, 200)
    const body = res.json()
    assert.ok(Array.isArray(body))
    for (const t of body) {
      assert.strictEqual(typeof t.id, 'string')
      assert.strictEqual(typeof t.name, 'string')
      assert.strictEqual(typeof t.online, 'boolean')
      assert.strictEqual(typeof t.lastSeenMs, 'number')
    }
  })

  test('instance passthrough (GET) + x-relay headers', async () => {
    const inst = await createFakeInstance({
      url: wsBase, token: instanceToken, id: instanceId, name: 'my-instance',
    })
    try {
      await waitFor(() => relay.registry.get(instanceId) !== null)
      const res = await request(base, '/relay/instance/' + instanceId + '/api/hello?x=1', {
        headers: { authorization: 'Bearer ' + clientToken },
      })
      assert.strictEqual(res.status, 200)
      assert.strictEqual(res.headers['x-relay-instance'], instanceId)
      assert.ok(Number(res.headers['x-relay-latency-ms']) >= 0)
      const body = res.json()
      assert.strictEqual(body.method, 'GET')
      assert.strictEqual(body.url, '/api/hello?x=1')

      const targets = (await request(base, '/relay/api/targets', {
        headers: { authorization: 'Bearer ' + clientToken },
      })).json()
      const t = targets.find((x) => x.id === instanceId)
      assert.ok(t)
      assert.strictEqual(t.online, true)
      assert.strictEqual(t.name, 'my-instance')
    } finally {
      inst.close()
    }
  })

  test('instance passthrough (POST body, base64)', async () => {
    const inst = await createFakeInstance({
      url: wsBase, token: instanceToken, id: instanceId, name: 'my-instance',
    })
    try {
      await waitFor(() => relay.registry.get(instanceId) !== null)
      const res = await request(base, '/relay/instance/' + instanceId + '/submit', {
        method: 'POST',
        headers: {
          authorization: 'Bearer ' + clientToken,
          'content-type': 'text/plain',
        },
        body: 'hello body',
      })
      assert.strictEqual(res.status, 200)
      const body = res.json()
      assert.strictEqual(body.method, 'POST')
      assert.strictEqual(Buffer.from(body.bodyBase64, 'base64').toString(), 'hello body')
    } finally {
      inst.close()
    }
  })

  test('auth failures (401/403)', async () => {
    // The directory is public (the picker page needs it without credentials);
    // instance access itself is authenticated by each instance's gateway.
    assert.strictEqual((await request(base, '/relay/api/targets')).status, 200)
    // The proxy path is transport-only (the instance gateway authenticates):
    // an unknown instance answers 404 even without any relay credential.
    assert.strictEqual((await request(base, '/relay/instance/x/y')).status, 404)
    assert.strictEqual((await request(base, '/relay/api/tokens')).status, 401)
    assert.strictEqual(
      (await request(base, '/relay/api/tokens', {
        headers: { authorization: 'Bearer ' + clientToken },
      })).status,
      403,
    )
  })

  test('wildcard subdomain routes to the instance with the full path', async () => {
    const inst = await createFakeInstance({
      url: wsBase, token: instanceToken, id: instanceId, name: 'my-instance',
    })
    try {
      await waitFor(() => relay.registry.get(instanceId) !== null)
      const res = await request(base, '/api/hello?x=1', {
        headers: { host: instanceId + '.inst.example.com', authorization: 'Bearer device-token' },
      })
      assert.strictEqual(res.status, 200)
      assert.strictEqual(res.headers['x-relay-instance'], instanceId)
      const body = res.json()
      assert.strictEqual(body.method, 'GET')
      assert.strictEqual(body.url, '/api/hello?x=1')
      assert.strictEqual(body.headers.authorization, 'Bearer device-token')
    } finally {
      inst.close()
    }
  })

  test('/instance/<id> routes, sets the routing cookie, and forwards the path minus the prefix', async () => {
    const inst = await createFakeInstance({
      url: wsBase, token: instanceToken, id: instanceId, name: 'my-instance',
    })
    try {
      await waitFor(() => relay.registry.get(instanceId) !== null)
      const res = await request(base, '/instance/' + instanceId + '/api/hello?x=1', {
        method: 'POST',
        headers: {
          host: 'relay.example.com',
          authorization: 'Bearer device-token',
          cookie: 'dsh_relay_owner=abc123; dsh_instance=other; dsh_mobile_sid=keepme',
        },
        body: 'ping',
      })
      assert.strictEqual(res.status, 200)
      const cookie = /dsh_instance=([^;]+)/.exec(res.headers['set-cookie'] ?? '')
      assert.ok(cookie, 'routing cookie set')
      assert.strictEqual(cookie[1], instanceId)
      const body = res.json()
      assert.strictEqual(body.method, 'POST')
      assert.strictEqual(body.url, '/api/hello?x=1')
      assert.strictEqual(Buffer.from(body.bodyBase64, 'base64').toString(), 'ping')
      // relay-private cookies never enter the tunnel; device cookies pass through
      assert.strictEqual(body.headers.cookie, 'dsh_mobile_sid=keepme')
    } finally {
      inst.close()
    }
  })

  test('split-tick res/chunk/end frames survive the idle timer (regression)', async () => {
    const u = new URL(wsBase)
    u.pathname = '/relay/instance-tunnel'
    u.search = `?instanceToken=${encodeURIComponent(instanceToken)}&id=${encodeURIComponent(instanceId)}&name=my-instance`
    const ws = await connect(u.toString())
    try {
      await waitFor(() => relay.registry.get(instanceId) !== null)
      ws.on('message', (data, isBinary) => {
        if (isBinary) return
        const msg = JSON.parse(data.toString())
        if (msg && msg.v === 1 && msg.t === 'req') {
          ws.sendText(JSON.stringify({ v: 1, t: 'res', id: msg.id, status: 200, headers: { 'content-type': 'text/plain' } }))
          // chunk + end arrive in a LATER tick — a broken idle timer (0 ms
          // re-arm) destroys the response in between and the client gets
          // nothing
          setTimeout(() => {
            ws.sendText(JSON.stringify({ v: 1, t: 'chunk', id: msg.id, bodyBase64: Buffer.from('late body').toString('base64') }))
            ws.sendText(JSON.stringify({ v: 1, t: 'end', id: msg.id }))
          }, 40)
        }
      })
      const res = await request(base, '/instance/' + instanceId + '/slow', { method: 'GET', headers: { host: 'relay.example.com' } })
      assert.strictEqual(res.status, 200)
      assert.strictEqual(res.text(), 'late body')
    } finally {
      try {
        ws.close()
      } catch {
        /* ignore */
      }
    }
  })

  test('client WebSocket upgrades are forwarded through the tunnel (byte pipe)', async () => {
    const inst = await createFakeInstance({
      url: wsBase, token: instanceToken, id: instanceId, name: 'ws-inst',
    })
    try {
      await waitFor(() => relay.registry.get(instanceId) !== null)
      const received = await new Promise((resolve, reject) => {
        const u = new URL(base)
        const socket = net.connect(Number(u.port), '127.0.0.1')
        const chunks = []
        const timer = setTimeout(() => {
          socket.destroy()
          reject(new Error('ws forward timeout'))
        }, 5000)
        socket.on('connect', () => {
          socket.write([
            'GET /api/events.mux HTTP/1.1',
            'Host: relay.example.com',
            'Upgrade: websocket',
            'Connection: Upgrade',
            'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
            'Sec-WebSocket-Version: 13',
            'Cookie: dsh_instance=' + instanceId,
            '',
            '',
          ].join('\r\n'))
        })
        socket.on('data', (c) => {
          chunks.push(c)
          const total = Buffer.concat(chunks)
          if (total.includes('101 Switching Protocols') && !socket.forwardProbe) {
            socket.forwardProbe = true
            socket.write(Buffer.from('ping-bytes'))
          }
          if (total.includes('ping-bytes')) {
            clearTimeout(timer)
            socket.destroy()
            resolve(total)
          }
        })
        socket.on('error', (err) => {
          clearTimeout(timer)
          reject(err)
        })
      })
      // the real 101 handshake bytes come from the instance side
      assert.ok(received.includes('HTTP/1.1 101 Switching Protocols'))
      // and raw bytes round-trip both ways
      assert.ok(received.includes('ping-bytes'))
    } finally {
      inst.close()
    }
  })

  test('cookie routing on the public host forwards root paths to the selected instance', async () => {
    const inst = await createFakeInstance({
      url: wsBase, token: instanceToken, id: instanceId, name: 'my-instance',
    })
    try {
      await waitFor(() => relay.registry.get(instanceId) !== null)
      // with the cookie, an ABSOLUTE path like the official frontend's /api
      // calls lands on the instance with the full path
      const res = await request(base, '/api/session.list', {
        headers: { host: 'relay.example.com', cookie: 'dsh_instance=' + instanceId, authorization: 'Bearer t' },
      })
      assert.strictEqual(res.status, 200)
      assert.strictEqual(res.json().url, '/api/session.list')

      // the BARE root is the main menu (instance picker) — always, even with
      // a routing cookie; entering an instance is a deliberate menu choice
      const rootNoCookie = await request(base, '/', { headers: { host: 'relay.example.com' } })
      assert.strictEqual(rootNoCookie.status, 200)
      assert.ok(rootNoCookie.text().includes('Instances'))
      const rootWithCookie = await request(base, '/', {
        headers: { host: 'relay.example.com', cookie: 'dsh_instance=' + instanceId },
      })
      assert.strictEqual(rootWithCookie.status, 200)
      assert.ok(rootWithCookie.text().includes('Instances'))

      // other root-space paths WITHOUT a cookie still redirect to the picker
      const noCookie = await request(base, '/mobile/auth', { headers: { host: 'relay.example.com' } })
      assert.strictEqual(noCookie.status, 302)
      assert.strictEqual(noCookie.headers.location, '/relay/')
    } finally {
      inst.close()
    }
  })

  test('authorization header passes verbatim to the instance', async () => {
    const inst = await createFakeInstance({
      url: wsBase, token: instanceToken, id: instanceId, name: 'my-instance',
      handler: async ({ headers }) => ({ status: 200, body: JSON.stringify({ got: headers.authorization ?? null }) }),
    })
    try {
      await waitFor(() => relay.registry.get(instanceId) !== null)
      const res = await request(base, '/relay/instance/' + instanceId + '/api/hello', {
        headers: { authorization: 'Bearer device-token-123' },
      })
      assert.strictEqual(res.status, 200)
      assert.strictEqual(res.json().got, 'Bearer device-token-123')
    } finally {
      inst.close()
    }
  })

  test('unknown instance -> 404', async () => {
    const res = await request(base, '/relay/instance/does-not-exist/x', {
      headers: { authorization: 'Bearer ' + clientToken },
    })
    assert.strictEqual(res.status, 404)
    assert.strictEqual(res.json().error, 'unknown-instance')
  })

  test('offline instance -> 502', async () => {
    const id = 'offline-' + Date.now()
    const inst = await createFakeInstance({ url: wsBase, token: instanceToken, id, name: 'off' })
    await waitFor(() => relay.registry.get(id) !== null)
    inst.close()
    await waitFor(() => relay.registry.get(id) === null)
    const res = await request(base, '/relay/instance/' + id + '/x', {
      headers: { authorization: 'Bearer ' + clientToken },
    })
    assert.strictEqual(res.status, 502)
    assert.strictEqual(res.json().error, 'instance-offline')
  })

  test('instance token revocation drops the tunnel and in-flight requests', async () => {
    const createRes = await request(base, '/relay/api/tokens', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: ownerCookie },
      body: JSON.stringify({ label: 'revokeme-instance', kind: 'instance' }),
    })
    const { token: victimInstanceToken, hashPrefix: victimPrefix } = createRes.json()

    let release
    const gate = new Promise((r) => { release = r })
    let invokedResolve
    const invoked = new Promise((r) => { invokedResolve = r })
    const revokeId = 'revoke-' + Date.now()
    const inst = await createFakeInstance({
      url: wsBase,
      token: victimInstanceToken,
      id: revokeId,
      name: 'revoke-me',
      handler: async () => {
        invokedResolve()
        await gate
        return { status: 200, body: 'late' }
      },
    })
    await waitFor(() => relay.registry.get(revokeId) !== null)

    const pendingReq = request(base, '/relay/instance/' + revokeId + '/slow')
    await invoked // the request reached the instance

    const del = await request(base, '/relay/api/tokens/' + victimPrefix, {
      method: 'DELETE',
      headers: { cookie: ownerCookie },
    })
    assert.strictEqual(del.status, 200)

    const res = await pendingReq
    assert.strictEqual(res.status, 502)
    assert.strictEqual(res.json().error, 'instance-offline')

    release()
    inst.close()
  })

  test('owner setup consumes bootstrap (one-time)', async () => {
    const r = createRelayServer({ port: 0, dataDir: await tmpDataDir() })
    await r.start()
    const b2 = 'http://127.0.0.1:' + r.port
    try {
      const bootstrap = await r.ensureBootstrap()
      assert.ok(bootstrap)
      const res1 = await request(b2, '/relay/api/setup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ bootstrapToken: bootstrap }),
      })
      assert.strictEqual(res1.status, 200)
      assert.ok(res1.headers['set-cookie'])

      const res2 = await request(b2, '/relay/api/setup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ bootstrapToken: bootstrap }),
      })
      assert.strictEqual(res2.status, 401)

      const res3 = await request(b2, '/relay/api/setup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ bootstrapToken: '0'.repeat(64) }),
      })
      assert.strictEqual(res3.status, 401)
    } finally {
      await r.close()
    }
  })

  test('passkey register-options requires owner session', async () => {
    const res = await request(base, '/relay/api/passkey/register-options', {
      method: 'POST',
    })
    assert.strictEqual(res.status, 401)
  })

  test('rate limit returns 429', async () => {
    const r = createRelayServer({ port: 0, dataDir: await tmpDataDir(), rateLimitPerMin: 3 })
    await r.start()
    const b2 = 'http://127.0.0.1:' + r.port
    try {
      const statuses = []
      for (let i = 0; i < 6; i++) {
        statuses.push((await request(b2, '/relay/health')).status)
      }
      assert.strictEqual(statuses.slice(0, 3).every((s) => s === 200), true)
      assert.ok(statuses.includes(429))
    } finally {
      await r.close()
    }
  })
})
