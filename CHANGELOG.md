# Changelog

All notable changes to D3 Pyrodeck are documented here.

## [0.6.1] - 2026-11-20

A server can be listed on game trackers from the panel.

### Added
- **Tracker listing.** Launch panel → Edit → Tracker Listing sets a server's region (a number from 0 to 12) and up to
  five trackers (`host` or `host:port`). Pyrodeck writes them to the file the server reads (`-gspyfile`, default
  `gamespy.cfg` in the game directory) as region and tracker pairs, the form the game reads, and keeps the old file as
  `<name>.bak`. The game reads one region line before each tracker, so a file of one region line followed by several
  trackers loses every second tracker: the block flags such a file and shows the lines the game does not use. It names
  the other profiles that read the same file, says the game reads it when the server starts, and gives the GameSpy UDP
  port the trackers query, which must be reachable from the internet. A GameSpy file that is not a `.cfg`, `.mps`,
  `.dmfc` or `.txt`, or is a server config or Startup Commands file, is shown but not saved. Pyrodeck ships no tracker
  list of its own. On a phone it is under More → Profiles → Edit.
- **API.** `GET` and `PUT /api/profiles/<id>/tracker-list`.

### Fixed
- **A shuffle playlist's saved position could carry a later shuffle order.** Each save of the playlist state is queued,
  and a queued save shared the live shuffle list, so a rotation made before the write ran changed what was written. A
  Pyrodeck restarted from such a file could play one entry of the round twice. Each save now takes its own copy.

### Security
- **The panel writes and deletes only config files in the game directory:** `.cfg`, `.mps`, `.dmfc` and `.txt`. Every
  write and delete there (the file editors, a restore of the previous version, the tracker list) refuses any other
  name with a 400. The game's executable lives in that directory, and a file written under its name would have run at
  the next launch. Reads are unchanged.

## [0.6.0] - 2026-11-15

One Pyrodeck runs several Descent 3 servers at once, an Anarchy and a CTF server side by side, from one panel. The
upgrade from 0.5.x is automatic.

### Added
- **A server list.** The Launch panel opens on the servers, one row per profile (and the server launched without a
  profile, once used): its state (stopped, starting, running, stopping, crashed; restarting or holding during a
  playlist's mission change), game type, mission and level, humans of max players, active playlist and ports, with
  its own Start or Stop. The list says how many run.
- **The server on screen.** A click on a row shows that server, and every tab is about it: Output, Console, Players,
  Bots, the server card, Playlists, Logs, Rules, Config, and the launcher, supervisor and autostart blocks. Its name
  and state stay in the header, the server card and the Launch and Stop buttons, so a command goes to the server you
  see. Each server keeps its own console text and game output (2000 and 5000 lines), and switching shows that
  server's, never the last one's. The choice is kept per browser. Bans and Settings apply to all servers and say so.
- **On a phone** the Server tab lists the servers, every screen names the server on screen at the top, and a tap
  there opens a sheet to pick another. The server is part of the address (`#/console?s=<id>`), so a reload opens it
  again.
- **A server per profile.** Each profile's server launches, logs in to its console, is watched by its own supervisor
  (relaunch, hang check, restart when empty: a player on one server never keeps another from its empty restart),
  rotates its own playlist, follows its own schedule and keeps its own run record, beside the others.
- **Launches that would clash are refused**, with a message naming the other server and what to change: the same game
  port, a GameSpy port set in the profile, the console port, the server config file, a Startup Commands file in use,
  or a temp directory set in the profile. The panel shows each reason under the server's row. A setting the operator
  made is never changed.
- **Each server gets its own temp directory** (`-tempdir`, short, the same at every launch) unless the profile sets
  one, so two servers no longer fight over the engine's lock file; and **a free GameSpy port** (`-gamespyport`) when
  another server holds 20142 and the profile sets none. Launch Options take a temp directory of their own.
- **A Startup Commands file per profile**, for servers sharing a game directory: Launch panel → Edit → Startup
  Commands File (default `autoexec.dmfc`), with a warning when another profile in the directory uses the same one. A
  profile created or duplicated in a game directory another profile uses gets its own (`ctf.cfg`: `ctf.dmfc`; a
  duplicate gets a copy of the source's commands). The Config tab edits the profile's own file.
- **A playlist per server.** The library is shared; Activate starts a playlist on the server on screen, each server
  rotates its own (two rotations at the same moment each restart their own server), and every playlist shows where it
  is active ("Active on CTF"). Hosting a playlist's missions covers every active playlist.
- **Re-attach to several games** after Pyrodeck restarts, and **autostart of several profiles**: "Start when Pyrodeck
  starts" can be on for more than one, the Autostart block lists them, and `PYRODECK_AUTOSTART_PROFILES` takes a
  comma-separated list (the single `PYRODECK_AUTOSTART_PROFILE` still works).
- **API.** `GET /api/servers` lists the servers (state, console, mission and level, humans and max players, game type,
  playlist, ports, supervisor, autostart), and `/api/servers/<id>/start`, `stop`, `status`, `command`, `players`,
  `playlist` (`activate`, `deactivate`, `resume`), `supervisor` (`cancel-relaunch`) and `autostart` (`cancel`) act on
  one. A server's id is its profile's id; `launch` is the server started from the global `dedicated.cfg`, `connect`
  Connect mode's session. `POST /api/profiles` takes the new config's `remoteConsolePort` and launch options; `PATCH`
  takes `startupFile`.
- **WebSocket protocol 2.** A client that sends `{ "type": "hello", "payload": { "protocol": 2 } }` gets every
  server's messages tagged with `serverId`, and names the server in its commands. The panel speaks it.

### Changed
- The URLs and WebSocket messages of earlier versions keep working for one server: they act on the profile named in
  the request, else on the only server running, else on the default server (the one running, else the last one). A
  change that names no server while several run answers 409 with the route to use, and `POST /api/launcher/start`
  still refuses while another server runs. A WebSocket that never says hello gets the default server's messages only,
  as before. The panel uses the per-server routes for everything it changes.
- Every launch now passes `-tempdir` (see above).
- Supervisor settings apply to every server; each server's supervisor keeps its own counters. Log retention and log
  deletion protect every running server's log; process priority applies to every server; `$rehash` after a hosts.deny
  edit goes to every server's console. Kick and ban name their server.
- `$netgameinfo` is asked once per console login of each server, when the panel first shows it, and never again on a
  switch back.

### Fixed
- **A playlist no longer skips an entry after Pyrodeck restarts.** The position was saved only at activation, so a
  restarted Pyrodeck came back at the first entry and the next mission change skipped ahead (0.5.7 and earlier do
  the same). The position is now saved at every mission change, and the next one goes to the entry after the one the
  server runs; a shuffle round goes on where it was. A mission change that was under way is finished: a server held
  before its restart, or one not yet stopped, is restarted into the next mission once Pyrodeck has logged in to it
  again; a server already restarted into it is left alone.
- **A server a playlist was restarting is no longer left down by a Pyrodeck restart.** When the old game had quit and
  the new one was not launched yet, Pyrodeck now launches it into the next mission at startup, unless the playlist is
  paused.

### Upgrade
- The first start upgrades the config directory in place: `servers/index.json` (the autostart list) and `servers/<id>/`
  (each server's run record and playlist state) are added; nothing else is moved, Connect mode's saved servers
  (`servers.json`) included. A running server is re-attached to and its playlist carries on.
- A browser tab left open across the upgrade keeps working on one server; reload it for the server list.
- To go back to 0.5.x, stop every server but one first. `running-server.json`, `playlist-state.json` and
  `autostart.profileId` keep describing one server for an older Pyrodeck, which re-attaches to it; the other servers
  would keep running unseen.

## [0.5.7] - 2026-11-15

A playlist's missions download from the mission host without a click per mission.

### Added
- **Playlists host their missions.** With the mission host on, activating a playlist points the download link of every mission in it at `<public URL>/missions/<file>`, through the same rewrite as **Host this mission** (the original is kept once as `<name>.mn3.pyrodeck-orig`). It happens again when the active playlist is saved with other missions, and when the mission host is turned on, or its public URL changed, while a playlist is active; links the host set under its former URL move to the new one. Skipped: missions that ship with the game, entries whose file is missing, links that already point at the host (no rewrite and no new backup), and a link the operator typed for a mission (Pyrodeck holds a backup and the link is not the hosted one), which is reported as its own link and kept. Nothing happens when the host serves another missions directory than the playlist's server; the playlist says so. A mission that cannot be rewritten is reported with the reason and never stops the activation. The sidebar and the playlist editor show one line, such as "Downloads: 9 hosted, 3 ship with the game, 1 failed", the editor with a line per mission that failed, is missing or keeps its own link; Pyrodeck's log lists each mission. The links take effect the next time the server loads each mission; nothing is restarted. `POST /api/playlists/:id/activate` and `PUT /api/mission-host` return the result as `downloads`, and `GET /api/playlists/status` and `playlist_status` carry the latest one.

### Changed
- **Missions that ship with the game are never hosted or rewritten**: `bedlam`, `bluedev`, `bside`, `bsidectf`, `chaos`, `d3`, `d3_2`, `dementia`, `frenzy`, `fury`, `havoc`, `kata12`, `mayhem`, `merc`, `poe`, `stonecutter`, `training` and `tri-pod` (`.mn3`, any case). Every player already has them. The mission host answers 404 for them, **Host this mission** and a typed link are refused ("ships with Descent 3; every player already has it"), and the Config tab offers neither for them. Until now only the four the server never advertises (`d3`, `d3_2`, `training`, `merc`) were left out. A link set on one of them by an earlier version can still be restored.
- **Host this mission** on a mission whose link already points at the host no longer writes a backup of it.

## [0.5.6] - 2026-11-05

A mission change no longer strands the players: they are held with a countdown, and the server quits cleanly.

### Added
- **A hold before every mission change.** A new mission needs a server restart. When a playlist's mission ends, Pyrodeck lets the server load the mission's first level again (the clients follow it into a live level, after the score screen), sends `$wait on` (DMFC's own command: every ship stops, weapons stop, the clock pauses and the game shows "Waiting for server"), and counts down in chat: "Mission over. The server restarts in 30 seconds for <next>.", "To play on, quit now (Esc) and join again in a minute.", then at 20, 10 and 5 seconds. The countdown starts when the first player is back in the level (a client spends some time on the score screen and loading; 25 seconds in the test flight), or 45 seconds after the server was held if none arrives; a player who arrives later is told the time left. Then the server restarts into the next mission. The length is per playlist, **Hold before the restart** under Mission Change in the playlist editor (default 30 s, 0 to 120, 0 restarts at once); the hold is skipped when no human is on. Calling a rotation off (an incompatible entry), deactivating or pausing the playlist, or starting or stopping the server by hand during a hold lets the players go (`$wait off`). The sidebar shows the hold and its countdown. `GET /api/playlists/status` and `playlist_status` carry status `holding` with `holdEntry` and `holdEndsAt`; a playlist carries `holdSeconds`.

### Changed
- **Rotations and a manual Stop quit the server through its console.** Pyrodeck sends `quit` and half-closes the connection: the server tells every client it has gone, so a player still on drops to the main menu at once, and since Pyrodeck closes its side first the console port is free for the next launch. A rotation used to kill the server instead, and a manual Stop's `quit` could leave the port busy for a minute. If the server does not exit, Pyrodeck still signals it.

### Fixed
- **A playlist rotation no longer hangs the players' clients.** Pyrodeck stopped the server one second after the mission ended, while the clients were on the score screen about to load the next level, and without telling them; each client then waited for a server that had gone until it timed out (up to about 80 seconds, measured on a live server), and the only way out was to force-quit the game.

All of it uses the stock console (`$wait`, `say`, `quit`) and works with any Descent 3 dedicated server. Bots on a Matcen server freeze with the players during the hold from Matcen 0.10.15; on older Matcen builds they keep moving.

## [0.5.5] - 2026-10-22

A phone layout, and the bot roster editor made safe: population settings, in-place saves, backups and the sample roster.

### Added
- **A phone layout.** Below 768 px the panel is a phone app: one screen at a time, a tab bar (Server, Console, Players, Bots, More), screens in the URL hash so the phone's back button and reloads work, bottom sheets for pickers and actions, confirmations before stopping the server or removing bots, 44 px targets and 16 px inputs. Server launches or stops the selected profile and holds the live server card; Players is a tappable scoreboard with kick and ban; Bots shows the population manager (on servers with the Matcen `population` feature), the bots with their shields, and an add-bot sheet; More holds Profiles, Config, Playlists, Logs, Bans, Rules and Settings. Tablet and desktop are unchanged. See `docs/phone.md`.
- **A console you can type into on a phone.** The console text as wrapped rows with a command field under it: favourite queries as chips, recent commands behind a history button, matching commands as a `$` word is typed, and a sheet of every command group the server offers (a command without arguments sends on a tap; one with arguments opens to its fields). Launch mode adds a switch to the game's own output.
- **Add to the home screen.** A web manifest, icons drawn from the Descent logo font and the iOS metas: installed from Safari or Chrome the panel opens full screen with its own icon.
- **Config on a phone.** The server config form, the bot roster editor with the population settings, startup commands, ship settings and every config file in the game directory, each as a form or raw text with Save and the previous version.
- **Settings → Layout:** use the desktop layout on a phone, and the way back from there.
- **Population settings in the Bot Roster editor.** "Bots at start" (`BotCount`), "Target players" (`BotTargetPlayers`) and "Reserved seats" (`BotReservedSlots`) sit above the roster, with the sizing rule and a warning when the profile's MaxPlayers is too small for the target. Entries beyond the bots at start are marked as the population manager's pool. Until now only the raw editor could set these keys.
- **Reset to the sample roster.** One confirmation writes Matcen's sample `bots.cfg` (Reaper, Phantom, Viper and Shadow; four at start, the manager keeping 12 players, one seat free), comments included. A roster created from the Config tab starts from the same sample instead of an empty `BotCount=0`.
- **Previous versions of config files.** Every write that changes a file in the game directory keeps the old content as `<name>.bak`, one per file. The raw editor and the roster editor offer "Restore previous version"; a restore swaps the two, so it can be undone. New endpoints: `GET /api/profiles/:id/files/:filename/backup`, `POST /api/profiles/:id/files/:filename/restore` and `POST /api/profiles/:id/bot-roster/reset`.
- **`$botpopulation` is parsed** on servers with the Matcen `population` feature: the `Population:` status line arrives as a `botpopulation` WebSocket message, and the Bots tab (desktop and phone) turns it into a card with the manager switch, the target and the reserved seats, live on the running server. Vanilla servers never see it.

### Changed
- **One session for both layouts.** The connection, launcher, playlist and server-info state live above the layout, so switching between the phone and desktop layouts, or rotating a tablet across 768 px, keeps the console connection.
- **Console text survives leaving the tab.** Both layouts keep the last 2000 console lines and 5000 lines of game output; the desktop consoles replay them when their tab is opened again.
- The desktop layout renders its side panels either inline or in a sheet, never both, so a hidden Launch panel no longer polls beside the visible one.
- `scripts/ui-shots.mjs` screenshots every screen at phone, tablet and desktop sizes for a before-and-after comparison; `scripts/make-icons.sh` regenerates the icons.

### Fixed
- **Saving the Bot Roster form no longer erases what it does not show.** It regenerated the whole file and dropped `BotTargetPlayers`, `BotReservedSlots`, every comment and any roster entry above `BotCount` (the population manager's pool). The file is now edited in place: the lines the form manages are replaced where they stand and everything else stays. Matcen's sample roster round-trips byte for byte.
- `BotCount` is the number of bots that join at start, as the engine reads it, not the length of the roster; the form used to force the two equal.
- The raw editor showed an empty file when a read failed and said nothing when a save failed; both now show the error. After a structured save the Raw view shows the saved text, not the text from before it.
- A roster file whose keys are not capitalised the usual way (`botcount=`), or that has `BotName1=` lines and no `BotCount=`, is recognised as a roster.
- Config writes go through a temp file and a rename, so an interrupted write cannot leave a half-written file.
- The Logs tab scrolls inside its panel instead of the whole page.
- The login and setup pages keep a side margin on a phone.

## [0.5.4] - 2026-10-21

A rebuild on Node.js 24.22.1, the Node.js security release of 2026-10-21. Nothing Pyrodeck does has changed.

### Security
- **The packaged binary is built on Node.js 24.22.1.** That release fixes the Node.js vulnerabilities announced the same day, four of them rated high (two TLS host name checks that could be bypassed, DNS name truncation, and a Brotli decoder bug rated as remote code execution), and updates the root certificate store built into Node.js to NSS 3.131.1, which drops the eMudhra (emSign) roots after the compromise of their intermediate keys and rejects any chain built on those keys. Pyrodeck's own TLS connections, the update check against GitHub and email alerts over STARTTLS or TLS, verify certificates against the store inside the binary, not the operating system's, so a root store fix reaches a host only through a rebuilt binary. Hosts on 0.5.3 or earlier should upgrade.
- **`.nvmrc` pins the exact Node.js version** (`24.22.1`) that the release workflow runs and that the packaging script downloads from nodejs.org, so a release build no longer takes whichever Node 24 the build runner has cached.

## [0.5.3] - 2026-10-08

A release for running unattended: the game comes back after a reboot, it no longer sees Pyrodeck's secrets, and releases carry checksums.

### Security
- **The game server no longer inherits Pyrodeck's environment.** It got all of it, `PYRODECK_ADMIN_PASSWORD` and `PYRODECK_SESSION_SECRET` included, along with anything else the service manager or a shell had set. Pyrodeck now builds the game's environment from a list: `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `TMPDIR`, `TMP`, `TEMP`, `TZ`, `LANG`, `LANGUAGE`, `LC_*`, `XDG_*` (the game's writable directory, and with it `netgames/hosts.deny`, follows `XDG_DATA_HOME`), `SDL_*`, `D3_*` (the engine's own), `LD_LIBRARY_PATH`, and on Windows the system variables a program needs to start and to open sockets (`SystemRoot`, `windir`, `ComSpec`, `TEMP`, `APPDATA`, the profile and program folders). `SDL_VIDEODRIVER=dummy` is set unless the environment names a driver, as before. No `PYRODECK_*` variable reaches the game, in any letter case. A variable outside the list no longer reaches the game either.

### Added
- **Autostart.** `PYRODECK_AUTOSTART_PROFILE=<profile name>`, or **Start when Pyrodeck starts** in a profile (Launch panel → Edit), launches that profile when Pyrodeck starts, so a host that reboots for updates brings the game back without anyone pressing Launch. One profile at a time: ticking a second one replaces the first. The environment variable wins, and the box shows as locked while it is set. The name must match the profile's exactly (a profile's id also works). Without either setting nothing changes.
- Autostart runs once, after Pyrodeck has tried to re-attach to a server that kept running across its restart. A server that is still running is left alone, re-attached or not. Otherwise the profile is launched exactly as the Launch button launches it, active playlist included: the server starts on the mission the playlist's last rotation wrote into the profile's config, rotation carries on from there, and a paused playlist stays paused until you resume it.
- **Crash-loop guard.** A launch that fails, or a server that exits within 60 s of starting, counts as a failure. After 5 in a row autostart stops: Pyrodeck's log gets an error with the last reason, a toast says it, and the supervisor stops relaunching (its block shows why). Autostart retries a launch that failed before the game started (a missing executable, an unreadable config) after 5, 10, 20 and 40 s. A server that started and then exited is relaunched by the supervisor, as after any crash, and the guard counts those relaunches; with **Relaunch the server when it crashes** off, the first early exit ends it. A server that stays up for 60 s ends the guard, and so does anyone else starting or stopping the server meanwhile.
- An unknown or ambiguous `PYRODECK_AUTOSTART_PROFILE` is logged as an error at startup, naming the profiles that exist. Pyrodeck carries on and starts nothing.
- Launch panel → **Autostart**: the profile and where it is set, what autostart did at startup, failures so far, the next retry with a **Cancel** button, and why it gave up. `GET /api/launcher/autostart`, `POST /api/launcher/autostart/cancel`, `autostart` in `GET /api/launcher/status`, and `PATCH /api/profiles/:id { autostart: true | false }`.
- **`SHA256SUMS.txt` on every release**, listing the SHA-256 of each asset in the format `sha256sum --check` reads. A manual (dry) run of the release workflow produces it too, as an artifact. README and BUILDING.md say how to verify a download.

### Changed
- `server.started` has a new reason, `autostart`; email alerts list it as a start.
- A supervisor that has given up schedules no relaunch, whoever made it give up. The next launch by hand starts over, as before.
- `docs/running-as-a-service.md` sets `PYRODECK_AUTOSTART_PROFILE` in the systemd unit, NSSM and `schtasks` examples, and explains what happens at a reboot; `docs/behind-a-reverse-proxy.md` lists it with the rest of the environment.

### Fixed
- A manual run of the release workflow from a branch whose name has a `/` failed to package: the branch name went into the file name. Packages from such a branch use `-` instead.

## [0.5.2] - 2026-10-08

The second hardening release for running Pyrodeck on the public internet: real login sessions, a loopback-only default address, and retention for the game-server logs.

### Security
- **Real sessions.** The session cookie held a signed constant, the same for every login: logging out only deleted the browser's copy, nothing expired on the server, and only a new session secret logged anyone out. Each login now gets a random 32-byte session id, kept in Pyrodeck's memory and checked on every request. A session ends at logout, 12 hours after login (`PYRODECK_SESSION_TTL_HOURS`) or after 120 minutes without a request (`PYRODECK_SESSION_IDLE_MINUTES`), whichever comes first, and the cookie's lifetime matches. A login always starts a new session and ends the one the browser carried, so an id planted before login is never the one logged in. Setting the admin password ends every session. Sessions are not saved to disk: the upgrade, and every restart of Pyrodeck from now on, logs everyone out.
- **Log out all sessions.** Settings tab → Sessions lists the sessions (address, browser, login and last use) and ends them all, this one included (`GET` and `DELETE /api/sessions`).
- **Open consoles close with their session.** A console WebSocket closes (code 4401) as soon as the session that opened it ends, by logout, revocation or timeout, and the browser goes back to the login page. A browser that reconnects after a Pyrodeck restart is sent to the login page instead of retrying forever.
- **Pyrodeck listens on 127.0.0.1 unless `PYRODECK_HOST` is set** (it was `0.0.0.0`). Behind a reverse proxy, or used from the same machine, nothing changes. **A LAN that opens Pyrodeck directly at `http://<this machine>:3001` must now set `PYRODECK_HOST=0.0.0.0`.** The desktop app (always on loopback) and `pnpm dev` work as before. Startup says where Pyrodeck listens and how to serve a LAN.
- A malformed `PYRODECK_PORT`, `PYRODECK_SESSION_*` or `PYRODECK_LOG_*` value stops Pyrodeck at startup with an error naming the variable.

### Added
- **Log retention, opt-in**, for the game-server logs Pyrodeck writes, one per launch (a server writes 12-28 MB an hour, and nothing pruned them). **It is off by default: an upgrade deletes and compresses nothing.** Once set, closed logs are gzipped in place (renamed to `.log.gz`, keeping their modification time), logs last written more than `PYRODECK_LOG_RETENTION_DAYS` ago are deleted, then the oldest until the total fits in `PYRODECK_LOG_MAX_MB`; `PYRODECK_LOG_COMPRESS=1` turns compression on. For a public server, 30 days, 2048 MB and compression on are recommended (the service unit in `docs/running-as-a-service.md` sets them). Retention runs at startup, every hour and when its settings are saved, and logs each compression and deletion at info level. It touches only files named the way Pyrodeck names its logs (`<profile>-YYYY-MM-DDTHH-MM-SS.log`), never anything else in the Log Directory, which may be the game's own folder; symlinks and directories are skipped. The running server's log, and any log written in the last ten minutes, is never compressed or deleted.
- While retention is off, Pyrodeck's log warns at startup and on each hourly check once its logs take more than 1 GB, with the total, the directory and the variables to set; the Logs tab shows the same notice.
- Logs tab → **Retention**: days, size cap and compression, saved in `config/pyrodeck.json`. A value set in the environment wins and shows as locked. `GET` and `PUT /api/logs/retention`.

### Changed
- The Logs tab lists compressed logs too. View decompresses them (the last 256 KB, as for any large log); Download saves the `.log.gz` itself.
- The Vite dev proxy targets `127.0.0.1:3001` instead of `localhost:3001`.
- `docs/behind-a-reverse-proxy.md` and `docs/running-as-a-service.md` rely on the new default address and set the session and recommended log retention variables explicitly.

## [0.5.1] - 2026-10-08

A hardening release for running Pyrodeck on the public internet behind a reverse proxy.

### Security
- **A request through a reverse proxy could be read as local.** With `PYRODECK_TRUST_PROXY` unset, every request through nginx came from 127.0.0.1, so until an admin password was set the whole API was open to the internet and anyone could claim the password with first-run setup. A request carrying `X-Forwarded-For`, `X-Forwarded-Host`, `X-Forwarded-Proto`, `Forwarded` or `X-Real-IP` is now never local, whatever the proxy setting. Local also requires the browser to ask for `localhost` or `127.0.0.1`, so a web page that points its own DNS name at 127.0.0.1 is not local either. The API, first-run setup and the console WebSocket share one test for this.
- **`PYRODECK_TRUST_PROXY=1` trusted every hop**, so the client's address was the left-most `X-Forwarded-For` entry, which the client writes: sending `X-Forwarded-For: 127.0.0.1` made a browser local, and a fresh address per attempt escaped the login rate limit. It now trusts a proxy on the same machine only (127.0.0.0/8, ::1), and the client's address is the right-most entry that is not that proxy, the one nginx appended. A proxy on another host is named by address or CIDR block (`PYRODECK_TRUST_PROXY=10.0.0.5`); a value that is neither stops Pyrodeck at startup.
- The session cookie is marked `Secure` when the browser reached Pyrodeck over HTTPS (`X-Forwarded-Proto` from a trusted proxy counts). Plain-http localhost works as before.
- The login rate limit counts per real client behind a trusted proxy, and per /64 for IPv6 clients.
- Browser requests whose `Origin` names another host are refused (403), the console WebSocket included, which had no origin check; this also covers the no-password local mode, where no cookie is needed. Behind a proxy that does not pass the `Host` header on, the error says so.
- Startup warnings when `PYRODECK_TRUST_PROXY` is set but Pyrodeck listens on a public address, and when it is set with no admin password; one warning the first time a proxied request arrives while it is not set.
- **The game console can stay off the network.** Pyrodeck refused to launch a server without `AllowRemoteConsole=1`, which puts the console (plain TCP, password in clear) on every interface. A launched server with `AllowRemoteConsole=0` is now logged in to on 127.0.0.1, whatever the profile's bind address; that console takes local connections only on every engine, and Matcen 0.10.8 and later also listen on 127.0.0.1 only. New configs are written with `AllowRemoteConsole=0`, and Pyrodeck's log warns at each launch of a profile that still uses 1.

### Added
- `docs/behind-a-reverse-proxy.md`: a public server with nginx and Let's Encrypt in front. The order of steps (admin password first), the environment, a complete nginx server block with the WebSocket upgrade, certbot, the firewall (what to open, and never the console or Pyrodeck's own port), HSTS and mission links, and checks.

### Changed
- The config form's Remote Console section always shows the port and password. Its switch reads "Accept console connections from other machines", explains that a server launched here does not need it, and warns that the console is reachable from the network when it is on.
- Connect mode explains a refused console: a server on another machine needs `AllowRemoteConsole=1`. A console that closes the connection before asking for the password now says so instead of reporting a failed password.
- Saving a profile's launch options warns about its console: open to the network with `AllowRemoteConsole=1`, or a bind address (`-useip`) with `AllowRemoteConsole=0`, which engines older than Matcen 0.10.8 cannot be logged in to. The same note follows a failed login or a console that never opens.
- `docs/running-as-a-service.md`: the systemd unit sets `PYRODECK_HOST=127.0.0.1` and `PYRODECK_TRUST_PROXY=1`.

## [0.5.0] - 2026-10-08

### Added
- **Supervisor: Pyrodeck keeps a launched server up, as D3Server3 did.** It relaunches the server when the process exits without a stop request (after 5 s, doubling to 2 min; after the seventh failure in 30 minutes it gives up and says so). It kills and relaunches a server whose remote console has been silent for 120 s and did not answer `$players`, sent after 59 s of silence; no probe or kill in the 2 minutes after a level starts loading. When turned on, it restarts a server that has run longer than an uptime limit, once no human has been on it for 130 s; bots don't count, and `$players` confirms the server is empty first. A server stopped from Pyrodeck, by a playlist rotation or with `quit` at its console stays down, and a crash during a playlist restart is left to the rotation's own retry. Relaunch and the hang check are on by default, restart-when-empty is off. If the console link drops while the server runs, Pyrodeck logs in again every 5 s. The Launch panel's **Supervisor** block shows its counters and holds the switches and limits; `GET /api/launcher/status` reports the same state, and Pyrodeck's log gets a `[Server]` line per start, stop, crash, hang, level start, join and leave.
- **Pyrodeck re-attaches to its server after it restarts.** A server Pyrodeck launched now keeps running when Pyrodeck stops or restarts (an upgrade, a crash, closing the desktop app), and the next Pyrodeck takes it over: status, console, Stop and the supervisor work again. Pyrodeck keeps the server's PID and launch in `config/running-server.json` and checks that the process is still that server before adopting it (on Linux by its start time, boot ID and command line; elsewhere by a console login). The server's output is no longer captured after the restart: the Output tab and the log file stop at that point, and the Launch panel says so.
- **Join address with a Copy button** in the Launch panel: the `host:port` players type into Multiplayer → Direct TCP/IP. The port is the profile's game port (`-useport`, else 2092); the host is a new global Join Host setting, edited right there, else the profile's public bind address, else the host of the mission host's public URL, else a LAN bind address (marked as reachable on this network only). `GET /api/profiles/:id/join-address`.
- **Powerup respawn time scaled by player count** (Launch panel → Edit → Respawn by Players; off by default): the longest time with two human players or fewer, falling evenly to the shortest at a chosen count (3-32), bots (`[BOT]`) not counted. Pyrodeck sends `$setrespawntime <seconds>` when the console connects and 15 s after the last join or leave, and only when the value changes; the server applies it to the next powerups picked up. The count comes from `player.joined`/`player.left` on Pyrodeck's server event bus.
- **Periodic console commands per profile** (Launch panel → Edit → Periodic Commands): lines sent once when Pyrodeck's console session to the launched server is ready, and lines sent every 1-1440 minutes while it runs, one at a time in order, one at random (never the same twice running), or all together. Each line is a `$` command or a `say` message of at most 200 characters (the console's `Say` limit); one round sends at most 5 lines, since the in-game chat shows only the last couple. They stop when the server stops or crashes and start over, start lines included, on the next launch or playlist restart. On a server Pyrodeck re-attaches to after its own restart they carry on without the start lines, and the respawn scaling first counts who is on with `$players`.
- **Team settings and the Hoard orb count per profile** (Launch panel → Edit → Teams and Hoard): allow team changes, auto balance, the four team names, and Hoard's orbs-to-score (1-12). They used to be console commands lost at every restart. DMFC reads one startup script, so Pyrodeck writes them into the Startup Commands file (`autoexec.dmfc`) at each launch and playlist restart as a block between `# pyrodeck: begin` and `# pyrodeck: end`, after the operator's own lines, which it never touches; with nothing set the block is removed. They apply before the first player joins. The open-source Hoard has no maximum-orbs command, so only the minimum is offered.
- **Launch options per profile** (Launch panel → Edit → Launch Options): bind address (`-useip`), game port (`-useport`), frame cap (`-framecap`), no pilot logos (`-nomultibmp`), GameSpy port and file (`-gamespyport`, `-gspyfile`), passed right after `-dedicated` on every launch and playlist restart. The bind address must be an IPv4 address (the engine parses it with `inet_addr`), and since the server then binds its console to that address too, Pyrodeck connects there. Saving a profile or a server config warns when another profile uses the same game, GameSpy or console port, or the console port is Pyrodeck's own or the mission host's.
- **Pyrodeck hosts mission downloads.** An optional second listener (Launch panel, Mission Downloads; off by default, port 3002) serves the server's custom missions over http, so a player who joins without the mission downloads it from the same machine. One click in the Config tab's mission panel points a mission's link at it, the panel shows whether each mission is hosted and the exact link, and **Test** fetches the mission through the public URL and compares it with the file on disk. The listener answers only `/missions/<file>.mn3`, never the retail missions and never the admin API, and starts or stops as soon as the setting is saved. `GET /api/launcher/status` reports its state.
- **Weekly schedule** per profile: start and stop windows by weekday and local time. A window's start launches the profile if nothing is running; its end stops the server once no human is on (asked with `$players`, bots excluded), or after a wait you set, with one warning in chat. The Launch panel shows the next scheduled action. `GET /api/schedule`; the windows are saved with the profile.
- **Email alerts** on server events (started, stopped, crashed, hung, relaunched, player kicked or banned, profanity ban, schedule actions) over SMTP, in a new Settings tab. Off by default; bursts are batched into one mail, at most one a minute; **Send test mail** checks the settings first. Uses `nodemailer`.
- **Process priority** for the game server (below normal to high), applied after every launch, playlist restart, scheduled start and relaunch, and to a running server when changed. A refused change (raising priority without privilege) is a warning, not a failure.
- **Update notice:** a banner when GitHub has a newer Pyrodeck release, checked at most once a day; never downloads anything; can be turned off.
- **Import a profile from a launch script** (`.bat`, `.cmd`, `.sh`): the `-dedicated` line is read the way the engine reads its command line, with a preview of the game directory, program and config before the profile is created. `-useip`, `-useport`, `-framecap`, `-nomultibmp`, `-gamespyport` and `-gspyfile` become the profile's Launch Options; other flags are kept on it as imported flags.
- **Player history.** Pyrodeck records who joined and left each server, with the slot and the player's address, and keeps a name-to-address index: 5,000 rows per server profile in `config/players/`. The address comes from one `$playerinfo` per new human session, never polled; on servers other than Matcen 0.9.3+, which never clear the text buffer that command writes into, at most 20 lookups per server run (the setting goes to 30), and none for a name containing `%`. A player who leaves during a level change without a leave line is closed out 120 s into the next level. API: `/api/players/history`, `/sessions` ("who was on"), `/addresses`, `/present`, `/settings`.
- **Bans that survive a restart.** The Ban button used DMFC's `$ban`, which the server forgets at every restart, playlist rotations included. Banning a player now says why in chat, waits two seconds, re-checks the slot, sends `$ban`, and adds the player's address to the engine's `netgames/hosts.deny` (and, if asked, the name to a stored name-ban list), then `$rehash`. The hosts.deny editor lists the file as the server reads it, flags lines the engine silently ignores (comments, trailing spaces, `/24`), takes addresses, `*` patterns and /8-/32 prefixes, keeps a reason and date per entry, and sends `$rehash` after each edit and at each level start. Banned names are kicked on join, with the reason said first. Pyrodeck edits the hosts.deny the server actually reads: the server's writable directory (`~/.local/share/Outrage Entertainment/Descent 3/netgames/` on Linux), learned from a launched server's log, or a path set by hand. API: `/api/bans`, `/api/bans/hosts`, `/api/bans/names`, `/api/bans/rehash`, `/api/players/kick`, `/api/players/ban`.
- **Join rules and a profanity monitor**, both off by default. Nickname rules kick a joining player whose name is empty, contains `%`, contains control characters or is shorter than a minimum, saying why first (D3Server3's INVALID/HACKED NICKNAME). The profanity monitor matches general chat against an editable word list (a short default list of plain profanity ships as data) and escalates per player: private warnings, then kicks, then a ban of the name and the address, with a cooldown so one burst counts once. API: `/api/players/rules`.
- **Players, Bans and Rules in the UI.** The Players tab gains a History view (joins and leaves, "who was on", name-to-address index) and is available without a connection; Kick and Ban ask for a reason. New Bans tab (hosts.deny editor, name bans, `$rehash`) and Rules tab (nickname rules, profanity monitor, address lookups).
- `docs/running-as-a-service.md`: running Pyrodeck under NSSM, `schtasks` or a systemd user service.

### Changed
- **Closing Pyrodeck no longer stops the game server**; stop it first if you want it down. On Linux and macOS the server is started through `sh` with SIGPIPE ignored, so its writes to a closed output pipe fail quietly instead of killing it.
- A server stopped by typing `quit` at its remote console now shows as stopped, not crashed.
- `config/pyrodeck.json` is written readable by its owner only, since it now holds the SMTP password.
- Joins, leaves, chat and level starts are read from Pyrodeck's console session (Connect mode included), the one source for the supervisor, history, rules, alerts and respawn scaling. A player who re-enters at a level start is not counted again.
- Mission links are capped at 86 characters instead of 95: the client copies "Downloading: <link>" into a 100-character buffer, so a longer link overflowed it. `https://` links now carry a warning (1999-era clients refuse them, current builds without TLS crash on them), and an upper-case `HTTP://` is refused.

### Fixed
- Stop never sent SIGKILL to a server that ignored SIGTERM: Node marks a child "killed" as soon as a signal is delivered, so the last step was always skipped. It now checks whether the process has exited.
- **Kick and Ban could hit the wrong player.** The Players tab sent `$kick`/`$ban` with the row's position in the `$scores` list, which is sorted by score, as if it were the player's slot. Pyrodeck now looks the slot up by name with `$players` and checks it again just before acting.
- **Startup Commands were never applied.** Pyrodeck saves them as `autoexec.dmfc` in the game directory, but DMFC only reads its own default file unless the server is started with `-autoexec`, and Pyrodeck never passed it. Each launch and playlist restart now passes `-autoexec <absolute path>` when the file exists, and nothing when it doesn't. A path longer than the 99 characters the engine keeps per argument is not passed; the console and the server log say so.
- Spec §1.3 credited D3Server3 with a profanity filter, email alerts, a Windows service mode and process priority control without saying which release. The audited 3.0.83 binary has none of them; they arrived from 3.0.84 to 3.1.9 (email through its event commands), and the paragraph now names the versions (`docs/D3SERVER3_AUDIT.md` §6).
- Playlist chat lines (the vote prompt, each vote, the result, the mission change) and the scheduled-stop warning carried mission labels and voters' names as typed. They now drop `%` (the server's console output treats it as a format directive), colons (the engine reads the text before one as a chat destination) and anything but printable ASCII (the vote result's em dash showed as junk in game).
- Spec §8.3 listed a `POST /api/command` route that never existed; console commands go over the WebSocket only.

## [0.4.20] - 2026-10-07

### Added
- **Mission download links.** A server offers players who join without its mission the `URL` lines inside the mission file, and most custom missions carry dead links from 1999. The Config tab's mission panel now shows a mission's links and can replace them with one working link; Pyrodeck rewrites the `.mn3` (checked as a real archive first, every other byte kept), keeps the untouched file as `<name>.mn3.pyrodeck-orig`, and restores it with one click. The server picks the new link up the next time it loads the mission.
- **Post-start settings** per server profile: server HUD names, kill message filter, and saving stats at level end and on disconnect. These can't go in `dedicated.cfg`, so Pyrodeck sends them over the console after every launch and playlist restart.
- Bots tab: a team choice when the server advertises `teams` and the current game has teams.
- Bug report issue form (`.github/ISSUE_TEMPLATE`).

### Changed
- **Playlist restarts are health-checked.** The restarted server must accept the console login and answer `$servercaps` within 120 s. A crash, a failed launch or a timeout retries once; if that fails too, the playlist pauses and the sidebar says why, with a Resume button, instead of rotating on behind a dead server.
- Synced to the Matcen fork's contract (`PYRODECK_CONTRACT.md`): `Name[BOT]` callsigns, `$addbot` with a team and its new success line, exact `$botmode` names, and `$botobj` printing to the console. The `$servercaps` parser keeps feature flags it doesn't know, including the fork's new `teams`, `squad_orders` and `population`. Spec v2.8.
- A refused or altered `$addbot` (server full, unknown ship, team out of range) now shows an error toast instead of appearing only in the console. Bot names are sent as one word of at most 14 characters, as the server expects.
- The Log Directory must be an absolute path; Pyrodeck creates the directory and the log file before each launch, playlist restarts included.

### Fixed
- A dead bot (`shields=-1`) vanished from the `$botstat` details.
- A playlist rotation whose profile config had no remote console stopped the server and never restarted it, without a message. It now pauses the playlist with that reason.
- A server log that stopped being written mid-run (deleted, moved, replaced) went unnoticed, and the one post-launch warning was a toast gone in five seconds. The log is now re-checked every 30 s and a failure stays in the Launch panel.
- Server unit tests ran twice locally (compiled copies in `dist/` were picked up too).

## [0.4.19] - 2026-09-26

### Fixed
- **Linux release binary never started the server.** The SEA packager injected the blob with `objcopy` but never flipped Node's SEA fuse, so the "binary" was a renamed `node` that exited silently; flipping the fuse alone then segfaulted, because an `objcopy` section isn't mapped the way Node reads the blob, and distro-packaged node binaries can't be injected at all. Packaging now downloads the official nodejs.org binary for the running Node version, verifies it against `SHASUMS256.txt` (the Windows download was previously unverified), and injects with a pinned `postject`. Both Linux and Windows (under Wine) artifacts verified to serve the API + SPA.
- **Release workflow failed on every run** ("No pnpm version is specified"). pnpm is now pinned via `packageManager`, CI builds on Node 24 from `.nvmrc` (Node 20 is EOL), actions moved to current majors, tests run before packaging, and a manual `workflow_dispatch` dry run builds artifacts without publishing.
- Release no longer depends on the SignPath signing job (signing is deferred), and the release notes no longer claim the Windows binary is signed.

### Changed
- **`$servercaps` probe survives slow level starts** (Matcen spec §3.3, 2026-09-20): a silent first probe no longer permanently means "vanilla". Pyrodeck re-probes in the background for ~30s and, if fork capabilities arrive, upgrades the session and re-enables fork features live, with no reconnect. Vanilla servers (which answer immediately) are unaffected.
- Command Reference `$nav` "Nav Set" takes the toggle name as free text; the fork's toggle table churns every build (Tier 3) and the old dropdown listed retired channels (`route`, `bnodes`, `softhop`).
- Spec synced to Matcen 0.9.15+ (probe timing, 0.9.11 removed-command list, `$nav` toggle churn).

### Security
- Dependency refresh: `fastify` 5.12, `@fastify/static` 10 (path-traversal/route-guard-bypass fixes), `@fastify/websocket` 11.3 (`ws` DoS fixes), plus minor bumps across client and server. `pnpm audit` goes from 72 advisories to 0. `shadcn` (a code-gen CLI) moved to devDependencies.

## [0.4.18] - 2026-07-18

### Fixed
- **Server profiles could not be edited or deleted while a server was running** — the profile selector and Edit button were hidden for the entire active session, and Delete only lived under Edit, so a running server made profile management unreachable. The selector and Edit now stay available; the live profile is marked `● running` in the picker and its own destructive actions are guarded (stop it first), while other profiles can be edited/deleted freely. The launcher now tracks which profile is live (`activeProfileId` in process status) to make this precise.
- Delete affordances made consistent and discoverable across the app: profile Delete is now a visible button instead of a buried link; saved-server delete gained an always-visible control (was hover-only, invisible on touch) plus an inline confirm; and Bots "Remove All" now confirms before firing. All four flows share one inline-confirm pattern.

### Security
- **Auth now fails closed for remote peers when no admin password is set.** Previously an instance bound to a non-localhost address with no password left the entire API/WebSocket open to the network (startup only warned). Localhost stays open for the zero-config dev workflow, but non-loopback peers are refused until a password is configured.
- Auth route matching is now boundary-aware, so a route like `/api/healthz` can no longer inherit `/api/health`'s auth bypass by prefix.

## [0.4.17] - 2026-07-12

### Added
- **Mission mode-compatibility scanning** — `Mn3Scanner` parses each `.mn3` (HOG2 header + embedded `.msn` keywords, a few KB per file) and computes per-game-mode support using the engine's own `MissionGetKeywords()` semantics; validated 1:1 against the Matcen fork's `mn3info.py` across a 111-mission library. Cached by mtime+size (full scan: 45ms cold, 7ms warm). Exposed via `GET /api/game-files/missions?details=1`
- Config tab mission picker: disables missions incompatible with the selected game type, shows details panel (display name, level count, mode badges with team capacity like `CTF·4T`), warns when the current pairing would fail to start
- Playlist validation against the profile's game type: activation rejected (400 with per-entry reasons) on definite mismatches; rotation re-validates and skips incompatible entries instead of restarting into a broken game; editor flags offending entries inline

## [0.4.16] - 2026-07-08

### Fixed
- Log viewer appeared to do nothing: the inline viewer rendered *below* a ~700px file list. Viewer now renders above the list and auto-scrolls into view when the fetch resolves

## [0.4.15] - 2026-07-08

### Fixed
- Bots tab intermittently vanished: the `$servercaps` probe used a 200ms first-response wait, which a freshly-started server (mid level-load) can miss entirely → empty parse → silent vanilla fallback. Transport now waits up to 5s for the *first* chunk while keeping 200ms inter-chunk silence, so normal commands stay fast

## [0.4.14] - 2026-07-02

### Added
- Matcen 0.9.5 `$nav` namespace in the command reference (toggle table, per-channel on/off, nav dump), replacing the retired `$terrainsteer`/`$navdump` buttons
- Per-log Delete with two-step confirm (active log of a running server refused server-side)

### Changed
- **Console performance overhaul** — D3 process output coalesced server-side on a 100ms tick (~9 WS messages/sec instead of one per pipe chunk; debug builds emit ~680 lines/sec), both consoles use xterm's WebGL renderer with DOM fallback, log viewer fetches only the last 256 KB (`?tail=1`) with a truncation banner
- Trailing process output flushed before state-change broadcasts so crash diagnostics render before the "crashed" badge

## [0.4.13] - 2026-06-17

### Added
- Auto-named per-launch logs (`<profile>-<timestamp>.log`) in a configurable log directory (default: next to the D3 executable), with pre-launch writability validation and a post-launch write-check warning
- Logs panel + API: list, view, download
- Tab overflow: Launch-only management tabs (Config, Playlists, Logs) collapse into a "More" dropdown

(0.4.12 was skipped — version realignment.)

## [0.4.11] - 2026-06-13

### Fixed
- **Stop crashing dedicated servers via `$netgameinfo`** — the engine never flushes its 16 KB text buffer headless, and `$netgameinfo` writes ~17 lines per call that are never cleared; polling overflowed and aborted the server after ~30 calls. Retail-D3 engine bug, so the fix is entirely Pyrodeck-side: all polling removed. Client queries once per connection (+ manual refresh) and derives the countdown locally; server queries once per activation and once per rotation. ~120 calls/hour → ~1 per connection

## [0.4.10] - 2026-06-13

### Security / Hardening
- Config filenames guarded against path traversal; playlist and saved-server request bodies validated
- Env-gated network defaults: `trustProxy` opt-in, same-origin CORS, localhost-only first-run setup
- `parseTimeLeft` handles `H:MM:SS`; color-code stripping survives TCP chunk boundaries
- ESLint flat config added; `pnpm lint` runs clean; hermetic timer tests

## [0.4.9] - 2026-06-13

### Fixed
- Time Left countdown resets on `$warp`, `$endlevel`, and rotations instead of running off a stale anchor; `level_changed` broadcast (from D3's "Opening level" stdout) drops the old timer the instant a new level loads
- Playlist line matching uses `includes()` — D3 concatenates debug text onto "Mission over."/"Ending level." lines, so the old equality check never matched real output; chat lines handled first so a player typing "Mission over." can't restart the server
- Vote ties and zero-vote rounds resolve to the first option; drift correction survives rotations/reconnects
- WebSocket keep-alive sends a browser-visible JSON ping and culls dead sockets (fixes iOS Safari reconnect)
- Server panel shows the actual loaded level, not just the mission file

## [0.4.8] - 2026-06-08

### Changed
- Matcen 0.9.1 sync (verified against engine emit code): two-line `$botstat` handled, `$navdump`/`$terrainsteer` added to Bot Debug
- Toolchain: Node 24 / pnpm 11 migration (`.nvmrc`, `allowBuilds`)

## [0.4.7] - 2026-05-17

### Added
- Real-time bot stats on the Bots tab: `$botstat all` polled every 2.5s for live State/Shields/Target columns, expandable rows with Role/Lean/Speed/Slot, color-coded shields

## [0.4.6] - 2026-05-17

### Changed
- Matcen 0.8.16 compatibility; `$botstat` parser gains role/lean fields

## [0.4.5] - 2026-05-02

### Fixed
- Playlist rotation triggers on "Mission over." instead of "Ending level." (the latter fires on mid-mission level transitions and caused premature rotation)

### Added
- `$botmode` and `$botobj` in the command drawer (Matcen 0.8.11)

## [0.4.4] - 2026-04-29

### Changed
- Guided and 4PackGuided disabled by default in new server profiles (community-standard anarchy rules; research in `docs/`)

## [0.4.3] - 2026-04-28

### Added
- Descent 2 font theming across the UI (DESCLOGO/DESCMENU/DESCSCOR community fonts; inputs, console, and numeric data retain Geist)

## [0.4.2] - 2026-04-25

### Added
- First-run auth setup page: prompts for an admin password when none is configured; scrypt-hashed (salted, timing-safe) in `config/pyrodeck.json`; `PYRODECK_ADMIN_PASSWORD` takes precedence; setup endpoint replay-proof

## [0.4.1] - 2026-04-19

### Added
- Delete profile UI with two-step confirmation; per-profile `gamePath`/`executablePath`

### Fixed
- ProfileEditor loading files from global gamePath instead of the profile's own
- TCP probe ends with FIN instead of RST so D3 handles the probe disconnect cleanly before auto-connect

## [0.4.0] - 2026-04-19

### Added
- **Playlist system** — Sequential, shuffle, and weighted rotation modes; mission voting via in-game `say` chat; countdown announces at 5m/2m/1m/30s/10s before round end
- **Responsive layout** — Three-tier adaptive UI: desktop (3-column), tablet (compact top bar + inline server panel), phone (single-column with slide-out sheets for left and right panels)
- **Admin authentication** — Single-password gate via `PYRODECK_ADMIN_PASSWORD` env var; signed HttpOnly `SameSite=Strict` cookie; in-memory rate limiting (5 attempts/15 min/IP); skipped automatically on localhost if unset; warns on non-loopback bind without a password
- **Server packaging** — Node SEA single-binary build pipeline (`pnpm package:server` → `dist-server/pyrodeck-server`); Tauri 2 app-mode wrapper scaffold (`src-tauri/`) for native window + sidecar deployment
- **`/api/version`** — Returns `{ version: "0.4.0" }` for programmatic version checks
- Version displayed in app header (`v0.4.0`)

### Changed
- Timer countdown runs client-side between `$netgameinfo` polls; no more stale displays
- Playlist panel vote countdown uses local tick rather than server epoch polling
- Logout button hidden in dev mode (when no password is configured)
- Server logs suppressed in sidecar mode (Tauri) to avoid polluting stdout port-announcement line

### Fixed
- `parseInt` vs `Number()` in time-left parsing — D3 outputs `"4:58 minutes"`, `Number("58 minutes")` is `NaN`; `parseInt` handles it correctly
- Duplicate timer: time-remaining was visible in both server sidebar and playlist panel; removed the playlist panel instance

## [0.3.x] - prior

See git history (`git log --oneline`).
