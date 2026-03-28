/**
 * Parser for $netgameinfo output.
 *
 * Example output (dedicated server):
 *   NetGame Information
 *   Game Name: My Server
 *   Mission Name: Polaris
 *   Script Name: Anarchy
 *   PPS: 20
 *   Max Players: 8
 *   Accurate Weapon Collisions: On
 *   Send Rotational Velocity: On
 *   Time Limit: 10 minutes
 *   Time Left: 7:32
 *   Goal: 25 points
 *   Respawn Time: 5:00
 *   Packet Loss: N/A
 *   Network Model: Client/Server
 *
 * Notes:
 * - Time Limit shows "None" when disabled, otherwise "<n> minute(s)"
 * - Time Left only appears when a time limit is active
 * - Goal shows "None" when disabled, otherwise "<n> points"
 * - PPS on server is always "PPS: <n>", clients see "PPS (Server/You): n/n"
 */

export interface NetGameInfo {
  gameName: string;
  missionName: string;
  scriptName: string;
  pps: number;
  maxPlayers: number;
  accurateCollisions: boolean;
  sendRotationalVelocity: boolean;
  timeLimit: number; // minutes, 0 = none
  timeLeft: string | null; // formatted time string, null if no timer
  goalLimit: number; // 0 = none
  respawnTime: string;
  networkModel: string;
}

export function parseNetgameinfo(raw: string): NetGameInfo | null {
  const lines = raw.split("\n").map((l) => l.trim());

  // Must contain the heading
  if (!lines.some((l) => l.includes("NetGame Information"))) return null;

  const get = (prefix: string): string | undefined => {
    for (const line of lines) {
      if (line.startsWith(prefix)) {
        return line.slice(prefix.length).trim();
      }
    }
    return undefined;
  };

  const gameName = get("Game Name:");
  const missionName = get("Mission Name:");
  const scriptName = get("Script Name:");
  if (!gameName || !missionName || !scriptName) return null;

  // PPS: dedicated server format is "PPS: <n>"
  const ppsRaw = get("PPS:");
  const pps = ppsRaw ? parseInt(ppsRaw, 10) || 0 : 0;

  const maxPlayersRaw = get("Max Players:");
  const maxPlayers = maxPlayersRaw ? parseInt(maxPlayersRaw, 10) || 0 : 0;

  const accurateCollisions = get("Accurate Weapon Collisions:") === "On";
  const sendRotationalVelocity = get("Send Rotational Velocity:") === "On";

  // Time Limit: "None" or "<n> minute(s)"
  const timeLimitRaw = get("Time Limit:");
  let timeLimit = 0;
  if (timeLimitRaw && timeLimitRaw !== "None") {
    const match = timeLimitRaw.match(/^(\d+)/);
    if (match) timeLimit = parseInt(match[1], 10);
  }

  const timeLeft = get("Time Left:") ?? null;

  // Goal: "None" or "<n> points"
  const goalRaw = get("Goal:");
  let goalLimit = 0;
  if (goalRaw && goalRaw !== "None") {
    const match = goalRaw.match(/^(\d+)/);
    if (match) goalLimit = parseInt(match[1], 10);
  }

  const respawnTime = get("Respawn Time:") ?? "0:00";
  const networkModel = get("Network Model:") ?? "Unknown";

  return {
    gameName,
    missionName,
    scriptName,
    pps,
    maxPlayers,
    accurateCollisions,
    sendRotationalVelocity,
    timeLimit,
    timeLeft,
    goalLimit,
    respawnTime,
    networkModel,
  };
}
