import type { FastifyInstance } from "fastify";
import fs from "node:fs/promises";
import path from "node:path";

const CONFIG_DIR = process.env.PYRODECK_CONFIG_DIR ?? "./config";

function sanitizeName(name: string): string | null {
  // Reject path traversal and separators
  if (
    name.includes("..") ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("\0")
  ) {
    return null;
  }
  return name;
}

export async function configRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/config/files", async () => {
    try {
      const entries = await fs.readdir(CONFIG_DIR);
      const files: string[] = [];
      for (const entry of entries) {
        const stat = await fs.stat(path.join(CONFIG_DIR, entry));
        if (stat.isFile()) {
          files.push(entry);
        }
      }
      return { files };
    } catch {
      return { files: [] };
    }
  });

  app.get("/api/config/files/:name", async (request, reply) => {
    const { name } = request.params as { name: string };
    const safe = sanitizeName(name);
    if (!safe) {
      return reply.status(400).send({ error: "Invalid filename" });
    }

    try {
      const content = await fs.readFile(path.join(CONFIG_DIR, safe), "utf-8");
      return { name: safe, content };
    } catch {
      return reply.status(404).send({ error: "File not found" });
    }
  });

  app.put("/api/config/files/:name", async (request, reply) => {
    const { name } = request.params as { name: string };
    const safe = sanitizeName(name);
    if (!safe) {
      return reply.status(400).send({ error: "Invalid filename" });
    }

    const { content } = request.body as { content: string };
    if (typeof content !== "string") {
      return reply.status(400).send({ error: "content must be a string" });
    }

    await fs.mkdir(CONFIG_DIR, { recursive: true });
    await fs.writeFile(path.join(CONFIG_DIR, safe), content);
    return { ok: true };
  });
}
