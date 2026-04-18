/**
 * Singleton PlaylistManager instance.
 * Kept in a separate module to avoid circular imports between launcher.ts and command.ts.
 */
import { PlaylistManager } from "./PlaylistManager.js";

const CONFIG_DIR = process.env.PYRODECK_CONFIG_DIR ?? "./config";

export const playlistManager = new PlaylistManager(CONFIG_DIR);
