import { describe, it, expect } from "vitest";
import { UpdateChecker, compareVersions, githubRepoFromUrl, parseVersion, sanitizeStoredUpdate } from "./updateCheck.js";

describe("compareVersions", () => {
  it("orders by major, minor, patch", () => {
    expect(compareVersions("0.4.21", "0.4.20")).toBeGreaterThan(0);
    expect(compareVersions("0.5.0", "0.4.99")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "0.99.99")).toBeGreaterThan(0);
    expect(compareVersions("v0.4.20", "0.4.20")).toBe(0);
  });

  it("puts a pre-release below its release and orders pre-release tags (semver §11)", () => {
    const ordered = [
      "1.0.0-alpha",
      "1.0.0-alpha.1",
      "1.0.0-alpha.beta",
      "1.0.0-beta",
      "1.0.0-beta.2",
      "1.0.0-beta.11",
      "1.0.0-rc.1",
      "1.0.0",
    ];
    for (let i = 0; i < ordered.length - 1; i++) {
      expect(compareVersions(ordered[i], ordered[i + 1])).toBeLessThan(0);
      expect(compareVersions(ordered[i + 1], ordered[i])).toBeGreaterThan(0);
    }
    expect(compareVersions("0.4.21", "0.4.21-dev")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0+build.5", "1.0.0")).toBe(0);
  });

  it("treats anything that is not a version as no difference", () => {
    expect(parseVersion("latest")).toBeNull();
    expect(compareVersions("nightly", "0.4.20")).toBe(0);
  });
});

describe("githubRepoFromUrl", () => {
  it("reads owner and repo from the usual forms", () => {
    const want = { owner: "stev0760", repo: "d3-pyrodeck" };
    expect(githubRepoFromUrl("https://github.com/stev0760/d3-pyrodeck.git")).toEqual(want);
    expect(githubRepoFromUrl("git+https://github.com/stev0760/d3-pyrodeck")).toEqual(want);
    expect(githubRepoFromUrl("git@github.com:stev0760/d3-pyrodeck.git")).toEqual(want);
    expect(githubRepoFromUrl("https://example.org/x/y")).toBeNull();
  });
});

function fakeFetch(responses: (() => Promise<Response>)[]) {
  const urls: string[] = [];
  const impl = (async (input: string | URL | Request) => {
    urls.push(String(input));
    const next = responses.shift();
    if (!next) throw new Error("no more responses");
    return next();
  }) as typeof fetch;
  return { impl, urls };
}

const release = (tag: string, html = `https://github.com/stev0760/d3-pyrodeck/releases/tag/${tag}`) => async () =>
  new Response(JSON.stringify({ tag_name: tag, html_url: html }), { status: 200 });

describe("UpdateChecker", () => {
  const repositoryUrl = "https://github.com/stev0760/d3-pyrodeck.git";

  it("reports a newer release with a link, and caches it for 24 h", async () => {
    let now = 1_000_000;
    const f = fakeFetch([release("v0.4.21"), release("v0.4.22")]);
    const checker = new UpdateChecker({ current: "0.4.20", repositoryUrl, fetchImpl: f.impl, now: () => now });
    const s = await checker.status(true);
    expect(s).toMatchObject({
      latest: "0.4.21",
      available: true,
      url: "https://github.com/stev0760/d3-pyrodeck/releases/tag/v0.4.21",
    });
    expect(f.urls).toEqual(["https://api.github.com/repos/stev0760/d3-pyrodeck/releases/latest"]);
    now += 23 * 3_600_000;
    await checker.status(true);
    expect(f.urls).toHaveLength(1);
    now += 3_600_000;
    expect((await checker.status(true)).latest).toBe("0.4.22");
  });

  it("says nothing for the same or an older release", async () => {
    const same = new UpdateChecker({ current: "0.4.20", repositoryUrl, fetchImpl: fakeFetch([release("v0.4.20")]).impl });
    expect((await same.status(true)).available).toBe(false);
    const older = new UpdateChecker({ current: "0.4.21-dev", repositoryUrl, fetchImpl: fakeFetch([release("v0.4.20")]).impl });
    expect((await older.status(true)).available).toBe(false);
  });

  it("is silent off-line, on a 404, or on a bad tag, and retries after an hour", async () => {
    let now = 0;
    const f = fakeFetch([
      async () => Promise.reject(new TypeError("fetch failed")),
      async () => new Response("{}", { status: 404 }),
      release("latest"),
      release("v0.4.21"),
    ]);
    const checker = new UpdateChecker({ current: "0.4.20", repositoryUrl, fetchImpl: f.impl, now: () => now });
    for (let i = 0; i < 3; i++) {
      expect(await checker.status(true)).toMatchObject({ available: false, latest: null });
      now += 30 * 60_000;
      expect(await checker.status(true)).toMatchObject({ available: false }); // cached failure, no request
      now += 30 * 60_000;
    }
    expect(f.urls).toHaveLength(3);
    expect((await checker.status(true)).available).toBe(true);
  });

  it("links only to the repository's own release pages", async () => {
    const checker = new UpdateChecker({
      current: "0.4.20",
      repositoryUrl,
      fetchImpl: fakeFetch([release("v0.5.0", "https://evil.example/download")]).impl,
    });
    expect((await checker.status(true)).url).toBe("https://github.com/stev0760/d3-pyrodeck/releases");
  });

  it("makes no request when the check is off", async () => {
    const f = fakeFetch([]);
    const checker = new UpdateChecker({ current: "0.4.20", repositoryUrl, fetchImpl: f.impl });
    expect(await checker.status(false)).toMatchObject({ enabled: false, available: false, latest: null });
    expect(f.urls).toEqual([]);
  });

  it("gives up after the timeout", async () => {
    const slow = (async (_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      })) as typeof fetch;
    const checker = new UpdateChecker({ current: "0.4.20", repositoryUrl, fetchImpl: slow, timeoutMs: 20 });
    expect(await checker.status(true)).toMatchObject({ available: false, latest: null });
  });

  it("stored settings default to on", () => {
    expect(sanitizeStoredUpdate(undefined)).toEqual({ enabled: true });
    expect(sanitizeStoredUpdate({ enabled: false })).toEqual({ enabled: false });
  });
});
