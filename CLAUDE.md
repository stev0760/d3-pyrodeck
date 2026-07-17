# D3 Pyrodeck

Web-based admin panel for Descent 3 dedicated servers. Companion project to the Matcen fork (`stev0760/Descent3`, branch `feature/multiplayer-bots`).

## Project Structure

pnpm monorepo:
- `packages/server` — Fastify + TypeScript backend, telnet transport, parser framework
- `packages/client` — React 19 + Vite 8 + TailwindCSS v4 frontend

## Dev Environment

- **Start backend:** `cd packages/server && pnpm dev` (port 3001)
- **Start frontend:** `cd packages/client && pnpm dev` (port 5173, proxies to 3001)
- **Test server:** D3 dedicated on localhost:2092, password "test"
- **D3 server logs:** Output to project root as `*.log` (gitignored)

## Key Architecture

- D3 "telnet" is plain TCP, not actual telnet IAC — `TelnetConnection.ts` is the core transport
- Commands are queued and executed serially with 200ms silence-based response collection
- D3 color codes (`\x01` + 3 RGB bytes) must be stripped from raw Buffer before UTF-8 conversion
- Auth: send password once after seeing "password" prompt, wait 1s — D3 closes on bad password
- `$` commands have two layers in D3:
  - **Engine layer** (bot commands): `$addbot`, `$removebot`, `$botlist`, `$servercaps` — always work from telnet
  - **DMFC layer** (game commands): `$kick`, `$ban`, `$scores`, `$endlevel` — go through game DLL
- `$kick`/`$ban` don't work on bots via DMFC (`CheckPlayerNum` rejects synthetic players). Use `$removebot` for bots.
- Web admin auth exists (scrypt hash + cookie session) but is skipped automatically on localhost when no password is set — dev workflow needs no login

## UI Testing Pipeline

Playwright MCP is configured for automated browser testing. Use it to verify UI changes
instead of asking for manual screenshots.

**Setup:** `claude mcp add playwright -- npx @playwright/mcp@latest --browser chromium`
MCP tools load at session start — tools are available as `mcp__playwright__browser_*`.

**Workflow:**
1. Start dev servers: `pnpm dev` from project root (both client + server in parallel)
2. Navigate: `browser_navigate` to `http://localhost:5173`
3. Inspect: `browser_snapshot` for accessibility tree (use for finding element refs before clicking)
4. Interact: `browser_click`, `browser_type`, `browser_fill_form` using `ref=` from snapshot
5. Verify: `browser_take_screenshot` to visually confirm state — save to named files for reference

**Tips:**
- Always `browser_snapshot` before clicking — refs change between page states
- Screenshots are expensive on context (use sparingly, prefer snapshots for logic)
- Save screenshots to descriptive filenames (`test-01-initial-load.png`) for easy reference
- The `depth` parameter on `browser_snapshot` can trim large trees
- `.playwright-mcp/` and `*.png` are gitignored

## Guidelines

- Start simple, prove it works, add complexity later
- Don't add extra abstraction until core functionality is solid
- Output D3 server logs to project root for easy analysis (gitignored via `*.log`)
- Test with empty server + add bots from web panel, not chaotic preset rosters
- The spec (`D3_PYRODECK_SPEC.md`) defines what to build; `PLAN.md` tracks progress; `DEVLOG.md` (gitignored) is the working journal
- **Keep `README.md` up to date** — update the current status, working features, and known limitations whenever significant changes land
