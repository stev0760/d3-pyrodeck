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

### Step 12: Bug Fixes & Polish (in progress)
- [x] Fix D3 color code stripping (strip `\x01` + 3 RGB bytes from raw Buffer before UTF-8)
- [x] Fix auth — password sent once, wait-and-verify strategy (D3 closes on bad password)
- [x] Fix kick/ban to use actual player numbers (pnum from `$scores` slot order)
- [x] Verify `$servercaps` probe populates UI correctly (confirmed: Matcen 0.8.3)
- [x] `$kick`/`$ban` confirmed working for human players
- [x] Tested with vanilla D3 server — works correctly
- [ ] Reconnection UX (banner, auto-retry with backoff)
- [ ] Error toasts for transient failures
- [ ] Web admin auth (re-add properly when core is stable)

### Step 13: Console Command Reference Drawer (next)

**Goal:** Add a collapsible command reference panel below the terminal so users can discover and execute commands without memorizing them or using `$help`.

**UX research summary:**
- **Bottom placement** chosen over sidebar — terminal needs full width for reading output, and the app already has a left sidebar. Vertical space is less critical than horizontal for terminal readability.
- **Collapsible drawer** pattern (PatternFly/Welie.com) — space-efficient, shows only a toggle bar by default, expands on demand. Avoids the modal overlay of a command palette.
- **IDE precedent** — VS Code, JetBrains, and Pterodactyl (game server admin panel, also React + xterm.js) all use terminal-first layout with controls around the terminal, not competing for horizontal space.
- **Click-to-execute** — simple commands run immediately, commands with arguments show inline input. Follows game server admin conventions (Pterodactyl, FiveM, Roblox admin panels) where quick-action buttons are standard.
- **Categorized grid** — commands grouped by function (Player, Team, Game, Server, Bots), not an alphabetical dump. Fuzzy search is overkill for ~30 commands; visual scanning of categories is faster.

**Implementation plan:**
- [ ] `CommandReference.tsx` — collapsible drawer component below the terminal
  - Collapsed: thin bar with "Commands" label + chevron toggle
  - Expanded: categorized command grid in chip/button style
  - Bots category only shown when `hasFeature("bots")` is true
- [ ] Click behavior:
  - No-arg commands (`$players`, `$scores`, `$endlevel`): execute immediately via `sendCommand`
  - Arg commands (`$kick <pnum>`, `$warp <level>`, `$addbot <name> [ship] [diff]`): show inline input with placeholder hints, execute on Enter/click
- [ ] Console tab layout change: split into terminal (flex-1) + command drawer (auto height)
- [ ] Persist collapsed/expanded state in localStorage
- [ ] Style: consistent with existing amber/zinc theme

**Command categories:**
- **Players:** `$players`, `$scores`, `$playerinfo`, `$kick`, `$ban`, `$banlist`, `$removeban`
- **Teams:** `$changeteam`, `$balance`, `$allowteamchange`, `$autobalance`, `$setteamname`
- **Game:** `$settimelimit`, `$setgoallimit`, `$setmaxplayers`, `$setpps`, `$setrespawntime`
- **Server:** `$endlevel`, `$warp`, `$wait`, `$netgameinfo`, `$serverhudnames`, `say`, `quit`
- **Stats:** `$savestats`, `$autosavelevel`, `$autosavedisconnect`, `$statmsgs`, `$killmsgfilter`
- **Bots (Matcen only):** `$addbot`, `$removebot`, `$removebots`, `$botlist`, `$botstat`, `$botdifficulty`, `$servercaps`

---

## Phase 2 — Windows Launch Mode & Packaging

**Goal:** Spawn and manage a local D3 server process. Single-exe distribution.

- [ ] Spawn D3 dedicated server via child_process / Bun subprocess
- [ ] Auto-generate `dedicated.cfg` if missing
- [ ] First-run setup wizard (locate D3 install, set config dir)
- [ ] Stop Server button (graceful: `Quit` command → wait → SIGTERM)
- [ ] Process state display (running/stopped/crashed)
- [ ] Auto-restart on crash/hang (configurable, with hang detection via telnet keepalive)
- [ ] Multiple server instances on different ports
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
