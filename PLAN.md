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
- [x] Web admin auth (v0.4.0–v0.4.2: scrypt password hashing, cookie sessions, rate limiting, first-run setup)

### Step 13: Console Command Reference Drawer ✅
- Collapsible, resizable drawer below the terminal with command categories (drag handle to resize, height persisted in localStorage)
- Click-to-execute for no-arg commands, inline inputs for commands with arguments
- 6 categories: Players, Teams, Server, Stats, Bots, Bot Debug — Bots/Bot Debug gated on `$servercaps` feature detection
- `$addbot` supports optional team arg (4th positional: `$addbot <name> <ship> <difficulty> <team>`)
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

### Follow-ups (since completed)
- [x] Quit button should route through launcher stop for graceful shutdown (currently sends raw `quit`, Pyrodeck sees it as a crash)
- [x] Packaging as single executable — Node SEA pipeline (`pnpm package:server` → `dist-server/pyrodeck-server`), Windows cross-compile via `--windows`; Tauri app-mode scaffold in `src-tauri/`

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

- [x] Identity section: server name (max 32), game type dropdown (scanned from netgames/), mission dropdown (scanned from missions/), starting level (SetLevel), MOTD
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

### Step 5: Config Form UI — Bots (Matcen Fork) ✅

Bot roster editor (available when a bot roster companion file is linked to the profile):
- [x] Bot roster form: add/remove/reorder bots (name, ship dropdown, difficulty dropdown, team dropdown)
- [x] Per-bot team assignment (1–4 or Auto) — written as `BotTeam<n>=` in bots.cfg; requires Matcen fork v0.8.6+
- [x] Default difficulty selector (applies to bots without per-bot override)
- [x] Bot count display with max players warning (fetches maxPlayers from structured config)
- [x] Save/load named bot presets — covered by existing Game Files browser + companion link/unlink
- [x] Generates roster file + `BotConfig=` in dedicated.cfg
- [x] Structured/Raw toggle (same pattern as ServerConfigForm)
- [x] At-or-near max players warnings; Add form hidden when full

### Step 6: Server Playlists ✅ (Layer 1 complete)

Automatic mission rotation triggered by level-end stdout detection.

**Architecture:**
- `PlaylistManager` (singleton via `playlistInstance.ts`) — CRUD, state machine (inactive → active → voting → restarting), stdout line buffer, timer anchoring
- `playlists.ts` routes — CRUD + activate/deactivate + status
- `launcher.ts` — wires stdout to PlaylistManager, handles `rotate` event (stop → swap MissionName → restart), `registerAutoConnect()` shared between initial launch and rotation restarts
- `command.ts` — forwards `$netgameinfo` responses to PlaylistManager for timer anchoring; intercepts `$settimelimit` for live correction
- Frontend: `usePlaylist` hook, `PlaylistEditor` component (Playlists tab, Launch mode), `PlaylistPanel` widget in ServerSidebar

**Layer 1 (complete):**
- [x] Playlist CRUD: name, mode (sequential/shuffle/weighted), entries (label, missionName, startingLevel, weight)
- [x] Stdout line buffering — "Ending level." detection
- [x] `rotate` event: stop server → `ensureConfigReference(MissionName)` → restart with same profile
- [x] `registerAutoConnect()` called before every `processManager.start()` (both user-initiated and rotation restarts)
- [x] Playlist persistence to `config/playlists.json`; activation state to `playlist-state.json`
- [x] PlaylistEditor UI: list view, detail editor with entry management, voting config
- [x] PlaylistPanel in ServerSidebar: active status, current/next mission, timer countdown, activate selector

**Layer 2 (timer/frontend) ✅:**
- [x] Countdown display in PlaylistPanel using `gameEndAt` epoch ms from WS `playlist_timer`
- [x] Periodic drift correction queries (60s interval) already running on activation

**Layer 3 (voting — backend complete, UX polish pending):**
- [x] Vote parsing: `/^\*(.+?) says: (\d)$/` regex, single digit, one vote per player, last wins
- [x] Vote options broadcast via `say` in-game with "mission" terminology; deadline countdown in sidebar
- [x] Tally on `voteDeadline` timeout or immediately when "Ending level." fires during active vote
- [x] Vote options visible in PlaylistPanel during voting state
- [ ] Repeat `say` reminder announcements at intervals during vote window
- [ ] Vote result toast / sidebar summary after tally

**Mission mode-compatibility (v0.4.17) ✅:**
- [x] `.mn3` scanner (`Mn3Scanner.ts`): HOG2 → `.msn` KEYWORDS → per-mode compat (spec Addendum A), mtime+size cache
- [x] Config tab: mission picker disables incompatible missions, details panel with mode badges, incompatible-pairing warning
- [x] Playlist validation: activation rejected (400 with per-entry reasons) when entries don't support the profile's Scriptname; rotate handler re-checks and skips incompatible entries instead of restarting into a failed game; PlaylistEditor shows per-entry ⚠ + summary against the selected profile

**Playlist rotation — best-effort stance (decided 2026-07):**

D3 has no native mission rotation: every playlist transition is a full server stop → config swap →
relaunch. This is inherently lossy — players must manually reconnect (D3 clients have no
server-initiated reconnect) and restart timing is not 100% reliable (port rebind, slow level
loads). **Rotation is officially best-effort**: we ship it as a convenience feature with clear
messaging, not a guaranteed-uptime mechanism. Remaining mitigations, in priority order:
- [x] Post-restart health check: telnet reconnect + `$servercaps` within a timeout, one automatic
      retry, then a WS alert + playlist auto-pause instead of a silent dead server. This is the
      one item that turns a bad rotation from "dead server nobody notices" into "visible failure."
      (v0.4.20: 120 s deadline, crash or failed spawn fails at once, paused status with reason +
      Resume; spec "Rotation Sequence" step 8.)
- [ ] Pre-rotation `say` countdown with explicit "server restarting — reconnect in ~30s" messaging
      so the disconnect is expected, not alarming.
- [ ] "Playlist health" line in PlaylistPanel showing entries skipped by the compat guard.
- Smooth in-place mission transitions are **out of scope**: they would require engine changes
  (project rule: the D3 server is a black box; unknown client compatibility fallout).

**Config Wizard (deferred):**
- [ ] "New Server Config" wizard: pick game type → form pre-fills sensible defaults for that mode
- [ ] autoexec.dmfc editor: simple list of DMFC commands to run at server start

### Step 7: Post-Start Settings ✅ (v0.4.20)

Settings that can't be set in cfg but Pyrodeck can apply after server launch:
- [x] Server HUD names (full/team/none) — send `$serverhudnames` after start
- [x] Kill message filter (full/simple/none) — send `$killmsgfilter` after start
- [x] Auto-save stats toggles — send `$autosavelevel`/`$autosavedisconnect` after start
- [x] Store these in Pyrodeck's own config per server profile, apply automatically on launch
      (`profiles.json` `postStart`; applied after every launch and playlist restart)

### Step 8: D3Server3 parity wave ✅ (v0.5.0)

From the ranked list in `docs/D3SERVER3_AUDIT.md` §3, rebuilt from scratch (no D3Server3 code). Spec §8.6-8.10 and
Addenda D (operations) and E (supervisor).
- [x] Supervisor: relaunch after a crash (backoff, gives up after 7 in 30 min), hang check (`$players` probe, kill at
      120 s), restart when empty after an uptime limit, re-attach after Pyrodeck restarts
- [x] Players: join/leave history with addresses (rationed `$playerinfo`), hosts.deny editor + `$rehash`, name bans,
      say-then-kick, nickname rules, profanity monitor
- [x] Profiles: launch options (`-useip`, `-useport`, `-framecap`, `-nomultibmp`, GameSpy), team and Hoard settings in
      the Startup Commands block, periodic commands, respawn scaled by players, join address
- [x] Operations: weekly schedule, email alerts, process priority, update notice, import from a launch script, service
      docs
- [x] One server event bus (`events/ServerEvents.ts`): one emitter per event; joins, leaves, chat and level starts from
      the console event hub only

Not in this wave (0.6.0 candidates): multi-server (audit rank 5; `ProcessManager` singleton → per instance, per-profile
`-autoexec` files); a playlist mission (repack a playlist's levels into one generated `.mn3` served by the mission
host, so clients follow rotations: the engine has no cross-mission switch, `MP_LEVEL_ENDED` carries only a level
index); tracker registration (tracker.h0m3.net and tsetsefly.de answer); operator commands on server events (audit
§3 item 20); stats processing.

---

## Phase 4 — Production Release (current focus)

**Goal:** First public release: repo public, tagged release with CI-built binaries, verified on
target platforms. Rotation ships as best-effort (see Phase 3 Step 6); Windows binaries ship
unsigned for now.

**Platform note:** Pyrodeck is cross-platform (Node.js). Linux is the primary dev/test
platform, but Windows is equally important — PiccuEngine servers are Windows-only currently.
Connect mode works with all D3 builds everywhere (vanilla 1.5, Matcen, PiccuEngine).
Launch mode works wherever the target D3 build runs. See DEVLOG for engine compatibility details.

### Already done (shipped v0.4.0–v0.4.10)
- [x] Static file serving in production (Fastify serves client build, `PYRODECK_STATIC_DIR` override)
- [x] Web admin auth (scrypt hash, cookie sessions, rate limiting, first-run setup, localhost exempt)
- [x] Packaging as single executable (Node SEA; Windows cross-compile; Tauri scaffold)
- [x] Network hardening (env-gated `trustProxy`, same-origin CORS, localhost-only first-run setup)
- [x] Release workflow (`.github/workflows/release.yml` — build-linux, build-windows, release jobs)

### Release checklist
- [x] Best-effort rotation hardening: post-restart health check + auto-pause (see Phase 3 Step 6;
      v0.4.20, verified live against a Matcen server: healthy rotation, and a crashing restart that
      retried once and paused)
- [x] Matcen contract sync (Matcen registry REL8, v0.4.20): parsers, tests and spec v2.8 match
      `PYRODECK_CONTRACT.md` §4; `$servercaps` keeps unknown feature flags (`teams`,
      `squad_orders`, `population`); Bots tab team choice gated on `teams`. A population panel waits
      for the fork's POP1 controls.
- [x] Mission download link refresh (Matcen registry REL7, v0.4.20): rewrite the `URL` lines
      inside a `.mn3`, backup once, restore; spec Addendum B
- [x] Mission host (v0.5.0): Pyrodeck serves the missions on its own port and points the link at
      itself; spec Addendum C. Open: a real game client downloading from it, and Windows
- [x] Server log path hardening (Matcen registry REL9, v0.4.20): absolute Log Directory validated on
      save, directory and file created before every launch, log re-checked while the server runs
- [x] Reverse-proxy hardening (v0.5.1): trust only the proxy hop, proxied requests never local,
      `Secure` cookie over HTTPS, per-client rate limit, cross-site Origin refusal, DNS-rebinding
      guard; launched consoles stay local with `AllowRemoteConsole=0`; `docs/behind-a-reverse-proxy.md`
- [x] Hardening (v0.5.2): real server-side sessions (random id per login, logout and "log out all sessions" revoke,
      12 h absolute and 120 min idle lifetimes, new id on login, `/ws` closed with its session); `PYRODECK_HOST`
      defaults to 127.0.0.1; opt-in game-server log retention (gzip closed logs, prune by age then total size,
      Pyrodeck's own file names only; a warning above 1 GB while it is off)
- [x] Unattended operation (v0.5.3): autostart of one profile when Pyrodeck starts (`PYRODECK_AUTOSTART_PROFILE` or
      the profile's "Start when Pyrodeck starts"), after re-attach, with a crash-loop guard over the supervisor's
      relaunches (spec Addendum F); the game server's environment built from an allowlist, never `PYRODECK_*`;
      `SHA256SUMS.txt` on every release and dry run
- [x] Node.js security rebuild (v0.5.4, 2026-10-21): the binary on Node.js 24.22.1 (four high-rated fixes; root
      store NSS 3.131.1 without the compromised eMudhra/emSign roots, which the OS trust store cannot fix for a
      Node SEA); `.nvmrc` pins the exact version so the release workflow and the packaging script agree
- [ ] Windows rotation E2E: live Windows + Matcen round-trip to confirm the rotation loop closes
      (profile-path fix is code-complete but unverified on Windows)
- [x] Go-public audit (2026-07-16, all clean): full-history scan across all 77 commits — no
      `.env`/config/log files ever committed, no API keys or private keys, no hardcoded password
      values (only D3's prompt-detection comment matches); `.gitignore` covers runtime config,
      logs, screenshots, scratch notes; LICENSE (MIT 2026), default branch `main`, repo
      description + topics set.
- [x] Release-readiness pass (2026-09-26, v0.4.19): release workflow fixed (had failed on every
      run: unpinned pnpm), Linux SEA binary fixed (was a silent no-op), dependency audit 72 → 0,
      Matcen 0.9.15 spec sync. Commit identity moved to the GitHub noreply address.
- [x] Rewrite history to the noreply author email before going public (2026-09-27, git-filter-repo;
      repository recreated so the old SHAs are gone)
- [ ] Flip repo public, push first release tag, verify CI pipeline end-to-end
      (dry run first: Actions → Release → Run workflow)
- [ ] Smoke-test CI artifacts: Linux tarball on Ubuntu LTS (binary starts, SPA loads, auth works,
      launch mode spawns D3), Windows .exe on a real Windows box
- [x] Release notes: include SmartScreen "More info → Run anyway" instructions (binaries are
      unsigned — signing via SignPath/Azure is out of reach for now, revisit post-release)
- [x] Issue template (`.github/ISSUE_TEMPLATE/bug_report.yml`): Pyrodeck version, OS/distro,
      D3 build, repro steps, logs (v0.4.20; blank issues disabled)

---

## Phase 5 — Docker & VPS Deployment

**Goal:** One-command VPS deployment with game file management.

- [ ] Docker image (Alpine) with `docker-compose.yml`
- [ ] Structured volumes: gamedata, config
- [ ] Web file manager (upload .mn3 missions, manage game files)
- [ ] Provisioning wizard (scan for required .hog files, validate, guide upload)
- [x] Document service setup for headless servers (`docs/running-as-a-service.md`, v0.5.0: systemd user unit, NSSM,
      `schtasks`)
- [x] Document a public server behind nginx with Let's Encrypt (`docs/behind-a-reverse-proxy.md`, v0.5.1)

---

## Phase 6 — Polish & Advanced Features

**Goal:** Refined UX and power-user features.

- [x] Responsive layout for mobile (v0.4.0 — phone/tablet/desktop breakpoints, sheet panels)
- [ ] Game tracker config UI (GameSpy port, tracker server list, PXO credentials)
- [x] IP access control UI: hosts.deny editor + `$rehash` (Bans tab, v0.5.0); hosts.allow not edited
- [ ] Repeat one level of a multi-level mission (D3Server3 "Loop"). Not expressible in `dedicated.cfg`: `SetLevel` only
      picks the first level (`dedicated_server.cpp:503-513`), and at level end the engine goes to `Multi_next_level` if a
      `$warp`/`SetLevel` set it, else the next level, wrapping after the last (`gamesequence.cpp:1929-1946`). Options: a
      one-level copy of the mission (D3Server3 rewrites the `.msn`; a changed `.mn3` must reach players too), or a
      one-entry playlist with a starting level (a server restart per level). Skipped in the D3Server3 parity wave
- [x] Scheduled auto-commands (D3Server3-style: run command every N minutes) — per-profile Periodic Commands (start lines + every N minutes; in order, random or all)
- [ ] Dark/light theme toggle
- [ ] Multi-server UI (tabs or sidebar, multiple D3 instances)
- [ ] Player list sorting/filtering
- [ ] CodeMirror for raw config editor
- [ ] Windows code signing (SignPath OSS or Azure Trusted Signing) — deferred, needs public repo
      + application process; until then SmartScreen warning is documented

---

## Tech Stack Reference

| Layer | Choice |
|-------|--------|
| Runtime | Node.js 20+ (dev on 24 per `.nvmrc`; packaged via Node SEA) |
| Backend | Fastify + TypeScript |
| Frontend | React 19 + Vite 8 + TailwindCSS v4 + shadcn/ui |
| Terminal | xterm.js (WebGL renderer, DOM fallback) |
| Config editor | Structured forms + raw textarea fallback (CodeMirror later) |
| Package manager | pnpm (monorepo workspaces) |
| Testing | Vitest |
| Packaging | Node SEA binary (`scripts/package-server.mjs`), Tauri app-mode scaffold |
