import { useState, useEffect, useCallback } from "react";

interface AuthState {
  authenticated: boolean;
  checking: boolean;
  authRequired: boolean;
}

export function useAuth() {
  const [state, setState] = useState<AuthState>({
    authenticated: false,
    checking: true,
    authRequired: true,
  });

  useEffect(() => {
    fetch("/api/auth/check", { credentials: "include" })
      .then(async (r) => {
        const data: { authenticated?: boolean; required?: boolean } =
          await r.json().catch(() => ({}));
        setState({
          authenticated: r.ok,
          checking: false,
          authRequired: data.required ?? true,
        });
      })
      .catch(() => {
        setState({ authenticated: false, checking: false, authRequired: true });
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

  const logout = useCallback(async () => {
    await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
    setState((s) => ({ ...s, authenticated: false, checking: false }));
  }, []);

  return { ...state, login, logout };
}
