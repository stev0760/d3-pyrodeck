# Operations

Running servers day to day: logs, the settings that keep an unattended server going, the supervisor, and bans and
join rules.

## Logs

- Each launch writes a timestamped log file (for example `ctf-2026-11-15T20-25-32.log`) — no hand-edited paths
- Log directory is configurable; defaults to the directory containing the D3 executable
- Logs panel lists runs (newest first) with in-browser view, download, and delete (two-step confirm; the active log of a running server can't be deleted)
- The in-browser viewer fetches only the last 256 KB of large logs; Download always saves the complete file
- Retention, opt-in (Logs tab, or `PYRODECK_LOG_RETENTION_DAYS`, `PYRODECK_LOG_MAX_MB` and `PYRODECK_LOG_COMPRESS`, which win). Off by default, so Pyrodeck keeps every log as written. Once set, at startup, every hour and on save, Pyrodeck gzips closed logs (renamed to `.log.gz`, same modification time), deletes its logs last written more than the set number of days ago, then the oldest until they fit in the size cap; 0 turns a limit off. Recommended for a public server: 30 days, 2048 MB, compression on. Only files named like Pyrodeck's logs are touched, never other files in the directory (which may be the game folder), symlinks or directories; the running server's log and anything written in the last ten minutes are left alone. Each compression and deletion is logged at info level. While retention is off, Pyrodeck's log and the Logs tab warn once its logs take more than 1 GB
- Compressed logs are listed with the rest: View decompresses them, Download saves the `.log.gz`
- The Log Directory must be an absolute path; before each launch Pyrodeck creates the directory and the log file itself and refuses to start if it can't
- After launch the log is checked (about 8 s in, then every 30 s): a log that stays empty, errors, or is deleted, moved or replaced mid-run raises an error and stays flagged in the Launch panel until the next launch

## Unattended settings

Settings that keep an unattended server running. The schedule lives in each profile; the rest are in the **Settings**
tab.

- **Weekly schedule.** Edit a profile and add windows (day, start, end, in the Pyrodeck machine's local time; an end at
  or before the start runs past midnight). At a window's start Pyrodeck launches the profile's server if it is not
  running. At its end it stops that server as soon as no player is on (bots don't count, Pyrodeck asks with
  `$players`), and after the wait you set at the latest; players get one warning in chat. A server you stop by hand
  during a window stays stopped until the next window. The Launch panel shows the next scheduled start or stop. A
  start that would clash with another running server (see [Several servers](several-servers.md)) is skipped, with a
  toast.
- **Email alerts.** SMTP host, port, security (STARTTLS, TLS or none), login, From, up to ten recipients, and a
  checklist: server started, stopped, crashed, hung or relaunched; player kicked or banned; profanity bans; schedule
  actions. Off by default. Events that arrive together go out in one mail, at most one mail a minute. **Send test mail**
  tries the settings on screen before you save them. The SMTP password is kept in `config/pyrodeck.json` (readable by
  its owner only) and never sent back to the browser.
- **Process priority.** Below normal, normal, above normal or high, applied to the game server after every launch,
  playlist restart, scheduled start and relaunch. On Linux, lowering needs no privilege and raising needs root or
  `CAP_SYS_NICE`; a refused change is a warning, and the server keeps running. On Windows these are the priority
  classes of the same names.
- **Update notice.** Pyrodeck asks GitHub once a day for the latest release and shows a banner with a link when it is
  newer. It never downloads anything. A failed check (offline, rate limit) shows nothing. Turn it off in Settings.
- **Import from a launch script.** In the Launch panel, **Import script**: paste or pick the batch file or shell script
  that ran `Descent3 -dedicated <cfg> ...`. Pyrodeck reads its flags the way the engine does (any case, `-`, `--` or
  `+`; the first one wins), shows where it found the game, program and config, and creates a profile linked to that
  config. The bind address, game and GameSpy ports, frame cap, GameSpy file and `-nomultibmp` become the profile's
  Launch Options; other flags are kept on the profile as "imported flags" for reference. The config must already be in
  the game directory.
- **Sessions.** The Settings tab lists the browsers logged in (address, browser, login and last use) and logs them all
  out with one button, this one included. Every open console of those sessions closes at once.
- **Autostart.** Edit a profile and tick **Start when Pyrodeck starts** (several profiles can), or set
  `PYRODECK_AUTOSTART_PROFILE` to a profile's name, or `PYRODECK_AUTOSTART_PROFILES` to several separated by commas
  (they win, and lock the box). Pyrodeck then launches those profiles each time it starts, once it has re-attached to
  the servers that kept running: a server still running is left alone. Each launch is its Start button's, so an
  active playlist carries on from the mission its last rotation wrote into the config, and a paused one stays paused.
  The change applies at the next start of Pyrodeck. The Launch panel's **Autostart** block lists the profiles and
  shows what happened to the selected server's. An unknown profile name is logged as an error; the others start.
- **Running as a service.** [running-as-a-service.md](running-as-a-service.md): NSSM, `schtasks` and a
  systemd user unit, with the working directory and log location each one needs. With autostart, the machine can
  reboot for updates unattended.

## Keeping a server up

In Launch mode Pyrodeck watches each server it started:

- **Crash:** when the game exits without being asked to, Pyrodeck starts it again with the same profile after 5 s. Each further crash doubles the wait, up to 2 minutes. After seven crashes in 30 minutes it stops trying and says so; the next launch by hand starts the count over.
- **Hang:** when the server's console has been quiet for 59 s, Pyrodeck sends `$players`. If nothing at all comes back by 120 s, it kills the server and starts it again. A level that is loading gets 2 minutes before this applies.
- **Restart when empty** (off by default): once the server has run longer than a set number of hours, Pyrodeck restarts it when no human is on it and the last one left at least 130 s ago. Bots don't count. It asks the server with `$players` before restarting, so a player it missed is never kicked.

A server you stop (Stop button, a playlist rotation, or `quit` typed at its console) stays down. A crash in the middle of a playlist restart is handled by the playlist's own retry.

The Launch panel's **Supervisor** block shows what it is doing (relaunches so far, the last crash and hang, uptime, players, how long the console has been quiet, why an empty restart has not happened yet) and, when you open it, the three switches and their limits. A pending relaunch has a **Cancel** button for a crashed server you want left down. Pyrodeck's own log gets one `[Server]` line per start, stop, crash, hang, level start, join and leave.

**After a reboot**, no server survives to re-attach to. With autostart set (see [Operations](operations.md)), Pyrodeck launches the profile when it starts. A crash-loop guard watches that start: a launch that fails, or a server that exits within 60 s of starting, is a failure. Autostart retries a failed launch after 5, 10, 20 and 40 s, the supervisor relaunches a server that exited, and after 5 failures in a row both stop, with the reason in Pyrodeck's log and in the Launch panel. A server that stays up for 60 s, or a start or stop by anyone else, ends the guard.

**Pyrodeck restarts do not stop the server.** A server Pyrodeck launched keeps running when Pyrodeck stops, crashes or is upgraded, and the next Pyrodeck re-attaches to it: status, console, Stop and the supervisor work again. An active playlist carries on from the mission the server runs; a mission change that was under way when Pyrodeck stopped is finished once it has logged in again, or, if the server had already quit for it, by launching it at startup. Closing Pyrodeck therefore leaves the server up; stop it first if you want it down. After a re-attach the server's own output is not captured any more (it went to the Pyrodeck that started it), so the Output tab and the log file stop at the restart; the console still shows everything the server prints there.

## Bans and join rules

**Bans that survive a restart.** The console's `$ban` lasts until the server restarts (a playlist rotation is a restart). Bans that last are the engine's `netgames/hosts.deny`, which the server reads at each game start and on `$rehash`:

- **Bans tab → Address bans.** Add an address (`203.0.113.9`), a pattern (`203.0.113.*`) or a prefix (`203.0.113.0/24`, `/8`, `/16`, `/24` or `/32`; the server matches whole parts only), with a reason. Pyrodeck writes the line exactly as the server reads it, keeps the reason and date itself (the file has no room for them), and sends `$rehash` after every change and, by default, at every level start. Lines the server silently ignores (a comment, a trailing space, a `/24` typed by hand) are listed with the reason.
- **Where the file is.** The server reads `netgames/hosts.deny` in its writable directory: on Linux `~/.local/share/Outrage Entertainment/Descent 3/`, on Windows `%APPDATA%\Outrage Entertainment\Descent 3\`. Pyrodeck uses the directory a launched server reports in its log, or a path you set; retail 1.4 servers read the file in their install directory. The file is on the server's machine, so in Connect mode to another machine the editor does not apply to that server.
- **Name bans.** The game has no name ban. Pyrodeck kicks a joining player whose name matches the list (any case; `Name*` matches every name starting with `Name`), saying why first. Names are easy to borrow, so ban the address too where you can.
- **Ban from the Players tab** says the reason, waits two seconds, re-checks the slot, sends `$ban`, adds the player's address to hosts.deny (on by default) and, if ticked, the name to the list.

**Addresses.** Pyrodeck learns a joining player's address with one `$playerinfo` per new session, never polled. On servers other than Matcen 0.9.3+ that command fills a buffer the server never empties (about 40 queries crash it), so Pyrodeck sends at most 20 per server run there (Rules tab; up to 30). Names containing `%` are never looked up.

**Rules tab** (both off by default):

- **Nickname rules**: kick a joining player whose name is empty, contains `%`, contains control characters, or is shorter than a minimum, with the reason said first.
- **Profanity monitor**: watches general chat (team and private chat never reach the server console) for an editable word list; a short default list of plain profanity ships with Pyrodeck. Per player and server run: private warnings, then kicks, then a ban of the name and address, with a cooldown so one burst of lines counts once. A chat line carries the name the sender's game claims.
