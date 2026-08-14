// Offline tests for the relay tunnel client (no network, injected deps).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTunnelClient, startTunnel } from '../src/relay-tunnel.js';

beforeEach(() => {
  MockWebSocket.instances = [];
});

class MockWebSocket {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = 0; // CONNECTING
    this.sent = [];
    this.listeners = new Map();
    this.closed = false;
    MockWebSocket.instances.push(this);
  }

  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }

  emit(type, payload = {}) {
    for (const fn of this.listeners.get(type) ?? []) fn(payload);
  }

  send(data) {
    this.sent.push(JSON.parse(data));
  }

  close() {
    this.closed = true;
    this.readyState = 3; // CLOSED
    this.emit('close', {});
  }

  _open() {
    this.readyState = 1; // OPEN
    this.emit('open', {});
  }
}

function makeDeps(overrides = {}) {
  const config = {
    mode: 'relay',
    relay: { url: 'https://relay.example.com', instanceId: 'HOME-PC', instanceToken: 'aa'.repeat(32), displayName: 'Home PC' },
  };
  const statuses = [];
  const writeStatus = (s) => statuses.push(s);
  const silentLog = { log() {}, error() {} };
  return { config, targetPort: 3081, statuses, writeStatus, reconnectBaseMs: 5, log: silentLog, ...overrides };
}

function frames(ws) {
  return ws.sent;
}

test('tunnel URL: wss scheme, sanitized id/name, token in query', () => {
  const { config, ...rest } = makeDeps();
  const client = createTunnelClient({ config, targetPort: 3081, wsCtor: MockWebSocket, ...rest });
  client.start().stop();
  const url = new URL(MockWebSocket.instances[0].url);
  assert.strictEqual(url.protocol, 'wss:');
  assert.strictEqual(url.host, 'relay.example.com');
  assert.strictEqual(url.pathname, '/relay/instance-tunnel');
  assert.strictEqual(url.searchParams.get('id'), 'home-pc');
  assert.strictEqual(url.searchParams.get('name'), 'home-pc');
  assert.strictEqual(url.searchParams.get('instanceToken'), 'aa'.repeat(32));
});

test('req frame is served against the local gateway and answered with res/chunk/end', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const deps = makeDeps({ fetchImpl });
  const client = createTunnelClient({ ...deps, wsCtor: MockWebSocket });
  const handle = client.start();
  const ws = MockWebSocket.instances[0];
  ws._open();

  ws.emit('message', { data: JSON.stringify({ v: 1, t: 'req', id: 7, method: 'POST', url: '/api/x?q=1', headers: { 'content-type': 'text/plain', authorization: 'Bearer dev-token' }, bodyBase64: Buffer.from('hello').toString('base64') }) });
  // give the async handler a tick
  await new Promise((r) => setTimeout(r, 20));

  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].url, 'http://127.0.0.1:3081/api/x?q=1');
  assert.strictEqual(calls[0].init.method, 'POST');
  assert.strictEqual(calls[0].init.headers.authorization, 'Bearer dev-token');
  assert.strictEqual(Buffer.from(calls[0].init.body).toString(), 'hello');

  const sent = frames(ws);
  assert.deepStrictEqual(sent.map((f) => f.t), ['res', 'chunk', 'end']);
  assert.strictEqual(sent[0].status, 200);
  assert.strictEqual(sent[0].headers['content-type'], 'application/json');
  assert.strictEqual(Buffer.from(sent[1].bodyBase64, 'base64').toString(), JSON.stringify({ ok: true }));
  assert.strictEqual(sent[2].id, 7);

  handle.stop();
});

test('hop-by-hop response headers are stripped from res frames', async () => {
  const fetchImpl = async () =>
    new Response('x', { status: 200, headers: { 'content-type': 'text/plain', 'transfer-encoding': 'chunked', 'content-length': '1', 'connection': 'close' } });
  const deps = makeDeps({ fetchImpl });
  const client = createTunnelClient({ ...deps, wsCtor: MockWebSocket });
  const handle = client.start();
  const ws = MockWebSocket.instances[0];
  ws._open();
  ws.emit('message', { data: JSON.stringify({ v: 1, t: 'req', id: 1, method: 'GET', url: '/', headers: {} }) });
  await new Promise((r) => setTimeout(r, 20));
  const res = frames(ws).find((f) => f.t === 'res');
  assert.strictEqual(res.headers['content-type'], 'text/plain');
  assert.strictEqual(res.headers['transfer-encoding'], undefined);
  assert.strictEqual(res.headers['content-length'], undefined);
  assert.strictEqual(res.headers['connection'], undefined);
  handle.stop();
});

test('stream limit: 33rd concurrent request answers 503 stream-limit', async () => {
  const pending = [];
  const fetchImpl = () => new Promise(() => {}); // never settles
  const deps = makeDeps({ fetchImpl });
  const client = createTunnelClient({ ...deps, wsCtor: MockWebSocket });
  const handle = client.start();
  const ws = MockWebSocket.instances[0];
  ws._open();
  for (let i = 0; i < 33; i += 1) {
    ws.emit('message', { data: JSON.stringify({ v: 1, t: 'req', id: i, method: 'GET', url: '/', headers: {} }) });
  }
  await new Promise((r) => setTimeout(r, 20));
  const last = frames(ws).filter((f) => f.id === 32 && f.t === 'res');
  assert.strictEqual(last.length, 1);
  assert.strictEqual(last[0].status, 503);
  handle.stop();
});

test('reconnects with backoff after close and writes status sidecar', async () => {
  const deps = makeDeps();
  const client = createTunnelClient({ ...deps, wsCtor: MockWebSocket });
  const handle = client.start();
  const ws1 = MockWebSocket.instances[0];
  ws1._open();
  assert.strictEqual(deps.statuses.at(-1).connected, true);

  ws1.close();
  assert.strictEqual(deps.statuses.at(-1).connected, false);
  await new Promise((r) => setTimeout(r, 60));
  assert.strictEqual(MockWebSocket.instances.length, 2);
  assert.strictEqual(handle.connected, false);
  handle.stop();
});

test('stop() closes the socket, aborts in-flight requests, and stops reconnecting', async () => {
  let aborted = false;
  const fetchImpl = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        aborted = true;
        reject(new DOMException('aborted', 'AbortError'));
      });
    });
  const deps = makeDeps({ fetchImpl });
  const client = createTunnelClient({ ...deps, wsCtor: MockWebSocket });
  const handle = client.start();
  const ws = MockWebSocket.instances[0];
  ws._open();
  ws.emit('message', { data: JSON.stringify({ v: 1, t: 'req', id: 9, method: 'GET', url: '/', headers: {} }) });
  await new Promise((r) => setTimeout(r, 10));
  handle.stop();
  await new Promise((r) => setTimeout(r, 10));
  assert.strictEqual(aborted, true);
  const count = MockWebSocket.instances.length;
  await new Promise((r) => setTimeout(r, 40));
  assert.strictEqual(MockWebSocket.instances.length, count); // no reconnect after stop
});

test('startTunnel is a no-op outside relay mode', async () => {
  const handle = await startTunnel({ config: { mode: 'tailscale', relay: {} }, targetPort: 3081 });
  assert.strictEqual(handle, null);
});
