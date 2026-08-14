# Tailscale point-to-point deployment

This is the simplest mode: your dsh machine and your phone (or any device)
join the same private tailnet. The phone reaches the gateway over WireGuard —
end-to-end encrypted, nothing exposed to the public internet.

## 1. Install Tailscale

- **Windows:** download from <https://tailscale.com/download>, install, log in.
- **macOS:** App Store ("Tailscale") or `brew install --cask tailscale`.
- **Linux:** `curl -fsSL https://tailscale.com/install.sh | sh`.

Bring the machine onto the tailnet:

```sh
tailscale up
```

Follow the browser login, then verify:

```sh
tailscale status        # your node should show, BackendState "Running"
tailscale ip -4         # e.g. 100.101.132.89
```

## 2. Point dsh at the tailnet

```sh
dsh --profile mobile tailscale connect     # same as `tailscale up`, plus a check
dsh --profile mobile tailscale status      # your node + peers, online state
dsh --profile mobile service start
dsh --profile mobile url                   # http://<your-node>.ts.net:3081/
```

`service start` passes the tailnet IP and MagicDNS hostname (with and without
the gateway port) to dsh's `--trusted-host` trust fence, so the official web
client accepts your phone's origin.

## 3. Use it from the phone

- Install Tailscale on the phone, sign in to the same tailnet.
- Open the URL printed by `dsh --profile mobile url` (or
  `http://100.101.132.89:3081/` style).
- Pair once (`dsh --profile mobile device pair --name iPhone`, or the gateway
  login page), and you get the official dsh Web UI on the phone.

## 4. Network notes

- The gateway binds your tailnet IP when known, otherwise `0.0.0.0`. With
  `0.0.0.0` your OS firewall may prompt for `node.exe` — allow it for the
  private/tailscale profile only, never the public profile.
- Transport security = WireGuard (plain HTTP inside the tailnet is
  intentional in phase 1; `tailscale serve` HTTPS is a phase-2 option).
- Optional hardening: in the Tailscale admin console, set ACLs so only your
  devices can reach port 3081 on this node.

## 5. Troubleshooting

| Symptom | Fix |
| --- | --- |
| `tailscale status` shows `BackendState=Stopped` | `tailscale up` / check the tailscaled service |
| MagicDNS hostname not resolving on the phone | enable MagicDNS in the admin console, or use the plain IP URL |
| Peer shows but page times out | firewall blocking the gateway port on the host; check bind with `dsh --profile mobile service status` |
| `dsh --profile mobile url` prints the IP but no hostname | MagicDNS off — IP URL works the same |
