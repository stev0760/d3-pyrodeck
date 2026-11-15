import type { ServerEvents } from "./ServerEvents.js";

/**
 * One line per event in Pyrodeck's own log: the history D3Server3 kept in
 * its event log. Subscribe once per bus, before any server instance, so that
 * these lines come before what the instance's own listeners log.
 */
export function logServerEvents(bus: ServerEvents): void {
  bus.onEvent("server.started", (e) => console.log(`[Server] started (${e.reason}), pid ${e.pid}`));
  bus.onEvent("server.stopped", (e) =>
    console.log(`[Server] stopped (${e.reason}${e.via ? `, ${e.via}` : ""}), pid ${e.pid}`),
  );
  bus.onEvent("server.crashed", (e) =>
    console.log(`[Server] crashed, pid ${e.pid} (${e.signal ? `signal ${e.signal}` : `exit code ${e.code}`})`),
  );
  bus.onEvent("server.hung", (e) =>
    console.log(`[Server] hung, pid ${e.pid}: console silent ${Math.round(e.silentForMs / 1000)} s`),
  );
  bus.onEvent("server.adopted", (e) => console.log(`[Server] re-attached, pid ${e.pid} (started ${e.startedAt})`));
  bus.onEvent("level.started", (e) => console.log(`[Server] level ${e.level ?? "?"} started`));
  // Humans only, one line per session: player.identified is a new session
  // (not a level re-entry), with the slot and address once looked up.
  bus.onEvent("player.identified", (e) =>
    console.log(
      `[Server] ${e.name} joined${e.slot !== undefined ? `, slot ${e.slot}` : ""}${e.ip ? `, ${e.ip}` : ""}`,
    ),
  );
  bus.onEvent("player.left", (e) => {
    if (!e.bot) console.log(`[Server] ${e.name} left${e.reason ? ` (${e.reason})` : ""}`);
  });
}
