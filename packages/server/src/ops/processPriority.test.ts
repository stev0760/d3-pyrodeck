import { describe, it, expect } from "vitest";
import os from "node:os";
import { applyPriority, isPriorityClass, priorityValue, type PriorityDeps } from "./processPriority.js";

/** A setPriority that records calls and fails with the given libuv code for some IDs. */
function fakeDeps(threads: number[] | null, failWith: Record<number, string> = {}, nice: Record<number, number> = {}) {
  const calls: [number, number][] = [];
  const deps: PriorityDeps = {
    getPriority: (pid) => nice[pid] ?? 0,
    setPriority: (pid, value) => {
      if (failWith[pid]) {
        throw Object.assign(new Error(`uv_os_setpriority returned ${failWith[pid]}`), {
          code: "ERR_SYSTEM_ERROR",
          info: { code: failWith[pid] },
        });
      }
      calls.push([pid, value]);
    },
    listThreads: async () => threads,
  };
  return { calls, deps };
}

describe("priority classes", () => {
  it("map to Node's priority constants (Windows priority classes of the same names)", () => {
    expect(priorityValue("below-normal")).toBe(os.constants.priority.PRIORITY_BELOW_NORMAL);
    expect(priorityValue("normal")).toBe(0);
    expect(priorityValue("above-normal")).toBe(os.constants.priority.PRIORITY_ABOVE_NORMAL);
    expect(priorityValue("high")).toBe(os.constants.priority.PRIORITY_HIGH);
    expect([10, 0, -7, -14]).toEqual(["below-normal", "normal", "above-normal", "high"].map((c) => priorityValue(c as never)));
  });

  it("accepts only the four classes", () => {
    expect(isPriorityClass("high")).toBe(true);
    expect(isPriorityClass("realtime")).toBe(false);
    expect(isPriorityClass(undefined)).toBe(false);
  });
});

describe("applyPriority", () => {
  it("sets every thread of the process (Linux lists them)", async () => {
    const { calls, deps } = fakeDeps([100, 101, 102]);
    const result = await applyPriority(100, "below-normal", deps);
    expect(calls).toEqual([
      [100, 10],
      [101, 10],
      [102, 10],
    ]);
    expect(result).toMatchObject({ applied: 3, warning: null });
  });

  it("leaves a thread that runs below the main thread on purpose (SDL's PulseHotplug at 19)", async () => {
    const { calls, deps } = fakeDeps([100, 101, 102], {}, { 100: 0, 101: 0, 102: 19 });
    const result = await applyPriority(100, "below-normal", deps);
    expect(calls).toEqual([
      [100, 10],
      [101, 10],
    ]);
    expect(result).toMatchObject({ applied: 2, warning: null });
    // A thread below the main one but above the target follows it down.
    const second = fakeDeps([100, 102], {}, { 100: 0, 102: 5 });
    await applyPriority(100, "below-normal", second.deps);
    expect(second.calls).toEqual([
      [100, 10],
      [102, 10],
    ]);
  });

  it("sets the process itself where threads cannot be listed", async () => {
    const { calls, deps } = fakeDeps(null);
    await applyPriority(200, "high", deps);
    expect(calls).toEqual([[200, -14]]);
  });

  it("turns a refusal (EACCES/EPERM) into a warning, not a throw", async () => {
    const { deps } = fakeDeps([300, 301], { 300: "EACCES", 301: "EACCES" });
    const result = await applyPriority(300, "high", deps);
    expect(result.applied).toBe(0);
    expect(result.warning).toMatch(/permission denied/);
    expect(result.warning).toMatch(/keeps running/);
    const eperm = await applyPriority(300, "above-normal", fakeDeps(null, { 300: "EPERM" }).deps);
    expect(eperm.warning).toMatch(/permission denied/);
  });

  it("says nothing when the process exited meanwhile", async () => {
    const result = await applyPriority(400, "below-normal", fakeDeps(null, { 400: "ESRCH" }).deps);
    expect(result).toMatchObject({ applied: 0, warning: null });
  });
});
