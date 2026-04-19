# Changelog

All notable changes to D3 Pyrodeck are documented here.

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
