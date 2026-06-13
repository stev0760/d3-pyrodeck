# D3 Pyrodeck

Web-based admin panel for Descent 3 dedicated servers.

Companion project to the [Matcen fork](https://github.com/stev0760/Descent3/tree/feature/multiplayer-bots) which adds multiplayer bots to the Descent 3 open source engine.

## Current Status

**v0.4.11** — Stop crashing dedicated servers via `$netgameinfo`. On a dedicated server the engine never flushes its 16 KB text-command buffer (no rendering), and `$netgameinfo` writes ~17 lines into it per call that are never cleared — so polling it overflows the buffer and aborts the server after ~30 calls (~10–15 min at the old 30s/60s intervals). This was an engine bug present in retail D3 1999, unfixable on unmodified servers, so the fix is entirely Pyrodeck-side: **all `$netgameinfo` polling is removed.** The client now queries once per connection (plus the manual refresh button) and derives the countdown locally; the server queries once per activation and once per mission rotation, re-anchoring mid-mission level changes from the cached time limit. The server pushes fresh `serverinfo` to clients after its queries so panels stay current without polling. (`$netgameinfo` is the lone offender — its handler calls a dual-purpose function that writes the overlay even headless. `$scores` and the other polls are verified to use console-only/`DPrintf` paths and are safe to poll.)

**v0.4.10** — Hardening and cleanup pass: config filenames are guarded against path traversal; playlist and saved-server request bodies are validated; `parseTimeLeft` handles `H:MM:SS` and color-code stripping survives TCP chunk boundaries. Network-facing defaults are safer (env-gated `trustProxy`, same-origin CORS, localhost-only first-run setup — see Security). Added an eslint flat config so `pnpm lint` runs clean.

**v0.4.9** — Timer reliability: the Time Left countdown resets on `$warp`, `$endlevel`, and mission rotations instead of running off a stale anchor, and re-syncs with the server every 30s. Launch mode broadcasts a `level_changed` signal (from D3's `Opening level` stdout) so the UI drops the old timer the instant a new level loads, and the Server panel shows the actual loaded level (e.g. `TheCore`), not just the mission file. Also fixed: playlist vote ties resolve to the first option, drift correction survives rotations/reconnects, WebSocket keep-alive pings are visible to browsers (iOS Safari reconnect works), and dead WS clients are culled.

Works with vanilla D3 1.4, the [open-source D3](https://github.com/DescentDevelopers/Descent3) engine, and the Matcen fork v0.8.4+. Two operating modes:

- **Connect mode:** Remote admin — connect to any running D3 server via its TCP console (port 2092)
- **Launch mode:** Full server manager — configure, launch, and manage a local D3 dedicated server process

## Features

### Console
- Live terminal (xterm.js) with command input, history (up/down), and 5000-line scrollback
- Collapsible, resizable command reference drawer with 6 categories (Players, Teams, Server, Stats, Bots, Bot Debug) — click-to-execute for simple commands, inline inputs for parameterized commands
- D3 color codes and null bytes stripped from output

### Server Console (Launch mode)
- Separate xterm.js terminal showing D3 process stdout/stderr
- Server output logged to `server.log` for post-session analysis

### Players
- Auto-refreshing scoreboard from `$scores` (name, points, kills, deaths, suicides, ping)
- Bot and observer badges
- Kick and ban controls per player

### Bots (Matcen fork only)
- Auto-detected via `$servercaps` probe — bot UI only appears when connected to a Matcen fork server
- Add bots with name, ship, and difficulty selection
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

### Config Editor (Launch mode)
- Server profile system — named configurations pointing at config files in the D3 game directory
- Tabbed editor sections: Server Config, Ship Settings, Bot Roster, Startup Commands
- **Structured form UI** (no .cfg editing required): server identity, network settings, rules, ship bans, powerup toggles, bot roster
- Starting level (SetLevel) exposed in the identity section
- Bot Roster: per-bot name, ship, difficulty, and team assignment (1-4 or auto-balance); roster count vs max-players warnings; default difficulty
- Ship bans and powerup allow/disallow lists written to the linked `.mps` file
- Create, link, and unlink companion files (`.mps`, `bots.cfg`, `autoexec.dmfc`)
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
- Process status indicator (stopped, starting, running, crashed)
- Graceful shutdown sequence: `quit` command → SIGTERM → SIGKILL

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

## Releases

Pre-built binaries are not yet published. Use `pnpm package:server` to build a self-contained Node SEA binary for the current platform. A Tauri app-mode wrapper (native window, sidecar server) scaffold lives in `src-tauri/` — see build instructions in `src-tauri/src/lib.rs`.

## Security

An admin password is required to access the web panel from non-localhost connections. You can set one via:

1. **First-run setup** — the web UI prompts for a password on first launch (stored as a scrypt hash in `config/pyrodeck.json`)
2. **Environment variable** — set `PYRODECK_ADMIN_PASSWORD` (takes precedence over the config file)

The server warns at startup if it binds to a non-loopback interface without a password. Passwords are verified using scrypt with a random salt and timing-safe comparison. Sessions use signed HttpOnly cookies with `SameSite=Strict`. Login attempts are rate-limited to 5 per IP per 15 minutes. Web-based first-run setup is allowed only from localhost (so nobody can claim the admin password on a freshly-exposed instance); set `PYRODECK_ALLOW_REMOTE_SETUP=1` to permit it from a remote browser.

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
