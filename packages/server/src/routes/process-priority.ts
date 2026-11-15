import type { FastifyInstance } from "fastify";
import { pyrodeckConfig } from "./pyrodeck-config.js";
import { serverRegistry } from "../servers/ServerRegistry.js";
import { wsBroadcast } from "./command.js";
import { serverEvents } from "../events/ServerEvents.js";
import { applyPriority, isPriorityClass, type PriorityResult } from "../ops/processPriority.js";

/**
 * Process priority class for the game servers: one setting for all of them,
 * applied on every server.started, and to every running server on a change.
 */

/** The last application, and the last one per server (by the profileId its events carry). */
let lastPriority: PriorityResult | null = null;
const lastByServer = new Map<string, PriorityResult | null>();

async function applyConfiguredPriority(profileId: string, pid: number, atLaunch: boolean): Promise<PriorityResult | null> {
  const cls = pyrodeckConfig.get().processPriority;
  // At launch, Normal leaves the process at the priority it inherits from Pyrodeck.
  if (atLaunch && cls === "normal") {
    lastPriority = null;
    lastByServer.set(profileId, null);
    return null;
  }
  const result = await applyPriority(pid, cls);
  lastPriority = result;
  lastByServer.set(profileId, result);
  if (result.warning) {
    console.warn(`[Priority] ${result.warning}`);
    wsBroadcast("error", { message: `Process priority not changed. ${result.warning}` });
  } else if (result.applied > 0) {
    console.log(`[Priority] Server PID ${pid} set to ${cls} (nice ${result.value}, ${result.applied} thread(s))`);
  }
  return result;
}

// Every start of every server: by hand, by a playlist restart, by the schedule, by the supervisor.
serverEvents.onEvent("server.started", ({ profileId, pid }) => {
  void applyConfiguredPriority(profileId, pid, true);
});

const byServer = () => Object.fromEntries(lastByServer);

export async function processPriorityRoutes(app: FastifyInstance): Promise<void> {
  /** GET /api/process-priority: the class and what its last application did (`byServer`: per server). */
  app.get("/api/process-priority", async () => ({
    priorityClass: pyrodeckConfig.get().processPriority,
    platform: process.platform,
    last: lastPriority,
    byServer: byServer(),
  }));

  /** PUT /api/process-priority  { priorityClass }: save, and apply to every running server now. */
  app.put("/api/process-priority", async (request, reply) => {
    const { priorityClass } = (request.body ?? {}) as { priorityClass?: unknown };
    if (!isPriorityClass(priorityClass)) {
      return reply.status(400).send({ error: "priorityClass must be below-normal, normal, above-normal or high." });
    }
    await pyrodeckConfig.save({ processPriority: priorityClass });
    let applied: PriorityResult | null = null;
    for (const server of serverRegistry.running()) {
      const pid = server.process.getStatus().pid;
      if (pid === null || !server.process.isRunning()) continue;
      const result = await applyConfiguredPriority(server.eventScopeId(), pid, false);
      if (server === serverRegistry.defaultServer() || applied === null) applied = result;
    }
    return { priorityClass, platform: process.platform, last: applied ?? lastPriority, byServer: byServer() };
  });
}
