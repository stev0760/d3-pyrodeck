# D3 Pyrodeck

Web-based admin panel for Descent 3 dedicated servers.

Companion project to the [Matcen fork](https://github.com/stev0760/Descent3/tree/feature/multiplayer-bots) which adds multiplayer bots to the Descent 3 open source engine.

## Current Status

**v0.5.3** — Unattended operation. **Autostart**: `PYRODECK_AUTOSTART_PROFILE=<profile name>`, or **Start when Pyrodeck starts** on one profile, launches it when Pyrodeck starts, after re-attach (a server still running is left alone), so a host that reboots for updates brings the game back by itself. A crash-loop guard stops after 5 failed starts in a row (a launch that fails, or a server that exits within 60 s) and says why in the log and the Launch panel. **The game server no longer sees Pyrodeck's environment**: it gets a short list of variables it needs (`PATH`, `HOME`, the locale, `XDG_*`, `SDL_*` and the like) and never a `PYRODECK_*` one, so the admin password and session secret stay with Pyrodeck. Releases carry a **`SHA256SUMS.txt`**; see [Releases](#releases).

**v0.5.2** — Second hardening pass before a public server. Logins are real sessions: a random id per login kept on the server, ended by logout, by **Log out all sessions** (Settings tab), by setting the password, 12 hours after login or after 2 hours unused (`PYRODECK_SESSION_TTL_HOURS`, `PYRODECK_SESSION_IDLE_MINUTES`); an open console closes the moment its session ends. Before, the cookie was the same signed constant for everyone and logout only deleted the browser's copy. **Pyrodeck now listens on 127.0.0.1 by default**: a LAN that opens it directly must set `PYRODECK_HOST=0.0.0.0`. Game-server logs can get retention, off until you set it (an upgrade deletes and compresses nothing): gzip closed logs to `.log.gz` and delete Pyrodeck's own logs past an age or a total size (`PYRODECK_LOG_RETENTION_DAYS`, `PYRODECK_LOG_MAX_MB`, `PYRODECK_LOG_COMPRESS`, or the Logs tab; 30 days, 2048 MB and compression on suit a public server), never touching any other file in the Log Directory. While it is off, Pyrodeck warns once its logs pass 1 GB. Sessions live in memory, so restarting Pyrodeck logs everyone out.

**v0.5.1** — Ready for a public server behind a reverse proxy. `PYRODECK_TRUST_PROXY=1` now trusts only a proxy on the same machine, so a client can no longer pass itself off as local by sending its own `X-Forwarded-For`, and a request that came through a proxy never counts as local (before, with `PYRODECK_TRUST_PROXY` unset, every request through nginx did, which left the API open and first-run setup claimable from the internet until a password was set). The session cookie is `Secure` over HTTPS, the login rate limit counts per real client, cross-site browser requests are refused, and a page that rebinds its DNS name to 127.0.0.1 is not local. The game's console can stay on the machine: a launched server with `AllowRemoteConsole=0` (now the default for new configs) is logged in to on 127.0.0.1. New guide: [Running Pyrodeck behind a reverse proxy](docs/behind-a-reverse-proxy.md).

**v0.5.0** — D3Server3 parity. Pyrodeck now keeps a launched server up: it relaunches a crashed server, kills and relaunches one whose console stops answering, can restart an empty server after an uptime limit, and re-attaches to its server after Pyrodeck itself restarts (closing Pyrodeck no longer stops the game). Players get a join and leave history with addresses, bans that survive a restart (the engine's `hosts.deny`, edited in a new Bans tab, plus name bans), nickname rules and a profanity monitor (Rules tab, off by default). Profiles gain launch options (`-useip`, `-useport`, `-framecap`, logos, GameSpy), team names and Hoard settings written into the Startup Commands at launch, periodic console commands, player-scaled powerup respawn, a weekly start/stop schedule and a join address with a Copy button. A Settings tab adds email alerts on server events, the game process's priority and an update notice; a profile can be imported from the `.bat`/`.sh` that launched an old server. See [Keeping a server up](#keeping-a-server-up), [Bans and join rules](#bans-and-join-rules) and [Operations](#operations).

**v0.4.20** — Matcen contract sync and rotation hardening. Parsers and the spec now match the fork's `PYRODECK_CONTRACT.md`: callsigns are `Name[BOT]`, `$addbot` takes a team and reports failures as a toast, `$botmode` names are exact, and a dead bot's `shields=-1` no longer drops it from `$botstat`. The `$servercaps` parser keeps feature flags it doesn't know (the fork is adding `teams`, `squad_orders` and `population`); the Bots tab offers a team when the server advertises `teams` and the game has teams. Mission download links: Pyrodeck can rewrite the `URL` lines inside a mission's `.mn3`, the links a server offers players who lack the mission, keeping the original for one-click restore. Every playlist restart is now health-checked (console login and `$servercaps` within 120 s); a failed restart retries once and then pauses the playlist with the reason on screen, instead of leaving a dead server behind it. Server logs are validated before launch (absolute Log Directory, the file itself created) and re-checked while the server runs, with a failure kept on screen. Profiles can carry post-start settings (HUD names, kill message filter, stat autosaves) that Pyrodeck applies after every launch.

**v0.4.19** — Release-readiness pass. The Linux release binary was silently broken (a renamed `node` that exited without starting the server); SEA packaging now uses the official, checksum-verified nodejs.org binary and both Linux and Windows artifacts are verified to run. The release workflow, which had failed on every run, is fixed (pinned pnpm, Node 24, current actions, tests before packaging) and no longer waits on code signing. Dependencies refreshed (`pnpm audit` 72 → 0, including `@fastify/static` path-traversal fixes). Synced to the Matcen 0.9.15+ spec: the `$servercaps` probe now retries in the background for ~30s so a slow level start no longer hides the Bots tab.

**v0.4.18** — UX and auth-hardening pass. Server profiles can now be edited and deleted while a server is running — previously the whole profile selector was hidden for the entire active session, so on a box that stays up you could never delete a profile. The picker marks the live profile (`● running`) and guards only its own destructive actions. Delete affordances are now consistent and discoverable across the app (profiles, saved servers, bots "Remove All") — all share one inline-confirm pattern, and the saved-server delete is no longer a hover-only control that was invisible on touch. Security: auth now fails closed for remote peers when no admin password is set (an instance exposed with no password is refused from the network instead of served wide open; localhost stays open for local dev), and route matching is boundary-aware so a route can't inherit another's auth bypass by prefix.

**v0.4.17** — Mission game-mode compatibility scanning. The server parses each `.mn3` in the game's `missions/` directory (HOG2 container → embedded `.msn` metadata) and computes which game modes it supports using a faithful TypeScript port of the engine's own mission filter (`MissionGetKeywords()`, spec Addendum A) — validated 1:1 against the fork's `mn3info.py` prototype across a 111-mission library. The Config tab's mission picker now shows a details panel (display name, level count, mode badges with team capacity like `CTF·4T`) and disables missions incompatible with the selected Game Type, with a warning when the current pairing would fail to start — ending launch-and-pray mission selection. Parsing reads only a few KB per file and results are cached by mtime+size, so full-library scans are milliseconds. Scan data rides on `GET /api/game-files/missions?details=1`; the endpoint is unchanged without the flag. The same scan validates playlists: activating a playlist whose entries don't support the profile's game type is rejected with per-entry reasons, mission rotation re-checks and skips incompatible entries instead of restarting into a server that can't start the game, and the playlist editor flags offending entries inline.

**v0.4.14** — Matcen 0.9.5 command-surface sync, console performance overhaul, and log management. The command reference gains the fork's new `$nav` namespace (toggle table, per-channel on/off, nav dump), replacing the retired flat `$terrainsteer`/`$navdump` buttons; the spec now documents the fork's command stability tiers (§5.1.1) — Pyrodeck parses only Tier 1 output and lists diagnostics as type-able text. Performance: D3 process output is coalesced server-side into ~10 WebSocket messages/sec instead of one per pipe chunk (debug builds emit hundreds of lines/sec — the per-message overhead was making the UI laggy, especially in Firefox), both consoles now use xterm's GPU-accelerated WebGL renderer (DOM-renderer fallback where WebGL is unavailable), and the log viewer fetches only the last 256 KB of a log (`?tail=1`) instead of downloading multi-hundred-MB soak logs to the browser. Logs panel gains per-file delete with confirm (the active log of a running server is protected). Trailing process output is flushed before state-change broadcasts so crash diagnostics render before the "crashed" badge.

**v0.4.13** — Auto-named per-launch logs, in-browser log viewer, tab overflow menu.

**v0.4.11** — Stop crashing dedicated servers via `$netgameinfo`. On a dedicated server the engine never flushes its 16 KB text-command buffer (no rendering), and `$netgameinfo` writes ~17 lines into it per call that are never cleared — so polling it overflows the buffer and aborts the server after ~30 calls (~10–15 min at the old 30s/60s intervals). This was an engine bug present in retail D3 1999, unfixable on unmodified servers, so the fix is entirely Pyrodeck-side: **all `$netgameinfo` polling is removed.** The client now queries once per connection (plus the manual refresh button) and derives the countdown locally; the server queries once per activation and once per mission rotation, re-anchoring mid-mission level changes from the cached time limit. The server pushes fresh `serverinfo` to clients after its queries so panels stay current without polling. (`$netgameinfo` is the lone offender — its handler calls a dual-purpose function that writes the overlay even headless. `$scores` and the other polls are verified to use console-only/`DPrintf` paths and are safe to poll.)

**v0.4.10** — Hardening and cleanup pass: config filenames are guarded against path traversal; playlist and saved-server request bodies are validated; `parseTimeLeft` handles `H:MM:SS` and color-code stripping survives TCP chunk boundaries. Network-facing defaults are safer (env-gated `trustProxy`, same-origin CORS, localhost-only first-run setup — see Security). Added an eslint flat config so `pnpm lint` runs clean.

**v0.4.9** — Timer reliability: the Time Left countdown resets on `$warp`, `$endlevel`, and mission rotations instead of running off a stale anchor, and re-syncs with the server every 30s. Launch mode broadcasts a `level_changed` signal (from D3's `Opening level` stdout) so the UI drops the old timer the instant a new level loads, and the Server panel shows the actual loaded level (e.g. `TheCore`), not just the mission file. Also fixed: playlist vote ties resolve to the first option, drift correction survives rotations/reconnects, WebSocket keep-alive pings are visible to browsers (iOS Safari reconnect works), and dead WS clients are culled.

Works with vanilla D3 1.4, the [open-source D3](https://github.com/DescentDevelopers/Descent3) engine, and the Matcen fork v0.8.4+ (protocol synced to the fork's contract as of 0.9.17; newer fork-only commands are harmless no-ops on older builds). Two operating modes:

- **Connect mode:** Remote admin — connect to any running D3 server via its TCP console (port 2092)
- **Launch mode:** Full server manager — configure, launch, and manage a local D3 dedicated server process

## Features

### Console
- Live terminal (xterm.js) with command input, history (up/down), and 5000-line scrollback
- Collapsible, resizable command reference drawer with 6 categories (Players, Teams, Server, Stats, Bots, Bot Debug) — click-to-execute for simple commands, inline inputs for parameterized commands
- D3 color codes and null bytes stripped from output

### Server Console (Launch mode)
- Separate xterm.js terminal showing D3 process stdout/stderr
- Server output auto-logged to a timestamped file per launch (see Logs)

### Logs (Launch mode)
- Each launch writes a timestamped log file (e.g. `testing-2026-06-17T22-20-31.log`) — no hand-edited paths
- Log directory is configurable; defaults to the directory containing the D3 executable
- Logs panel lists runs (newest first) with in-browser view, download, and delete (two-step confirm; the active log of a running server can't be deleted)
- The in-browser viewer fetches only the last 256 KB of large logs; Download always saves the complete file
- Retention, opt-in (Logs tab, or `PYRODECK_LOG_RETENTION_DAYS`, `PYRODECK_LOG_MAX_MB` and `PYRODECK_LOG_COMPRESS`, which win). Off by default, so Pyrodeck keeps every log as written. Once set, at startup, every hour and on save, Pyrodeck gzips closed logs (renamed to `.log.gz`, same modification time), deletes its logs last written more than the set number of days ago, then the oldest until they fit in the size cap; 0 turns a limit off. Recommended for a public server: 30 days, 2048 MB, compression on. Only files named like Pyrodeck's logs are touched, never other files in the directory (which may be the game folder), symlinks or directories; the running server's log and anything written in the last ten minutes are left alone. Each compression and deletion is logged at info level. While retention is off, Pyrodeck's log and the Logs tab warn once its logs take more than 1 GB
- Compressed logs are listed with the rest: View decompresses them, Download saves the `.log.gz`
- The Log Directory must be an absolute path; before each launch Pyrodeck creates the directory and the log file itself and refuses to start if it can't
- After launch the log is checked (about 8 s in, then every 30 s): a log that stays empty, errors, or is deleted, moved or replaced mid-run raises an error and stays flagged in the Launch panel until the next launch

### Players
- Auto-refreshing scoreboard from `$scores` (name, points, kills, deaths, suicides, ping), with each human's address when known
- Bot and observer badges
- Kick and Ban per player, each with a reason that is said in chat before the kick; Ban can also put the address in hosts.deny and the name on the name-ban list (see Bans and join rules)
- **History** view: every join and leave per server, with slot and address, searchable by name or address; "who was on" between two times; a name-to-address index

### Bots (Matcen fork only)
- Auto-detected via `$servercaps` probe — bot UI only appears when connected to a Matcen fork server
- Add bots with name, ship, and difficulty selection; a team choice appears when the server advertises `teams` and the game has teams
- A refused `$addbot` (server full) or one the server altered (unknown ship, team out of range) shows as an error toast
- Active bot list with per-bot difficulty adjustment and remove controls
- Bulk remove all bots

### Server Dashboard
- Live server info: game name, mission, current level (Launch mode), game mode, network model, time remaining
- Stepper controls for max players, PPS, time limit, and kill goal
- Quick actions: end level, warp to level, balance teams
- Quit server with confirmation dialog (Connect mode; Launch mode uses Stop Server button)

### Server Playlists (Launch mode)

- Create named playlists with ordered mission entries (label, `.mn3` filename, optional starting level)
- Three rotation modes: Sequential (in order, looping), Shuffle (Fisher-Yates, reshuffles on loop), Weighted (random draw by weight)
- Activate/deactivate from the Playlists tab or the Server sidebar widget
- On mission completion (`"Mission over."` in stdout), server automatically stops, swaps `MissionName=` in the active profile config, and restarts. Mid-mission level transitions (`"Ending level."` followed by `"Opening level"`) do not rotate
- Timer anchoring: queries `$netgameinfo` once on activation and once per mission rotation (never on a timer — it leaks the engine text buffer and crashes dedicated servers). Mid-mission level changes re-anchor from the cached time limit; the countdown ticks down locally and is visible in the sidebar
- Mission voting (requires time-limited game with no kill goal): announces options via `say`, players vote by typing a single digit in chat
- Voting language uses "mission" terminology throughout
- Game-mode validation: activation is rejected (with per-entry reasons) when a playlist entry's mission doesn't support the profile's game type; rotation re-checks each entry and skips incompatible ones instead of restarting into a broken game; the editor flags offending entries with ⚠ inline
- Restart health check: each restarted server must accept the console login and answer `$servercaps` within 120 s. A crash or timeout retries once; a second failure pauses the playlist with the reason in the sidebar and a Resume button. Rotation is still best-effort: players must reconnect after each mission change

### Config Editor (Launch mode)
- Server profile system — named configurations pointing at config files in the D3 game directory
- Tabbed editor sections: Server Config, Ship Settings, Bot Roster, Startup Commands
- **Structured form UI** (no .cfg editing required): server identity, network settings, rules, ship bans, powerup toggles, bot roster
- Starting level (SetLevel) exposed in the identity section
- **Mission mode-compatibility**: mission picker shows per-mission details (name, level count, mode badges with team capacity) parsed from each `.mn3`, disables missions that don't support the selected game type, and warns on incompatible pairings
- **Mission download link**: set the link a server offers players who join without the mission (rewrites the `URL` lines inside the server's copy of the `.mn3`; the original is kept as `<name>.mn3.pyrodeck-orig` and one click restores it; takes effect the next time the server loads the mission)
- **Mission hosting**: Pyrodeck can serve the missions itself, so the link points at this machine; see [Hosting mission downloads](#hosting-mission-downloads)
- Bot Roster: per-bot name, ship, difficulty, and team assignment (1-4 or auto-balance); roster count vs max-players warnings; default difficulty
- Ship bans and powerup allow/disallow lists written to the linked `.mps` file
- Create, link, and unlink companion files (`.mps`, `bots.cfg`, `autoexec.dmfc`)
- Startup Commands (`autoexec.dmfc` in the game directory) reach the server at launch through `-autoexec`
- Per-profile team settings and Hoard orb count (Launch panel → Edit → Teams and Hoard): allow team changes, auto balance, the four team names, orbs needed to score. Pyrodeck writes them into the Startup Commands file at each launch, between `# pyrodeck: begin` and `# pyrodeck: end`, and leaves every other line alone
- Companion file management auto-updates CVars (`BotConfig=`, `MultiSettingsFile=`) in the server config
- Raw textarea fallback always available via structured/raw toggle
- Import existing config files as new profiles

### Game Files Browser (Launch mode)
- Categorized file listing with metadata (size, last modified)
- File classification: server configs, bot rosters, ship settings, startup commands, missions, game data
- In-place text editing with save for any config file

### Connection Management
- Saved server profiles (name, host, port) with quick-select
- WebSocket auto-reconnect with exponential backoff (1s to 30s)
- Connection status banner during reconnection attempts
- Error toast notifications (auto-dismiss after 5s)

### Launch Mode
- D3 install path detection and validation
- Process lifecycle management (launch, stop, auto-connect via telnet)
- Per-profile post-start settings applied after every launch and playlist restart: server HUD names (full/team/none), kill message filter (full/simple/none), save stats at level end and on disconnect
- Per-profile periodic commands (Edit → Periodic Commands): `$` commands or `say` lines sent once when Pyrodeck's console connects to the launched server, and every N minutes while it runs (next line in order, one at random, or all of them; at most 5 per round). They stop with the server and start over on the next launch; after Pyrodeck re-attaches to a running server they carry on, without the start lines
- Per-profile powerup respawn scaling (Edit → Respawn by Players, off by default): `$setrespawntime` moves from a longest time at two human players or fewer to a shortest time at a set player count, bots not counted; sent when the console connects and after the player count settles, only when the value changes. It follows the server's player join and leave events
- Per-profile launch options (Edit → Launch Options): bind address (`-useip`, IPv4 only; with `AllowRemoteConsole=1` the console is then reached at that address), game port (`-useport`, default 2092/udp), frame cap (`-framecap`, 1-999, default 60), no pilot logos (`-nomultibmp`), GameSpy port and file (`-gamespyport`, `-gspyfile`). Saving a profile, or a server config's console port, warns when another profile uses the same game, GameSpy or console port
- Join address in the Launch panel: the `host:port` players type into the game's Direct TCP/IP screen, with a Copy button. The port is the profile's game port (2092 unless set); the host is the Join Host setting (set it right there), else the profile's bind address or the mission host's public URL
- Process status indicator (stopped, starting, running, crashed)
- Graceful shutdown sequence: `quit` command → SIGTERM → SIGKILL
- Supervisor: relaunches a crashed server, restarts a hung one, and can restart an empty server after an uptime limit (see [Keeping a server up](#keeping-a-server-up))
- Weekly schedule per profile: start and stop windows by weekday and time (see Operations)
- Autostart: one profile launched whenever Pyrodeck starts, after re-attach, with a crash-loop guard (see Operations)
- Import a profile from the `.bat`/`.sh` that launched an old server (see Operations)

### Responsive Layout
- Three breakpoints: phone (<768px), tablet (768-1024px), desktop (1024px+)
- Mobile: hamburger menu opens left sheet, server icon opens right sheet, full-screen tab content
- Tablet: compact top bar, left panel via sheet, right sidebar inline
- Desktop: full three-column layout

## Requirements

- Node.js 20+
- pnpm
- A Descent 3 installation (Launch mode) or a running D3 dedicated server (Connect mode)
- A `ConsolePassword` in the server's `dedicated.cfg`: Pyrodeck logs in to the server's console with it. Connect mode to a server on another machine also needs `AllowRemoteConsole=1` there

## Quick Start

```bash
# Install dependencies
pnpm install

# Start both frontend and backend in dev mode
pnpm dev
```

Or start them separately:

```bash
# Backend (port 3001)
cd packages/server && pnpm dev

# Frontend (port 5173, proxies API/WS to backend)
cd packages/client && pnpm dev
```

Open http://localhost:5173. On first run you'll be prompted to create an admin password. This password is hashed (scrypt) and stored in `config/pyrodeck.json`.

Alternatively, set the password via environment variable (takes precedence over config):

```bash
# Linux/macOS
PYRODECK_ADMIN_PASSWORD=yourpassword pnpm dev

# Windows PowerShell
$env:PYRODECK_ADMIN_PASSWORD="yourpassword"; pnpm dev
```

> **Note:** After `git pull`, always run `pnpm install` to pick up any new dependencies.

### Connect Mode

Enter your D3 server's host, port, and console password. A server on another machine needs this in its `dedicated.cfg`:

```
AllowRemoteConsole=1
RemoteConsolePort=2092
ConsolePassword=yourpassword
```

`AllowRemoteConsole=1` lets the console take connections from the network, in plain TCP with the password in clear, so keep its port closed in the firewall to everything but the machine Pyrodeck runs on. With `AllowRemoteConsole=0` (the engine's default) the console takes connections from its own machine only; connect to `127.0.0.1` there.

### Launch Mode

Point Pyrodeck at your D3 installation directory, select or create a server profile, and click Launch. Pyrodeck spawns the D3 process and auto-connects to it. The config needs a `ConsolePassword`; with `AllowRemoteConsole=0`, the default for configs Pyrodeck creates, Pyrodeck logs in on 127.0.0.1 and the console stays off the network. `AllowRemoteConsole=1` is needed only to connect from Pyrodeck on another machine, and Pyrodeck's log warns at each launch that the console is then reachable from the network.

## Operations

Settings that keep an unattended server running. The schedule lives in each profile; the rest are in the **Settings**
tab.

- **Weekly schedule.** Edit a profile and add windows (day, start, end, in the Pyrodeck machine's local time; an end at
  or before the start runs past midnight). At a window's start Pyrodeck launches the profile if no server is running. At
  its end it stops the server as soon as no player is on (bots don't count, Pyrodeck asks with `$players`), and after
  the wait you set at the latest; players get one warning in chat. A server you stop by hand during a window stays
  stopped until the next window. The Launch panel shows the next scheduled start or stop. Only one server runs at a
  time, so a window whose start finds another profile's server running is skipped, with a toast.
- **Email alerts.** SMTP host, port, security (STARTTLS, TLS or none), login, From, up to ten recipients, and a
  checklist: server started, stopped, crashed, hung or relaunched; player kicked or banned; profanity bans; schedule
  actions. Off by default. Events that arrive together go out in one mail, at most one mail a minute. **Send test mail**
  tries the settings on screen before you save them. The SMTP password is kept in `config/pyrodeck.json` (now
  written readable by its owner only) and never sent back to the browser.
- **Process priority.** Below normal, normal, above normal or high, applied to the game server after every launch,
  playlist restart, scheduled start and relaunch. On Linux, lowering needs no privilege and raising needs root or
  `CAP_SYS_NICE`; a refused change is a warning, and the server keeps running. On Windows these are the priority
  classes of the same names.
- **Update notice.** Pyrodeck asks GitHub once a day for the latest release and shows a banner with a link when it is
  newer. It never downloads anything. A failed check (offline, rate limit) shows nothing. Turn it off in Settings.
- **Import from a launch script.** In the Launch panel, **Import script**: paste or pick the batch file or shell script
  that ran `Descent3 -dedicated <cfg> ...`. Pyrodeck reads its flags the way the engine does (any case, `-`, `--` or
  `+`; the first one wins), shows where it found the game, program and config, and creates a profile linked to that
  config. The bind address, game and GameSpy ports, frame cap, GameSpy file and `-nomultibmp` become the profile's
  Launch Options; other flags are kept on the profile as "imported flags" for reference. The config must already be in
  the game directory.
- **Sessions.** The Settings tab lists the browsers logged in (address, browser, login and last use) and logs them all
  out with one button, this one included. Every open console of those sessions closes at once.
- **Autostart.** Edit a profile and tick **Start when Pyrodeck starts**, or set `PYRODECK_AUTOSTART_PROFILE` to the
  profile's name (it wins, and locks the box). Pyrodeck then launches that profile each time it starts, once it has
  tried to re-attach to a server that kept running: a server still running is left alone. The launch is the Launch
  button's, so an active playlist carries on from the mission its last rotation wrote into the config, and a paused
  one stays paused. One profile at a time; the change applies at the next start of Pyrodeck. The Launch panel's
  **Autostart** block shows what happened. An unknown profile name is logged as an error and starts nothing.
- **Running as a service.** [docs/running-as-a-service.md](docs/running-as-a-service.md): NSSM, `schtasks` and a
  systemd user unit, with the working directory and log location each one needs. With autostart, the machine can
  reboot for updates unattended.

## Hosting mission downloads

A player who joins a server without its mission is offered the mission's download links. Pyrodeck can host the missions itself, from the same machine, so those links work without a separate web server.

1. In the Launch panel, open **Mission Downloads**, tick **Serve missions to players who join without them**, and set:
   - **Port**: the TCP port the download listener uses (default `3002`). Forward it on your router to this machine.
   - **Public URL**: the address players reach that port at, such as `http://example.org:3002`. A dynamic-DNS name works. Pyrodeck adds `/missions/<file>`.
2. In the Config tab, pick a mission and click **Host this mission**. Pyrodeck points the mission's link at `<public URL>/missions/<file>` (the same rewrite as a typed link, so the original file is kept and **Restore original** puts it back). The server offers the new link the next time it loads the mission.
3. **Test** downloads the mission through the public URL from the Pyrodeck machine and compares it with the file on disk. That proves the listener works, not that players outside your network can reach it: check that from outside the LAN (a phone off Wi-Fi will do). Some routers cannot reach their own public address from inside, so a failed test from inside the LAN is not proof either.

The listener is separate from the admin panel: it answers only `GET`/`HEAD /missions/<file>.mn3` for missions in the game path's `missions/` directory, and every other path, the admin API included, gets a 404. It needs no login. It starts, stops and moves port as soon as you save, and the Launch panel shows whether it is listening. It serves the global game path; a profile with its own game path cannot host its missions.

Limits that come from the game client:

- **http only.** The game's HTTP client is built without TLS: current builds crash on an `https://` link and 1999-era ones refuse it.
- **86 characters at most** for the whole link (the download screen copies it into a 100-character buffer). A long host name plus a long mission file name can exceed it; Pyrodeck refuses with the length.
- **No resume.** An interrupted download starts over.
- **Retail missions are never offered** (`d3.mn3`, `d3_2.mn3`, `training.mn3`, `merc.mn3`); the server never advertises links for them.
- **1999-era clients** (retail-derived builds) accept no port in a link. To reach them as well, forward public port 80 to the listener's port and leave the port out of the public URL (`http://example.org`).
- The game window does not redraw while a download runs; it resumes when the download finishes. Pyrodeck holds each download for one second before sending, to keep clear of a divide-by-zero in the client's progress display.

## Keeping a server up

In Launch mode Pyrodeck watches the server it started, as D3Server3 did:

- **Crash:** when the game exits without being asked to, Pyrodeck starts it again with the same profile after 5 s. Each further crash doubles the wait, up to 2 minutes. After seven crashes in 30 minutes it stops trying and says so; the next launch by hand starts the count over.
- **Hang:** when the server's console has been quiet for 59 s, Pyrodeck sends `$players`. If nothing at all comes back by 120 s, it kills the server and starts it again. A level that is loading gets 2 minutes before this applies.
- **Restart when empty** (off by default): once the server has run longer than a set number of hours, Pyrodeck restarts it when no human is on it and the last one left at least 130 s ago. Bots don't count. It asks the server with `$players` before restarting, so a player it missed is never kicked.

A server you stop (Stop button, a playlist rotation, or `quit` typed at its console) stays down. A crash in the middle of a playlist restart is handled by the playlist's own retry.

The Launch panel's **Supervisor** block shows what it is doing (relaunches so far, the last crash and hang, uptime, players, how long the console has been quiet, why an empty restart has not happened yet) and, when you open it, the three switches and their limits. A pending relaunch has a **Cancel** button for a crashed server you want left down. Pyrodeck's own log gets one `[Server]` line per start, stop, crash, hang, level start, join and leave.

**After a reboot**, no server survives to re-attach to. With autostart set (see [Operations](#operations)), Pyrodeck launches the profile when it starts. A crash-loop guard watches that start: a launch that fails, or a server that exits within 60 s of starting, is a failure. Autostart retries a failed launch after 5, 10, 20 and 40 s, the supervisor relaunches a server that exited, and after 5 failures in a row both stop, with the reason in Pyrodeck's log and in the Launch panel. A server that stays up for 60 s, or a start or stop by anyone else, ends the guard.

**Pyrodeck restarts do not stop the server.** A server Pyrodeck launched keeps running when Pyrodeck stops, crashes or is upgraded, and the next Pyrodeck re-attaches to it: status, console, Stop and the supervisor work again. Closing Pyrodeck therefore leaves the server up; stop it first if you want it down. After a re-attach the server's own output is not captured any more (it went to the Pyrodeck that started it), so the Output tab and the log file stop at the restart; the console still shows everything the server prints there.

## Bans and join rules

**Bans that survive a restart.** The console's `$ban` lasts until the server restarts (a playlist rotation is a restart). Bans that last are the engine's `netgames/hosts.deny`, which the server reads at each game start and on `$rehash`:

- **Bans tab → Address bans.** Add an address (`203.0.113.9`), a pattern (`203.0.113.*`) or a prefix (`203.0.113.0/24`, `/8`, `/16`, `/24` or `/32`; the server matches whole parts only), with a reason. Pyrodeck writes the line exactly as the server reads it, keeps the reason and date itself (the file has no room for them), and sends `$rehash` after every change and, by default, at every level start. Lines the server silently ignores (a comment, a trailing space, a `/24` typed by hand) are listed with the reason.
- **Where the file is.** The server reads `netgames/hosts.deny` in its writable directory: on Linux `~/.local/share/Outrage Entertainment/Descent 3/`, on Windows `%APPDATA%\Outrage Entertainment\Descent 3\`. Pyrodeck uses the directory a launched server reports in its log, or a path you set; retail 1.4/1.5 servers read the file in their install directory. The file is on the server's machine, so in Connect mode to another machine the editor does not apply to that server.
- **Name bans.** The game has no name ban. Pyrodeck kicks a joining player whose name matches the list (any case; `Name*` matches every name starting with `Name`), saying why first. Names are easy to borrow, so ban the address too where you can.
- **Ban from the Players tab** says the reason, waits two seconds, re-checks the slot, sends `$ban`, adds the player's address to hosts.deny (on by default) and, if ticked, the name to the list.

**Addresses.** Pyrodeck learns a joining player's address with one `$playerinfo` per new session, never polled. On servers other than Matcen 0.9.3+ that command fills a buffer the server never empties (about 40 queries crash it), so Pyrodeck sends at most 20 per server run there (Rules tab; up to 30). Names containing `%` are never looked up.

**Rules tab** (both off by default):

- **Nickname rules**: kick a joining player whose name is empty, contains `%`, contains control characters, or is shorter than a minimum, with the reason said first.
- **Profanity monitor**: watches general chat (team and private chat never reach the server console) for an editable word list; a short default list of plain profanity ships with Pyrodeck. Per player and server run: private warnings, then kicks, then a ban of the name and address, with a cooldown so one burst of lines counts once. A chat line carries the name the sender's game claims.

## Tech Stack

| Layer | Choice |
|-------|--------|
| Backend | Fastify + TypeScript |
| Frontend | React 19 + Vite 8 + TailwindCSS v4 + shadcn/ui |
| Terminal | xterm.js |
| Transport | Plain TCP (D3's "telnet" is not actual telnet IAC) |
| UI Components | shadcn/ui (Radix + Tailwind) with semantic CSS variable theming |
| Package manager | pnpm (monorepo workspaces) |

## Project Structure

```
packages/
  server/     Fastify backend — telnet transport, parser framework,
              process manager, config/profile management
  client/     React frontend — xterm.js console, dashboard,
              config editor, shadcn/ui components
docs/
  d3-dedicated-server-reference.md   Complete D3 server command & config reference
```

## Documentation

- [`BUILDING.md`](BUILDING.md) — building from source and running on all platforms (Windows, Ubuntu, Rocky Linux/RHEL, Arch)
- `docs/d3-dedicated-server-reference.md` — D3 dedicated server command and config reference
- `docs/D3SERVER3_AUDIT.md` — feature audit of D3Server3 3.0.83 (2010) against Pyrodeck 0.4.20, with a ranked list of what Pyrodeck lacks
- `docs/running-as-a-service.md` — running Pyrodeck unattended (NSSM, schtasks, systemd)
- [`docs/behind-a-reverse-proxy.md`](docs/behind-a-reverse-proxy.md) — a public server: nginx with HTTPS in front, the environment, the firewall, the order of steps

## Releases

A `v*` tag runs `.github/workflows/release.yml`, which builds the Linux and Windows packages and publishes them as a GitHub Release with `SHA256SUMS.txt`, the SHA-256 of every file in the release in `sha256sum` format. To build one yourself, `pnpm package:server` makes a self-contained Node SEA binary for the current platform ([BUILDING.md](BUILDING.md)). A Tauri app-mode wrapper (native window, sidecar server) scaffold lives in `src-tauri/` — see build instructions in `src-tauri/src/lib.rs`.

### Verifying a download

Download `SHA256SUMS.txt` into the same directory as the package, then:

```bash
sha256sum --check --ignore-missing SHA256SUMS.txt        # Linux: "pyrodeck-v0.5.3-linux-x64.tar.gz: OK"
shasum -a 256 --check --ignore-missing SHA256SUMS.txt    # macOS
```

On Windows, in PowerShell, compare the hash with the package's line in `SHA256SUMS.txt`:

```powershell
(Get-FileHash .\pyrodeck-v0.5.3-windows-x64.zip -Algorithm SHA256).Hash.ToLower()
```

A mismatch, or `FAILED`, means the file is not the one the workflow built: download it again, and do not run it.

## Security

An admin password is required to access the web panel from non-localhost connections. You can set one via:

1. **First-run setup** — the web UI prompts for a password on first launch (stored as a scrypt hash in `config/pyrodeck.json`)
2. **Environment variable** — set `PYRODECK_ADMIN_PASSWORD` (takes precedence over the config file)

With no admin password set, the server serves localhost only: requests from non-loopback peers are refused (and a startup warning explains why) until a password is configured. "Localhost" means a browser connected straight to Pyrodeck's port from the same machine, asking for `localhost` or `127.0.0.1`: a request that came through a reverse proxy (it carries `X-Forwarded-For`, `Forwarded`, `X-Real-IP` or another forwarding header) is never local, and neither is a page whose own DNS name points at 127.0.0.1. Passwords are verified using scrypt with a random salt and timing-safe comparison. Each login gets a random 32-byte session id, kept in Pyrodeck's memory and carried in a signed HttpOnly cookie with `SameSite=Strict`, marked `Secure` when the browser came over HTTPS; a new login always gets a new id and ends the one the browser carried. A session ends at logout, at **Log out all sessions** (Settings tab), when the admin password is set, 12 hours after login (`PYRODECK_SESSION_TTL_HOURS`) or after 120 minutes without a request (`PYRODECK_SESSION_IDLE_MINUTES`), and the console WebSockets it opened close with it. An open panel polls the server, so it keeps its session in use: the idle timeout ends the sessions of closed or sleeping browsers, and the 12-hour limit ends every session. Sessions are not saved, so restarting Pyrodeck logs everyone out. Browser requests whose `Origin` names another host are refused, the WebSocket included. Login attempts are rate-limited to 5 per client address per 15 minutes (per /64 for IPv6). Web-based first-run setup is allowed only from localhost (so nobody can claim the admin password on a freshly-exposed instance); set `PYRODECK_ALLOW_REMOTE_SETUP=1` to permit it from a remote browser.

The game server Pyrodeck launches does not inherit Pyrodeck's environment. It gets `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `TMPDIR`/`TMP`/`TEMP`, `TZ`, `LANG`, `LANGUAGE`, `LC_*`, `XDG_*`, `SDL_*`, `D3_*` and `LD_LIBRARY_PATH` (on Windows also the system variables such as `SystemRoot` and `APPDATA`), plus `SDL_VIDEODRIVER=dummy` unless set, and never a `PYRODECK_*` variable: the admin password, the session secret and anything else in the service's environment stay with Pyrodeck.

The mission download listener (off by default) is public by design and needs no login, but serves nothing except the missions in the game path's `missions/` directory, never the retail ones; it runs on its own port, not through the admin panel.

For internet-facing deployments, put Pyrodeck behind a reverse proxy (nginx, Caddy) with HTTPS, leave it on `127.0.0.1` (the default since 0.5.2), and set `PYRODECK_TRUST_PROXY=1` so rate-limiting, the `Secure` cookie and logging see the real client from `X-Forwarded-For` and `X-Forwarded-Proto`. It trusts those headers only from a proxy on the same machine; the client's address is the last one the proxy added, so a client cannot spoof it. Set the admin password before the proxy goes live. [docs/behind-a-reverse-proxy.md](docs/behind-a-reverse-proxy.md) has the nginx server block, certbot, the firewall and the checks. Keep the game's remote console off the network too: `AllowRemoteConsole=0` (see Launch Mode).

### Environment variables

| Variable | Purpose |
|---|---|
| `PYRODECK_ADMIN_PASSWORD` | Admin password (plaintext; takes precedence over the config hash) |
| `PYRODECK_TRUST_PROXY` | Unset: `X-Forwarded-*` ignored. `1`: trust it from a proxy on this machine (127.0.0.0/8, ::1) only. Or a comma-separated list of the proxy's addresses or CIDR blocks. Anything else stops Pyrodeck at startup |
| `PYRODECK_CORS_ORIGIN` | Comma-separated origin allowlist; CORS is off (same-origin only) by default |
| `PYRODECK_ALLOW_REMOTE_SETUP` | `1` to allow first-run password setup from a non-local browser |
| `PYRODECK_HOST` / `PYRODECK_PORT` | Bind address/port (default `127.0.0.1:3001`, this machine only). Set `PYRODECK_HOST=0.0.0.0` to serve a LAN directly; the default was `0.0.0.0` before 0.5.2 |
| `PYRODECK_SESSION_TTL_HOURS` | A session ends this long after login, however busy (default `12`; decimals allowed) |
| `PYRODECK_SESSION_IDLE_MINUTES` | A session ends after this long without a request (default `120`) |
| `PYRODECK_LOG_RETENTION_DAYS` | Delete Pyrodeck's game-server logs last written more than this many days ago (default `0` = never; `30` recommended for a public server). Wins over the Logs tab |
| `PYRODECK_LOG_MAX_MB` | Then delete the oldest until Pyrodeck's logs take at most this many MB (default `0` = no cap; `2048` recommended). Wins over the Logs tab |
| `PYRODECK_LOG_COMPRESS` | `1` gzips closed logs to `.log.gz`, `0` leaves them as they are (default: the Logs tab's setting, off; `1` recommended). Wins over the Logs tab |
| `PYRODECK_AUTOSTART_PROFILE` | The profile to launch when Pyrodeck starts, by its exact name (or id); unset or blank leaves it to **Start when Pyrodeck starts** in the profile, which it wins over and locks. Default: no autostart. An unknown name is logged as an error and starts nothing |

## Known Limitations

- Playlist rotation is **best-effort**: D3 has no native mission rotation, so every transition is a full server stop → config swap → relaunch. Players must manually reconnect after each rotation (D3 clients cannot be told to reconnect), and the restart can occasionally fail. Treat rotation as a convenience feature, not a guaranteed-uptime mechanism
- Single server connection only (multi-server support planned)
- Player history and rules see only what the server prints on its console: team and private chat are invisible, and a player who drops during a level change is recorded as gone two minutes into the next level
- On the open-source engine and Matcen (0.9.16 tested), console text containing `%` is formatted twice by the server itself, and a `%s` in a bot name crashed it. A player whose name or chat contains `%` may crash such a server before the nickname rule can kick them; that is an engine fix, not something Pyrodeck can prevent
- Bot team choice in the add-bot form appears only when the server advertises `teams` in `$servercaps` and the game has teams; otherwise use the Bot Roster config editor before launch
- After Pyrodeck restarts and re-attaches to a running server, that server's output is no longer captured: the Output tab and its log file stop at the restart (the console still shows what the server prints there)
- Bot team assignment requires Matcen fork v0.8.6+ (`BotTeam<n>=` support in engine)
- A profile with a bind address (`-useip`) and `AllowRemoteConsole=0` works on Matcen 0.10.8 and later, whose console listens on 127.0.0.1. Older engines (retail 1.4, upstream Descent 3, earlier Matcen) put the console on the bind address but accept only 127.0.0.1, so Pyrodeck cannot log in to them; Pyrodeck warns when the profile is saved, at launch and when the login fails
- Login sessions are kept in memory: restarting Pyrodeck (an upgrade, a crash, the service restarting) logs everyone out, and two Pyrodeck instances behind one proxy do not share sessions
- Log retention covers the Log Directory the Logs tab shows and the folder of the last launch's log; logs that an earlier profile wrote next to another executable (with no Log Directory set) are not pruned
- Windows binaries are unsigned; SmartScreen will warn on first run — click **More info → Run anyway**

## Development

Pyrodeck was written by Steve V with significant AI assistance from Claude (Anthropic).
All architecture, design decisions, and testing direction are the author's. The author takes
full responsibility for every line of code. AI assistance was used as a development accelerator,
not a replacement for engineering discipline — auth, responsive layout, packaging, licensing,
and documentation are all implemented properly as a result.

Source code is available under the [MIT License](LICENSE).

## License

MIT — see [LICENSE](LICENSE).
