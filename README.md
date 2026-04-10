# D3 Pyrodeck

Web-based admin panel for Descent 3 dedicated servers.

Companion project to the [Matcen fork](https://github.com/stev0760/Descent3/tree/feature/multiplayer-bots) which adds multiplayer bots to the Descent 3 open source engine.

## Current Status

**Phase 2 (Launch Mode) — complete. Phase 3 (Structured Config) — in progress.**

Works with vanilla D3 1.4, the [open-source D3](https://github.com/DescentDevelopers/Descent3) engine, and the Matcen fork v0.8.4+. Two operating modes:

- **Connect mode:** Remote admin — connect to any running D3 server via its TCP console (port 2092)
- **Launch mode:** Full server manager — configure, launch, and manage a local D3 dedicated server process

## Features

### Console
- Live terminal (xterm.js) with command input, history (up/down), and 5000-line scrollback
- Collapsible command reference drawer with 5 categories (Players, Teams, Server, Stats, Bots) — click-to-execute for simple commands, inline inputs for parameterized commands
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
- Live server info: game name, mission, game mode, network model, time remaining
- Stepper controls for max players, PPS, time limit, and kill goal
- Quick actions: end level, warp to level, balance teams
- Quit server with confirmation dialog

### Config Editor (Launch mode)
- Server profile system — named configurations pointing at config files in the D3 game directory
- Tabbed editor sections: Server Config, Ship Settings, Bot Roster, Startup Commands
- Create, link, and unlink companion files (`.mps`, `bots.cfg`, `autoexec.dmfc`)
- Companion file management auto-updates CVars (`BotConfig=`, `MultiSettingsFile=`) in the server config
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

Open http://localhost:5173, choose Connect or Launch mode, and go.

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

- `D3_PYRODECK_SPEC.md` — full project specification
- `PLAN.md` — development roadmap and progress tracking
- `docs/d3-dedicated-server-reference.md` — D3 dedicated server command and config reference
- `CLAUDE.md` — project conventions and architecture notes

## Known Limitations

- Web admin auth is not yet implemented (D3 console password is the only auth layer)
- Single server connection only (multi-server planned for Phase 5)
- Config editor is raw text only (structured form UI planned for Phase 3)
- Quit button sends raw `quit` — Pyrodeck interprets this as a crash rather than intentional shutdown
