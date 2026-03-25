# D3 Pyrodeck

Web-based admin panel for Descent 3 dedicated servers.

Companion project to the [Matcen fork](https://github.com/stev0760/Descent3/tree/feature/multiplayer-bots) which adds multiplayer bots to the Descent 3 open source engine.

## Current Status

**Phase 1 (Connect Mode) — complete.**

Works with vanilla D3 1.4, the [open-source D3](https://github.com/DescentDevelopers/Descent3) engine, and the Matcen fork v0.8.4. Connects to any D3 dedicated server via its remote console (plain TCP on port 2092).

## Features

### Console
- Live terminal (xterm.js) with command input, history (up/down), and 5000-line scrollback
- Collapsible command reference drawer below the terminal — 6 categories (Players, Teams, Game, Server, Stats, Bots), click-to-execute for simple commands, inline argument inputs for commands with parameters
- D3 color codes and null bytes stripped from output

### Players
- Auto-refreshing scoreboard from `$scores` (name, points, kills, deaths, suicides, ping)
- Kick and ban controls per player

### Bots (Matcen fork only)
- Auto-detected via `$servercaps` probe — bot controls only appear when connected to a Matcen fork server
- Add bots with name, ship, and difficulty selection
- Active bot list with remove controls

### Game Settings
- Live controls: max players, PPS (default 30), time limit, kill goal, respawn time, HUD names
- Server actions: end level, warp to mission, balance teams, quit (with confirmation)

### Config
- File list with editor for `dedicated.cfg` and other server config files
- Warning banner for changes that require server restart

### Connection Management
- Saved server profiles (name, host, port) with quick-select
- WebSocket auto-reconnect with exponential backoff (1s to 30s)
- "Connection lost" banner during reconnection attempts
- Error toast notifications for transient failures (auto-dismiss after 5s)

## Requirements

- Node.js 20+
- pnpm
- A Descent 3 dedicated server to connect to (with `AllowRemoteConsole=1` in `dedicated.cfg`)

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

Then open http://localhost:5173 and enter your D3 server's host, port, and console password.

## D3 Server Setup

Your `dedicated.cfg` needs these settings to allow remote console access:

```
AllowRemoteConsole=1
RemoteConsolePort=2092
ConsolePassword=yourpassword
```

## Tech Stack

| Layer | Choice |
|-------|--------|
| Backend | Fastify + TypeScript |
| Frontend | React 19 + Vite 8 + TailwindCSS v4 |
| Terminal | xterm.js |
| Transport | Plain TCP (D3's "telnet" is not actual telnet IAC) |
| Package manager | pnpm (monorepo workspaces) |

## Project Structure

```
packages/
  server/     Fastify backend, telnet transport, parser framework
  client/     React frontend with xterm.js console
docs/
  d3-dedicated-server-reference.md   Complete D3 server command & config reference
```

## Documentation

- `D3_PYRODECK_SPEC.md` — full project specification
- `PLAN.md` — development roadmap and progress
- `docs/d3-dedicated-server-reference.md` — D3 dedicated server command and config reference
- `CLAUDE.md` — project conventions and architecture notes

## Known Limitations

- Web admin auth is disabled (D3 console password is the only auth layer)
- Single server connection only (multi-server is planned)
- Config editor is a plain textarea (CodeMirror planned for later)
