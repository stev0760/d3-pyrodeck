# Building Pyrodeck

Two ways to run Pyrodeck: **dev mode** (fastest for testing, requires Node.js on the machine) or a **standalone binary** (no runtime required, portable). This document covers both, on every supported platform.

---

## Prerequisites

| Tool | Version | Notes |
|------|---------|-------|
| Node.js | 20 LTS | [nodejs.org](https://nodejs.org) or your distro's package manager |
| pnpm | 8+ | `npm install -g pnpm` after Node is installed |
| Git | any | For cloning the repo |
| `objcopy` | any | **Linux only**, for building the standalone binary. Part of `binutils`. |
| `unzip` | any | **Linux only**, only needed for cross-compiling Windows binary. |

### Installing prerequisites by platform

**Arch Linux**
```bash
sudo pacman -S nodejs pnpm git binutils
```

**Ubuntu / Debian**
```bash
# Node 20 via NodeSource (Ubuntu's built-in package is often outdated)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs git binutils
npm install -g pnpm
```

**Rocky Linux 8 / 9 (RHEL-compatible)**
```bash
curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
sudo dnf install -y nodejs git binutils
npm install -g pnpm
```

**Windows**
```powershell
# Option A: winget (built into Windows 11)
winget install OpenJS.NodeJS.LTS
winget install Git.Git

# Option B: manual — download from nodejs.org and git-scm.com
# After installing Node:
npm install -g pnpm
```
No C++ build tools or Visual Studio required — Pyrodeck has no native addons.

---

## Getting the source

```bash
git clone https://github.com/stev0760/Descent3-Pyrodeck.git
cd Descent3-Pyrodeck
pnpm install
```

`pnpm install` at the repo root installs dependencies for both `packages/server` and `packages/client` in one step (pnpm workspaces).

---

## Option 1 — Dev mode (fastest, requires Node on the machine)

This is how all development has been done. Both the backend and frontend run as separate dev servers with hot reload.

```bash
pnpm dev
```

This runs `pnpm dev` in parallel across both packages:
- **Backend** → `packages/server` on port 3001 (tsx watch, restarts on file changes)
- **Frontend** → `packages/client` on port 5173 (Vite dev server, proxies `/api` and `/ws` to 3001)

Open `http://localhost:5173` in a browser.

To run them separately (useful if you only want one):
```bash
# Backend only
cd packages/server && pnpm dev

# Frontend only
cd packages/client && pnpm dev
```

**Why use dev mode for testing?**
- No build step needed
- Changes to source reload immediately
- Full error messages and stack traces in the terminal
- Same as what you'd run during active development

---

## Option 2 — Standalone binary (portable, no Node required)

Builds a self-contained executable that includes the Node.js runtime and the compiled app. The output is two things that must stay together:

```
dist-server/
  pyrodeck-server          # the executable (pyrodeck-server.exe on Windows)
  resources/               # compiled SPA (served automatically by the binary)
```

### Build commands

```bash
# Linux binary (on Linux)
pnpm package:server

# Windows binary — cross-compiled from Linux
pnpm package:server:windows

# Windows binary — when running on a Windows machine
pnpm package:server
```

The script detects your current platform automatically. Use `--linux` or `--windows` flags to override.

### Running the binary

**Linux**
```bash
./dist-server/pyrodeck-server

# With admin password (required for any non-localhost deployment)
PYRODECK_ADMIN_PASSWORD=yourpassword ./dist-server/pyrodeck-server

# Custom port
PYRODECK_PORT=8080 ./dist-server/pyrodeck-server
```

**Windows**
```cmd
dist-server\pyrodeck-server.exe

:: With admin password
set PYRODECK_ADMIN_PASSWORD=yourpassword
dist-server\pyrodeck-server.exe
```

Open `http://localhost:3001` (not 5173 — the binary serves the SPA directly on port 3001).

### What the build script does

1. `pnpm tsc` — compiles TypeScript in `packages/server/src/` → `packages/server/dist/`
2. `pnpm build` — Vite builds the React frontend → `packages/client/dist/`
3. `esbuild` — bundles `packages/server/dist/index.js` and all npm deps into a single `dist-server/server.cjs`
4. `node --experimental-sea-config` — creates the Node SEA (Single Executable Application) blob
5. Copies the platform's `node` binary, injects the blob using:
   - Linux: `objcopy` (GNU binutils — most reliable for ELF)
   - Windows: `postject` (via npx, handles PE format)
   - macOS: `postject` with macOS codesigning

---

## Platform-specific notes

### Windows

**Building the binary on Windows:**
The packaging script works natively. `postject` is downloaded automatically via `npx` the first time.

**Running the binary on Windows:**
SmartScreen will warn on first run ("Windows protected your PC"). Click **More info → Run anyway**. This warning appears because the binary is unsigned. See [BUILDING.md#code-signing] — free OSS signing via SignPath is planned.

**If you see a "missing DLL" error:**
This shouldn't happen since the Node SEA binary is fully self-contained, but if it does, install the [Visual C++ Redistributable](https://aka.ms/vs/17/release/vc_redist.x64.exe) (already present on most Windows systems).

**PowerShell execution policy:**
If running pnpm scripts gives "cannot be loaded because running scripts is disabled," run:
```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
```

---

### Ubuntu / Debian

Install prerequisites as shown above. The build and run process is identical to Arch Linux.

**Firewall:**
```bash
sudo ufw allow 3001/tcp
```

**Running as a service (optional):**
Create `/etc/systemd/system/pyrodeck.service`:
```ini
[Unit]
Description=D3 Pyrodeck
After=network.target

[Service]
Type=simple
User=yourusername
WorkingDirectory=/opt/pyrodeck
ExecStart=/opt/pyrodeck/pyrodeck-server
Restart=on-failure
RestartSec=5
Environment=PYRODECK_ADMIN_PASSWORD=yourpassword
Environment=PYRODECK_PORT=3001

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now pyrodeck
sudo systemctl status pyrodeck
```

---

### Rocky Linux 8/9 and RHEL-compatible distros

Rocky Linux runs SELinux in enforcing mode by default. Some extra steps are needed.

**Install prerequisites:**
```bash
# Node 20 (not in default Rocky repos)
curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
sudo dnf install -y nodejs git binutils
npm install -g pnpm

# Verify
node --version   # should be v20.x.x
pnpm --version
```

**Build normally** — the build process is the same as on any Linux:
```bash
pnpm install
pnpm package:server
```

**Running the binary — SELinux file context:**

When you copy or download a binary to a new location, it inherits the wrong SELinux file context and may be blocked from executing. Fix:

```bash
# Copy to a standard location
sudo mkdir -p /opt/pyrodeck
sudo cp -r dist-server/pyrodeck-server dist-server/resources /opt/pyrodeck/

# Fix the file context so SELinux allows execution
sudo restorecon -Rv /opt/pyrodeck/
# Or manually set the type if restorecon doesn't help:
sudo chcon -t bin_t /opt/pyrodeck/pyrodeck-server
```

**If the binary still won't run, check SELinux denials:**
```bash
# See what SELinux blocked in the last few minutes
sudo ausearch -m avc -ts recent | audit2allow

# Watch denials in real time
sudo tail -f /var/log/audit/audit.log | grep denied
```

**Node.js JIT and execmem:**
Node.js uses JIT compilation which requires `execmem` (the ability to execute writable memory). This is normally allowed for unconfined user processes on Rocky Linux, but if you're running under systemd with a strict service context you may see denials. Quick diagnosis:

```bash
sudo setsebool -P allow_execmem 1   # temporary workaround for testing
# Proper fix: write a custom SELinux policy module (see below)
```

**Port labeling:**
Port 3001 has no default SELinux label. For a regular user-launched process this is fine. For a systemd service, you need to label it:

```bash
# Label 3001 as an HTTP port (or use http_cache_port_t for non-80/443)
sudo semanage port -a -t http_port_t -p tcp 3001
# Verify:
sudo semanage port -l | grep 3001
```

**Firewall (firewalld on Rocky):**
```bash
sudo firewall-cmd --permanent --add-port=3001/tcp
sudo firewall-cmd --reload
```

**Systemd service on Rocky with SELinux:**

The safest approach for testing is to run the binary as an `unconfined_service_t` process by adding this to the service file:
```ini
[Service]
SELinuxContext=system_u:system_r:unconfined_service_t:s0
```
This opts the service out of SELinux confinement — appropriate for testing but not ideal for a hardened production deployment. Once everything works, you can write a proper policy module.

**Writing a minimal SELinux policy module (proper fix):**
```bash
# Generate a policy from the denials you've seen:
sudo ausearch -m avc -ts recent | audit2allow -M pyrodeck
sudo semodule -i pyrodeck.pp

# This creates a custom policy that allows exactly what was denied.
# Re-run after each new denial until the binary runs cleanly.
```

---

### Arch Linux (the dev machine)

Everything works out of the box. The note here is about **not distributing locally-built binaries** to other platforms:

When you run `pnpm package:server` on Arch, the resulting binary links against your current system's glibc. Arch is a rolling release and typically has a newer glibc than Ubuntu LTS or Rocky Linux. The binary will work on Arch and on any distro with a recent-enough glibc, but may fail on older LTS distributions with a "GLIBC version not found" error.

**For distribution:** always use the binary produced by GitHub Actions (ubuntu-latest runner), which links against Ubuntu 22.04's glibc and is broadly compatible. See `.github/workflows/release.yml`.

**For local testing:** the Arch-built binary is fine. Use it to test against the Matcen fork on your workstation.

To check what glibc version a binary requires:
```bash
objdump -p ./dist-server/pyrodeck-server | grep GLIBC
# Output lists each required GLIBC symbol version — the highest is the minimum required
```

---

## Environment variables

All configuration is via environment variables. None are required to start in dev/local mode.

The admin password can also be set via the web UI on first run (stored as a scrypt hash in `config/pyrodeck.json`). The environment variable takes precedence if both are set.

| Variable | Default | Purpose |
|----------|---------|---------|
| `PYRODECK_ADMIN_PASSWORD` | *(unset)* | Admin password. If unset, falls back to the password hash in `config/pyrodeck.json`. If neither is set, the web UI prompts for first-time setup. |
| `PYRODECK_PORT` | `3001` | Port to bind |
| `PYRODECK_HOST` | `0.0.0.0` | Interface to bind. Use `127.0.0.1` for loopback-only. |
| `PYRODECK_CONFIG_DIR` | `./config` | Where Pyrodeck stores profiles, secrets, playlists |
| `PYRODECK_SESSION_SECRET` | *(auto-generated)* | Cookie signing secret. Auto-generated and saved to `config/session-secret` on first run. Set explicitly for multi-instance or to preserve sessions across restarts. |
| `PYRODECK_STATIC_DIR` | *(auto-detected)* | Path to the `resources/` SPA directory. Auto-detected from the executable's location in binary mode. Set manually if needed. |
| `PYRODECK_SIDECAR` | *(unset)* | Set to `1` by the Tauri wrapper. Binds loopback-only on an ephemeral port and writes `sidecar-port:{n}` to stdout. |

---

## Troubleshooting

**`pnpm install` fails on Windows with gyp errors**
Pyrodeck has no native addons — if you see gyp errors, they're from an unrelated transitive dependency. Try `pnpm install --ignore-scripts` and report the specific package.

**Port 3001 already in use**
```bash
# Find what's using it:
sudo lsof -i :3001        # Linux/macOS
netstat -ano | findstr :3001   # Windows

# Use a different port:
PYRODECK_PORT=3002 ./dist-server/pyrodeck-server
```

**Binary exits immediately with no output**
On Linux, run with `strace ./dist-server/pyrodeck-server 2>&1 | head -30` to see what system call is failing. On Rocky, check `ausearch -m avc -ts recent` for SELinux denials first.

**`config/session-secret` permission denied**
The binary creates `./config/session-secret` in the working directory. Make sure the user running the binary has write permission to the working directory, or set `PYRODECK_CONFIG_DIR` to a writable path:
```bash
PYRODECK_CONFIG_DIR=/var/lib/pyrodeck ./pyrodeck-server
```

**TypeScript errors during build**
Run `pnpm tsc --noEmit` in `packages/server` or `packages/client` to see type errors clearly. The build script runs tsc but esbuild output may obscure where the error originated.
