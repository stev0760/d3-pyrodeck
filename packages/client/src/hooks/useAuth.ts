import { useCallback } from "react";

// Auth is disabled for early development.
// The D3 server has its own console password.
// Web admin auth will be added back in a later phase.

export function useAuth() {
  const logout = useCallback(async () => {
    // no-op for now
  }, []);

  return {
    authenticated: true,
    checking: false,
    login: async (_password: string) => true,
    logout,
  };
}
