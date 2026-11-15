/**
 * Singleton PlaylistManager instance, and the health monitor for the server
 * restarts that rotation performs; the default server
 * (servers/ServerRegistry.ts) rotates with both. Kept in a separate module so
 * that command.ts and the playlist routes reach them without importing the
 * server registry, which imports command.ts.
 */
import { PlaylistManager } from "./PlaylistManager.js";
import { RotationHealthMonitor } from "./RotationHealthMonitor.js";

const CONFIG_DIR = process.env.PYRODECK_CONFIG_DIR ?? "./config";

export const playlistManager = new PlaylistManager(CONFIG_DIR);

export const rotationHealth = new RotationHealthMonitor();

/** Playlist status as sent to clients: the manager's state plus the restart health check. */
export function playlistStatusPayload(): Record<string, unknown> {
  return { ...playlistManager.getStatus(), rotationCheck: rotationHealth.snapshot() };
}
