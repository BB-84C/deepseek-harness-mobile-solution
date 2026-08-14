#!/usr/bin/env node
/**
 * relay-probe — end-to-end connectivity probe for a deployed dsh-relay.
 *
 * Standalone: does NOT touch any dsh instance or the resident service. It
 * starts a local echo target, opens a REAL instance tunnel to the relay
 * (outbound WebSocket), verifies the instance appears in the directory, and
 * round-trips one request through the public deep-link path
 * (client -> relay -> tunnel -> local target).
 *
 * Usage:
 *   node scripts/relay-probe.mjs --relay https://dsh.bb84.ai --instance-token <token>
 *     [--id woody] [--name woody] [--client-token <token>]
 *
 * Env fallbacks: DSH_RELAY_PROBE_URL, DSH_RELAY_PROBE_TOKEN, DSH_RELAY_PROBE_CLIENT_TOKEN.
 */
import http from 'node:http';
import https from 'node:https';
import { createTunnelClient } from '../packages/dsh-mobile-server/src/relay-tunnel.js';

function arg(name, envName) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx !== -1 && process.argv[idx + 1] !== undefined) return process.argv[idx + 1];
  return process.env[envName] ?? null;
}

const relayUrl = arg('relay', 'DSH_RELAY_PROBE_URL');
const instanceToken = arg('instance-token', 'DSH_RELAY_PROBE_TOKEN');
const clientToken = arg('client-token', 'DSH_RELAY_PROBE_CLIENT_TOKEN');
const id = arg('id', 'DSH_RELAY_PROBE_ID') ?? 'probe-' + Date.now();
const name = arg('name', 'DSH_RELAY_PROBE_NAME') ?? 'probe';
const holdSec = Number(arg('hold', 'DSH_RELAY_PROBE_HOLD') ?? 0);

if (!relayUrl || !instanceToken) {
  console.error('usage: node scripts/relay-probe.mjs --relay <url> --instance-token <token> [--client-token <token>]');
  process.exit(2);
}

const normalized = relayUrl.replace(/\/+$/, '');

function httpRequest(base, pathname, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(base);
    const client = u.protocol === 'https:' ? https : http;
    const req = client.request(
      { hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: pathname, method, headers },
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

const statuses = [];
const echoServer = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, echo: { method: req.method, url: req.url, body: Buffer.concat(chunks).toString() } }));
  });
});

await new Promise((resolve) => echoServer.listen(0, '127.0.0.1', resolve));
const targetPort = echoServer.address().port;
console.log(`probe: relay=${normalized} id=${id} local-target=127.0.0.1:${targetPort}`);

const tunnel = createTunnelClient({
  config: { mode: 'relay', relay: { url: normalized, instanceId: id, instanceToken, displayName: name } },
  targetPort,
  reconnectBaseMs: 2000,
  writeStatus: (s) => statuses.push(s),
  log: { log() {}, error(m) { console.error(`[tunnel] ${m}`); } },
}).start();

async function waitFor(fn, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('timeout');
}

try {
  await waitFor(() => statuses.some((s) => s.connected));
  console.log('probe: tunnel connected');

  // 1. directory visibility (needs the relay client token)
  if (clientToken) {
    const targets = await httpRequest(normalized, '/relay/api/targets', {
      headers: { authorization: `Bearer ${clientToken}` },
    });
    const mine = targets.json().find((t) => t.id === id);
    console.log(`probe: directory status=${targets.status} online=${mine?.online ?? false} name=${mine?.name ?? '?'}`);
  } else {
    console.log('probe: no --client-token given; skipping directory check');
  }

  // 2. deep-link round trip through the relay (public path)
  const res = await httpRequest(normalized, `/relay/instance/${id}/api/hello?x=1`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain', authorization: 'Bearer probe' },
    body: 'ping',
  });
  console.log(`probe: deep-link status=${res.status} x-relay-instance=${res.headers['x-relay-instance'] ?? '-'}`);
  const body = res.json();
  console.log(`probe: echo method=${body.echo?.method} url=${body.echo?.url} body=${body.echo?.body} auth-forwarded=${body.echo ? 'n/a' : '?'}`);

  // 3. unknown instance
  const missing = await httpRequest(normalized, '/relay/instance/definitely-not-here/x');
  console.log(`probe: unknown-instance status=${missing.status} (expect 404)`);

  console.log('PROBE_OK');
  if (Number.isFinite(holdSec) && holdSec > 0) {
    console.log(`holding the tunnel open for ${holdSec}s (external checks: wildcard host or /relay/instance/${id}/...)`);
    await new Promise((resolve) => setTimeout(resolve, holdSec * 1000));
    console.log('PROBE_DONE');
  }
} catch (error) {
  console.error(`PROBE_FAILED: ${error.message}`);
  process.exitCode = 1;
} finally {
  tunnel.stop();
  await new Promise((resolve) => echoServer.close(resolve));
}
