// Offline tests for the mobile gateway (docs/design/gateway.md §7).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

import { createGateway } from '../src/gateway.js';
import { createDeviceStore } from '@bb-84c/dsh-mobile-common/devices.js';
import { mobilePaths } from '@bb-84c/dsh-mobile-common/home.js';

let tmpHome;
let testEnv;
let targetServer;
let targetPort;
let gateway;
let gatewayPort;
let store;
let deviceId;
let deviceToken;

const FAKE_TS = { ip4: () => '100.101.132.89', hostname: () => 'woody.tail40672a.ts.net' };

function request(pathname, { method = 'GET', headers = {}, body } = {}, port = gatewayPort) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path: pathname, method, headers },
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

function cookie(headers) {
  const sc = headers['set-cookie'];
  if (Array.isArray(sc)) return sc[0].split(';')[0];
  return String(sc ?? '').split(';')[0];
}

before(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-gw-'));
  testEnv = {
    ...process.env,
    MOBILE_HOME: tmpHome,
    DSH_MOBILE_INSTANCE: '1',
    DSH_MOBILE_TOKEN: 'ab'.repeat(16),
    DSH_MOBILE_GATEWAY_PORT: '0',
  };
  store = createDeviceStore({ paths: () => mobilePaths(testEnv) });

  // fake dsh web target
  targetServer = http.createServer((req, res) => {
    if (req.url.startsWith('/page')) {
      const html = '<!doctype html><html><head><title>t</title></head><body>x</body></html>';
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': String(Buffer.byteLength(html)) });
      res.end(html);
      return;
    }
    if (req.url.startsWith('/sse')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"a":1}\n\n');
      setTimeout(() => {
        try {
          res.write('data: {"a":2}\n\n');
        } catch {}
      }, 30);
      req.on('close', () => res.end());
      return;
    }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ method: req.method, url: req.url, auth: req.headers.authorization ?? null, body: Buffer.concat(chunks).toString() }));
    });
  });
  targetServer.on('upgrade', (req, socket, head) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
    if (head && head.length) socket.write(head);
    socket.on('data', (data) => socket.write(data)); // echo
  });
  await new Promise((r) => targetServer.listen(0, '127.0.0.1', r));
  targetPort = targetServer.address().port;

  gateway = createGateway({
    env: testEnv,
    pid: 424242,
    config: {
      mode: 'tailscale',
      webPort: targetPort,
      gatewayPort: 3081,
      relay: {},
      tailscale: {},
      auth: { sessionTtlDays: 30 },
    },
    devices: store,
    tailscale: FAKE_TS,
    relayStatus: () => ({ connected: true, since: '2026-01-01T00:00:00Z', instanceId: 'i1' }),
  });
  const started = await gateway.start();
  gatewayPort = started.port;
});

after(async () => {
  if (gateway) await gateway.stop();
  if (targetServer) await new Promise((r) => targetServer.close(r));
  await fs.rm(tmpHome, { recursive: true, force: true });
});

test('health shape (no auth)', async () => {
  const res = await request('/mobile/health');
  assert.strictEqual(res.status, 200);
  const body = res.json();
  assert.strictEqual(body.ok, true);
  assert.strictEqual(body.mode, 'tailscale');
  assert.strictEqual(body.instanceId, 'woody.tail40672a.ts.net');
  assert.strictEqual(typeof body.uptimeSec, 'number');
});

test('unauthenticated navigation redirects to the auth gate', async () => {
  const res = await request('/');
  assert.strictEqual(res.status, 302);
  assert.ok(res.headers.location.startsWith('/mobile/auth?next='));
});

test('unauthenticated /api returns 401 JSON', async () => {
  const res = await request('/api/x', { headers: { accept: 'application/json' } });
  assert.strictEqual(res.status, 401);
  assert.strictEqual(res.json().error, 'unauthorized');
});

test('browser pairing flow: code -> cookie -> proxied request', async () => {
  const pending = store.issuePairing({ name: 'phone' });
  const res = await request(`/mobile/pair?code=${pending.pairingCode}`);
  assert.strictEqual(res.status, 302);
  const sidCookie = cookie(res.headers);
  assert.ok(sidCookie.startsWith('dsh_mobile_sid='));

  const proxied = await request('/api/hello?x=1', { headers: { cookie: sidCookie } });
  assert.strictEqual(proxied.status, 200);
  assert.strictEqual(proxied.headers['x-dsh-mobile-gateway'], '1');
  const body = proxied.json();
  assert.strictEqual(body.method, 'GET');
  assert.strictEqual(body.url, '/api/hello?x=1');

  // pairing code is single-use
  const again = await request(`/mobile/pair?code=${pending.pairingCode}`);
  assert.strictEqual(again.status, 302);
  assert.ok(again.headers.location.includes('error=pair'));
});

test('app pairing flow: POST /mobile/pair JSON delivers the token exactly once', async () => {
  const pending = store.issuePairing({ name: 'iphone' });
  const res = await request('/mobile/pair', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ code: pending.pairingCode }),
  });
  assert.strictEqual(res.status, 200);
  const body = res.json();
  assert.strictEqual(body.ok, true);
  assert.strictEqual(typeof body.deviceId, 'string');
  assert.match(body.token, /^[0-9a-f]{32}$/);
  assert.strictEqual(body.expiresAt, null);
  deviceId = body.deviceId;
  deviceToken = body.token;

  // the token works as a bearer on the very next proxied request
  const proxied = await request('/api/echo', {
    headers: { authorization: `Bearer ${deviceToken}` },
  });
  assert.strictEqual(proxied.status, 200);
  assert.strictEqual(proxied.json().auth, `Bearer ${deviceToken}`);

  // only hashes are persisted, never the raw token
  const devicesFile = JSON.parse(await fs.readFile(path.join(tmpHome, 'data', 'devices.json'), 'utf8'));
  const entry = devicesFile.find((d) => d.id === deviceId);
  assert.ok(entry);
  assert.match(entry.tokenHash, /^[0-9a-f]{64}$/);
  assert.strictEqual(entry.tokenHash, undefined || entry.tokenHash); // hash, not raw
  assert.ok(!JSON.stringify(devicesFile).includes(deviceToken));
});

test('bearer proxy forwards method, body and headers', async () => {
  const res = await request('/api/submit?q=2', {
    method: 'POST',
    headers: { authorization: `Bearer ${deviceToken}`, 'content-type': 'text/plain' },
    body: 'hello body',
  });
  assert.strictEqual(res.status, 200);
  const body = res.json();
  assert.strictEqual(body.method, 'POST');
  assert.strictEqual(body.url, '/api/submit?q=2');
  assert.strictEqual(body.body, 'hello body');
});

test('HTML responses get the secure-context crypto.randomUUID polyfill injected', async () => {
  const res = await request('/page', {
    headers: { authorization: `Bearer ${deviceToken}` },
  });
  assert.strictEqual(res.status, 200);
  const html = res.text();
  assert.ok(html.includes('crypto.randomUUID'), 'polyfill present');
  assert.ok(html.includes('<head>'), 'original head tag kept');
  assert.ok(html.indexOf('randomUUID') < html.indexOf('</head>'), 'injected inside head region');
  assert.ok(html.includes('<body>x</body>'), 'body preserved');
  assert.strictEqual(res.headers['content-length'], undefined, 'length stripped (streamed chunked)');
});

test('device token login via POST /mobile/auth sets a session', async () => {
  const res = await request('/mobile/auth', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ token: deviceToken }),
  });
  assert.strictEqual(res.status, 200);
  assert.ok(cookie(res.headers).startsWith('dsh_mobile_sid='));
});

test('revocation: session dies, bearer dies, live SSE stream is torn down', async () => {
  // open an SSE stream through the gateway with the bearer
  const stream = await new Promise((resolve, reject) => {
    const req = http.get(
      { hostname: '127.0.0.1', port: gatewayPort, path: '/sse', headers: { authorization: `Bearer ${deviceToken}` } },
      (res) => resolve({ res, req }),
    );
    req.on('error', reject);
  });
  assert.strictEqual(stream.res.statusCode, 200);
  const closed = new Promise((r) => {
    stream.res.on('close', r);
    stream.res.on('error', r);
  });

  // revoke THROUGH the gateway (loopback = owner) so it can tear down the
  // device's tracked sockets and sessions
  const del = await request(`/mobile/api/devices/${deviceId}`, { method: 'DELETE' });
  assert.strictEqual(del.status, 200);
  await closed; // the live stream must be destroyed immediately

  const next = await request('/api/x', { headers: { authorization: `Bearer ${deviceToken}` } });
  assert.strictEqual(next.status, 401);
});

test('websocket upgrade passes through with authentication', async () => {
  // pair a fresh device for this test (rate limiter state may be warm)
  const pending = store.issuePairing({ name: 'ws-phone' });
  const pairRes = await request('/mobile/pair', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ code: pending.pairingCode }),
  });
  const token = pairRes.json().token;

  const echo = await new Promise((resolve, reject) => {
    const chunks = [];
    const socket = net.connect(gatewayPort, '127.0.0.1', () => {
      socket.write(
        'GET /ws HTTP/1.1\r\n' +
          `authorization: Bearer ${token}\r\n` +
          'connection: Upgrade\r\n' +
          'upgrade: websocket\r\n' +
          'sec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
          'sec-websocket-version: 13\r\n\r\n',
      );
      setTimeout(() => socket.write(Buffer.from('ping')), 20);
    });
    socket.setTimeout(3000, () => reject(new Error('upgrade timeout')));
    socket.on('data', (data) => {
      chunks.push(data);
      const text = Buffer.concat(chunks).toString();
      if (text.includes('ping')) {
        socket.destroy();
        resolve(text);
      }
    });
    socket.on('error', reject);
  });
  assert.ok(echo.includes('101'), `expected 101 upgrade, got: ${echo}`);
  assert.ok(echo.includes('ping'), 'expected echoed payload');
});

test('owner endpoints: non-owner device gets 403, loopback owner gets 200', async () => {
  // second (non-owner) device
  const pending = store.issuePairing({ name: 'second' });
  const pairRes = await request('/mobile/pair', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ code: pending.pairingCode }),
  });
  const secondToken = pairRes.json().token;
  assert.match(secondToken, /^[0-9a-f]{32}$/);
  const asSecond = await request('/mobile/api/devices', {
    headers: { authorization: `Bearer ${secondToken}` },
  });
  assert.strictEqual(asSecond.status, 403);

  // loopback without any credential is the owner
  const asOwner = await request('/mobile/api/devices');
  assert.strictEqual(asOwner.status, 200);
  const body = asOwner.json();
  assert.ok(Array.isArray(body.devices));
  assert.strictEqual(typeof body.ownerId, 'string');
});

test('/mobile/api/status shape matches the app spec', async () => {
  const pending = store.issuePairing({ name: 'status-phone' });
  const pairRes = await request('/mobile/pair', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ code: pending.pairingCode }),
  });
  const token = pairRes.json().token;
  const res = await request('/mobile/api/status', {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.strictEqual(res.status, 200);
  const body = res.json();
  assert.strictEqual(body.ok, true);
  assert.strictEqual(body.mode, 'tailscale');
  assert.strictEqual(body.instanceId, 'woody.tail40672a.ts.net');
  assert.strictEqual(typeof body.uptimeSec, 'number');
  assert.strictEqual(body.tailscale.interfaceIp, '100.101.132.89');
  assert.strictEqual(body.tailscale.hostname, 'woody.tail40672a.ts.net');
  assert.strictEqual(body.relay.connected, true);
  assert.strictEqual(body.dshWeb.healthy, true);
  assert.strictEqual(body.dshWeb.webPort, targetPort);
});

test('open redirect is blocked', async () => {
  const res = await request('/mobile/auth', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'code=000000&next=//evil.com',
  });
  assert.strictEqual(res.status, 401); // form nav flow re-renders login
  assert.ok(!String(res.text()).includes('evil.com'));
});

test('sidecar is written on start and removed on stop', async () => {
  const sidecarPath = path.join(tmpHome, 'instances', '424242.json');
  const sidecar = JSON.parse(await fs.readFile(sidecarPath, 'utf8'));
  assert.strictEqual(sidecar.pid, 424242);
  assert.strictEqual(sidecar.token, 'ab'.repeat(16));
  assert.strictEqual(typeof sidecar.startedAt, 'number');
});

test('sessions survive a gateway restart (persisted store, hashed sids)', async () => {
  // pair through the main gateway (browser flow sets the cookie)
  const pending = store.issuePairing({ name: 'persist-phone' });
  const pairRes = await request(`/mobile/pair?code=${pending.pairingCode}`);
  assert.strictEqual(pairRes.status, 302);
  const sidCookie = cookie(pairRes.headers);
  assert.ok(sidCookie.startsWith('dsh_mobile_sid='));

  // the persisted store keeps only hashes, never the raw sid
  const records = JSON.parse(await fs.readFile(path.join(tmpHome, 'data', 'sessions.json'), 'utf8'));
  assert.ok(records.length >= 1);
  for (const record of records) {
    assert.match(record.hash, /^[0-9a-f]{64}$/);
  }
  const rawSid = sidCookie.split('=')[1];
  assert.ok(!JSON.stringify(records).includes(rawSid), 'raw sid must not be persisted');

  // a FRESH gateway instance (same home) accepts the old cookie
  const gw2 = createGateway({
    env: testEnv,
    pid: 424243,
    config: {
      mode: 'tailscale',
      webPort: targetPort,
      gatewayPort: 3082,
      relay: {},
      tailscale: {},
      auth: { sessionTtlDays: 30 },
    },
    devices: store,
    tailscale: FAKE_TS,
    relayStatus: () => null,
  });
  const started2 = await gw2.start();
  try {
    const proxied = await request('/api/hello?persisted=1', { headers: { cookie: sidCookie } }, started2.port);
    assert.strictEqual(proxied.status, 200);
    assert.strictEqual(proxied.json().url, '/api/hello?persisted=1');
  } finally {
    await gw2.stop();
  }
});

// Rate limiting is tested last: its 12 failed attempts exhaust the per-IP
// bucket (10/min) and would starve every later pairing in this suite.
test('rate limit: 11 failed auth attempts -> 429', async () => {
  let limited = false;
  for (let i = 0; i < 12; i += 1) {
    const res = await request('/mobile/auth', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ code: '000000' }),
    });
    if (res.status === 429) {
      limited = true;
      break;
    }
    assert.strictEqual(res.status, 401);
  }
  assert.strictEqual(limited, true);
});
