import { useCallback, useMemo, useSyncExternalStore } from "react";
import { buildHash, parseHash, serverOfRoute, tabOf, withServer, type Route, type Tab } from "../lib/hashRoute.ts";

/**
 * How deep the current history entry sits above its tab root, kept in
 * `history.state` so the browser's own back button keeps it right.
 */
function depthOf(): number {
  const state = window.history.state as { pyrodeckDepth?: number } | null;
  return typeof state?.pyrodeckDepth === "number" ? state.pyrodeckDepth : 0;
}

const listeners = new Set<() => void>();
function emit(): void {
  for (const l of listeners) l();
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  window.addEventListener("popstate", onChange);
  window.addEventListener("hashchange", onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("popstate", onChange);
    window.removeEventListener("hashchange", onChange);
  };
}

export interface NavigateOptions {
  /** Replace the current history entry instead of pushing one. Tab roots do this. */
  replace?: boolean;
}

export interface HashRouter {
  route: Route;
  tab: Tab;
  navigate: (path: readonly string[] | string, params?: Record<string, string>, options?: NavigateOptions) => void;
  /** To the screen below, or the tab root when this entry was opened directly. */
  back: () => void;
}

/** Write the hash without a history entry (the server on screen changed), and tell the store. */
export function replaceHash(hash: string): void {
  if (hash === window.location.hash) return;
  window.history.replaceState(window.history.state, "", hash);
  emit();
}

/**
 * The hash as a React external store. Tab taps `replace` (so back from a
 * root leaves the app, like a native app), stacked screens push, and `back()`
 * walks history when there is somewhere to go and otherwise jumps to the
 * tab's root (a deep link or a reload landed here).
 */
export function useHashRoute(): HashRouter {
  const hash = useSyncExternalStore(
    subscribe,
    () => window.location.hash,
    () => "",
  );
  const route = useMemo(() => parseHash(hash), [hash]);
  const tab = tabOf(route);

  const navigate = useCallback(
    (path: readonly string[] | string, params?: Record<string, string>, options?: NavigateOptions) => {
      let target = typeof path === "string" ? (path.startsWith("#") ? path : `#${path}`) : buildHash(path, params);
      // Every screen stays on the server on screen: carry its `s` along.
      const server = serverOfRoute(parseHash(window.location.hash));
      if (server && !serverOfRoute(parseHash(target))) target = withServer(target, server);
      if (target === window.location.hash) return;
      if (options?.replace) {
        window.history.replaceState({ pyrodeckDepth: 0 }, "", target);
      } else {
        window.history.pushState({ pyrodeckDepth: depthOf() + 1 }, "", target);
      }
      emit();
    },
    [],
  );

  const back = useCallback(() => {
    if (depthOf() > 0) {
      window.history.back();
      return;
    }
    const current = parseHash(window.location.hash);
    navigate([tabOf(current)], undefined, { replace: true });
  }, [navigate]);

  return { route, tab, navigate, back };
}
