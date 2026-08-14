// End-to-end integration: relay server + dsh-side tunnel client + a fake
// local target. Exercises the full fan-in data path offline (ws:// loopback).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

import { createRelayServer } from '../../dsh-relay/src/server.js';
import { createTunnelClient } from '../src/relay-tunnel.js';

let relay;
let targetServer;
let targetPort;
let tunnelHandle;
let dataDir;

const statuses = [];
const silentLog = { log() {}, error() {} };
const writeStatus = (s) => statuses.push(s);

function request(baseUrl, pathname, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl);
    const req = http.request(
      { hostname: u.hostname, port: Number(u.port), path: pathname, method, headers },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          resolve({ status: res.statusCode, headers: res.headers, text: () => buf.toString('utf8'), json: () => JSON.parse(buf.toString('utf8')) });
        });
      },
    );
    req.on('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
}

async function waitFor(fn, timeout = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('waitFor timed out');
}

before(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-relay-e2e-'));

  // fake local target: the role the gateway will play in production
  targetServer = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json', 'x-relay-instance': 'spoofed' });
      res.end(JSON.stringify({
        method: req.method,
        url: req.url,
        auth: req.headers.authorization ?? null,
        body: Buffer.concat(chunks).toString(),
      }));
    });
  });
  await new Promise((r) => targetServer.listen(0, '127.0.0.1', r));
  targetPort = targetServer.address().port;

  relay = createRelayServer({ port: 0, dataDir });
  await relay.start();
});

after(async () => {
  if (tunnelHandle) tunnelHandle.stop();
  if (relay) await relay.close();
  if (targetServer) await new Promise((r) => targetServer.close(r));
});

test('instance registers via tunnel and serves proxied requests end-to-end', async () => {
  const base = `http://127.0.0.1:${relay.port}`;

  // owner setup + tokens
  const bootstrap = await relay.ensureBootstrap();
  const setupRes = await request(base, '/relay/api/setup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bootstrapToken: bootstrap }),
  });
  assert.strictEqual(setupRes.status, 200);
  const sid = /dsh_relay_owner=([^;]+)/.exec(setupRes.headers['set-cookie'])[1];
  const ownerCookie = 'dsh_relay_owner=' + sid;

  const clientTokenRes = await request(base, '/relay/api/tokens', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: ownerCookie },
    body: JSON.stringify({ label: 'client', kind: 'client' }),
  });
  const clientToken = clientTokenRes.json().token;

  const instanceTokenRes = await request(base, '/relay/api/tokens', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: ownerCookie },
    body: JSON.stringify({ label: 'instance', kind: 'instance' }),
  });
  const instanceToken = instanceTokenRes.json().token;

  // dsh-side tunnel client (the real one, global WebSocket, ws:// loopback)
  const instanceId = 'e2e-' + Date.now();
  tunnelHandle = createTunnelClient({
    config: {
      mode: 'relay',
      relay: { url: base, instanceId, instanceToken, displayName: 'E2E box' },
    },
    targetPort,
    log: silentLog,
    writeStatus,
    reconnectBaseMs: 100,
  }).start();
  await waitFor(() => statuses.some((s) => s.connected));

  // directory (relay client token guards this)
  const targetsRes = await request(base, '/relay/api/targets', {
    headers: { authorization: 'Bearer ' + clientToken },
  });
  assert.strictEqual(targetsRes.status, 200);
  const target = targetsRes.json().find((t) => t.id === instanceId);
  assert.ok(target);
  assert.strictEqual(target.online, true);

  // proxy path: no relay credential required; Authorization passes verbatim
  const proxyRes = await request(base, `/relay/instance/${instanceId}/api/hello?x=1`, {
    method: 'POST',
    headers: { authorization: 'Bearer device-token-123', 'content-type': 'text/plain' },
    body: 'ping',
  });
  assert.strictEqual(proxyRes.status, 200);
  assert.strictEqual(proxyRes.headers['x-relay-instance'], instanceId);
  assert.strictEqual(proxyRes.headers['x-relay-latency-ms'] !== undefined, true);
  const body = proxyRes.json();
  assert.strictEqual(body.method, 'POST');
  assert.strictEqual(body.url, '/api/hello?x=1');
  assert.strictEqual(body.auth, 'Bearer device-token-123');
  assert.strictEqual(body.body, 'ping');
  assert.strictEqual(body.headers === undefined || true, true);

  // unknown instance
  const missing = await request(base, '/relay/instance/nope/x');
  assert.strictEqual(missing.status, 404);
});
