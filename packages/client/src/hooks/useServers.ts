import { useCallback, useEffect, useRef, useState } from "react";
import { isActiveState, type ServerList, type ServerRow } from "@/lib/servers";

/**
 * GET /api/servers, kept fresh: every 2 s while a server is up, every 5 s
 * while none is (the supervisor, the schedule or autostart can start one),
 * and soon after any server's process changes state.
 */
export function useServers() {
  const [list, setList] = useState<ServerList | null>(null);
  const [loaded, setLoaded] = useState(false);
  const pendingRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/servers", { credentials: "include" });
      if (res.ok) setList((await res.json()) as ServerList);
    } catch {
      // Pyrodeck unreachable: keep the last list
    } finally {
      setLoaded(true);
    }
  }, []);

  /** A refresh shortly, collapsing a burst of changes into one request. */
  const refreshSoon = useCallback(() => {
    if (pendingRef.current) return;
    pendingRef.current = setTimeout(() => {
      pendingRef.current = null;
      void refresh();
    }, 250);
  }, [refresh]);

  useEffect(() => {
    void refresh();
    return () => {
      if (pendingRef.current) clearTimeout(pendingRef.current);
    };
  }, [refresh]);

  const anyActive = list?.servers.some((s) => isActiveState(s.state)) ?? false;
  useEffect(() => {
    const timer = setInterval(() => void refresh(), anyActive ? 2000 : 5000);
    return () => clearInterval(timer);
  }, [anyActive, refresh]);

  /** Show a process state from the WebSocket at once, before the next list. */
  const setRowState = useCallback((id: string, state: ServerRow["state"]) => {
    setList((prev) =>
      prev ? { ...prev, servers: prev.servers.map((s) => (s.id === id ? { ...s, state } : s)) } : prev,
    );
  }, []);

  return { list, servers: list?.servers ?? [], loaded, refresh, refreshSoon, setRowState };
}
