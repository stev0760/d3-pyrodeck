/**
 * Update notice: compare the running version with the latest GitHub release
 * of Pyrodeck's repository. Read-only: Pyrodeck never downloads or installs
 * anything; the panel shows a link to the release page.
 *
 * GET https://api.github.com/repos/<owner>/<repo>/releases/latest returns the
 * newest published release that is not a draft or a pre-release. Results are
 * cached for 24 h (a failure for 1 h), each request gives up after 5 s, and a
 * failure (offline, rate limit, private repository) only means no notice.
 */

export interface UpdateSettings {
  /** Ask GitHub for the latest release. On by default. */
  enabled: boolean;
}

export const DEFAULT_UPDATE_SETTINGS: UpdateSettings = { enabled: true };

export function sanitizeStoredUpdate(raw: unknown): UpdateSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return { enabled: r.enabled !== false };
}

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  pre: (string | number)[];
}

const SEMVER = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** "v1.2.3-rc.1+build" → parts, or null when it is not a semantic version. */
export function parseVersion(value: string): ParsedVersion | null {
  const m = SEMVER.exec(value.trim());
  if (!m) return null;
  const pre = m[4] ? m[4].split(".").map((id) => (/^\d+$/.test(id) ? Number(id) : id)) : [];
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre };
}

/**
 * Semantic-version precedence (semver.org §11): numbers first; a version with
 * a pre-release tag is lower than the same version without; tags compare
 * identifier by identifier, numbers below strings, a shorter list first.
 * Returns <0, 0 or >0. Unparseable versions compare equal (no notice).
 */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return 0;
  for (const k of ["major", "minor", "patch"] as const) {
    if (x[k] !== y[k]) return x[k] - y[k];
  }
  if (x.pre.length === 0 || y.pre.length === 0) return y.pre.length - x.pre.length;
  for (let i = 0; i < Math.min(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === q) continue;
    if (typeof p === "number" && typeof q === "number") return p - q;
    if (typeof p === "number") return -1;
    if (typeof q === "number") return 1;
    return p < q ? -1 : 1;
  }
  return x.pre.length - y.pre.length;
}

/** owner/repo from a GitHub repository URL (https, git+https, ssh), or null. */
export function githubRepoFromUrl(url: string): { owner: string; repo: string } | null {
  const m = /github\.com[/:]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? { owner: m[1], repo: m[2] } : null;
}

export interface UpdateStatus {
  enabled: boolean;
  current: string;
  /** Latest release version, when the last check got one. */
  latest: string | null;
  /** True when `latest` is newer than `current`. */
  available: boolean;
  /** The release page, always on github.com/<owner>/<repo>/releases. */
  url: string | null;
  checkedAt: string | null;
}

export interface UpdateCheckerOptions {
  current: string;
  repositoryUrl: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  ttlMs?: number;
  failureTtlMs?: number;
  timeoutMs?: number;
}

export class UpdateChecker {
  private cache: { at: number; ok: boolean; latest: string | null; url: string | null } | null = null;
  private inflight: Promise<void> | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly failureTtlMs: number;
  private readonly timeoutMs: number;
  private readonly repo: { owner: string; repo: string } | null;

  constructor(private opts: UpdateCheckerOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
    this.ttlMs = opts.ttlMs ?? 24 * 60 * 60_000;
    this.failureTtlMs = opts.failureTtlMs ?? 60 * 60_000;
    this.timeoutMs = opts.timeoutMs ?? 5_000;
    this.repo = githubRepoFromUrl(opts.repositoryUrl);
  }

  /** The cached result, refreshed from GitHub when it is older than its TTL. */
  async status(enabled: boolean): Promise<UpdateStatus> {
    if (enabled && this.repo) {
      const c = this.cache;
      const stale = !c || this.now() - c.at >= (c.ok ? this.ttlMs : this.failureTtlMs);
      if (stale) {
        this.inflight ??= this.refresh().finally(() => {
          this.inflight = null;
        });
        await this.inflight;
      }
    }
    const c = this.cache;
    const latest = enabled ? c?.latest ?? null : null;
    return {
      enabled,
      current: this.opts.current,
      latest,
      available: latest !== null && compareVersions(latest, this.opts.current) > 0,
      url: enabled ? c?.url ?? null : null,
      checkedAt: enabled && c ? new Date(c.at).toISOString() : null,
    };
  }

  private async refresh(): Promise<void> {
    const { owner, repo } = this.repo!;
    const releases = `https://github.com/${owner}/${repo}/releases`;
    try {
      const res = await this.fetchImpl(`https://api.github.com/repos/${owner}/${repo}/releases/latest`, {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": `d3-pyrodeck/${this.opts.current}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { tag_name?: unknown; html_url?: unknown };
      const tag = typeof body.tag_name === "string" ? body.tag_name : "";
      const parsed = parseVersion(tag);
      if (!parsed) throw new Error("release tag is not a version");
      const version = tag.replace(/^v/, "");
      // Link only to this repository's releases, whatever the API returned.
      const page =
        typeof body.html_url === "string" && body.html_url.startsWith(`${releases}/`) ? body.html_url : releases;
      this.cache = { at: this.now(), ok: true, latest: version, url: page };
    } catch {
      // Off-line, rate-limited, no release yet: silent, retried after failureTtlMs.
      this.cache = { at: this.now(), ok: false, latest: this.cache?.latest ?? null, url: this.cache?.url ?? null };
    }
  }
}
