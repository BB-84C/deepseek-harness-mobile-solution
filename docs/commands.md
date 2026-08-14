# `dsh --profile mobile` — command reference

The whole mobile solution lives behind one entry point. Every command runs on
the **host**; the phone is only a frontend.

## The family at a glance

| Command | What it does |
| --- | --- |
| `install` | Install/repair the plugins into the `mobile` + `web` profiles (idempotent) |
| `uninstall` | Remove the plugins from both profiles (keeps your data) |
| `tailscale start\|stop\|restart\|logs [n]` | **Run the resident dsh web over tailscale** (one command: sets the transport, guards the single-instance port 3080, starts) |
| `tailscale status\|ip\|connect\|ping [host]` | Tailscale state: tailnet view (+ service line), address, up, reachability |
| `tailscale serve on\|off\|status` | HTTPS on your MagicDNS name (Let's Encrypt cert via Tailscale) |
| `relay connect <url> --token <t> [--id] [--name]` | Register this machine with your VPS relay (fan-in) |
| `relay start\|stop\|restart\|logs [n]` | **Run the resident dsh web through the relay** (sets the transport, guards port 3080, starts the tunnel) |
| `relay disconnect\|status\|ping` | Leave / inspect / probe the relay connection |
| `service start\|stop\|restart\|status\|logs [n]` | Low-level lifecycle in the currently configured transport (auto-start templates use this) |
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

`config set gatewayPort` changes it if you ever need it. There is deliberately NO
webPort knob: the resident instance always owns 3080 (one-instance principle).

## Lifecycle: after a reboot

- **tailscaled** runs as a system service and reconnects on its own;
  `tailscale serve` was enabled with `--bg`, so the 443 → gateway mapping
  restores itself.
- **The resident instance** starts automatically at logon if you installed an
  auto-start template once (`scripts/autostart/` — Task Scheduler / launchd /
  systemd user unit; they call the low-level `service start`, which keeps the
  configured transport). Otherwise, after boot you run exactly one command:
  `dsh --profile mobile tailscale start` (or `relay start`).
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

- **`tailscale start` / `relay start`** make the machine's single dsh web in
  the chosen transport. If port 3080 is free, the resident instance starts
  there — local usage is unchanged (`http://127.0.0.1:3080/`) and the phone
  live-streams every session, past and running, from that one instance.
- If the port is occupied by a process that is NOT the tracked resident
  instance (your old dsh web), the start command **refuses with exact
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
