# D3 Pyrodeck — Development Plan

This is a living document tracking the implementation roadmap. The spec (`D3_PYRODECK_SPEC.md`) defines *what* to build; this document tracks *how* and *in what order*, updated as we go.

---

## Phase 1 — Connect Mode MVP

**Goal:** End-to-end loop: browser → Fastify → telnet → D3 server and back.

### Step 1: Repo & Scaffolding ✅
- pnpm monorepo with `packages/server` and `packages/client`
- Fastify backend with health endpoint
- React + Vite + TailwindCSS frontend with dev proxy to backend
- Shared TypeScript config, .gitignore, .env.example

### Step 2: Telnet Transport ✅
- `ServerConnection` interface
- `TelnetConnection` with command queue, echo stripping, timeout-based response collection
- Unit tests for echo stripping

### Step 3: Parser Framework ✅
- `ResponseParser` registry (command → parser function)
- `$servercaps` parser (detects Matcen fork vs vanilla)
- `$scores`, `$botlist`, `$botstat` parsers
- Unit tests for servercaps parsing

### Step 4: Session Manager ✅
- `ServerSession` with connection lifecycle states (connecting → probing → ready)
- Single active session (Phase 1), keyed by ID for future multi-server

### Step 5: WebSocket Command Streaming ✅
- WebSocket endpoint at `/ws`
- Bidirectional: client sends commands, server streams telnet output
- Parsed responses sent as structured messages (players, bots, capabilities)

### Step 6: Connection Form & Console ✅
- Connection form: host, port, D3 console password
- Status indicator (disconnected/connecting/probing/ready)
- xterm.js live console with command input, history (up/down arrows), scrollback
- Fork version display in header when connected to Matcen fork

### Step 7: Players Panel ✅
- `$scores` output parsed into player table
- Auto-refresh on interval (5s)
- Bot rows visually distinguished
- Kick/Ban buttons (needs fix: currently sends wrong player index)

### Step 8: Bots Tab ✅
- Add Bot form (name, ship dropdown, difficulty dropdown — conditional on feature flags)
- Active bot list from `$botlist` with remove/difficulty controls
- Conditional on `bots` feature flag from `$servercaps`

### Step 9: Config Editor ✅
- File list API with path sanitization
- Textarea editor with save (CodeMirror deferred to polish phase)
- Warning banner: "Changes take effect after server restart"

### Step 10: Game Settings ✅
- Live controls: max players, PPS, time limit, kill goal, respawn time, HUD names
- Server control: end level, warp, balance teams, quit (with confirmation)

### Step 11: Saved Servers ✅
- Save/load connection profiles (name, host, port — no password stored)
- Stored in `config/servers.json`

### Step 12: Bug Fixes & Polish ✅
- [x] Fix D3 color code stripping (strip `\x01` + 3 RGB bytes from raw Buffer before UTF-8)
- [x] Fix null byte stripping (`\x00` in `$servercaps` response)
- [x] Fix auth — password sent once, wait-and-verify strategy (D3 closes on bad password)
- [x] Fix kick/ban to use actual player numbers (pnum from `$scores` slot order)
- [x] Fix echo stripping for commands without `[IP]` prefix
- [x] Fix multi-word ship name parsing in `$botlist` ("Black Pyro")
- [x] Fix player panel: uniform Kick/Ban for all players (bots are players)
- [x] Verify `$servercaps` probe populates UI correctly (confirmed: Matcen 0.8.4)
- [x] `$kick`/`$ban` confirmed working for human players
- [x] Tested with vanilla D3 1.4, open-source D3, and Matcen fork — all work
- [x] Switch PlayerList/BotPanel from raw output parsing to structured WebSocket messages
- [x] WebSocket auto-reconnect with exponential backoff (1s to 30s max) + connection-lost banner
- [x] Error toast notifications (bottom-right, auto-dismiss after 5s)
- [x] PPS default fixed from 12 to 30
- [ ] Web admin auth (deferred per CLAUDE.md — re-add when core is stable)

### Step 13: Console Command Reference Drawer ✅
- Collapsible drawer below the terminal with 6 command categories
- Click-to-execute for no-arg commands, inline inputs for commands with arguments
- Bots category gated on `$servercaps` feature detection
- State persisted in localStorage

---

## Phase 2 — Launch Mode & Packaging

**Goal:** Add local server management alongside existing remote admin. Same dashboard, different connection entry point.

- **Connect Mode** (existing): User enters host/port/password → telnet to remote server
- **Launch Mode** (new): User configures + launches a local D3 process → Pyrodeck auto-connects via telnet to localhost

Once connected, Console/Players/Bots/Settings all work identically.

### UI Reorganization
- [ ] Sidebar mode toggle (Connect / Launch)
- [ ] Config tab visibility: hidden in Connect mode, shown in Launch mode
- [ ] LaunchForm component (D3 path, config file, port, password, Launch/Stop, status)

### Launch Mode Backend
- [ ] Pyrodeck config (`config/pyrodeck.json` — D3 install path, defaults)
- [ ] ProcessManager (spawn D3 via child_process, state tracking, graceful shutdown)
- [ ] Launch routes (`/api/server/launch`, `/api/server/stop`, `/api/server/process-status`)
- [ ] Default `dedicated.cfg` generation
- [ ] First-run setup (validate D3 path)

### Launch Mode Frontend
- [ ] LaunchForm with process status indicator
- [ ] Stream D3 stdout/stderr to console during startup

### Packaging (after Launch Mode works)
- [ ] Package as single Windows `.exe` (evaluate Bun `--compile` vs Node SEA)

---

## Phase 3 — Docker & Provisioning

**Goal:** One-command VPS deployment with game file management.

- [ ] Docker image (Alpine) with `docker-compose.yml`
- [ ] Structured volumes: gamedata, servers, import, config
- [ ] Web file manager (upload, download, rename, delete, extract zip)
- [ ] SFTP server option for large file uploads
- [ ] Provisioning wizard (scan for required .hog files, validate, guide upload)
- [ ] Mission pack management (.mn3 upload + listing)

---

## Phase 4 — Polish & Advanced Features

**Goal:** Refined UX and power-user features.

- [ ] Structured config forms (server name, game mode, ships/weapons/powerups)
- [ ] Bot preset management (save/load named rosters)
- [ ] IP access control UI (hosts.allow/deny editor + `$rehash`)
- [ ] Server profiles (save/load full server configurations)
- [ ] Game tracker registration (PXO, community trackers)
- [ ] Dark/light theme toggle
- [ ] Responsive layout for mobile
- [ ] Multi-server UI (tabs or sidebar)
- [ ] Player list sorting/filtering

---

## Tech Stack Reference

| Layer | Choice |
|-------|--------|
| Runtime | Node.js 20 (evaluate Bun for packaging later) |
| Backend | Fastify + TypeScript |
| Frontend | React 19 + Vite 8 + TailwindCSS v4 |
| Terminal | xterm.js |
| Config editor | Textarea now, CodeMirror later |
| Package manager | pnpm (monorepo workspaces) |
| Testing | Vitest |
