import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { randomBytes } from "node:crypto";
import { buildLogFilename } from "./logPaths.js";
import {
  DEFAULT_LOG_RETENTION,
  RECOMMENDED_LOG_RETENTION,
  UNBOUNDED_WARN_BYTES,
  LogRetentionService,
  effectiveLogRetention,
  gzipLog,
  parseLogRetentionEnv,
  pyrodeckLogKind,
  runLogRetention,
  sanitizeStoredLogRetention,
  validateLogRetention,
  type LogRetentionSettings,
} from "./logRetention.js";

const DAY = 86_400_000;
const MB = 1024 * 1024;
const NOW = Date.parse("2026-10-08T12:00:00Z");

describe("pyrodeckLogKind", () => {
  it("recognises every name buildLogFilename makes", () => {
    for (const label of ["testing", "CTF Night #2", "a".repeat(80), "---", "über-server", "x_y-z 9"]) {
      const name = buildLogFilename(label, new Date("2026-06-17T22:20:31.434Z"));
      expect(pyrodeckLogKind(name), name).toBe("log");
      expect(pyrodeckLogKind(`${name}.gz`), name).toBe("gz");
      expect(pyrodeckLogKind(`${name}.gz.partial`), name).toBe("partial");
    }
  });

  it.each([
    "server.log",
    "navrouting11-ctf-overnight.log",
    "Descent3.log",
    "testing-2026-06-17.log",
    "Testing-2026-06-17T22-20-31.log",
    "testing-2026-06-17T22:20:31.log",
    "testing-2026-06-17T22-20-31.log.bak",
    "testing-2026-06-17T22-20-31.txt",
    "testing-2026-06-17T22-20-31.log.zip",
    "testing-2026-02-31T22-20-31.log",
    "testing-2026-06-17T25-20-31.log",
    "-2026-06-17T22-20-31.log",
    "dedicated.cfg",
    "d3.hog",
  ])("leaves %s alone", (name) => {
    expect(pyrodeckLogKind(name)).toBeNull();
  });
});

describe("settings", () => {
  it("is off by default; 30 days, 2048 MB and compression are the recommended values", () => {
    expect(DEFAULT_LOG_RETENTION).toEqual({ days: 0, maxMb: 0, compress: false });
    expect(RECOMMENDED_LOG_RETENTION).toEqual({ days: 30, maxMb: 2048, compress: true });
    expect(UNBOUNDED_WARN_BYTES).toBe(1024 ** 3);
    expect(sanitizeStoredLogRetention(undefined)).toEqual(DEFAULT_LOG_RETENTION);
    expect(sanitizeStoredLogRetention({ days: -3, maxMb: "x", compress: "yes" })).toEqual(DEFAULT_LOG_RETENTION);
    expect(sanitizeStoredLogRetention({ days: 0, maxMb: 0, compress: false })).toEqual({ days: 0, maxMb: 0, compress: false });
  });

  it("validates the Logs tab's values", () => {
    expect(validateLogRetention({ days: 7, maxMb: 500, compress: true })).toEqual({ settings: { days: 7, maxMb: 500, compress: true } });
    expect(validateLogRetention({ days: 1.5, maxMb: 500, compress: true })).toHaveProperty("error");
    expect(validateLogRetention({ days: 7, maxMb: -1, compress: true })).toHaveProperty("error");
    expect(validateLogRetention({ days: 7, maxMb: 500 })).toHaveProperty("error");
  });

  it("reads the three variables, unset meaning the Logs tab decides", () => {
    expect(parseLogRetentionEnv({})).toEqual({ days: null, maxMb: null, compress: null });
    expect(parseLogRetentionEnv({ PYRODECK_LOG_RETENTION_DAYS: " 14 ", PYRODECK_LOG_MAX_MB: "0" })).toEqual({
      days: 14,
      maxMb: 0,
      compress: null,
    });
    for (const on of ["1", "true", "YES", "on"]) expect(parseLogRetentionEnv({ PYRODECK_LOG_COMPRESS: on }).compress).toBe(true);
    for (const off of ["0", "false", "no", "Off"]) expect(parseLogRetentionEnv({ PYRODECK_LOG_COMPRESS: off }).compress).toBe(false);
  });

  it.each([
    ["PYRODECK_LOG_RETENTION_DAYS", "-1"],
    ["PYRODECK_LOG_RETENTION_DAYS", "7.5"],
    ["PYRODECK_LOG_RETENTION_DAYS", "a week"],
    ["PYRODECK_LOG_RETENTION_DAYS", "4000"],
    ["PYRODECK_LOG_MAX_MB", "2G"],
    ["PYRODECK_LOG_MAX_MB", "99999999"],
    ["PYRODECK_LOG_COMPRESS", "gzip"],
  ])("refuses %s=%s at startup", (name, value) => {
    expect(() => parseLogRetentionEnv({ [name]: value })).toThrow(new RegExp(name));
  });

  it("lets the environment win over the stored settings", () => {
    const stored = { days: 7, maxMb: 100, compress: false };
    expect(effectiveLogRetention(stored, { days: null, maxMb: null, compress: null })).toEqual(stored);
    expect(effectiveLogRetention(stored, { days: 90, maxMb: 0, compress: true })).toEqual({ days: 90, maxMb: 0, compress: true });
  });
});

describe("runLogRetention on a directory", () => {
  let dir: string;
  let outside: string;
  const info = vi.fn<(m: string) => void>();
  const warn = vi.fn<(m: string) => void>();
  const log = { info, warn };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "pyrodeck-retention-"));
    outside = await fs.mkdtemp(path.join(os.tmpdir(), "pyrodeck-retention-outside-"));
    info.mockReset();
    warn.mockReset();
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });

  /** Write a file whose last write was `ageDays` before NOW. */
  async function put(name: string, content: string | Buffer, ageDays: number, where = dir): Promise<string> {
    const full = path.join(where, name);
    await fs.writeFile(full, content);
    const t = new Date(NOW - ageDays * DAY);
    await fs.utimes(full, t, t);
    return full;
  }

  const logName = (label: string, day: number) =>
    buildLogFilename(label, new Date(Date.UTC(2026, 8, day, 10, 0, 0)));

  async function names(where = dir): Promise<string[]> {
    return (await fs.readdir(where)).sort();
  }

  function run(settings: Partial<LogRetentionSettings>, activeLogPath: string | null = null) {
    return runLogRetention({
      dirs: [dir],
      settings: { days: 0, maxMb: 0, compress: false, ...settings },
      activeLogPath,
      log,
      now: NOW,
    });
  }

  /** A file of `bytes` that takes no disk space (sparse), last written `ageDays` before NOW. */
  async function putSparse(name: string, bytes: number, ageDays: number): Promise<string> {
    const full = path.join(dir, name);
    const handle = await fs.open(full, "w");
    await handle.truncate(bytes);
    await handle.close();
    const t = new Date(NOW - ageDays * DAY);
    await fs.utimes(full, t, t);
    return full;
  }

  it("does nothing with the defaults, however old and large the logs", async () => {
    const files = [
      await put(logName("ancient", 1), "first soak\n".repeat(50_000), 900),
      await put(`${logName("packed", 2)}.gz`, Buffer.from([0x1f, 0x8b, 0x08]), 400),
      await put(logName("big", 3), Buffer.alloc(3 * MB, "x"), 60),
      await putSparse(logName("huge", 4), 1100 * MB, 45),
      await put(logName("closed", 5), "closed an hour ago\n", 1 / 24),
    ];
    const before = await Promise.all(files.map(async (f) => [f, (await fs.stat(f)).size, (await fs.stat(f)).mtimeMs]));

    const result = await run({ ...DEFAULT_LOG_RETENTION });

    expect(result).toMatchObject({ deleted: 0, compressed: 0, freedBytes: 0, files: 5, errors: [] });
    const after = await Promise.all(files.map(async (f) => [f, (await fs.stat(f)).size, (await fs.stat(f)).mtimeMs]));
    expect(after).toEqual(before);
    expect(await names()).toEqual(files.map((f) => path.basename(f)).sort());
    expect(info).not.toHaveBeenCalled();
  });

  it("with retention off, warns once Pyrodeck's logs pass 1 GB, naming the total, the directory and the variables", async () => {
    await putSparse(logName("a", 1), 512 * MB, 10);
    await putSparse(`${logName("b", 2)}.gz`, 512 * MB, 9); // exactly 1 GB: not more than
    await putSparse("unrelated.log", 4096 * MB, 9); // not Pyrodeck's: not counted

    expect((await run({ ...DEFAULT_LOG_RETENTION })).warning).toBeNull();
    expect(warn).not.toHaveBeenCalled();

    await put(logName("c", 3), "one more line\n", 1);
    const result = await run({ ...DEFAULT_LOG_RETENTION });

    expect(result.warning).toMatch(/^Log retention is off and Pyrodeck's logs take 1\.0 GB in /);
    expect(result.warning).toContain(dir);
    expect(result.warning).toMatch(/PYRODECK_LOG_RETENTION_DAYS and PYRODECK_LOG_MAX_MB/);
    expect(warn).toHaveBeenCalledWith(result.warning);
    expect(result).toMatchObject({ deleted: 0, compressed: 0 });
  });

  it("warns with compression alone too, since nothing bounds the total, and not once a limit is set", async () => {
    await put(logName("a", 1), randomBytes(2 * MB), 10); // gzip cannot shrink it under the 1 MB used here
    const compressOnly = await runLogRetention({
      dirs: [dir],
      settings: { days: 0, maxMb: 0, compress: true },
      activeLogPath: null,
      log,
      now: NOW,
      warnAboveBytes: MB,
    });
    expect(compressOnly.warning).not.toBeNull();
    await put(logName("b", 2), Buffer.alloc(2 * MB, "y"), 10);
    for (const settings of [
      { days: 30, maxMb: 0, compress: false },
      { days: 0, maxMb: 2048, compress: false },
    ]) {
      const result = await runLogRetention({ dirs: [dir], settings, activeLogPath: null, log, now: NOW, warnAboveBytes: MB });
      expect(result.warning).toBeNull();
    }
  });

  it("applies the recommended values once they are set", async () => {
    const content = "Opening level 1\n".repeat(5000);
    await put(logName("old", 1), content, 45);
    const closed = await put(logName("week", 2), content, 7);
    const running = await put(logName("live", 3), content, 0.5);

    const result = await run({ ...RECOMMENDED_LOG_RETENTION }, running);

    expect(result).toMatchObject({ deleted: 1, compressed: 1, warning: null });
    expect(await names()).toEqual([`${logName("week", 2)}.gz`, logName("live", 3)].sort());
    expect(gunzipSync(await fs.readFile(`${closed}.gz`)).toString()).toBe(content);
  });

  it("deletes Pyrodeck's logs older than the retention days and nothing else, however old", async () => {
    const old = await put(logName("testing", 1), "old run\n", 40);
    const oldGz = await put(`${logName("ctf", 2)}.gz`, Buffer.from([0x1f, 0x8b]), 45);
    const recent = await put(logName("testing", 20), "recent run\n", 20);
    // The game folder's own files and anything not named like Pyrodeck's logs.
    const foreign = [
      await put("server.log", "game log\n", 400),
      await put("navrouting11-ctf-overnight.log", "soak\n", 400),
      await put("Testing-2026-09-01T10-00-00.log", "capitalised\n", 400),
      await put(`${logName("testing", 3)}.bak`, "backup\n", 400),
      await put("dedicated.cfg", "PPS=12\n", 400),
      await put("d3.hog", Buffer.alloc(64), 400),
    ];

    const result = await run({ days: 30 });

    expect(result.deleted).toBe(2);
    await expect(fs.access(old)).rejects.toThrow();
    await expect(fs.access(oldGz)).rejects.toThrow();
    await fs.access(recent);
    for (const f of foreign) await fs.access(f);
    expect(info.mock.calls.filter(([m]) => m.includes("deleted")).length).toBe(2);
    expect(info.mock.calls.every(([m]) => m.startsWith("Log retention:"))).toBe(true);
  });

  it("never follows or removes a symlink or a directory named like a log", async () => {
    const target = await put("precious.log", "not Pyrodeck's\n", 400, outside);
    await fs.symlink(target, path.join(dir, logName("linked", 1)));
    await fs.mkdir(path.join(dir, logName("folder", 1)));
    const t = new Date(NOW - 400 * DAY);
    await fs.lutimes(path.join(dir, logName("linked", 1)), t, t);
    await fs.utimes(path.join(dir, logName("folder", 1)), t, t);

    const result = await run({ days: 1, maxMb: 1, compress: true });

    expect(result).toMatchObject({ deleted: 0, compressed: 0 });
    expect(await names()).toEqual([logName("folder", 1), logName("linked", 1)].sort());
    expect(await fs.readFile(target, "utf-8")).toBe("not Pyrodeck's\n");
  });

  it("gzips closed logs in place, keeping their content and modification time", async () => {
    const content = "Opening level 1\n".repeat(5000);
    const closed = await put(logName("testing", 10), content, 3);
    const before = await fs.stat(closed);

    const result = await run({ compress: true });

    expect(result.compressed).toBe(1);
    expect(await names()).toEqual([`${logName("testing", 10)}.gz`]);
    const gz = await fs.stat(`${closed}.gz`);
    expect(gz.mtimeMs).toBe(before.mtimeMs);
    expect(gz.size).toBeLessThan(before.size / 10);
    expect(gunzipSync(await fs.readFile(`${closed}.gz`)).toString()).toBe(content);
    expect(result.freedBytes).toBe(before.size - gz.size);
    expect(info.mock.calls.some(([m]) => /compressed .*testing-.*\.log \(/.test(m))).toBe(true);
  });

  it("never compresses or deletes the running server's log, nor one written in the last ten minutes", async () => {
    // Both old enough, big enough and closed-looking enough to be pruned or
    // compressed, were they not open.
    const running = await put(logName("live", 1), Buffer.alloc(MB + 1, "a"), 400);
    const justStopped = path.join(dir, logName("stopped", 30));
    await fs.writeFile(justStopped, Buffer.alloc(MB, "b"));
    const minuteAgo = new Date(NOW - 60_000);
    await fs.utimes(justStopped, minuteAgo, minuteAgo);

    const result = await run({ days: 1, maxMb: 1, compress: true }, running);

    expect(result).toMatchObject({ deleted: 0, compressed: 0 });
    expect(await names()).toEqual([logName("live", 1), logName("stopped", 30)].sort());
  });

  it("deletes the oldest logs first until Pyrodeck's logs fit the size cap", async () => {
    const mb = Buffer.alloc(MB, "x");
    await put(logName("a", 1), mb, 10);
    await put(`${logName("b", 2)}.gz`, mb, 9);
    await put(logName("c", 3), mb, 8);
    await put(logName("d", 4), mb, 7);
    await put("unrelated.log", Buffer.alloc(5 * MB), 100); // not counted, not touched

    const result = await run({ maxMb: 2 });

    expect(result.deleted).toBe(2);
    expect(await names()).toEqual([logName("c", 3), logName("d", 4), "unrelated.log"].sort());
    expect(result).toMatchObject({ files: 2, totalBytes: 2 * MB });
    expect(info.mock.calls.filter(([m]) => m.includes("over 2 MB")).length).toBe(2);
  });

  it("keeps the running server's log even when it alone is over the cap, and says so", async () => {
    const running = await put(logName("live", 5), Buffer.alloc(3 * MB), 0.5);
    await put(logName("old", 1), Buffer.alloc(MB), 4);

    const result = await run({ maxMb: 2 }, running);

    expect(result.deleted).toBe(1);
    expect(await names()).toEqual([logName("live", 5)]);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/over the 2 MB cap/));
  });

  it("prunes by age, then compresses, then caps the size of what is left", async () => {
    const text = (n: number) => `${"x".repeat(80)}\n`.repeat(n);
    await put(logName("ancient", 1), text(10_000), 60);
    await put(logName("week", 2), text(30_000), 7); // 2.4 MB each: over the 2 MB cap together,
    await put(logName("day", 3), text(30_000), 1); // a few KB each once compressed

    const result = await run({ days: 30, maxMb: 2, compress: true });

    expect(result).toMatchObject({ deleted: 1, compressed: 2, files: 2 });
    expect(await names()).toEqual([`${logName("day", 3)}.gz`, `${logName("week", 2)}.gz`].sort());
  });

  it("does nothing with every limit off", async () => {
    await put(logName("keep", 1), "x\n", 4000);
    const result = await run({ days: 0, maxMb: 0, compress: false });
    expect(result).toMatchObject({ deleted: 0, compressed: 0, files: 1 });
    expect(info).not.toHaveBeenCalled();
  });

  it("removes a compression a stopped Pyrodeck left unfinished, but not one in progress", async () => {
    await put(logName("x", 1), "log\n", 2);
    await put(`${logName("x", 1)}.gz.partial`, Buffer.from([0x1f]), 2);
    const inProgress = path.join(dir, `${logName("y", 2)}.gz.partial`);
    await fs.writeFile(inProgress, Buffer.from([0x1f]));
    const now = new Date(NOW);
    await fs.utimes(inProgress, now, now);

    await run({});

    expect(await names()).toEqual([logName("x", 1), `${logName("y", 2)}.gz.partial`].sort());
  });

  it("looks in each directory once and skips one that does not exist", async () => {
    await put(logName("a", 1), "x\n", 40);
    const result = await runLogRetention({
      dirs: [dir, `${dir}/`, path.join(dir, "missing")],
      settings: { days: 30, maxMb: 0, compress: false },
      activeLogPath: null,
      log,
      now: NOW,
    });
    expect(result).toMatchObject({ deleted: 1, errors: [] });
  });
});

describe("gzipLog", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "pyrodeck-gzip-"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("replaces a stale .gz of the same name and leaves no .partial behind", async () => {
    const src = path.join(dir, "testing-2026-09-01T10-00-00.log");
    await fs.writeFile(src, "new content\n");
    await fs.writeFile(`${src}.gz`, "stale");
    const size = await gzipLog(src);
    expect(size).toBeGreaterThan(0);
    expect(await fs.readdir(dir)).toEqual(["testing-2026-09-01T10-00-00.log.gz"]);
    expect(gunzipSync(await fs.readFile(`${src}.gz`)).toString()).toBe("new content\n");
  });

  it("keeps the original when compression fails", async () => {
    const src = path.join(dir, "testing-2026-09-01T10-00-00.log");
    await fs.writeFile(src, "content\n");
    await fs.mkdir(`${src}.gz.partial`); // the .partial cannot be written
    await expect(gzipLog(src)).rejects.toThrow();
    expect(await fs.readFile(src, "utf-8")).toBe("content\n");
  });
});

describe("LogRetentionService", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs shortly after start and then every hour", async () => {
    vi.useFakeTimers();
    const dirs = vi.fn(() => [] as string[]);
    const service = new LogRetentionService({
      dirs,
      activeLogPath: () => null,
      settings: () => DEFAULT_LOG_RETENTION,
      log: { info: () => {}, warn: () => {} },
    });
    service.start();
    await vi.advanceTimersByTimeAsync(4999);
    expect(dirs).toHaveBeenCalledTimes(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(dirs).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(dirs).toHaveBeenCalledTimes(2);
    service.stop();
    await vi.advanceTimersByTimeAsync(3 * 60 * 60_000);
    expect(dirs).toHaveBeenCalledTimes(2);
    expect(service.getLastResult()).toMatchObject({ deleted: 0, compressed: 0, errors: [] });
  });

  it("joins a run already going instead of starting a second", async () => {
    const dirs = vi.fn(() => [] as string[]);
    const service = new LogRetentionService({
      dirs,
      activeLogPath: () => null,
      settings: () => DEFAULT_LOG_RETENTION,
      log: { info: () => {}, warn: () => {} },
    });
    const [a, b] = [service.runNow(), service.runNow()];
    expect(a).toBe(b);
    await a;
    await service.runNow();
    expect(dirs).toHaveBeenCalledTimes(2);
  });

  it("runs again with new settings when they change during a run", async () => {
    let days = 30;
    const seen: number[] = [];
    const service = new LogRetentionService({
      dirs: () => [],
      activeLogPath: () => null,
      settings: () => {
        seen.push(days);
        return { ...DEFAULT_LOG_RETENTION, days };
      },
      log: { info: () => {}, warn: () => {} },
    });
    const first = service.runNow();
    days = 7;
    await service.runAfterChange();
    await first;
    expect(seen).toEqual([30, 7]);
  });

  it("reports a failed run instead of throwing", async () => {
    const warn = vi.fn();
    const service = new LogRetentionService({
      dirs: () => {
        throw new Error("boom");
      },
      activeLogPath: () => null,
      settings: () => DEFAULT_LOG_RETENTION,
      log: { info: () => {}, warn },
    });
    expect((await service.runNow()).errors).toEqual(["boom"]);
    expect(warn).toHaveBeenCalledWith("Log retention failed: boom");
    expect((await service.runNow()).errors).toEqual(["boom"]); // not stuck on the failed run
  });
});
