/**
 * The server ended this browser's login session (logout elsewhere, "log out all
 * sessions", its lifetime or idle timeout, a Pyrodeck restart). useAuth listens
 * and shows the login page.
 */
export const SESSION_ENDED_EVENT = "pyrodeck:session-ended";

/** WebSocket close code the server uses when the session that opened the socket ends. */
export const WS_SESSION_ENDED = 4401;

export function notifySessionEnded(): void {
  window.dispatchEvent(new Event(SESSION_ENDED_EVENT));
}

/** True when /api/auth/check says a password is set and this browser has no live session. */
export async function sessionIsGone(): Promise<boolean> {
  try {
    const res = await fetch("/api/auth/check", { credentials: "include" });
    if (res.status !== 401) return false;
    const body = (await res.json().catch(() => ({}))) as { required?: boolean };
    return body.required === true;
  } catch {
    return false; // Pyrodeck unreachable (restarting): keep trying
  }
}

export interface SessionView {
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  idleExpiresAt: number;
  ip: string | null;
  userAgent: string | null;
  current: boolean;
}

export interface SessionsState {
  ttlHours: number;
  idleMinutes: number;
  sessions: SessionView[];
}
