# Running Pyrodeck as a service

Pyrodeck can run without anyone logged in, start with the machine, and come back after a crash. Its weekly schedule,
email alerts and process priority need it to be running, so a server you leave unattended usually wants this.

The steps below use the standalone binary from `pnpm package:server` ([BUILDING.md](../BUILDING.md), Option 2). The
same applies to a dev checkout if you replace the binary with `node packages/server/dist/index.js`.

## What the service needs

- **The binary and `resources/` side by side.** `pyrodeck-server` (`pyrodeck-server.exe` on Windows) serves the web
  panel from the `resources/` directory next to the executable, wherever the working directory is.
- **A fixed working directory, or `PYRODECK_CONFIG_DIR`.** Pyrodeck keeps its settings, profiles, playlists and
  session secret in `./config` relative to the working directory. A service manager often starts programs in
  `C:\Windows\System32` or `/`, which is the wrong place (and `C:\Windows\System32\config` is the Windows registry
  directory). Set the working directory to the Pyrodeck directory, or set `PYRODECK_CONFIG_DIR` to an absolute path.
- **An admin password.** Set `PYRODECK_ADMIN_PASSWORD`, or set one once from a local browser before you install the
  service. Without one, Pyrodeck answers only on localhost.
- **A reverse proxy for a server on the internet.** Put nginx in front with HTTPS, keep Pyrodeck on 127.0.0.1 (its
  default address) and set `PYRODECK_TRUST_PROXY`: [behind-a-reverse-proxy.md](behind-a-reverse-proxy.md) has the
  whole setup, the firewall included. To serve browsers on a LAN directly instead, set `PYRODECK_HOST=0.0.0.0`.
- **A user account that can run the game.** Run the service as the account that owns the Descent 3 directory, not as
  root or `LocalSystem`. The game server writes into the game directory and its temp directory.
- **A place for Pyrodeck's own log.** Pyrodeck writes its log to standard output. The service manager has to capture
  it (journald on Linux, a file under NSSM). The game servers' logs are separate: they go to the Log Directory set in
  the Logs tab, next to the game executable by default. Pyrodeck gzips the closed ones and deletes its own logs older
  than 30 days or beyond 2048 MB in total (`PYRODECK_LOG_RETENTION_DAYS`, `PYRODECK_LOG_MAX_MB`; 0 turns a limit off),
  and never touches another file there.
- **Sessions end on restart.** Logins are kept in memory, so a restart of the service logs every browser out. A
  session also ends 12 hours after login and after 2 hours unused (`PYRODECK_SESSION_TTL_HOURS`,
  `PYRODECK_SESSION_IDLE_MINUTES`).

## What happens when Pyrodeck restarts

The game server is a child process of Pyrodeck. Whether it survives a Pyrodeck restart depends on the service manager:
by default systemd and NSSM stop the whole process tree, game server included. The settings below
(`KillMode=process`, `AppKillProcessTree 0`) leave the game server running instead, so an upgrade of Pyrodeck does not
drop the players. A Pyrodeck build that can re-attach to a running server then picks it up again when it comes back;
without that, the server keeps running on its own until it is stopped from the console or the system, and Pyrodeck
shows it as stopped. Choose the default if you would rather have Pyrodeck and the game stop together.

Pyrodeck keeps nothing about the schedule except the settings, so after a restart it works out the schedule again: inside
a window it starts the server if none is running; outside one it stops nothing.

## Windows: NSSM

[NSSM](https://nssm.cc) wraps an ordinary program as a Windows service. From an administrator command prompt, with
Pyrodeck in `C:\Pyrodeck`:

```cmd
nssm install Pyrodeck "C:\Pyrodeck\pyrodeck-server.exe"
nssm set Pyrodeck AppDirectory "C:\Pyrodeck"
nssm set Pyrodeck AppEnvironmentExtra PYRODECK_ADMIN_PASSWORD=change-me PYRODECK_PORT=3001
nssm set Pyrodeck AppStdout "C:\Pyrodeck\logs\pyrodeck.log"
nssm set Pyrodeck AppStderr "C:\Pyrodeck\logs\pyrodeck.log"
nssm set Pyrodeck AppRotateFiles 1
nssm set Pyrodeck AppRotateBytes 10485760
nssm set Pyrodeck AppExit Default Restart
nssm set Pyrodeck AppRestartDelay 5000
nssm set Pyrodeck ObjectName ".\d3host" "the-account-password"
nssm set Pyrodeck Start SERVICE_AUTO_START
mkdir C:\Pyrodeck\logs
nssm start Pyrodeck
```

`ObjectName` runs the service as the local account `d3host`; use the account that owns the Descent 3 directory. To
keep the game server running when the service stops or restarts, also set:

```cmd
nssm set Pyrodeck AppKillProcessTree 0
```

With the settings above, Pyrodeck answers browsers on this machine only; for browsers on other machines of the LAN,
add `PYRODECK_HOST=0.0.0.0` to `AppEnvironmentExtra`. `nssm stop Pyrodeck`, `nssm restart Pyrodeck` and
`nssm remove Pyrodeck confirm` manage it afterwards. The Windows firewall needs an inbound rule for the game's UDP
port, and for Pyrodeck's port (3001) if browsers on other machines reach it directly. The game's console port needs
one only for Connect mode from another machine, which also takes `AllowRemoteConsole=1` in the server's config; a
server Pyrodeck launches here needs neither.

## Windows: sc.exe and schtasks

`sc.exe create` registers a service, but the program it starts must speak the Windows service protocol.
`pyrodeck-server.exe` does not, so a service created with `sc.exe` pointing at it fails to start (error 1053, "did not
respond in a timely fashion"). Use `sc.exe` only with a wrapper such as NSSM or WinSW, which NSSM above already does
for you.

Without extra software, a scheduled task that runs at startup works. Put the working directory and the environment in
a small script, `C:\Pyrodeck\run-pyrodeck.cmd`:

```cmd
@echo off
cd /d C:\Pyrodeck
set PYRODECK_ADMIN_PASSWORD=change-me
set PYRODECK_PORT=3001
pyrodeck-server.exe >> C:\Pyrodeck\logs\pyrodeck.log 2>&1
```

Then, from an administrator command prompt:

```cmd
mkdir C:\Pyrodeck\logs
schtasks /Create /TN "D3 Pyrodeck" /TR "C:\Pyrodeck\run-pyrodeck.cmd" /SC ONSTART /RU d3host /RP * /RL LIMITED
schtasks /Run /TN "D3 Pyrodeck"
```

`/RP *` asks for the account's password. A scheduled task does not restart Pyrodeck if it exits; in Task Scheduler,
open the task's Settings tab and set "If the task fails, restart every 1 minute". Ending the task (`schtasks /End`)
stops only Pyrodeck, so a running game server keeps going.

A game build that opens a window of its own (the retail 1.4 executable, Piccu) may not run in a service session, which
has no desktop. The open-source engine's dedicated server runs without one. For a windowed build, use a task that runs
at logon (`/SC ONLOGON`) instead. This was not tested.

## Linux: systemd user service

A user service runs as you, without root. Put Pyrodeck in `~/pyrodeck` and create
`~/.config/systemd/user/pyrodeck.service`:

```ini
[Unit]
Description=D3 Pyrodeck
After=network-online.target

[Service]
Type=simple
WorkingDirectory=%h/pyrodeck
ExecStart=%h/pyrodeck/pyrodeck-server
Environment=PYRODECK_ADMIN_PASSWORD=change-me
Environment=PYRODECK_PORT=3001
# Behind nginx on this machine (behind-a-reverse-proxy.md): trust
# X-Forwarded-For/-Proto from that proxy alone. Pyrodeck listens on 127.0.0.1
# by default, so only the proxy reaches it. To serve a LAN directly instead,
# replace this line with PYRODECK_HOST=0.0.0.0 and open port 3001 in the firewall.
Environment=PYRODECK_TRUST_PROXY=1
# Sessions: end 12 h after login, or after 120 min without a request.
Environment=PYRODECK_SESSION_TTL_HOURS=12
Environment=PYRODECK_SESSION_IDLE_MINUTES=120
# Game-server logs: delete Pyrodeck's logs older than 30 days, then the oldest
# beyond 2048 MB in total (0 turns a limit off). These win over the Logs tab.
Environment=PYRODECK_LOG_RETENTION_DAYS=30
Environment=PYRODECK_LOG_MAX_MB=2048
Restart=on-failure
RestartSec=5
# Leave the game server running when Pyrodeck stops or restarts
# (see "What happens when Pyrodeck restarts"). Remove this line to stop it too.
KillMode=process

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now pyrodeck
loginctl enable-linger "$USER"     # run without a login session, start at boot
journalctl --user -u pyrodeck -f   # Pyrodeck's log
```

To keep the password out of the unit file, put the `PYRODECK_*` lines in `%h/pyrodeck/pyrodeck.env` (mode 600) and use
`EnvironmentFile=%h/pyrodeck/pyrodeck.env` instead. To write the log to a file as well as the journal, add
`StandardOutput=append:%h/pyrodeck/logs/pyrodeck.log` and `StandardError=inherit`.

A system service (`/etc/systemd/system/pyrodeck.service`, run as a dedicated user) works the same way; BUILDING.md has
an example. On distributions with SELinux, read the Rocky Linux notes there first.

The Process priority setting can lower the game server's priority as an ordinary user. Raising it needs
`CAP_SYS_NICE`; for a system service, `AmbientCapabilities=CAP_SYS_NICE` in the `[Service]` section grants it.
