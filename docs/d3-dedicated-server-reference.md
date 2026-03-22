# Descent 3 Dedicated Server Reference

Comprehensive reference for running and managing Descent 3 dedicated servers. Compiled from community documentation (descentforum.net/serverops) and engine source analysis.

---

## Command-Line Switches

### Dedicated Server Options

| Switch | Description |
|--------|-------------|
| `-dedicated [config.cfg]` | Start as dedicated server using the specified config file |
| `-useip [IP]` | Bind to a specific IP address |
| `-useport [port]` | Set TCP/IP and IPX port (default 2092) |
| `-gamespyport [port]` | Set GameSpy query port (default 20142) |
| `-nomultibmp` | Disable sending/receiving custom ship bitmaps (prevents crashes from corrupted logos) |
| `-quitongoal` | Shut down server after goal is reached |
| `-setdir [path]` | Set working directory |
| `-tempdir [path]` | Set temp directory (required for running multiple instances) |
| `-useexedir` | Use executable directory as working directory |
| `-autoexec [file]` | Load a multiplayer config file (.dmfc) on startup |
| `-mission [name]` | Load specified mission at startup |
| `-nointro` | Skip intro movie |
| `-nooutragelogo` | Disable Outrage logo |
| `-pilot [name]` | Skip pilot selection dialog |
| `-framecap [fps]` | Limit framerate (default 50; use 999 to remove cap) |
| `-playermessages` | Disable weapon-related HUD messages in multiplayer |

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

### Core Settings

| Parameter | Description | Default |
|-----------|-------------|---------|
| `GameName=[string]` | Server name shown in server browser | |
| `MissionName=[string]` | Mission file to load (.mn3) | |
| `ScriptName=[string]` | Game type DLL name | Anarchy |
| `MaxPlayers=[num]` | Player limit (includes server slot 0) | |
| `NumTeams=[num]` | Number of teams for team game types | 2 |
| `Timelimit=[num]` | Level duration in minutes (0 = no limit) | |
| `Killgoal=[num]` | Kills/points to end level (0 = no limit) | |
| `RespawnTime=[num]` | Powerup respawn time in seconds | |
| `PPS=[num]` | Packets per second sent to each client (30 recommended) | |
| `SetDifficulty=[0-4]` | Difficulty: 0=Trainee, 1=Rookie, 2=Hotshot, 3=Ace, 4=Insane | |
| `SetLevel=[num]` | Starting level number in the mission | |
| `MOTD=[string]` | Message of the day shown to joining players | |

### Game Types (ScriptName values)

- `Anarchy` — Free-for-all deathmatch
- `Team Anarchy` — Team-based deathmatch
- `CTF` — Capture the Flag
- `Monsterball` — Push the ball into the goal
- `Entropy` — Capture and hold rooms
- `Hoard` — Collect orbs and score at goal
- `Hyper-Anarchy` — Anarchy with bonus modifiers
- `Robo-Anarchy` — Anarchy with AI-controlled robot ships

### Network Settings

| Parameter | Description | Default |
|-----------|-------------|---------|
| `ConnectionName=[string]` | Connection type: `Direct TCP~IP`, `Parallax Online`, etc. | |
| `UsePort=[num]` | Network port | 2092 |
| `UseIP=[address]` | Bind to specific IP | |
| `Peer2Peer=[0/1]` | Use peer-to-peer networking | 0 |
| `Permissable=[0/1]` | Use permissible client-server architecture | 0 |
| `SendRotVel=[0/1]` | Send rotation velocity for smooth interpolation | |
| `UseSmoothing=[0/1]` | Enable position smoothing | |
| `Gamespyport=[port]` | GameSpy query port (for multiple servers on one machine) | 20142 |
| `NoMultiBmp=[0/1]` | Disable custom ship bitmaps | 0 |
| `PlayerMessages=[0/1]` | Enable weapon HUD messages | |

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

| Parameter | Description |
|-----------|-------------|
| `AccurateCollisions=[0/1]` | Enable polygon-accurate collision detection |
| `BrightPlayers=[0/1]` | Brighten all player ships for visibility |
| `RandomizeRespawn=[0/1]` | Randomize powerup respawn locations |
| `AllowMouselook=[0/1]` | Allow mouselook in multiplayer |
| `AudioTauntDelay=[seconds]` | Minimum seconds between audio taunts |
| `MultiSettingsFile=[string]` | Load additional multiplayer settings (.mps file) |

### Powerup Control

Use `AllowPowerup` and `DisallowPowerup` to control which items spawn:

```
AllowPowerup=SuperLaser
DisallowPowerup=Proxminepowerup
DisallowPowerup=Betty4Pack
```

Multiple entries can be used. Bandwidth-intensive powerups to consider disabling for low-bandwidth servers:
- `Proxminepowerup` — Proximity Mines
- `Betty4Pack` — Bouncing Betties
- Black Sharks
- Seeker Mines

### Runtime Logging

| Parameter | Description |
|-----------|-------------|
| `StartRtLog` | Start real-time logging at server startup |
| `StopRtLog` | Stop real-time logging |

These are fire-once CVars (no value) — presence in the config triggers the action.

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
SERVERCAPS version=1 fork=Matcen fork_version=0.8.3 features=bots,roster,ships,difficulty
```

A vanilla D3 server will not recognize `$servercaps` and will produce no structured output. The presence of the `SERVERCAPS` line confirms the Matcen fork.

**Fields:**
- `version` — Protocol version (currently 1)
- `fork` — Fork name (`Matcen`)
- `fork_version` — Semantic version (e.g., `0.8.3`)
- `features` — Comma-separated feature flags: `bots`, `roster`, `ships`, `difficulty`

### Bot Commands

| Command | Description |
|---------|-------------|
| `$addbot <name> [ship] [difficulty]` | Add a bot with optional ship and difficulty |
| `$removebot <index>` | Remove a specific bot by its bot index |
| `$removebots` | Remove all bots |
| `$botlist` | List all active bots with status |
| `$botstat [index\|all]` | Show detailed bot status (state, speed, target, shields) |
| `$botdifficulty <index\|all> <level>` | Change difficulty for one or all bots |
| `$botmov [on\|off]` | Toggle bot movement debug logging |
| `$bothelp` | Show bot command help |

### Bot Command Details

**`$addbot <name> [ship] [difficulty]`**

Adds a bot to the game. All parameters after name are optional.

- **name** — Bot callsign (will be prefixed with `[BOT]` in player lists)
- **ship** — Ship alias: `pyro`, `phoenix`, `magnum`, `blackpyro` (default: pyro)
- **difficulty** — `trainee`, `rookie`, `hotshot`, `ace`, `insane` (or 0-4)

```
$addbot Viper
$addbot Reaper phoenix ace
$addbot Shadow blackpyro 4
```

Output on success:
```
Bot 'Viper' added in slot 3 (ship=Pyro-GL, diff=Hotshot)
```

Output on failure:
```
Failed to add bot (server full or max bots reached)
```

**`$botlist`**

Lists all active bots with their index, slot, ship, difficulty, and alive/dead status.

```
  Bot 0: 'Viper' slot=1 ship=Pyro-GL diff=Hotshot (alive)
  Bot 1: 'Reaper' slot=2 ship=Phoenix diff=Ace (dead)
```

- **Bot index** (0, 1, 2...) is used for `$removebot` and `$botdifficulty`
- **Slot** is the player slot number (same as pnum in `$players`)

**`$botstat [index|all]`**

Shows detailed real-time bot status. With no argument or `all`, shows all bots.

```
  Bot 0 'Viper' slot=1 state=COMBAT speed=32.5 vel=(12.3,-8.1,4.2) shields=84 target=PlayerOne
  Bot 1 'Reaper' slot=2 state=EXPLORE speed=15.0 vel=(5.0,0.0,10.0) shields=100 target=(none)
```

**States:** `EXPLORE`, `HUNT`, `COMBAT`, `FLEE`, `EVADE`

**`$botdifficulty <index|all> <level>`**

Changes difficulty for a specific bot or all bots. When used with `all`, also sets the default difficulty for future bots.

```
$botdifficulty 0 ace
$botdifficulty all insane
```

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
- `[BOT]` prefix in name indicates a bot player (Matcen fork)
- Ping `---` means no network connection (bots, disconnected)
- Column layout varies by game type (anarchy shown above)
- Players are listed in slot order (pnum 1, 2, 3...)

### Players Output

The `$players` command returns:

```
PNum Name
00: -Server-
01: PlayerOne
02: [BOT] Viper
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
- **GAMEINIT** — Can only be set at server startup (e.g., `NumTeams`, `RandomizeRespawn`, `AllowMouselook`, `BotConfig`)
- **GAMEPLAY** — Can be changed at runtime via `$set` commands (e.g., `PPS`, `SetLevel`, `PXOHostingLobby`)

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

D3 supports `hosts.allow` and `hosts.deny` files for IP-based access control. Use `$rehash` to reload these files without restarting the server.

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
- Matcen fork testing (v0.8.3)
