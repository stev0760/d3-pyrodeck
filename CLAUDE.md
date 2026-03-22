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
- Web admin auth is currently disabled — D3 console password is sufficient for dev

## Matcen Fork Source

The D3 engine fork source is at `/home/steve/Projects/Descent3-mulitplayer-bots-fork/Descent3`. Useful for tracing D3 server behavior, command routing, and DMFC internals.

## Guidelines

- Start simple, prove it works, add complexity later
- Don't add app-level auth or extra abstraction until core functionality is solid
- Output D3 server logs to project root for easy analysis (gitignored via `*.log`)
- Test with empty server + add bots from web panel, not chaotic preset rosters
- The spec (`D3_PYRODECK_SPEC.md`) defines what to build; `PLAN.md` tracks progress; `DEVLOG.md` (gitignored) is the working journal
- **Keep `README.md` up to date** — update the current status, working features, and known limitations whenever significant changes land
