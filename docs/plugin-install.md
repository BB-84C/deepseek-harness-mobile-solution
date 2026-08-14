# Installing the dsh mobile plugins

The mobile solution ships as **dsh plugins** — plain npm packages that declare
`dsh.bundle.patch`, installed into two profiles with dsh's own profile
mechanism. Nothing patches your dsh installation.

| Package | Profile | What it provides |
| --- | --- | --- |
| `@bb-84c/dsh-mobile-cli` | `mobile` | the `dsh --profile mobile` control plane (service / tailscale / relay / device / config / doctor) |
| `@bb-84c/dsh-mobile-server` | `web` | the device-authenticated gateway in front of the official dsh web, plus the relay tunnel client |

## Prerequisites

- Node.js ≥ 22 and a working `dsh` (the DeepSeek Harness CLI) on `PATH`.
- The checkout of this repository (private phase) — after the packages are
  published to npm, the registry flow below replaces the checkout flow.

## Install (checkout flow)

```sh
git clone https://github.com/BB-84C/deepseek-harness-mobile-solution.git
cd deepseek-harness-mobile-solution

# 1. install the repo workspace dependencies (commander, dsh-cmdline) —
#    the profile links resolve these by walking up from packages/
pnpm install

# 2. install the plugins into both profiles (idempotent, safe to re-run)
node scripts/install-mobile.mjs
#   PowerShell:  powershell -ExecutionPolicy Bypass -File scripts\install-mobile.ps1
#   macOS/Linux: bash scripts/install-mobile.sh

# 3. verify
dsh --profile mobile doctor
```

The installer creates the `mobile` profile if needed (bundles:
`@deepseek-ai/dsh-base` + the CLI plugin), appends the gateway plugin to the
existing `web` profile, and links the packages into each profile's
`node_modules`.

> **Windows note (why no `dsh plugin add` here):** pnpm 10.x mis-parses
> absolute Windows paths in `link:`/`file:` specs (the drive letter is treated
> as a URL host, producing dangling junctions). The installer uses the
> verified junction pattern instead: a `vendor-packages` junction inside each
> profile pointing at this repo's `packages/`, manifest entries written as
> relative `link:` specs through that junction, and direct `node_modules`
> links for dsh's bundle resolver. Re-running the installer is always safe.

## Install (registry flow, once published)

```sh
dsh plugin --profile mobile add @bb-84c/dsh-mobile-cli
dsh plugin --profile web    add @bb-84c/dsh-mobile-server
```

The official `dsh plugin` manager installs the packages and reconciles them
into each profile's `dsh.profile.bundles` automatically.

## Update

Checkout flow: `git pull && pnpm install && node scripts/install-mobile.mjs`
(the installer is idempotent and re-links in place).
Registry flow: `dsh --profile mobile update` (updates both profiles).

## Uninstall

```sh
node scripts/install-mobile.mjs --uninstall
```

Removes the plugin entries from both profiles. Your data
(`$DSH_HOME/mobile/` — config, paired devices, logs) is kept; delete that
directory manually if you want a full wipe.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `dsh: profile "mobile" does not exist` | run the installer, or `dsh plugin --profile mobile add <package>` once |
| `cannot resolve profile bundle @bb-84c/dsh-mobile-cli` | the `node_modules` link is missing — re-run `node scripts/install-mobile.mjs` |
| `service failed to start: spawned process has no pid` | you are on Windows and running an old version — update the checkout (the launcher now spawns the real dsh JS entry with node) |
| gateway not responding after `service start` | see `dsh --profile mobile service logs`; the gateway needs the `web` profile to carry the server plugin |
