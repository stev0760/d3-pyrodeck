# D3 Pyrodeck — Specification

**Version:** 2.9
**Date:** October 8, 2026
**Author:** stev0760
**Repository:** `stev0760/d3-pyrodeck` (planned)
**Engine Fork:** `stev0760/Descent3` branch `feature/multiplayer-bots`

---

## 1. Project Overview

D3 Pyrodeck is a standalone web-based administration tool for managing Descent 3 dedicated servers. It communicates exclusively via the existing Telnet remote console (default port 2092), requiring zero modifications to game clients or the game protocol.

The tool is completely separate from the Descent 3 engine fork. It lives in its own repository and ships as its own artifact. No engine changes are required for the core tool to function — fork-specific features are auto-detected and gracefully disabled on vanilla servers.

### 1.1 Compatibility Targets

- Vanilla retail Descent 3 v1.5 dedicated servers
- Pre-open-source builds
- Piccu Engine servers (best-effort)
- `stev0760/Descent3` fork with multiplayer bots (enables full bot management UI)

### 1.2 Design Principles

- **No client modifications.** Retail D3 v1.5 clients connect and play normally with no awareness of the admin tool.
- **Graceful degradation.** Fork-specific features are auto-detected via `$servercaps`; vanilla servers get the full admin experience minus bot-specific controls.
- **Console-first UX.** The live console is the core of the product. Every other feature is built on top of it.
- **Minimal C++ footprint.** The fork adds server management capability without changing fundamental server behavior. No new terminators, no JSON output, no protocol changes beyond the commands listed in Section 5.
- **Extensible from day one.** Abstractions (transport layer, parser registry, session model) are designed for future growth without requiring rewrites.

### 1.3 Inspirations

- **D3Server3** (Thomas / dateiliste.com, originally by (DE)Hunter) — Windows GUI tool, the gold standard for D3 server management. The 3.0.83 binary, audited in `docs/D3SERVER3_AUDIT.md`, runs several servers at once, each launched from a stored configuration with its own `-autoexec` file and ports. It relaunches a server whose process dies, kills and relaunches one whose console stays silent for 120 s, restarts empty servers after an uptime limit, starts and stops servers on a weekly schedule, registers them with GameSpy-protocol trackers, and applies nickname rules and downloaded ban lists to joining players. Later releases add more, per the author's archived manual and release notes (`docs/D3SERVER3_AUDIT.md` §6; the last release is 3.2.3.0, 2014-10-22): a profanity filter with kick and ban thresholds (3.1.3.0), external commands run on server events (3.0.90 on), which is how it sent email (through Blat), a Windows service mode through `ServiceExe` (3.0.84, reliable from 3.0.85), and process priority for the tool and its servers (3.1.9.0). None of these is in the 3.0.83 binary. Many community installers bundled it. Our goal is to rebuild and modernize this experience as a cross-platform web app.
- **DD3 (Direct Descent 3)** (BitNix / Anders "BotNak" Larsson) — Windows GUI for Direct TCP/IP servers. Notable for: auto-hang detection + restart, dynamic IP re-publishing, web-based server listing at descent.dk, modem dial-up automation.
- **descent3console** (roncli) — Node.js module providing the most comprehensive programmatic API for D3 telnet interaction. Full EventEmitter-based parsing of all 9 game type scoring events, kill streaks, revenge tracking, efficiency stats. Reference implementation for our parser architecture.
- **descent3launcher** (roncli) — Node.js module for programmatic server launch with granular ship/weapon/powerup control. Reference for our Launch Mode config generation.
- **SOD (Server on Demand)** (SHIVA / descentforum.net) — Web-based on-demand server launch. The BOZ variant allowed configuring bot count and difficulty through a web form — closest historical precedent to our bot web admin.
- **Pterodactyl / Pelican Panel** — UX patterns for game server management.
- **PufferPanel** — Lightweight single-server management aimed at personal use.

---

## 2. Goals and Non-Goals

### Goals

- Provide a modern web dashboard for Descent 3 server management (console, players, bots, config).
- Auto-detect fork-capable servers via `$servercaps` and enable/disable UI accordingly.
- Support launching servers on Windows for casual users (auto-configure `dedicated.cfg`).
- Provide Docker support for VPS/24-7 hosting with a game file upload/provisioning flow.
- Deliver real-time updates via WebSocket.
- Operate in two modes: connect-only for remote servers, launch mode for local.

### Non-Goals

- Embedding the web server into the Descent 3 executable.
- Modifying the game network protocol or adding new ports.
- Building a multi-game server panel (this is purpose-built for Descent 3).
- Requiring users to install Node.js or other runtimes (ship as single binaries or Docker images).
- Handling game client connections (this is purely server-side administration).
- System tray integration or Electron wrapper.
- Real-time kill/score graphs from parsed output (fragile, low-value; backlog only).

---

## 3. Architecture

### 3.1 High-Level Flow

```
User Browser <--WebSocket--> D3 Pyrodeck Backend <--Telnet--> D3 Dedicated Server
              (React app)       (Node/Bun)            (port 2092)
```

1. User opens web app (e.g. `http://localhost:3000`).
2. Login gate: session password required (set via env var or config).
3. Connection form: enter D3 server host, Telnet port, console password.
4. Telnet login → send `$servercaps` → render UI based on capabilities.
5. Commands sent as text over Telnet; output streamed to browser via WebSocket.

### 3.2 Operating Modes

**Connect Mode** — Attach to any running D3 dedicated server via Telnet. The server can be on `localhost`, a LAN address, or a remote IP/hostname across the internet — the web admin is not limited to the same machine. Default mode; works with all server types. Users can save connection profiles (name, host, port) for quick reconnection to frequently-managed servers.

**Launch Mode** — Spawn a D3 dedicated server process locally, auto-generate config if missing, auto-connect Telnet after launch. Primarily for Windows LAN party use. Includes "Stop Server" for graceful shutdown.

### 3.3 Transport Abstraction

The Telnet connection is abstracted behind a `ServerConnection` interface so future transport options can be added without touching business logic.

```typescript
interface ServerConnection {
  connect(host: string, port: number, password: string): Promise<void>;
  send(command: string): Promise<void>;
  onData(callback: (data: string) => void): void;
  onDisconnect(callback: (reason: string) => void): void;
  disconnect(): Promise<void>;
  isConnected(): boolean;
}
```

The Telnet implementation uses a **command queue with timeout-based response collection**: send one command, wait for output to settle (~200ms of silence), then send the next. This prevents output interleaving from concurrent commands.

`$servercaps` is an exception — it is single-line and collected on the first `\n` after the command echo.

**Timing (Matcen spec, 2026-09-20).** The server prints the echo and the reply in the same call, so nothing can interleave between
them; what CAN happen is a late reply. The console is serviced once per server frame, and builds before Matcen 0.9.15
could stop running frames for seconds at a level start (9.5 s observed on Tower of Isengard, 100 s on HAVOC's DownTown)
while navigation data was built — a probe sent in that window timed out and the version was never read. 0.9.15 removes
the stalls, but the client should still not treat one timeout as "vanilla server": retry the probe a few times over
~30 s before disabling fork features, and accept a `SERVERCAPS` line whenever it arrives.

*Pyrodeck implementation (0.4.19, `session/probeCapabilities.ts`):* the first probe decides the connect result. A
non-empty reply without `SERVERCAPS` is a vanilla answer (no retries). An empty reply starts up to 5 background
re-probes (~30 s with the 5 s first-chunk wait); if fork caps arrive, the session is upgraded and a `capabilities`
WS message re-enables fork features without reconnecting.

### 3.4 Response Parsing

All console output parsing is handled by a `ResponseParser` module, separate from transport and UI logic. Parsers are registered per command and convert raw text into structured objects.

The parser starts as a pass-through (raw text displayed in console). Structured parsers are added incrementally as UI features require them. Each parser is independently unit-testable.

**Command echo stripping:** D3 echoes commands back prefixed with the client IP, e.g.:
```
[127.0.0.1] $servercaps
```
The parser must strip this echo line before processing the response.

### 3.5 Server instances

Each server Pyrodeck launches is one object, `servers/ServerInstance.ts`: its `ProcessManager`, the console login (the
session, the 5 s reconnect, the `quit` a stop sends), the console quit watch, the supervisor, autostart and its
crash-loop guard, the profile automation, the playlist rotation with its restart health check, the run record, and
the batching of process output for the browsers. `servers/ServerRegistry.ts` holds one instance per profile and one
for the global `dedicated.cfg` (Addendum H), each with its own playlist manager, its view of the event bus scoped to
its own events, and its run record; it checks every launch against the others under one lock, and decides which
server the routes and sockets of a single-server client mean (the default server). Each instance's console session
lives in the `SessionManager` it shares with the other servers and Connect mode; an instance only touches its own.

On a process state change the instance sends the buffered output first, then the state; forgets the loaded level;
fails a playlist restart that died while its health check waited, having first read whether the check was pending, so
the supervisor leaves that crash to the rotation; then stops the reconnect timer, removes the run record, and reports
the exit to autostart's guard before the supervisor. The per-event lines in Pyrodeck's log (`events/serverEventLog.ts`)
are subscribed to the bus before the instance, so they print first.

The instance takes its process, console transport, process checks and timings as options; `ServerInstance.test.ts`
runs it on a stand-in process and console, and `ServerRegistry.test.ts` runs three on one bus.

---

## 4. Tech Stack

| Layer | Choice | Notes |
|-------|--------|-------|
| Runtime | Bun or Node.js | Evaluate Bun `--compile` for packaging; fallback to Node SEA |
| Backend framework | Fastify | TypeScript-first, fast, good WebSocket support |
| Frontend | React + Vite + TailwindCSS + shadcn/ui | |
| Terminal emulator | xterm.js | ANSI support, scrollback, input history |
| Language | TypeScript | Non-negotiable throughout |
| Packaging (Windows) | Bun `--compile` or Node SEA | Single `.exe`, no Node install required |
| Packaging (Linux) | Native binary or Docker Alpine image | |
| Config editor | CodeMirror | Lighter than Monaco; switch if editing feels lacking |

---

## 5. Fork-Side Protocol Extensions

These are the only additions made to the `stev0760/Descent3` engine fork that the web admin depends on. The philosophy is minimal C++ footprint — add server management capability without changing how the server fundamentally works.

**Source of truth for output formats.** What the fork prints is owned by the Matcen repo's
`matcen-docs/PYRODECK_CONTRACT.md`; every Tier 1 line below is copied from it (verified against the fork
source at Matcen 0.9.16/0.9.17-dev, 2026-10-07). When the two disagree, the contract wins and this
section is the one to fix.

### 5.1 `$servercaps` — Capability Detection

**Purpose:** Allows the web admin to detect fork capabilities after connecting, and enable/disable UI features accordingly.

**Command:** `$servercaps`

**Response format:** Single line, no terminator required.
```
SERVERCAPS version=1 fork=Matcen fork_version=0.9.16 features=bots,roster,ships,difficulty
SERVERCAPS version=1 fork=Matcen fork_version=0.9.17 features=bots,roster,ships,difficulty,teams,squad_orders,population
```
The first line is Matcen 0.9.16; the second is the extended list the fork adopts from 0.9.17 (POP6;
`population` appears once the population controls are built). `fork_version` is always a clean
`X.Y.Z`: the fork's `-dev` suffix is never printed here.

**Feature flags (version=1):**

| Flag | Meaning | Web Admin UI Effect |
|------|---------|-------------------|
| `bots` | The `$` bot commands exist (`$addbot`, `$removebot`, `$removebots`, `$botlist`, `$botdifficulty`, `$botmode`, `$botstat`, `$botobj`, `$bothelp`) | Enable Bots tab and the Bots / Bot Debug command reference |
| `roster` | Bots come from a config-file roster (`BotConfig=`). (Older Pyrodeck builds read it as "`$scores` is parseable"; the fork settled on the roster meaning, 2026-10-01.) | None today; the Players panel is not gated on it |
| `ships` | `$addbot` takes a ship argument | Ship dropdown in the Add Bot form |
| `difficulty` | `$addbot` takes a difficulty argument; `$botdifficulty` exists | Difficulty dropdown in the Add Bot form |
| `teams` | `$addbot` takes a 4th, 1-based team argument (built in Matcen 0.8.6, advertised from 0.9.17) | Team dropdown in the Add Bot form, shown only in a team game (`$botmode` `teams>=2`) |
| `squad_orders` | The in-game `!` chat orders exist | None (players use them in chat) |
| `population` | The `$botpopulation` console controls exist | Not built yet; the flag is parsed and kept |

**Unknown flags are kept, never an error.** The parser stores every comma-separated flag in the
set, known or not, and ignores `key=value` fields it does not recognise, so a newer fork that adds a
flag or a field degrades to "that UI is hidden" rather than "vanilla server". Gate UI on `features=`,
never on `fork_version`.

**Vanilla server behavior:** Returns `Unknown command` or no response. Web admin detects this and sets all features to disabled. The general admin experience (console, config, standard commands) remains fully functional.

**Parser** (`packages/server/src/parser/parsers/servercaps.ts`):
```typescript
interface ServerCapabilities {
  version: number;           // 0 = vanilla/unknown
  fork: string;              // fork name (e.g., "Matcen"), empty on vanilla
  forkVersion: string;       // fork version (e.g., "0.9.16"), empty on vanilla
  features: Set<string>;     // empty set on vanilla; unknown flags kept
}

// A line whose first token is SERVERCAPS; the rest is read as key=value
// fields. version (numeric), fork and features are required; fork_version
// defaults to ""; unknown keys are ignored; empty feature tokens are dropped.
function parseServercaps(raw: string): ServerCapabilities | null;

// "Unknown command" or timeout → vanilla server
const VANILLA_CAPS: ServerCapabilities = { version: 0, fork: '', forkVersion: '', features: new Set() };
```

**Version field** enables future feature-gating without breaking older web admin clients.

### 5.1.1 Command Stability Tiers — Contract vs. Diagnostics

The fork's bot command surface is **two surfaces in one**: a stable management/handshake *contract*, and a
*diagnostic* surface that churns continuously as bot AI and navigation are debugged. Pyrodeck must treat them
differently or it will break on every fork bug-fix cycle. (Background: the 0.9.1 development cycle added, renamed,
and **removed** several nav debug commands; treating them as a contract caused repeated parser drift.)

**Anchor on `$servercaps`, never on command existence.** `$servercaps` is self-versioning (`version=`) and
capability-enumerating (`features=`). Gate UI on the `features=` set — *not* on whether a particular command
exists. Adding or removing a diagnostic command is invisible churn; a real capability change is reflected in
`features=`. This is the one part of the surface guaranteed stable across fork versions.

**Cardinal rule:**
- **Listing** a command in operator help / `CommandReference` is safe for **any** tier — it is just type-able text.
- **Parsing** a command's output or building a **UI panel/feature** against it is permitted **only for Tier 1.**

| Tier | Commands | Pyrodeck may… |
|------|----------|---------------|
| **1 — Stable contract** | `$servercaps` (anchor), `$addbot`, `$removebot`, `$removebots`, `$botlist`, `$botdifficulty`, `$botmode`, plus the vanilla `$scores` / player / team / settings commands in §5.3 | parse output, build UI, feature-gate |
| **2 — Semi-stable** | `$botstat` *status* line (line 1 only), `$botobj`, `$bothelp` | expose as console/help text; avoid hard output parsers |
| **3 — Volatile diagnostics (mid-flight)** | `$botstat` **nav: line** (`route:goal=… dijkstra=… boa=… gcost=… intent:room=… owner=… held=…`), the `$nav` namespace (bare `$nav` = toggle table, `$nav <name> on|off`, `$nav dump [file]` = nav-geometry JSON; flat aliases may be added or retired), `$botmov` | reference as text only — **zero** output binding |

**Tier 3 detail.** These commands exist to support active bot-AI/navigation debugging and change shape without
notice. Do not write parsers against them; mark any `CommandReference` entries for them as "format unstable — do
not parse." Skip the `$botstat` nav: line when parsing the status block (the status line is Tier 2).

**Removed commands — never reference.** `$navrouting`, `$flowfield`, `$potentialfield`, `$botpathfind`,
and `$botdispersal` were deleted in the earlier nav consolidation. The 0.9.11 retirement audit also
removed `$nav gridall`, `$nav outroute`, `$nav replan` and flat aliases `$gridall`, `$outdoorroute`,
`$stallreplan`. If an older Pyrodeck build references any of these, strip them.

**Hidden aliases — work, but never reference.** `$navdump [file]` (use `$nav dump [file]`) and
`$terrainsteer on|off` (use `$nav terrain on|off`; its usage line now reads
`Usage: $nav terrain on|off  (current: …)`), plus about 27 other flat toggle aliases (`$gridnav`,
`$navgrid`, ...). Pyrodeck's Command Reference lists only the `$nav` forms.

### 5.2 Bot Management Commands

These commands exist in the fork. The web admin sends them as plain text over Telnet and parses the output with timeout-based collection (~200ms silence window). Every reply is plain text, one line per message, with no terminator line. A listen-server host has no `$` bot commands; input that matches no bot command falls through to the game DLL.

**Callsigns** are `<name>[BOT]`, with **no space** before the suffix (Matcen `BOT_NAME_SUFFIX`). The base name is cut to 14 characters so the whole callsign fits D3's 19-character limit. Match bots on `[BOT]` alone; builds before 0.9.9 printed `Name [BOT]`, and Pyrodeck's parsers accept both.

**`$addbot <name> [ship] [difficulty] [team]`** *(Tier 1; parser `parsers/addbot.ts`)*
Arguments are positional: difficulty is read only when a ship was given, team only when a difficulty was given. The name is one whitespace-free token (the server splits on whitespace).
- Ship: `pyro`, `phoenix`, `magnum`, `blackpyro`, or a full ship name. An unknown ship first prints `Unknown ship '<ship>', using default. Valid: pyro, phoenix, magnum, blackpyro` and uses Pyro-GL.
- Difficulty: `trainee`, `rookie`, `hotshot`, `ace`, `insane`, or `0`–`4`. An unknown word becomes Hotshot silently (not the configured default).
- Team (`teams` flag): `1`–`4`, 1-based; anything else means auto-balance. In a team game, a team above the game's team count first prints `BOT: team <n> out of range for <teams>-team game — auto-balancing '<name>'` (the base name, without `[BOT]`; seen live 2026-10-07). In a free-for-all game the team is always auto.

Output on success: `Bot '<name>[BOT]' added in slot <N> (ship=<ship>, diff=<difficulty>, team=<T>)` — `team` is 1-based (`Players[].team + 1`), so a free-for-all bot prints `team=1`. Example: `Bot 'Phantom[BOT]' added in slot 2 (ship=Pyro-GL, diff=Hotshot, team=2)`.
Output on failure: `Failed to add bot (server full or max bots reached)`
Pyrodeck shows the failure line and either warning line as an error toast.

**`$removebot <index>`** *(Tier 1)*
Remove a specific bot by Bots[] index (0-based). Index comes from `$botlist` output, not the player slot.
Output on success: `Removing bot '<callsign>' from slot <N>`
Output on invalid index: `Invalid bot index <N>`
Output on no argument: `Usage: $removebot <index>`

**`$removebots`** *(Tier 1)*
Remove all bots. Output: `All bots removed`

**`$botlist`** *(Tier 1; parser `parsers/botlist.ts`)*
List active bots, one line per bot with two leading spaces:
```
  Bot 0: 'Phantom[BOT]' slot=2 ship=Black Pyro diff=Ace (alive)
  Bot 1: 'Viper[BOT]' slot=3 ship=Phoenix diff=Hotshot (dead)
```
No terminator — use timeout-based collection (~200ms silence). Empty list returns `No bots active`.
Fields: bot index, callsign, player slot, ship name (the game's name, which can contain a space: `Black Pyro`), difficulty name (`Trainee`, `Rookie`, `Hotshot`, `Ace`, `Insane`), alive/dead status.

**`$botdifficulty <index|all> <level>`** *(Tier 1)*
Change difficulty mid-game. `index` is a Bots[] index or `all` for every active bot.
Level: `trainee`, `rookie`, `hotshot`, `ace`, `insane` (also accepts `0`–`4`).
When `all`, also updates the default difficulty for future `$addbot` calls.
Output (single): `Bot <N> '<callsign>' → <difficulty>`
Output (all): `  Bot <N> '<callsign>' → <difficulty>` per bot (2 leading spaces), then `Default difficulty set to <difficulty>`
The arrow is the UTF-8 character U+2192, not `->`.
Errors: `Usage: $botdifficulty <index|all> <level>` plus `Levels: trainee, rookie, hotshot, ace, insane (or 0-4)`; `Invalid bot index <N>`.

**`$botmode`** *(Tier 1; parser `parsers/botmode.ts`)*
Print the detected game mode. Output: `Game mode: <MODE> (scriptname='<name>', teams=<n>)`. `<MODE>` is exactly one of `Anarchy`, `Team Anarchy`, `Robo-Anarchy`, `Co-op`, `CTF`, `Hyper-Anarchy`, `Hoard`, `Entropy`, `Monsterball`, `Unknown` (the fork's `BotGameModeName`). Two names contain a space and three a hyphen, so match the name up to ` (scriptname=`. Pyrodeck reads `teams=` to decide whether the Add Bot form offers a team choice.

**`$botstat [index|all]`** *(status line Tier 2; nav line Tier 3)*
Show bot status — usually **two lines per bot** (a status line and a navigation-diagnostic line):
```
  Bot 0 'Phantom[BOT]' slot=2 state=COMBAT role=Freelance lean=balanced speed=10.3 shields=100 target=Viper[BOT]
      nav: dest_room=5 num_paths=1 path=0/3 mdir|0.98| ahead:WALL d=12.3 ...
  Bot 1 'Viper[BOT]' slot=3 state=EXPLORE role=Attack lean=attack speed=51.6 shields=43 target=(none)
      nav: dest_room=7 num_paths=1 path=1/4 mdir|1.00| ahead:clear(>30u) ...
```
Status-line fields: `slot=` (player slot index), `state=` (`EXPLORE`, `HUNT`, `COMBAT`, `FLEE`, `EVADE`), `role=` (`Freelance`, `Attack`, `Defend`, `Follow`, `Cover` — TitleCase), `lean=` (`balanced`, `attack`, `defend`, `runner`, `flex`, or `?` for an out-of-range value), `speed=`, `shields=` (`-1` for a dead bot, seen live 2026-10-07), `target=` (a player callsign, which ends in `[BOT]` for a bot, `(robot)`, or `(none)`).
A bot with no object prints `  Bot <N> '<callsign>' slot=<N> (no object — respawning?)` instead. No match: `No bots active (or invalid index)`.
> **Tier:** status line = Tier 2 (semi-stable, OK to surface as text, parsed softly: non-matching lines are skipped); nav line = **Tier 3 (volatile — do not parse)**. See §5.1.1.

**`$nav` — navigation toggle/diagnostic namespace (0.9.5)**
Single entry point for the nav diagnostic surface. Bare `$nav` prints the live toggle table; `$nav <name> on|off` flips one toggle and prints `nav <name> <on|off> - <description>`; `$nav dump [file]` writes the nav-geometry JSON (default `navdump.json`, server working directory) and prints `Nav geometry dumped to '<file>' (see log for summary)` once the file is written. Toggle names churn every build (0.9.5 had 8; the 0.9.15+ table has ~26, e.g. `grid`, `bridge`, `grate`, `terrain`, `troute`, `mball`, `outdoorvia`; `route`, `bnodes` and `softhop` are gone) — Pyrodeck's Command Reference therefore takes the toggle name as free text and relies on bare `$nav` for the live list. Some sub-commands take values rather than on/off (e.g. `$nav mtenure <seconds>`, `$nav contend [index|all]`). Flat pre-0.9.5 names (`$terrainsteer`, `$navdump`, ...) remain as **hidden aliases** but are never referenced (§5.1.1).
> **Tier 3 (volatile, mid-flight).** The toggle set and JSON schema churn with nav development — list in the command reference but build zero output binding. See §5.1.1.

**`$botmov on|off`**
Toggle movement debug logging. No structured output. *(Tier 3 — diagnostic toggle; reference only.)*

**`$botobj`** *(Tier 2)*
Prints `Game mode: <MODE>` (no parenthesised part) and then the objective state, all to the console: flags and carriers, orbs, Hoard counts, Monsterball roles, Entropy labs, the co-op goal, per-bot roles and leans. (Before Matcen 0.9.16 most of this went to the server log only.) Show as text; no parser.

**`$bothelp`** *(Tier 2)*
Print bot command reference. For display in the web UI help panel only.

### 5.3 Standard Commands Used by the Web Admin

These are vanilla D3 commands (present in all D3 builds) that the web admin calls and may parse. This is a comprehensive list — not all need structured parsers; many are sent as-is with output displayed in the console.

#### Scoreboard & Player Info

**`$scores`**
Player scoreboard. Output format (timeout-based collection):
```
Pilot                Points K D S Ping
Viper[BOT]:          5      6 1 1 0
Shadow[BOT]:         4      6 2 2 0
Phantom[BOT]:        0      0 8 0 0
*Reaper[BOT]:        0      0 0 0 ---
```
- `*` prefix = observer/disconnected slot — exclude from active count
- Bot players identified by `[BOT]` suffix in name — match on `[BOT]` alone: Matcen emits it with **no** leading space (`Viper[BOT]`, verified live 2026-09-26 and in the fork contract); builds before 0.9.9 printed `Viper [BOT]`
- Hyper Anarchy formats score columns as `total[level]` (e.g. `1[1]`); parse the leading integer
- Ping `---` = no network connection (bots always show this)
- First line is the header; skip for data parsing
- Column layout varies by game type (anarchy shown above). Team anarchy, CTF, etc. have different columns. Parser should handle variable column counts gracefully.

**`$players`**
Human-readable player list. Used as a fallback if `$scores` parsing fails.

**`$playerinfo <pnum>`**
Detailed info for a player by player number (from `$players`): IP address, port, ship, team, time in game.

#### Player Management

**`$kick <pnum>`** — Kick a player by player number (from `$players`).
**`$ban <pnum>`** — Ban a player by player number (persists until removed or server restart).
**`$banlist`** — List currently banned players with index numbers.
**`$removeban <index>`** — Remove a ban by index from `$banlist`.

#### Team Management

**`$changeteam <pnum> <team_name>`** — Force a player to a different team by player number and team name.
**`$balance`** — Force-balance teams.
**`$setteamname <index> <name>`** — Set a team's display name.
**`$allowteamchange on|off`** — Toggle whether players can change teams.

#### Live Game Settings

**`$setmaxplayers <n>`** — Change max player count.
**`$setpps <n>`** — Change packets per second (5–20).
**`$settimelimit <minutes>`** — Change time limit (0 = unlimited).
**`$setgoallimit <n>`** — Change kill/score goal (0 = unlimited).
**`$setrespawntime <seconds>`** — Change respawn time.
**`$serverhudnames <none|team|full>`** — HUD name display level.
**`$statmsgs on|off`** — Toggle stat messages.
**`$wait [seconds]`** — Pause the game (optional duration).

#### Server Control

**`$endlevel`** — End the current level.
**`$warp <level>`** — Warp to a specific level number.
**`Quit`** — Graceful server shutdown. **Note: this is a CVar command, NOT a `$`-prefixed command.** Sent without the `$` prefix.
**`$help`** — Show built-in command list.

#### Post-start settings (v0.4.20)

Four DMFC options cannot be set in `dedicated.cfg`. Each server profile can store them in
`profiles.json` (`postStart: { hudNames?, killMsgFilter?, autoSaveLevel?, autoSaveDisconnect? }`,
edited under the profile's **After Launch** fields), and Pyrodeck sends them over the console after
every launch and playlist restart of that profile: `$serverhudnames full|team|none`,
`$killmsgfilter full|simple|none`, `$autosavelevel on|off`, `$autosavedisconnect on|off`. An unset
option sends nothing (the server keeps its default). Verified 2026-10-07 on a Matcen dedicated
server: each command is acknowledged (`*Server Max HUD Name Level: Team Only`,
`*Kill Message Filter: Simple`, `*AutoSave Stats on Level End: Off`,
`*AutoSave Stats on Disconnect: On`).

#### Additional DMFC Commands (not all need UI controls)

These exist in all D3 builds via the DMFC framework. Listed for completeness — the web admin may expose some of these in future phases:

**`$autobalance on|off`** — Toggle automatic team balancing.
**`$observer <pnum>`** — Force a player into observer mode.
**`$savestats`** — Manually save game statistics.
**`$autosavelevel on|off`** — Auto-save stats at level end.
**`$autosavedisconnect on|off`** — Auto-save stats on player disconnect.
**`$killmsgfilter <level>`** — Set kill message filter level.
**`$remoteadmin on|off`** — Toggle in-game remote admin ($remote) access.
**`$remoteadminpass <password>`** — Set in-game remote admin password.
**`$netgameinfo`** — Display current netgame configuration.

#### Network / Access Control

**`$rehash`** — Reload `hosts.allow` / `hosts.deny` IP filter files without restart. Useful for live banning by IP range.

#### Monitoring (passive output, no command needed)

The server emits unsolicited output for game events. The parser should recognize and categorize these for the console display (and optionally for future structured event feeds):

- **Kill messages**: `<killer> was killed by <killed>` (format varies by game type)
- **Join/leave**: player connection and disconnection messages
- **Chat**: `say` messages from players
- **Level transitions**: level start/end notifications
- **Stat saves**: auto-save confirmations

### 5.4 Response Collection Strategy

| Command | Terminator | Collection Strategy |
|---------|-----------|-------------------|
| `$servercaps` | None (single line) | Collect until `\n` after echo strip |
| `$botlist` | None | Timeout-based (~200ms silence) |
| `$botdifficulty` | None | Timeout-based (~200ms silence) |
| `$botstat` | None | Timeout-based (~200ms silence) |
| `$scores` | None | Timeout-based (~200ms silence) |
| All others | None | Timeout-based (~200ms silence) |

The command queue processes one command at a time. Concurrent commands are queued and dispatched serially to prevent output interleaving.

---

## 6. Session Model

Per-connection session state, keyed to allow future multi-server support without a rewrite.

```typescript
interface ServerSession {
  id: string;                        // UUID
  connection: ServerConnection;
  capabilities: ServerCapabilities;  // populated after $servercaps probe
  connectionInfo: {
    host: string;
    port: number;
    connectedAt: Date;
  };
  state: 'connecting' | 'probing' | 'ready' | 'disconnected' | 'reconnecting';
}
```

### Connection Lifecycle

1. User submits connection form (host, port, console password)
2. Telnet connect → authenticate with console password
3. Send `$servercaps` → parse `ServerCapabilities` → store in session
4. Transition to `ready` → notify frontend via WebSocket
5. Frontend enables/disables features based on capabilities

### Reconnection

On unexpected disconnect: back-off retry (1s, 2s, 4s, up to 30s). Notify frontend of `reconnecting` state. Do not re-prompt for credentials — use stored session info. On successful reconnect, re-run the `$servercaps` probe.

---

## 7. Features by Phase

### Phase 1 — Connect Mode MVP

Complete end-to-end loop: browser → server and back.

**Web UI Authentication**
- Login form gated by session password (env var or config file).
- No access to any functionality without authentication.
- Session token stored in cookie; configurable expiry.

**Connection Form**
- Host (IP address or hostname — `localhost`, LAN IP, or remote public IP), port (default 2092), console password.
- Connect/disconnect button; connection status indicator in header.
- **Saved Servers**: Save connection profiles (display name, host, port) for quick access. Console password is NOT saved (entered each time for security). Saved servers shown as a selectable list above the manual entry fields. Stored in the web admin's config file (`config/servers.json`).
- The D3 dedicated server must have Telnet remote admin enabled and the Telnet port reachable from wherever the web admin is running (firewall/port forwarding may be required for remote servers).

**Live Console**
- xterm.js terminal emulator.
- Full scrollback buffer.
- Command input with history (up/down arrow keys).
- Auto-scroll with "pinned to bottom" toggle.
- ANSI color support.
- Command echo displayed as typed.

**Server Probe**
- Auto-send `$servercaps` after successful Telnet login.
- Populate `ServerCapabilities` in session.
- Enable/disable tabs and controls based on feature flags.
- Display fork version info in header/sidebar if available.

**Players Panel** (requires `roster` feature flag)
- Parse `$scores` output into a player table.
- Show: name, points, kills, deaths, suicides, ping.
- Bot rows visually distinguished (identified by `[BOT]` suffix, ping `---`).
- Refresh button; auto-refresh on a configurable interval (default 5s).
- Action buttons per human player row: Kick, Ban.
- Ban list viewer: `$banlist` → table with Remove button per entry.
- Team controls (when teams are active): Change Team button per player, Balance Teams button, Set Team Names.

**Bots Tab** (requires `bots` feature flag)
- Add Bot form: name field, ship dropdown (if `ships` flag), difficulty dropdown (if `difficulty` flag).
- Active bot list from `$botlist`: index, name, slot, ship, difficulty, alive/dead status.
- Remove button per bot row (sends `$removebot <index>`).
- Remove All button.
- Difficulty change per bot or all (sends `$botdifficulty <index|all> <level>`).
- Bot detail from `$botstat`: state, speed, shields, target — shown on row expand or tooltip.

**Config File Editor**
- Raw text editor (CodeMirror) for `dedicated.cfg` and any other files in the configured config directory.
- File selector dropdown.
- Save button writes file contents via `PUT /api/config/files/:name`.
- Warning banner when server is running: "Changes will take effect after server restart."
- Path traversal protection: only files within the configured config directory are accessible.

**Game Settings Panel**
- Live settings controls (all vanilla commands, work on any server):
  - Max Players (`$setmaxplayers`)
  - PPS (`$setpps`) — slider, 5–20
  - Time Limit (`$settimelimit`) — minutes, 0 = unlimited
  - Goal/Kill Limit (`$setgoallimit`) — 0 = unlimited
  - Respawn Time (`$setrespawntime`) — seconds
  - HUD Names (`$serverhudnames`) — none/team/full toggle
- Server control buttons: End Level, Warp to Level, Quit Server.
- All commands also executable directly from the console.

### Phase 2 — Windows Launch Mode + Packaging

Can proceed in parallel with Phase 3 after Phase 1 ships.

- Spawn local D3 dedicated server process (`child_process` / Bun subprocess).
- Auto-generate minimal `dedicated.cfg` if not present.
- Setup wizard for first-run: locate D3 install, set config directory, set session password.
- "Stop Server" button for graceful shutdown (sends `$quit`, waits, then SIGTERM/TerminateProcess).
- Process state display (running / stopped / crashed with last exit code and timestamp).
- **Auto-restart on crash/hang** (inspired by D3Server3 and DD3):
  - Configurable: off, on-crash-only, or on-crash-and-hang.
  - Hang detection: Telnet keepalive probe every 30s. If 3 consecutive probes get no response, declare hang → kill and restart.
  - Configurable restart delay (default 5s) and max restart count (default 10, resets after 1hr of uptime).
  - Restart event logged with timestamp and reason.
- **Multiple server instances** — support launching and managing more than one D3 server on different ports/tempdirs. Each instance gets its own session, process monitor, and config. UI: instance tabs or sidebar list.
- Package as single Windows `.exe` (Bun `--compile` or Node SEA — evaluate during this phase).

### Phase 3 — Docker + Provisioning

Can proceed in parallel with Phase 2 after Phase 1 ships. Inspired by Pterodactyl/Pelican (egg-based provisioning, SFTP fallback), Crafty Controller (zip import wizard, structured Docker volumes), and PufferPanel (simple single-binary approach).

#### 3.1 Docker Deployment

- Docker image (Alpine-based) with the web admin binary baked in.
- `docker-compose.yml` for one-command VPS deployment.
- Structured volume layout:
  ```yaml
  volumes:
    - ./gamedata:/app/gamedata      # Shared retail game files (.hog, tables, etc.)
    - ./servers:/app/servers        # Per-server configs, missions, logs
    - ./import:/app/import          # Staging area for zip imports
    - ./config:/app/config          # Web admin config
  ```
- `gamedata/` is shared read-only across all server instances (like Pterodactyl's Mount concept — one copy of `d3-linux.hog` for N servers).
- `servers/<instance-id>/` contains per-server `dedicated.cfg`, `bots.cfg`, `missions/`, logs.

#### 3.2 Game File Provisioning

D3 retail game files (`.hog` archives) can be 200–600MB. Every mature game server panel (Pterodactyl, PufferPanel, AMP) acknowledges that web upload breaks down at this scale and recommends SFTP. We adopt the same two-tier approach:

**Tier 1 — Web File Manager (config files, missions, small uploads)**
- File browser UI for the server's managed directory (flat listing, click to navigate — like Pterodactyl, not a tree view).
- Operations: upload, download, rename, delete, create directory.
- Built-in text editor (CodeMirror, reused from Phase 1 config editor) for `.cfg`, `.txt` files.
- Drag-and-drop upload with progress indicator.
- **Server-side archive extraction**: upload a `.zip`, right-click → Extract. Critical for uploading mission packs or bulk configs. This is the primary workflow for directory uploads (HTML file input cannot upload directories).
- Practical upload size limit: ~100MB via web. Enforced server-side. Larger files → use SFTP or direct volume mount.

**Tier 2 — SFTP / Direct Volume Mount (game data, large files)**
- **Option A — Built-in SFTP server** (like Pterodactyl Wings / PufferPanel): The web admin runs a lightweight SFTP endpoint (port configurable, default 2023) authenticated with web admin credentials. Writes directly to the `gamedata/` or `servers/` volume. Recommended for uploading retail `.hog` files from a local machine to a remote VPS.
- **Option B — Direct volume mount** (simplest for Docker): User places game files directly in the `./gamedata/` host directory before or after starting the container. No upload needed — just `scp` or copy the files. The provisioning UI detects them.
- **Option C — Zip import** (like Crafty Controller): Upload a zip of a D3 installation to the `import/` staging volume (via SFTP or direct copy). The web admin UI lists staged zips, lets the user select one, previews contents, and extracts game files to the correct locations.

#### 3.3 Provisioning Wizard (First-Run)

On first connection (or when required game files are missing), the web admin shows a setup wizard instead of the main dashboard:

1. **Check game files**: Scan `gamedata/` for required files. Display checklist with status:
   - `d3.hog` — **Required** (base game data archive)
   - `d3-linux.hog` or `d3-win.hog` or `d3-osx.hog` — **Required** (platform-specific game data)
   - `extra.hog` or `extra1.hog` — **Required** (shared assets; Steam uses `extra1.hog`, GOG/retail use `extra.hog`)
   - `extra13.hog` — Optional (v1.3 patch content including Black Pyro ship)
   - `missions/` — Optional (custom `.mn3` mission files)
   - `netgames/` — **Required** (multiplayer game mode shared libraries: `anarchy.so`/`.dll`, `ctf.so`/`.dll`, etc.)
   - Note: Table files (`.gam`) are packed inside the HOG archives — they are not separate loose files.
2. **Upload prompt**: For each missing file, show upload button (web) or display SFTP/volume-mount instructions with the exact path.
3. **Validation**: Verify file integrity (check HOG magic bytes, expected file sizes). Reject corrupt uploads before they waste time.
4. **Config generation**: Auto-generate a minimal `dedicated.cfg` if none exists (`GameName`, `MaxPlayers`, `Scriptname`, `MissionName`, `BotConfig`).
5. **Server start gate**: "Start Server" button only enabled when all required files are present and validated.

Status endpoint: `GET /api/setup/status` returns provisioning state (which files are present/missing/invalid).

#### 3.4 Mission Pack Management

- Upload `.mn3` mission files via web file manager or SFTP to `servers/<id>/missions/`.
- Mission list endpoint: `GET /api/missions` scans the missions directory.
- Upload endpoint with `.mn3` extension validation.
- Future: parse MN3 headers to display mission name, author, player count (reference: roncli's `descent3-mn3-tools` npm module).

### Server Playlists & Mission Voting

**Key feature.** D3 dedicated servers can only run one `.mn3` mission file at a time. Pyrodeck implements mission rotation at the process level: it monitors server stdout for level-end signals, swaps the `MissionName=` CVar in the active profile's config file, and restarts the server.

#### Playlist Modes
- **Sequential** — cycle through entries in order, looping back to the first
- **Shuffle** — Fisher-Yates shuffle; reshuffle on each full loop
- **Weighted** — random draw by relative weight (e.g., `weight: 3` means 3× more likely to be drawn)

Each entry specifies a display label, the `.mn3` mission filename, and an optional starting level within the mission.

#### Level-End Detection
D3 dedicated server prints `"Ending level."` to stdout at the end of every level. Pyrodeck buffers stdout in 4KB chunks and splits on newlines before matching, so the signal is never missed due to chunk boundaries. `"Mission over. Looping back to first level..."` is also detected (full `.mn3` cycle).

#### Rotation Sequence
1. `"Mission over."` fires (after `"Ending level."`) → rotation triggered
2. If a vote is in progress, immediately tally votes and use winner; otherwise advance the playlist index per mode
2a. **The hold (v0.5.6)**, when the playlist's `holdSeconds` (default 30, 0-120) is above 0 and a human may be
   on (the supervisor's roster: one or more humans, or not known yet): status `holding`. The server loads the
   mission's first level again; at its `"Opening level"` line plus 3 s (or 20 s after the mission end if the line
   never comes) Pyrodeck sends `$wait on` (DMFC: every client's ship and weapons frozen, the real game time paused,
   "Waiting for server" on screen; a client joining then is frozen too). The countdown in chat starts at the first
   human's join line after that (the client has left the score screen and loaded the level), or 45 s after
   `$wait on`: then the restart at `holdSeconds`. If the roster is empty when the 45 s run out, the restart comes at
   once. A human who joins during the countdown with 8 s or more left is told the time left. During the hold the loop-back level gets no timer anchor, announces or vote. A rotation the
   launcher calls off (an incompatible entry, a missing path), a deactivation or pause, or a manual start or stop
   sends `$wait off`. `playlist_status` carries `holdEntry` and `holdEndsAt` (null until the countdown starts).
3. Announce next mission in-game: `say Changing mission to <label>` (filtered: printable ASCII, no `%`, no colon)
4. `processManager.stop()` — graceful quit → SIGTERM → SIGKILL fallback. The quit is `quit` sent with a half-close
   (`TelnetConnection.quit`, v0.5.6): the server sends every client its quit message, and our FIN goes first, so the
   TIME_WAIT is ours and the console port is free for the relaunch. Never a full close before the server's: the
   console echoes each byte it reads, and an echo into a closed socket ends a server that does not ignore SIGPIPE
   (every build before Matcen 0.10.16) before the quit runs. The session is dropped after the server has closed it
5. `ensureConfigReference("MissionName", missionName)` patches the active profile's `.cfg` file in place
6. `processManager.start()` — new D3 process with updated config
7. Pyrodeck auto-reconnects via telnet (same `registerAutoConnect()` flow as normal launch)
8. **Health check (v0.4.20):** the restarted server must accept the console login and answer
   `$servercaps` (any answer, or fork caps from the background re-probe) within 120 s of the spawn.
   A crash during startup, a failed spawn or a refused login fails the attempt at once. One
   automatic retry (stop whatever is left, relaunch the same config, appending to the same log);
   if that also fails, the playlist is **paused**: status `paused` with a `pausedReason`, an error
   toast, and a red notice with a Resume button in the sidebar. A paused playlist ignores level
   ends and opens no votes; the pause survives a Pyrodeck restart (`playlist-state.json`). Resume
   (`POST /api/playlists/resume`) does not relaunch the server; the operator launches it. Starting or
   stopping the server by hand during the check cancels it. A profile config without a remote
   console now pauses the playlist instead of leaving the server stopped without a word.
   `GET /api/playlists/status` and `playlist_status` carry
   `rotationCheck: { state: "idle"|"relaunching"|"waiting", attempt, maxRetries, deadline }`.

#### Position across a Pyrodeck restart
`playlist-state.json` holds `{ activePlaylistId, currentIndex, shuffleOrder, paused, pending }`. `currentIndex` is
the entry the server runs, `shuffleOrder` the rest of the shuffle round. `pending: { kind, since }` is set while that
entry is not the server's yet: `activation` (activated, not loaded), `hold`, or `restart` (handed to the launcher at
`since`, not healthy yet). The file is written whole and renamed into place, in order, at activation, at a hold's
start, at the hand-off, at the healthy restart (or a rotation called off), at a hold called off, at a launch that
loads the entry, and at pause, resume and deactivation.

After a restart, with no `pending` the next mission end goes to the entry after `currentIndex`. With `pending`, the
entry comes next. The first console login to a re-attached server (E.5) settles it from the server's start time:
- `restart`, server started at or after `since`: the restarted server, which runs the entry; nothing to do.
- `hold`, or `restart` with a server started before `since` (Pyrodeck stopped before the old server did): its
  mission is over and it may be held, so the restart into the entry happens at once (`say Changing mission`, `quit`,
  relaunch), with no second hold and no timer anchor. A rotation then called off sends `$wait off`.
- `activation`: the server's mission end loads the entry, as without the restart.

With no server to re-attach to, the next launch (autostart or the Launch button) starts the entry.

#### Mission Voting
Voting is chat-based — backwards-compatible with all D3 builds, no client mod required. Players vote by typing a single digit in all-chat; Pyrodeck parses `*PlayerName says: N` from stdout.

**Conditions for voting:** Time-limited game (`Timelimit > 0`) with no kill goal (`Killgoal == 0`). Without a predictable end time, voting can't be scheduled.

**Flow:**
1. Server queries `$netgameinfo` on playlist activation; anchors `gameEndAt = now + timeLeft`; drift-corrects every 60 seconds
2. At `timeLeft - preAnnounceSeconds` (default: 120s before end), Pyrodeck broadcasts options via `say`:
   ```
   Vote for next mission! Type a number in chat:
    1 = Skybox
    2 = Polaris
    3 = Entropy
   ```
3. Players type `1`–`N` in chat during the `voteOpenSeconds` window (default: 60s). One vote per player (a player's latest vote replaces their earlier one). When options tie, the lowest-numbered option wins (first-option-wins)
4. If `"Ending level."` fires during voting, Pyrodeck immediately tallies and uses the winner
5. Winner is announced: `say Next mission: <label>`. Rotation proceeds with winner as next entry

**Vote parsing:** `/^\*(.+?) says: (\d)$/` — matches messages whose *entire content* is exactly one digit. `"I got 1 kill"` does not match; `"1"` does. "Mission" terminology used throughout (never "map").

#### Timer Architecture
- `gameEndAt` epoch milliseconds broadcast as `playlist_timer` WS message
- Frontend countdown ticks every second in `PlaylistPanel`
- `$settimelimit` commands intercepted and forwarded to PlaylistManager for live correction
- Voting state (`voteOptions`, `voteDeadline`) broadcast as WS messages; sidebar shows live vote options

### Phase 4 — Polish + Advanced Features

Depends on Phase 1. See `BOT_MANAGEMENT.md` in the fork for bot config format reference.

- Player list with improved display (sort/filter by kills, deaths, ping).
- Structured config forms: server name, max players, time limit, game mode, allowed ships, weapon/powerup restrictions — read/write `dedicated.cfg` cleanly.
- Ship/weapon/powerup allow/disallow UI — checkboxes for each item, generates correct `AllowPowerUp=` / `DisallowPowerUp=` config entries. Reference: `descent3launcher`'s granular defaults (omega off due to framerate bug, mines/cloak/invuln off for latency).
- Bot preset management: save/load named bot configurations (roster files).
- Bot difficulty UI tied to fork difficulty tiers (Trainee/Rookie/Hotshot/Ace/Insane) — already implemented in fork Phase 5.2.
- **IP access control UI**: Edit `hosts.allow` / `hosts.deny` files through the config editor, with a "Reload" button that sends `$rehash`. *(hosts.deny: built as the Bans tab, §8.8; hosts.allow is shown read-only.)*
- **Server profiles**: Save/load named server configurations (like D3Server3's multi-config and DD3's .dd3 save/load). Each profile stores the full `dedicated.cfg` + bot roster + launch parameters.
- **Game tracker registration**: Configure tracker URLs for PXO, descent.cx, and other community trackers. Reference: D3Server3 supported up to 5 trackers; `descent3launcher` defaults to 5 (kali, descent.cx, descentservers.net, tsetsefly.de, qtracker).
- Dark/light theme toggle.
- Responsive layout for mobile.
- Multi-server UI (tabs or sidebar) — session model already supports this.

---

## 8. API Surface

All REST endpoints are prefixed with `/api`. WebSocket endpoint is `/ws`.

### 8.1 Authentication

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/auth/login` | Authenticate; starts a new session (the browser's previous one ends) and sets the `pyrodeck_session` cookie |
| `POST` | `/api/auth/logout` | End this session on the server and clear the cookie |
| `GET` | `/api/sessions` | `{ ttlHours, idleMinutes, sessions: [{ createdAt, lastSeenAt, expiresAt, idleExpiresAt, ip, userAgent, current }] }`, most recently used first; never the ids |
| `DELETE` | `/api/sessions` | End every session, the caller's included; `{ ok, revoked }`. Their `/ws` sockets close with 4401 |

### 8.2 Server Connection

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/server/connect` | Connect to D3 server (host, port, password); replaces Connect mode's session only |
| `POST` | `/api/server/disconnect` | Disconnect Connect mode's session, else the default server's console (Addendum H.7) |
| `GET` | `/api/server/status` | The default server's connection state + cached capabilities |
| `GET` | `/api/servers` | Every server Pyrodeck runs; `/api/servers/:serverId/...` acts on one (Addendum H.7) |
| `GET` | `/api/servers/saved` | List saved server profiles |
| `POST` | `/api/servers/saved` | Add/update a saved server profile (name, host, port) |
| `DELETE` | `/api/servers/saved/:id` | Delete a saved server profile |

### 8.3 Commands

Console commands flow through the WebSocket (`/ws`), so their output streams back as it arrives;
`POST /api/servers/:serverId/command` sends one and returns the reply (Addendum H.7). With protocol 2 (a `hello`), a
server's messages carry `serverId` (Addendum H.8).

**WebSocket message types:**

```typescript
// Client → Server
{ type: "hello",   payload: { protocol: 2 } }
{ type: "command", payload: { command: string; serverId?: string } }

// Server → Client
{ type: "output",                payload: { raw: string; parsed?: StructuredResponse } }
{ type: "connection_state",      payload: { state: ServerSession['state'] } }
{ type: "capabilities",          payload: ServerCapabilities }
{ type: "players",               payload: ParsedScores }
{ type: "bots",                  payload: ParsedBotList }
{ type: "botmode",               payload: { mode: string; scriptName: string; teams: number } }
{ type: "serverinfo",            payload: NetGameInfo }
{ type: "process_state",         payload: { state: "running" | "stopped" | "crashed" | "starting" | "stopping" } }
{ type: "process_output",        payload: { stream: "stdout" | "stderr"; data: string } }
{ type: "playlist_status",       payload: PlaylistStatus }
{ type: "playlist_timer",        payload: { gameEndAt: number | null } }
{ type: "playlist_rotate",       payload: { entry: PlaylistEntry } }
{ type: "playlist_vote_announce",payload: { options: VoteOption[]; timeoutMs: number; deadline: number } }
{ type: "playlist_vote_result",  payload: { winner: PlaylistEntry; counts: number[] } }
```

### 8.4 Playlists

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/playlists` | List all playlists |
| `POST` | `/api/playlists` | Create playlist (`name`, `mode`, `entries[]`) |
| `GET` | `/api/playlists/:id` | Get playlist by ID |
| `PUT` | `/api/playlists/:id` | Update playlist (the active one with other missions: hosts them, Addendum C.4) |
| `DELETE` | `/api/playlists/:id` | Delete playlist |
| `POST` | `/api/playlists/:id/activate` | Activate playlist (starts rotation on next level end); returns `{ ok, status, downloads }` (C.4) |
| `POST` | `/api/playlists/deactivate` | Deactivate current playlist |
| `GET` | `/api/playlists/status` | Current PlaylistManager status, `downloads` included (C.4) |

`PlaylistEntry: { id, label, missionName, startingLevel?, weight? }`
`PlaylistVoting: { enabled, preAnnounceSeconds, voteOpenSeconds, optionCount }`
`Playlist: { id, name, mode ("sequential"|"shuffle"|"weighted"), entries[], voting, createdAt, updatedAt }`

### 8.4.1 Game Files: missions

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/game-files/missions?profileId=&details=1` | `.mn3` list; with `details=1`, per-mission metadata, mode compatibility, `urls` and `urlBackup` (Addenda A, B) |
| `PUT` | `/api/game-files/missions/:file/download-url` | Body `{ url, profileId? }`: rewrite the mission's download link (Addendum B) |
| `POST` | `/api/game-files/missions/:file/download-url/restore` | Body `{ profileId? }`: put the original `.mn3` back and delete the backup |
| `POST` | `/api/game-files/missions/:file/download-url/host` | Body `{ profileId? }`: set the link to `<publicBaseUrl>/missions/<file>` (Addendum C) |
| `GET` | `/api/mission-host` | `{ settings: { enabled, port, publicBaseUrl }, status: { enabled, port, bound, error, publicBaseUrl, missionsDir } }` |
| `PUT` | `/api/mission-host` | Body `{ enabled, port, publicBaseUrl }`: validate, save, start/stop/move the listener; returns `{ settings, status, warnings, downloads }` (`downloads`: C.4, null unless the active playlist was hosted) |
| `POST` | `/api/mission-host/test` | Body `{ file }`: fetch the mission through the public base URL from the Pyrodeck machine; `{ ok, url, status, contentLength, bytes, matches, elapsedMs, error }` |

`details=1` entries carry `linkError` for a mission that takes no new link (retail or stock, C.4). With the host on,
they also carry `hostUrl` (the link the host serves the mission at) or `hostError` (why it cannot: retail, stock,
too long, another game path). `GET /api/launcher/status` carries
`missionHost` (the status object above).

### 8.5 Config Files (Phase 1)

Phase 1 uses a simplified config file API scoped to the config directory only. Phase 3 replaces this with the full file manager (Section 8.5) but this endpoint remains for backwards compatibility.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/config/files` | List config files in configured directory |
| `GET` | `/api/config/files/:name` | Read file contents |
| `PUT` | `/api/config/files/:name` | Write file contents |

Path sanitization enforced — reject any `name` containing `..` or path separators. Only files within the configured config directory are accessible.

### 8.5 File Manager (Phase 3)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/files` | List directory contents (query: `path=/`) |
| `GET` | `/api/files/content` | Read file contents (query: `path=/foo.cfg`) |
| `PUT` | `/api/files/content` | Write file contents (query: `path=/foo.cfg`) |
| `POST` | `/api/files/upload` | Upload file (multipart, query: `path=/missions/`) |
| `POST` | `/api/files/mkdir` | Create directory |
| `DELETE` | `/api/files` | Delete file or directory |
| `POST` | `/api/files/rename` | Rename/move file or directory |
| `POST` | `/api/files/extract` | Extract archive server-side (`.zip`) |

Path sanitization enforced on all endpoints — reject `..`, absolute paths, symlink traversal. All paths relative to the server's managed root directory. Max upload size configurable (default 100MB); larger files should use SFTP or direct volume mount.

### 8.6 Setup / Provisioning (Phase 3)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/setup/status` | Provisioning state (checklist of required files: present/missing/invalid) |
| `GET` | `/api/missions` | List installed mission files with metadata |
| `POST` | `/api/setup/import` | Import from staged zip in `import/` volume (body: `{ zipName, targetDir }`) |

### 8.6 Launcher (Phase 2)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/launcher/start` | Start local D3 dedicated server process |
| `POST` | `/api/launcher/stop` | Stop local server (graceful) |
| `GET` | `/api/launcher/status` | Process state (running / stopped / crashed), plus `missionHost`, `supervisor` (Addendum E) and `autostart` (Addendum F) |
| `PUT` | `/api/launcher/config` | Update `dedicated.cfg` settings |
| `GET` | `/api/launcher/supervisor` | Supervisor settings and state (Addendum E) |
| `PUT` | `/api/launcher/supervisor` | Save supervisor settings (fields left out keep their value); applies at once |
| `POST` | `/api/launcher/supervisor/cancel-relaunch` | Drop a pending relaunch (409 when none) |
| `GET` | `/api/launcher/autostart` | `{ env, settingProfileId, effective: { source, profileId, profileName, error } \| null, run }`: the profile that starts with Pyrodeck and this run's autostart state (Addendum F, v0.5.3) |
| `POST` | `/api/launcher/autostart/cancel` | Drop a pending retry of a failed autostart launch (409 when none) |
| `GET` | `/api/profiles/:id/join-address` | `{ host, port, address, hostSource: "setting"\|"bind-address"\|"mission-host"\|null, lanOnly }`: what players join the profile's server at (v0.5.0) |

**Join address (v0.5.0).** `port` is the profile's `launchOptions.gamePort`, else `D3_DEFAULT_PORT` 2092
(`Descent3/descent.h`). `host` is the first of: the global `joinHost` setting (`PUT /api/pyrodeck/config`
`{ joinHost }`, a host name or IPv4 address without scheme, port or path; empty clears it), the profile's `bindIp` when
it is public, the host of `missionHost.publicBaseUrl`, the `bindIp` when it is a LAN address. `lanOnly` marks a loopback
or private host. The Launch panel shows `address` with a Copy button and edits `joinHost` in place.

**Server log safety (v0.4.13, hardened v0.4.20; Matcen registry REL9).** Each launch logs to an
auto-named file (`<profile>-<UTC timestamp>.log`) in the Log Directory (default: next to the
executable). Saving a Log Directory requires an absolute path that is, or can be created under, a
writable directory. Before a launch, Pyrodeck creates the directory and the log file itself; a
failure refuses the user-started launch (400) and is announced on a playlist restart (which still
restarts the server). After launch, `GET /api/launcher/status` carries
`log: { path, state: "none"|"pending"|"ok"|"failed", message }`: `ok` once the file holds output
(first check about 8 s after launch), `failed` on a stream error, an empty or missing file, or a
file deleted, moved or replaced while the server runs (re-checked every 30 s). A failure also
raises an error toast; the Launch panel keeps it on screen until the next launch.

**Log retention (v0.5.2, `launcher/logRetention.ts`), opt-in.** Off by default (days 0, maxMb 0,
compress false): an upgrade deletes and compresses nothing. At startup (after 5 s), every hour and after
`PUT /api/logs/retention`, in the Log Directory and the folder of the last launch's log: (1) delete
Pyrodeck's logs last written more than `days` ago, (2) gzip each closed `.log` to `.log.gz` (written
as `.log.gz.partial`, synced, given the original's times, renamed; the original is kept if it changed
meanwhile), (3) delete the oldest until the total is at most `maxMb`. Only names matching
buildLogFilename's output (`^[a-z0-9_-]{1,48}-YYYY-MM-DDTHH-MM-SS\.log(\.gz)?$`, a real UTC time) and
regular files (lstat; never symlinks) are touched. The running server's log and files written in the
last 10 minutes are never compressed or deleted. Each deletion and compression is logged at info.
With days and maxMb both 0, a run only measures: when Pyrodeck's logs there take more than 1 GiB it
warns (log and `lastRun.warning`) with the total, the directories and the variables to set.
Settings `{ days, maxMb, compress }` (default 0, 0, false; recommended 30, 2048, true; 0 turns a limit
off) live in `pyrodeck.json` `logRetention`; `PYRODECK_LOG_RETENTION_DAYS`, `PYRODECK_LOG_MAX_MB` and
`PYRODECK_LOG_COMPRESS` (1/0) win over them, and a malformed value stops startup.
`GET /api/logs/retention` returns `{ settings (in force), stored, env: { days, maxMb, compress } (null
when unset), dirs, lastRun }`; `lastRun` is `{ at, compressed, deleted, freedBytes, files, totalBytes,
errors, warning }`. `GET /api/logs` items carry
`compressed`; `GET /api/logs/:name` decompresses a `.log.gz` (with `?tail=1`, the last 256 KB and
`X-Log-Truncated`/`X-Log-Total-Size` of the decompressed text) and `?download=1` sends the `.gz` as is.

**Profile settings (v0.5.0).** `PATCH /api/profiles/:id` takes, besides the metadata and `postStart`:

| Field | Shape | Effect |
|-------|-------|--------|
| `launchOptions` | `{ bindIp?, gamePort?, frameCap?, noMultiBmp?, gameSpyPort?, gameSpyFile? }` or `null` | Flags after `-dedicated <cfg>`: `-useip`, `-useport`, `-framecap`, `-nomultibmp`, `-gamespyport`, `-gspyfile` |
| `teamSettings` | `{ allowTeamChange?, autoBalance?, teamNames?: { red?, blue?, green?, yellow? }, hoardMinOrbs? }` or `null` | Lines in the Startup Commands block at launch: `$allowteamchange on\|off`, `$autobalance on\|off`, `$setteamname <0-3> <name>`, `$mincount <1-12>` |
| `respawnScaling` | `{ enabled, minSeconds, maxSeconds, playersForMin }` or `null` | `$setrespawntime` from `maxSeconds` (two humans or fewer) down to `minSeconds` (at `playersForMin`, 3-32), linear between; 1-10000 s |
| `periodicCommands` | `{ enabled, startLines: string[], lines: string[], intervalMinutes, mode: "all"\|"sequential"\|"random" }` or `null` | Console lines: `startLines` once per launch when the console session is ready, `lines` every `intervalMinutes` (1-1440) |

Invalid values are refused with 400 and `details: string[]`; the stored profile is untouched. The response is the
profile plus `warnings: string[]`, problems that do not block the save. Saving launch options checks the profile's game
(UDP), GameSpy (UDP) and console (TCP, `RemoteConsolePort` from its config file) ports against every other profile and
against Pyrodeck's own and the mission host's TCP ports; `PUT /api/profiles/:id/structured-config` runs the same check
and returns `{ ok, warnings }`.

Launch option rules, from the engine source (`packages/server/src/launcher/launchOptions.ts` cites each line):
`bindIp` is a dotted IPv4 literal (`inet_addr`; a host name would be ignored, `255.255.255.255` is `INADDR_NONE`), and
since the server binds its console to it too, Pyrodeck's readiness probe and auto-connect go to that address instead of
loopback. Ports are 1-65535 (defaults: game 2092, GameSpy 20142). `frameCap` is 1-999 frames per second (default 60;
0 divides by zero in `init.cpp`). `gameSpyFile` is a plain file name in the game directory.

Team settings ride in the Startup Commands file because DMFC reads exactly one startup script (`ParseStartupScript`,
`netgames/dmfc/dmfcbase.cpp`), after its saved settings, so they apply before any player joins. At each profile launch
and playlist restart `ProcessManager.start` rewrites the block between `# pyrodeck: begin` and `# pyrodeck: end` at the
end of `<gamePath>/autoexec.dmfc` (`launcher/autoexecBlock.ts`): idempotent, operator lines and line endings kept, the
block removed when nothing is set, the file created only when there is a block to write. DMFC runs the marker lines as
the unknown command `$#`, which it ignores. Team names are one word of at most 15 characters (DMFC parses one word into
`MAX_TEAMNAME_LEN` 16); `$mincount` exists only in Hoard (1-12) and other game types ignore it; the open-source Hoard has
no maximum. DMFC saves allow-team-change and auto-balance in the engine's preferences when a game ends, so an unset
value means what the last server on the machine left. Verified on the Matcen Debug build: `*Allow Team Changing: On`,
`*Auto Team Balance: On`, `Red changed team name to Crimson`, `*Hoard Orb Score Minimum Count Set To 3`, after the
operator's own `$statmsgs on` (`*Statistical Messages: On`).

Periodic commands (`launcher/periodicCommands.ts`, `launcher/profileAutomation.ts`) follow one server run:
`ProcessManager.start` emits `server.started` (`{ profileId, pid, args, reason }`) for every launch, by hand, by a
playlist, the supervisor or the schedule; the automation loads the profile's settings and waits; when the launch's
auto-connect session is ready it sends the start lines, then a round every interval over that session, skipping rounds
while the connection is down. Every new login (a reconnect after the link dropped) hands the run the new session; the
start lines still go once per run. `server.adopted` (Pyrodeck re-attached to a running server after its own restart)
starts a run without the start lines, and respawn scaling first reads who is on with one `$players`. The run ends on
the process's exit (and on `server.stopped`/`server.crashed` from the bus); a second `server.started` for the same pid
is ignored. Lines must start with `$` or `say `, be printable ASCII and at most 200 characters (the
`Say` cvar's limit, `dedicated_server.cpp:181`; the console drops lines past 254 bytes, `:1656`). A round sends at most
5 lines; `startLines` and `all`-mode `lines` are capped at 5, the others at 20. Verified live: `[127.0.0.1] say PRO
start line: welcome` / `*-Server- says: PRO start line: welcome`, then one minute apart `*-Server- says: PRO periodic
tick A` and `... tick B`.

Respawn scaling (`launcher/respawnScaling.ts`) rides the same run. It counts human players from `player.joined` and
`player.left` for the launched profile (`[BOT]` callsigns are bots; each callsign counts once, since the join line
repeats for everyone at each level start), starting from zero at each `server.started`. At console ready it sends the value for the current count, then recomputes 15 s after the
last join or leave and sends `$setrespawntime <n>` only when `n` differs from the last value sent. DMFC
(`dmfcinputcommand.cpp:672-700`) clamps below 1, has no upper limit and syncs the netgame to clients; the engine times
each powerup's return at pickup (`object.cpp:1917-1918`: `respawn_time` × the powerup's `respawn_scalar`), so a change
applies from the next pickup. The console event hub emits `player.joined`/`player.left` (Addendum E.1).

### 8.7 Operations (Addendum D)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/schedule` | `{ timeZone, now, entries: [{ profileId, name, enabled, next: { action, at, atLocal } \| null, pendingStop: { deadline, deadlineLocal } \| null }] }` |
| `PATCH` | `/api/profiles/:id` | Also takes `schedule: { enabled, windows: [{ day, start, end }], stopWaitMinutes } \| null` (400 with `details` when invalid) and `importedArgs: string[] \| null` |
| `POST` | `/api/profiles` | Also takes `launchOptions` and `importedArgs` (with `existingConfigFile`); invalid launch options are dropped |
| `GET` | `/api/alerts/mail` | `{ settings (no password; passwordSet), status: { lastSentAt, lastError, lastErrorAt, pending } }` |
| `PUT` | `/api/alerts/mail` | Body `{ enabled, host, port, tls: "none"\|"starttls"\|"tls", user, password?, from, recipients, events }`; no `password` keeps the stored one, `""` clears it; returns `{ settings, status, warnings }` |
| `POST` | `/api/alerts/mail/test` | Optional body as for PUT (unsaved settings); sends one mail now: `{ ok, messageId, accepted, rejected, error }` |
| `GET` | `/api/process-priority` | `{ priorityClass, platform, last: { pid, priorityClass, value, applied, warning } \| null }` |
| `PUT` | `/api/process-priority` | Body `{ priorityClass: "below-normal"\|"normal"\|"above-normal"\|"high" }`; saves and applies to a running server |
| `GET` | `/api/update-check` | `{ enabled, current, latest, available, url, checkedAt }` |
| `PUT` | `/api/update-check` | Body `{ enabled }` |
| `POST` | `/api/launch-script/preview` | Body `{ text, fileName? }` (64 KB max): `{ script, profile: { name, gamePath, executablePath, configFile, launchOptions, launchOptionArgs, importedArgs, notes }, checks }`; creates nothing |

`GET /api/pyrodeck/config` does not return `mail`, and `PUT /api/pyrodeck/config` ignores `missionHost`, `supervisor`,
`autostart`, `mail`, `processPriority`, `updateCheck`, `players` and `playerRules`: each has its own route
(`autostart` is set with `PATCH /api/profiles/:id { autostart: true | false }`, Addendum F).

### 8.8 Players: history and addresses

Pyrodeck reads every console session it opens (Connect and Launch mode) and keeps, per server
profile, the joins and leaves it sees: `<config dir>/players/<profile>.json`, 5,000 rows, oldest
dropped first, plus a name/address index of up to 5,000 pairs. A Connect-mode server's profile id is
`connect:<host>:<port>`. A join while the player is already in the game is a level re-entry (every
player re-enters each level) and adds no row. For a human's new session Pyrodeck sends `$players`
for the slot and one `$playerinfo <slot>` for the address, never polled; see §8.8.1.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/players/profiles` | `{ active, profiles: [{ profileId, label, rows, lastEventAt }] }`: profiles with a history; `active` is the open console's profile |
| `GET` | `/api/players/history?profileId=&q=&limit=&before=` | `{ profileId, rows, total }`: join/leave rows newest first (`id, time, event, name, slot?, ip?, bot?, reason?`); `q` matches name or address; `before` pages by row id. `profileId` defaults to the open console's |
| `GET` | `/api/players/sessions?profileId=&from=&to=&q=` | "Who was on": `{ sessions: [{ name, slot?, ip?, bot?, joinedAt, leftAt, reason? }] }` overlapping `from`..`to` (ISO; default the last 24 h) |
| `GET` | `/api/players/addresses?profileId=&q=` | `{ entries: [{ name, ip, firstSeen, lastSeen, count }] }`, most recent first |
| `GET` | `/api/players/present` | `{ profileId, players: [{ name, slot?, ip?, bot }] }`: who Pyrodeck tracks as in the game |
| `GET` | `/api/players/settings` | `{ settings, lookup: { profileId, used, unlimited } }` |
| `PUT` | `/api/players/settings` | Body: any of the settings below; 400 with `errors` on a bad value |

Settings (`pyrodeck.json` → `players`): `ipLookup` (default `true`), `ipLookupBudget` (0-30,
default 20).

#### 8.8.1 Engine facts

- **Lines read** (all printed through `PrintDedicatedMessage`, so they reach every console
  session; a HUD message prints as `*<text>`, `hudmessage.cpp:425`). Join: each game DLL's
  `OnClientPlayerEntersGame` line, e.g. `*Bob has joined the Anarchy`, `*Bob has joined CTF`,
  `*Bob has joined the Red Team`, `*Bob Has Joined The Blue Team` (Monsterball, Entropy). Leave:
  `*Bob has left the game` (`multi.cpp:3635`) and `*Bob disconnected!` (`multi_server.cpp:1108`;
  time-outs, kicks and bans). Bots: `Bot '<name>' added in slot <n> (...)`
  (`dedicated_server.cpp:905`) after the join line, `  Bot '<name>' spawned (..., slot=<n>)`
  (`bot.cpp:9983`), `Removing bot '<name>' from slot <n>` (`dedicated_server.cpp:918`; a removed
  bot prints no leave line), `All bots removed`. `$kick`/`$ban` print `*Kicking <name> from game` /
  `*Banning <name> from game` (`dmfcinputcommand.cpp:353`, `:379`); a human's `disconnected!`
  follows, a bot gets no other line. Chat: `*<name> says: <text>` (`TXT_HUDSAY`). Level:
  `Opening level '<file>'...` (`LoadLevel.cpp:3688`). `Ending level.`, `Opening level '...'...` and
  the level-load progress have no newline, so the first player re-entering a level arrives glued to
  kilobytes of `...level 2 99 Percent Complete` on one line; Pyrodeck splits lines at those points.
  Emitted on the event bus as `player.joined`,
  `player.left`, `player.chat`, `level.started`; `player.identified` follows a human's new session
  once the slot and address are looked up.
- **`$players`** lists `NN: <name>` for every player that passes `CheckPlayerNum` (connected and in
  the level), the server (`00: -Server-`) and bots included (`dmfcinputcommand.cpp:394`).
- **`$playerinfo <slot>`** prints the callsign, `PlayerNum: <n>`, `IP: <a.b.c.d>:<port>`
  (`networking.cpp:825`) and the ship. For a slot not in the game it prints the previously shown
  player if that one is still in, so Pyrodeck keeps an answer only when it names the slot and the
  player asked about. The command queues its text twice with `DLLgrtext_Printf`, even headless
  (`dmfcmenu.cpp:1138`, `dmfcinputcommand.cpp:261`), about 400 bytes per query into a 16 KB buffer a
  dedicated server never flushes (`grtext.h:115`): the same defect as `$netgameinfo` (v0.4.11), so a
  retail or upstream server dies after roughly 40 queries. Matcen clears the buffer every frame from
  0.9.3 (`GameLoop.cpp:2591`). Pyrodeck therefore sends at most `ipLookupBudget` queries per server
  run to anything but Matcen 0.9.3+, and none for a name containing `%` (the callsign line is passed
  to `DLLgrtext_Printf` as the format string, `dmfcbase.cpp:1654`).
- After each level start, a player who has neither re-entered nor appears in `$players` within
  120 s gets a leave row ("not back after a level change"); `server.started`, `server.stopped` and
  `server.crashed` end every open session.

### 8.9 Bans

DMFC's `$ban <slot>` kicks and refuses the address, but keeps it in a list freed with the game DLL
(`BanPlayerFromGame`, `dmfcbase.cpp:3088`; freed in `~DMFCBase`, `:586`), so every restart, a
playlist rotation included, forgets it. Bans that last are the engine's `netgames/hosts.deny`
(addresses) and Pyrodeck's own name list.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/bans` | `{ hostsDeny: { path, source, exists, lines: [{ line, text, entry, error, reason?, addedAt?, name? }], allow: { path, exists, entries }, error }, nameBans, settings, detectedLocalDir, consoleIsLocal }` |
| `POST` | `/api/bans/hosts` | Body `{ entry, reason }`: an address, a `*` pattern or a /8, /16, /24, /32 prefix (converted to `*` parts). Appends it, notes why and when, sends `$rehash` |
| `DELETE` | `/api/bans/hosts/:entry` | Removes every line the engine reads as that entry, sends `$rehash` |
| `POST` | `/api/bans/names` | Body `{ pattern, reason }`: a callsign (any case), or `Name*` for every name starting with `Name` |
| `DELETE` | `/api/bans/names/:id` | Remove a name ban |
| `POST` | `/api/bans/rehash` | `$rehash` on the open console |
| `PUT` | `/api/bans/settings` | Body `{ hostsDenyPath?, rehashOnLevelStart? }` |
| `POST` | `/api/players/kick` | Body `{ name, reason?, slot? }`: `say <name> kicked - <reason>`, 2 s, re-check the slot with `$players`, `$kick <slot>`; emits `player.kicked` |
| `POST` | `/api/players/ban` | Body `{ name, reason?, hostsDeny? (default true), nameBan?, slot? }`: as kick but `$ban`, then the address into hosts.deny and the name into the list; emits `player.banned`. Refuses bots (`$playerinfo` gives a bot the server's own address, `127.0.1.1`) and never writes `0.0.0.0` or `127.x` to hosts.deny |

Settings (`pyrodeck.json` → `players`): `hostsDenyPath` (absolute path; null = the server's
directory below), `rehashOnLevelStart` (default `true`). Name bans and the notes on hosts.deny
entries live in `<config dir>/bans.json`.

#### 8.9.1 Engine facts

- **Where:** DMFC reads `<LocalD3Dir>/netgames/hosts.deny` and `hosts.allow`
  (`ReadInHostsAllowDeny`, `dmfcbase.cpp:4844`). `LocalD3Dir` is the engine's first, writable base
  directory (`manage.cpp:671`), which in the open-source engine and Matcen is SDL's preference path
  (`init.cpp:1425`): `~/.local/share/Outrage Entertainment/Descent 3` (or `$XDG_DATA_HOME/...`) on
  Linux, `%APPDATA%\Outrage Entertainment\Descent 3` on Windows. Retail 1.4/1.5 uses its install
  directory. A launched server logs it (`Local dir: <path>`, `manage.cpp:679`) and Pyrodeck
  remembers it; the `hostsDenyPath` setting overrides both. Verified 2026-10-07: `$rehash` opens
  and reads `<pref dir>/netgames/hosts.deny` (inotify on a Matcen 0.9.16 server).
- **Format** (`ParseHostsFile`, `dmfcbase.cpp:4688`): one entry per line; CR, LF or CR LF; leading
  spaces and tabs skipped; then only digits, dots and `*`, exactly three dots, at most 15
  characters; each part 1-3 characters, a lone `*` or a number 0-255. Anything else (a comment, a
  trailing space, a `/24`) makes the line ignored, silently. `*` matches any value in its part.
  hosts.allow is checked first and wins (`IsAddressBanned`, `dmfcbase.cpp:3215`); only TCP/IP
  addresses are checked. The lists are read at game start and by `$rehash`
  (`*Rehashing Hosts.allow and Hosts.deny`), which Pyrodeck sends after each edit and, by default,
  at each level start.
- **Kick and ban** take a slot only (`dmfcinputcommand.cpp:330`, `:357`), so the reason goes out
  first as chat: the dedicated console's `say` (`Say` variable, `dedicated_server.cpp:185`). Text
  before a colon is read as a destination (a slot, a name prefix or `team`;
  `GetMessageDestination`, `hudmessage.cpp:737`), so public lines carry no colon and `say <slot>:
  <text>` reaches one player. The engine has no name ban: a name on the list is kicked on join.

### 8.10 Join rules and the profanity monitor

Both off by default; settings in `pyrodeck.json` → `playerRules`.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/players/rules` | `{ rules, defaultWords, recent: [{ time, profileId, name, rule, action, detail, ok }], offenders }` (`offenders`: this run's profanity counts on the open server) |
| `PUT` | `/api/players/rules` | Body `{ nickname?: {...}, profanity?: {...} }`, any subset; 400 with `errors` on a bad value |
| `POST` | `/api/players/rules/forgive` | Body `{ name }`: clear a player's profanity count |

- **Nickname rules** (`nickname: { enabled, rejectEmpty, rejectPercent, rejectControl, minLength }`),
  applied to each human's new session (`player.identified`): an empty or blank name or one with `%`
  is kicked as `INVALID NICKNAME`, one with control characters as `HACKED NICKNAME`, one shorter
  than `minLength` (0 = off) as `INVALID NICKNAME`, the reason said first. `%` matters because
  callsigns reach printf-style calls as the format: in DMFC (`dmfcbase.cpp:1654`,
  `dmfcinputcommand.cpp:753`) and, worse, in the engine's own console output:
  `PrintDedicatedMessage` formats its text and then passes the result to `con_Printf` as the format
  (`dedicated_server.cpp:1388`, `lnxcon.cpp:144`), so every console line is formatted twice. Tested
  2026-10-07 on Matcen 0.9.16: `$addbot Pct%sX` echoed as `Pct<newline>X` and the server died with
  SIGSEGV at the bot's join line. A client callsign or a chat line with `%` takes the same path, so on
  the open-source engine and Matcen such a player can crash the server before any rule acts; the
  `%` rule helps only where the join line survives. A joining client's name cannot be produced from
  the server console, so the client case was not tried. The console reader drops NUL bytes and
  colour codes (`0x01` + 3 bytes) before Pyrodeck sees a name. Pyrodeck strips `%` from every chat
  line it sends.
- **Profanity monitor** (`profanity: { enabled, words, warnings, kicks, ban, cooldownSeconds }`),
  applied to `player.chat` (general chat only; team and private chat never reach the console).
  Words match as whole words or phrases without regard to case; a trailing `*` matches any ending.
  The default list ships as data (`rules/profanityDefaults.json`): plain profanity, no slurs. Per
  player and server run: `warnings` private warnings (`say <slot>: ...`), then `kicks` kicks, then a
  ban of the name and the address (§8.9), or more kicks when `ban` is off. Matches within
  `cooldownSeconds` of the last action are not counted. A chat line's name is the sender's own
  claim (the client writes `<name> says: <text>`, `hudmessage.cpp:828`), so a modified client can
  put words in another player's mouth; the bans that follow go by that name's slot and address.

---

## 9. Project Structure

```
d3-pyrodeck/
├── packages/
│   ├── server/                  # Backend (Fastify + Bun/Node)
│   │   ├── src/
│   │   │   ├── connection/
│   │   │   │   ├── ServerConnection.ts      # Interface
│   │   │   │   └── TelnetConnection.ts      # Implementation
│   │   │   ├── parser/
│   │   │   │   ├── ResponseParser.ts        # Registry + dispatch
│   │   │   │   ├── parsers/
│   │   │   │   │   ├── servercaps.ts
│   │   │   │   │   ├── botlist.ts
│   │   │   │   │   ├── botstat.ts
│   │   │   │   │   └── scores.ts
│   │   │   ├── files/
│   │   │   │   ├── FileManager.ts           # File operations (list, read, write, delete, extract)
│   │   │   │   ├── Provisioner.ts           # Game file validation + setup wizard logic
│   │   │   │   └── SftpServer.ts            # Optional built-in SFTP endpoint (Phase 3)
│   │   │   ├── launcher/
│   │   │   │   ├── ProcessManager.ts        # Server process lifecycle + auto-restart
│   │   │   │   └── ConfigGenerator.ts       # Auto-generate dedicated.cfg
│   │   │   ├── session/
│   │   │   │   └── SessionManager.ts
│   │   │   ├── routes/
│   │   │   │   ├── auth.ts
│   │   │   │   ├── server.ts
│   │   │   │   ├── command.ts
│   │   │   │   ├── config.ts
│   │   │   │   ├── files.ts                 # File manager endpoints (Phase 3)
│   │   │   │   ├── setup.ts                 # Provisioning wizard endpoints (Phase 3)
│   │   │   │   └── launcher.ts
│   │   │   └── index.ts
│   │   └── package.json
│   └── client/                  # Frontend (React + Vite)
│       ├── src/
│       │   ├── components/
│       │   │   ├── Console.tsx
│       │   │   ├── PlayerList.tsx
│       │   │   ├── BotPanel.tsx
│       │   │   ├── ConfigEditor.tsx
│       │   │   ├── FileManager.tsx          # File browser UI (Phase 3)
│       │   │   └── SetupWizard.tsx          # Provisioning wizard UI (Phase 3)
│       │   ├── hooks/
│       │   │   └── useServerConnection.ts
│       │   └── App.tsx
│       └── package.json
├── docker/
│   ├── Dockerfile
│   └── docker-compose.yml
└── package.json                 # Workspace root
```

---

## 10. Security

- **Web UI auth:** Session password required before any functionality is accessible. Configured via env var (`PYRODECK_PASSWORD`) or config file. No default password — fail to start if unset.
- **Telnet credentials:** Console password stored in session memory only. Never written to disk by the web admin.
- **File access:** Strict path sanitization on all file manager endpoints. Reject `..`, absolute paths, symlinks pointing outside the managed root. All file operations are jailed to the server's managed directory tree (`gamedata/`, `servers/`, `import/`). Config editor (Phase 1) is further scoped to the config directory only.
- **Upload limits:** Configurable max upload size (default 100MB). Uploads streamed to disk (not buffered in memory) to prevent OOM on large files. File type validation on upload (reject unexpected extensions in sensitive directories).
- **SFTP access:** If the built-in SFTP server is enabled (Phase 3), it uses the web admin session password for authentication. SFTP root is jailed to the same managed directory tree as the web file manager. Disabled by default — opt-in via config.
- **HTTPS:** Out of scope for the app. Users deploying to VPS should put nginx or Caddy in front, as `docs/behind-a-reverse-proxy.md` describes. `PYRODECK_TRUST_PROXY=1` trusts `X-Forwarded-For`/`-Proto` from loopback only (an explicit address/CIDR list names a remote proxy; never every hop), so the client is the right-most untrusted address. A request carrying any forwarding header is never local, and a local request must ask for a loopback Host name. The session cookie is `Secure` when `request.protocol` is https; browser requests whose `Origin` host differs from `Host` are refused (403). Pyrodeck listens on 127.0.0.1 unless `PYRODECK_HOST` is set (v0.5.2).
- **Sessions (v0.5.2, `auth/sessions.ts`):** a random 32-byte id per login (base64url in the signed cookie), kept in memory with its login time, last use, address and user agent. A request with a password set needs a live session and restarts its idle clock. A session ends at logout, `DELETE /api/sessions`, when the admin password is set, `PYRODECK_SESSION_TTL_HOURS` (default 12) after login, or `PYRODECK_SESSION_IDLE_MINUTES` (default 120) after its last request; expired sessions are swept every 60 s. Cookie `maxAge` is the absolute lifetime. Login ends the session id the browser presented and issues a new one (no fixation). A `/ws` socket is bound to the session that opened it and closes with code 4401 when it ends; a command on a socket whose session ended closes it too. At most 1000 sessions; the least recently used goes first. A restart ends every session.
- **Game console exposure:** A launched server's console is reached on 127.0.0.1 when its config has `AllowRemoteConsole=0` (the default Pyrodeck writes); `AllowRemoteConsole=1` is needed only for Connect mode from another machine, and Pyrodeck warns when a launched profile uses it.
- **Game server environment (v0.5.3, `launcher/childEnv.ts`):** the launched process gets an environment built from an allowlist of Pyrodeck's (`PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `TMPDIR`/`TMP`/`TEMP`, `TZ`, `LANG`, `LANGUAGE`, `LC_*`, `XDG_*`, `SDL_*`, `D3_*`, `LD_LIBRARY_PATH`, and the Windows system variables), names compared case-insensitively, plus `SDL_VIDEODRIVER=dummy` unless set. No `PYRODECK_*` name is ever passed; every secret Pyrodeck reads from its environment is one.
- **CORS:** Restricted to the web admin's own origin by default.

---

## 11. Deployment

### 11.1 Windows LAN Party (Phase 2)

Download single `.exe`. Run from command line or double-click. First-run wizard guides through locating D3 install and setting a session password. Opens browser automatically at `http://localhost:3000`.

### 11.2 VPS / Linux (Phase 1 — Connect Mode)

```bash
./d3-pyrodeck --port 3000 --password yourpassword
```

Connect to any running D3 dedicated server — local, LAN, or remote. The web admin does not need to run on the same machine as the game server. Example scenarios:

- **Same machine:** Web admin and D3 server on the same VPS. Connect to `localhost:2092`.
- **LAN:** Web admin on your laptop, D3 server on a dedicated box. Connect to `192.168.1.50:2092`.
- **Remote:** Web admin on a VPS or your local machine, D3 server on a friend's machine across the internet. Connect to their public IP or hostname (Telnet port must be forwarded/open).

No Docker required for connect-only mode.

### 11.3 VPS / Docker with Provisioning (Phase 3)

```yaml
# docker-compose.yml
services:
  d3-pyrodeck:
    image: stev0760/d3-pyrodeck:latest
    ports:
      - "3000:3000"    # Web UI
      - "2023:2023"    # SFTP (optional, for large file uploads)
    volumes:
      - ./gamedata:/app/gamedata    # Retail game files (.hog, tables, netgames)
      - ./servers:/app/servers      # Per-server configs, missions, logs
      - ./import:/app/import        # Staging area for zip imports
      - ./config:/app/config        # Web admin config
    environment:
      - PYRODECK_PASSWORD=yourpassword
      - D3_SERVER_HOST=localhost
      - D3_SERVER_PORT=2092
      - D3_SFTP_ENABLED=false       # Enable built-in SFTP server
```

**Provisioning workflow:**
1. Start the container. Web UI shows the setup wizard (game files missing).
2. Upload game files via one of three methods:
   - **Web upload** — drag-and-drop `.hog` files in the wizard (works for files <100MB)
   - **SFTP** — connect to port 2023, upload to `/gamedata/` (best for large `.hog` files)
   - **Direct volume mount** — copy files to `./gamedata/` on the host before starting
3. Wizard validates files and enables "Start Server."

---

## 12. Testing and Compatibility

- **Vanilla retail server:** `$servercaps` returns `Unknown command`. All fork features disabled. General admin (console, config, standard commands) fully functional.
- **stev0760 fork:** Full capabilities returned. All tabs and features enabled per feature flags.
- **Bad Telnet password:** Clear error message on connection form. Not a crash.
- **Server unreachable:** Timeout with retry option. Reconnect back-off strategy applies.
- **Bot output during parsing:** Kill messages and game events interleave with command responses. Parser must handle this gracefully — strip non-response lines from structured output.

---

## 13. Open Questions

Deferred to implementation — do not block Phase 1:

- **Packaging tool:** Bun `--compile` vs. Node SEA. Evaluate during Phase 2.
- **Code editor:** CodeMirror vs. Monaco. Start with CodeMirror; switch if needed.
- **Probe polling:** Periodic re-probe for player count updates, or event-driven only? Start with connect-only; add polling if UI feels stale.
- **Multi-server UI layout:** Tabs vs. sidebar. Phase 4 concern — session model is already multi-server capable.
- **`$scores` polling interval:** 5s default? Configurable? Decide during Phase 1 implementation.
- **Game event parsing depth:** `descent3console` parses kill streaks, revenge, efficiency, hat tricks. Is this useful for the web admin beyond raw console display? Backlog for now; parser registry supports adding these later.
- **Tracker registration:** D3Server3 supported 5 trackers. Which community trackers are still active? descent.cx and descentservers.net appear defunct. PXO revival status unknown. Research during Phase 4.
- **MPS file support:** D3 supports `MultiSettingsFile=` for templated server configs. Should the config editor understand `.mps` format, or just treat it as a raw file? Start with raw; evaluate structured editing later.
- **SFTP implementation:** Built-in SFTP server adds complexity. Evaluate whether `ssh2` (Node.js) or a Go-based SFTP sidecar is more practical. Alternative: skip built-in SFTP entirely and document `scp`/`rsync` to the volume mount. Every Minecraft panel eventually added SFTP — but D3's file set is simpler (a few large .hog files, not thousands of chunk files).
- **HOG file validation:** Should we parse HOG headers to validate integrity, or just check file size and magic bytes? Full parsing catches corruption but adds complexity. Start with magic bytes + size range check.
- **Chunked uploads:** No Minecraft panel implements chunked/resumable web uploads — all punt to SFTP. Worth investigating `tus` protocol for Phase 3+ if SFTP proves too complex for casual users.

---

## 14. Reference Implementations

These existing open-source projects serve as reference for parser logic and server interaction patterns:

| Project | URL | Useful For |
|---------|-----|-----------|
| `descent3console` | github.com/roncli/descent3console | Telnet connection handling, game event parsing (kills, deaths, joins, chat, scoring for all 9 game types), player info parsing, EventEmitter patterns |
| `descent3launcher` | github.com/roncli/descent3launcher | Programmatic server launch, config generation, ship/weapon/powerup allow/disallow defaults, command-line switch reference |
| Descent DSN | roncli.com/gaming/descent-dedicated-server-network | Planned web-based server management with scoreboards, game logs, spectator chat — architecture reference for future features |

`descent3console` is particularly valuable — it parses stat events (kill streaks, revenge, efficiency, hat tricks) that the raw console does not structure. While Phase 1 does not need this level of parsing, the parser registry architecture should accommodate it for future phases.

---

## 15. Out of Scope

- Descent 3 engine internals beyond the commands in Section 5.
- Bot AI behavior, navigation, difficulty tuning, FSM logic (see `BOTS_DEVEL.md`).
- Bot config file format (see `BOT_MANAGEMENT.md` in the engine fork).
- Client-side modifications of any kind.
- Game asset distribution — users must supply their own retail copy of Descent 3 (GOG or Steam).

---

## Addendum A — Mission (.mn3) game-mode compatibility scanning (2026-07-12, implemented v0.4.17)

Ported from the fork spec's Addendum A (`matcen-docs/D3_PYRODECK_SPEC.md`); implemented in
`packages/server/src/gamefiles/Mn3Scanner.ts` and surfaced in the Config tab's structured form.

**Goal:** Pyrodeck reads the server's `missions/` directory and shows, per mission, which game
modes it supports and at how many teams — ending launch-and-pray mission selection. All data is
author-declared text metadata inside the `.mn3`; the scan is a faithful port of the engine's own
mission filter (`Descent3/Mission.cpp: MissionGetKeywords()`), so Pyrodeck's answer is exactly as
trustworthy as the game's own mission list. Reference prototype: `tools/mn3info.py` in the engine
fork (validated 2026-07-12 against a 102-mission library; the TS port matches it 1:1 on 111 missions).

### A.1 Container: .mn3 is a HOG2 archive

Little-endian throughout (`cfile/hogfile.h`):

| Offset | Size | Field |
|---|---|---|
| 0 | 4 | magic `"HOG2"` |
| 4 | 4 | `u32 nfiles` |
| 8 | 4 | `u32 file_data_offset` |
| 12 | 56 | padding (header is 68 bytes total) |
| 68 | 48 × nfiles | file entries: `char name[36]` (NUL-terminated), `u32 flags`, `u32 len`, `u32 timestamp` |

File payloads follow **sequentially in entry order** starting at `file_data_offset` (entry N's
offset = `file_data_offset` + sum of `len` of entries 0..N-1). The scanner reads only the header,
entry table, and the `.msn` blob — a few KB per file regardless of archive size.

### A.2 Mission metadata: the `.msn` text file

Extract the entry whose name ends in `.msn` (case-insensitive). It is line-oriented text; parse
the first token of each line (whitespace-delimited, case-insensitive), remainder = operand:
`NAME` (display name), `NUMLEVELS`, `MULTI`/`SINGLE`, `AUTHOR`/`DESCRIPTION`/`URL`, and
`KEYWORDS` — **comma-separated compatibility tags, the payload**.

### A.3 Mode requirements (from `netgames/*/` `options->requirements`, verified in source)

| Mode (.d3m) | Requirements |
|---|---|
| Anarchy, Team Anarchy, Hyper-Anarchy | *(none — every mission qualifies)* |
| CTF | `MINGOALS2,GOALPERTEAM` |
| Hoard | `MINGOALS1` |
| Entropy | `ENTROPY` |
| Monsterball | `MINGOALS2,GOALPERTEAM,SPEC1` |
| Co-op, Robo-Anarchy | `COOP` |

### A.4 Matching semantics (port of `MissionGetKeywords`, returns max teams or INCOMPATIBLE)

1. Parse mission `KEYWORDS` into tags (comma-separated, trim, case-insensitive). A tag
   `GOALS<n>` sets `goals = n` (last one wins).
2. For each mode-requirement token: `MINGOALS<n>` → set `goalsneeded = n`; `GOALPERTEAM` → set
   `goal_per_team = true`; **any other token → INCOMPATIBLE unless it appears literally in the
   mission tags** (this is how `ENTROPY`, `SPEC1`, `COOP` work).
3. `teams = goal_per_team ? goals : MAX_NET_PLAYERS`; if `teams < goalsneeded` or
   `goals < goalsneeded` → INCOMPATIBLE; else compatible at up to `teams` teams.

Tolerances (all observed in the validation library): lowercase keywords, author typos
(`GOALSPERTEAM`), duplicate tokens, and custom tags (`inferno`, `ASSAULT`) — unknown mission tags
are harmless and ignored, exactly as the engine ignores them. Missions with no `KEYWORDS` line
are anarchy-class only. **Caveat:** tags are author-declared; a mislabeled mission lies to the
game and to Pyrodeck equally.

### A.5 Pyrodeck implementation (v0.4.17)

- **Scanner:** `packages/server/src/gamefiles/Mn3Scanner.ts` — `parseMn3Cached()` with a
  module-level mtime+size cache; `scanMissionsDir()` for the whole directory. Per-file parse
  errors land in an `error` field and never fail the scan. Mode keys are normalized `.d3m`
  basenames (`"team anarchy.d3m"` → `teamanarchy`).
- **API:** `GET /api/game-files/missions?profileId=…&details=1` adds a `details: Mn3Info[]`
  array alongside the existing `missions` list (shape unchanged without the param).
- **UI:** Config tab structured form — mission dropdown disables missions incompatible with the
  selected Game Type (label suffix `— no <mode> support`); a details panel under the picker shows
  display name, level count, and compatible-mode badges with team capacity (e.g. `CTF·4T`); a red
  warning renders when the selected mission/script pairing is incompatible. Unknown custom
  scripts and scan errors never block selection.
- **Playlist validation** (`packages/server/src/gamefiles/playlistCompat.ts`): playlist entries
  are checked against the rotation profile's `Scriptname=`. `POST /api/playlists/:id/activate`
  (body may carry `profileId`; falls back to the most recently launched profile — the same
  profile rotation uses) rejects with 400 and a per-entry reason list (`no <mode> support` /
  `mission file not found`) when any entry is incompatible. The rotate handler re-validates each
  entry just before restarting and **skips** incompatible ones (current mission keeps running,
  WS warning broadcast) — guarding against Scriptname changes made after activation. The
  PlaylistEditor shows per-entry ⚠ markers and a summary against the Launch panel's selected
  profile. Validation is lenient: no/unknown script or unparseable missions never block.

---

## Addendum B — Mission download links (2026-10-07, implemented v0.4.20)

**Goal:** a player who joins without the server's mission is offered a working download link.
D3 does this natively: the client asks the server for links (`MP_ASK_FOR_URL`) and the server
answers with the `URL` lines of the loaded mission's `.msn`. Most custom missions carry dead
1999-era links, and the engine has no setting to override them (a `MissionURL` cvar was drafted in
the fork and reverted on 2026-07-19: the decision is that Pyrodeck rewrites the URL lines inside
the server's copy of the `.mn3`). Matcen registry item REL7.

### B.1 Engine facts (Matcen `Descent3/Mission.cpp`, `mission_download.cpp`, `cfile/`)

- The engine opens `<mission stem>.msn` inside the `.mn3` (`d3_2` maps to `d3`). Lines are read
  into a 128-byte buffer; the command is the first token, the operand is the rest of the line cut
  to 95 characters (`char operand[96]`).
- `URL <link>` is a mission-level command: one after the first `LEVEL` line is a load error. Any
  unknown command is a load error too, so Pyrodeck writes nothing but URL lines.
- Up to 5 links are kept (`MAX_MISSION_URL_COUNT`) and offered to the client as a list.
- Clients download only `http://` and `https://` links. A link whose last path segment ends in
  `.zip` is unzipped into `missions/`; any other body is saved as the mission file itself.
- The fork never advertises links for the retail missions (`d3.mn3`, `d3_2.mn3`, `training.mn3`,
  `merc.mn3`).
- The join checksum covers level geometry and ship physics, not the `.msn`, so clients holding the
  original mission still join a server whose copy was rewritten.
- The engine reads the links when it loads the mission, so a rewrite takes effect at the next
  mission load (server restart or playlist rotation).

### B.2 Rewrite (`packages/server/src/gamefiles/Mn3UrlRewriter.ts`)

1. Validate the file: a plain `*.mn3` name listed in `gamePath/missions/`, not retail (from v0.5.7
   not stock either, C.4; restore still accepts a stock mission); HOG2 magic,
   a plausible entry count, a data offset after the entry table, payloads that end inside the
   file, and a `.msn` entry.
2. Validate the link: `http(s)`, printable ASCII without spaces, at most 95 characters, a host, a
   final path segment (a link not ending in `.zip`/`.mn3` is allowed with a warning).
3. Back up once: copy the untouched file to `<name>.mn3.pyrodeck-orig` with an exclusive create, so
   later rewrites never replace the true original. (D3 and the mission scanner list only `*.mn3`,
   so the backup is invisible to both.)
4. Edit the `.msn` text byte-exactly (latin1): the first mission-level `URL` line becomes
   `URL<its own whitespace><link>`, other mission-level `URL` lines are removed; with none, a
   `URL <link>` line goes just before the first `LEVEL` line. Every other byte and each line's own
   ending (CRLF in all 112 missions surveyed) is kept.
5. Write a new archive to `<name>.mn3.pyrodeck-tmp`: the header, entry table and any gap copied
   with only the `.msn` length patched, the payloads before the `.msn` copied, the new `.msn`, the
   payloads after it copied. Entry order (the engine requires sorted names) and timestamps are
   kept. Read the temp file back and compare the `.msn`, then rename it over the mission.
6. Restore copies the backup back the same way and deletes it, but only when the current file's
   entry names and non-`.msn` lengths still match the backup; a mission replaced by another
   version is never overwritten by a stale backup.

On Linux the rename is safe while a server has the mission open (the running process keeps the old
file). On Windows the rename fails while the file is open; the API reports "stop the server that
has this mission loaded".

**Verified 2026-10-07:** all 108 non-retail missions of a 112-mission library rewritten and
restored (non-`.msn` payloads and the mode scan unchanged; restore byte-identical); a Matcen
0.9.17-dev dedicated server loaded a rewritten `2fast2.mn3` and logged exactly the new link
(`Found a Mission URL: …`).

### B.3 UI

Config tab, mission details panel: the current links, **Set link / Change** (one link replaces all
of them), and **Restore original** while a backup exists.

## Addendum C — Mission host (2026-10-07, branch `feature/mission-host`)

**Goal:** Quake 3 `sv_allowDownload` parity. Pyrodeck serves the server's custom missions itself, so
the link from Addendum B can point at the same machine. No `$` command or console output changes;
the Matcen contract (`PYRODECK_CONTRACT.md`) is untouched.

### C.1 Engine facts (Matcen source, read 2026-10-07; corrects B.1 where noted)

- **The current client** (`Descent3/mission_download.cpp`, `msn_DownloadWithStatus`) checks the
  scheme with `stricmp`, splits the link at `/`, and hands `scheme://host[:port]` to
  `D3::HttpClient` (`netcon/inetfile/httpclient.cpp`), a cpp-httplib 0.28 `Client` with
  `follow_location(true)` and a 5 s connect timeout. Request: `GET /<path> HTTP/1.1`, origin-form,
  with `Host`, `Accept` and `Connection: close`; no `User-Agent`, no `Accept-Encoding` (httplib adds
  them only without a content receiver), no `Range`. It reads Content-Length, chunked and
  close-delimited bodies and keeps the body only on 200. The body is written to
  `<missions dir>/<server's mission name>`; a link ending in `.zip` is unzipped instead.
- **No https (corrects B.1).** The fork's vcpkg manifest builds cpp-httplib with features
  `brotli;core`, so `CPPHTTPLIB_OPENSSL_SUPPORT` is off and `httplib::Client` throws
  `std::invalid_argument` on an `https` link; nothing catches it. httplib's scheme regex is `[a-z]+`,
  so an upper-case `HTTP://` fails to resolve.
- **86 characters, not 95 (corrects B.1 for writing).** `sprintf(fmturl, "Downloading: %s", url)`
  into `char fmturl[100]` (`MSN_MAX_STRING_LEN`), unchanged since the 1999 import: 13 + length + 1
  must fit in 100. The `.msn` parser still keeps 95; Pyrodeck writes at most 86.
- **Progress division.** `int starttime = timer_GetTime();` then every 500 ms
  `time_elapsed = timer_GetTime() - starttime;` and, once httplib's progress callback has reported a
  Content-Length, `received_bytes / time_elapsed` in integer arithmetic. `time_elapsed` is 0 until
  the first wall-clock second boundary after the start, so a body that starts arriving within about
  0.5 s raises SIGFPE about half the time (reproduced with the same expression outside the engine).
  httplib reports progress only for bodies with a Content-Length.
- **The 1999-era client** (`netcon/inetfile/Chttpget.cpp` in the source import `df209742`) rejects
  any `:` after `http://` (port 80 only), sends its request with bare-LF line endings, needs CRLF in
  the response, follows only 301, and stops reading at Content-Length.

### C.2 Listener (`packages/server/src/gamefiles/MissionHost.ts`)

- Settings in `pyrodeck.json` as `missionHost: { enabled (false), port (3002), publicBaseUrl }`, set
  only through `PUT /api/mission-host` (the generic config PUT ignores the key). `publicBaseUrl` is
  normalized to `http://<lower-case host>[:port]`; https, paths, queries and credentials are
  refused; a LAN or loopback host draws a warning.
- A plain `node:http` server, not the admin Fastify app: `GET`/`HEAD /missions/<name>` where the
  decoded name is a bare basename ending in `.mn3`, not retail or stock (C.4), and listed case-exact by a `readdir`
  of `<global gamePath>/missions` at request time. Everything else is 404 (405 for other methods on a
  mission path). No directory listing, no ranges (`Accept-Ranges: none`).
- Response: 200, `Content-Type: application/octet-stream`, `Content-Length` from the open
  descriptor (a concurrent link rewrite renames a new file over the name; the response keeps the
  old one), `Connection: close`, `X-Content-Type-Options: nosniff`.
- Each GET is held 1 s before the first byte (`FIRST_BYTE_DELAY_MS`). The request leaves the client
  after it read `starttime`, so by the time it sees a Content-Length a full second has passed and
  `time_elapsed` is at least 1. Side effect: the client's first check sees 0 of 0 bytes and blocks on
  the transfer, so its window does not redraw until the download ends (it does the same on any slow
  start).
- `insecureHTTPParser` on this listener only, for the 1999-era client's bare-LF requests (Node's
  strict parser answers them 400). The listener reads no request bodies and proxies nothing.
- 64 connections at most, 10 s to receive a request. Bind failures (`EADDRINUSE`, `EACCES`) go into
  the status, never stop Pyrodeck. Saving the settings starts, stops or moves the listener.

### C.3 Link and UI

- `POST .../download-url/host` builds `<publicBaseUrl>/missions/<encodeURIComponent(file)>`, refuses
  retail, non-`.mn3` and over-86-character links, and a profile whose missions directory is not the
  host's, then calls the Addendum B rewriter (backup and restore unchanged).
- Launch panel, **Mission Downloads**: on/off, port, public URL, state (green dot and port, or the
  bind error). Config tab mission panel: "Hosted by Pyrodeck" / "Not hosted by Pyrodeck" with the
  exact link, **Host this mission**, **Test** (server-side GET through the public URL, compared by
  size and SHA-256 with the disk; the UI says that only a client outside the LAN proves reachability).

**Verified 2026-10-07:** unit and integration tests (allowlist, URL builder, a listener on an
ephemeral port: byte-identical body with Content-Length, 404 for retail, traversal, non-`.mn3`,
unknown, wrong-case and `/api/...`, the bare-LF request, the hold, bind failure). Manual run on
127.0.0.1:3001/3002: `curl -sI` and a SHA-256 match on a 5.4 MB mission, refusals, port move and
disable without a restart. **Not verified:** a real game client downloading from the listener.

### C.4 Playlists and stock missions (v0.5.7, branch `feature/playlist-hosting`)

**Stock missions.** `STOCK_MISSIONS` (`Mn3UrlRewriter.ts`) lists the 18 missions that ship with the retail game,
compared lower-cased: `bedlam`, `bluedev`, `bside`, `bsidectf`, `chaos`, `d3`, `d3_2`, `dementia`, `frenzy`, `fury`,
`havoc`, `kata12`, `mayhem`, `merc`, `poe`, `stonecutter`, `training`, `tri-pod` (`.mn3`). `RETAIL_MISSIONS` stays the
four the engine refuses to advertise (B.1). A stock mission is never served (`isServableMission`), never given a hosted
link (`buildHostedMissionUrl`) and never given a typed one (`checkLinkableMission`, used by `setMissionUrl` and the
`download-url` PUT): "`<file>` ships with Descent 3; every player already has it." (the retail message stays for the
four). Restore takes `checkMissionFilename` only, so a stock mission rewritten by an earlier version can be restored.
The Config tab shows neither **Set link** nor the host block for a mission with `linkError`.

**Hosting one mission** (`gamefiles/missionHosting.ts`, `hostMission`), shared by the host route and playlists:

1. A stock mission is `stock`; a file not listed in the directory is `missing`.
2. Build the hosted link (C.3); a refusal (too long) throws.
3. Read the current links. One of them is the hosted link: `already` (no rewrite, no backup).
4. A `.pyrodeck-orig` backup exists and a current link is neither the hosted one nor the host's link under a former
   public URL: the operator typed it, so a playlist leaves it (`custom`). The host route replaces it.
5. Otherwise rewrite through `setMissionUrl` (B.2): `hosted`, with `backupCreated` on the first rewrite.

**A playlist** (`routes/mission-host.ts`, `hostPlaylistDownloads`) runs only while the host is on with a public base URL
and serves the missions directory of the playlist's server (the activation's `profileId`, else the most recently
launched profile, as for rotation); otherwise it records a `notice` and rewrites nothing. Each mission file is handled
once, in entry order, one at a time; a thrown error becomes that entry's `error` result, never a failed request. It
runs where an entry or the hosted link can change:

- `POST /api/playlists/:id/activate`, after the compatibility check and the activation;
- `PUT /api/playlists/:id` on the active playlist when the set of mission names changed (not on a re-order or a new
  label);
- `PUT /api/mission-host` when the host is turned on, or its public URL changes, while a playlist is active; links at
  the previous URL count as the host's own and move.

Not at rotation or at Pyrodeck start: the rewrites are on disk and stay. A rewrite takes effect the next time the server
loads the mission; nothing is restarted. On Windows the mission the running server has loaded cannot be replaced (B.2),
so it is an `error` entry.

The report, `{ playlistId, at, summary, notice?, results: [{ entryId, label, file, outcome, url?, urls?, backupCreated?,
urlBackup?, message? }] }` with `outcome` one of `hosted`, `already`, `custom`, `stock`, `missing`, `error`, goes to
the log (a summary line and a line per hosted, failed, missing or custom mission), to the response, and to
`PlaylistManager.setDownloads`: `GET /api/playlists/status` and `playlist_status` carry it as `downloads` until the next
activation, a deactivation or the host being turned off. It is not saved. `summary` counts mission files, hosted and
already together: "9 hosted, 3 ship with the game, 1 has its own link, 1 missing, 1 failed" (zeros left out). The
sidebar shows "Downloads: <summary>" with the problem entries in its tooltip; the playlist editor lists them under the
line; the Mission Downloads panel shows the result of its own save.


## Addendum D — Operations (2026-10-07, branch `parity/ops`)

**Goal:** the operations side of D3Server3 parity (`docs/D3SERVER3_AUDIT.md` §3 items 12, 14, 15; §1.3's
emails, service mode and priority class). No `$` command or console output changes.

### D.1 Engine facts (Matcen source, read 2026-10-07)

- **Command line** (`Descent3/args.cpp`): a flag matches case-insensitively with any of the prefixes `-`, `--`, `+`
  (`SkipArgPrefix` :91, `FindArg` :107-128); the first occurrence wins (scan from 1, :115); a value is the next argument.
  At most 30 arguments of at most 100 bytes each (`args.h` :22-23, copied with `strncpy` at :83). `-d` (exact, lower case)
  also names the server config (`FindArgChar("-dedicated", 'd')`, `dedicated_server.cpp` :322); the config is
  `GameArgs[t + 1]` (:340). `+host` is `-useport` (`init.cpp` :1811-1814) and `+ip` is `-useip` (`networking.cpp`
  :591-594). Read elsewhere: `-autoexec` (`dmfcbase.cpp` :4921), `-pxoport` (`init.cpp` :1819), `-gamespyport`
  (`gamespy.cpp` :144), `-gspyfile` (:113), `-framecap` (`init.cpp` :1091), `-nomultibmp` (:1078), `-tempdir` (:1971).
- **`$players`** (`dmfcinputcommand.cpp` :394) prints `PNum Name` then `%02d: %s` per connected, playing slot
  (`CheckPlayerNum`, `dmfcbase.cpp` :1801). On a dedicated server slot 0 is the server (`multi_server.cpp` :757, named
  `-Server-` at `dedicated_server.cpp` :301). Verified on the Matcen Debug build: an empty server answers
  `PNum Name` / `00: -Server-`, after the console's own echo line.
- **Process priority** is not an engine setting. Linux nice values are per thread; the dedicated server runs three
  threads, the SDL audio hotplug thread at nice 19 of its own accord (seen with `ps -L`).

### D.2 Weekly schedule (`ops/schedule.ts`, `ops/Scheduler.ts`, `routes/schedule.ts`)

- Per profile: `schedule: { enabled, windows: [{ day 0-6, start "HH:MM", end "HH:MM" }], stopWaitMinutes 0-240
  (default 15) }`, at most 28 windows. An end at or before the start ends the next day. Times are the Pyrodeck
  machine's local clock; each occurrence becomes absolute instants through the local `Date` constructor, so a time in
  the spring gap moves forward by the gap and an end in the autumn repeat ends at its first occurrence. Overlapping or
  touching windows merge into one run.
- A 30 s tick (the first 10 s after Pyrodeck starts), edge-triggered on runs: at a run's start, the profile is
  started through the Launch panel's own path (`ServerInstance.start`; `server.started{reason:"schedule"}`) if nothing
  is running; another profile's server or a playlist restart in progress skips it (`schedule.skipped` event, error
  toast). At the run's end, if the profile's
  server is running, it is stopped (`ServerInstance.stop`: SIGTERM, no `quit`; `server.stopped{reason:"schedule"}`) as soon as `$players` lists no
  human (slot 0 and `[BOT]` callsigns excluded), and at `end + stopWaitMinutes` regardless; without a console session the
  count is unknown and the stop waits for the deadline. One `say` when the wait begins.
- Nothing is persisted but the settings. After a Pyrodeck restart: inside a run, the start is made; outside one, nothing
  is stopped. A server stopped by hand inside a run stays down until the next run.

### D.3 Email alerts (`ops/mailSettings.ts`, `ops/MailNotifier.ts`, `routes/alerts.ts`)

- `pyrodeck.json` `mail: { enabled (false), host, port, tls, user, password, from, recipients (≤ 10), events }`. The
  password is stored as entered (SMTP AUTH needs it), never returned (`passwordSet`), never logged; `pyrodeck.json`
  is written with mode 0600. Addresses are single mailboxes with no spaces, commas, angle brackets or line breaks.
- Events from the bus: `server.started` (manual → started; relaunch → relaunched; schedule → started, schedule;
  playlist → not mailed), `server.stopped` (manual, empty-restart → stopped; schedule → stopped, schedule; playlist →
  not mailed), `server.crashed`, `server.hung`, `player.kicked`, `player.banned` (a reason matching `/profan/i` is a
  profanity ban), `schedule.skipped`. Mailed when any of its checklist entries is ticked. Defaults: crashed, hung,
  relaunched, banned, profanity ban, schedule on; started, stopped, kicked off.
- Batching: a burst is sent 10 s after its first event, never sooner than 60 s after the previous mail; identical events
  are listed once; at most 50 per mail (the rest counted). nodemailer, 10 s connect and greeting timeouts. `none` sends
  plain SMTP (`ignoreTLS`), `starttls` requires the upgrade, `tls` is implicit TLS.

### D.4 Process priority (`ops/processPriority.ts`, `routes/process-priority.ts`)

- `pyrodeck.json` `processPriority`: `below-normal` (`PRIORITY_BELOW_NORMAL`, 10), `normal` (0), `above-normal` (−7),
  `high` (−14), Node's `os.constants.priority`; on Windows libuv maps them to the priority classes of the same names.
  Applied on every `server.started` (Normal at launch changes nothing) and on a change while a server runs.
- Linux: every thread in `/proc/<pid>/task` is set, except one already below both the main thread and the target (the
  hotplug thread). EACCES/EPERM gives a warning (log, toast, `last.warning`); ESRCH is ignored.

### D.5 Update notice (`ops/updateCheck.ts`, `routes/update-check.ts`)

- `GET https://api.github.com/repos/<owner>/<repo>/releases/latest` for the repository in the root `package.json`
  (mirrored as `REPOSITORY_URL` in `version.ts`, enforced by a test), 5 s timeout, cached 24 h (a failure 1 h). Semantic
  version comparison with pre-release precedence. The link is the release's `html_url` only when it is under
  `https://github.com/<owner>/<repo>/releases/`. `pyrodeck.json` `updateCheck: { enabled (true) }`. While the repository
  is private the API answers 404 and no banner shows.

### D.6 Import from a launch script (`ops/launchScript.ts`, `routes/launch-script.ts`)

- Shell from the extension, else from the content. cmd: `^` continuations, `set` variables, `%~dp0`/`%CD%`, `cd /d`,
  `pushd`, `start ["title"] [/d dir] [/min] [/high…]`, `call`. sh: `\` continuations, `NAME=value`, `$(dirname "$0")`,
  `${0%/*}`, `cd`, `exec`, `nohup`, `env`, `nice`, `screen`, a command inside one quoted argument (tmux, `sh -c`).
  Redirections and pipes are dropped.
- The plan: game path = the directory changed to, else the program's, else the config's; config file = the
  `-dedicated` value's name (it must be in the game path, Pyrodeck passes `-dedicated ./<cfg>`); `-autoexec` of the game
  path's own `autoexec.dmfc` is dropped (Pyrodeck passes it); the first `-useip`, `-useport`, `-framecap`,
  `-nomultibmp`, `-gamespyport` and `-gspyfile` (aliases `+ip`, `+host` included) become `launchOptions`, each checked
  as the profile form checks it (a refused value stays an imported flag, with a note); every other argument is kept
  verbatim on the profile as `importedArgs`, shown in the Launch panel. The client creates the profile with
  `POST /api/profiles` (`existingConfigFile`, `launchOptions`, `importedArgs`), so a config missing from the game path
  is refused there.

### D.7 Service mode

Documentation only: `docs/running-as-a-service.md` (NSSM, `sc.exe` and why it needs a wrapper, `schtasks`, a systemd
user unit; working directory, `PYRODECK_CONFIG_DIR`, log capture; `KillMode=process` / `AppKillProcessTree 0` to keep
the game server running across a Pyrodeck restart).

---

## Addendum E — Supervisor (D3Server3 parity, 2026-10-07, branch `parity/sup`)

The behaviours `docs/D3SERVER3_AUDIT.md` ranks 1, 3 and 13: relaunch after a crash or a hang, restart
when empty after an uptime limit, and re-attach after Pyrodeck restarts. Engine facts are cited from
the Matcen tree (`Descent3/`, `netgames/`).

### E.1 Server events and the lines behind them

`packages/server/src/events/ServerEvents.ts` is the bus. `ProcessManager` emits `server.started`
(with the reason the caller passed: `manual` for the Launch button, `playlist` for a rotation,
`relaunch` for the supervisor), `server.stopped` (the reason passed to `stop()`) and `server.crashed`
(an exit nobody asked for). An exit within 30 s of the echo of a `quit` typed at a remote console
(`[<address>] quit`, printed for every console line by `DedicatedReadTelnet`, dedicated_server.cpp;
`Quit` is a console variable whose setter leaves the game, `SetCVarNone`) is a stop on request:
state `stopped`, `server.stopped` with `reason: "manual", via: "console"`.

`launcher/consoleQuit.ts` watches the launched process's stdout (the console when re-attached, E.5)
for that echo. Joins, leaves, chat and level starts come from the console event hub
(`events/consoleEventHub.ts`, `events/consoleLines.ts`; §8.8.1 lists the
lines): it reads Pyrodeck's console session from its login, so it also works in Connect mode and for a
re-attached server, and it is the only emitter of `player.joined`, `player.left`, `player.chat` and
`level.started`. The join line repeats for every player at each level start (`OnClientPlayerEntersGame`
runs per level), so the supervisor and the respawn scaler count callsigns as a set: a join of a name
already in the game is a re-entry. Bots (`[BOT]` callsigns) are reported with `bot: true` and never
counted as players.

### E.2 Relaunch after a crash

`launcher/Supervisor.ts`, wired in `servers/ServerInstance.ts`. A process that exits in state `crashed`
(no `stop()` and no console `quit`, E.1) is relaunched with the same `LaunchConfig` (same profile,
config file, executable and arguments; a new log file next to the last one) and
`server.started{reason:"relaunch"}`. The wait is 5 s, doubling per failure to 2 min; failures older
than 30 minutes are forgotten; the seventh failure inside 30 minutes gives up (`gaveUp` in the
status, an error toast) until the next launch by hand. A relaunch that cannot spawn counts as a
failure. Launching by hand cancels a pending relaunch and resets the count;
`POST .../cancel-relaunch` drops it without launching.

Left alone: a stop on request (`server.stopped`: the Stop button, a rotation, the scheduler, a
console `quit`), and a crash while the rotation health check (`RotationHealthMonitor`) is pending.
That crash belongs to the rotation, which retries once and then pauses the playlist; the launcher
reads `rotationHealth.isPending()` before the health check reacts to the crash, because the check is
idle once it gives up.

`ServerInstance.stop(reason, {kill})` is the one stop path (Stop button, supervisor;
the scheduler should use it with `"schedule"`). Only a manual stop sends `quit`; the others close
Pyrodeck's console session first and signal the process, as a rotation does, so the console port
is not left in TIME_WAIT on the server's side.

### E.3 Hang check

`launcher/HangWatch.ts`. The engine services the remote console once per server frame
(`DoDedicatedServerFrame` → `DedicatedReadTelnet`, dedicated_server.cpp) and echoes each line it
reads before running it, so any console output proves the main loop turns and any command makes
it print. Once the console is logged in, every chunk of console output resets the silence. After
`hangProbeAfterSec` (default 59) of silence it sends `$players`
(`DMFCInputCommand_Players`, dmfcinputcommand.cpp: a header and one line per player, printed with
`DPrintf` = `PrintDedicatedMessage`, Game2DLL.cpp; vanilla and Matcen alike, and it refreshes the
player count for E.4). With no output for `hangRestartAfterSec` (default 120) in all it emits
`server.hung`, kills the process (SIGKILL, no `quit`: a stuck loop never runs it, and the engine's
SIGTERM handler runs shutdown code in the same stuck process, sdlmain.cpp `fatal_signal_handler`)
and relaunches it with the E.2 backoff. No `server.stopped` or `server.crashed` follows the kill.

Level loads: no probe and no kill for 120 s after `level.started`. 3202 loads in the Matcen soak
lab's logs took at most 0.98 s from `Opening level` to the end of the load, and the end of a level
to the next `Opening level` about 1 s; builds before 0.9.15 stopped running frames for up to 48 s
after a load (lab log, lazy navigation build on the main thread) and 100 s on DownTown (§3.3). A
server that hangs during a load is found 120 s + 61 s after the load began.

If the console link drops while the process runs, Pyrodeck logs in again every 5 s (D3Server3
does the same); the silence keeps counting, so a server that accepts the TCP connection but never
prompts for the password is still found hung.

### E.4 Restart when empty

Off by default. Checked every 15 s (D3Server3's timer): uptime above `emptyRestartAfterHours`
(default 24), no human on the server, and at least `emptyRestartGraceSec` (default 130, D3Server3's
value) since the last one left (since the start if nobody joined). Humans are counted from
`player.joined`/`player.left` (E.1; `[BOT]` callsigns never count, a callsign counts once) and from every `$players` reply
(slot 0 is the server itself). Before restarting, `$players` is sent once more and the restart
happens only if its reply parses and lists no human. Then `server.stopped{reason:"empty-restart"}`
and an immediate relaunch (`server.started{reason:"relaunch"}`), not counted as a failure. Not
during a rotation. A re-attached server (E.5) counts as unknown until its first `$players` reply.

Settings are global (`pyrodeck.json` → `supervisor`, validated like `missionHost`):
`relaunchOnCrash` (true), `hangCheck` (true), `hangProbeAfterSec` (59, 10..3600),
`hangRestartAfterSec` (120, at least probe + 10, up to 7200), `emptyRestart` (false),
`emptyRestartAfterHours` (24, 0.1..8760), `emptyRestartGraceSec` (130, 0..3600).

`supervisor` in `GET /api/launcher/status`: `settings`, `enabled`, `relaunchCount`,
`recentFailures`, `pendingRelaunch {at, cause}`, `gaveUp {at, reason}`, `lastCrash {at, code,
signal}`, `lastHang {at, silentForMs}`, `hang {state: off|listening|probing|loading, silentForMs,
probeAt, restartAt}`, `uptimeMs`, `humans` (null = unknown), `emptySince`, `emptyRestart` (why not
yet, null when off), `adopted`. The process status also carries `stopReason`.

### E.5 Re-attach after Pyrodeck restarts

For the server to outlive Pyrodeck, `ProcessManager.start` spawns it `detached` (its own process
group on POSIX, so a Ctrl+C or SIGHUP to Pyrodeck's group does not reach it; outside libuv's
kill-on-close job object on Windows), and on POSIX through
`/bin/sh -c 'trap "" PIPE; exec "$0" "$@"' <exe> <args>`. Without that, the first write to stdout
after Pyrodeck exits raises SIGPIPE, which kills the server: the engine installs no SIGPIPE handler
(`install_signal_handlers`, sdlmain.cpp) and libuv resets every signal in the child. An ignored
signal survives `exec`; the PID and `/proc/<pid>/cmdline` are the server's.

`config/running-server.json` (`launcher/runRecord.ts`) holds `pid`, `profileId`, `executablePath`,
`gamePath`, `configFile`, `args`, `logPath`, `telnetPort`, `startedAt` and, on Linux, the process's
start time in clock ticks (`/proc/<pid>/stat` field 22) and `/proc/sys/kernel/random/boot_id`. It is
written on `server.started` and removed when the process goes down; the console password is not
stored. At startup Pyrodeck adopts the process only if (Linux) it is alive and not a zombie, the
boot ID and start ticks match (so a reused PID is never taken), argv[0] is the executable and
`-dedicated` is among the arguments; elsewhere if `process.kill(pid, 0)` finds it, it started after
the last boot, and a login to its console port with the config file's password succeeds. Anything
else removes the record and logs why.

An adopted process: state `running`, `adopted: true`, `server.adopted` on the bus; the console logs
in (no post-start settings; the playlist timer is anchored once, and a rotation the last Pyrodeck left under way is
settled: "Position across a Pyrodeck restart" under Server Playlists); Stop sends `quit`, then SIGTERM
and SIGKILL by PID; its exit is found by polling every second (exit code unknown, so an exit
without a request is a crash and the supervisor relaunches it). Its stdout went to the old
Pyrodeck, so the Output tab and log get nothing more; the console then feeds the line monitor
(E.1) and the playlist's level detection instead.

### E.6 UI

Launch panel, **Supervisor** (below the Launch/Stop button, above Mission Downloads;
`components/SupervisorSettings.tsx`). The title row shows a dot and a word: Watching, Probing,
Relaunch in N s, Gave up or Off. Always visible: the give-up reason, a pending relaunch with its time
and a **Cancel** button, `Relaunches: N · last crash HH:MM:SS (signal or exit) · last hang`,
`Up … · N players · empty since …` while a server runs, the hang line (`Console answering`,
`Console quiet N s (probe at 59 s)`, `$players sent, restart in N s without an answer`, or
`Level loading: hang check paused`), and `Empty restart: <why not yet>` when that rule is on.
Opening it shows the three switches with their numbers (probe after / restart after in seconds;
uptime limit in hours, wait after the last player in seconds) and Save; a refused value shows the
server's reason. The process status row gains a `Re-attached` badge and a line saying what works
for an adopted server and that its output is no longer captured, and a signal badge for a crash.
The launcher status is polled every 2 s while a server is up and every 5 s while it is down, so a
relaunch shows without a reload.

## Addendum F — Autostart (2026-10-08, v0.5.3, branch `ops/autostart-env-checksums`)

Pyrodeck re-attaches to a server that survived its own restart (E.5), but after a reboot no server survives and
nobody presses Launch. Autostart launches one profile when Pyrodeck starts.

### F.1 Which profile

`launcher/autostartSettings.ts`. `PYRODECK_AUTOSTART_PROFILE` (read once at startup; unset or blank = not set) names
the profile by its exact, case-sensitive name, else by id; two profiles of that name is an error. Otherwise
`pyrodeck.json` `autostart.profileId`, set by the profile form's **Start when Pyrodeck starts**
(`PATCH /api/profiles/:id { autostart: true }` makes the profile the one, replacing another; `false` clears it only if
it is this profile; any other value is a 400). Deleting the profile clears it. While the variable is set the UI box is
locked, and a PATCH that sends `autostart` anyway is stored and answered with a warning that the variable wins.
Neither set: no autostart. Since several servers (Addendum H.6), the UI setting is a list in `servers.json` and
`PYRODECK_AUTOSTART_PROFILES` names several; each listed profile starts with its own guard.

### F.2 When, and how

`launcher/Autostart.ts`, wired in `servers/ServerInstance.ts`; `index.ts` calls it once after `listen`, and
`launcherRoutes` has re-attached by then. Once per Pyrodeck process:

1. No profile set: state `off`, nothing logged. Unknown or ambiguous name, or the UI's profile deleted: state
   `error`, `console.error` naming the profiles that exist, nothing launched, no throw.
2. A server is running (re-attached), or re-attach found one it could not adopt (its config lost
   `ConsolePassword`), or re-attach threw: state `skipped` with the reason, nothing launched.
3. Otherwise, after the playlist state is restored, `ServerInstance.start({ profileId, reason: "autostart" })`, the Launch
   button's path. Playlists are global: the restored playlist's `needsInitialSync` is false, so the server starts on
   the `MissionName` its last rotation wrote into the profile's config and rotation carries on; a paused playlist
   stays paused; rotations restart the most recently launched profile, which `markLaunched` makes this one.
   `server.started.reason` is `autostart` (mailed as `started`).

### F.3 Crash-loop guard

A failure is a launch that `ServerInstance.start` refuses or `ProcessManager.start` throws on, or a process that goes down
(`crashed`, or `stopped` with reason `hang`) within `AUTOSTART_QUICK_EXIT_MS` (60 s) of `server.started`.
`AUTOSTART_MAX_FAILURES` (5) in a row: state `failed`, `console.error` and a toast with the last reason, and
`Supervisor.giveUp(reason)`, which cancels a pending relaunch and sets the supervisor's `gaveUp`; a supervisor that
has given up schedules nothing until a deliberate launch (`processStarted` with a reason other than `relaunch`)
clears it.

Who retries: a refused launch is retried by autostart after `backoffDelayMs(failures)` (5, 10, 20, 40 s; state
`retrying`, `nextAttemptAt`), since the supervisor has no launch config to repeat. A process that went down is the
supervisor's (state `relaunching`): it relaunches after a crash when `relaunchOnCrash` is on and always after a hang;
`server.started{reason:"relaunch"}` starts the next 60 s watch, and a relaunch whose spawn throws counts as a failure
(the supervisor's `relaunch` action reports it). With `relaunchOnCrash` off the first early exit is state `failed`.
`ServerInstance` calls `autostart.processDown` before `supervisor.processDown`, so a tripped guard is in place first.

The guard ends with state `started` once a process has run 60 s, or `cancelled` when someone else acts: a
`server.started` with reason `manual`, `schedule` or `playlist`, a stop on request inside the window, or
`POST /api/launcher/autostart/cancel` during `retrying`.

`autostart` in `GET /api/launcher/status`: `state` (`off`, `error`, `skipped`, `launching`, `retrying`, `watching`,
`relaunching`, `started`, `failed`, `cancelled`), `profileId`, `profileName`, `source` (`env` | `setting`), `reason`,
`failures`, `maxFailures`, `quickExitSec`, `at`, `nextAttemptAt` (retrying), `watchUntil` (watching),
`relaunchPending` (relaunching).

### F.4 UI

Launch panel, **Autostart** (above Supervisor; `components/AutostartStatus.tsx`), hidden while no profile is set and
nothing happened: a dot and a word (Checking, Retrying n/5, Relaunching n/5, Started, Gave up, Handed over, Server was
running, Not started), the profile and its source, and one line for the state (the reason, failures n of 5, the next
retry with **Cancel**, the give-up). Profile form: **Start when Pyrodeck starts**, with the profile it replaces, or
locked with the variable's value.

## Addendum G — Phone layout, shared session, roster round-trip (2026-10-22, v0.5.5, branch `feature/mobile-ui`)

### G.1 Decision

The operator runs the public server from a phone. The desktop layout (§7) stays as it is until the reveal brings
feedback; below 768 px the client renders a second shell instead. Both shells read one session, so nothing is
duplicated server-side and nothing is lost switching between them.

### G.2 Session

`session/SessionProvider.tsx` instantiates the connection, launcher, toast, playlist and server-info hooks once,
above both shells, together with the mode (`pyrodeck-mode`) and two `LineBuffer`s (`lib/lineBuffer.ts`): the console
(`output` messages plus typed commands, 2000 lines) and the game process (`process_output`, 5000 lines, stdout and
stderr apart). Buffers join partial lines per kind and notify once per animation frame. The desktop xterm consoles
replay the buffer on mount, so scrollback survives leaving a tab. `App` picks the shell with `useIsMobile()`:
`(max-width: 767px)` unless `localStorage["pyrodeck-layout"]` is `desktop`.

### G.3 Routes

The phone shell lives in the URL hash (`lib/hashRoute.ts`, `hooks/useHashRoute.ts`): `#/server`, `#/console`,
`#/console/output`, `#/players`, `#/players/history`, `#/bots`, `#/more`, `#/more/profiles`, `#/more/config`,
`#/more/config/server`, `#/more/config/roster`, `#/more/config/raw?file=`, `#/more/config/files`,
`#/more/playlists`, `#/more/logs`, `#/more/bans`, `#/more/rules`, `#/more/settings`. A tab tap replaces the history
entry (back from a root leaves the app), a stacked screen pushes with its depth in `history.state`, and `back()` walks
history when there is somewhere to go, else replaces with the tab root. Sheets do not enter history.

### G.4 Screens

`components/mobile/`: `MobileApp` (h-dvh, safe-area padding, the keyboard inset from `visualViewport`, the tab bar
hidden while typing), `Screen` (48 px header: wordmark on roots, back and title on stacked screens), `TabBar`,
`ShellStatus`. Screens: Server (mode switch; profile picker sheet; state; Launch, or Stop behind a confirm; the
`ServerSidebar` card when connected; saved servers and the connect form in Connect mode; Manage profiles opens the
Launch panel), Console (`LineView` over the buffer, `ConsoleInput` with favourites, history and `$` suggestions,
`CommandSheet` from `lib/commands.ts`), Players (`usePlayers` + `PlayerCards`; kick and ban in a sheet; History
reuses `PlayerHistory`), Bots (`useBots`, `usePopulation` + `PopulationCard`, `BotCards`, the add-bot sheet, Remove
all behind a confirm), More (Profiles = `LaunchPanel`; Config = `ConfigScreen` with `ServerConfigForm`,
`RosterEditor`, `RawFileScreen` (`useProfileFile`: content, save, the previous version) and the game-file list;
Playlists, Logs, Bans, Rules, Settings reused). Shared panels reused inside the shell get phone-sized controls from
one unlayered CSS overlay scoped to `.pd-mobile` (16 px inputs, 40 px buttons, dark `color-scheme`) and lay
themselves out from their container (`@container` roots, `@md:` grids), so the desktop rendering is untouched.

### G.5 Home-screen app

`public/manifest.webmanifest` (standalone, `start_url /#/server`, icons 192 and 512 from `scripts/make-icons.sh`),
`apple-touch-icon`, `viewport-fit=cover`, the iOS standalone metas, `theme-color`. No service worker: the panel needs
its server.

### G.6 Bot roster: in-place saves, backups, population

`launcher/botRoster.ts`: `BotRosterData { botCount, defaultDifficulty?, targetPlayers?, reservedSlots?, bots[] }`,
with `botCount` the bots that join at start (0..16, independent of the roster's length; entries above it are the
population manager's pool, a count above the roster gets built-in names). `parseBotRoster` reads every numbered
entry and the two population keys, case-insensitive. `updateBotRoster(existing, data)` edits a file in place: managed
scalars replaced where they stand (the file's key casing kept, later duplicates dropped, missing ones inserted after
`BotCount`; a scalar undefined in `data` leaves the line alone), the entry block regenerated with its comments kept
at its head, every other line and the EOL style kept. The Matcen sample roster round-trips byte for byte.
`ServerProfileManager.writeFile` keeps the previous content as `<name>.bak` and writes through a temp file and a
rename. Routes: `PUT /api/profiles/:id/bot-roster` edits in place, `POST /api/profiles/:id/bot-roster/reset` writes
the sample (optionally under a new `filename`, creating the `BotConfig=` line), `GET
/api/profiles/:id/files/:filename/backup`, `POST /api/profiles/:id/files/:filename/restore` (swaps the two).
`parser/parsers/botpopulation.ts` parses the Tier 1 `Population:` line into a `botpopulation` message
(`{manager, target, reserve, humans, bots, seatsUsed, seats, botLimit, note?}`); the client polls `$botpopulation`
every 5 s while the `population` feature is advertised and re-queries 300 ms after `on`, `off`, `target n`,
`reserve n`. The card sits on the desktop Bots tab (above the bot table, the operator's one approved desktop
addition) and on the phone's Bots screen; a server without the feature shows neither.

### G.7 Verification

`scripts/ui-shots.mjs` captures every screen at 390x844, 360x780, 768x1024 and 1440x900, idle and with a launched
server; a desktop capture before the work is the baseline, and `magick compare -metric AE` must report zero for every
idle desktop and tablet screen after it (the Logs tab and the live screens carry changing text). Server vitest covers
the roster round-trip, the population parser and the backups; client vitest covers the line buffer, the hash routes
and the command table.

## Addendum H — Several servers at once (2026-11-15, unreleased, branch `feature/multi-server`)

One Pyrodeck runs several Descent 3 dedicated servers side by side, each with its own profile, ports, console,
supervisor and playlist. This addendum covers the server side; the panel still shows one server (the default, H.7).

### H.1 Servers and ids

`servers/ServerRegistry.ts` creates a `ServerInstance` (§3.5) per profile at startup (`init()`, from `launcherRoutes`)
and when a profile is added; its id is the profile's id, and it only ever launches that profile. `launch` is the server
started from the global `dedicated.cfg` without a profile (its events carry `profileId: "launch"`, `NO_PROFILE_ID`).
`connect` names Connect mode's console session (one remote server) in the list and on the WebSocket; it has no process.
`saved` is reserved (`/api/servers/saved`). A profile id that cannot name a directory (`[A-Za-z0-9._-]`, at most 100)
or is one of these is logged and gets no server. An idle server whose profile was deleted is dropped on the next list.

### H.2 Console sessions and events

`SessionManager` holds every open session: each has an `owner` (a server's id, or `connect`) and the `profileId` its
events carry. A server opens, replaces and closes only its own session; Connect mode replaces only its own. Everything
that talks to "the server's console" asks the server for its session: the supervisor's probes, the schedule's player
count and `say`, periodic commands and respawn scaling, players, bans and rules (`players/activeConsole.ts`, by
profile id), WebSocket commands. `events/consoleEventHub.ts` keeps one `ConsoleEventSource` per session and takes the
profile id from the session (Connect mode: `connect:<host>:<port>`); nothing is guessed from ports. `$rehash` after a
hosts.deny edit goes to every open console.

Each server gets `scopedEvents(bus, id)` as its `events` (`events/ServerEvents.ts`): its supervisor, autostart guard,
quit watch and profile automation hear only events whose `profileId` is the server's, so a join on one server never
counts on another and a start of one does not end another's autostart watch. What a server emits goes through the
shared bus, where alerts, player history, bans, rules, process priority and the event log hear every server.

### H.3 Launch checks and per-server defaults

Every launch (by hand, a playlist rotation and its retry, a supervisor relaunch, the schedule, autostart) passes
`ServerRegistry.reserve()` (the `LaunchGuard`) right before the spawn, one at a time under the registry's launch lock.
`servers/launchConflicts.ts` compares the launch with every other server that holds one: its process is starting,
running or stopping, a playlist rotation is restarting it, a reservation is in flight, or (H.6) a game from before
Pyrodeck's restart still runs without being re-attached. Refused, with a message naming the other server and what to
change (409 from the start routes; a rotation retries once and then pauses the playlist; the supervisor backs off):

| Shared | Why |
|--------|-----|
| Game UDP port (`-useport`, default 2092), also against the other's GameSpy port | the second server runs without network (`init.cpp:1808`, `networking.cpp:746`) |
| GameSpy UDP port set by the operator (`-gamespyport`) | opened on every launch (`gamespy.cpp:144`, `init.cpp:1883`) |
| Console TCP port (`RemoteConsolePort`) | Pyrodeck would log in to the other server |
| Server config file (same game path and file) | a rotation rewrites its `MissionName` |
| Startup Commands file, when it exists or a launch writes Pyrodeck's block | every launch rewrites it |
| Temp directory set by the operator (`-tempdir`) | the second server exits "Unable to create lock file" (`init.cpp:2040`) |

UDP ports clash only on the same `-useip` address or when either binds every address. The operator's settings are
never changed. Where the profile sets nothing, the launch gets `defaultOptions`, merged under the profile's
`launchOptions` (which win) by `buildLaunchArgs`: `tempDir` always, `<os.tmpdir()>/pyrodeck-<12 hex>` (a hash of the
config directory and server id: the same at every launch, different per server and per Pyrodeck; `/tmp`, or the drive
root on Windows, when the system temp path would make it longer than the engine's 99 bytes), with a stale `.lock` in
it removed before the launch (the server is down, so no process of its holds it); and `gameSpyPort`, only when another
server holds 20142: the first free port above it. A log of the same name as another server's live log gets `-2`,
`-3` ... before `.log`. A profile sets its own Startup Commands file with `startupFile` (H.7); default
`autoexec.dmfc`, so a single-server setup is unchanged.

### H.4 Playlists

The library (`playlists.json`) is shared. Each server has its own `PlaylistManager` (active playlist, position, pause,
votes, hold) saved in `servers/<id>/playlist-state.json`; the legacy owner (H.5) keeps `playlist-state.json`. A
rotation restarts its own server: its profile, its config file, its executable, its launch options, through the launch
check; the server without a profile restarts its last launch. While it restarts the server keeps its ports (H.3).
Saving a playlist refreshes it on every server that has it active, and deleting it deactivates it there. Activation
checks the entries against the server's own profile and hosts the missions from its game path; turning the mission
host on, or moving it, hosts every server's active playlist; each server's playlist status carries its own
`downloads`.

### H.5 Files and the upgrade

| File | Holds |
|------|-------|
| `servers.json` | `{ version: 1, autostart: [profileId…], legacyOwner }` |
| `servers/<id>/run.json` | the server's run record (E.5), plus `serverId`, `defaultOptions`, `startupFile` |
| `servers/<id>/playlist-state.json` | the server's playlist state (not the legacy owner's) |
| `running-server.json` | a copy of one running server's record, for a Pyrodeck that ran one server: the legacy owner's when it runs, else the server started first; removed when none runs |
| `playlist-state.json` | the legacy owner's playlist state |
| `pyrodeck.json` `autostart.profileId` | the first of the autostart list |

Not in `pyrodeck.json`, which a Pyrodeck from before saves with only the keys it knows. `servers/serverStore.ts`
`upgradeConfigDir()` runs at every start and is idempotent. Without `servers.json` (the first start): the legacy owner is
the server `running-server.json` names (its profile, else `launch`), else `autostart.profileId`, else the most recently
launched profile, else the only profile, else `launch`; the autostart list is `[autostart.profileId]`; profiles,
schedules, bans, history and playlists are not touched. With it: when `autostart.profileId` is not the list's first, a
downgraded Pyrodeck changed it, and the list follows (that profile first, or the old first dropped when it was
cleared); `pyrodeck.json` is then set to the list's first again. A downgraded Pyrodeck re-attaches to the one server in
`running-server.json`; the others keep running unseen (stop them first).

### H.6 Re-attach and autostart

`reattachAll()` creates a server for every `servers/<id>/run.json` (also a deleted profile's) and for the server
`running-server.json` names, then lets each re-attach (E.5) from its own record and, for that one server, the copy; the
newer live record wins and becomes its own. A live game whose console cannot be logged in to holds its ports (H.3) and
blocks that server's autostart. Then autostart runs once per listed profile, each with its own crash-loop guard (F.3):
`PYRODECK_AUTOSTART_PROFILE` (one name) and `PYRODECK_AUTOSTART_PROFILES` (a comma list of names or ids) together,
when either is set, win over the profiles ticked **Start when Pyrodeck starts**; `PATCH /api/profiles/:id
{ autostart }` now adds or removes one profile of `servers.json`'s list instead of replacing the one. A name that
matches no profile is logged; the others still start. Autostart launches go through the launch check like any other.

### H.7 API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/servers` | `{ defaultServerId, servers: [row] }`: every profile's server, `launch` once used (or when there are no profiles), `connect` while open. Row: `id, kind ("profile"\|"launch"\|"connect"), name, profileId, profileExists, default, state, pid, startedAt, adopted, stopReason, console, log, gameName, gameType, mission, level, humans, maxPlayers, playlist { id, name, status, currentEntry, pausedReason } \| null, ports { bindIp, game, gameSpy, console, tempDir, startupFile }, held { why, pid } \| null, supervisor { enabled, relaunchCount, pendingRelaunch, gaveUp, hang, uptimeMs }, autostart { listed, state, reason }` (ports: the running launch's, else what the next launch would use) |
| `GET` | `/api/servers/:serverId` | One row |
| `POST` | `/api/servers/:serverId/start` | Launch it beside the others (409 with the clash, H.3) |
| `POST` | `/api/servers/:serverId/stop` | Stop it |
| `GET` | `/api/servers/:serverId/status` | As `GET /api/launcher/status`, plus `serverId`, `console`, `capabilities`, `playlist` |
| `POST` | `/api/servers/:serverId/command` | Body `{ command }` (one line): `{ serverId, reply, parsed: { type, payload } \| null, problems }`; 409 while its console is not logged in |
| `GET` | `/api/servers/:serverId/players` | `{ serverId, profileId, humans, players }` (the tracker's players in its game) |
| `GET` | `/api/servers/:serverId/playlist` | Its playlist status |
| `POST` | `/api/servers/:serverId/playlist/activate` | Body `{ playlistId }`: `{ serverId, ok, status, downloads }` |
| `POST` | `/api/servers/:serverId/playlist/deactivate` | |
| `POST` | `/api/servers/:serverId/playlist/resume` | 409 when not paused |
| `GET` | `/api/servers/:serverId/supervisor` | Its supervisor snapshot (the settings are every server's) |
| `POST` | `/api/servers/:serverId/supervisor/cancel-relaunch` | 409 when none is pending |
| `GET` | `/api/servers/:serverId/autostart` | As `GET /api/launcher/autostart`, `run` being this server's |
| `POST` | `/api/servers/:serverId/autostart/cancel` | 409 when no retry is pending |

`connect` answers `status`, `command` and `players`, 400 for the rest; an unknown id is 404.

The flat routes stay as aliases (`routes/launcher.ts`, `routes/playlists.ts`, `routes/bans.ts`): the server of the
`profileId` in the body or query; else, for a route that changes something, the only server running (409 naming the
`/api/servers/:serverId/...` route when several run); else the default server. `POST /api/launcher/start` still
refuses while any other server runs (409 naming `POST /api/servers/<id>/start`) and still replaces a Connect-mode
session. `POST /api/playlists/deactivate` and `/resume` take the only server whose playlist is active (or paused).
`POST /api/players/kick` and `/ban` take `profileId`, else the one open console (409 when several are open).
`GET /api/players/present`, `/settings` and `/rules` take `?profileId=`. `PUT /api/launcher/supervisor` applies to every
server. `GET /api/launcher/autostart` adds `envList`, `settingProfileIds`, `profiles` (each with its `run`) and
`errors`. `PUT /api/process-priority` applies to every running server; both priority routes add `byServer`. The log
routes and retention protect every server's live log.

The default server (`defaultServerId()`) is what a single-server client means by "the server": the one with a process
or console session open; with several, the one that was the default already, else the one started first (Connect
mode counts while its session is open); with none, the last default (at first, the legacy owner). An alias that names
a profile makes it the default while the default has nothing running.

Profiles: `POST /api/profiles` takes `remoteConsolePort` (1-65535, written into the new config file) and, for a new
profile, `launchOptions` (refused with 400 when invalid). `PATCH /api/profiles/:id` takes `startupFile` (a plain
`.dmfc` name in the game directory, at most 64 characters; `null` or `""` goes back to `autoexec.dmfc`) and
`launchOptions.tempDir` (an absolute path of at most 99 bytes, `-tempdir`). `GET /api/profiles/:id/companions` reports
the profile's Startup Commands file.

### H.8 WebSocket

One `/ws`. A server's messages (`process_state`, `process_output`, `output`, `connection_state`, `capabilities`,
`playlist_*`, `level_changed`, `serverinfo`, its `error`s) are sent as `{ type, serverId, payload }` to a socket that
sent `{ type: "hello", payload: { protocol: 2 } }`; the reply is `{ type: "hello", payload: { protocol, defaultServerId,
servers } }`, then each server's `connection_state`, `capabilities` and `level_changed`, tagged. A socket that never
says hello gets the default server's messages only, untagged, and its greeting at connect, exactly as before. Global
messages (`ping`, errors of no server: schedule, process priority) go to every socket untagged. `{ type: "command",
payload: { command, serverId? } }` runs on the named server's console (protocol 2), else on the default server's; the
parsed reply (`players`, `bots`, ...) comes back to that socket, tagged for protocol 2.

### H.9 Verified, and not yet

Server vitest runs three servers on one bus with stand-in processes and consoles (`servers/testing/fakeGames.ts`):
launches side by side, a crash and relaunch of one, a human on one and the restart-when-empty of another, two
rotations at once, each refusal, the defaults, re-attach to several, `running-server.json` from an older Pyrodeck, the
autostart list; the upgrade cases (fresh, 0.5.x idle, 0.5.x running with a playlist, running without a profile,
downgrade then upgrade, idempotent); the API, the aliases and the hello over Fastify's inject. The built server was run
against a scratch config directory with a stand-in game executable: three servers launched, logged in and listed;
two rotations at the same moment; Pyrodeck restarted and re-attached to all three; two profiles autostarted.

Only real servers can show: two games on one machine with clients on both; `-tempdir` on retail 1.4 and PiccuEngine;
a separate `-autoexec` file per profile read by DMFC; `systemctl restart` with `KillMode=process` re-attaching
several; the CPU of several bot servers on one VPS; a downgrade to 0.5.7 on a copy of a config directory.

---

*This spec is the handoff artifact for implementation via Claude Code agents. All design decisions are locked unless explicitly revisited. Extend with addenda rather than in-place edits to preserve decision history.*
