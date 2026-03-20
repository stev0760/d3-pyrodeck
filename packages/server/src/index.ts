import Fastify from "fastify";

const PORT = parseInt(process.env.PYRODECK_PORT ?? "3001", 10);

const app = Fastify({ logger: true });

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
