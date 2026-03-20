import type { FastifyInstance } from "fastify";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

interface SavedServer {
  id: string;
  name: string;
  host: string;
  port: number;
}

const CONFIG_DIR = process.env.PYRODECK_CONFIG_DIR ?? "./config";
const SERVERS_FILE = path.join(CONFIG_DIR, "servers.json");

async function readServers(): Promise<SavedServer[]> {
  try {
    const data = await fs.readFile(SERVERS_FILE, "utf-8");
    return JSON.parse(data) as SavedServer[];
  } catch {
    return [];
  }
}

async function writeServers(servers: SavedServer[]): Promise<void> {
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  await fs.writeFile(SERVERS_FILE, JSON.stringify(servers, null, 2));
}

export async function savedServerRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/servers/saved", async () => {
    return await readServers();
  });

  app.post("/api/servers/saved", async (request) => {
    const { name, host, port } = request.body as {
      name: string;
      host: string;
      port: number;
    };

    const servers = await readServers();
    const entry: SavedServer = {
      id: crypto.randomUUID(),
      name,
      host,
      port: port ?? 2092,
    };
    servers.push(entry);
    await writeServers(servers);
    return entry;
  });

  app.delete("/api/servers/saved/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const servers = await readServers();
    const filtered = servers.filter((s) => s.id !== id);
    if (filtered.length === servers.length) {
      return reply.status(404).send({ error: "Server not found" });
    }
    await writeServers(filtered);
    return { ok: true };
  });
}
