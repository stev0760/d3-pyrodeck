# Changelog

All notable changes to D3 Pyrodeck are documented here.

## [Unreleased]

### Added
- **Pyrodeck hosts mission downloads.** An optional second listener (Launch panel, Mission Downloads; off by default, port 3002) serves the server's custom missions over http, so a player who joins without the mission downloads it from the same machine. One click in the Config tab's mission panel points a mission's link at it, the panel shows whether each mission is hosted and the exact link, and **Test** fetches the mission through the public URL and compares it with the file on disk. The listener answers only `/missions/<file>.mn3`, never the retail missions and never the admin API, and starts or stops as soon as the setting is saved. `GET /api/launcher/status` reports its state.

- **Player history.** Pyrodeck records who joined and left each server, with the slot and the player's address, and keeps a name-to-address index: 5,000 rows per server profile in `config/players/`. The address comes from one `$playerinfo` per new human session, never polled; on servers other than Matcen 0.9.3+, which never clear the text buffer that command writes into, at most 20 lookups per server run (the setting goes to 30), and none for a name containing `%`. A player who leaves during a level change without a leave line is closed out 120 s into the next level. API: `/api/players/history`, `/sessions` ("who was on"), `/addresses`, `/present`, `/settings`.

- **Bans that survive a restart.** The Ban button used DMFC's `$ban`, which the server forgets at every restart, playlist rotations included. Banning a player now says why in chat, waits two seconds, re-checks the slot, sends `$ban`, and adds the player's address to the engine's `netgames/hosts.deny` (and, if asked, the name to a stored name-ban list), then `$rehash`. The hosts.deny editor lists the file as the server reads it, flags lines the engine silently ignores (comments, trailing spaces, `/24`), takes addresses, `*` patterns and /8-/32 prefixes, keeps a reason and date per entry, and sends `$rehash` after each edit and at each level start. Banned names are kicked on join, with the reason said first. Pyrodeck edits the hosts.deny the server actually reads: the server's writable directory (`~/.local/share/Outrage Entertainment/Descent 3/netgames/` on Linux), learned from a launched server's log, or a path set by hand. API: `/api/bans`, `/api/bans/hosts`, `/api/bans/names`, `/api/bans/rehash`, `/api/players/kick`, `/api/players/ban`.

- **Join rules and a profanity monitor**, both off by default. Nickname rules kick a joining player whose name is empty, contains `%`, contains control characters or is shorter than a minimum, saying why first (D3Server3's INVALID/HACKED NICKNAME). The profanity monitor matches general chat against an editable word list (a short default list of plain profanity ships as data) and escalates per player: private warnings, then kicks, then a ban of the name and the address, with a cooldown so one burst counts once. API: `/api/players/rules`.

### Changed
- Mission links are capped at 86 characters instead of 95: the client copies "Downloading: <link>" into a 100-character buffer, so a longer link overflowed it. `https://` links now carry a warning (1999-era clients refuse them, current builds without TLS crash on them), and an upper-case `HTTP://` is refused.

### Fixed
- **Startup Commands were never applied.** Pyrodeck saves them as `autoexec.dmfc` in the game directory, but DMFC only reads its own default file unless the server is started with `-autoexec`, and Pyrodeck never passed it. Each launch and playlist restart now passes `-autoexec <absolute path>` when the file exists, and nothing when it doesn't. A path longer than the 99 characters the engine keeps per argument is not passed; the console and the server log say so.
- Spec §1.3 credited D3Server3 with a profanity filter, email alerts, a Windows service mode and process priority control. The audited 3.0.83 binary has none of them; the paragraph now lists what the audit found.

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
