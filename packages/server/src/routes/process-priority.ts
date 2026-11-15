import type { FastifyInstance } from "fastify";
import { pyrodeckConfig } from "./pyrodeck-config.js";
import { serverRegistry } from "../servers/ServerRegistry.js";
import { wsBroadcast } from "./command.js";
import { serverEvents } from "../events/ServerEvents.js";
import { applyPriority, isPriorityClass, type PriorityResult } from "../ops/processPriority.js";

/** Process priority class for the game server: applied on every server.started, and on a change. */

let lastPriority: PriorityResult | null = null;

async function applyConfiguredPriority(pid: number, atLaunch: boolean): Promise<PriorityResult | null> {
  const cls = pyrodeckConfig.get().processPriority;
  // At launch, Normal leaves the process at the priority it inherits from Pyrodeck.
  if (atLaunch && cls === "normal") {
    lastPriority = null;
    return null;
  }
  const result = await applyPriority(pid, cls);
  lastPriority = result;
  if (result.warning) {
    console.warn(`[Priority] ${result.warning}`);
    wsBroadcast("error", { message: `Process priority not changed. ${result.warning}` });
  } else if (result.applied > 0) {
    console.log(`[Priority] Server PID ${pid} set to ${cls} (nice ${result.value}, ${result.applied} thread(s))`);
  }
  return result;
}

// Every start: by hand, by a playlist restart, by the schedule, by the supervisor.
serverEvents.onEvent("server.started", ({ pid }) => {
  void applyConfiguredPriority(pid, true);
});

export async function processPriorityRoutes(app: FastifyInstance): Promise<void> {
  /** GET /api/process-priority: the class and what its last application did. */
  app.get("/api/process-priority", async () => ({
    priorityClass: pyrodeckConfig.get().processPriority,
    platform: process.platform,
    last: lastPriority,
  }));

  /** PUT /api/process-priority  { priorityClass }: save, and apply to the running server now. */
  app.put("/api/process-priority", async (request, reply) => {
    const { priorityClass } = (request.body ?? {}) as { priorityClass?: unknown };
    if (!isPriorityClass(priorityClass)) {
      return reply.status(400).send({ error: "priorityClass must be below-normal, normal, above-normal or high." });
    }
    await pyrodeckConfig.save({ processPriority: priorityClass });
    const launchedProcess = serverRegistry.getDefault().process;
    const pid = launchedProcess.getStatus().pid;
    const applied = pid !== null && launchedProcess.isRunning() ? await applyConfiguredPriority(pid, false) : null;
    return { priorityClass, platform: process.platform, last: applied ?? lastPriority };
  });
}
