import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { load } from "js-yaml";

/**
 * .github/workflows/release.yml: it parses, every release (and every dry
 * run) gets SHA256SUMS.txt over all its assets, and the step that writes it
 * produces `sha256sum` output. The step's own script is run here against
 * stand-in packages.
 */

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  "working-directory"?: string;
}
interface Job {
  needs?: string[];
  if?: string;
  steps: Step[];
}
interface Workflow {
  on: Record<string, unknown>;
  jobs: Record<string, Job>;
}

const WORKFLOW_PATH = new URL("../../../.github/workflows/release.yml", import.meta.url);
const workflow = load(fs.readFileSync(WORKFLOW_PATH, "utf-8")) as Workflow;
const sumsStep = workflow.jobs.checksums.steps.find((s) => s.name === "Write SHA256SUMS.txt");

describe("release workflow", () => {
  it("parses, and runs on a v* tag and by hand (the dry run)", () => {
    expect(workflow.on).toHaveProperty("push", { tags: ["v*"] });
    expect(workflow.on).toHaveProperty("workflow_dispatch");
    expect(Object.keys(workflow.jobs).sort()).toEqual(["build-linux", "build-windows", "checksums", "release"]);
  });

  it("writes the checksums after both packages, in dry runs too", () => {
    const job = workflow.jobs.checksums;
    expect(job.needs?.sort()).toEqual(["build-linux", "build-windows"]);
    expect(job.if).toBeUndefined(); // the tag condition is the release job's alone
    const download = job.steps.find((s) => s.uses?.startsWith("actions/download-artifact@"));
    expect(download?.with).toMatchObject({ pattern: "*-release", path: "release", "merge-multiple": true });
    expect(sumsStep?.["working-directory"]).toBe("release");
    expect(sumsStep?.run).toMatch(/sha256sum/);
    const upload = job.steps.find((s) => s.uses?.startsWith("actions/upload-artifact@"));
    expect(upload?.with).toMatchObject({ name: "release-assets", path: "release/" });
  });

  it("publishes, on a tag only, the checksummed directory: packages and SHA256SUMS.txt", () => {
    const job = workflow.jobs.release;
    expect(job.needs).toEqual(["checksums"]);
    expect(job.if).toBe("startsWith(github.ref, 'refs/tags/')");
    const download = job.steps.find((s) => s.uses?.startsWith("actions/download-artifact@"));
    expect(download?.with).toMatchObject({ name: "release-assets", path: "release" });
    const publish = job.steps.find((s) => s.uses?.startsWith("softprops/action-gh-release@"));
    expect(publish?.with?.files).toBe("release/*");
    expect(publish?.with?.body).toMatch(/SHA256SUMS\.txt/);
  });

  it("uploads each package under the *-release name the checksum job collects", () => {
    for (const [job, file] of [
      ["build-linux", "pyrodeck-*-linux-x64.tar.gz"],
      ["build-windows", "pyrodeck-*-windows-x64.zip"],
    ] as const) {
      const upload = workflow.jobs[job].steps.find((s) => s.uses?.startsWith("actions/upload-artifact@"));
      expect(upload?.with?.name, job).toMatch(/-release$/);
      expect(upload?.with?.path, job).toBe(file);
    }
  });
});

const hasTools =
  process.platform !== "win32" &&
  spawnSync("bash", ["--version"]).status === 0 &&
  spawnSync("sha256sum", ["--version"]).status === 0;

describe.skipIf(!hasTools)("the Write SHA256SUMS.txt step", () => {
  let dir: string;
  let assets: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "pyrodeck-sums-"));
    assets = path.join(dir, "release");
    fs.mkdirSync(assets);
    fs.mkdirSync(path.join(dir, "tmp"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const runStep = () =>
    spawnSync("bash", ["-e", "-o", "pipefail", "-c", sumsStep!.run!], {
      cwd: assets,
      env: { PATH: process.env.PATH, RUNNER_TEMP: path.join(dir, "tmp"), GITHUB_STEP_SUMMARY: path.join(dir, "summary.md") },
      encoding: "utf-8",
    });

  it("lists every asset, and only the assets, in sha256sum's format", () => {
    const files = {
      "pyrodeck-v0.5.3-linux-x64.tar.gz": "linux package",
      "pyrodeck-v0.5.3-windows-x64.zip": "windows package",
    };
    for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(assets, name), body);

    const result = runStep();
    expect(result.status, result.stderr).toBe(0);

    const sums = fs.readFileSync(path.join(assets, "SHA256SUMS.txt"), "utf-8");
    const expected = Object.entries(files)
      .map(([name, body]) => `${createHash("sha256").update(body).digest("hex")}  ${name}\n`)
      .sort()
      .join("");
    expect(sums.split(/(?<=\n)/).sort().join("")).toBe(expected);
    // What a user runs on the download:
    expect(execFileSync("sha256sum", ["--check", "--strict", "SHA256SUMS.txt"], { cwd: assets, encoding: "utf-8" })).toMatch(
      /linux-x64\.tar\.gz: OK\n.*windows-x64\.zip: OK\n/s,
    );
    expect(fs.readFileSync(path.join(dir, "summary.md"), "utf-8")).toContain(sums);
  });

  it("fails when a package is missing", () => {
    fs.writeFileSync(path.join(assets, "pyrodeck-v0.5.3-linux-x64.tar.gz"), "only one");
    const result = runStep();
    expect(result.status).not.toBe(0);
    expect(result.stdout).toMatch(/Expected the Linux and Windows packages/);
    expect(fs.existsSync(path.join(assets, "SHA256SUMS.txt"))).toBe(false);
  });
});
