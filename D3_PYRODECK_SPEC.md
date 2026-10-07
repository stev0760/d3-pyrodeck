# D3 Pyrodeck — Specification

**Version:** 2.8
**Date:** October 7, 2026
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

- **D3Server3** (Thomas / dateiliste.com, originally by (DE)Hunter) — Windows GUI tool, the gold standard for D3 server management. Features: multi-tracker registration, profanity filter with escalation (warn→kick→ban + email alerts), Windows service mode, auto-restart on hang, process priority control. Many community installers bundled it. Our goal is to rebuild and modernize this experience as a cross-platform web app.
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
1. `"Ending level."` fires → rotation triggered
2. If a vote is in progress, immediately tally votes and use winner; otherwise advance the playlist index per mode
3. Announce next mission in-game: `say Changing mission to: <label>`
4. `processManager.stop()` — graceful quit → SIGTERM → SIGKILL fallback
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
- **IP access control UI**: Edit `hosts.allow` / `hosts.deny` files through the config editor, with a "Reload" button that sends `$rehash`.
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
| `POST` | `/api/auth/login` | Authenticate; returns session token |
| `POST` | `/api/auth/logout` | Invalidate session |

### 8.2 Server Connection

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/server/connect` | Connect to D3 server (host, port, password) |
| `POST` | `/api/server/disconnect` | Disconnect from current server |
| `GET` | `/api/server/status` | Connection state + cached capabilities |
| `GET` | `/api/servers/saved` | List saved server profiles |
| `POST` | `/api/servers/saved` | Add/update a saved server profile (name, host, port) |
| `DELETE` | `/api/servers/saved/:id` | Delete a saved server profile |

### 8.3 Commands

All commands flow through WebSocket for real-time streaming. The REST endpoint is a convenience for one-shot commands.

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/command` | Send a raw command; returns collected response |

**WebSocket message types:**

```typescript
// Client → Server
{ type: "command", payload: { command: string } }

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
| `PUT` | `/api/playlists/:id` | Update playlist |
| `DELETE` | `/api/playlists/:id` | Delete playlist |
| `POST` | `/api/playlists/:id/activate` | Activate playlist (starts rotation on next level end) |
| `POST` | `/api/playlists/deactivate` | Deactivate current playlist |
| `GET` | `/api/playlists/status` | Current PlaylistManager status |

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
| `PUT` | `/api/mission-host` | Body `{ enabled, port, publicBaseUrl }`: validate, save, start/stop/move the listener; returns `{ settings, status, warnings }` |
| `POST` | `/api/mission-host/test` | Body `{ file }`: fetch the mission through the public base URL from the Pyrodeck machine; `{ ok, url, status, contentLength, bytes, matches, elapsedMs, error }` |

With the host on, `details=1` entries also carry `hostUrl` (the link the host serves the mission at) or
`hostError` (why it cannot: retail, too long, another game path). `GET /api/launcher/status` carries
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
| `GET` | `/api/launcher/status` | Process state (running / stopped / crashed) |
| `PUT` | `/api/launcher/config` | Update `dedicated.cfg` settings |

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
- **HTTPS:** Out of scope for the app. Users deploying to VPS should put nginx or Caddy in front. Documented in README.
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

1. Validate the file: a plain `*.mn3` name listed in `gamePath/missions/`, not retail; HOG2 magic,
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
  decoded name is a bare basename ending in `.mn3`, not retail, and listed case-exact by a `readdir`
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

---

*This spec is the handoff artifact for implementation via Claude Code agents. All design decisions are locked unless explicitly revisited. Extend with addenda rather than in-place edits to preserve decision history.*
