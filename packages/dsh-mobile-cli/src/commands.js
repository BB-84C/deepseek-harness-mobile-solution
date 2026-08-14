/**
 * Command orchestration for `dsh --profile mobile <command>`.
 *
 * Thin layer between the commander program (startup.js) and the business
 * modules (home/config/service/tailscale/devices/url/doctor). Every command
 * returns an exit code; output goes to stdout/stderr as plain text.
 */

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureMobileDirs, logsDir, resolveMobileHome } from "@bb-84c/dsh-mobile-common/home.js";
import { loadConfig, saveConfig, setConfigValue, getConfigValue } from "@bb-84c/dsh-mobile-common/config.js";
import * as tailscale from "@bb-84c/dsh-mobile-common/tailscale.js";
import * as service from "@bb-84c/dsh-mobile-common/service.js";
import * as devices from "@bb-84c/dsh-mobile-common/devices.js";
import { buildAccessUrl, pairingUrl } from "@bb-84c/dsh-mobile-common/url.js";
import { diagnose } from "@bb-84c/dsh-mobile-common/doctor.js";
import { readRelayStatus } from "@bb-84c/dsh-mobile-common/relay-status.js";

/** Repository root, derived from this file's real location (works through the
 * profile junction because ESM resolves the real path). */
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const INSTALLER = join(REPO_ROOT, "scripts", "install-mobile.mjs");

function fail(message) {
  throw new Error(message);
}

/** Load config with defaults; print validation problems as warnings. */
function mustConfig() {
  const loaded = loadConfig();
  if (loaded.errors.length > 0) console.warn(`config: ${loaded.errors.join("; ")}`);
  return loaded.config;
}

/** Unique, order-preserving, empty-free. */
function unique(values) {
  return [...new Set(values.filter((v) => v !== "" && v !== undefined && v !== null))];
}

/** Compute the --trusted-host authorities for the resident web instance:
 * the browser's origin after the gateway proxies it must pass the official
 * /api trust fence. Feed every plausible literal form. */
async function computeAuthorities(config) {
  const port = String(config.gatewayPort ?? 3081);
  if (config.mode === "relay") {
    const base = (config.relay?.url ?? "").replace(/^https?:\/\//, "").replace(/\/+$/, "");
    if (!base) fail("relay.url is not configured; run: dsh --profile mobile relay connect <relay-url>");
    return unique([base, `${base.split("/")[0]}:443`]);
  }
  const ip = tailscale.tailscaleIp4();
  const host = tailscale.tailscaleHostname();
  if (!ip && !host) fail("tailscale is not up; run: dsh --profile mobile tailscale connect");
  return unique([ip, `${ip}:${port}`, host, `${host}:${port}`]);
}

async function mobileUrl(config) {
  const ip = config.mode === "tailscale" ? tailscale.tailscaleIp4() : null;
  const host = config.mode === "tailscale" ? tailscale.tailscaleHostname() : null;
  return buildAccessUrl({ config, tailscaleIp: ip, tailscaleHostname: host });
}

// ── individual commands ────────────────────────────────────────────────────

async function cmdInstall() {
  ensureMobileDirs();
  const result = spawnSync(process.execPath, [INSTALLER], { stdio: "inherit" });
  if (result.error) fail(`could not run installer (${INSTALLER}): ${result.error.message}`);
  if (result.status !== 0 && result.status !== null) return result.status;
  console.log("\ninstall complete — next steps:");
  console.log("  dsh --profile mobile tailscale connect        # or: relay connect <url>");
  console.log("  dsh --profile mobile service start");
  console.log("  dsh --profile mobile device pair --name <phone>");
  return 0;
}

async function cmdUninstall() {
  const result = spawnSync(process.execPath, [INSTALLER, "--uninstall"], { stdio: "inherit" });
  if (result.error) fail(`could not run installer: ${result.error.message}`);
  return result.status ?? 1;
}

async function cmdStatus() {
  const config = mustConfig();
  ensureMobileDirs();
  console.log(`mobile home : ${resolveMobileHome()}`);
  console.log(`mode        : ${config.mode}`);
  console.log(`web port    : ${config.webPort} (loopback, official dsh web)`);
  console.log(`gateway port: ${config.gatewayPort}`);

  const svc = service.serviceStatus({ config });
  console.log(`service     : ${svc.running ? `running (pid ${svc.pid})` : "stopped"}${svc.gatewayReachable ? ", gateway healthy" : ""}`);

  const ts = tailscale.tailscaleStatus();
  if (ts.ok) {
    const self = ts.json?.Self;
    console.log(`tailscale   : ${ts.json?.BackendState ?? "unknown"} — ${self?.DNSName ?? "?"} ${(self?.TailscaleIPs ?? []).join(", ")}`);
    for (const peer of Object.values(ts.json?.Peer ?? {})) {
      console.log(`  peer      : ${peer.DNSName ?? "?"} ${(peer.TailscaleIPs ?? []).join(", ")} ${peer.Online ? "online" : "offline"}`);
    }
  } else {
    console.log(`tailscale   : ${ts.error ?? "not available"}`);
  }

  if (config.mode === "relay") {
    console.log(`relay       : ${config.relay?.url ?? "(not configured)"} as ${config.relay?.instanceId ?? "?"}`);
  }

  const list = devices.listDevices();
  const active = list.filter((d) => !d.revoked);
  console.log(`devices     : ${active.length} active, ${list.length - active.length} revoked`);
  for (const d of active) console.log(`  device    : ${d.name} (${d.id}) last seen ${d.lastSeenAt ? new Date(d.lastSeenAt).toISOString() : "never"}`);

  let url = "";
  try {
    url = await mobileUrl(config);
  } catch {
    url = "(unavailable — run dsh --profile mobile url for details)";
  }
  console.log(`web url     : ${url}`);
  return 0;
}

async function cmdService(args) {
  const [action, nRaw] = args;
  const n = nRaw === undefined ? 50 : Number.parseInt(nRaw, 10);
  const config = mustConfig();
  ensureMobileDirs();
  const logPath = join(logsDir(), "service.log");

  switch (action) {
    case "start": {
      const authorities = await computeAuthorities(config);
      const result = service.startService({ config, authorities, logPath });
      if (!result.started) {
        console.log(result.alreadyRunning ? `service already running (pid ${result.pid})` : `service failed to start: ${result.error ?? "unknown error"}`);
        return result.alreadyRunning ? 0 : 1;
      }
      console.log(`service started (pid ${result.pid})`);
      console.log(`  logs : ${logPath}`);
      console.log(`  web  : ${await mobileUrl(config)}`);
      console.log("pair your phone: dsh --profile mobile device pair --name <name>");
      return 0;
    }
    case "stop": {
      const result = service.stopService({ config });
      if (result.error) {
        console.error(`refusing to stop: ${result.error}`);
        return 1;
      }
      console.log(result.stopped ? `service stopped (was pid ${result.pid})` : "service was not running");
      return 0;
    }
    case "restart": {
      const stopped = service.stopService({ config });
      if (stopped.error) {
        console.error(`refusing to restart: ${stopped.error}`);
        return 1;
      }
      const authorities = await computeAuthorities(config);
      const started = service.startService({ config, authorities, logPath });
      console.log(`service restarted (pid ${started.pid})`);
      return 0;
    }
    case "status": {
      const s = service.serviceStatus({ config });
      console.log(s.running ? `running (pid ${s.pid}, started ${s.startedAt ? new Date(s.startedAt).toISOString() : "?"})` : "stopped");
      if (s.running) console.log(`gateway: ${s.gatewayReachable ? "healthy" : "not responding"}`);
      return s.running ? 0 : 1;
    }
    case "logs": {
      for (const line of service.serviceLogs({ logPath, tail: Number.isFinite(n) ? n : 50 })) console.log(line);
      return 0;
    }
    default:
      fail(`unknown action ${JSON.stringify(action)} — use start | stop | restart | status | logs [n]`);
  }
}

async function cmdTailscale(args) {
  const [action, host] = args;
  switch (action) {
    case "status": {
      const status = tailscale.tailscaleStatus();
      if (!status.ok) fail(status.error ?? "tailscale status failed");
      console.log(`backend: ${status.json?.BackendState}`);
      const self = status.json?.Self;
      console.log(`self   : ${self?.DNSName ?? "?"} (${(self?.TailscaleIPs ?? []).join(", ")})`);
      for (const peer of Object.values(status.json?.Peer ?? {})) {
        console.log(`peer   : ${peer.DNSName ?? "?"} ${(peer.TailscaleIPs ?? []).join(", ")} ${peer.Online ? "online" : "offline"}`);
      }
      return 0;
    }
    case "ip": {
      const ip = tailscale.tailscaleIp4();
      if (!ip) fail("no tailscale IPv4 — is tailscale up?");
      console.log(ip);
      return 0;
    }
    case "connect": {
      const result = tailscale.tailscaleUp();
      if (!result.ok) fail(result.error ?? `tailscale up failed: ${result.stderr ?? ""}`.trim());
      console.log(result.stdout ?? "tailscale up OK");
      const ip = tailscale.tailscaleIp4();
      console.log(ip ? `tailnet ip: ${ip}` : "up, but no IPv4 yet");
      return 0;
    }
    case "ping": {
      if (!host) fail("ping needs a host: dsh --profile mobile tailscale ping <host>");
      const result = tailscale.tailscalePing(host);
      console.log(result.stdout ?? "");
      return result.ok ? 0 : 1;
    }
    default:
      fail(`unknown action ${JSON.stringify(action)} — use status | ip | connect | ping [host]`);
  }
}

async function cmdRelay(args, options) {
  const [action, relayUrl] = args;
  const config = mustConfig();
  switch (action) {
    case "connect": {
      if (!relayUrl) fail("connect needs the relay URL: dsh --profile mobile relay connect wss://relay.example.com --token <t>");
      if (!options.token) fail("connect needs --token <instance-token> (issued by the relay owner)");
      const normalized = relayUrl.replace(/^wss?:\/\//, "https://").replace(/\/+$/, "");
      config.mode = "relay";
      config.relay = {
        url: normalized,
        instanceToken: options.token,
        instanceId: options.id ?? "",
        displayName: options.name ?? "",
      };
      saveConfig(config);
      console.log(`relay configured: ${normalized}`);
      console.log("apply it: dsh --profile mobile service restart");
      return 0;
    }
    case "disconnect": {
      config.mode = "tailscale";
      saveConfig(config);
      console.log("switched back to tailscale mode; run: dsh --profile mobile service restart");
      return 0;
    }
    case "status": {
      const health = await relayHealth(config);
      console.log(`relay    : ${config.relay?.url ?? "(not configured)"}`);
      if (config.relay?.url) console.log(`reachable: ${health.reachable ? `yes (${health.detail})` : "no"}`);
      const tunnel = await relayTunnelState();
      if (tunnel !== null) {
        console.log(`tunnel   : ${tunnel.connected ? `connected (since ${tunnel.since})` : `down (${tunnel.lastError ?? "?"})`}`);
      } else {
        console.log("tunnel   : no state file (start the service first)");
      }
      return 0;
    }
    case "ping": {
      const health = await relayHealth(config);
      console.log(health.reachable ? health.detail : `unreachable: ${health.detail}`);
      return health.reachable ? 0 : 1;
    }
    default:
      fail(`unknown action ${JSON.stringify(action)} — use connect <url> | disconnect | status | ping`);
  }
}

async function relayHealth(config) {
  const url = config.relay?.url;
  if (!url) return { reachable: false, detail: "relay not configured" };
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(`${url}/relay/health`, { signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) return { reachable: false, detail: `http ${response.status}` };
    const body = await response.json();
    return { reachable: true, detail: `ok, ${body.instances ?? "?"} instances` };
  } catch (error) {
    return { reachable: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

async function relayTunnelState() {
  return readRelayStatus();
}

async function cmdDevice(args, options) {
  const [action, id] = args;
  const config = mustConfig();
  switch (action) {
    case "pair": {
      if (!options.name) fail("pair needs --name <device-name>");
      const pending = devices.issuePairing({ name: options.name });
      const access = await mobileUrl(config);
      console.log(`pairing request for "${options.name}" (expires in 5 minutes):`);
      console.log(`  open on the phone : ${pairingUrl({ accessUrl: access, pairingCode: pending.pairingCode })}`);
      console.log(`  or enter the code : ${pending.pairingCode}`);
      console.log("(the device token is delivered to the device itself on first exchange)");
      return 0;
    }
    case "list": {
      for (const device of devices.listDevices()) {
        const state = device.revoked ? "revoked" : "active";
        console.log(`${device.id}  ${device.name}  ${state}  created ${new Date(device.createdAt).toISOString()}  lastSeen ${device.lastSeenAt ? new Date(device.lastSeenAt).toISOString() : "never"}`);
      }
      return 0;
    }
    case "revoke": {
      if (!id) fail("revoke needs the device id: dsh --profile mobile device revoke <id>");
      const device = devices.revokeDevice(id);
      if (!device) fail(`no device with id ${JSON.stringify(id)}`);
      console.log(`revoked ${device.name} (${device.id}) — its sessions are closed`);
      return 0;
    }
    default:
      fail(`unknown action ${JSON.stringify(action)} — use pair | list | revoke <id>`);
  }
}

async function cmdUrl() {
  const config = mustConfig();
  console.log(await mobileUrl(config));
  return 0;
}

async function cmdConfig(args) {
  const [action, key, value] = args;
  switch (action) {
    case "show": {
      console.log(JSON.stringify(mustConfig(), null, 2));
      return 0;
    }
    case "get": {
      if (!key) fail("get needs a key: dsh --profile mobile config get <key>");
      const current = getConfigValue(mustConfig(), key);
      console.log(current === undefined ? "" : typeof current === "string" ? current : JSON.stringify(current));
      return 0;
    }
    case "set": {
      if (!key || value === undefined) fail("set needs key and value: dsh --profile mobile config set <key> <value>");
      const parsed = (() => {
        try {
          return JSON.parse(value);
        } catch {
          return value;
        }
      })();
      const updated = setConfigValue(mustConfig(), key, parsed);
      saveConfig(updated);
      console.log(`set ${key} = ${JSON.stringify(parsed)}`);
      return 0;
    }
    default:
      fail(`unknown action ${JSON.stringify(action)} — use show | get <key> | set <key> <value>`);
  }
}

async function cmdDoctor() {
  const config = mustConfig();
  const findings = await diagnose({ config });
  let worst = 0;
  for (const finding of findings) {
    const mark = finding.level === "error" ? "✗" : finding.level === "warn" ? "!" : "✓";
    console.log(`${mark} ${finding.check}: ${finding.detail}`);
    if (finding.level === "error") worst = 2;
    else if (finding.level === "warn" && worst < 1) worst = 1;
  }
  return worst;
}

async function cmdUpdate() {
  let code = 0;
  for (const profile of ["mobile", "web"]) {
    const result = spawnSync("dsh", ["plugin", "--profile", profile, "update"], { stdio: "inherit" });
    if (result.error) {
      console.error(`update ${profile}: ${result.error.message}`);
      code = 1;
    } else if (result.status !== 0) code = result.status ?? 1;
  }
  return code;
}

// ── dispatch ───────────────────────────────────────────────────────────────

const COMMANDS = {
  install: cmdInstall,
  uninstall: cmdUninstall,
  status: cmdStatus,
  service: cmdService,
  tailscale: cmdTailscale,
  relay: cmdRelay,
  device: cmdDevice,
  url: cmdUrl,
  config: cmdConfig,
  doctor: cmdDoctor,
  update: cmdUpdate,
};

export async function runCommand(name, args, options) {
  const handler = COMMANDS[name];
  if (handler === undefined) fail(`unknown command ${JSON.stringify(name)}`);
  return await handler(args, options);
}
