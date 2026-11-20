# D3Server3 feature audit

Audited 2026-10-07 against D3 Pyrodeck 0.4.20 (`b4eaccf`). Section 6 extends the audit to the last release, 3.2.3.0, from
the archived manual and release notes; its Pyrodeck column is read against the 0.4.21 development tree.

**The Pyrodeck columns record that moment.** Pyrodeck has built many of the features marked missing since then: the
changelog entries for 0.5.0 (supervisor, re-attach, bans, player history, join rules, schedule and more), 0.6.0 (several
servers at once) and 0.6.1 (tracker listing) list them, and [features.md](features.md) is the current list. A row here
is brought up to date only where a later section depends on it.

D3Server3 is the community's old Windows server manager for Descent 3. This document lists what it does, how it drives
the dedicated server, and which of its features Pyrodeck 0.4.20 has. It is an inventory of features and behaviour.
D3Server3's licence is unknown and Pyrodeck is written from scratch, so no D3Server3 code is reproduced here, and none
should be. The evidence column cites UI strings, the engine commands and flags the tool sends (the engine's public
interface), and function addresses in the decompiled binary.

## 1. What D3Server3 is

| Item | Value |
|---|---|
| File | `D3Server3.exe`, 658 KB, PE32 GUI, i386 |
| Version | 3.0.83.0 (version resource and the internal constant `0x30053` the update check compares against) |
| Build date | PE timestamp 2010-07-29 12:01:34 |
| Authors | "Copyright (C) 2000 - 2009, Martin Baedeker" (M. "(DE)Hunter" Baedeker); About box adds "Portions (C) 2009/2010 Thomas". Credits Kevin "Kevlar" Bentley for network help |
| Toolchain | MSVC .NET 2003 (linker 7.10), MFC 7.x statically linked, native Win32 (not .NET). Imports kernel32, user32, gdi32, comdlg32, winspool, advapi32 (registry only), shell32 (tray icon, file ops), comctl32, shlwapi, oleaut32, ws2_32, wininet |
| Companion | `logtext.dll` 1.6.32, built 2010-05-06, "Copyright (C) 2010, Thomas Belmer" (logtext.de). A generic logging library, not D3-specific: zlib 1.1.4, daily/weekly/monthly/yearly file names, keep-N logs and keep-N archives, NTFS compression, line/size shrinking, a queued asynchronous variant. Loaded at run time with `LoadLibrary` (`0x41f290`); `logtext.ini` sets `WEEKLY`, `MaxLogs=5`, `MaxZips=30`, `NTFS_COMPRESSION` |
| Embedded helper | `WaitMutCopy.exe` 1.2 ("Copyright (C) 2010, Thomas"): waits for a mutex, copies files, starts the last one. Extracted at update time to swap in a new `D3Server3.exe`. Its banner says it is freeware with source at dateiliste.com; that covers the helper only. The binary carries no licence text for D3Server3 itself |
| Help | One online page per dialog under `dateiliste.com/descent-3/58-descent-3-dedicated-server-tool-for-windws/` |

Screenshots of a D3Server3 v3.2 exist. The binary audited here is 3.0.83, so a later release may have features this
one lacks.

### How it drives the server

- **Launch.** Per server, the tool writes every file the server needs from its own stored configuration (`0x404070`):
  the main config (`0x410850`), a ship-ban file (`0x418640`), a DMFC autoexec file (`0x409980`), a `gamespy.cfg`
  (`0x411b10`), and, when the level-loop option is on, a rewritten `.msn` next to the mission (`0x4164b0`). It then
  builds a command line (`0x40be70`) from `-dedicated`, `-autoexec`, `-setdir`, `-tempdir`, `-useport`, `-pxoport`,
  `-gamespyport`, `-gspyfile`, `-useip`, `-framecap`, `-nomultibmp` and `-nocrashbox`, and starts the server with
  `CreateProcessA` in a console window of its own, minimized if the global option says so (`0x43d560`). Each server
  gets its own temp directory, and a stale `.lock` file in it is deleted before launch.
- **No stdin, no stdout.** The tool opens no pipe to the server. Everything it learns comes over the remote console.
- **Remote console.** One thread per server (`0x448690`) connects to the server's console port, waits for the prompt,
  sends the password, appends to the per-server log, sends `$players`, then reads in 200 ms polls and hands batches
  (cut at 1 s of quiet or 96 KB) to a line parser (`0x447a60`). It reconnects after 5 s if the link drops. On
  disconnect it sends `logout`. On stop it sends `quit` (`0x446b50`, `0x446c10`), waits, and calls `TerminateProcess`
  if the server is still alive (`0x43d620`).
- **Supervision.** A 15 s timer (`SetTimer` in `0x406630`, handler `0x406fa0`) checks every server: process alive,
  console silence, players, the schedule, the uptime limit, auto-command intervals. Section 2 lists what it does with
  each.
- **Re-attach.** Running servers' process IDs are saved in `ServerInfo.dat` and reopened with `OpenProcess` when the tool
  starts again (`0x43d760`), so closing or restarting D3Server3 does not stop the servers.
- **State files.** `ServerInfo.dat` (server configurations), `PlayerInfo.dat`/`.txt` (name and IP history),
  `TrackerInfo.dat`/`.txt`, `DescentInfo.dat` (scanned executables, missions, network and online modules). The D3
  directory comes from the registry key `SOFTWARE\Outrage\Descent3`.

### Engine cross-check

Checked against the open-source tree (`Descent3/init.cpp`, `gamespy.cpp`, `dedicated_server.cpp`,
`netgames/dmfc/dmfcbase.cpp`):

- The engine still reads `-autoexec` (DMFC, default `<D3 dir>/netgames/autoexec.dmfc`), `-gspyfile`, `-gamespyport`,
  `-useport`, `-pxoport`, `-tempdir`, `-useip`, `-framecap` (default 60 fps) and `-nomultibmp`.
- `-setdir` and `-nocrashbox` are not in the open-source engine, and neither are the config keys `SetTeamDamage`,
  `RemoteAdmin`, `RemoteAdminPass`, `AllowAudioTaunts` and `GameSpyPort` that D3Server3 writes. The tool also
  launches "Pyro" executables (`pyro*.exe`, "Pyro15" in a tooltip), which probably read them. That is inferred, not
  checked.
- Every console command D3Server3 sends exists in DMFC: `$players`, `$playerinfo`, `$kick`, `$ban`, `$rehash`,
  `$setrespawntime`, `$setmaxplayers`, and the autoexec verbs (`allowteamchange`, `autobalance`, `autosavelevel`,
  `autosavedisconnect`, `serverhudnames`, `killmsgfilter`, `setteamname`, Hoard's `mincount`/`maxcount`).
- `$ban` adds to an in-memory DMFC list (`DMFCBase::BanPlayerFromGame`) freed when the game DLL unloads. Bans that
  survive a restart need `netgames/hosts.deny` (IPs and ranges) and `$rehash`.
- Two lines the parser waits for, `*Entering` (its level-start hook) and `connection activity, "ip:port"` (its IP
  capture on join), do not appear in the open-source tree. They may come from the retail 1.4/1.5 executable or a Pyro
  build. Against the current engine those hooks may never fire.

## 2. Feature inventory

Pyrodeck column: **built**, **partial**, **missing**, or **n/a** (obsolete, or no meaning for a headless web tool).
Paths are under `packages/`.

### Process and supervision

| Feature | Evidence | Pyrodeck 0.4.20 |
|---|---|---|
| Launch a dedicated server from a stored configuration | `0x404070`, `0x43d560` | built: `server/src/launcher/ProcessManager.ts`, `POST /api/launcher/start` |
| Server in its own console window, optionally minimized | `CREATE_NEW_CONSOLE`; "Start servers minimized" | n/a: headless; stdout goes to the Server Console tab |
| Graceful stop: `quit`, wait, then kill | `0x446c10`, `0x43d620` | built: `ProcessManager.stop()` (`quit`, SIGTERM, SIGKILL) |
| Relaunch when the process dies | `0x406fa0` "Not running anymore -> Restart." (no option gates it; skipped for the first minute after the tool starts) | partial: shown as `crashed`; relaunched only during a playlist restart (`server/src/launcher/RotationHealthMonitor.ts`, one retry) |
| Hang watchdog: `$players` after 59 s of console silence; kill and relaunch after 120 s, players or not | `0x406fa0`, `0x447360`, `0x446d00` | missing (Pyrodeck checks that the log file is still being written, not that the server answers) |
| "Network data corruption detected." marks the server crashed; relaunch once it is empty | `0x447a60`, `0x406fa0` | missing |
| Restart after an uptime limit, only with no players and at least 130 s after the last one left | Global options ("Auto restart time"), tooltip; `0x406fa0` | missing |
| A server quit from the console ("Shutting down" with no local stop) is not relaunched | `0x447a60`, `0x406fa0` "has been quit by admin" | n/a until Pyrodeck relaunches on its own |
| Weekly schedule: start and stop windows by day and time | Scheduler dialog; `0x406fa0` "Scheduled start." / "Scheduled stop." | missing |
| Start servers when the tool starts; servers running at last exit always come back | Global options; tooltip "Servers that had been running when D3Server3 was closed..." | missing |
| Re-attach to running servers after the tool restarts | `0x43d760` (saved PIDs, `OpenProcess`) | missing |

### Several servers

| Feature | Evidence | Pyrodeck 0.4.20 |
|---|---|---|
| Many configurations: add, import, edit, copy, remove | "Server Configurations Selector" dialog | built: profiles (`server/src/routes/config.ts`, `/api/profiles`, `/duplicate`, import) |
| Several servers running at once, one list with status, mission, game type, max players, schedule | main window list; `0x406fa0` loops over all | missing: one running server (README, Known Limitations) |
| Port plan: base ports, "Next free port", conflict check across game UDP, console TCP and GameSpy UDP | "Select port" dialog; "%s port %u is already in use!" | missing (Pyrodeck waits for the console port to free before a relaunch: `ProcessManager.waitForPortFree`) |
| Per-server temp directory (`-tempdir`) with a `.lock` cleanup | `0x404070` | missing (one instance does not need it) |
| Stop all, stop all empty, stop empty and exit | main window buttons | n/a with one server |
| "Selective" servers: when one has players, the empty ones stop | config option and tooltip; `0x406fa0` | missing |
| Player cap across all servers | Global options; its tooltip says "Note: This function is not implemented yet." | missing (never finished in D3Server3 either) |

### Configuration

| Feature | Evidence | Pyrodeck 0.4.20 |
|---|---|---|
| Import from a launch batch file, or from separate main, multisettings, autoexec and GameSpy files; warns about unsupported keys | Import dialog; "The following commands in %s are not supported" | partial: imports an existing `.cfg` as a profile |
| Choice of executable per server (Descent 3, Pyro builds) | "D3 Executable"; `main.exe`, `pyro*.exe` | built: per-profile `executablePath` |
| Find the D3 install | registry `SOFTWARE\Outrage\Descent3\BaseDirectory` | partial: the operator enters the path; Pyrodeck validates it (`POST /api/pyrodeck/validate-path`) and lists its HOGs (`GET /api/launcher/detect`) |
| Mission and level from scanned `.mn3`/`.msn` | `.msn` reader `0x416ff0`; "No mission files (*.mn3) found!" | built: `server/src/gamefiles/Mn3Scanner.ts`, with game-mode compatibility (D3Server3 has none) |
| Loop one level of a multi-level mission (rewrites the mission's `.msn`) | "Loop: on/off" and its tooltip; `0x4164b0` | missing (playlists rotate missions; nothing repeats one level) |
| Name, game type, max players, teams, difficulty, time limit, kill goal, MOTD, PPS, network model, bright ships, mouselook, accurate collisions, rotational velocity, random respawn | Server Configuration dialog; config writer keys | built: `client/src/components/ServerConfigForm.tsx`, `server/src/launcher/ConfigGenerator.ts` |
| Frame cap (`-framecap`) | "Frames / second (0..999)" | missing (engine default 60) |
| Game UDP port (`-useport`) and bind address (`-useip`) | "Server port (UDP)", "Alternate server IP" | missing |
| Disable pilot logos (`-nomultibmp`) | "Disable logos" | missing |
| Ship bans | Ship options dialog; `ShipBan` | built: `.mps` via the config form |
| Powerup allow/disallow | Powerup options dialog | built |
| Hoard orbs to score (`MinCount`/`MaxCount`) | autoexec writer `0x409980`; "Orbs to score" | missing |
| Team options: allow team change, auto balance, four team names | Team Options dialog; `0x409980` | partial: console commands in `client/src/components/CommandReference.tsx`, not stored in the profile |
| HUD names, kill message filter, save stats at level end and on disconnect | Server Configuration dialog; written to the autoexec file | built: post-start settings sent over the console (`server/src/launcher/postStartSettings.ts`) |
| DMFC settings applied at launch through a per-server `-autoexec` file | `0x409980`; ` -autoexec "%s"` | partial: a "Startup Commands" `autoexec.dmfc` companion exists, but see section 3 |
| Powerup respawn time scaled by player count: max at two players or fewer, falling toward the min as players join, sent as `$setrespawntime` | min/max respawn tooltips; `0x418790`, `0x4475a0` | missing |
| Audio taunt delay | `AudioTauntDelay` | built (`AllowAudioTaunts` is not an engine key) |
| Team damage, in-game remote admin password as config keys | `SetTeamDamage`, `RemoteAdmin`, `RemoteAdminPass` | n/a: not read by the open-source engine |
| Extract a mission's `.oof` models before launch, remove them at stop | `0x41d950`; "Server %u: %d custom objects extracted." | n/a (purpose not resolved, no known need) |

### Console and logging

| Feature | Evidence | Pyrodeck 0.4.20 |
|---|---|---|
| Remote console session and live output | `0x448690` | built: `server/src/connection/TelnetConnection.ts`, `client/src/components/Console.tsx` |
| Per-server console log, optional per-line timestamps, "log all output" or echoes filtered out | Console and Logging dialog; `0x446d40` | partial: one stdout log per launch (`server/src/launcher/logPaths.ts`, `client/src/components/LogsPanel.tsx`), no per-line timestamps |
| Log rotation, compression and retention (logtext.dll) | `logtext.ini`; `logtext.dll` | partial: logs can be deleted by hand; no retention rule |
| Event log of tool actions (launched, stopped, crashed, kicked, banned, updated) with copy to clipboard | main window "Event log" | partial: toasts and the Launch panel status; no kept history |
| Auto commands: a list run when the console connects and at each level start, then every N minutes; all, one at a time, or one at random | Console and Logging dialog and tooltips; `0x447170`, `0x406fa0` | missing |

### Players and access control

| Feature | Evidence | Pyrodeck 0.4.20 |
|---|---|---|
| Player roster | parses the `$players` table | built: `client/src/components/PlayerList.tsx` from `$scores` every 5 s, with scores and ping (D3Server3 shows player counts and join and leave events, no scoreboard) |
| Kick and ban | `0x4477f0` (`$kick`), `0x447990` (`$ban`) | built: `PlayerList.tsx` (DMFC's temporary ban) |
| `say` the reason before kicking, then wait up to 2 s | `0x447710`, `0x4477f0` | missing |
| Join and leave log, with the player's IP | `0x446ef0`, `0x447070`, `0x447a60` | missing |
| Name and IP history, exported to `PlayerInfo.txt` | `0x420360`; "%04u-%02u-%02u %s - %s" | missing |
| Optional `$playerinfo` per new player to read the IP; only below six players, and the tooltip warns it "could cause server crashes on servers with more than 10 players" | `0x4474f0`; Console and Logging tooltip | missing |
| Disallowed-nickname list (case-insensitive, trailing `*` wildcard) that bans on join | anti-cheat dialog; `0x447a60` | missing |
| Kick names that are empty or contain `%` ("INVALID NICKNAME"), contain non-printable characters ("HACKED NICKNAME"), or are N characters or shorter | anti-cheat dialog; `0x447a60` | missing |
| Kick a player who toggles observer mode more than three times, each under a second apart | `0x447a60` "kicked (observer on/off switch)" | missing |
| Blocked IPs and ranges in `netgames\hosts.deny`; `$rehash` sent at every level start | anti-cheat dialog; `0x447400` | missing; `$rehash` only as a typed command |
| Community ban lists downloaded every 12 h (`hostdeny.txt`, `aliasdeny.txt` from descentforum.net), merged or replacing earlier entries | `0x412cb0`, `0x412a60` | missing (section 4 explains why not to copy it as built) |
| Change max players live | `$setmaxplayers` (`0x447660`; D3Server3 sends it only from the cross-server cap code) | built: Server sidebar stepper |

### Discovery and trackers

| Feature | Evidence | Pyrodeck 0.4.20 |
|---|---|---|
| GameSpy-protocol tracker list and region code (`gamespy.cfg`, `-gamespyport`, `-gspyfile`); defaults `tracker.descent.cx:27900`, `tracker.kali.net:22999`, `master0.gamespy.com:27900` | Game Tracker dialog; region list | built (0.6.1): Launch panel → Edit → Tracker Listing writes a region and up to five trackers to the profile's `-gspyfile` as region/tracker pairs (`server/src/launcher/trackerList.ts`); no default list |
| PlanetDescent listing over HTTP (launch, update with player count, shutdown) | `0x41a8f0`; its own tooltip: "Planetdescent.com is down" | n/a |
| PXO login, PXO status panel, switch servers to Direct TCP/IP when PXO is down | Global options; main window status box; `chat.pxo.net` | n/a: PXO is gone |
| Copy a `d3://ip:port` link | server list context menu | missing (minor) |
| "Remote info server": binary UDP protocol with a numeric password for the D3Client tool: list servers; list, set and delete entries in a key/value table kept in `TrackerInfo.dat` | `0x43f020` | n/a: Pyrodeck's authenticated HTTP API and WebSocket cover remote access |

### The tool itself

| Feature | Evidence | Pyrodeck 0.4.20 |
|---|---|---|
| Update check every 12 h when no server has players, by reading a release-notes HTML page; optional download and self-replace | `0x44c1b0`; `WaitMutCopy` | missing (section 4) |
| Restarts itself about every 3.3 h when no server has players (12,000 passes of a one-second updater loop) | `0x44c1b0` "D3Server3: Uptime exceeded." | n/a |
| Single instance, tray icon | mutex `Global\D3Server3`; `Shell_NotifyIconA` | n/a |
| Access control on the manager | none (local GUI) | Pyrodeck has its own (password, sessions, rate limit) |

Features named in Pyrodeck's spec (section 1.3) as D3Server3's that this build does not have: a profanity filter with
warn, kick, ban escalation and email alerts, a Windows service mode, and process priority control. No string mentions
them, and the imports rule them out (no service-control or priority-class APIs, and `advapi32` serves the registry
only). Email appears only as the PlanetDescent listing field.

## 3. What Pyrodeck lacks, ranked

Ranked by what an operator running a server in 2026 would want, mostly someone hosting one unattended server on a
VPS or home box.

1. **Relaunch after a crash or a hang, outside playlist rotation.** Relaunch when the process exits on its own.
   Kill and relaunch when the console stops answering (probe after about 60 s of silence, give up at about 120 s).
   Leave alone a server an admin quit. A crashed server stays down today until someone looks, and the
   relaunch-and-verify path already exists in `RotationHealthMonitor.ts`.
2. **Bans that survive a restart.** A `hosts.deny` editor (IPs and ranges) that sends `$rehash`, and a stored
   name-ban list applied on join. The Ban button is DMFC's in-memory ban, so every restart, including every playlist
   rotation, unbans everyone.
3. **Restart when empty after an uptime limit,** with a grace period after the last player leaves. Cheap upkeep for
   servers that run for weeks, using the same restart path as item 1.
4. **Join and leave history with IPs, and a name-to-IP index.** Banning the right address when a griefer changes
   names depends on it, and so does "who was on last night". Getting the IP needs `$playerinfo`, which D3Server3
   rationed because of crash reports. Check the engine path before polling it.
5. **Several servers at once,** with per-instance game, console and GameSpy ports, `-tempdir`, and a port-conflict
   check. The largest structural gap (README, Known Limitations). Communities often run more than one
   game type side by side.
6. **Periodic console commands:** a list run at start and every N minutes, all, one at a time, or at random (rules,
   a link to the community's chat, tips). Small, and already planned.
7. **Bind address, game port, frame cap and logo switch in the profile** (`-useip`, `-useport`, `-framecap`,
   `-nomultibmp`). Hosts with several addresses need `-useip`, `-useport` is a precondition for item 5, and
   `-framecap` sets the server's tick rate.
8. **Game tracker registration** (`gamespy.cfg` with region and tracker list, `-gamespyport`, `-gspyfile`). The engine's
   only built-in way to advertise a Direct TCP/IP game. Trackers that speak this protocol were still answering when the
   audit was made (section 6.5), which puts this level with items 4 and 5 for anyone who wants strangers to find the
   server. Built in 0.6.1: Launch panel → Edit → Tracker Listing.
9. **Nickname checks on join:** kick names that are empty, contain `%`, or contain non-printable characters, with an
   optional minimum length and a `say` reason first. Cheap and defensive. Whether a `%` name still harms the current
   engine was not tested. **Section 6 adds the 3.1+ siblings that belong in the same work:** the profanity monitor
   (page 580: word-list match on chat, per-player counter, KICK/BAN/EVENT at a threshold) and the trailing-`*` wildcard
   nickname list (page 428). Both were built in 0.5.0.
10. **Team settings and Hoard orb counts stored in the profile** (allow team change, auto balance, team names,
    `mincount`/`maxcount`) and applied at launch. Today they are console commands, lost on every restart.
11. **Powerup respawn scaled by player count** (`$setrespawntime` between a min and a max as the roster changes). A
    gameplay nicety for servers whose population swings.
12. **Weekly schedule windows** (start and stop by day and time). Good for event nights, of little value where an idle
    server costs nothing.
13. **Re-attach to a running server after Pyrodeck restarts.** Upgrading Pyrodeck should not drop players. This
    matters once Pyrodeck is the supervisor of record.
14. **Import from a launch batch file** (read `-dedicated`, `-autoexec`, `-gspyfile`, ports from a `.bat`). Helps
    operators moving old Windows servers over. One-time value.
15. **Update notice:** compare `/api/version` with the latest release and say so, never self-install. Low.
16. **Show and copy the join address** (`host:port`). Minor convenience.
17. **Repeat one level of a multi-level mission.** Playlists cover most rotation needs.
18. **Kick for observer-mode toggle spam.** A niche exploit.
19. **Selective servers and a cap across servers.** Resource rationing for 2000-era hardware, meaningful only after
    item 5, and D3Server3 never finished the cap.
20. **Operator-defined hooks on server events** (added by section 6). D3Server3 3.0.90.0 onward runs an external
    command on more than a dozen events and substitutes variables into it (page 528). The 3.1+ features that look like
    alerting (email on join, profanity escalation, stats upload) are built on that one mechanism (pages 579, 580, 595).
    Pyrodeck 0.4.21 has the internal typed bus (`server/src/events/ServerEvents.ts`) but no way for an operator to
    attach a command or webhook to it. Place it just below item 6: small once the bus exists, and it replaces several
    one-off features. Run the command without a shell and pass values as arguments or environment, not by text
    substitution (page 528 shows `%COMSPEC% /C`, and release 3.1.3.0 had to add `MakeCommandsBatchSafe` to strip
    unsafe characters from player names).

### Side finding: the Startup Commands file is probably never read

Found while checking the `-autoexec` row. Read from source, not tested live. Pyrodeck's "Startup Commands" companion
is `<gamePath>/autoexec.dmfc` (`server/src/routes/config.ts`, `/api/profiles/:id/companions`, and
`ServerProfile.readFile`/`writeFile`, which join a bare file name to `gamePath`). DMFC reads
`<D3 dir>/netgames/autoexec.dmfc` unless `-autoexec <path>` is on the command line (`ParseStartupScript` in
`netgames/dmfc/dmfcbase.cpp`), and Pyrodeck passes no `-autoexec` (`additionalArgs` in `ProcessManager.ts` is never
set). If that holds, commands saved there do nothing. Passing `-autoexec ./<file>` per profile would fix it, and would
also let the 0.4.20 post-start settings apply at launch, as D3Server3 does, instead of over the console afterwards.

The finding held. Since 0.5.0 each launch passes `-autoexec` with the profile's Startup Commands file, when the file
exists.

## 4. Ideas worth taking, and what to leave behind

### Worth taking (as ideas, rebuilt from scratch)

- **Supervise over the console, not only stdout.** D3Server3's crash, hang and empty-server logic runs entirely on
  the console link, so the same logic would work in Pyrodeck's Connect mode. Its keepalive is a cheap command only
  after a quiet minute. Pick the probe with care: `$netgameinfo` leaks the engine's text buffer on dedicated servers
  (Pyrodeck 0.4.11), so verify the probe command's output path first.
- **Restart only when empty, and wait after the last player leaves** (D3Server3 waits 130 s). Treat a hang
  differently: a server that has stopped answering is restarted even with players on it.
- **Respect a deliberate quit.** A server that printed "Shutting down" with no local stop request is left down.
- **Write the whole launch from one profile.** Every file the server reads, including a per-server DMFC autoexec, is
  generated at launch from the stored configuration, so the files on disk can't drift from what the UI shows.
- **Send `$rehash` at each level start** so `hosts.deny` edits take effect without a restart.
- **Say why before kicking** and give the message a moment to reach the player.
- **Check ports across every configured server and service** when a profile is saved, not at launch.
- **Keep the PIDs** so a manager restart re-attaches instead of orphaning servers.

### Leave behind

- **PXO and PlanetDescent:** the login fields, the PXO status panel, the switch to Direct TCP/IP on PXO downtime, and
  HTTP posting that put the operator's email address in a GET query string. Both services are gone, and the 2010 tool
  already says so.
- **The hardcoded 1999 tracker list** (`master0.gamespy.com` and others). If tracker support comes back, the operator
  supplies the list.
- **The self-update mechanism:** scraping a version number out of an HTML page over plain HTTP, downloading an
  executable from a URL found in that page, and running it with no signature check. Also the scheduled self-restart
  every few hours.
- **Bans from an unauthenticated remote list applied without review.** The tool's own dialog says "use carefully!"
  Callsigns are trivial to impersonate, so an automatic name ban punishes the impersonated player. A shared list, if
  wanted, should be fetched over HTTPS and reviewed before it takes effect.
- **IP capture by polling `$playerinfo` on servers with few players,** which D3Server3 itself warned could crash
  servers. Find an IP source that is known to be safe first.
- **Config keys and flags the engine does not read** (`SetTeamDamage`, `RemoteAdmin`, `RemoteAdminPass`,
  `AllowAudioTaunts`, `GameSpyPort`, `-setdir`, `-nocrashbox`).
- **A closed logging DLL with NTFS compression:** a retention rule (keep N logs or N days) does the job on any OS.
- **The binary UDP "remote info server" with a numeric password:** Pyrodeck's authenticated API replaces it.
- **Selective servers and the unfinished global cap:** resource rationing for hardware that no longer needs it.
- **The level-start and IP hooks on lines the current engine never prints** (`*Entering`, `connection activity`).
  Anything modelled on them has to be re-anchored on lines verified in the open-source tree.

## 5. Method and limits

- **Static strings.** `strings -n 6` (ASCII) and `strings -el` (UTF-16) on the executable and the DLL gave the dialog
  captions and controls, tooltips, config keys, command-line flags, console commands, log formats, URLs and the version
  resources. `pefile` was not available, so resources were read through `strings -el` only, and dialog control IDs were not
  mapped to the code that reads them.
- **Decompilation.** Ghidra 12.1.4 headless, 1.5 GB heap: auto-analysis, then a script that decompiled every function.
  Auto-analysis missed most MFC message-map handlers (the supervision timer among them), so a second pass created 188
  functions at code boundaries in the gaps and the timer handler by hand, and a raw scan for `call` instructions found
  callers Ghidra had not linked. Addresses cited are virtual addresses (image base `0x400000`).
- **No dynamic run.** The tool was not executed (no Wine, no live server), so every behaviour is read from code and
  strings, not observed.
- **From strings only:** the help-page structure, the Import dialog's batch-file parsing, the PXO status panel, the
  generated `.bat` launch file (whether the tool uses it to launch or only offers it for export is unresolved),
  the region list, and most dialog option names.
- **Inferred, not confirmed:** which checkbox maps to which configuration field (matched by tooltip text and use); that
  the extra config keys and `-setdir` serve the Pyro executables; the updater loop period (one second, from its wait
  call), hence the 3.3 h self-restart figure.
- **Unresolved:** what the `TrackerInfo.dat` key/value table is for (the info server can list, set and delete it); why
  `.oof` models are extracted from missions before launch; the exact effect of the global player cap code; where global
  options are stored (registry or `ServerInfo.dat`); and the source of `*Entering` and `connection activity`, which
  are absent from the open-source engine. A function that appends an IP to `hosts.deny` ("hosts.deny: auto added",
  `0x412420`) exists but nothing calls it: dead code in 3.0.83.
- **Pyrodeck column:** read from the 0.4.20 README, CHANGELOG, plan, spec and the server and client sources at
  `b4eaccf`. The Startup Commands finding in section 3 comes from reading source. It was not tested against a server.

## 6. The 3.2.3.0 line, from the archived manual

Sections 1 to 5 audit the 3.0.83.0 binary of 2010-07-29. The last release is **3.2.3.0, dated 2014-10-22** (release notes
page 422, "Latest D3Server3 version: 3.2.3.0", feed text "Features: CPU usage and tracker list"). This section reads the
author's archived manual and release notes for everything from 3.0.83 to 3.2.3.0.

**What was and was not available.** The 3.2.3.0 binary and `D3Server3_src.zip` were offered on the Dateiliste download page
(captures 2014 to 2021) but are not in the archive, and both dateiliste TLDs now serve a hosting placeholder. So 3.2.3.0
was not decompiled. Everything here comes from the manual and the release notes, as text the author wrote about his own
tool, and cites the Dateiliste article id. Release notes are page 422, read in full from one Wayback `?showall=1`
capture (2021-01-20). Page ids cited: 420, 421, 423, 424, 425, 426, 428, 429, 430, 431, 433, 434, 467, 482, 492, 516,
528, 575, 576, 579, 580, 585, 588, 589, 590, 592, 595, the blog post 597 and the article "Providing download links for
hosted missions" (id 20). Pages 427 (import), 582 (server control panel) and 598 ("Descent 3 profiles") are one-line
stubs ("this is going to be the online help for..."), so those features are known only from the release notes. Not
fetched: pages 2 to 5 of 516 (service install steps), page 2 of 423 (keeping the tracker list current) and page 2 of
467, and the articles "Vortex and Gamespy services" and "Hosting co-op servers". The manual is uneven: several
pages are 2009 drafts by a volunteer ("???" where the writer did not know), and the 2013+ pages by the author are
exact. Where a draft and the release notes disagree, the notes are used.

### 6.1 Version history

Dates are the release-note dates (page 422). The 3.0.7x betas and the 3.1 beta of October 2009 are folded into one row.

| Version | Date | Notable features added |
|---|---|---|
| 3.1 beta / 3.0.70.x to 3.0.76 | 2009-10-01 to 2010-01-23 | Selective servers (421). Defaults: PPS 9 to 12, FPS 0 to 999, Direct TCP/IP for new servers, "Auto restart servers" on. `logtext.dll` for the event log, per-server auto-launch flag, automatic update through `WaitMutCopy` (3.0.70.12). Empty-server restart wait 90 s to 130 s (3.0.73.4). `$playerinfo` sent only below six players, with an IP fallback parsed from the "connection" line above six (3.0.76.1 to .3) |
| 3.0.77 to 3.0.82 | 2010-02-13 to 2010-06-20 | 128 KB console buffer and 64-bit timers (3.0.77); automatic `.oof` extraction from missions (3.0.78, page 482); the tool restarts itself every 50 hours (3.0.79); team names capped at 12 characters "to avoid game crashes" (3.0.80); repeating and random auto commands (3.0.82) |
| 3.0.83.0 | 2010-07-29 | The audited binary. Game posting to PlanetDescent disabled, "Copy d3://ip:port (127.0.0.1)", `hosts.deny` created if missing |
| 3.0.84 to 3.0.92 | 2010-09-27 to 2011-02-18 | Runs as a Windows service through the external `ServiceExe` (3.0.84, packaged and reliable from 3.0.85, page 516); renamed D3Server3 (3.0.86); random level choice and selective-server delay 90 s (3.0.89); **server events** (3.0.90, page 528); base directory kept in `D3Server3.ini` instead of the registry, several instances side by side, update by downloading and running an installer (3.0.91) |
| 3.1.0.0 | 2012-04-07 | Process IDs shown in logs; "Show server window(s)" in the popup menu; RestWinIcons support; update request timeout 2 s to 30 s |
| 3.1.1.0 to 3.1.2.0 | 2012-10-23 / 24 | **Corrected download links** in an extracted `.msn` (`DownloadURLs.txt`); events `OnServerManualStart`, `OnServerManualStop`, `OnD3Server3Start`; event logging; `ProcessServerEvents` switch |
| 3.1.3.0 | 2013-01-26 | **Profanity filter** (page 580) with events `OnPlayerUsedProfanity` and `OnPlayerProfanityThreshold`; **smart hosts.deny** (the tool matches joining IPs itself and logs the hit); event variables `$ServerName`, `$PortNumber`, `$EventType`; `AllowDotsInServerNames`; tray restore on single click |
| 3.1.4.0 / 3.1.5.0 | 2013-05-28 / 30 | Public IP detection; "Copy d3://ip:port" for localhost, private and public address; Ryujin's tracker added with a "Default" button in the tracker dialog; run-time state moved to `cfg\DynSettings.ini` |
| 3.1.6.0 | 2013-06-16 | **Server control panel** switched on; remote info server code removed; optional beta channel; PIDs and tick counts stored for re-attach |
| 3.1.7.0 / 3.1.8.0 | 2013-06-23 / 27 | `$DateTime`, `$ProfanityText`, `$D3ServerVersion` variables; control panel commands `$warp`, `$setmaxplayers`, `$priority`, `$minpps`, `$maxpps`, `$servername`; `[Log]` section |
| 3.1.9.0 | 2013-11-07 | **Process priority** (page 585) for the tool and for servers at start, run and close; `ProfanityCheckForServer`; "Restart server(s)" and "Restart empty server(s)"; defaults: bright ships off, respawn 12 to 20 s; `OnD3Server3UpdateRestarting`; `$ServerToolID` |
| 3.1.10.0 / 3.1.11.0 | 2013-12-15 / 25 | Orphaned server processes terminated at start; tsetsefly.de tracker added; `DownloadURIs.dat` with up to four corrected links per mission (576); "Stop empty server(s)"; copy player name, IP, host from the event log |
| 3.2.0.0 | 2014-03-14 | Name server lookups (592); open and tail log files from the popup menu (589); `logtext.dll` mandatory; `TimeWithoutPlayersBeforeAutomaticRestart` (130 s default); `ShowBalloons`; `$MainLogfile`, `$ServerLogfile`; service stopped automatically when a second instance starts; "Send rotational velocity" and "Accurate collisions" on by default, "Use on LAN only" notes removed |
| 3.2.1.0 | 2014-05-11 | **Statistics processing**: FTP upload of `.stats` files, backup, 7-Zip archive (595) |
| 3.2.2.0 | 2014-10-10 | **CPU usage panel replaces the PXO status box**; hard-coded default tracker list (`UseDefaultTrackers`), Qtracker servers; control panel `$playerinfo`, `$ban`, `$removeban`, `$changeteam`, `$kick` work; `EnableProcessPriorityChanges`; better orphan handling; Wine detection; admin manifest; many deadlock and crash fixes |
| 3.2.3.0 | 2014-10-22 | "nickname" added to the too-short-nickname kick message; "Send rotational velocity" default back to off (it disconnects players in co-op); default FPS 999 to 333 for new installs; tracker list trimmed to the five the engine can use (`master2.qtracker.com`, `tracker.kali.net` removed) |

Versions missing from the table were not released or were beta-only (3.0.88, 3.0.76.1 to .4).

### 6.2 What the manual documents that section 2 does not cover

Pyrodeck column is read against the 0.4.21 development tree (`e7757d0`). Features that were being built when this
section was written are marked with the release that shipped them, 0.5.0.

| Feature | Page | What it does | Pyrodeck 0.4.21 |
|---|---|---|---|
| Server events: external command per event | 528, notes 3.0.90 to 3.2.0 | `ServerEvents.ini` maps an event to a command line, per server (`port:name=`) or `Default`. Events (more than a dozen): server start, stop, manual start, manual stop, level start, level end, player joined, player left, profanity used, profanity threshold, tool start, tool close, tool update restart, plus a catch-all `OnServerEvent`. Variables substituted into the command: server name, port, event type, date-time, tool version and folder, tool ID, main and server log paths, player name, profanity text. Commands run one at a time from a queue of 100, in the tool's folder, optionally hidden | partial: the internal typed bus exists (`server/src/events/ServerEvents.ts`); nothing lets an operator attach a command |
| Email on events | 579 | Not built in. A server event calls Blat (`BLAT.EXE -optionfile ... -subject ... -body "...$ServerName..."`). The page lists WSH and other mailers as alternatives. Original use: "email me when someone joins" | built in 0.5.0: email alerts on server events, over SMTP |
| Profanity monitor | 580, notes 3.1.3 to 3.1.9 | Global. Reads chat lines from the server log (needs "Log all output"), matches whole words and multi-word phrases against a sorted list, counts per player for the life of the running game. `ProfanityThreshold` (default 10, so inert) and `ProfanityAction` of `KICK`, `BAN`, `NONE`, `EVENT`, combinable (kick, ban about 2 s later, event). A canned-reply list varies the warning text. `ProfanityCheckForServer` also checks what the server says. Private messages are invisible to it | built in 0.5.0, off by default |
| Windows service | 516 | `ServiceExe` wraps the tool; no user logged in; recovery strategy through the service manager. The tool stops the service itself if run interactively | missing (a systemd unit is the Linux equivalent; not in the repo) |
| Process priority | 585, notes 3.1.9, 3.2.2 | `ProcessPriority` for the tool (idle recommended); `ServerStartupProcessPriority`, `ServerRunningProcessPriority`, `ServerClosingProcessPriority` for servers so a restarting server does not starve the others; servers always begin at normal priority; `EnableProcessPriorityChanges` off switch | built in 0.5.0 for the game server |
| Update check, beta channel, installer swap | 467, 575 | Reads the first tokens of the release-notes page at start and every 12 h; shows the new version in the title bar and event log; optional download and installer run; `DownloadAndInstallBetas` | built in 0.5.0: update notice only, by design |
| Scheduler | 433 | Weekday and time start and stop pairs per server; 24 h clock | built in 0.5.0 |
| Selective servers | 421 | When a player joins one selective server, the other selective servers stop after about 60 s (90 s in the notes); they return when the last player leaves. A server that gains a player in the delay stays up | missing |
| Automatic object extraction | 482, notes 3.0.78 | Missions with custom `.oof` models crash a server with "Could not load x.oof", mid-game or at level rollover. The tool extracts the mission's objects into the D3 folder before launch and removes them at stop (not while another running server still uses them). Known flaw: two missions that share an object file name collide | missing; not needed until a crash is seen on the 1.5 engine |
| Smart `hosts.deny` | notes 3.1.3 | The tool moves `hosts.deny` out of `netgames`, matches each joining player's IP against it and kicks, so blocked attempts appear in the server log. The engine's own file blocks silently | partial, 0.5.0: a ban adds the address to `hosts.deny` and sends `$rehash`; the engine's file still blocks silently |
| Stats upload and archive | 595, notes 3.2.1 | Watches `netgames` for `.stats` files, uploads each by FTP to `d3stats.de`, moves it to `stats_backup`, and after 200 files runs 7-Zip into `stats_archive\StatsArchive<year>.7z`. Needs "save stats at level end" and "at disconnect" on | missing; the destination's state in 2026 is unknown |
| Server control panel | 582, 588, notes 3.1.6 to 3.2.2 | A per-server dialog: console output and a command list with arguments (`$warp` with a level box, `$setmaxplayers`, `$settimelimit`, `$autobalance` and friends remembering their last choice, `$playerinfo`, `$ban`, `$removeban`, `$changeteam`, `$kick`, `say`, `quit`) | built: Console tab and `CommandReference.tsx`; per-command forms are partial |
| Server list popup menu | 588 | Stop, stop empty, restart, restart empty; copy `d3://` link for localhost, private IP, public IP; show, minimize, hide the server's own window; open log folder | partial: stop and restart exist; no empty-only variants, no join-link copy |
| Public IP detection | notes 3.1.4, 3.2.2 | Asks `descentforum.net`, `dateiliste.com` or `whatismyip` for the public address (`CheckForPublicIP`), shown beside the private one | missing: the operator sets the Join Host, and Pyrodeck shows the join address from it |
| Name server lookups | 592 | Reverse DNS of player IPs in the background, 1.5 s apart, table of 128 entries, 3 h lifetime; shown with the IP in the event log and logs | missing; low value |
| Event log popup and `whois` | 590 | Right-click a log line: copy port, PID, player name, IP, host name, `.msn` path; open a `whois` page for an IP; clear the window | missing; low value |
| Log viewing | 589 | "Open" starts a viewer on the main or a server log; "Monitor" starts `tail`; detached variants survive the tool; a log roll-over reopens the viewer | partial: `LogsPanel.tsx` |
| CPU usage display | notes 3.2.2 | Tool and servers' CPU in the main window (the notes call the numbers "not always correct") | missing |
| Orphan handling | notes 3.1.10, 3.2.2 | At start, servers the tool has no saved PID for are terminated (`TerminateOrphanedServers`); only valid PIDs are stored | re-attach built in 0.5.0; no orphan policy |
| Tracker list, hard-coded | 423, notes 3.1.4 to 3.2.3 | "Allow game tracker(s)" plus a tracker dialog; from 3.2.2 a built-in list the operator cannot edit unless `UseDefaultTrackers=0`; the engine honours five | built differently (0.6.1): the operator's own list of up to five, no built-in list (`client/src/components/TrackerListSettings.tsx`) |
| Hosts.deny and nickname list sources | 428 | Defaults `descentforum.net/D3Server/hostdeny.txt` and `aliasdeny.txt`, maintained by Do_Checkor and other operators, fetched at start and every 12 h; "remove previous entries" on by default; trailing-`*` wildcard only | covered in section 2; see section 4 for why not to copy |
| Ship list rule | 429 | Never disallow the Pyro-GL: with any other ship disallowed players default to the GL, and players who try the GL crash | built: `ServerConfigForm.tsx` warns when the GL is banned |
| Powerup rule | 430 | Always allow the "Others" group (keys, CTF flags, the Builder's Icon in co-op) | built (the list is in the form); a warning is not present |
| Co-op player cap | 420 | Max players above 3 in co-op works only with a modified `co-op.d3m`; random respawn off in co-op because scripts may need a specific powerup | partial: the cap is not warned about |
| Level choice | 420, notes 3.0.89 | "Start random level" for a multi-level mission, besides "Loop" (section 2) | partial: playlists rotate missions; random level within one is missing |
| Server defaults | notes 3.0.70 to 3.2.3 | PPS 12, FPS 333 (999 before 3.2.3), respawn 12 to 20 s, bright ships off, kill filter "Full", rotational velocity off (disconnects in co-op, 3.2.3), port 2092 and 2093 avoided (the client and Vortex use them) | partial: `sendRotVel` defaults false (`ConfigGenerator.ts:218`); the rest were not compared |
| Game name rules | notes 3.1.3, 3.0.80 | Dots in a server name can break stats file names (`AllowDotsInServerNames`); team names limited to 12 characters | missing; check the 12-character limit against the engine |
| Descent 3 profiles | 598 | Stub page, 2015-03-25: "going to be the online help for Descent 3 profiles". No release note ever ships it | not shipped by D3Server3; nothing to match |

### 6.3 Corrections to sections 1 to 5

Each is a statement in 1 to 5 that the 3.2 documentation changes. Items 3 to 5 correct the audit; the rest are version
differences.

1. **The binary audited is not the last release.** Section 1 notes this. Page 597 (2014-10-11) and page 422 date the
   last two releases 2014-10-10 and 2014-10-22.
2. **Registry.** "The D3 directory comes from the registry key `SOFTWARE\Outrage\Descent3`" holds for 3.0.83. Release
   3.0.91.0 (2011-01-15) stores the game folder in `D3Server3.ini` and stops reading the registry. Release 3.2.0.0 also exits without overwriting the server list when the stored folder is wrong and the file dialog is cancelled.
3. **Self-restart interval.** Section 2 gives "about every 3.3 h" from 12,000 passes of a one-second loop. The release
   notes say "restarts itself every 50 hours" (3.0.79.0) and page 592 says "after about 50 hours". The loop period is
   about 15 s, not 1 s. Release 3.2.2.0 adds that a restart is postponed while a dialog is open or a server is being
   played, for at most about 100 minutes, then happens anyway.
4. **`.oof` extraction purpose.** Section 5 lists it as unresolved. Page 482 resolves it: a custom model that is not in
   the D3 folder crashes the server ("Could not load filename.oof") in the middle of a game or at level rollover.
5. **Remote info server.** Page 492 (2010) lists it as a feature "to support D3Client". Its port check was removed in
   3.0.91.0 because it hung servers, and 3.1.6.0 removed every call ("this server has never been used within
   D3Server3"). Section 2's `n/a` stands.
6. **Profanity filter, email, service mode, priority control (section 2, last paragraph).** The statement is right for
   3.0.83. All four exist in 3.1 and later: profanity 580 (3.1.3.0), email 579 (through server events and Blat), service
   516 (through `ServiceExe`), priority 585 (3.1.9.0). So a statement that D3Server3 has all four is right for 3.1.9 and later, and wrong for the
   binary audited in sections 1 to 5.
7. **Re-attach.** Page 425 states it: servers keep running when the tool is closed with "Exit", and "Stop & Exit"
   is the way to stop them. Release 3.1.6.0 stores PIDs and tick counts in `cfg\DynSettings.ini`, and 3.1.10.0 adds an
   orphan policy (kill servers the tool lost). Re-attach and orphan kill are separate decisions.
8. **Nickname rules.** Page 492 confirms the `%` and observer-toggle kicks. Page 428 covers only the wildcard list, the
   hacked-name rule and the minimum length. Note 3.2.3.0 fixes the text of the too-short message only.
9. **IP capture.** Section 4 says polling `$playerinfo` "could crash servers". Release 3.0.76.1 to .3 limits it to fewer
   than six players and, above six, parses the IP from a "connection" line instead. Release 3.1.3.0 removes the crash
   warning from the dialog ("fixed several versions ago"), while page 431 still carries it. The advice to find a safe
   IP source first stands, but the author's final position was that the crash was gone.
10. **Selective servers (section 2).** The row is right. Delay: page 421 says about 60 s, the notes (3.0.89.0) say 90 s.
11. **Pyro executables.** Page 420 tells the operator to use "Pyro15" for Pyromania and that Vortex shows such servers
    only to clients configured for 1.5; 3.0.91.0 fixes hosting the Pyromania and Black Pyro Justice mods. This supports
    the inference in section 1 that the extra config keys and `-setdir` serve those builds. Still not proven.
12. **Tracker defaults (section 2).** `tracker.descent.cx:27900`, `tracker.kali.net:22999` and `master0.gamespy.com` are
    the 3.0.83 list. By 3.2.3.0 the list is hard-coded and holds, per the notes, `gsm.qtracker.com:27900`,
    `tsetsefly.de:27900` and `tracker.descentvalhalla.com:27900` among five; Kali is removed as dead (3.2.3.0) and the
    blog post (597) says "Gamespy is down". The notes do not print the complete list.

### 6.4 Download links: pages 576 and 20 against Pyrodeck's mission host

**What D3Server3 does (576; notes 3.1.1.0, 3.1.11.0, 3.2.2.0; 575).** When it starts a server it extracts the `.msn`
embedded in the `.mn3` into the game folder, and writes into it corrected download URLs from a data file shipped with
the tool: `DownloadURLs.txt` at first, then `DownloadURIs.dat` (3.1.11.0), built from Do_Checkor's "Download Link
Surgery 2007". Up to `AmountDownloadLinksToCorrect` links are added, default four, because the engine accepts five and
the fifth slot is left for the level author's first link. Applies to every mission when `CorrectDownloadURIs=1`, not
only the surveyed ones. The links are added once, at first start, since 3.1.11.0 (earlier builds appended them at every
restart and the `.msn` grew). A `.msn` that the tool did not write is overwritten or deleted unless it is
write-protected (575), and it also writes `.msn` files for level looping (section 2), so the two features share a file.
The links point at third-party hosts that serve a `.zip`; in the worked example (page 20) the host is
`dateiliste.de/d3files/missions`. An operator with a mission outside the list edits the mission in D3Edit ("Edit MSN",
replace the dead URLs, save, zip `.mn3` and readme, upload), and page 20 notes that changing only the URLs does not make
the file incompatible with copies other players already have. Existing server configurations are corrected only after
the operator reselects the mission (576).

**What Pyrodeck 0.4.21 does.** `Mn3UrlRewriter.ts` edits the URL lines of the `.msn` inside the server's own `.mn3`
copy, capped at 86 characters and five lines (the client formats the link into a 100-byte buffer); `MissionHost.ts`
runs a second HTTP listener (default 3002, off until enabled) that serves the `.mn3` itself, and the client saves any
non-`.zip` body as the mission (`missionHostSettings.ts`, `MissionHost.test.ts`).

**Comparison.**

| Aspect | D3Server3 3.2 | Pyrodeck 0.4.21 |
|---|---|---|
| Where the link text goes | extracted `.msn` in the game folder, rewritten at launch | the `.msn` inside the server's `.mn3` copy |
| Where the file is hosted | third-party hosts from a shared list (`DownloadURIs.dat`) | the game server's own machine, plain http, `.mn3` served directly |
| Link count | four corrected plus the author's first | up to five, set by the operator |
| Opt-out | write-protect the `.msn` | do not enable the host / do not rewrite |
| Dependency | a central list the author maintains; the Dateiliste site is gone and its list cannot be refreshed | the operator's own bandwidth and an open port |
| Applies to | all hosted missions, once per start | missions the operator hosts or rewrites |

Pyrodeck's design avoids the central-list failure. The 2010 list points at community hosts of its day (Dateiliste, DFiles.de, Descentforum); only Dateiliste was checked, and it is gone. Page 576 itself says many of the embedded links "don't exist anymore", and release 3.2.1.0 moved DFiles.de to the end of the list because it "is not always available". Two ideas carry over. First, keep the
original author's link in the fifth slot rather than replacing all of them. Second, apply the rewrite once per launch
and never append on restart (the 3.1.11.0 bug). One difference to document: D3Server3 serves a `.zip` (the client
unzips it) while Pyrodeck serves a raw `.mn3`; both work with the client logic described in `MissionHost.ts`.

### 6.5 Do any game trackers still answer in 2026?

Yes. When the audit was made, at least two trackers that speak the engine's GameSpy protocol were answering. One of
them is the list the open-source client's game browser reads
(`netcon/descent3onlineclient/dip_gametrack.h` in the engine tree). That moved item 8 from waiting to worth building,
and Pyrodeck 0.6.1 has it: Launch panel → Edit → Tracker Listing writes the tracker list the server reads.
[The dedicated server reference](d3-dedicated-server-reference.md#the-tracker-list--gspyfile) gives the file's format
and what a tracker needs from the server.

Pyrodeck ships no tracker list. The hosts D3Server3 shipped date from 1999 to 2014 and some no longer resolve, so the
operator supplies the list.
