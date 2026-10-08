# Running Pyrodeck behind a reverse proxy

This is the setup for a server on the public internet: one machine (a small VPS is enough) running Pyrodeck as a
service, the game server as Pyrodeck's child process, and nginx in front with a Let's Encrypt certificate. You log
in to the panel from anywhere over HTTPS. Nothing else of Pyrodeck's is reachable from outside.

The examples use `panel.example.com` for the panel's host name and `203.0.113.10` for the machine's public address.
Replace both. The commands are for Ubuntu LTS. Other distributions differ only in package names.

## Order of steps

1. Install Pyrodeck as a service ([running-as-a-service.md](running-as-a-service.md)) with the environment below.
2. **Set the admin password before nginx is reachable**, in one of two ways:
   - `PYRODECK_ADMIN_PASSWORD` in the unit file, or in an environment file it reads (mode 600).
   - Once from a browser on your own computer, through an SSH tunnel to Pyrodeck's own port:

     ```bash
     ssh -L 3001:127.0.0.1:3001 you@203.0.113.10
     ```

     then open `http://localhost:3001` and set the password there.

   Pyrodeck refuses first-run setup through the proxy, but until a password exists the panel cannot be used through
   it either.
3. Set up the firewall.
4. Install nginx and the certificate.
5. Run the checks at the end of this page.

## Pyrodeck's environment

```ini
Environment=PYRODECK_PORT=3001
Environment=PYRODECK_TRUST_PROXY=1
Environment=PYRODECK_SESSION_TTL_HOURS=12
Environment=PYRODECK_SESSION_IDLE_MINUTES=120
Environment=PYRODECK_LOG_RETENTION_DAYS=30
Environment=PYRODECK_LOG_MAX_MB=2048
Environment=PYRODECK_LOG_COMPRESS=1
Environment="PYRODECK_AUTOSTART_PROFILE=Public CTF"
```

- Pyrodeck listens on 127.0.0.1 unless `PYRODECK_HOST` says otherwise (the default since 0.5.2), so its port is off
  the network and browsers reach it only through nginx. Leave `PYRODECK_HOST` unset. At startup the log says
  `Listening on 127.0.0.1 only`.
- `PYRODECK_TRUST_PROXY=1` trusts `X-Forwarded-For` and `X-Forwarded-Proto` from a proxy on this machine
  (127.0.0.0/8 and ::1) and from nowhere else. A proxy on another machine is named by its address instead:
  `PYRODECK_TRUST_PROXY=10.0.0.5`, or a list of addresses and CIDR blocks (`10.0.0.0/24,fd00::/8`). Any other value
  stops Pyrodeck at startup with an error. With a proxy on another machine, Pyrodeck must also listen where that
  proxy reaches it: set `PYRODECK_HOST` to this machine's address on the private network.
- A login session ends 12 hours after login or after 120 minutes without a request (the defaults, set here so they
  are visible).
- Log retention is off unless set. These values gzip closed game-server logs to `.log.gz`, delete Pyrodeck's logs
  last written more than 30 days ago, then the oldest beyond 2048 MB in total; nothing else in the Log Directory is
  touched. A game server writes 12-28 MB an hour.
- `PYRODECK_AUTOSTART_PROFILE` launches the named profile whenever Pyrodeck starts, so the game comes back by itself
  after the VPS reboots for updates. A crash-loop guard stops after 5 failed starts in a row
  ([running-as-a-service.md](running-as-a-service.md#after-a-reboot)).
- None of these reach the game server: Pyrodeck starts it with a short list of variables (`PATH`, `HOME`, the
  locale and the like) and never a `PYRODECK_*` one, so the admin password stays with Pyrodeck.

At startup Pyrodeck's log says `Trusting X-Forwarded-For and X-Forwarded-Proto from: loopback`. It warns when
`PYRODECK_TRUST_PROXY` is set but `PYRODECK_HOST` is a public address, when no admin password is set, and, the first
time a proxied request arrives, when `PYRODECK_TRUST_PROXY` is not set.

### What Pyrodeck reads from a proxied request

- **The client's address** is the right-most `X-Forwarded-For` entry that is not the trusted proxy: the address
  nginx appended. Whatever a client writes into its own `X-Forwarded-For` sits further left and is ignored, so
  sending `X-Forwarded-For: 127.0.0.1` does not make a browser local. The login rate limit (5 attempts per 15
  minutes) counts per client address, and an IPv6 client's whole /64 counts as one client.
- **Local access** (the open API while no password is set, and first-run setup) is granted only to a browser that
  connects to Pyrodeck's own port from this machine, asking for `localhost` or `127.0.0.1`. A request carrying
  `X-Forwarded-For`, `X-Forwarded-Host`, `X-Forwarded-Proto`, `Forwarded` or `X-Real-IP` is never local, whether or
  not the proxy is trusted.
- **The session cookie** is marked `Secure` when the browser reached nginx over HTTPS (`X-Forwarded-Proto: https`).
  It stays usable on plain-http localhost.
- **Browser requests from another site** are refused with 403: a request whose `Origin` names a different host from
  its `Host` header. nginx must pass the browser's `Host` header on (`proxy_set_header Host $host`). Without it,
  Pyrodeck refuses every login and WebSocket, and the error says so.

Without `PYRODECK_TRUST_PROXY`, every request through nginx comes from 127.0.0.1: nothing proxied is local, which is
safe, but all clients share one login rate limit (one attacker can lock you out) and the cookie is never `Secure`.

## nginx

```bash
sudo apt install nginx certbot python3-certbot-nginx
```

Create `/etc/nginx/sites-available/pyrodeck`:

```nginx
# Ask the upstream to upgrade only when the browser asked for a WebSocket.
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 80;
    listen [::]:80;
    server_name panel.example.com;

    proxy_http_version 1.1;
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Host  $host;
    proxy_set_header Upgrade           $http_upgrade;
    proxy_set_header Connection        $connection_upgrade;

    location / {
        proxy_pass http://127.0.0.1:3001;
    }

    # The console WebSocket. Pyrodeck pings it every 15 s; the long timeouts
    # keep a quiet session from being cut if a ping is ever late.
    location = /ws {
        proxy_pass http://127.0.0.1:3001;
        proxy_read_timeout 1h;
        proxy_send_timeout 1h;
    }
}
```

`$proxy_add_x_forwarded_for` appends the client's address to whatever `X-Forwarded-For` the client sent. That is safe
here because Pyrodeck reads only the right-most entry nginx added. The `proxy_set_header` lines sit at the server
level so both locations inherit them. A location that sets any header of its own inherits none of them.

```bash
sudo ln -s /etc/nginx/sites-available/pyrodeck /etc/nginx/sites-enabled/
sudo rm /etc/nginx/sites-enabled/default    # optional: the stock welcome page
sudo nginx -t && sudo systemctl reload nginx
```

### The certificate

Point `panel.example.com`'s DNS A (and AAAA) record at the machine, open ports 80 and 443 (next section), then:

```bash
sudo certbot --nginx -d panel.example.com
```

certbot adds the 443 listener and the certificate to the server block and turns port 80 into a redirect to https
(older versions ask first: answer redirect). A systemd timer renews the certificate, and
`sudo certbot renew --dry-run` checks the renewal.

## The firewall

With ufw:

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp           # certificate renewal and the redirect to https
sudo ufw allow 443/tcp          # the panel
sudo ufw allow 2092/udp         # the game (the profile's -useport, if set)
sudo ufw allow 20142/udp        # GameSpy queries (-gamespyport, if set)
sudo ufw allow 3002/tcp         # mission downloads, only if the mission host is on (its port)
sudo ufw enable
```

Never open:

- **Pyrodeck's own port** (3001/tcp). Browsers go through nginx.
- **The game's remote console** (`RemoteConsolePort`, 2092/tcp by default). It shares its number with the game's UDP
  port, so write `2092/udp`: a bare `ufw allow 2092` opens TCP too.

The console is plain TCP and its password crosses the network in clear. Keep it local with `AllowRemoteConsole=0` in
the server's config, the recommended setting and the default for configs Pyrodeck creates. Pyrodeck then logs in on
127.0.0.1, and the firewall is a second layer rather than the only one:

- Matcen 0.10.8 and later listen for the console on 127.0.0.1 only, so nothing off the machine reaches it.
- Older engines (retail 1.4, upstream Descent 3, Matcen before 0.10.8) listen on every interface but close any
  connection that is not from 127.0.0.1 before asking for the password. With `-useip` in the profile they listen on
  that address only, and Pyrodeck cannot log in to them. On those, leave the profile's bind address empty.

`AllowRemoteConsole=1` is needed only when a Pyrodeck on another machine connects to this server (Connect mode). The
console then takes connections from anywhere, and the firewall is all that protects it.

A DigitalOcean cloud firewall (or your provider's equivalent) can hold the same rules outside the machine as well.

**Check the mission host from outside.** Its **Test** button fetches the mission from this machine, and on Linux a
connection to the machine's own public address goes over the loopback interface, which ufw allows. The test passes
even when the port is closed to everyone else. From another machine:

```bash
curl -sI http://203.0.113.10:3002/missions/yourmission.mn3
```

## HSTS and mission links

Pyrodeck sends `Strict-Transport-Security: max-age=31536000; includeSubDomains` on every response (`@fastify/helmet`'s
default). Browsers ignore it over plain http and obey it over https. Once you open the panel through nginx, your
browser uses https for `panel.example.com` and every name under it, on every port, for a year. On an
HSTS-preloaded top-level domain (`.dev`, `.app`, `.page` and others; see hstspreload.org) every browser does that
for every name in the domain from the start.

Game clients ignore HSTS and download missions over plain http, as they must: the game's HTTP client has no TLS, so a
mission link is always `http://<host>:<mission port>/missions/<file>.mn3`, never https and never 127.0.0.1. A person
who clicks that link in a browser under HSTS is sent to https on the mission port, which speaks only http, and the
download fails. If players should be able to fetch missions in a browser too, give the mission host a public base URL
on a name outside the panel's (`http://missions.example.com:3002` with the panel at `panel.example.com`, not at the
bare `example.com`), on a domain that is not preloaded, or use the IP address (`http://203.0.113.10:3002`).

The 1999-era clients accept no port in a link (README, "Hosting mission downloads"), and port 80 belongs to nginx
on this machine, so they cannot download from its mission host.

## Checks

From another machine:

```bash
curl -sI https://panel.example.com/ | grep -i -e '^HTTP' -e strict-transport
curl -s https://panel.example.com/api/auth/check
# {"authenticated":false,"required":true,"needsSetup":false}
curl -s -o /dev/null -w '%{http_code}\n' -H 'X-Forwarded-For: 127.0.0.1' https://panel.example.com/api/pyrodeck/config
# 401: a forged local address gets nothing
nc -vz -w 3 203.0.113.10 3001   # Pyrodeck's port: must fail
nc -vz -w 3 203.0.113.10 2092   # the console (TCP): must fail
```

Log in from a browser: the developer tools show the `pyrodeck_session` cookie with `Secure`, `HttpOnly` and
`SameSite=Strict`, and the console tab connects (a WebSocket to `wss://panel.example.com/ws`). Pyrodeck's log
(`journalctl --user -u pyrodeck`) records your address, not 127.0.0.1, on each request. Copy the cookie's value, log
out, and send it back: the API answers 401, because logout ended the session on the server.

```bash
curl -s -o /dev/null -w '%{http_code}\n' -H 'Cookie: pyrodeck_session=<the copied value>' https://panel.example.com/api/sessions
# 401
```
