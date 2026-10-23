/**
 * The phone shell's routes live in the URL hash: `#/players/history`,
 * `#/more/config/raw?file=bots.cfg`. A hash needs nothing from the server or
 * a reverse proxy, never collides with `/api`, `/ws` or the mission host, and
 * gives the phone's back button, reload and deep links something to work with.
 *
 * Pure functions here; the React side is hooks/useHashRoute.ts.
 */

export const TABS = ["server", "console", "players", "bots", "more"] as const;
export type Tab = (typeof TABS)[number];

export interface Route {
  /** Path segments, never empty: `#/` and `#` parse to `["server"]`. */
  path: string[];
  params: URLSearchParams;
}

export function parseHash(hash: string): Route {
  let rest = hash.startsWith("#") ? hash.slice(1) : hash;
  if (rest.startsWith("/")) rest = rest.slice(1);
  const q = rest.indexOf("?");
  const pathPart = q === -1 ? rest : rest.slice(0, q);
  const query = q === -1 ? "" : rest.slice(q + 1);
  const path = pathPart
    .split("/")
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    })
    .filter((s) => s.length > 0);
  return { path: path.length > 0 ? path : ["server"], params: new URLSearchParams(query) };
}

export function buildHash(path: readonly string[], params?: Record<string, string> | URLSearchParams): string {
  const segments = path.filter((s) => s.length > 0).map((s) => encodeURIComponent(s));
  const query = params ? new URLSearchParams(params).toString() : "";
  return `#/${segments.join("/")}${query ? `?${query}` : ""}`;
}

/** The bottom tab a route belongs to; anything unknown lands on Server. */
export function tabOf(route: Route): Tab {
  const first = route.path[0];
  return (TABS as readonly string[]).includes(first) ? (first as Tab) : "server";
}

/** A tab's own screen, with nothing stacked on it. */
export function isRoot(route: Route): boolean {
  return route.path.length === 1;
}

export function sameRoute(a: Route, b: Route): boolean {
  return a.path.join("/") === b.path.join("/") && a.params.toString() === b.params.toString();
}
