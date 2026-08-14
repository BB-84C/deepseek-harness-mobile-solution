/**
 * Instance-side relay tunnel client (M3).
 *
 * Opens ONE outbound WebSocket to the relay
 * (wss://<relay>/relay/instance-tunnel?instanceToken=..&id=..&name=..) and
 * serves relay-forwarded HTTP requests against the LOCAL gateway
 * (http://127.0.0.1:<gatewayPort>). Wire protocol: docs/research/relay-protocol.md.
 *
 * The tunnel is transport only: device authentication happens inside the
 * gateway, never here. The relay forwards the client's Authorization header
 * verbatim (see protocol §6).
 */

import os from 'node:os';
import { loadConfig } from '@bb-84c/dsh-mobile-common/config.js';
import { writeRelayStatus } from '@bb-84c/dsh-mobile-common/relay-status.js';

const STREAM_LIMIT = 32;
const HOP_BY_HOP_RES = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-length', 'content-encoding',
]);

/** Sanitize an instance id / display name to ^[a-z0-9-]{1,64}$. */
function sanitizeName(value, fallback) {
  const cleaned = String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return cleaned || sanitizeName(String(fallback ?? 'dsh'), 'dsh');
}

function tunnelUrl(config, hostname) {
  const base = String(config.relay?.url ?? '').replace(/\/+$/, '');
  if (!base) throw new Error('relay.url is not configured');
  const wsBase = base.replace(/^https:\/\//i, 'wss://').replace(/^http:\/\//i, 'ws://');
  const id = sanitizeName(config.relay?.instanceId, hostname);
  const name = sanitizeName(config.relay?.displayName, hostname);
  const params = new URLSearchParams({
    instanceToken: String(config.relay?.instanceToken ?? ''),
    id,
    name,
  });
  return `${wsBase}/relay/instance-tunnel?${params}`;
}

export function createTunnelClient(deps = {}) {
  const {
    config,
    targetPort,
    hostname = () => os.hostname(),
    wsCtor = globalThis.WebSocket,
    fetchImpl = fetch,
    writeStatus = writeRelayStatus,
    log = console,
    reconnectBaseMs = 1000,
    reconnectMaxMs = 30000,
    streamLimit = STREAM_LIMIT,
  } = deps;

  if (!config) throw new Error('config is required');
  if (!targetPort) throw new Error('targetPort is required');

  const inflight = new Map();
  let ws = null;
  let stopped = false;
  let reconnectTimer = null;
  let backoffMs = reconnectBaseMs;
  let connectedSince = null;

  function status(connected, lastError = null) {
    try {
      writeStatus({
        connected,
        since: connected && connectedSince ? new Date(connectedSince).toISOString() : null,
        instanceId: config.relay?.instanceId ?? '',
        lastError,
      });
    } catch {
      /* status is best-effort */
    }
  }

  function send(frame) {
    if (ws && ws.readyState === 1 /* OPEN */) ws.send(JSON.stringify(frame));
  }

  async function handleReq(frame) {
    const id = frame.id;
    let controller;
    try {
      if (inflight.size >= streamLimit) {
        send({ v: 1, t: 'res', id, status: 503, headers: { 'content-type': 'application/json' } });
        send({ v: 1, t: 'chunk', id, bodyBase64: Buffer.from(JSON.stringify({ error: 'stream-limit' })).toString('base64') });
        send({ v: 1, t: 'end', id });
        return;
      }
      controller = new AbortController();
      inflight.set(id, controller);
      const headers = { ...(frame.headers ?? {}) };
      const body = frame.bodyBase64 ? Buffer.from(frame.bodyBase64, 'base64') : undefined;
      const response = await fetchImpl(`http://127.0.0.1:${targetPort}${frame.url ?? '/'}`, {
        method: frame.method ?? 'GET',
        headers,
        body,
        signal: controller.signal,
      });
      const resHeaders = {};
      if (response.headers) {
        // Headers is an iterator object, not a plain record — Object.entries
        // would silently yield nothing.
        for (const [key, value] of response.headers.entries()) {
          if (!HOP_BY_HOP_RES.has(key.toLowerCase())) resHeaders[key] = value;
        }
      }
      send({ v: 1, t: 'res', id, status: response.status, headers: resHeaders });
      if (response.body) {
        const reader = response.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
          send({ v: 1, t: 'chunk', id, bodyBase64: Buffer.from(bytes).toString('base64') });
        }
      }
      send({ v: 1, t: 'end', id });
    } catch (error) {
      const aborted = error?.name === 'AbortError';
      if (!aborted && ws && ws.readyState === 1) {
        send({ v: 1, t: 'res', id, status: 502, headers: { 'content-type': 'application/json' } });
        send({ v: 1, t: 'chunk', id, bodyBase64: Buffer.from(JSON.stringify({ error: 'instance-request-failed' })).toString('base64') });
        send({ v: 1, t: 'end', id });
      }
    } finally {
      if (controller) inflight.delete(id);
    }
  }

  function connect() {
    if (stopped) return;
    let url;
    try {
      url = tunnelUrl(config, hostname());
    } catch (error) {
      log.error(`[relay-tunnel] ${error.message}`);
      status(false, error.message);
      return;
    }
    log.log(`[relay-tunnel] connecting to ${url.replace(/instanceToken=[^&]+/, 'instanceToken=***')}`);
    try {
      ws = new wsCtor(url);
    } catch (error) {
      scheduleReconnect(`failed to construct WebSocket: ${error.message}`);
      return;
    }
    ws.addEventListener('open', () => {
      backoffMs = reconnectBaseMs;
      connectedSince = Date.now();
      status(true);
      log.log('[relay-tunnel] connected');
    });
    ws.addEventListener('message', (event) => {
      let frame;
      try {
        frame = JSON.parse(String(event.data));
      } catch {
        return; // ignore malformed frames
      }
      if (frame && frame.v === 1 && frame.t === 'req' && Number.isInteger(frame.id)) {
        handleReq(frame).catch(() => {});
      }
    });
    ws.addEventListener('close', () => {
      const wasConnected = connectedSince !== null;
      connectedSince = null;
      abortAll();
      status(false, 'connection closed');
      if (wasConnected) log.log('[relay-tunnel] disconnected');
      scheduleReconnect('connection closed');
    });
    ws.addEventListener('error', () => {
      // close follows; nothing to do here beyond a log line
      log.error('[relay-tunnel] websocket error');
    });
  }

  function abortAll() {
    for (const controller of inflight.values()) {
      try {
        controller.abort();
      } catch {
        /* ignore */
      }
    }
    inflight.clear();
  }

  function scheduleReconnect(reason) {
    if (stopped) return;
    if (reconnectTimer) return;
    log.log(`[relay-tunnel] reconnecting in ${backoffMs}ms (${reason})`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      backoffMs = Math.min(backoffMs * 2, reconnectMaxMs);
      try {
        if (ws && ws.readyState !== 3 /* CLOSED */) ws.close();
      } catch {
        /* ignore */
      }
      connect();
    }, backoffMs);
    if (reconnectTimer.unref) reconnectTimer.unref();
  }

  function start() {
    connect();
    return {
      stop() {
        stopped = true;
        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
        abortAll();
        try {
          if (ws && ws.readyState !== 3 /* CLOSED */) ws.close();
        } catch {
          /* ignore */
        }
        status(false, 'stopped');
      },
      get connected() {
        return connectedSince !== null;
      },
    };
  }

  return { start };
}

/** Start the tunnel for the resident instance when config.mode === 'relay'. */
export async function startTunnel(deps = {}) {
  const { config = loadConfig().config, targetPort, ...rest } = deps;
  if (config.mode !== 'relay') return null;
  return createTunnelClient({ config, targetPort, ...rest }).start();
}
