import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifyCors from "@fastify/cors";
import fastifyHelmet from "@fastify/helmet";
import fastifyWebSocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { authRoutes } from "./routes/auth.js";
import { serverRoutes } from "./routes/server.js";
import { commandRoutes } from "./routes/command.js";
import { savedServerRoutes } from "./routes/saved-servers.js";
import { configRoutes } from "./routes/config.js";
import { pyrodeckConfigRoutes } from "./routes/pyrodeck-config.js";
import { missionHostRoutes } from "./routes/mission-host.js";
import { launcherRoutes, startAutostart } from "./routes/launcher.js";
import { logsRoutes } from "./routes/logs.js";
import { playlistRoutes } from "./routes/playlists.js";
import { versionRoutes } from "./routes/version.js";
import { scheduleRoutes } from "./routes/schedule.js";
import { alertRoutes } from "./routes/alerts.js";
import { processPriorityRoutes } from "./routes/process-priority.js";
import { updateCheckRoutes } from "./routes/update-check.js";
import { launchScriptRoutes } from "./routes/launch-script.js";
import { playersRoutes } from "./routes/players.js";
import { banRoutes } from "./routes/bans.js";
import { playerRulesRoutes } from "./routes/playerRules.js";
import { requireAuth } from "./middleware/requireAuth.js";
import {
  isLoopbackAddress,
  isLoopbackName,
  isProxiedRequest,
  parseOriginList,
  parseTrustProxy,
} from "./middleware/requestSource.js";
import { startConsoleEvents } from "./events/consoleEventHub.js";
import { resolveListenAddress } from "./listenAddress.js";
import { parseSessionLifetimes, sessions } from "./auth/sessions.js";

const CONFIG_DIR = process.env.PYRODECK_CONFIG_DIR ?? "./config";

async function loadSessionSecret(): Promise<string> {
  if (process.env.PYRODECK_SESSION_SECRET) {
    return process.env.PYRODECK_SESSION_SECRET;
  }
  const secretPath = path.join(CONFIG_DIR, "session-secret");
  try {
    return (await fs.readFile(secretPath, "utf-8")).trim();
  } catch {
    const secret = crypto.randomBytes(32).toString("hex");
    await fs.mkdir(CONFIG_DIR, { recursive: true });
    await fs.writeFile(secretPath, secret, { mode: 0o600 });
    return secret;
  }
}

async function findStaticDir(): Promise<string | null> {
  if (process.env.PYRODECK_STATIC_DIR) {
    return process.env.PYRODECK_STATIC_DIR;
  }
  const candidate = path.join(path.dirname(process.execPath), "resources");
  try {
    await fs.access(path.join(candidate, "index.html"));
    return candidate;
  } catch {
    return null;
  }
}

async function main() {
  // Environment checks first: a malformed value stops the start here.
  const listen = resolveListenAddress(process.env);
  const { host: HOST, port: PORT, sidecar: isSidecar } = listen;
  sessions.setLifetimes(parseSessionLifetimes(process.env));

  const sessionSecret = await loadSessionSecret();
  const staticDir = await findStaticDir();

  const isLocalhost = isLoopbackName(HOST);

  const { pyrodeckConfig } = await import("./routes/pyrodeck-config.js");
  await pyrodeckConfig.load();

  const hasPassword =
    !!process.env.PYRODECK_ADMIN_PASSWORD ||
    !!pyrodeckConfig.get().adminPasswordHash;

  // trustProxy must be opt-in: when the server is directly exposed (no reverse
  // proxy), trusting X-Forwarded-For lets a client spoof its IP and bypass the
  // login rate limiter. Enable only when actually behind a trusted proxy, and
  // then trust only that proxy's address (requestSource.ts): "1" means a proxy
  // on this machine. Throws on a malformed value, so a typo stops the start.
  const trustProxy = parseTrustProxy(process.env.PYRODECK_TRUST_PROXY);
  const trustsLoopbackOnly =
    !!trustProxy &&
    trustProxy.every((e) => e.toLowerCase() === "loopback" || isLoopbackAddress(e.split("/")[0]));

  if (!hasPassword && !isLocalhost && !isSidecar) {
    console.warn(
      "[Pyrodeck] WARNING: No admin password configured but PYRODECK_HOST is " +
        HOST +
        ". Remote clients are refused until a password is set (requireAuth fails " +
        "closed for non-loopback peers). Set PYRODECK_ADMIN_PASSWORD to enable " +
        "remote access; web-based setup stays blocked from non-local clients " +
        "unless PYRODECK_ALLOW_REMOTE_SETUP=1.",
    );
  }
  if (!hasPassword && trustProxy && !isSidecar) {
    console.warn(
      "[Pyrodeck] WARNING: No admin password configured. Requests through the reverse proxy are " +
        "never local, so the panel refuses them until a password is set: set PYRODECK_ADMIN_PASSWORD, " +
        "or set one from a browser on this machine (an SSH tunnel to " +
        `127.0.0.1:${PORT}), not through the proxy.`,
    );
  }
  if (trustsLoopbackOnly && !isLocalhost && !isSidecar) {
    console.warn(
      `[Pyrodeck] WARNING: PYRODECK_TRUST_PROXY trusts a reverse proxy on this machine, but Pyrodeck ` +
        `listens on ${HOST}, so browsers can also reach it directly over plain http, around the proxy. ` +
        "Remove PYRODECK_HOST (the default is 127.0.0.1), or keep the port closed in the firewall.",
    );
  }

  const app = Fastify({ logger: !isSidecar, trustProxy });

  const { ttlMs, idleMs } = sessions.getLifetimes();
  sessions.setLogger((message) => app.log.info(message));
  app.log.info(
    `Sessions end ${ttlMs / 3_600_000} h after login, or after ${idleMs / 60_000} min unused. ` +
      "They are kept in memory: restarting Pyrodeck logs everyone out.",
  );
  if (listen.hostIsDefault && !isSidecar) {
    app.log.info(
      `Listening on ${HOST} only (the default since 0.5.2): browsers on other machines reach Pyrodeck through a ` +
        "reverse proxy or an SSH tunnel. To serve a LAN directly, set PYRODECK_HOST=0.0.0.0.",
    );
  }

  if (trustProxy) {
    app.log.info(`Trusting X-Forwarded-For and X-Forwarded-Proto from: ${trustProxy.join(", ")}`);
  } else if (!isSidecar) {
    // Behind a proxy with trustProxy off, every client has the proxy's address:
    // nothing relayed is local (good), but the login rate limit is one bucket
    // for the whole internet and the session cookie is never Secure. Say so
    // once, on the first relayed request.
    let warned = false;
    app.addHook("onRequest", async (request) => {
      if (warned || !isProxiedRequest(request)) return;
      warned = true;
      request.log.warn(
        `A request came through a reverse proxy (from ${request.ip}) but PYRODECK_TRUST_PROXY is not set: ` +
          "every browser then shares the proxy's address, so the login rate limit is shared and the session " +
          "cookie is not marked Secure. Set PYRODECK_TRUST_PROXY=1 for a proxy on this machine, or to the proxy's address.",
      );
    });
  }

  await app.register(fastifyCookie, { secret: sessionSecret });

  // The SPA is served same-origin (Fastify static in prod, Vite proxy in dev),
  // so cross-origin access is disabled by default. Set PYRODECK_CORS_ORIGIN to
  // a comma-separated allowlist only if you front the API from another origin.
  const corsOrigins = parseOriginList(process.env.PYRODECK_CORS_ORIGIN);
  await app.register(fastifyCors, {
    origin: corsOrigins.length > 0 ? corsOrigins : false,
    credentials: true,
  });
  await app.register(fastifyHelmet, { contentSecurityPolicy: false });
  await app.register(fastifyWebSocket);

  await app.register(authRoutes);
  await app.register(versionRoutes);
  await app.register(serverRoutes);
  await app.register(commandRoutes);
  await app.register(savedServerRoutes);
  await app.register(configRoutes);
  await app.register(pyrodeckConfigRoutes);
  // Starts the mission download listener (its own port) when it is enabled.
  await app.register(missionHostRoutes);
  await app.register(launcherRoutes);
  await app.register(logsRoutes);
  await app.register(playlistRoutes);
  // Starts the weekly schedule's 30 s tick.
  await app.register(scheduleRoutes);
  await app.register(alertRoutes);
  await app.register(processPriorityRoutes);
  await app.register(updateCheckRoutes);
  await app.register(launchScriptRoutes);
  await app.register(playersRoutes);
  await app.register(banRoutes);
  await app.register(playerRulesRoutes);

  app.get("/api/health", async () => ({ status: "ok" }));

  // Player and level events from whatever console session is open.
  startConsoleEvents();

  if (staticDir) {
    await app.register(fastifyStatic, { root: staticDir, wildcard: false });
    app.setNotFoundHandler((_req, reply) => reply.sendFile("index.html"));
  }

  // Auth guard after all plugin registrations so @fastify/cookie's onRequest
  // hook (which provides request.unsignCookie) is already in place.
  app.addHook("onRequest", requireAuth);

  await app.listen({ port: PORT, host: HOST });

  if (isSidecar) {
    const addr = app.server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    process.stdout.write(`sidecar-port:${port}\n`);
  } else {
    app.log.info(`D3 Pyrodeck server listening on ${HOST}:${PORT}`);
  }

  // Autostart last: re-attach has run (launcherRoutes), and the panel is up
  // to show what autostart does. It never throws; a failure is logged.
  void startAutostart();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
