# deepseek-harness-mobile-solution

> Remotely control a locally resident [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) instance from any of your devices — phone, tablet, or another computer — with the official dsh Web UI/UX, unchanged.

Your `dsh` keeps running on your home/office machine. This project adds a mobile control plane as **dsh plugins** (no fork, no patched binaries) and gives you two ways to reach it:

- **Tailscale (point-to-point)** — both machines join your private tailnet; the phone reaches the dsh Web UI over an encrypted WireGuard path. Nothing is exposed to the public internet.
- **VPS relay (fan-in)** — many `dsh` instances (home PC, office PC, lab box) register with one relay on a VPS you control; any device picks the instance it wants from a directory and talks to it through the relay.

Both transports land on the same surface: the **official dsh Web GUI** served through an authenticating mobile gateway, plus a **native mobile app (Android/iOS)** whose specs live in [`docs/specs/`](docs/specs/).

> **Status:** early development. The repository is currently private; it is kept publish-ready so it can be opened later without a rewrite.

## How it works

```
 phone / browser / another PC
        │
        │  (1) tailscale point-to-point
        │      https://woody.tailXXXX.ts.net:3081 ───────────────┐
        │                                                        ▼
        │                 dsh mobile gateway (device auth)  ──►  dsh web 127.0.0.1:3080
        │                                                        ▲
        │  (2) VPS relay fan-in                                  │
        └── https://relay.example.com/instance/<id>/ ──► relay ──┘   (per-instance tunnel)
```

- The official dsh web process stays bound to `127.0.0.1` exactly as shipped (dsh deliberately refuses to bind `0.0.0.0`).
- A plugin-provided **mobile gateway** sits in front of it: it authenticates devices, then reverse-proxies the real dsh Web UI — same UI, same UX.
- Device credentials are stored **hashed** and can be revoked instantly.

## Repositories & entry point

Everything dsh-side ships as **dsh plugins** — npm packages declaring `dsh.bundle.patch`, installed with the stock plugin manager:

```
dsh plugin --profile mobile add @bb-84c/dsh-mobile-cli      # the `dsh mobile` command family
dsh plugin --profile web    add @bb-84c/dsh-mobile-server   # gateway + tailscale/relay transports
```

All mobile functionality is behind one unified entry point — a `mobile` profile installed with the stock plugin manager:

```
dsh --profile mobile [options] [args]
```

No wrapper, no PATH tricks, no patched launcher: `--profile` is the stock entry mechanism and every dsh-side feature ships as a plugin. See [`docs/plugin-install.md`](docs/plugin-install.md).

## Quickstart

```sh
# 1. install the plugins (creates the `mobile` profile, one command)
dsh --profile mobile install

# 2. choose a transport
dsh --profile mobile tailscale status             # tailscale point-to-point
dsh --profile mobile relay connect --relay wss://relay.example.com --token <instance-token>

# 3. bring the resident service online
dsh --profile mobile service start

# 4. pair your phone
dsh --profile mobile device pair --name iPhone    # prints a pairing URL/QR
dsh --profile mobile url                          # open the remote dsh Web UI
```

## Documentation

| Doc | Audience | Content |
| --- | --- | --- |
| [`docs/plan.md`](docs/plan.md) | project | architecture, milestones, decisions (Chinese) |
| [`docs/plugin-install.md`](docs/plugin-install.md) | users | plugin installation & upgrade |
| [`docs/deployment/tailscale.md`](docs/deployment/tailscale.md) | users | tailscale setup guide |
| [`docs/deployment/relay.md`](docs/deployment/relay.md) | users | VPS relay deployment guide |
| [`docs/deployment/service.md`](docs/deployment/service.md) | users | resident service & auto-start (Win/macOS/Linux) |
| [`docs/specs/mobile-web.md`](docs/specs/mobile-web.md) | app implementors | remote web client spec |
| [`docs/specs/mobile-app.md`](docs/specs/mobile-app.md) | app implementors | Android/iOS app spec |
| [`docs/research/`](docs/research/) | project | architecture research notes |

## Security model

- dsh's web server never leaves loopback; the gateway is the only network-facing surface.
- Tailscale mode rides WireGuard end-to-end; relay mode is HTTPS (deploy behind Caddy/Let's Encrypt per the guide).
- Devices authenticate with one-time pairing codes; long-lived device tokens are stored as SHA-256 hashes; revocation closes live sessions.
- The relay stores only token hashes and a minimal target directory (instance id + display name).

## Requirements

- A machine running DeepSeek Harness (`dsh`) that stays online.
- Node.js ≥ 22, pnpm (used by dsh's own plugin manager).
- Tailscale (for point-to-point mode) **or** a small VPS (for relay mode).

## License

MIT — see [LICENSE](LICENSE).

*This project is an independent community effort. It is not affiliated with DeepSeek; "DeepSeek Harness" and "dsh" refer to [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness). The architecture is informed by [opencode-mobile-solution](https://github.com/BB-84C/opencode-mobile-solution); no code or UI is reused from it.*
