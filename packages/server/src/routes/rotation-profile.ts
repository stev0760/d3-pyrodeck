import { ServerProfileManager } from "../config/ServerProfile.js";
import { pyrodeckConfig } from "./pyrodeck-config.js";
import type { ServerInstance } from "../servers/ServerInstance.js";

const CONFIG_DIR = process.env.PYRODECK_CONFIG_DIR ?? "./config";

/**
 * The game path and config file a server's playlist runs against: its
 * profile's; the global dedicated.cfg for the server without a profile.
 */
export async function serverPlaylistProfile(
  server: Pick<ServerInstance, "profileId">,
): Promise<{ gamePath: string; configFile: string } | null> {
  if (server.profileId === null) {
    const gamePath = pyrodeckConfig.get().gamePath;
    return gamePath ? { gamePath, configFile: "dedicated.cfg" } : null;
  }
  return resolveRotationProfile(server.profileId);
}

/**
 * Resolve the profile a playlist would rotate against: an explicit profileId
 * if given, else the most recently launched (what a server not bound to a
 * profile rotates, servers/ServerInstance.ts rotationTarget). Returns null
 * when nothing is resolvable — callers then skip what needs it rather than
 * block.
 */
export async function resolveRotationProfile(
  profileId?: string,
): Promise<{ gamePath: string; configFile: string } | null> {
  const globalGamePath = pyrodeckConfig.get().gamePath;
  const metadataManager = new ServerProfileManager(CONFIG_DIR, "");
  try {
    const profiles = await metadataManager.list();
    if (profiles.length === 0) return null;
    const profile =
      (profileId && profiles.find((p) => p.id === profileId)) ||
      profiles
        .filter((p) => p.lastLaunchedAt)
        .sort((a, b) => (b.lastLaunchedAt ?? "").localeCompare(a.lastLaunchedAt ?? ""))[0] ||
      profiles[0];
    const gamePath = profile.gamePath ?? globalGamePath;
    if (!gamePath) return null;
    return { gamePath, configFile: profile.configFile };
  } catch {
    return null;
  }
}
