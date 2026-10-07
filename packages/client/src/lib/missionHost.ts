/** Mission host settings and state (server: gamefiles/MissionHost.ts, routes/mission-host.ts). */

export interface MissionHostSettings {
  enabled: boolean;
  port: number;
  /** "http://host[:port]" players' clients reach the listener at. */
  publicBaseUrl: string | null;
}

export interface MissionHostStatus {
  enabled: boolean;
  port: number;
  bound: boolean;
  error: string | null;
  publicBaseUrl: string | null;
  missionsDir: string | null;
}

export interface MissionHostState {
  settings: MissionHostSettings;
  status: MissionHostStatus;
}

export interface MissionHostTestResult {
  ok: boolean;
  url: string;
  status: number | null;
  contentLength: number | null;
  bytes: number;
  matches: boolean;
  elapsedMs: number;
  error: string | null;
}

export async function fetchMissionHost(): Promise<MissionHostState | null> {
  try {
    const res = await fetch("/api/mission-host", { credentials: "include" });
    return res.ok ? ((await res.json()) as MissionHostState) : null;
  } catch {
    return null;
  }
}

/** One line for the listener's state. */
export function describeHostStatus(status: MissionHostStatus): string {
  if (!status.enabled) return "Off";
  if (status.bound) return `Listening on port ${status.port}`;
  return `Not listening: ${status.error ?? "unknown error"}`;
}
