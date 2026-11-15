/**
 * The playlist kept in `<config>/playlist-state.json` and the health monitor
 * of its restarts: those of the server that kept that file when Pyrodeck ran
 * one server (the legacy owner, servers/serverStore.ts), so that an older
 * Pyrodeck finds its playlist where it left it. Every other server has its own
 * (servers/<id>/playlist-state.json). This manager also reads and writes the
 * shared playlist library (playlists.json), which every server's manager
 * reads, for routes that run before the servers exist.
 */
import { PlaylistManager } from "./PlaylistManager.js";
import { RotationHealthMonitor } from "./RotationHealthMonitor.js";

const CONFIG_DIR = process.env.PYRODECK_CONFIG_DIR ?? "./config";

export const playlistManager = new PlaylistManager(CONFIG_DIR);

export const rotationHealth = new RotationHealthMonitor();
