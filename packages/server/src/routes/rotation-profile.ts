import { ServerProfileManager } from "../config/ServerProfile.js";
import { pyrodeckConfig } from "./pyrodeck-config.js";

const CONFIG_DIR = process.env.PYRODECK_CONFIG_DIR ?? "./config";

/**
 * Resolve the profile a playlist would rotate against: an explicit profileId
 * if given, else the most recently launched (mirrors the rotate handler in
 * servers/ServerInstance.ts). Returns null when nothing is resolvable — callers then skip
 * what needs it rather than block.
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
