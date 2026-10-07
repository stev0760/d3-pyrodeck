# Descent 3 Dedicated Server Reference

Comprehensive reference for running and managing Descent 3 dedicated servers. Compiled from community documentation (descentforum.net/serverops) and engine source analysis.

---

## Command-Line Switches

### Dedicated Server Options

| Switch | Description |
|--------|-------------|
| `-dedicated [config.cfg]` | Start as dedicated server using the specified config file |
| `-useip [IP]` | Bind every server socket (game UDP, remote console, GameSpy) to this IPv4 address. Parsed with `inet_addr`, so a host name is ignored (`networking/networking.cpp:591-599`, `nw_GetThisIP` :847) |
| `-useport [port]` | Game UDP port (default 2092, `D3_DEFAULT_PORT` in `Descent3/descent.h`; `Descent3/init.cpp:1808-1817`) |
| `-gamespyport [port]` | GameSpy query UDP port (default 20142, `Descent3/gamespy.cpp:144-151`) |
| `-gspyfile [file]` | GameSpy tracker list, found under the game directory (default `gamespy.cfg`, `Descent3/gamespy.cpp:113-128`) |
| `-nomultibmp` | The server neither requests nor relays pilot logos (`Use_file_xfer = 0`, `Descent3/init.cpp:1078`, `multi_server.cpp:2703`) |
| `-quitongoal` | Shut down server after goal is reached |
| `-setdir [path]` | Set working directory |
| `-tempdir [path]` | Set temp directory (required for running multiple instances) |
| `-useexedir` | Use executable directory as working directory |
| `-autoexec [file]` | Load a multiplayer config file (.dmfc) on startup |
| `-mission [name]` | Load specified mission at startup |
| `-nointro` | Skip intro movie |
| `-nooutragelogo` | Disable Outrage logo |
| `-pilot [name]` | Skip pilot selection dialog |
| `-framecap [fps]` | Server frame rate: minimum frame time of 1000/fps whole milliseconds (default 60, which also replaces the dedicated server's 30 ms `-limitframe` default; 0 divides by zero; above 500 the frame time is 1 ms). `Descent3/init.cpp:1081-1099` |
| `-playermessages` | Disable weapon-related HUD messages in multiplayer |

Pyrodeck sets `-useip`, `-useport`, `-framecap`, `-nomultibmp`, `-gamespyport` and `-gspyfile` per profile (Launch
panel → Edit → Launch Options) and passes them right after `-dedicated <cfg>`. The engine takes the first occurrence of
a flag and keeps at most 99 characters of each argument (`Descent3/args.cpp`).

### Network Switches

| Switch | Description |
|--------|-------------|
| `-httpproxy [addr]` or `-httpproxy [addr:port]` | Specify HTTP proxy for tracker connections |
| `-nonetwork` | Disable multiplayer networking |

### Rendering (client-side, not typically used for dedicated)

| Switch | Description |
|--------|-------------|
| `-aspect [value]` | Set screen aspect ratio (e.g., 1.78 for 16:9) |
| `-width [w]` / `-height [h]` | Set screen resolution |
| `-framecap [fps]` | Limit framerate |
| `-vsync` | Enable vertical sync |
| `-lowmem` | Use scaled textures and 8-bit sound |
| `-superlowmem` | Maximum memory conservation |
| `-nolightmaps` | Disable lightmaps |
| `-nosound` / `-nomusic` | Disable audio |

---

## Configuration File (dedicated.cfg)

The config file uses `Key=Value` syntax, one option per line. Loaded at server startup via `-dedicated myconfig.cfg`.

All CVars are registered in `dedicated_server.cpp:165-210`. Most are **GAMEINIT** (startup-only). A few are **GAMEPLAY** (runtime-changeable).

### Core Settings

| Parameter | Type | Range | Default | Permission | Description |
|-----------|------|-------|---------|-----------|-------------|
| `GameName=[string]` | STRING | max 32 | "Generic D3 Game" | GAMEINIT | Server name shown in browser |
| `MissionName=[string]` | STRING | max 32 | "fury.mn3" | GAMEINIT | Mission file to load (.mn3) |
| `Scriptname=[string]` | STRING | max 32 | "Anarchy.d3m" | GAMEINIT | Game type DLL name |
| `MaxPlayers=[num]` | INT | 2-32 | 8 | GAMEINIT | Player limit (includes server slot 0) |
| `NumTeams=[num]` | INT | 2-4 | 2 | GAMEINIT | Teams for team game types |
| `Timelimit=[num]` | INT | 0-10000 | 0 | GAMEINIT | Level duration in minutes (0 = no limit) |
| `Killgoal=[num]` | INT | 0-10000 | 0 | GAMEINIT | Points/kills to end level (0 = no limit) |
| `RespawnTime=[num]` | INT | 0-10000 | 60 | GAMEINIT | Powerup respawn time in seconds |
| `PPS=[num]` | INT | 2-40 | 10 | GAMEINIT | Packets per second (30 recommended) |
| `SetDifficulty=[0-4]` | INT | 0-4 | 2 | GAMEINIT | 0=Trainee, 1=Rookie, 2=Hotshot, 3=Ace, 4=Insane |
| `SetLevel=[num]` | INT | - | 1 | GAMEINIT+GAMEPLAY | Starting level (runtime: warps to level) |
| `MOTD=[string]` | STRING | max 400 | "" | GAMEINIT | Message of the day |

### Game Types (Scriptname values)

These are `.d3m` files in the `netgames/` directory:

- `Anarchy` — Free-for-all deathmatch
- `Team Anarchy` — Team-based deathmatch
- `CTF` — Capture the Flag
- `Monsterball` — Push the ball into the goal
- `Entropy` — Capture and hold rooms
- `Hoard` — Collect orbs and score at goal
- `Hyper-Anarchy` — Anarchy with bonus modifiers
- `Robo-Anarchy` — Anarchy with single-player AI enemies active
- `Co-op` — Cooperative (sets NF_COOP flag)

### Network Settings

| Parameter | Type | Default | Permission | Description |
|-----------|------|---------|-----------|-------------|
| `ConnectionName=[string]` | STRING max 35 | "Direct TCP~IP" | GAMEINIT | Connection type |
| `Peer2Peer=[0/1]` | INT | 0 | GAMEINIT | Peer-to-peer networking (sets NF_PEER_PEER, clears NF_PERMISSABLE) |
| `Permissable=[0/1]` | INT | 0 | GAMEINIT | Permissible client-server (sets NF_PERMISSABLE, clears NF_PEER_PEER) |
| `SendRotVel=[0/1]` | INT | 0 | GAMEINIT | Send rotation velocity for smooth interpolation (NF_SENDROTVEL) |
| `UseSmoothing=[0/1]` | INT | 0 | GAMEINIT | Enable position smoothing (NF_USE_SMOOTHING) |
| `Gamespyport=[port]` | INT | 20142 | GAMEINIT | GameSpy query port (for multiple servers on one machine) |

Note: `Peer2Peer` and `Permissable` are **mutually exclusive** — setting one clears the other. Neither set = standard client-server model.

**Connection models:**
- **Client/Server (default)**: Server authoritative. Clients send inputs, server sends positions.
- **Peer2Peer=1**: Pseudo peer-to-peer. Position packets sent to all clients.
- **Permissable=1**: Clients need server permission to fire weapons. More anti-cheat.

**Command-line only network settings** (not in dedicated.cfg, use `-flag` switches):
- `-useport [port]` — Network port (default 2092)
- `-useip [address]` — Bind to specific IP
- `-nomultibmp` — Disable custom ship bitmaps (prevents crashes from corrupted logos)
- `-gamespyport [port]` — Alternative to cfg Gamespyport

### Remote Console (Telnet)

| Parameter | Description | Default |
|-----------|-------------|---------|
| `AllowRemoteConsole=[0/1]` | Enable telnet administration | 0 |
| `RemoteConsolePort=[num]` | TCP port for telnet connections | 2092 |
| `ConsolePassword=[string]` | Password for telnet login | |

### Tracker / Online

| Parameter | Description |
|-----------|-------------|
| `PXOUsername=[string]` | Parallax Online username |
| `PXOPassword=[string]` | Parallax Online password |
| `PXOHostingLobby=[string]` | PXO lobby name when hosting |

### Gameplay Modifiers

| Parameter | Type | Permission | Description |
|-----------|------|-----------|-------------|
| `AccurateCollisions=[0/1]` | INT | GAMEINIT | Polygon-accurate collision detection (NF_USE_ACC_WEAP) |
| `BrightPlayers=[0/1]` | INT | GAMEINIT | Brighten all player ships for visibility (NF_BRIGHT_PLAYERS) |
| `RandomizeRespawn=[0/1]` | INT | GAMEINIT | Randomize powerup respawn locations (NF_RANDOMIZE_RESPAWN). **On by default** |
| `AllowMouselook=[0/1]` | INT | GAMEINIT | Allow mouselook in multiplayer (NF_ALLOW_MLOOK) |
| `AudioTauntDelay=[seconds]` | FLOAT | GAMEINIT | Minimum seconds between audio taunts |
| `MultiSettingsFile=[string]` | STRING max 40 | GAMEINIT | Load additional .mps settings file (see MPS Format below) |

### Powerup Control

Use `AllowPowerup` and `DisallowPowerup` to control which items spawn. Multiple entries allowed. Names are **case-insensitive** (uses `stricmp` via `FindObjectIDName()`).

```
AllowPowerup=SuperLaser
DisallowPowerup=ProxMinePowerup
DisallowPowerup=Betty4Pack
```

For the complete list of all valid powerup names, see [d3-powerups-and-ships.md](d3-powerups-and-ships.md).

### Ship Control

There is **no direct cfg key** for ship banning. Ship permissions must be set via a `.mps` file loaded with `MultiSettingsFile`:

```
MultiSettingsFile=myserver.mps
```

See the MPS Format section below for `SHIPBAN` syntax.

### Bot Configuration (Matcen Fork)

| Parameter | Type | Permission | Description |
|-----------|------|-----------|-------------|
| `BotConfig=[string]` | STRING max 259 | GAMEINIT | Path to bot roster file |

### Runtime Logging and Actions

| Parameter | Permission | Description |
|-----------|-----------|-------------|
| `StartRtLog` | GAMEPLAY | Start real-time logging (fire-once, no value) |
| `StopRtLog` | GAMEPLAY | Stop real-time logging (fire-once, no value) |
| `Quit` | GAMEPLAY | Shut down server (fire-once) |
| `EndLevel` | GAMEPLAY | End current level (fire-once) |
| `Say=[message]` | GAMEPLAY | Broadcast chat message (max 200 chars). Supports team prefixes |

### Settings Not Available in dedicated.cfg

These DMFC commands have **no cfg CVar** — set them via `autoexec.dmfc` or send after server start:

| Command | Description |
|---------|-------------|
| `$serverhudnames [full/team/none]` | Max allowed HUD name display level |
| `$killmsgfilter [full/simple/none]` | Death message verbosity |
| `$autosavelevel [on/off]` | Auto-save stats on level end |
| `$autosavedisconnect [on/off]` | Auto-save stats on disconnect |
| `$hudnames [full/team/none]` | Client HUD name display |
| `$statmsgs [on/off]` | Statistical HUD messages |

---

## MultiSettingsFile (.mps) Format

Loaded via `MultiSettingsFile=filename.mps` in dedicated.cfg. Tab-separated `LABEL\tVALUE` format. Parsed by `MultiLoadSettings()` in `multi_save_setting.cpp`.

| Key | Type | Effect |
|-----|------|--------|
| `NAME` | string | Server name (supports spaces) |
| `MISSION` | string | Mission file |
| `SCRIPT` | string | Game type script |
| `PPS` | int | Packets per second |
| `MAXPLAYERS` | int | Max players |
| `TIMELIMIT` | int | Time limit |
| `KILLGOAL` | int | Kill/score goal |
| `RESPAWNTIME` | int | Powerup respawn time |
| `DIFFICULTY` | int 0-4 | Difficulty level |
| `PEERPEER` | TRUE/FALSE | Peer-to-peer flag |
| `PERMISSABLE` | TRUE/FALSE | Permissable flag |
| `RANDOMIZERESPAWN` | TRUE/FALSE | Randomize respawn |
| `ROTVEL` | TRUE/FALSE | Send rotation velocity |
| `USESMOOTHING` | TRUE/FALSE | Position smoothing |
| `BRIGHTPLAYERS` | TRUE/FALSE | Bright player ships |
| `ACCWEAP` | TRUE/FALSE | Accurate collisions |
| `MLOOK` | TRUE/FALSE | Allow mouselook |
| `OBJBAN` | string | Ban a powerup by name (same names as AllowPowerup/DisallowPowerup) |
| `SHIPBAN` | string | Ban a ship by full name (e.g. `Black Pyro`, `Phoenix`) |

**Ship banning example** (`myserver.mps`):
```
SHIPBAN	Black Pyro
SHIPBAN	Magnum-AHT
```

This is the **only way** to restrict ships in a dedicated server config. The available ships are: `Pyro-GL`, `Phoenix`, `Magnum-AHT`, `Black Pyro`.

---

## autoexec.dmfc

DMFC reads `<writable dir>/netgames/autoexec.dmfc` unless `-autoexec <path>` names another file (`ParseStartupScript` in
`netgames/dmfc/dmfcbase.cpp`). The writable dir is the engine's preference directory, logged at startup as
`Local dir:` (on Linux `~/.local/share/Outrage Entertainment/Descent 3`), not the game directory. The engine keeps at
most 99 characters of each command-line argument, so the `-autoexec` path must fit.

Pyrodeck keeps a profile's Startup Commands in `<gamePath>/autoexec.dmfc` and, when that file exists at launch,
passes it as `-autoexec <absolute path>`. Without the file it passes nothing and DMFC reads its default.

Contains `$command` lines — same syntax as runtime DMFC commands. Executed at DMFC initialization after the game DLL loads. Use this to set options that have no dedicated.cfg CVar:

```
$serverhudnames full
$killmsgfilter simple
$autosavelevel on
$autosavedisconnect on
```

Max line length: 254 characters. Lines can optionally omit the `$` prefix.

---

## Runtime Console Commands

These commands can be entered on the server's local console or via remote telnet. Commands prefixed with `$` are routed through DMFC (the game DLL framework).

Both local console and telnet use identical code paths — there is no privilege difference between them.

### Player Management

| Command | Description |
|---------|-------------|
| `$players` | List all players with their player numbers (pnum) |
| `$playerinfo [pnum]` | Show detailed info for a player (IP, port, ship, team) |
| `$scores` | Display scoreboard (points, kills, deaths, suicides, ping) |
| `$kick [pnum]` | Kick a player by player number |
| `$ban [pnum]` | Ban a player by player number |
| `$banlist` | List currently banned players with ban index |
| `$removeban [index]` | Remove a ban by index from `$banlist` |
| `$observer [on/off]` | Toggle observer mode |
| `$piggyback [pnum]` | Observe from a specific player's perspective |

### Team Management

| Command | Description |
|---------|-------------|
| `$team [team_name]` | Request to change your own team (client-side) |
| `$changeteam [pnum] [team_name]` | Force a player to a different team |
| `$balance` | Auto-balance teams by seniority |
| `$allowteamchange [on/off]` | Allow/prevent players from switching teams |
| `$autobalance [on/off]` | Enable/disable automatic team balancing |
| `$setteamname [teamnum] [teamname]` | Rename a team |

### Game Settings (Live)

| Command | Description |
|---------|-------------|
| `$settimelimit [minutes]` | Change level time limit |
| `$setgoallimit [points]` | Change kill/point goal |
| `$setmaxplayers [max]` | Change max players |
| `$setpps [pps]` | Change packets per second |
| `$setrespawntime [seconds]` | Change powerup respawn time |

### Server Control

| Command | Description |
|---------|-------------|
| `$endlevel` | End current level, advance to next |
| `$warp [level_number]` | Jump to a specific level in the mission |
| `$wait [on/off/seconds]` | Freeze players at level start (useful for waiting for joins) |
| `quit` | Shut down the server |
| `say [message]` | Broadcast a message to all players |

### Display & Stats

| Command | Description |
|---------|-------------|
| `$netgameinfo` | Display current game settings |
| `$hudnames [full/team/none]` | Set HUD name display level (client) |
| `$serverhudnames [full/team/none]` | Set maximum allowed HUD name level (server) |
| `$killmsgfilter [full/simple/none]` | Set kill message detail level |
| `$statmsgs [on/off]` | Toggle statistical HUD messages |
| `$savestats` | Save game statistics to file |
| `$autosavelevel [on/off]` | Auto-save stats at level end |
| `$autosavedisconnect [on/off]` | Auto-save stats on disconnect |
| `$help [command]` | Show help for a command, or list all commands |

### Access Control

| Command | Description |
|---------|-------------|
| `$rehash` | Reload `hosts.allow` and `hosts.deny` files |

### Remote Administration (DMFC)

D3 has a built-in remote admin system for in-game clients (separate from telnet):

| Command | Description |
|---------|-------------|
| `$remoteadmin [on/off]` | Enable/disable remote admin from in-game clients |
| `$remoteadminpass [password]` | Set/change the remote admin password |
| `$remoteadminlogout [login-id]` | List logged-in admins, or log one out |
| `$remote [command] [args]` | (Client-side) Send an admin command to the server |

### Hoard-Specific

| Command | Description |
|---------|-------------|
| `$mincount [1-12]` | Set minimum orbs needed to score |

---

## Matcen Fork — Multiplayer Bots

The Matcen fork adds multiplayer bot support to D3's dedicated server. Bots occupy real player slots and participate as full players in the game. All bot commands are handled at the **engine level** (in `dedicated_server.cpp`), not through DMFC — they always work from both local console and telnet.

### Detecting the Matcen Fork

Use `$servercaps` to probe whether the server is a Matcen fork:

```
$servercaps
```

**Output format:**
```
SERVERCAPS version=1 fork=Matcen fork_version=0.9.16 features=bots,roster,ships,difficulty
```

A vanilla D3 server will not recognize `$servercaps` and will produce no structured output. The presence of the `SERVERCAPS` line confirms the Matcen fork.

**Fields:**
- `version` — Protocol version (currently 1)
- `fork` — Fork name (`Matcen`)
- `fork_version` — Numeric `X.Y.Z` (the `-dev` suffix is never printed)
- `features` — Comma-separated feature flags: `bots`, `roster`, `ships`, `difficulty`; from 0.9.17 also `teams`, `squad_orders`, and `population` once its controls exist. Treat unknown flags as harmless.

The output formats below are owned by the fork's `matcen-docs/PYRODECK_CONTRACT.md`; Pyrodeck's spec §5.2 mirrors them.

### Bot Commands

| Command | Description |
|---------|-------------|
| `$addbot <name> [ship] [difficulty] [team]` | Add a bot; arguments are positional |
| `$removebot <index>` | Remove a specific bot by its bot index |
| `$removebots` | Remove all bots |
| `$botlist` | List all active bots with status |
| `$botstat [index\|all]` | Show detailed bot status (state, role, lean, speed, shields, target) |
| `$botdifficulty <index\|all> <level>` | Change difficulty for one or all bots |
| `$botmode` | Print the detected game mode and team count |
| `$botobj` | Print the objective state (flags, orbs, roles) |
| `$botmov [on\|off]` | Toggle bot movement debug logging |
| `$nav ...` | Navigation diagnostics (format unstable; do not parse) |
| `$bothelp` | Show bot command help |

### Bot Command Details

**`$addbot <name> [ship] [difficulty] [team]`**

Adds a bot to the game. Difficulty is read only after a ship, team only after a difficulty.

- **name** — One token, cut to 14 characters; the callsign becomes `<name>[BOT]` (no space)
- **ship** — Ship alias: `pyro`, `phoenix`, `magnum`, `blackpyro` (default: pyro)
- **difficulty** — `trainee`, `rookie`, `hotshot`, `ace`, `insane` (or 0-4); an unknown word becomes Hotshot
- **team** — `1`-`4` (1-based); anything else auto-balances; ignored in free-for-all games

```
$addbot Viper
$addbot Reaper phoenix ace
$addbot Shadow blackpyro 4 2
```

Output on success (team is 1-based; a free-for-all bot prints `team=1`):
```
Bot 'Viper[BOT]' added in slot 3 (ship=Pyro-GL, diff=Hotshot, team=1)
```

Output on failure:
```
Failed to add bot (server full or max bots reached)
```

**`$botlist`**

Lists all active bots with their index, slot, ship, difficulty, and alive/dead status.

```
  Bot 0: 'Viper[BOT]' slot=1 ship=Pyro-GL diff=Hotshot (alive)
  Bot 1: 'Reaper[BOT]' slot=2 ship=Black Pyro diff=Ace (dead)
```

- **Bot index** (0, 1, 2...) is used for `$removebot` and `$botdifficulty`
- **Slot** is the player slot number (same as pnum in `$players`)

**`$botstat [index|all]`**

Shows detailed real-time bot status. With no argument or `all`, shows all bots. Each bot prints a status line and, usually, an indented `nav:` diagnostics line whose format changes without notice.

```
  Bot 0 'Viper[BOT]' slot=1 state=COMBAT role=Freelance lean=balanced speed=32.5 shields=84 target=PlayerOne
      nav: ...
  Bot 1 'Reaper[BOT]' slot=2 state=EXPLORE role=Attack lean=attack speed=15.0 shields=100 target=(none)
```

**States:** `EXPLORE`, `HUNT`, `COMBAT`, `FLEE`, `EVADE`. **Roles:** `Freelance`, `Attack`, `Defend`, `Follow`, `Cover`. **Leans:** `balanced`, `attack`, `defend`, `runner`, `flex`.

**`$botdifficulty <index|all> <level>`**

Changes difficulty for a specific bot or all bots. When used with `all`, also sets the default difficulty for future bots. Replies use the `→` (U+2192) arrow: `Bot 0 'Viper[BOT]' → Ace`.

```
$botdifficulty 0 ace
$botdifficulty all insane
```

**`$botmode`**

```
Game mode: Team Anarchy (scriptname='team anarchy', teams=2)
```

Mode names: `Anarchy`, `Team Anarchy`, `Robo-Anarchy`, `Co-op`, `CTF`, `Hyper-Anarchy`, `Hoard`, `Entropy`, `Monsterball`, `Unknown`.

### Bot Roster File (BotConfig)

For dedicated servers, bots can be auto-spawned at level load using a roster file. Set the path in `dedicated.cfg`:

```
BotConfig=bots.cfg
```

The roster file uses the same `Key=Value` format as `dedicated.cfg`. Comments start with `;` or `#`.

**Roster file format:**

```
; Bot roster for dedicated server
BotCount=4
BotDifficulty=hotshot

; Per-bot configuration (1-indexed)
BotName1=Viper
BotShip1=pyro

BotName2=Reaper
BotShip2=phoenix
BotDifficulty2=ace

BotName3=Shadow
BotShip3=blackpyro

BotName4=Wraith
BotShip4=magnum
BotDifficulty4=insane
```

**Keys:**
- `BotCount=[num]` — Number of bots to spawn (required)
- `BotDifficulty=[level]` — Default difficulty for all bots
- `BotName[N]=[string]` — Name for bot N (1-indexed, falls back to `BotN` if missing)
- `BotShip[N]=[alias]` — Ship for bot N (`pyro`, `phoenix`, `magnum`, `blackpyro`)
- `BotDifficulty[N]=[level]` — Per-bot difficulty override
- `BotTeam[N]=[1-4]` — Per-bot team in team games (Matcen 0.8.6+)

### Available Ships

| Alias | Full Name |
|-------|-----------|
| `pyro` | Pyro-GL |
| `phoenix` | Phoenix |
| `magnum` | Magnum-AHT |
| `blackpyro` | Black Pyro |

### Difficulty Levels

| Level | Name | Value |
|-------|------|-------|
| 0 | Trainee | Easiest |
| 1 | Rookie | |
| 2 | Hotshot | Default |
| 3 | Ace | |
| 4 | Insane | Hardest |

---

## Output Formats

### Scores Output

The `$scores` command returns a formatted table:

```
Pilot                Points K D S Ping
PlayerName:          5      6 1 1 45
*DisconnectedPlayer: 0      0 0 0 ---
```

- `*` prefix indicates observer/disconnected slot
- `[BOT]` suffix in name indicates a bot player (Matcen fork)
- Ping `---` means no network connection (bots, disconnected)
- Column layout varies by game type (anarchy shown above)
- Players are listed in slot order (pnum 1, 2, 3...)

### Players Output

The `$players` command returns:

```
PNum Name
00: -Server-
01: PlayerOne
02: Viper[BOT]
03: PlayerTwo
```

Player number 00 is always the dedicated server itself.

---

## Command Architecture

D3 has two layers of command handling on the dedicated server:

### Engine Layer

Bot commands (`$addbot`, `$removebot`, `$botlist`, `$botstat`, `$botdifficulty`, `$botmov`, `$servercaps`, `$bothelp`) are handled directly by the engine in `DedicatedHandleBotCommand()`. These always work identically from both local console and telnet.

### DMFC Layer

Game management commands (`$kick`, `$ban`, `$scores`, `$endlevel`, `$settimelimit`, etc.) are routed through the game DLL via `CallGameDLL(EVT_CLIENT_INPUT_STRING)` → DMFC's `InputCommandHandle()` → registered handler functions. These also work from both console and telnet — there is no privilege difference.

The `$remote` admin system is entirely separate — it allows in-game clients to send admin commands via encrypted game packets. Not related to telnet administration.

### CVar Permission Levels

Config file parameters are CVars with permission levels:
- **GAMEINIT** — Can only be set at server startup. Most dedicated.cfg settings are GAMEINIT.
- **GAMEPLAY** — Can be changed at runtime. AllowPowerup, DisallowPowerup, SetLevel, Quit, EndLevel, Say, ConsolePassword, StartRtLog, StopRtLog.
- Some CVars have **both**: e.g. `SetLevel` sets the start level at init, but warps to a level at runtime.

### Netgame Flags (multi_external.h)

The `Netgame.flags` bitmask controls network behavior. Set by CVars or internally:

| Flag | Hex | Set By |
|------|-----|--------|
| NF_TIMER | 0x01 | Timelimit > 0 |
| NF_KILLGOAL | 0x02 | Killgoal > 0 |
| NF_PEER_PEER | 0x10 | Peer2Peer=1 |
| NF_SENDROTVEL | 0x20 | SendRotVel=1 |
| NF_USE_ACC_WEAP | 0x400 | AccurateCollisions=1 |
| NF_USE_SMOOTHING | 0x800 | UseSmoothing=1 |
| NF_BRIGHT_PLAYERS | 0x1000 | BrightPlayers=1 |
| NF_PERMISSABLE | 0x2000 | Permissable=1 |
| NF_RANDOMIZE_RESPAWN | 0x8000 | RandomizeRespawn=1 |
| NF_ALLOW_MLOOK | 0x10000 | AllowMouselook=1 |
| NF_COOP | 0x40000 | Co-op script |

### Server Defaults (before config parsing)

| Parameter | Default Value |
|-----------|--------------|
| Scriptname | "Anarchy.d3m" |
| ConnectionName | "Direct TCP~IP" |
| MissionName | "fury.mn3" |
| GameName | "Generic D3 Game" |
| PPS | 10 |
| RespawnTime | 60 |
| Flags | NF_RANDOMIZE_RESPAWN (0x8000) |
| MaxPlayers | 8 |
| Difficulty | 2 (Hotshot) |
| MOTD | "" (empty) |

---

## Server Administration Tips

### PPS (Packets Per Second)

Modern recommendation: **PPS=30**. The old default of PPS=8 was designed for dial-up connections and results in poor gameplay on modern networks. At PPS=30, expect roughly 150-200 kbps upload per connected player on a broadband connection.

### Crash Prevention

Always use `-nomultibmp` to prevent crashes from corrupted custom ship logos. This is especially important for public servers.

### Multiple Instances

To run multiple D3 servers on one machine:
- Use different `-useport` values for each
- Use different `-gamespyport` values
- Use `-tempdir` to give each instance its own temp directory
- Use different `RemoteConsolePort` values in each config

### Access Control

D3 supports `hosts.allow` and `hosts.deny` files (located in `<D3_dir>/netgames/`) for IP-based access control. Use `$rehash` to reload these files without restarting the server.

### Server Timeout

Command-line flag `-timeout <minutes>` sets `ServerTimeout` — auto-quit after N minutes with no network packets received. Checked in `DoDedicatedServerFrame()`.

---

## Example Configurations

### Basic Anarchy Server

```
GameName=My Anarchy Server
MissionName=fury.mn3
ScriptName=Anarchy
MaxPlayers=8
PPS=30
Timelimit=20
Killgoal=25
RespawnTime=30
SetDifficulty=2
AllowRemoteConsole=1
RemoteConsolePort=2092
ConsolePassword=mypassword
MOTD=Welcome to my server!
```

### CTF Server

```
GameName=My CTF Server
MissionName=bedlam.mn3
ScriptName=CTF
ConnectionName=Direct TCP~IP
MaxPlayers=12
NumTeams=2
PPS=30
Timelimit=0
Killgoal=0
RespawnTime=20
SetDifficulty=1
AllowRemoteConsole=1
RemoteConsolePort=2093
ConsolePassword=mypassword
```

### Anarchy Server with Bots (Matcen Fork)

```
GameName=Bot Arena
MissionName=fury.mn3
ScriptName=Anarchy
MaxPlayers=8
PPS=30
Timelimit=20
Killgoal=25
RespawnTime=30
SetDifficulty=2
AllowRemoteConsole=1
RemoteConsolePort=2092
ConsolePassword=mypassword
BotConfig=bots.cfg
```

### Low-Bandwidth Server

```
GameName=Low Bandwidth Server
MissionName=fury.mn3
ScriptName=Anarchy
MaxPlayers=4
PPS=15
Timelimit=15
RespawnTime=45
DisallowPowerup=Proxminepowerup
DisallowPowerup=Betty4Pack
```

---

## Sources

- descentforum.net/serverops/d3dedi.htm (Midnight Squadron server ops guide)
- D3 engine source (dedicated_server.cpp, DMFC framework)
- Matcen fork source analysis (bot.cpp, dmfcinputcommand.cpp, dmfcbase.cpp)
- Matcen fork testing (v0.8.16)
