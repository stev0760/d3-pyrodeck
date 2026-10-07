# D3Server3 feature audit

Audited 2026-10-07 against D3 Pyrodeck 0.4.20 (`b4eaccf`).

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

Pyrodeck's `PLAN.md` (Phase 3) cites "D3Server3 v3.2 screenshots". The binary audited here is 3.0.83, so a later
release may have features this one lacks.

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
| Auto commands: a list run when the console connects and at each level start, then every N minutes; all, one at a time, or one at random | Console and Logging dialog and tooltips; `0x447170`, `0x406fa0` | missing (PLAN Phase 6) |

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
| Blocked IPs and ranges in `netgames\hosts.deny`; `$rehash` sent at every level start | anti-cheat dialog; `0x447400` | missing (PLAN Phase 6, "IP access control UI"); `$rehash` only as a typed command |
| Community ban lists downloaded every 12 h (`hostdeny.txt`, `aliasdeny.txt` from descentforum.net), merged or replacing earlier entries | `0x412cb0`, `0x412a60` | missing (section 4 explains why not to copy it as built) |
| Change max players live | `$setmaxplayers` (`0x447660`; D3Server3 sends it only from the cross-server cap code) | built: Server sidebar stepper |

### Discovery and trackers

| Feature | Evidence | Pyrodeck 0.4.20 |
|---|---|---|
| GameSpy-protocol tracker list and region code (`gamespy.cfg`, `-gamespyport`, `-gspyfile`); defaults `tracker.descent.cx:27900`, `tracker.kali.net:22999`, `master0.gamespy.com:27900` | Game Tracker dialog; region list | missing (PLAN Phase 6) |
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
   check. The largest structural gap (README Known Limitations, PLAN Phase 6). Communities often run more than one
   game type side by side.
6. **Periodic console commands:** a list run at start and every N minutes, all, one at a time, or at random (rules,
   a Discord link, tips). Small, and already on PLAN Phase 6.
7. **Bind address, game port, frame cap and logo switch in the profile** (`-useip`, `-useport`, `-framecap`,
   `-nomultibmp`). Hosts with several addresses need `-useip`, `-useport` is a precondition for item 5, and
   `-framecap` sets the server's tick rate.
8. **Game tracker registration** (`gamespy.cfg` with region and tracker list, `-gamespyport`, `-gspyfile`). The engine's
   only built-in way to advertise a Direct TCP/IP game. Worth building only if a GameSpy-protocol master still answers
   in 2026, which this audit did not check.
9. **Nickname checks on join:** kick names that are empty, contain `%`, or contain non-printable characters, with an
   optional minimum length and a `say` reason first. Cheap and defensive. Whether a `%` name still harms the current
   engine was not tested.
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

### Side finding: the Startup Commands file is probably never read

Found while checking the `-autoexec` row. Read from source, not tested live. Pyrodeck's "Startup Commands" companion
is `<gamePath>/autoexec.dmfc` (`server/src/routes/config.ts`, `/api/profiles/:id/companions`, and
`ServerProfile.readFile`/`writeFile`, which join a bare file name to `gamePath`). DMFC reads
`<D3 dir>/netgames/autoexec.dmfc` unless `-autoexec <path>` is on the command line (`ParseStartupScript` in
`netgames/dmfc/dmfcbase.cpp`), and Pyrodeck passes no `-autoexec` (`additionalArgs` in `ProcessManager.ts` is never
set). If that holds, commands saved there do nothing. Passing `-autoexec ./<file>` per profile would fix it, and would
also let the 0.4.20 post-start settings apply at launch, as D3Server3 does, instead of over the console afterwards.

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
- **Pyrodeck column:** read from the 0.4.20 README, CHANGELOG, PLAN, spec and the server and client sources at
  `b4eaccf`. The Startup Commands finding in section 3 comes from reading source. It was not tested against a server.
