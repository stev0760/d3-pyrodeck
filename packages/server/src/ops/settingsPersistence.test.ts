import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PyrodeckConfigManager } from "../config/PyrodeckConfig.js";
import { DEFAULT_MAIL_SETTINGS } from "./mailSettings.js";

describe("operations settings in pyrodeck.json", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "pyrodeck-ops-"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("defaults to mail off, normal priority and the update check on", async () => {
    const config = await new PyrodeckConfigManager(dir).load();
    expect(config.mail).toEqual(DEFAULT_MAIL_SETTINGS);
    expect(config.processPriority).toBe("normal");
    expect(config.updateCheck).toEqual({ enabled: true });
  });

  it("round-trips the settings and writes the file owner-only", async () => {
    const m = new PyrodeckConfigManager(dir);
    await m.load();
    await m.save({
      mail: { ...DEFAULT_MAIL_SETTINGS, host: "smtp.example.org", password: "hunter2" },
      processPriority: "below-normal",
      updateCheck: { enabled: false },
    });
    const again = await new PyrodeckConfigManager(dir).load();
    expect(again.mail.password).toBe("hunter2");
    expect(again.processPriority).toBe("below-normal");
    expect(again.updateCheck.enabled).toBe(false);
    if (process.platform !== "win32") {
      expect((await fs.stat(path.join(dir, "pyrodeck.json"))).mode & 0o777).toBe(0o600);
    }
  });

  it("loads hand-edited bad values safely", async () => {
    await fs.writeFile(
      path.join(dir, "pyrodeck.json"),
      JSON.stringify({ mail: { enabled: true, host: "" }, processPriority: "realtime", updateCheck: "yes" }),
    );
    const config = await new PyrodeckConfigManager(dir).load();
    expect(config.mail.enabled).toBe(false);
    expect(config.processPriority).toBe("normal");
    expect(config.updateCheck.enabled).toBe(true);
  });
});
