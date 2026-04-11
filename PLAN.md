# D3 Pyrodeck — Development Plan

This is a living document tracking the implementation roadmap. The spec (`D3_PYRODECK_SPEC.md`) defines *what* to build; this document tracks *how* and *in what order*, updated as we go.

---

## Phase 1 — Connect Mode MVP ✅

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
- Kick/Ban buttons with correct player numbers

### Step 8: Bots Tab ✅
- Add Bot form (name, ship dropdown, difficulty dropdown — conditional on feature flags)
- Active bot list from `$botlist` with remove/difficulty controls
- Conditional on `bots` feature flag from `$servercaps`

### Step 9: Config Editor ✅
- File list API with path sanitization
- Textarea editor with save (CodeMirror deferred to polish phase)
- Warning banner: "Changes take effect after server restart"

### Step 10: Game Settings ✅ (replaced in Phase 2)
- ~~Live controls: max players, PPS, time limit, kill goal, respawn time, HUD names~~
- ~~Server control: end level, warp, balance teams, quit (with confirmation)~~
- Replaced by ServerSidebar in Phase 2

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
- Collapsible drawer below the terminal with command categories
- Click-to-execute for no-arg commands, inline inputs for commands with arguments
- Bots category gated on `$servercaps` feature detection
- State persisted in localStorage

---

## Phase 2 — Launch Mode & Server Dashboard ✅

**Goal:** Add local server management alongside existing remote admin. Same dashboard, different connection entry point.

- **Connect Mode** (existing): User enters host/port/password → telnet to remote server
- **Launch Mode** (new): User configures + launches a local D3 process → Pyrodeck auto-connects via telnet to localhost

Once connected, Console/Players/Bots all work identically.

### UI Reorganization ✅
- [x] Sidebar mode toggle (Connect / Launch) persisted to localStorage
- [x] Config tab visibility: hidden in Connect mode, shown in Launch mode
- [x] LaunchPanel component (D3 path setup, config file selector, process status, Launch/Stop)

### Launch Mode Backend ✅
- [x] Pyrodeck config (`config/pyrodeck.json` — D3 install path, executable, defaults)
- [x] ConfigGenerator (dedicated.cfg parser, telnet config extraction, default generation)
- [x] ProcessManager (spawn with `-dedicated` flag, `SDL_VIDEODRIVER=dummy`, stdout/stderr drain, TCP probe + stdout pattern matching for telnet readiness, graceful shutdown: quit → SIGTERM → SIGKILL)
- [x] Launcher routes (`POST /start`, `POST /stop`, `GET /status`, `GET /detect`)
- [x] Pyrodeck config routes (`GET/PUT /api/pyrodeck/config`, `POST /validate-path`)
- [x] Auto-connect telnet on process readiness, probe $servercaps, create session
- [x] wireSessionToClients() for late-binding telnet data to WS clients

### Launch Mode Frontend ✅
- [x] LaunchPanel with process status indicator (color-coded dot: gray/amber/green/red)
- [x] useLauncher hook with config management and process status polling
- [x] WebSocket always-open on mount for receiving Launch Mode broadcasts

### Server Dashboard (replaced Settings tab) ✅
- [x] ServerSidebar (right panel, visible when connected)
- [x] Server info: game name, mission, mode, network model, time left
- [x] $netgameinfo parser for structured server state
- [x] Stepper controls for max players, PPS, time limit, kill goal
- [x] Quick actions: end level, warp, balance teams
- [x] Quit server with confirmation
- [x] useServerInfo hook: query on connect, re-query after setting changes, manual refresh
- [x] 3-column layout: left sidebar | center content | right sidebar
- [x] Removed Game/Server categories from CommandReference (moved to sidebar)
- [x] Deleted GameSettings.tsx

### Bug Fixes ✅
- [x] D3 spawn: correct flag is `-dedicated` not `-d`, config needs `./` prefix
- [x] SIGPIPE prevention: wrapped stdout/stderr handlers in try/catch, stream error handlers, stdin "ignore"
- [x] WebSocket lifecycle: stale onclose clobbering new WS ref, shouldReconnect killed on initial disconnected
- [x] Terminal doubling: stale telnetReady handlers accumulating across launch/crash/relaunch — clear old listeners before registering new ones
- [x] wireSessionToClients() made idempotent via wiredSessionId tracking
- [x] $scores parser: handle D3's 19-char name truncation (colon lost on long names) with fallback text/number boundary detection

### Not Yet Done
- [x] Quit button should route through launcher stop for graceful shutdown (currently sends raw `quit`, Pyrodeck sees it as a crash)
- [ ] Packaging as single executable (evaluate Bun `--compile` vs Node SEA)

---

## Phase 3 — Structured Config & D3Server3 Parity

**Goal:** Full config creation/editing UI matching D3Server3's capabilities. A user should be able to create, configure, and launch a server entirely through Pyrodeck's web UI without ever touching a .cfg file.

**Reference:** D3Server3 v3.2 screenshots analyzed in `.claude/skills/d3-server-admin/d3server3-feature-map.md`. All dedicated.cfg CVars documented in `d3-dedicated-server-reference.md` with source-verified types, ranges, and defaults.

### Step 0: File & Path Architecture ✅

Foundational refactor separating Pyrodeck's internal config from D3 server config management.

**Two storage domains:**
- **Pyrodeck internal** (`PYRODECK_CONFIG_DIR`): `pyrodeck.json`, `servers.json`, `profiles.json` — Pyrodeck's own settings, D3 never sees these
- **D3 server configs** (in `gamePath`): `dedicated.cfg`, `.mps`, `bots.cfg`, `autoexec.dmfc` — files D3 reads at launch, stored in the game directory

**Architecture decision — in-place configs (v2):** Initially designed with a separate `configPath` directory and per-profile subdirectories, but D3's `cfopen()` file resolution is tightly coupled to `cwd` and doesn't search `-additionaldir` paths for config files. After testing, switched to **in-place model**: config files live directly in `gamePath` (the traditional D3 layout). Profiles are lightweight JSON metadata in Pyrodeck's config dir, each pointing at a config filename in gamePath. Launch is simple: `cwd = gamePath`, no `-additionaldir` needed.

**Server profiles:** Each profile is a named reference to a config file in gamePath. Metadata (name, description, timestamps) stored in `profiles.json`. Profile CRUD: list, create, read, update, delete, duplicate, import existing.

- [x] PyrodeckConfig: `gamePath`, `executablePath` replace old `d3InstallPath`/`d3Executable` (removed `configPath`)
- [x] Auto-migration from legacy config format on first load
- [x] Split path validation: `validateGamePath`, `validateExecutable`
- [x] ServerProfile module: lightweight JSON profiles pointing at config files in gamePath
- [x] ProcessManager: `cwd = gamePath`, simplified launch args
- [x] Launcher routes: profile-based launch, updated detect endpoint
- [x] Config routes: profile-aware file management, import existing configs, game file listing
- [x] Server console: xterm.js terminal for D3 stdout/stderr, file logging to server.log
- [x] Frontend: LaunchPanel with profile selector, ConfigEditor with sectioned file types
- [x] ConfigEditor redesign: tabbed sections (Server Config, Ship Settings, Bot Roster, Startup Commands), create/delete companion files, import existing configs as profiles
- [x] Clear UI labeling: "Pyrodeck Settings" vs "D3 Server Config", profile dropdown shows config filename

### Step 1: Raw Text Editing ✅

Direct text editing for all config file types — the "advanced mode" baseline:

- [x] Profile Editor: textarea editing for server config and all companion files (bot roster, ship settings, startup commands)
- [x] Companion file management: create with custom filename, link existing, unlink (removes CVar without deleting)
- [x] CVar auto-management: creating/deleting companions auto-updates BotConfig=/MultiSettingsFile= in server config
- [x] Game File Browser: categorized file list with metadata, preview pane, edit-in-place with save
- [x] File classification: backend inspects content to categorize as server-config, bot-roster, ship-settings, startup-commands
- [x] Profile-less file write endpoint for Game Files browser editing

### Step 2: Config Backend — Parse & Generate ✅

- [x] Bidirectional cfg parsing: `entriesToStructured()` / `structuredToString()` with full `DedicatedCfgData` schema
- [x] Type-aware parsing with D3 engine defaults for missing keys
- [x] Handle multi-value keys: `AllowPowerup`/`DisallowPowerup` collected as arrays
- [x] .mps file read/write: `parseMpsFile()` / `generateMpsFile()` with `SHIPBAN` support
- [x] Bot roster file read/write: `parseBotRoster()` / `generateBotRoster()`
- [x] `GET/PUT /api/profiles/:id/structured-config` — structured config API (merges ship bans from .mps)
- [x] `GET/PUT /api/profiles/:id/bot-roster` — structured bot roster API
- [x] `GET /api/game-files/missions` — scans `gamePath/missions/` for .mn3 files
- [x] `GET /api/game-files/netgames` — scans `gamePath/netgames/` for .d3m game types
- [x] 27 unit tests covering parse/generate round-trips for all formats

### Step 3: Config Form UI — Core Settings (Structured Mode) ✅

- [x] Identity section: server name (max 32), game type dropdown (scanned from netgames/), mission dropdown (scanned from missions/), MOTD
- [x] Network section: PPS (2-40, rec. 20), max players (2-32), network model radio (Client/Server, Peer-to-Peer, Permissable), send rotation velocity, use smoothing
- [x] Rules section: time limit, kill goal, respawn time, randomize respawn, difficulty dropdown (Trainee→Insane), num teams (visible for team modes)
- [x] Gameplay toggles: accurate collisions, bright players, allow mouselook
- [x] Remote console section: allow/disable toggle, port, password with auto-generate button
- [x] Structured/Raw toggle in editor header — raw textarea always available as fallback
- [x] Save/Reset controls with unsaved-changes indicator
- [ ] Defaults button to populate recommended values
- [ ] Form validation error display (currently clamped silently at engine min/max)

### Step 4: Config Form UI — Ships & Powerups ✅

- [x] Ship toggles: Pyro-GL, Phoenix, Magnum-AHT, Black Pyro — "at least one required" validation, Pyro-GL ban warning
- [x] Ship bans written to .mps file, MultiSettingsFile= auto-added/removed from cfg
- [x] Powerup toggles in 4 categories: Primary Weapons, Secondary Weapons, Utility, Countermeasures
- [x] "Allow all" / "Disallow all" per category + global Allow All / Disallow All
- [x] Running count: "X/30 allowed"
- [x] Bandwidth-heavy indicator (BW label) on ProxMinePowerup, Betty4Pack, BlackShark, Seeker3Pack
- [x] Disallowed powerups rendered with strikethrough for clarity
- [x] Normalizes AllowPowerup= allow-list → DisallowPowerup= disallow-list on load (UI always uses disallow pattern)

### Step 5: Config Form UI — Bots (Matcen Fork)

Bot roster editor (gated on Matcen fork detection via $servercaps):
- [ ] Bot roster form: add/remove/reorder bots (name, ship dropdown, difficulty dropdown)
- [ ] Default difficulty selector (applies to bots without per-bot override)
- [ ] Bot count display with max players warning
- [ ] Save/load named bot presets (roster files)
- [ ] Generates roster file + `BotConfig=` in dedicated.cfg

### Step 6: Config Management & Wizard

- [ ] "New Server Config" wizard: pick game type → form pre-fills sensible defaults for that mode
- [ ] autoexec.dmfc editor: simple list of DMFC commands to run at server start

### Step 7: Post-Start Settings

Settings that can't be set in cfg but Pyrodeck can apply after server launch:
- [ ] Server HUD names (full/team/none) — send `$serverhudnames` after start
- [ ] Kill message filter (full/simple/none) — send `$killmsgfilter` after start
- [ ] Auto-save stats toggles — send `$autosavelevel`/`$autosavedisconnect` after start
- [ ] Store these in Pyrodeck's own config per server profile, apply automatically on launch

---

## Phase 4 — Docker & Deployment

**Goal:** One-command VPS deployment with game file management.

**Platform note:** Pyrodeck is cross-platform (Node.js). Linux is the primary dev/test
platform, but Windows is equally important — PiccuEngine servers are Windows-only currently.
Connect mode works with all D3 builds everywhere (vanilla 1.5, Matcen, PiccuEngine).
Launch mode works wherever the target D3 build runs. See DEVLOG for engine compatibility details.

- [ ] Docker image (Alpine) with `docker-compose.yml`
- [ ] Structured volumes: gamedata, config
- [ ] Static file serving in production (Fastify serves client build)
- [ ] Web file manager (upload .mn3 missions, manage game files)
- [ ] Provisioning wizard (scan for required .hog files, validate, guide upload)
- [ ] Web admin auth (password gate from env var, off by default for localhost)
- [ ] Packaging as single executable (evaluate Bun `--compile` vs Node SEA)

---

## Phase 5 — Polish & Advanced Features

**Goal:** Refined UX and power-user features.

- [ ] Game tracker config UI (GameSpy port, tracker server list, PXO credentials)
- [ ] IP access control UI (hosts.allow/deny editor + `$rehash`)
- [ ] Scheduled auto-commands (D3Server3-style: run command every N minutes)
- [ ] Dark/light theme toggle
- [ ] Responsive layout for mobile
- [ ] Multi-server UI (tabs or sidebar, multiple D3 instances)
- [ ] Player list sorting/filtering
- [ ] CodeMirror for raw config editor

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
