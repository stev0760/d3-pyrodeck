/**
 * The result of pointing a playlist's missions at the mission host (server:
 * gamefiles/missionHosting.ts), carried by the playlist status as `downloads`.
 */

/**
 * hosted: pointed at the host now. already: pointed there before. custom: keeps
 * a link set by hand. stock: ships with the game. missing: no such file.
 * error: the link could not be set.
 */
export type HostingOutcome = "hosted" | "already" | "custom" | "stock" | "missing" | "error";

export interface EntryHostingResult {
  entryId: string;
  label: string;
  file: string;
  outcome: HostingOutcome;
  url?: string;
  message?: string;
}

export interface PlaylistDownloads {
  playlistId: string;
  /** Epoch ms. */
  at: number;
  /** "9 hosted, 3 ship with the game, 1 failed"; empty when `notice` is set. */
  summary: string;
  /** Why nothing was hosted (the host serves another missions directory). */
  notice?: string;
  results: EntryHostingResult[];
}

/**
 * The summary line, and one line per mission that needs a look (failed,
 * missing, keeps its own link), each mission once.
 */
export function describeDownloads(d: PlaylistDownloads): { line: string; problems: string[]; warn: boolean } {
  if (d.notice) return { line: `Downloads not hosted: ${d.notice}`, problems: [], warn: true };
  const seen = new Set<string>();
  const problems: string[] = [];
  for (const r of d.results) {
    if (seen.has(r.file) || !(r.outcome === "error" || r.outcome === "missing" || r.outcome === "custom")) continue;
    seen.add(r.file);
    problems.push(`${r.label} (${r.file}): ${r.message ?? r.outcome}`);
  }
  return {
    line: `Downloads: ${d.summary}`,
    problems,
    warn: d.results.some((r) => r.outcome === "error" || r.outcome === "missing"),
  };
}
