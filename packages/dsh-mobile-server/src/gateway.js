/**
 * @bb-84c/dsh-mobile-server — mobile gateway (M2).
 *
 * The only network-facing surface of the resident dsh web instance. It binds a
 * self-owned node:http server, authenticates devices (session cookie / bearer
 * token), serves the /mobile/* self endpoints (health, login, pairing, device
 * management, status) and reverse-proxies everything else to the official dsh
 * web on 127.0.0.1:<webPort>, streaming SSE and forwarding WebSocket upgrades
 * unchanged.
 *
 * Design contract: docs/design/gateway.md.
 */
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { Transform } from 'node:stream';
import { randomBytes, timingSafeEqual } from 'node:crypto';

import { loadConfig } from '@bb-84c/dsh-mobile-common/config.js';
import * as devices from '@bb-84c/dsh-mobile-common/devices.js';
import { mobilePaths, ensureMobileDirs } from '@bb-84c/dsh-mobile-common/home.js';
import { atomicWriteJson } from '@bb-84c/dsh-mobile-common/fsutil.js';
import { readRelayStatus } from '@bb-84c/dsh-mobile-common/relay-status.js';
import { tailscaleIp4, tailscaleHostname } from '@bb-84c/dsh-mobile-common/tailscale.js';
import { checkResumeSafe } from './session-guard.js';

const { sha256Hex } = devices;

export const GATEWAY_VERSION = '0.1.0';
const SESSION_COOKIE = 'dsh_mobile_sid';
const RATE_LIMIT = 10; // auth attempts per IP
const RATE_WINDOW_MS = 60 * 1000;
const WEB_PROBE_TIMEOUT_MS = 2000;
// Session-live guard body buffer cap: envelopes larger than this (image
// attachments on session.prompt) pass through without the guard.
const GUARD_BODY_LIMIT = 64 * 1024;

// Hop-by-hop headers that must not be forwarded across the proxy boundary.
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

// For a WebSocket upgrade handshake we must preserve `connection`/`upgrade`/
// `sec-websocket-*` (the upstream needs them) and strip only the rest.
const UPGRADE_STRIP = new Set([
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
]);

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/** Only allow same-origin relative redirect targets (blocks open redirects). */
function safeNext(next) {
  if (typeof next !== 'string' || next === '') return '/';
  if (next.startsWith('/') && !next.startsWith('//')) return next;
  return '/';
}

function isLoopback(req) {
  const addr = req.socket && req.socket.remoteAddress;
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

function wantsJson(req) {
  const accept = req.headers && req.headers.accept;
  return typeof accept === 'string' && accept.toLowerCase().includes('application/json');
}

function getSid(req) {
  const cookie = req.headers && req.headers.cookie;
  if (typeof cookie !== 'string') return null;
  for (const part of cookie.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    if (key === SESSION_COOKIE) return part.slice(idx + 1).trim();
  }
  return null;
}

function filterHeaders(headers, stripSet) {
  const out = {};
  for (const [key, value] of Object.entries(headers || {})) {
    if (stripSet.has(key.toLowerCase())) continue;
    out[key] = value;
  }
  return out;
}

// The official web frontend calls crypto.randomUUID (RPC ids, directory
// picker), which browsers only expose in SECURE CONTEXTS. Tailscale mode
// serves plain http over the tailnet (WireGuard already encrypts it), so
// remote browsers lack the API. Inject a minimal polyfill into HTML responses
// (getRandomValues stays available outside secure contexts). Real TLS via
// `tailscale serve` remains the recommended path; this keeps plain-http mode
// functional.
const SECURE_CONTEXT_POLYFILL =
  "<script>(function(){if(!globalThis.crypto||typeof crypto.randomUUID!=='function'){" +
  "var c=globalThis.crypto||{};" +
  "var r=c.getRandomValues?function(a){return c.getRandomValues(a)}:function(a){for(var i=0;i<a.length;i++)a[i]=Math.floor(Math.random()*256)};" +
  "c.randomUUID=function(){var b=new Uint8Array(16);r(b);b[6]=(b[6]&15)|64;b[8]=(b[8]&63)|128;" +
  "var h=Array.from(b,function(x){return x.toString(16).padStart(2,'0')});" +
  "return h.slice(0,4).join('')+'-'+h.slice(4,6).join('')+'-'+h.slice(6,8).join('')+'-'+h.slice(8,10).join('')+'-'+h.slice(10).join('')};" +
  "globalThis.crypto=c;}})();</script>";

/**
 * Stream transform that injects `tag` right after the first `<head ...>` tag.
 * Byte-safe: searches in latin1 so multibyte UTF-8 split across chunks is not
 * corrupted. If no head appears within 64 KiB the stream passes through
 * untouched (the content is not a page we should modify).
 */
function makeHtmlInjector(tag) {
  let pending = Buffer.alloc(0);
  let done = false;
  return new Transform({
    transform(chunk, _encoding, cb) {
      if (done) return cb(null, chunk);
      pending = Buffer.concat([pending, chunk]);
      const text = pending.toString('latin1');
      const match = /<head[^>]*>/i.exec(text);
      if (match) {
        done = true;
        const end = match.index + match[0].length;
        const out = Buffer.concat([
          Buffer.from(text.slice(0, end), 'latin1'),
          Buffer.from(tag, 'utf8'),
          Buffer.from(text.slice(end), 'latin1'),
        ]);
        pending = Buffer.alloc(0);
        return cb(null, out);
      }
      if (pending.length > 64 * 1024) {
        done = true;
        const out = pending;
        pending = Buffer.alloc(0);
        return cb(null, out);
      }
      cb(null);
    },
    flush(cb) {
      if (!done && pending.length > 0) cb(null, pending);
      else cb(null);
    },
  });
}

function resolvePort(env, config) {
  if (env && env.DSH_MOBILE_GATEWAY_PORT !== undefined && env.DSH_MOBILE_GATEWAY_PORT !== '') {
    const p = Number(env.DSH_MOBILE_GATEWAY_PORT);
    if (Number.isInteger(p) && p >= 0) return p;
  }
  const p = config && config.gatewayPort;
  if (Number.isInteger(p) && p >= 0) return p;
  return 3081;
}

function resolveHost(config) {
  if (config && config.mode === 'relay') return '127.0.0.1';
  const ip = config && config.tailscale && config.tailscale.interfaceIp;
  return ip || '0.0.0.0';
}

function json(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function redirect(res, location) {
  res.writeHead(302, { location });
  res.end();
}

// ---------------------------------------------------------------------------
// Gateway factory (testable core)
// ---------------------------------------------------------------------------

/**
 * Create a mobile gateway. Dependencies are injectable so the suite can run
 * fully offline.
 * @param {object} [deps]
 * @param {object} [deps.env]             process env (MOBILE_HOME, DSH_MOBILE_*)
 * @param {object} [deps.config]          resolved config (defaults to loadConfig)
 * @param {object} [deps.devices]         device store (default: devices.js singleton)
 * @param {Function} [deps.now]           clock returning epoch ms
 * @param {Function} [deps.uptime]        process uptime seconds
 * @param {number} [deps.pid]             pid for the sidecar (default: process.pid)
 * @param {string} [deps.logPath]         audit log path
 * @param {number} [deps.targetPort]      dsh web port to proxy to (default: config.webPort)
 * @param {Function} [deps.serverFactory] (handler) => http.Server
 * @param {Function} [deps.fetchImpl]     fetch for the web probe
 * @param {object} [deps.tailscale]       { ip4(), hostname() }
 * @param {Function} [deps.relayStatus]   (env) => object|null
 */
export function createGateway(deps = {}) {
  const {
    env = process.env,
    config = null,
    devices: devicesApi = devices,
    now = () => Date.now(),
    uptime = () => process.uptime(),
    pid = process.pid,
    logPath = null,
    targetPort = null,
    serverFactory = null,
    fetchImpl = globalThis.fetch,
    tailscale = null,
    relayStatus = readRelayStatus,
    resumeGuard = null,
  } = deps;

  const effectiveConfig = config ?? loadConfig(env).config;
  const paths = () => mobilePaths(env);
  const port = resolvePort(env, effectiveConfig);
  const host = resolveHost(effectiveConfig);
  const target = targetPort ?? 3080;
  const auditLogPath = logPath ?? path.join(paths().logsDir, 'gateway.log');
  const sessionTtlDays = (effectiveConfig.auth && effectiveConfig.auth.sessionTtlDays) || 30;
  const sessionTtlMs = sessionTtlDays * 86400 * 1000;
  const sessionMaxAgeSec = sessionTtlDays * 86400;
  const ts = tailscale ?? { ip4: () => tailscaleIp4(), hostname: () => tailscaleHostname() };

  // Runtime state.
  const sessions = new Map(); // sid -> { deviceId, expiresAt }
  const buckets = new Map(); // ip -> { tokens, last }
  const deviceSockets = new Map(); // deviceId -> Set<socket>
  const allSockets = new Set(); // every TCP socket (for stop())
  let server = null;
  let started = false;
  let boundPort = null;
  let boundHost = null;
  let cleanupTimer = null;
  let sidecarPath = null;
  let cachedInstanceId;

  // --- session store -------------------------------------------------------

  // Sessions survive service restarts: sid -> {deviceId, expiresAt} persisted
  // to $DSH_HOME/mobile/data/sessions.json with the sid stored ONLY as its
  // SHA-256 hash (the raw sid lives in the browser cookie alone).
  const sessionsFilePath = path.join(paths().dataDir, 'sessions.json');
  let sessionDirty = false;

  function persistSessions() {
    if (!sessionDirty) return;
    sessionDirty = false;
    try {
      const records = [];
      for (const [hash, session] of sessions) {
        records.push({ hash, deviceId: session.deviceId, expiresAt: session.expiresAt });
      }
      atomicWriteJson(sessionsFilePath, records);
    } catch {
      // persistence must never break serving
    }
  }

  function loadSessions() {
    try {
      const records = JSON.parse(fs.readFileSync(sessionsFilePath, 'utf8'));
      const t = now();
      for (const record of Array.isArray(records) ? records : []) {
        if (typeof record?.hash !== 'string' || typeof record?.deviceId !== 'string') continue;
        if (typeof record.expiresAt !== 'number' || record.expiresAt <= t) continue;
        sessions.set(record.hash, { deviceId: record.deviceId, expiresAt: record.expiresAt });
      }
    } catch {
      // missing/corrupt file -> start empty
    }
  }

  function createSession(deviceId) {
    const sid = randomBytes(16).toString('hex');
    sessions.set(sha256Hex(sid), { deviceId, expiresAt: now() + sessionTtlMs });
    sessionDirty = true;
    persistSessions();
    return { sid, maxAgeSec: sessionMaxAgeSec };
  }

  function getSession(sid) {
    if (!sid) return null;
    const session = sessions.get(sha256Hex(sid));
    if (!session) return null;
    if (session.expiresAt <= now()) {
      sessions.delete(sha256Hex(sid));
      sessionDirty = true;
      return null;
    }
    session.expiresAt = now() + sessionTtlMs; // sliding renewal
    return session;
  }

  function destroyDeviceSessions(deviceId) {
    for (const [hash, session] of sessions) {
      if (session.deviceId === deviceId) sessions.delete(hash);
    }
    sessionDirty = true;
    persistSessions();
  }

  function cleanup() {
    const t = now();
    for (const [hash, session] of sessions) {
      if (session.expiresAt <= t) {
        sessions.delete(hash);
        sessionDirty = true;
      }
    }
    for (const [ip, bucket] of buckets) {
      if (t - bucket.last > RATE_WINDOW_MS * 2) buckets.delete(ip);
    }
    persistSessions();
  }

  // --- rate limiting (in-memory token bucket) ------------------------------

  function rateAllow(ip) {
    const t = now();
    let bucket = buckets.get(ip);
    if (!bucket) {
      bucket = { tokens: RATE_LIMIT, last: t };
      buckets.set(ip, bucket);
    }
    const elapsed = t - bucket.last;
    bucket.tokens = Math.min(RATE_LIMIT, bucket.tokens + (elapsed / RATE_WINDOW_MS) * RATE_LIMIT);
    bucket.last = t;
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return true;
    }
    return false;
  }

  // --- socket tracking (so revocation can tear down live SSE/WS) -----------

  function trackSocket(deviceId, socket) {
    if (!deviceId || !socket) return;
    let set = deviceSockets.get(deviceId);
    if (!set) {
      set = new Set();
      deviceSockets.set(deviceId, set);
    }
    if (set.has(socket)) return;
    set.add(socket);
    socket.once('close', () => {
      set.delete(socket);
      if (set.size === 0) deviceSockets.delete(deviceId);
    });
  }

  function destroyDeviceSockets(deviceId) {
    const set = deviceSockets.get(deviceId);
    if (!set) return;
    for (const socket of set) socket.destroy();
    deviceSockets.delete(deviceId);
  }

  // --- authentication ------------------------------------------------------

  /** Timing-safe device lookup by raw token (sha256 hash comparison). */
  function verifyToken(rawToken) {
    if (typeof rawToken !== 'string' || rawToken === '') return null;
    const hashBuf = Buffer.from(sha256Hex(rawToken), 'hex');
    for (const device of devicesApi.listDevices()) {
      if (device.revoked || typeof device.tokenHash !== 'string') continue;
      const candidate = Buffer.from(device.tokenHash, 'hex');
      if (candidate.length !== hashBuf.length) continue;
      if (timingSafeEqual(candidate, hashBuf)) return device;
    }
    return null;
  }

  function authenticate(req) {
    const auth = req.headers && req.headers.authorization;
    if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
      const token = auth.slice(7).trim();
      return verifyToken(token); // null on bad bearer (no cookie fallback)
    }
    const session = getSession(getSid(req));
    if (session) {
      const device = devicesApi.listDevices().find((d) => d.id === session.deviceId && !d.revoked);
      if (device) return device;
    }
    return null;
  }

  function isOwner(deviceId) {
    const list = devicesApi.listDevices();
    const owner = list.find((d) => !d.revoked);
    return Boolean(owner && owner.id === deviceId);
  }

  /** Returns {ok, deviceId} | {ok:false, status}. */
  function requireOwner(req) {
    const device = authenticate(req);
    if (device) {
      return isOwner(device.id) ? { ok: true, deviceId: device.id } : { ok: false, status: 403 };
    }
    if (isLoopback(req)) return { ok: true, deviceId: null };
    return { ok: false, status: 401 };
  }

  // --- audit ---------------------------------------------------------------

  function audit(event, extra = {}) {
    try {
      fs.mkdirSync(path.dirname(auditLogPath), { recursive: true });
      const parts = [`ts=${new Date(now()).toISOString()}`, `event=${event}`];
      for (const [key, value] of Object.entries(extra)) {
        if (value === undefined || value === null) continue;
        parts.push(`${key}=${String(value).replace(/\s/g, '_')}`);
      }
      fs.appendFileSync(auditLogPath, `${parts.join(' ')}\n`, 'utf8');
    } catch {
      // audit must never break serving
    }
  }

  // --- body / form parsing -------------------------------------------------

  function readBody(req, limit = 1024 * 1024) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > limit) {
          reject(new Error('request body too large'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  function parseBody(req, raw) {
    if (!raw) return {};
    const ct = String(req.headers['content-type'] || '').toLowerCase();
    if (ct.includes('application/json')) {
      try {
        return JSON.parse(raw);
      } catch {
        return {};
      }
    }
    if (ct.includes('application/x-www-form-urlencoded')) {
      return Object.fromEntries(new URLSearchParams(raw));
    }
    // fallback: try JSON, then form
    try {
      return JSON.parse(raw);
    } catch {
      return Object.fromEntries(new URLSearchParams(raw));
    }
  }

  // --- login / pairing -----------------------------------------------------

  /** Redeem a one-time pairing code, minting the device's long-lived token. */
  function redeemCode(code) {
    if (!/^\d{6}$/.test(String(code))) return null;
    const rawToken = randomBytes(16).toString('hex');
    try {
      const device = devicesApi.completePairing({ pairingCode: String(code), rawToken });
      return { device, rawToken };
    } catch {
      return null;
    }
  }

  /**
   * @returns {{ok:boolean, deviceId?:string, rawToken?:string, error?:string}}
   */
  function login(body) {
    let { code, token } = body || {};
    // A single form field named `code` may carry either a 6-digit pairing code
    // or a device token; a non-numeric value is treated as a token.
    if (!token && code && !/^\d{6}$/.test(code)) {
      token = code;
      code = undefined;
    }
    if (token) {
      const device = verifyToken(token);
      if (!device) return { ok: false, error: 'invalid device token' };
      return { ok: true, deviceId: device.id };
    }
    if (code) {
      const redeemed = redeemCode(code);
      if (!redeemed) return { ok: false, error: 'invalid or expired pairing code' };
      return { ok: true, deviceId: redeemed.device.id, rawToken: redeemed.rawToken };
    }
    return { ok: false, error: 'pairing code or device token required' };
  }

  function setSessionCookie(req, res, sid, maxAgeSec) {
    const secure = Boolean(req.socket && req.socket.encrypted);
    const cookie = `${SESSION_COOKIE}=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSec}` +
      (secure ? '; Secure' : '');
    res.setHeader('set-cookie', cookie);
  }

  function clearSessionCookie(res) {
    res.setHeader('set-cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
  }

  function authErrorText(key) {
    if (!key) return '';
    if (key === 'pair') return 'Invalid or expired pairing code.';
    if (key === 'missing') return 'A pairing code is required.';
    return 'Sign in failed.';
  }

  function renderLogin(res, { next = '', error = '', status = 200 } = {}) {
    const nextVal = safeNext(next) === '/' ? '' : escapeHtml(safeNext(next));
    const errorHtml = error ? `<p class="error">${escapeHtml(error)}</p>` : '';
    const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>dsh mobile — sign in</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #101014; color: #e6e6eb; font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  form { width: min(24rem, 92vw); padding: 2rem; background: #18181e; border: 1px solid #2a2a32; border-radius: 12px; display: grid; gap: 1rem; }
  h1 { margin: 0; font-size: 1.25rem; font-weight: 600; }
  input, button { font: inherit; padding: .7rem .8rem; border-radius: 8px; border: 1px solid #3a3a44; background: #101014; color: inherit; }
  button { cursor: pointer; background: #2563eb; border-color: #2563eb; color: #fff; font-weight: 600; }
  button:hover { background: #1d4ed8; }
  .error { color: #fca5a5; margin: 0; }
  .hint { color: #9ca3af; font-size: .85rem; margin: 0; }
</style></head>
<body>
  <form method="post" action="/mobile/auth" autocomplete="off">
    <h1>dsh mobile</h1>
    ${errorHtml}
    <input name="code" placeholder="Pairing code or device token" autofocus required />
    <input type="hidden" name="next" value="${nextVal}" />
    <button type="submit">Sign in</button>
    <p class="hint">Pair a device with <code>dsh --profile mobile device pair</code>, or paste an existing device token.</p>
  </form>
</body></html>`;
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  }

  // --- self endpoints (/mobile/*) ------------------------------------------

  function instanceId() {
    if (cachedInstanceId !== undefined) return cachedInstanceId;
    if (effectiveConfig.relay && effectiveConfig.relay.instanceId) {
      cachedInstanceId = effectiveConfig.relay.instanceId;
    } else {
      try {
        cachedInstanceId = ts.hostname() || '';
      } catch {
        cachedInstanceId = '';
      }
    }
    return cachedInstanceId;
  }

  function handleHealth(req, res) {
    json(res, 200, {
      ok: true,
      version: GATEWAY_VERSION,
      mode: effectiveConfig.mode,
      instanceId: instanceId(),
      uptimeSec: Math.round(uptime()),
    });
  }

  async function handleAuthPost(req, res, url) {
    const ip = req.socket.remoteAddress || 'unknown';
    if (!rateAllow(ip)) return json(res, 429, { error: 'rate limit exceeded' });

    const body = parseBody(req, await readBody(req));
    const result = login(body);

    if (!result.ok) {
      audit('login_fail', { ip, reason: result.error });
      if (wantsJson(req)) return json(res, 401, { error: result.error });
      return renderLogin(res, { next: body.next || '', error: result.error, status: 401 });
    }

    const { sid, maxAgeSec } = createSession(result.deviceId);
    setSessionCookie(req, res, sid, maxAgeSec);
    audit('login_success', { ip, deviceId: result.deviceId });

    if (wantsJson(req)) {
      const payload = { ok: true, deviceId: result.deviceId };
      if (result.rawToken) payload.token = result.rawToken; // delivered once, app flow
      return json(res, 200, payload);
    }
    return redirect(res, safeNext(body.next || ''));
  }

  async function handlePair(req, res, url) {
    const ip = req.socket.remoteAddress || 'unknown';
    if (!rateAllow(ip)) return json(res, 429, { error: 'rate limit exceeded' });

    let code = url.searchParams.get('code');
    if (!code && req.method === 'POST') {
      const body = parseBody(req, await readBody(req));
      code = body.code;
    }
    if (!code) return redirect(res, '/mobile/auth?error=missing');

    const redeemed = redeemCode(code);
    if (!redeemed) {
      audit('pair_fail', { ip, code });
      return redirect(res, '/mobile/auth?error=pair');
    }
    const { sid, maxAgeSec } = createSession(redeemed.device.id);
    setSessionCookie(req, res, sid, maxAgeSec);
    audit('pair_success', { ip, deviceId: redeemed.device.id });
    if (req.method === 'POST' && wantsJson(req)) {
      // App flow: deliver the minted device token exactly once as JSON
      // (docs/specs/mobile-app.md §3.1). Device tokens are long-lived and
      // revocation-managed, so expiresAt is null.
      return json(res, 200, {
        ok: true,
        deviceId: redeemed.device.id,
        token: redeemed.rawToken,
        expiresAt: null,
      });
    }
    return redirect(res, '/');
  }

  function handleLogout(req, res) {
    const sid = getSid(req);
    if (sid) sessions.delete(sid);
    clearSessionCookie(res);
    if (wantsJson(req)) return json(res, 200, { ok: true });
    return redirect(res, '/');
  }

  function handleListDevices(req, res) {
    const authz = requireOwner(req);
    if (!authz.ok) {
      return json(res, authz.status, { error: authz.status === 403 ? 'owner required' : 'unauthorized' });
    }
    const list = devicesApi.listDevices();
    const owner = list.find((d) => !d.revoked);
    json(res, 200, { devices: list, ownerId: owner ? owner.id : null });
  }

  function handleDeleteDevice(req, res, id) {
    const authz = requireOwner(req);
    if (!authz.ok) {
      return json(res, authz.status, { error: authz.status === 403 ? 'owner required' : 'unauthorized' });
    }
    const device = devicesApi.revokeDevice(id);
    if (!device) return json(res, 404, { error: 'device not found' });
    destroyDeviceSessions(id);
    destroyDeviceSockets(id);
    audit('revoke', { deviceId: id, by: authz.deviceId ?? 'loopback' });
    json(res, 200, { ok: true });
  }

  async function handleToken(req, res) {
    const authz = requireOwner(req);
    if (!authz.ok) {
      return json(res, authz.status, { error: authz.status === 403 ? 'owner required' : 'unauthorized' });
    }
    const body = parseBody(req, await readBody(req));
    const targetId = body.deviceId || authz.deviceId;
    if (!targetId) return json(res, 400, { error: 'deviceId required' });
    const result = devicesApi.rotateDeviceToken(targetId);
    if (!result) return json(res, 404, { error: 'device not found' });
    audit('token_rotate', { deviceId: targetId, by: authz.deviceId ?? 'loopback' });
    json(res, 200, { ok: true, deviceId: targetId, token: result.rawToken });
  }

  async function probeWeb() {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), WEB_PROBE_TIMEOUT_MS);
      try {
        const res = await fetchImpl(`http://127.0.0.1:${target}/`, { signal: controller.signal });
        return Boolean(res);
      } finally {
        clearTimeout(timer);
      }
    } catch {
      return false;
    }
  }

  async function handleStatus(req, res) {
    const device = authenticate(req);
    if (!device && !isLoopback(req)) {
      return json(res, 401, { error: 'unauthorized' });
    }
    let tailscaleIp = null;
    let tailscaleHost = null;
    let relayState = null;
    try {
      tailscaleIp = ts.ip4();
    } catch {
      // degrade gracefully
    }
    try {
      tailscaleHost = ts.hostname();
    } catch {
      // degrade gracefully
    }
    try {
      relayState = relayStatus(env);
    } catch {
      // degrade gracefully
    }
    // Shape contract: docs/specs/mobile-app.md §3.4.
    json(res, 200, {
      ok: true,
      mode: effectiveConfig.mode,
      instanceId: instanceId(),
      displayName: effectiveConfig.relay?.displayName ?? '',
      uptimeSec: Math.round(uptime()),
      tailscale: { interfaceIp: tailscaleIp, hostname: tailscaleHost },
      relay: relayState
        ? { connected: Boolean(relayState.connected), since: relayState.since ?? null, instanceId: relayState.instanceId ?? '', displayName: effectiveConfig.relay?.displayName ?? '' }
        : { connected: false, since: null, instanceId: '', displayName: '' },
      dshWeb: { healthy: await probeWeb(), webPort: target },
    });
  }

  async function handleMobile(req, res, url, pathname) {
    const method = req.method.toUpperCase();
    if (pathname === '/mobile/health' && method === 'GET') return handleHealth(req, res);
    if (pathname === '/mobile/auth' && method === 'GET') {
      return renderLogin(res, {
        next: url.searchParams.get('next') || '',
        error: authErrorText(url.searchParams.get('error')),
      });
    }
    if (pathname === '/mobile/auth' && method === 'POST') return handleAuthPost(req, res, url);
    if (pathname === '/mobile/pair' && (method === 'GET' || method === 'POST')) return handlePair(req, res, url);
    if (pathname === '/mobile/logout' && method === 'POST') return handleLogout(req, res);
    if (pathname === '/mobile/api/devices' && method === 'GET') return handleListDevices(req, res);
    if (pathname === '/mobile/api/status' && method === 'GET') return handleStatus(req, res);
    if (pathname === '/mobile/api/token' && method === 'POST') return handleToken(req, res);

    const match = /^\/mobile\/api\/devices\/([^/]+)$/.exec(pathname);
    if (match && method === 'DELETE') return handleDeleteDevice(req, res, match[1]);

    return json(res, 404, { error: 'not found' });
  }

  // --- proxy path ----------------------------------------------------------

  function forward(req, res, deviceId, preReadBody = null) {
    const headers = filterHeaders(req.headers, HOP_BY_HOP);
    // Relay mode: the tunnel's fetch forbids a custom Host header, so the web
    // app would see Host: 127.0.0.1:<gatewayPort> while the browser's requests
    // carry Origin: https://<relay-host> — the official trust fence then
    // rejects every /api call with 403 (Origin vs Host mismatch) and pins
    // privileged methods to loopback anyway. Present ALL proxied requests as
    // loopback-local and drop the browser origin: the gateway is the device
    // authentication boundary here, not the web app's browser fence.
    if (effectiveConfig.mode === 'relay') {
      headers.host = `127.0.0.1:${target}`;
      delete headers.origin;
    }
    const proxyReq = http.request(
      {
        host: '127.0.0.1',
        port: target,
        method: req.method,
        path: req.url,
        headers,
      },
      (proxyRes) => {
        let upstreamEnded = false;
        const resHeaders = filterHeaders(proxyRes.headers, HOP_BY_HOP);
        resHeaders['x-dsh-mobile-gateway'] = '1';
        const contentType = typeof proxyRes.headers['content-type'] === 'string' ? proxyRes.headers['content-type'].toLowerCase() : '';
        const isHtml = contentType.includes('text/html');
        const isEncoded = proxyRes.headers['content-encoding'] !== undefined;
        if (isHtml && !isEncoded) {
          // Inject the secure-context polyfill; length changes, so stream
          // chunked instead of trusting the upstream content-length.
          delete resHeaders['content-length'];
          res.writeHead(proxyRes.statusCode, resHeaders);
          proxyRes.pipe(makeHtmlInjector(SECURE_CONTEXT_POLYFILL)).pipe(res);
        } else {
          res.writeHead(proxyRes.statusCode, resHeaders);
          proxyRes.pipe(res);
        }
        proxyRes.on('end', () => {
          upstreamEnded = true;
        });
        proxyRes.on('error', () => res.destroy());
        // If the client goes away mid-stream (revocation), abort upstream too.
        res.on('close', () => {
          if (!upstreamEnded) proxyReq.destroy();
        });
      },
    );
    proxyReq.on('error', () => {
      if (!res.headersSent) json(res, 502, { error: 'bad gateway' });
      else res.destroy();
    });
    req.on('aborted', () => proxyReq.destroy());
    if (preReadBody !== null) {
      proxyReq.end(preReadBody);
    } else {
      req.pipe(proxyReq);
    }
    trackSocket(deviceId, req.socket);
  }

  async function handleProxy(req, res) {
    const device = authenticate(req);
    if (!device) {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      if (pathname.startsWith('/api') || wantsJson(req)) {
        return json(res, 401, { error: 'unauthorized' });
      }
      return redirect(res, `/mobile/auth?next=${encodeURIComponent(req.url)}`);
    }

    // Session-live guard: opening/resuming a session whose log another dsh
    // instance is actively writing corrupts it (single-writer logs). Check
    // before forwarding; bodies over the buffer cap pass through unguarded.
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (
      req.method === 'POST' &&
      (pathname === '/api/session.prompt' || pathname === '/api/session.create') &&
      resumeGuard !== null
    ) {
      let raw = null;
      try {
        raw = await readBody(req, GUARD_BODY_LIMIT);
      } catch {
        raw = null;
      }
      if (raw !== null) {
        let sessionId;
        try {
          sessionId = JSON.parse(raw)?.payload?.sessionId;
        } catch {
          sessionId = undefined;
        }
        const verdict = await checkResumeSafe(
          { dshHome: resumeGuard.dshHome, sessions: resumeGuard.sessions, now: resumeGuard.now },
          sessionId,
        );
        if (!verdict.safe) {
          audit('session_guard_block', { sessionId: sessionId ?? '', reason: verdict.reason });
          return json(res, 409, { error: 'session-live-elsewhere', message: verdict.reason });
        }
        return forward(req, res, device.id, raw);
      }
    }

    return forward(req, res, device.id);
  }

  function handleUpgrade(req, socket, head) {
    const device = authenticate(req);
    if (!device) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const upstream = net.connect(target, '127.0.0.1', () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      const headers = { ...(req.headers || {}) };
      if (effectiveConfig.mode === 'relay') {
        headers.host = `127.0.0.1:${target}`;
        delete headers.origin;
      }
      for (const [key, value] of Object.entries(headers)) {
        if (UPGRADE_STRIP.has(key.toLowerCase())) continue;
        lines.push(`${key}: ${Array.isArray(value) ? value.join(', ') : value}`);
      }
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head && head.length) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
      trackSocket(device.id, socket);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
    socket.on('close', () => upstream.destroy());
    upstream.on('close', () => socket.destroy());
  }

  function handleRequest(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;
    Promise.resolve(
      pathname.startsWith('/mobile/') ? handleMobile(req, res, url, pathname) : handleProxy(req, res),
    ).catch(() => {
      if (!res.headersSent) json(res, 500, { error: 'internal error' });
      else res.destroy();
    });
  }

  // --- lifecycle -----------------------------------------------------------

  function writeSidecar() {
    const dir = paths().instancesDir;
    fs.mkdirSync(dir, { recursive: true });
    sidecarPath = path.join(dir, `${pid}.json`);
    const startedAt = now() - Math.round(uptime() * 1000);
    atomicWriteJson(sidecarPath, { pid, startedAt, token: env.DSH_MOBILE_TOKEN });
  }

  function deleteSidecar() {
    if (!sidecarPath) return;
    try {
      const current = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
      if (current && current.pid === pid && current.token === env.DSH_MOBILE_TOKEN) {
        fs.unlinkSync(sidecarPath);
      }
    } catch {
      // already gone
    }
    sidecarPath = null;
  }

  function start() {
    return new Promise((resolve, reject) => {
      if (started && server) return resolve({ port: boundPort, host: boundHost });
      ensureMobileDirs(env);
      fs.mkdirSync(path.dirname(sessionsFilePath), { recursive: true });
      loadSessions();
      writeSidecar();
      const factory = serverFactory || ((handler) => http.createServer(handler));
      server = factory(handleRequest);
      server.on('upgrade', handleUpgrade);
      server.on('connection', (socket) => {
        allSockets.add(socket);
        socket.once('close', () => allSockets.delete(socket));
      });
      server.on('error', reject);
      server.listen(port, host, () => {
        const address = server.address();
        boundPort = address.port;
        boundHost = host;
        started = true;
        cleanupTimer = setInterval(cleanup, RATE_WINDOW_MS);
        if (typeof cleanupTimer.unref === 'function') cleanupTimer.unref();
        audit('bind', { host: boundHost, port: boundPort, mode: effectiveConfig.mode });
        // eslint-disable-next-line no-console
        console.log(`[dsh-mobile-server] mobile gateway listening on http://${boundHost}:${boundPort} (mode=${effectiveConfig.mode})`);
        resolve({ port: boundPort, host: boundHost });
      });
    });
  }

  function stop() {
    if (cleanupTimer) {
      clearInterval(cleanupTimer);
      cleanupTimer = null;
    }
    deleteSidecar();
    for (const set of deviceSockets.values()) {
      for (const socket of set) socket.destroy();
    }
    deviceSockets.clear();
    for (const socket of allSockets) socket.destroy();
    allSockets.clear();
    sessions.clear();
    if (server) {
      try {
        server.close();
      } catch {
        // already closed
      }
      server = null;
    }
    started = false;
    boundPort = null;
  }

  return {
    start,
    stop,
    get server() {
      return server;
    },
    get port() {
      return boundPort;
    },
    get host() {
      return boundHost;
    },
    get config() {
      return effectiveConfig;
    },
  };
}

// ---------------------------------------------------------------------------
// Cordis entry (called by startup.js when DSH_MOBILE_INSTANCE === "1")
// ---------------------------------------------------------------------------

/**
 * @param {{ ctx?: object }} [params]
 * @returns {Promise<{ stop(): void }>}
 */
export async function startGateway({ ctx } = {}) {
  const env = process.env;
  const loaded = loadConfig(env);
  if (!loaded.valid || loaded.errors.length > 0) {
    // eslint-disable-next-line no-console
    console.warn(`[dsh-mobile-server] config warnings: ${loaded.errors.join('; ')}`);
  }
  // Session-live guard inputs: the live session store (sessions we own) and
  // the shared harness home (where session logs live). Null when the service
  // is absent — the guard then degrades to pass-through.
  const sessionsService = ctx?.get?.('sessions');
  const resumeGuard =
    typeof sessionsService?.get === 'function'
      ? { dshHome: path.dirname(mobilePaths(env).home), sessions: sessionsService }
      : null;
  const gateway = createGateway({ env, config: loaded.config, resumeGuard });
  await gateway.start();
  return { stop: () => gateway.stop() };
}
