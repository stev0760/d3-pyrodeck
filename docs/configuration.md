# Configuration and security

How access to the panel is controlled, and every environment variable Pyrodeck reads. Most settings are made in the
panel and kept in the config directory; the variables below are for the machine-level ones.

## Security

An admin password is required to access the web panel from non-localhost connections. You can set one via:

1. **First-run setup** — the web UI prompts for a password on first launch (stored as a scrypt hash in `config/pyrodeck.json`)
2. **Environment variable** — set `PYRODECK_ADMIN_PASSWORD` (takes precedence over the config file)

With no admin password set, the server serves localhost only: requests from non-loopback peers are refused (and a startup warning explains why) until a password is configured. "Localhost" means a browser connected straight to Pyrodeck's port from the same machine, asking for `localhost` or `127.0.0.1`: a request that came through a reverse proxy (it carries `X-Forwarded-For`, `Forwarded`, `X-Real-IP` or another forwarding header) is never local, and neither is a page whose own DNS name points at 127.0.0.1. Passwords are verified using scrypt with a random salt and timing-safe comparison. Each login gets a random 32-byte session id, kept in Pyrodeck's memory and carried in a signed HttpOnly cookie with `SameSite=Strict`, marked `Secure` when the browser came over HTTPS; a new login always gets a new id and ends the one the browser carried. A session ends at logout, at **Log out all sessions** (Settings tab), when the admin password is set, 12 hours after login (`PYRODECK_SESSION_TTL_HOURS`) or after 120 minutes without a request (`PYRODECK_SESSION_IDLE_MINUTES`), and the console WebSockets it opened close with it. An open panel polls the server, so it keeps its session in use: the idle timeout ends the sessions of closed or sleeping browsers, and the 12-hour limit ends every session. Sessions are not saved, so restarting Pyrodeck logs everyone out. Browser requests whose `Origin` names another host are refused, the WebSocket included. Login attempts are rate-limited to 5 per client address per 15 minutes (per /64 for IPv6). Web-based first-run setup is allowed only from localhost (so nobody can claim the admin password on a freshly-exposed instance); set `PYRODECK_ALLOW_REMOTE_SETUP=1` to permit it from a remote browser.

The game server Pyrodeck launches does not inherit Pyrodeck's environment. It gets `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `TMPDIR`/`TMP`/`TEMP`, `TZ`, `LANG`, `LANGUAGE`, `LC_*`, `XDG_*`, `SDL_*`, `D3_*` and `LD_LIBRARY_PATH` (on Windows also the system variables such as `SystemRoot` and `APPDATA`), plus `SDL_VIDEODRIVER=dummy` unless set, and never a `PYRODECK_*` variable: the admin password, the session secret and anything else in the service's environment stay with Pyrodeck.

The mission download listener (off by default) is public by design and needs no login, but serves nothing except the missions in the game path's `missions/` directory, never the ones that ship with the game; it runs on its own port, not through the admin panel.

For internet-facing deployments, put Pyrodeck behind a reverse proxy (nginx, Caddy) with HTTPS, leave it on `127.0.0.1` (the default), and set `PYRODECK_TRUST_PROXY=1` so rate-limiting, the `Secure` cookie and logging see the real client from `X-Forwarded-For` and `X-Forwarded-Proto`. It trusts those headers only from a proxy on the same machine; the client's address is the last one the proxy added, so a client cannot spoof it. Set the admin password before the proxy goes live. [behind-a-reverse-proxy.md](behind-a-reverse-proxy.md) has the nginx server block, certbot, the firewall and the checks. Keep the game's remote console off the network too: `AllowRemoteConsole=0` (a server Pyrodeck launches is reached on 127.0.0.1).

## Environment variables

| Variable | Purpose |
|---|---|
| `PYRODECK_ADMIN_PASSWORD` | Admin password (plaintext; takes precedence over the config hash) |
| `PYRODECK_TRUST_PROXY` | Unset: `X-Forwarded-*` ignored. `1`: trust it from a proxy on this machine (127.0.0.0/8, ::1) only. Or a comma-separated list of the proxy's addresses or CIDR blocks. Anything else stops Pyrodeck at startup |
| `PYRODECK_CORS_ORIGIN` | Comma-separated origin allowlist; CORS is off (same-origin only) by default |
| `PYRODECK_ALLOW_REMOTE_SETUP` | `1` to allow first-run password setup from a non-local browser |
| `PYRODECK_HOST` / `PYRODECK_PORT` | Bind address/port (default `127.0.0.1:3001`, this machine only). Set `PYRODECK_HOST=0.0.0.0` to serve a LAN directly |
| `PYRODECK_SESSION_TTL_HOURS` | A session ends this long after login, however busy (default `12`; decimals allowed) |
| `PYRODECK_SESSION_IDLE_MINUTES` | A session ends after this long without a request (default `120`) |
| `PYRODECK_LOG_RETENTION_DAYS` | Delete Pyrodeck's game-server logs last written more than this many days ago (default `0` = never; `30` recommended for a public server). Wins over the Logs tab |
| `PYRODECK_LOG_MAX_MB` | Then delete the oldest until Pyrodeck's logs take at most this many MB (default `0` = no cap; `2048` recommended). Wins over the Logs tab |
| `PYRODECK_LOG_COMPRESS` | `1` gzips closed logs to `.log.gz`, `0` leaves them as they are (default: the Logs tab's setting, off; `1` recommended). Wins over the Logs tab |
| `PYRODECK_AUTOSTART_PROFILE` | The profile to launch when Pyrodeck starts, by its exact name (or id); unset or blank leaves it to **Start when Pyrodeck starts** in the profile, which it wins over and locks. Default: no autostart. An unknown name is logged as an error and starts nothing |
| `PYRODECK_AUTOSTART_PROFILES` | Several profiles to launch when Pyrodeck starts, by name or id, separated by commas. Added to `PYRODECK_AUTOSTART_PROFILE`; both win over the profiles' own setting |
| `PYRODECK_CONFIG_DIR` | The directory Pyrodeck keeps its own files in (default `./config`, relative to the directory it is started from) |
| `PYRODECK_SESSION_SECRET` | The secret that signs session cookies. Unset: Pyrodeck creates one and keeps it in `session-secret` in the config directory |
| `PYRODECK_STATIC_DIR` | Where the panel's web files are. Unset: the `resources` folder beside the program |
