/**
 * Post-start settings: DMFC options that dedicated.cfg cannot hold, applied
 * over the remote console each time Pyrodeck brings a server up (launch and
 * playlist restarts). Stored per profile in Pyrodeck's profiles.json.
 *
 * Commands and arguments as the DMFC source parses them
 * (netgames/dmfc/dmfcinputcommand.cpp):
 *   $serverhudnames full|team|none      max HUD callsign level for clients
 *   $killmsgfilter full|simple|none     death message detail
 *   $autosavelevel on|off               save stats at each level end
 *   $autosavedisconnect on|off          save stats when a player leaves
 *
 * A setting left unset is not sent, so the server keeps its own default.
 */

export type HudNamesLevel = "full" | "team" | "none";
export type KillMsgFilter = "full" | "simple" | "none";

export interface PostStartSettings {
  hudNames?: HudNamesLevel;
  killMsgFilter?: KillMsgFilter;
  autoSaveLevel?: boolean;
  autoSaveDisconnect?: boolean;
}

const HUD_NAMES: readonly HudNamesLevel[] = ["full", "team", "none"];
const KILL_FILTERS: readonly KillMsgFilter[] = ["full", "simple", "none"];

/**
 * Coerce untrusted input into PostStartSettings, keeping only valid values.
 * Returns null when nothing valid is left (no settings stored).
 */
export function sanitizePostStart(raw: unknown): PostStartSettings | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const out: PostStartSettings = {};
  if (typeof r.hudNames === "string" && (HUD_NAMES as readonly string[]).includes(r.hudNames)) {
    out.hudNames = r.hudNames as HudNamesLevel;
  }
  if (typeof r.killMsgFilter === "string" && (KILL_FILTERS as readonly string[]).includes(r.killMsgFilter)) {
    out.killMsgFilter = r.killMsgFilter as KillMsgFilter;
  }
  if (typeof r.autoSaveLevel === "boolean") out.autoSaveLevel = r.autoSaveLevel;
  if (typeof r.autoSaveDisconnect === "boolean") out.autoSaveDisconnect = r.autoSaveDisconnect;
  return Object.keys(out).length > 0 ? out : null;
}

/** The console commands that apply these settings, in a fixed order. */
export function buildPostStartCommands(settings: PostStartSettings | null | undefined): string[] {
  if (!settings) return [];
  const cmds: string[] = [];
  if (settings.hudNames) cmds.push(`$serverhudnames ${settings.hudNames}`);
  if (settings.killMsgFilter) cmds.push(`$killmsgfilter ${settings.killMsgFilter}`);
  if (settings.autoSaveLevel !== undefined) {
    cmds.push(`$autosavelevel ${settings.autoSaveLevel ? "on" : "off"}`);
  }
  if (settings.autoSaveDisconnect !== undefined) {
    cmds.push(`$autosavedisconnect ${settings.autoSaveDisconnect ? "on" : "off"}`);
  }
  return cmds;
}
