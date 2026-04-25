import { useState, useEffect, useCallback } from "react";

interface AuthState {
  authenticated: boolean;
  checking: boolean;
  authRequired: boolean;
  needsSetup: boolean;
}

export function useAuth() {
  const [state, setState] = useState<AuthState>({
    authenticated: false,
    checking: true,
    authRequired: true,
    needsSetup: false,
  });

  useEffect(() => {
    fetch("/api/auth/check", { credentials: "include" })
      .then(async (r) => {
        const data: {
          authenticated?: boolean;
          required?: boolean;
          needsSetup?: boolean;
        } = await r.json().catch(() => ({}));
        setState({
          authenticated: r.ok,
          checking: false,
          authRequired: data.required ?? true,
          needsSetup: data.needsSetup ?? false,
        });
      })
      .catch(() => {
        setState({
          authenticated: false,
          checking: false,
          authRequired: true,
          needsSetup: false,
        });
      });
  }, []);

  const login = useCallback(async (password: string): Promise<boolean> => {
    try {
      const r = await fetch("/api/auth/login", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (r.ok) {
        setState((s) => ({ ...s, authenticated: true, checking: false }));
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }, []);

  const setup = useCallback(
    async (password: string): Promise<{ ok: boolean; error?: string }> => {
      try {
        const r = await fetch("/api/auth/setup", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password }),
        });
        const data = await r.json().catch(() => ({}));
        if (r.ok) {
          setState((s) => ({
            ...s,
            authenticated: true,
            checking: false,
            needsSetup: false,
            authRequired: true,
          }));
          return { ok: true };
        }
        return { ok: false, error: data.error ?? "Setup failed" };
      } catch {
        return { ok: false, error: "Network error" };
      }
    },
    [],
  );

  const logout = useCallback(async () => {
    await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
    setState((s) => ({ ...s, authenticated: false, checking: false }));
  }, []);

  return { ...state, login, setup, logout };
}
