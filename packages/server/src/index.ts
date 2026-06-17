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
import { launcherRoutes } from "./routes/launcher.js";
import { logsRoutes } from "./routes/logs.js";
import { playlistRoutes } from "./routes/playlists.js";
import { versionRoutes } from "./routes/version.js";
import { requireAuth } from "./middleware/requireAuth.js";

const PORT = parseInt(process.env.PYRODECK_PORT ?? "3001", 10);
const HOST = process.env.PYRODECK_HOST ?? "0.0.0.0";
const CONFIG_DIR = process.env.PYRODECK_CONFIG_DIR ?? "./config";
const isSidecar = process.env.PYRODECK_SIDECAR === "1";

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
  const sessionSecret = await loadSessionSecret();
  const staticDir = await findStaticDir();

  const isLocalhost =
    HOST === "127.0.0.1" || HOST === "::1" || HOST === "localhost";

  const { pyrodeckConfig } = await import("./routes/pyrodeck-config.js");
  await pyrodeckConfig.load();

  const hasPassword =
    !!process.env.PYRODECK_ADMIN_PASSWORD ||
    !!pyrodeckConfig.get().adminPasswordHash;

  if (!hasPassword && !isLocalhost && !isSidecar) {
    console.warn(
      "[Pyrodeck] WARNING: No admin password configured but server is binding to " +
        HOST +
        ". Set PYRODECK_ADMIN_PASSWORD before exposing this server. Web-based setup " +
        "is blocked from non-local clients unless PYRODECK_ALLOW_REMOTE_SETUP=1.",
    );
  }

  // trustProxy must be opt-in: when the server is directly exposed (no reverse
  // proxy), trusting X-Forwarded-For lets a client spoof its IP and bypass the
  // login rate limiter. Enable only when actually behind a trusted proxy.
  const trustProxy = process.env.PYRODECK_TRUST_PROXY === "1";

  const app = Fastify({ logger: !isSidecar, trustProxy });

  await app.register(fastifyCookie, { secret: sessionSecret });

  // The SPA is served same-origin (Fastify static in prod, Vite proxy in dev),
  // so cross-origin access is disabled by default. Set PYRODECK_CORS_ORIGIN to
  // a comma-separated allowlist only if you front the API from another origin.
  const corsOrigin = process.env.PYRODECK_CORS_ORIGIN;
  await app.register(fastifyCors, {
    origin: corsOrigin
      ? corsOrigin.split(",").map((o) => o.trim()).filter(Boolean)
      : false,
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
  await app.register(launcherRoutes);
  await app.register(logsRoutes);
  await app.register(playlistRoutes);

  app.get("/api/health", async () => ({ status: "ok" }));

  if (staticDir) {
    await app.register(fastifyStatic, { root: staticDir, wildcard: false });
    app.setNotFoundHandler((_req, reply) => reply.sendFile("index.html"));
  }

  // Auth guard after all plugin registrations so @fastify/cookie's onRequest
  // hook (which provides request.unsignCookie) is already in place.
  app.addHook("onRequest", requireAuth);

  const bindHost = isSidecar ? "127.0.0.1" : HOST;
  const bindPort = isSidecar ? 0 : PORT;

  await app.listen({ port: bindPort, host: bindHost });

  if (isSidecar) {
    const addr = app.server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    process.stdout.write(`sidecar-port:${port}\n`);
  } else {
    app.log.info(`D3 Pyrodeck server listening on ${bindHost}:${PORT}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
