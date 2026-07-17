# Changelog

All notable changes to D3 Pyrodeck are documented here.

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
