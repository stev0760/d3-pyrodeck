# D3 Pyrodeck

Web-based admin panel for Descent 3 dedicated servers.

Companion project to the [Matcen fork](https://github.com/stev0760/Descent3/tree/feature/multiplayer-bots) which adds multiplayer bots to the Descent 3 open source engine.

## Current Status

**Phase 1 (Connect Mode MVP)** — mostly complete, in bug-fix/polish stage.

Working:
- Connect to a running D3 dedicated server via telnet from your browser
- Live console with command input, history, and scrollback (xterm.js)
- Auto-detect Matcen fork via `$servercaps` probe (shows version, enables bot features)
- Player scoreboard with auto-refresh
- Add/remove bots with ship and difficulty selection (Matcen fork only)
- Game settings: max players, PPS, time limit, kill goal, respawn time
- Server controls: end level, warp, quit
- Config file editor
- Saved server profiles

Known limitations:
- Web admin auth is disabled for now (D3 console password is the only auth layer)
- Single server connection only (multi-server is planned)

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
AllowRemoteConsole 1
RemoteConsolePort 2092
ConsolePassword yourpassword
```

## Project Structure

```
packages/
  server/     Fastify + TypeScript backend, telnet transport, parser framework
  client/     React 19 + Vite 8 + TailwindCSS v4 frontend
```

## Documentation

- `D3_PYRODECK_SPEC.md` — full project specification
- `PLAN.md` — development roadmap and progress
