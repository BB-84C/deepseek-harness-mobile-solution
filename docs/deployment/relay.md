# VPS relay deployment (fan-in)

Use this when you have **several dsh machines** (home PC, office box, lab
server) and want one entry point for all of them: each machine dials OUT to a
relay on a VPS you control, and any device picks the instance it wants.

```
dsh@home ──┐
dsh@work ──┼─ (outbound wss tunnels) ─► relay on VPS ─ (Caddy HTTPS) ─► phone / browser
dsh@lab  ──┘                           127.0.0.1:4097
```

## 1. VPS setup (any small VPS, Debian/Ubuntu assumed)

```sh
# Node.js ≥ 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs caddy

# relay data dir + system user
sudo mkdir -p /var/lib/dsh-relay
sudo useradd --system --home /var/lib/dsh-relay dsh-relay
sudo chown -R dsh-relay:dsh-relay /var/lib/dsh-relay
```

Copy the relay onto the VPS (checkout of this repo, or scp
`packages/dsh-relay/`), then:

```sh
sudo -u dsh-relay node packages/dsh-relay/bin/relay.js \
  --port 4097 --data-dir /var/lib/dsh-relay
# prints the ONE-TIME owner bootstrap token — save it
```

Install the systemd unit `scripts/autostart/dsh-relay.service` (edit paths),
`systemctl enable --now dsh-relay`. The relay listens on **127.0.0.1 only** —
never expose it directly.

### Caddy (TLS termination)

`/etc/caddy/Caddyfile`:

```caddyfile
relay.example.com {
    reverse_proxy 127.0.0.1:4097
}
```

(`systemctl reload caddy`). TLS is automatic via Let's Encrypt; the upgrade
request carrying the instance token therefore travels over HTTPS.

## 2. One-time owner setup

Open `https://relay.example.com/relay/`, POST your bootstrap token (the
dashboard has the form, or `curl -X POST /relay/api/setup -d
'{"bootstrapToken":"..."}'`). The bootstrap token is consumed on first use.

As owner (dashboard → Tokens) create:

1. one **instance** token per dsh machine,
2. one **client** token for the mobile app (guards the instance directory).

All tokens are stored as SHA-256 hashes; raw values are shown exactly once.

## 3. Connect each dsh machine

```sh
dsh --profile mobile relay connect https://relay.example.com --token <instance-token>
dsh --profile mobile relay start          # sets relay transport + starts the resident instance
dsh --profile mobile relay status         # tunnel: connected since ...
```

Each machine registers as an instance (id = machine hostname by default,
override with `--id`). The tunnel is outbound only — no ports to open on the
machines.

## 4. Use it

- **Browser:** open the deep link printed by
  `dsh --profile mobile url` — `https://relay.example.com/instance/<id>/` —
  and pair on the gateway login page.
- **App:** the app lists instances from `/relay/api/targets` (with the client
  token) and connects to `/relay/instance/<id>/...`. Device authentication
  happens on the instance gateway, per instance; the relay is transport only.

## 5. Operations

| Task | How |
| --- | --- |
| Health | `curl https://relay.example.com/relay/health` → `{ok, uptime, instances}` |
| List instances | dashboard, or `GET /relay/api/targets` with Bearer client token |
| Revoke an instance token | dashboard → revoke → its tunnel and in-flight requests drop immediately (502) |
| Revoke a client token | dashboard → revoke → directory access ends |
| Relay logs | `journalctl -u dsh-relay` |

## 6. Security notes

- TLS terminates at Caddy; the relay itself speaks plain HTTP on loopback.
- Consider hiding upgrade query strings from Caddy access logs (they carry the
  instance token once at registration).
- The relay never sees device credentials: it forwards `Authorization` and the
  gateway cookies verbatim, so tokens are only verified against the instance
  they belong to.
- Keep `tokens.json` (`/var/lib/dsh-relay/tokens.json`) readable only by the
  relay user; it contains hashes, not raw tokens.

## 7. Connectivity probe (no dsh instance required)

`scripts/relay-probe.mjs` opens a REAL tunnel from any machine to the relay and
round-trips one request through the public deep-link path — useful before
committing the resident service:

```sh
node scripts/relay-probe.mjs --relay https://dsh.bb84.ai --instance-token <instance-token>
# optional: --client-token <token> to also verify the directory API
```

Expect `PROBE_OK`: tunnel connected, deep-link 200 with `x-relay-instance`,
unknown instance 404.

## 8. Owner-token recovery

The bootstrap token is consumed by the first `/relay/api/setup`. To regain an
owner session later (new client tokens, dashboard, passkey registration):

1. On the VPS: put a fresh 64-hex token into
   `/etc/bb84-vps/dsh-relay.env` (`DSH_RELAY_BOOTSTRAP_TOKEN=...`) and
   `sudo systemctl restart dsh-relay`.
2. Open `https://dsh.bb84.ai/relay/`, submit the new bootstrap, and register a
   **passkey** — from then on the passkey alone reopens the owner session.
