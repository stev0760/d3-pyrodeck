/**
 * Supervisor settings (global, in pyrodeck.json; set via /api/launcher/supervisor).
 * The defaults are D3Server3's: it relaunches a dead server and kills a hung
 * one with no option to turn either off, sends `$players` after 59 s of
 * console silence and kills at 120 s, and restarts on its uptime limit only
 * 130 s after the last player left (docs/D3SERVER3_AUDIT.md, section 2).
 */
export interface SupervisorSettings {
  /** Relaunch the server when its process exits without a stop request. */
  relaunchOnCrash: boolean;
  /** Probe a quiet console and kill and relaunch a server that does not answer. */
  hangCheck: boolean;
  /** Console silence before the probe is sent. */
  hangProbeAfterSec: number;
  /** Console silence after which the server counts as hung (includes the probe wait). */
  hangRestartAfterSec: number;
  /** Restart a server that has run longer than the limit, once nobody is on it. */
  emptyRestart: boolean;
  emptyRestartAfterHours: number;
  /** How long after the last player left before the restart may happen. */
  emptyRestartGraceSec: number;
}

export const DEFAULT_SUPERVISOR_SETTINGS: SupervisorSettings = {
  relaunchOnCrash: true,
  hangCheck: true,
  hangProbeAfterSec: 59,
  hangRestartAfterSec: 120,
  emptyRestart: false,
  emptyRestartAfterHours: 24,
  emptyRestartGraceSec: 130,
};

export interface SupervisorSettingsCheck {
  settings: SupervisorSettings;
  errors: string[];
}

function readNumber(
  r: Record<string, unknown>,
  key: keyof SupervisorSettings,
  fallback: number,
  min: number,
  max: number,
  integer: boolean,
  label: string,
  errors: string[],
): number {
  if (r[key] === undefined) return fallback;
  const n = typeof r[key] === "string" ? Number(r[key]) : r[key];
  if (typeof n !== "number" || !Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) {
    errors.push(`${label} must be ${integer ? "a whole number" : "a number"} from ${min} to ${max}.`);
    return fallback;
  }
  return n;
}

/** Validate untrusted settings input; fields left out keep `base`. On errors, do not save. */
export function validateSupervisorSettings(
  raw: unknown,
  base: SupervisorSettings = DEFAULT_SUPERVISOR_SETTINGS,
): SupervisorSettingsCheck {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const errors: string[] = [];
  const bool = (key: keyof SupervisorSettings, fallback: boolean): boolean => {
    if (r[key] === undefined) return fallback;
    if (typeof r[key] !== "boolean") {
      errors.push(`${key} must be true or false.`);
      return fallback;
    }
    return r[key] as boolean;
  };

  const settings: SupervisorSettings = {
    relaunchOnCrash: bool("relaunchOnCrash", base.relaunchOnCrash),
    hangCheck: bool("hangCheck", base.hangCheck),
    hangProbeAfterSec: readNumber(r, "hangProbeAfterSec", base.hangProbeAfterSec, 10, 3600, true, "The probe delay", errors),
    hangRestartAfterSec: readNumber(r, "hangRestartAfterSec", base.hangRestartAfterSec, 20, 7200, true, "The restart delay", errors),
    emptyRestart: bool("emptyRestart", base.emptyRestart),
    emptyRestartAfterHours: readNumber(r, "emptyRestartAfterHours", base.emptyRestartAfterHours, 0.1, 8760, false, "The uptime limit", errors),
    emptyRestartGraceSec: readNumber(r, "emptyRestartGraceSec", base.emptyRestartGraceSec, 0, 3600, true, "The wait after the last player leaves", errors),
  };
  if (errors.length === 0 && settings.hangRestartAfterSec < settings.hangProbeAfterSec + 10) {
    errors.push("The restart delay must be at least 10 s longer than the probe delay, so the probe can be answered.");
  }
  return { settings, errors };
}

/** Settings as stored in pyrodeck.json, made safe for use (bad values fall back to the defaults). */
export function sanitizeStoredSupervisor(raw: unknown): SupervisorSettings {
  const check = validateSupervisorSettings(raw);
  return check.errors.length === 0 ? check.settings : { ...DEFAULT_SUPERVISOR_SETTINGS };
}
