# Contributing

Thanks for your interest! This project keeps a strict boundary: **all dsh-side changes ship as dsh plugins** (`@bb-84c/*` packages declaring `dsh.bundle.patch`) — never patches to the shipped `@deepseek-ai/*` packages.

## Quick orientation

- `packages/` — four npm packages: two dsh plugins (`dsh-mobile-cli`, `dsh-mobile-server`), one shared library (`dsh-mobile-common`), and the standalone relay service (`dsh-relay`).
- `docs/plan.md` — authoritative architecture and decisions (Chinese).
- `docs/research/relay-protocol.md` — the wire protocol between relay and instance tunnels.
- `docs/research/upstream-touchpoints.md` — the official-dsh surfaces we depend on, and the post-upgrade checklist.

## Development

```sh
pnpm install
npm test        # 144+ offline tests across all packages
```

## Before a PR

- [ ] `npm test` is green
- [ ] New behavior has tests (the suite runs fully offline — prefer injected dependencies over network calls)
- [ ] User-facing changes are reflected in `docs/` (`plan.md` for decisions, the relevant deployment/command doc for behavior)
- [ ] No secrets, machine-specific paths, or debug artifacts in the diff

## Style

- Plain JavaScript (ESM), no TypeScript in `packages/dsh-relay` (it is zero-dependency and must run with stock Node ≥ 22).
- Remote UI work never reimplements or restyles the official dsh web UI/UX.
