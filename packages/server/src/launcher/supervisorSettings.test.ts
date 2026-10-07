import { describe, it, expect } from "vitest";
import {
  DEFAULT_SUPERVISOR_SETTINGS,
  sanitizeStoredSupervisor,
  validateSupervisorSettings,
} from "./supervisorSettings.js";

describe("supervisor settings", () => {
  it("defaults to D3Server3's behaviour, restart-when-empty off", () => {
    expect(DEFAULT_SUPERVISOR_SETTINGS).toEqual({
      relaunchOnCrash: true,
      hangCheck: true,
      hangProbeAfterSec: 59,
      hangRestartAfterSec: 120,
      emptyRestart: false,
      emptyRestartAfterHours: 24,
      emptyRestartGraceSec: 130,
    });
  });

  it("keeps saved values for fields left out", () => {
    const base = { ...DEFAULT_SUPERVISOR_SETTINGS, emptyRestart: true };
    const check = validateSupervisorSettings({ emptyRestartAfterHours: "6" }, base);
    expect(check.errors).toEqual([]);
    expect(check.settings).toEqual({ ...base, emptyRestartAfterHours: 6 });
  });

  it("refuses bad values with a reason", () => {
    expect(validateSupervisorSettings({ hangProbeAfterSec: 2 }).errors[0]).toMatch(/probe delay/);
    expect(validateSupervisorSettings({ hangProbeAfterSec: 30.5 }).errors[0]).toMatch(/whole number/);
    expect(validateSupervisorSettings({ relaunchOnCrash: "yes" }).errors[0]).toMatch(/true or false/);
    expect(validateSupervisorSettings({ emptyRestartAfterHours: 0 }).errors[0]).toMatch(/uptime limit/);
  });

  it("requires room for the probe to be answered", () => {
    const check = validateSupervisorSettings({ hangProbeAfterSec: 60, hangRestartAfterSec: 65 });
    expect(check.errors[0]).toMatch(/at least 10 s longer/);
  });

  it("falls back to the defaults for a damaged stored value", () => {
    expect(sanitizeStoredSupervisor({ hangProbeAfterSec: -1 })).toEqual(DEFAULT_SUPERVISOR_SETTINGS);
    expect(sanitizeStoredSupervisor({ emptyRestart: true })).toEqual({ ...DEFAULT_SUPERVISOR_SETTINGS, emptyRestart: true });
  });
});
