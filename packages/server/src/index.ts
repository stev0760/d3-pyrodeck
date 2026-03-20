import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifyCors from "@fastify/cors";
import fastifyWebSocket from "@fastify/websocket";
import { authRoutes, getSessionPassword } from "./routes/auth.js";
import { serverRoutes } from "./routes/server.js";
import { commandRoutes } from "./routes/command.js";

const PORT = parseInt(process.env.PYRODECK_PORT ?? "3001", 10);

// Validate required config before starting
try {
  getSessionPassword();
} catch (err) {
  console.error(
    "PYRODECK_PASSWORD environment variable must be set.\n" +
      "Example: PYRODECK_PASSWORD=mysecret pnpm dev",
  );
  process.exit(1);
}

const app = Fastify({ logger: true });

// Plugins
await app.register(fastifyCookie);
await app.register(fastifyCors, {
  origin: true, // Allow same-origin (Vite proxy in dev)
  credentials: true,
});
await app.register(fastifyWebSocket);

// Routes
await app.register(authRoutes);
await app.register(serverRoutes);
await app.register(commandRoutes);

// Health check (unauthenticated)
app.get("/api/health", async () => {
  return { status: "ok" };
});

try {
  await app.listen({ port: PORT, host: "0.0.0.0" });
  app.log.info(`D3 Pyrodeck server listening on port ${PORT}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
