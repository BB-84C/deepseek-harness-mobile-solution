# @bb-84c/dsh-relay

The VPS relay for the **deepseek-harness mobile solution**. Many local dsh
instances on different machines dial **outbound** to one relay over a WebSocket
tunnel; clients (browser / mobile app) pick an instance and talk to it through
the relay. No instance needs an inbound port.

- **Zero runtime dependencies** — the RFC 6455 WebSocket server and a minimal
  client are implemented by hand in this package.
- **Node >= 22**, plain ESM.
- Listens on `127.0.0.1` only; TLS is terminated in front by Caddy (or another
  reverse proxy).

## Run

```sh
node bin/relay.js --port 4097 --host 127.0.0.1 --data-dir ./data
# or, once installed:
dsh-relay --port 4097 --host 127.0.0.1 --data-dir ./data
```

Options:

| Flag | Default | Meaning |
| --- | --- | --- |
| `--port` | `4097` | Listen port. |
| `--host` | `127.0.0.1` | Listen host. |
| `--data-dir` | `./data` | Where `tokens.json` and `passkeys.json` are stored. |
| `--bootstrap-token <hex>` | *(generated)* | Owner bootstrap secret (64 hex chars). If no active one exists it is created and printed **once**. |
| `--origin <url>` | *(derived)* | Public origin for WebAuthn (e.g. `https://relay.example.com`). |
| `--rp-name <name>` | `dsh-relay` | WebAuthn relying-party display name. |
| `--rp-id <domain>` | *(derived)* | WebAuthn relying-party id (effective domain). |

On first start the relay prints a one-time **owner bootstrap token**. Open the
dashboard (`GET /relay/`) and submit it to `POST /relay/api/setup` (the
dashboard does this for you) to create the owner session cookie.

## Environment

Configuration is via CLI flags (above) or environment variables; a CLI flag
wins over its env var, which wins over the default.

| Flag | Env var | Default |
| --- | --- | --- |
| `--port` | `DSH_RELAY_PORT` | `4097` |
| `--host` | `DSH_RELAY_HOST` | `127.0.0.1` |
| `--data-dir` | `DSH_RELAY_DATA_DIR` | `./data` |
| `--bootstrap-token` | `DSH_RELAY_BOOTSTRAP_TOKEN` | *(generated)* |
| `--origin` | `DSH_RELAY_ORIGIN` | *(derived)* |
| `--rp-name` | `DSH_RELAY_RP_NAME` | `dsh-relay` |
| `--rp-id` | `DSH_RELAY_RP_ID` | *(derived)* |

Secrets are stored only as SHA-256 hashes in `<data-dir>/tokens.json`. Passkey
credentials store only public keys in `<data-dir>/passkeys.json`.

## API surface (summary)

Full wire contract: `docs/research/relay-protocol.md`.

| Endpoint | Auth | Purpose |
| --- | --- | --- |
| `GET /relay/health` | — | Liveness: `{ok, uptime, instances}`. |
| `GET /relay/` | — | Owner dashboard (plain HTML/JS). |
| `GET /relay/instance-tunnel?...` (Upgrade) | instance token | dsh instance outbound WebSocket tunnel. |
| `GET /relay/api/targets` | client token \| owner cookie | `[{id,name,online,lastSeenMs}]`. |
| `ALL /relay/instance/<id>/<path...>` | — (the instance gateway authenticates) | Forward over the instance tunnel; `Authorization` passes through verbatim. |
| `POST /relay/api/setup` | bootstrap token | One-time owner session (HttpOnly cookie). |
| `GET /relay/api/tokens` | owner cookie | List tokens (hash prefixes only). |
| `POST /relay/api/tokens` | owner cookie | Create a client/instance token (`{label, kind}`). |
| `DELETE /relay/api/tokens/<hashPrefix>` | owner cookie | Revoke a token + drop its live sockets/requests. |
| `POST /relay/api/logout` | — | Clear the owner session cookie. |
| `POST /relay/api/passkey/register-options` | owner cookie | Start passkey registration (`{challenge, rp, user}`). |
| `POST /relay/api/passkey/register-verify` | owner cookie | Verify + store the credential public key. |
| `POST /relay/api/passkey/login-options` | — | Get a login `{challenge}`. |
| `POST /relay/api/passkey/login-verify` | — | Verify the assertion and create the owner session. |

Client token (`Authorization: Bearer <token>`) guards the directory only; the
proxy path is transport-only — device credentials travel through the relay and
are verified by the instance-side gateway. Owner: `dsh_relay_owner` HttpOnly
cookie.

## Test

```sh
node --test
# or: npm test
```

Runs fully offline (no `npm install` needed).
