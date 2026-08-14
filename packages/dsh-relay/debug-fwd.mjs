import http from 'node:http'
import { createRelayServer, createFakeInstance } from './src/server.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.on('uncaughtException', (e) => {
  console.log('UNCAUGHT:', e.message)
  console.log(e.stack)
})

function request(baseUrl, pathname, opts) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl)
    const req = http.request({ hostname: u.hostname, port: Number(u.port), path: pathname, method: 'GET', headers: opts.headers }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }))
    })
    req.on('error', (e) => { console.log('REQ ERROR', e.message); reject(e) })
    req.end()
  })
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-relay-'))
const relay = createRelayServer({ port: 0, dataDir: dir })
await relay.start()
const base = 'http://127.0.0.1:' + relay.port
const wsBase = 'ws://127.0.0.1:' + relay.port

const bootstrap = await relay.ensureBootstrap()
const setup = await request(base, '/relay/api/setup', { method: 'POST', headers: { 'content-type': 'application/json' } })
// do setup properly
const httpSetup = await new Promise((resolve, reject) => {
  const u = new URL(base)
  const req = http.request({ hostname: u.hostname, port: Number(u.port), path: '/relay/api/setup', method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
    const c = []; res.on('data', (x) => c.push(x)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }))
  })
  req.on('error', reject)
  req.end(JSON.stringify({ bootstrapToken: bootstrap }))
})
console.log('setup status', httpSetup.status, 'set-cookie', httpSetup.headers['set-cookie'])
const sid = /dsh_relay_owner=([^;]+)/.exec(httpSetup.headers['set-cookie'])[1]
const ownerCookie = 'dsh_relay_owner=' + sid

function req2(pathname, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(base)
    const r = http.request({ hostname: u.hostname, port: Number(u.port), path: pathname, method, headers }, (res) => {
      const c = []; res.on('data', (x) => c.push(x)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(c).toString() }))
    })
    r.on('error', reject)
    if (body) r.write(body)
    r.end()
  })
}

const clientTok = await req2('/relay/api/tokens', { method: 'POST', headers: { 'content-type': 'application/json', cookie: ownerCookie }, body: JSON.stringify({ label: 'c', kind: 'client' }) })
const instanceTok = await req2('/relay/api/tokens', { method: 'POST', headers: { 'content-type': 'application/json', cookie: ownerCookie }, body: JSON.stringify({ label: 'i', kind: 'instance' }) })
console.log('client token status', clientTok.status, 'instance token status', instanceTok.status)
const clientToken = JSON.parse(clientTok.body).token
const instanceToken = JSON.parse(instanceTok.body).token
const instanceId = 'test-debug'

const inst = await createFakeInstance({ url: wsBase, token: instanceToken, id: instanceId, name: 'n' })
console.log('instance connected, registered=', relay.registry.get(instanceId) !== null)

const res = await req2('/relay/instance/' + instanceId + '/api/hello?x=1', { headers: { authorization: 'Bearer ' + clientToken } })
console.log('PASSTHROUGH status', res.status)
console.log('headers', JSON.stringify(res.headers))
console.log('body', res.body)

await inst.close()
await relay.close()
process.exit(0)
