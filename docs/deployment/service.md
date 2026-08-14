# The resident service

`dsh --profile mobile service ...` manages a **detached, resident dsh web
instance** on the machine that owns the dsh setup. This instance is the same
official dsh web you use locally, plus the mobile gateway that exposes it to
your devices.

## Lifecycle

```sh
dsh --profile mobile service start      # start (refuses if already running)
dsh --profile mobile service stop       # stop (NEVER kills non-mobile dsh)
dsh --profile mobile service restart    # stop + start
dsh --profile mobile service status     # running? pid? gateway healthy?
dsh --profile mobile service logs       # last 50 lines; logs [n] for n lines
```

- The service spawns `dsh --profile web --port <webPort> --trusted-host ...`
  with env `DSH_MOBILE_INSTANCE=1` and a fresh per-start token.
- State: pidfile `$DSH_HOME/mobile/pid.json`, logs
  `$DSH_HOME/mobile/logs/service.log`, per-instance sidecar
  `$DSH_HOME/mobile/instances/<pid>.json`.
- **Kill safety (by design):** `stop`/`restart` only kill a process whose pid,
  start token, and sidecar all match the pidfile. Anything else — including a
  plain `dsh web` you started yourself — is refused loudly. This is the red
  line; do not bypass it.
- `webPort` defaults to 3080 (the official default). If something else already
  occupies it, change it: `dsh --profile mobile config set webPort 3090`.

## Environment & API keys

The resident instance **inherits the launching shell's full environment** —
this is the credential path, and it is deliberate: the phone is only a
frontend, the key never travels to it.

- Machine- or user-level environment variables (`DEEPSEEK_API_KEY`) are
  inherited automatically by any shell, so `service start` from your normal
  PowerShell/zsh/bash terminal passes the key straight through.
- If you start the service from a stripped-down shell (CI, a sandbox, a
  remote session with a sanitized environment), the instance will report
  "no api key configured" on the phone. `service start` prints a warning when
  it detects that; fix it by restarting from a shell that has the key.
- `.env` files also work: dsh's own layered env loads
  `<invoking-directory>/.env` then `$DSH_HOME/.env` at launch.

## One instance, one registry — the attach mode

dsh persists sessions as **single-writer logs**. Two dsh web processes on the
same machine keep separate session registries, and resuming a session that
another live process is writing races its writer — the failure mode looks
like `corrupt session log: seq gap in committed region`. The fix is the
one-instance principle: **the phone must reach the instance that owns the
sessions.**

If you already run a primary dsh web (your daily driver), attach the gateway
to IT instead of running a second instance:

```sh
dsh --profile mobile attach        # prints the exact env/flags for your launch
```

That is: stop the separate resident service, then launch your primary dsh web
with `DSH_MOBILE_INSTANCE=1` (activates the in-profile gateway) and the
printed `--trusted-host` flags. The phone then live-streams every session of
that instance — including ones that are running right now.

The resident-service model (`service start`) remains the right choice when the
machine has NO other dsh web: the resident instance is then the single owner
of all sessions and the phone streams them live from the first prompt.

## Start on login (optional)

The service itself is process-detached (survives the launching shell); the
templates below additionally start it at login. Pick the one for your OS, fill
in the placeholder paths, and install it.

### Windows — Task Scheduler

Import `scripts/autostart/dsh-mobile-task.xml` (edit the `dsh` path inside),
or create a task manually: trigger *At log on*, action *Start a program* →
`dsh`, arguments `--profile mobile service start`.

```powershell
schtasks /Create /TN "dsh-mobile" /XML scripts\autostart\dsh-mobile-task.xml
```

### macOS — launchd

```sh
mkdir -p ~/Library/LaunchAgents
cp scripts/autostart/com.bb84c.dsh-mobile.plist ~/Library/LaunchAgents/
# edit the plist to use your dsh path, then:
launchctl load ~/Library/LaunchAgents/com.bb84c.dsh-mobile.plist
```

### Linux — systemd (user unit)

```sh
mkdir -p ~/.config/systemd/user
cp scripts/autostart/dsh-mobile.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now dsh-mobile.service
```

## Ports

| Port | Role | Bound to |
| --- | --- | --- |
| `webPort` (3080) | official dsh web | 127.0.0.1 only (unchanged, by dsh's design) |
| `gatewayPort` (3081) | mobile gateway | tailscale IP or 0.0.0.0 (tailscale mode) / 127.0.0.1 (relay mode) |

The gateway proxies to the web port on loopback; the official web never
leaves loopback.
