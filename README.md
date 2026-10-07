# D3 Pyrodeck

Web-based admin panel for Descent 3 dedicated servers.

Companion project to the [Matcen fork](https://github.com/stev0760/Descent3/tree/feature/multiplayer-bots) which adds multiplayer bots to the Descent 3 open source engine.

## Current Status

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
- The Log Directory must be an absolute path; before each launch Pyrodeck creates the directory and the log file itself and refuses to start if it can't
- After launch the log is checked (about 8 s in, then every 30 s): a log that stays empty, errors, or is deleted, moved or replaced mid-run raises an error and stays flagged in the Launch panel until the next launch

### Players
- Auto-refreshing scoreboard from `$scores` (name, points, kills, deaths, suicides, ping)
- Bot and observer badges
- Kick and ban controls per player

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
- Process status indicator (stopped, starting, running, crashed)
- Graceful shutdown sequence: `quit` command → SIGTERM → SIGKILL
- Supervisor: relaunches a crashed server, restarts a hung one, and can restart an empty server after an uptime limit (see [Keeping a server up](#keeping-a-server-up))

### Responsive Layout
- Three breakpoints: phone (<768px), tablet (768-1024px), desktop (1024px+)
- Mobile: hamburger menu opens left sheet, server icon opens right sheet, full-screen tab content
- Tablet: compact top bar, left panel via sheet, right sidebar inline
- Desktop: full three-column layout

## Requirements

- Node.js 20+
- pnpm
- A Descent 3 installation (Launch mode) or a running D3 dedicated server (Connect mode)
- `AllowRemoteConsole=1` in `dedicated.cfg` for remote console access

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

Enter your D3 server's host, port, and console password. The server's `dedicated.cfg` needs:

```
AllowRemoteConsole=1
RemoteConsolePort=2092
ConsolePassword=yourpassword
```

### Launch Mode

Point Pyrodeck at your D3 installation directory, select or create a server profile, and click Launch. Pyrodeck spawns the D3 process and auto-connects to it.

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

## Releases

Pre-built binaries are not yet published. Use `pnpm package:server` to build a self-contained Node SEA binary for the current platform. A Tauri app-mode wrapper (native window, sidecar server) scaffold lives in `src-tauri/` — see build instructions in `src-tauri/src/lib.rs`.

## Security

An admin password is required to access the web panel from non-localhost connections. You can set one via:

1. **First-run setup** — the web UI prompts for a password on first launch (stored as a scrypt hash in `config/pyrodeck.json`)
2. **Environment variable** — set `PYRODECK_ADMIN_PASSWORD` (takes precedence over the config file)

With no admin password set, the server serves localhost only: requests from non-loopback peers are refused (and a startup warning explains why) until a password is configured. Passwords are verified using scrypt with a random salt and timing-safe comparison. Sessions use signed HttpOnly cookies with `SameSite=Strict`. Login attempts are rate-limited to 5 per IP per 15 minutes. Web-based first-run setup is allowed only from localhost (so nobody can claim the admin password on a freshly-exposed instance); set `PYRODECK_ALLOW_REMOTE_SETUP=1` to permit it from a remote browser.

The mission download listener (off by default) is public by design and needs no login, but serves nothing except the missions in the game path's `missions/` directory, never the retail ones; it runs on its own port, not through the admin panel.

For internet-facing deployments, put Pyrodeck behind a reverse proxy (nginx, Caddy) with HTTPS, and set `PYRODECK_TRUST_PROXY=1` so rate-limiting and logging see the real client IP from `X-Forwarded-For` (off by default, since trusting that header on a directly-exposed server lets clients spoof their IP).

### Environment variables

| Variable | Purpose |
|---|---|
| `PYRODECK_ADMIN_PASSWORD` | Admin password (plaintext; takes precedence over the config hash) |
| `PYRODECK_TRUST_PROXY` | `1` to trust `X-Forwarded-For` (set only behind a reverse proxy) |
| `PYRODECK_CORS_ORIGIN` | Comma-separated origin allowlist; CORS is off (same-origin only) by default |
| `PYRODECK_ALLOW_REMOTE_SETUP` | `1` to allow first-run password setup from a non-local browser |
| `PYRODECK_HOST` / `PYRODECK_PORT` | Bind address/port (default `0.0.0.0:3001`) |

## Known Limitations

- Playlist rotation is **best-effort**: D3 has no native mission rotation, so every transition is a full server stop → config swap → relaunch. Players must manually reconnect after each rotation (D3 clients cannot be told to reconnect), and the restart can occasionally fail. Treat rotation as a convenience feature, not a guaranteed-uptime mechanism
- Single server connection only (multi-server support planned)
- Bot team assignment in the add-bot form is not yet implemented (team assignment is available in the Bot Roster config editor for pre-launch setup)
- Bot team assignment requires Matcen fork v0.8.6+ (`BotTeam<n>=` support in engine)
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
