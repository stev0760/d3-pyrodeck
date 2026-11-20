import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AUTOEXEC_BLOCK_BEGIN, AUTOEXEC_BLOCK_END, mergeAutoexecBlock, syncAutoexecBlock } from "./autoexecBlock.js";

// A queued state write may still land while the temp directory is being removed (ENOTEMPTY): retry.
const RM_TEMP = { recursive: true, force: true, maxRetries: 10, retryDelay: 20 } as const;

const BLOCK = ["$allowteamchange off", "$setteamname 0 Crimson"];

describe("mergeAutoexecBlock", () => {
  it("appends the block after the operator's lines, which stay as written", () => {
    const operator = "# my settings\n$killmsgfilter simple\n\n  $serverhudnames team\n";
    expect(mergeAutoexecBlock(operator, BLOCK)).toBe(
      [
        "# my settings",
        "$killmsgfilter simple",
        "",
        "  $serverhudnames team",
        "",
        AUTOEXEC_BLOCK_BEGIN,
        ...BLOCK,
        AUTOEXEC_BLOCK_END,
        "",
      ].join("\n"),
    );
  });

  it("is idempotent", () => {
    const once = mergeAutoexecBlock("$killmsgfilter simple\n", BLOCK);
    expect(mergeAutoexecBlock(once, BLOCK)).toBe(once);
    expect(mergeAutoexecBlock(mergeAutoexecBlock(once, BLOCK), BLOCK)).toBe(once);
  });

  it("replaces an older block and keeps operator lines on both sides of it", () => {
    const content = [
      "$killmsgfilter simple",
      AUTOEXEC_BLOCK_BEGIN,
      "$autobalance on",
      AUTOEXEC_BLOCK_END,
      "$statmsgs off",
      "",
    ].join("\n");
    const merged = mergeAutoexecBlock(content, BLOCK);
    expect(merged).toBe(
      ["$killmsgfilter simple", "$statmsgs off", "", AUTOEXEC_BLOCK_BEGIN, ...BLOCK, AUTOEXEC_BLOCK_END, ""].join("\n"),
    );
    expect(merged).not.toContain("$autobalance on");
  });

  it("removes the block when there is nothing to write, leaving the operator's lines", () => {
    const withBlock = mergeAutoexecBlock("$killmsgfilter simple\n", BLOCK);
    expect(mergeAutoexecBlock(withBlock, [])).toBe("$killmsgfilter simple\n");
    expect(mergeAutoexecBlock(mergeAutoexecBlock("", BLOCK), [])).toBe("");
  });

  it("leaves a file without a block untouched when there is nothing to write", () => {
    const content = "$killmsgfilter simple\n\n\n"; // trailing blank lines kept as is
    expect(mergeAutoexecBlock(content, [])).toBe(content);
    expect(mergeAutoexecBlock("no final newline", [])).toBe("no final newline");
  });

  it("keeps Windows line endings", () => {
    const merged = mergeAutoexecBlock("$killmsgfilter simple\r\n", BLOCK);
    expect(merged).toBe(
      ["$killmsgfilter simple", "", AUTOEXEC_BLOCK_BEGIN, ...BLOCK, AUTOEXEC_BLOCK_END, ""].join("\r\n"),
    );
    expect(mergeAutoexecBlock(merged, BLOCK)).toBe(merged);
  });

  it("drops only the marker of an unterminated block, never the operator's lines after it", () => {
    const content = ["$killmsgfilter simple", AUTOEXEC_BLOCK_BEGIN, "$statmsgs off", ""].join("\n");
    expect(mergeAutoexecBlock(content, [])).toBe("$killmsgfilter simple\n$statmsgs off\n");
  });

  it("writes a block alone into an empty file", () => {
    expect(mergeAutoexecBlock("", BLOCK)).toBe([AUTOEXEC_BLOCK_BEGIN, ...BLOCK, AUTOEXEC_BLOCK_END, ""].join("\n"));
  });
});

describe("syncAutoexecBlock", () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "pyrodeck-autoexec-"));
    file = path.join(dir, "autoexec.dmfc");
  });

  afterEach(async () => {
    await fs.rm(dir, RM_TEMP);
  });

  it("creates the file only when there is a block to write", async () => {
    expect(await syncAutoexecBlock(file, [])).toBe("unchanged");
    await expect(fs.access(file)).rejects.toThrow();
    expect(await syncAutoexecBlock(file, BLOCK)).toBe("created");
    expect(await fs.readFile(file, "utf-8")).toContain("$setteamname 0 Crimson");
  });

  it("does not rewrite a file that is already up to date", async () => {
    await fs.writeFile(file, "$killmsgfilter simple\n");
    expect(await syncAutoexecBlock(file, BLOCK)).toBe("written");
    const { mtimeMs } = await fs.stat(file);
    expect(await syncAutoexecBlock(file, BLOCK)).toBe("unchanged");
    expect((await fs.stat(file)).mtimeMs).toBe(mtimeMs);
    expect(await syncAutoexecBlock(file, [])).toBe("written");
    expect(await fs.readFile(file, "utf-8")).toBe("$killmsgfilter simple\n");
  });

  it("refuses a line with a line break", async () => {
    await expect(syncAutoexecBlock(file, ["$autobalance on\n$quit"])).rejects.toThrow(/line break/);
  });
});
