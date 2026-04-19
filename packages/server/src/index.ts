import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifyCors from "@fastify/cors";
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
import { playlistRoutes } from "./routes/playlists.js";
import { versionRoutes } from "./routes/version.js";
import { requireAuth } from "./middleware/requireAuth.js";

const PORT = parseInt(process.env.PYRODECK_PORT ?? "3001", 10);
const HOST = process.env.PYRODECK_HOST ?? "0.0.0.0";
const CONFIG_DIR = process.env.PYRODECK_CONFIG_DIR ?? "./config";
const isSidecar = process.env.PYRODECK_SIDECAR === "1";

// Load or generate session secret
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

// Locate SPA static files (production/SEA mode only)
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

const sessionSecret = await loadSessionSecret();
const staticDir = await findStaticDir();

const isLocalhost =
  HOST === "127.0.0.1" || HOST === "::1" || HOST === "localhost";

if (!process.env.PYRODECK_ADMIN_PASSWORD && !isLocalhost && !isSidecar) {
  console.warn(
    "[Pyrodeck] WARNING: PYRODECK_ADMIN_PASSWORD is not set but server is binding to " +
      HOST +
      ". The admin panel will be accessible without a password. Set PYRODECK_ADMIN_PASSWORD to secure it.",
  );
}

const app = Fastify({ logger: !isSidecar, trustProxy: true });

// Plugins
await app.register(fastifyCookie, { secret: sessionSecret });
await app.register(fastifyCors, {
  origin: true,
  credentials: true,
});
await app.register(fastifyWebSocket);

// Routes
await app.register(authRoutes);
await app.register(versionRoutes);
await app.register(serverRoutes);
await app.register(commandRoutes);
await app.register(savedServerRoutes);
await app.register(configRoutes);
await app.register(pyrodeckConfigRoutes);
await app.register(launcherRoutes);
await app.register(playlistRoutes);

app.get("/api/health", async () => {
  return { status: "ok" };
});

// Serve SPA in production mode
if (staticDir) {
  await app.register(fastifyStatic, {
    root: staticDir,
    wildcard: false,
  });
  app.setNotFoundHandler((_req, reply) => {
    return reply.sendFile("index.html");
  });
}

// Auth guard — registered AFTER all plugins so @fastify/cookie's onRequest
// hook (which populates request.unsignCookie) has already been registered.
app.addHook("onRequest", requireAuth);

// Bind address
const bindHost = isSidecar ? "127.0.0.1" : HOST;
const bindPort = isSidecar ? 0 : PORT;

try {
  await app.listen({ port: bindPort, host: bindHost });

  if (isSidecar) {
    // Write port to stdout for Tauri to read
    const addr = app.server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    process.stdout.write(`sidecar-port:${port}\n`);
  } else {
    app.log.info(`D3 Pyrodeck server listening on ${bindHost}:${PORT}`);
  }
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
