import type { FastifyInstance } from "fastify";
import path from "node:path";
import { pyrodeckConfig } from "./pyrodeck-config.js";
import { serverRegistry } from "../servers/ServerRegistry.js";
import { playerTracker } from "./players.js";
import { BanStore } from "../bans/BanStore.js";
import { BanService } from "../bans/BanService.js";
import { activeConsoleLink, openConsoleIsLocal, openConsoleLink } from "../players/activeConsole.js";
import { activeConsoleProfileId } from "../events/consoleEventHub.js";
import { LineSplitter } from "../events/consoleLines.js";
import { validatePlayerSettings } from "../players/playerSettings.js";

const CONFIG_DIR = process.env.PYRODECK_CONFIG_DIR ?? "./config";

export const banService = new BanService({
  store: new BanStore(path.join(CONFIG_DIR, "bans.json")),
  console: activeConsoleLink,
  openConsole: openConsoleLink,
  settings: () => pyrodeckConfig.get().players,
  lookupAddress: (profileId, name, slot) => playerTracker.lookupAddress(profileId, name, slot),
});

/**
 * A launched server logs its writable directory ("Local dir: <path>",
 * mng_InitLocalTables, manage/manage.cpp:679), which is where DMFC reads
 * netgames/hosts.deny. Remember it so the editor works on the file that
 * server reads.
 */
function watchLaunchedServerLocalDir(): void {
  const launchedProcess = serverRegistry.getDefault().process;
  let splitter = new LineSplitter();
  launchedProcess.on("stateChange", (state: string) => {
    if (state === "starting") splitter = new LineSplitter();
  });
  launchedProcess.on("stdout", (chunk: string) => {
    for (const line of splitter.push(chunk)) {
      const m = /\bLocal dir: (.+?)\s*$/.exec(line);
      if (m && path.isAbsolute(m[1])) void banService.store.setDetectedLocalDir(m[1]).catch(() => {});
    }
  });
}

function text(v: unknown): string {
  return typeof v === "string" ? v : "";
}

export async function banRoutes(app: FastifyInstance): Promise<void> {
  await banService.store.load();
  banService.start();
  watchLaunchedServerLocalDir();
  app.addHook("onClose", async () => banService.stop());

  /** GET /api/bans: hosts.deny as the server reads it, the name bans, the ban settings. */
  app.get("/api/bans", async () => {
    const { hostsDenyPath, rehashOnLevelStart } = pyrodeckConfig.get().players;
    return {
      hostsDeny: await banService.readHostsDeny(),
      nameBans: banService.store.nameBans(),
      settings: { hostsDenyPath, rehashOnLevelStart },
      detectedLocalDir: banService.store.detectedLocalDir,
      consoleIsLocal: openConsoleIsLocal(),
    };
  });

  /** POST /api/bans/hosts  { entry, reason }: an address, a * pattern, or a /8-/32 prefix. */
  app.post("/api/bans/hosts", async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    try {
      const result = await banService.addHostsDeny(text(body.entry), text(body.reason));
      if (!result.ok) return reply.status(400).send({ error: result.error });
      return result;
    } catch (err) {
      return reply.status(500).send({ error: `Cannot write hosts.deny: ${err instanceof Error ? err.message : String(err)}` });
    }
  });

  /** DELETE /api/bans/hosts/:entry */
  app.delete("/api/bans/hosts/:entry", async (request, reply) => {
    const { entry } = request.params as { entry: string };
    try {
      const result = await banService.removeHostsDeny(entry);
      if (!result.ok) return reply.status(404).send({ error: result.error });
      return result;
    } catch (err) {
      return reply.status(500).send({ error: `Cannot write hosts.deny: ${err instanceof Error ? err.message : String(err)}` });
    }
  });

  /** POST /api/bans/names  { pattern, reason }: a callsign, or Name* for every name starting with Name. */
  app.post("/api/bans/names", async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const result = await banService.addNameBan(body.pattern, text(body.reason));
    if ("error" in result) return reply.status(400).send(result);
    return result;
  });

  /** DELETE /api/bans/names/:id */
  app.delete("/api/bans/names/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!(await banService.store.removeNameBan(id))) return reply.status(404).send({ error: "No such name ban." });
    return { ok: true };
  });

  /** POST /api/bans/rehash: `$rehash` on the open console. */
  app.post("/api/bans/rehash", async (_request, reply) => {
    if (!(await banService.rehash())) return reply.status(409).send({ error: "No server console is open." });
    return { ok: true };
  });

  /** POST /api/players/kick  { name, reason?, slot? }: say why, then `$kick`. */
  app.post("/api/players/kick", async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const profileId = activeConsoleProfileId();
    if (!profileId) return reply.status(409).send({ error: "No server console is open." });
    if (typeof body.name !== "string" || !body.name) return reply.status(400).send({ error: "name is required" });
    const result = await banService.kick(
      profileId,
      body.name,
      typeof body.reason === "string" ? body.reason : "",
      typeof body.slot === "number" ? body.slot : undefined,
    );
    if (!result.ok) return reply.status(409).send({ error: result.error });
    return result;
  });

  /**
   * POST /api/players/ban  { name, reason?, hostsDeny?, nameBan?, slot? }:
   * say why, `$ban`, and optionally add the address to hosts.deny and the
   * name to the name-ban list.
   */
  app.post("/api/players/ban", async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const profileId = activeConsoleProfileId();
    if (!profileId) return reply.status(409).send({ error: "No server console is open." });
    if (typeof body.name !== "string" || !body.name) return reply.status(400).send({ error: "name is required" });
    const result = await banService.ban(profileId, body.name, typeof body.reason === "string" ? body.reason : "", {
      hostsDeny: body.hostsDeny !== false,
      nameBan: body.nameBan === true,
      slot: typeof body.slot === "number" ? body.slot : undefined,
    });
    if (!result.ok) return reply.status(409).send({ error: result.error });
    return result;
  });

  /** PUT /api/bans/settings  { hostsDenyPath?, rehashOnLevelStart? } */
  app.put("/api/bans/settings", async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const check = validatePlayerSettings(
      { hostsDenyPath: body.hostsDenyPath, rehashOnLevelStart: body.rehashOnLevelStart },
      pyrodeckConfig.get().players,
    );
    if (check.errors.length > 0) {
      return reply.status(400).send({ error: check.errors.join(" "), errors: check.errors });
    }
    await pyrodeckConfig.save({ players: check.settings });
    const { hostsDenyPath, rehashOnLevelStart } = check.settings;
    return { settings: { hostsDenyPath, rehashOnLevelStart }, hostsDeny: await banService.readHostsDeny() };
  });
}
