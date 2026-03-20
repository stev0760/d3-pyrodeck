import { useState, useCallback, useEffect } from "react";

interface AuthState {
  authenticated: boolean;
  checking: boolean;
}

export function useAuth() {
  const [state, setState] = useState<AuthState>({
    authenticated: false,
    checking: true,
  });

  // Check if we have a valid session on mount
  useEffect(() => {
    fetch("/api/server/status", { credentials: "include" })
      .then((res) => {
        setState({ authenticated: res.ok, checking: false });
      })
      .catch(() => {
        setState({ authenticated: false, checking: false });
      });
  }, []);

  const login = useCallback(async (password: string): Promise<boolean> => {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ password }),
    });

    if (res.ok) {
      setState({ authenticated: true, checking: false });
      return true;
    }
    return false;
  }, []);

  const logout = useCallback(async () => {
    await fetch("/api/auth/logout", {
      method: "POST",
      credentials: "include",
    });
    setState({ authenticated: false, checking: false });
  }, []);

  return { ...state, login, logout };
}
