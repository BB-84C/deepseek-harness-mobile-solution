# `dsh --profile mobile` — command reference

The whole mobile solution lives behind one entry point. Every command runs on
the **host**; the phone is only a frontend.

## The family at a glance

| Command | What it does |
| --- | --- |
| `install` | Install/repair the plugins into the `mobile` + `web` profiles (idempotent) |
| `uninstall` | Remove the plugins from both profiles (keeps your data) |
| `service start\|stop\|restart\|status\|logs [n]` | Manage the machine's single dsh web (detached, kill-safe, one-instance guard) |
| `tailscale status\|ip\|connect\|ping [host]` | Tailscale transport: state, address, up, reachability |
| `tailscale serve status\|on\|off` | HTTPS on your MagicDNS name (Let's Encrypt cert via Tailscale) |
| `relay connect <url> --token <t> [--id] [--name]` | Register this machine with your VPS relay (fan-in) |
| `relay disconnect\|status\|ping` | Leave / inspect / probe the relay connection |
| `device pair --name <n>\|list\|revoke <id>` | One-time pairing codes, device directory, instant revocation |
| `url` | Print the URL for the phone (https MagicDNS when serve is on) |
| `config show\|get <key>\|set <key> <value>` | Read/write `$DSH_HOME/mobile/config.json` |
| `doctor` | Diagnostics: versions, ports, tailscale, relay, LLM credentials |
| `status` | One-page overview: service, tailscale, relay, devices, URL |
| `update` | Upgrade the plugin packages in both profiles |

## Ports (you never configure these by hand)

| Port | Role | Notes |
| --- | --- | --- |
| `3080` | official dsh web, loopback only | the standard dsh web port; the resident instance binds it by default |
| `3081` | mobile gateway (device auth + proxy) | binds the tailnet address; `tailscale serve` forwards 443 → 127.0.0.1:3081, so the phone sees only `https://<your-node>.ts.net/` |
| `443` (tailnet) | HTTPS entry via `tailscale serve` | certificate issued and renewed by Tailscale |

`config set webPort/gatewayPort` changes the first two if you ever need it.

## Lifecycle: after a reboot

- **tailscaled** runs as a system service and reconnects on its own;
  `tailscale serve` was enabled with `--bg`, so the 443 → gateway mapping
  restores itself.
- **The resident instance** starts automatically at logon if you installed an
  auto-start template once (`scripts/autostart/` — Task Scheduler / launchd /
  systemd user unit; see `docs/deployment/service.md`). Otherwise, after boot
  you run exactly one command: `dsh --profile mobile service start`.
- **The API key** needs nothing from you: the launcher inherits your shell
  environment, and on Windows it additionally reads the machine/user registry
  scopes (`DEEPSEEK_API_KEY`), so a stale shell snapshot cannot strip it.
- **The phone** keeps its session cookie for 30 days and the cookie survives
  service restarts (persisted store). After boot, just open
  `https://<your-node>.ts.net/` — no re-pairing.
- **Sessions** are on disk under `$DSH_HOME/sessions`; the resident instance
  lists and validates every persisted session at boot
  (`[mobile-session-hydrate]` line in `service logs`).

## One-instance principle

dsh session logs are single-writer. Never run two dsh web processes against
the same `$DSH_HOME` and resume the same sessions from both — that races the
writer and corrupts logs (`seq gap in committed region`). There is exactly one
command to know:

- **`service start`** makes the machine's single dsh web. If the configured
  port (default 3080) is free, the resident instance starts there — local
  usage is unchanged (`http://127.0.0.1:3080/`) and the phone live-streams
  every session, past and running, from that one instance.
- If the port is occupied by a process that is NOT the tracked resident
  instance (your old dsh web), `service start` **refuses with exact
  instructions**: stop that instance, re-run the same command. Nothing is
  touched; nothing is lost (sessions live on disk under `$DSH_HOME/sessions`).

## Multi-machine (relay fan-in)

Each machine gets its own instance token from the relay owner
(`docs/deployment/relay.md`), runs `relay connect`, and appears in the relay
directory as `<instance-id>`. The phone picks an instance and talks to it
through the relay — device auth still happens on each machine's gateway.

## Security model (one line per promise)

- The official dsh web never leaves loopback; the gateway is the only
  network-facing surface.
- Device tokens and session ids are stored as SHA-256 hashes only;
  revocation tears down live streams immediately.
- Tailscale mode = WireGuard end-to-end (+ optional HTTPS via serve);
  relay mode = HTTPS through Caddy on your VPS; the relay forwards
  credentials verbatim to the machine that verifies them.
