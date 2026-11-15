import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import {
  D3_DEFAULT_GAMESPY_PORT,
  MAX_ENGINE_ARG_BYTES,
  effectivePorts,
  mergeLaunchOptions,
  type LaunchOptions,
} from "../launcher/launchOptions.js";
import { startupFilePath, type LaunchConfig } from "../launcher/ProcessManager.js";

/**
 * What two Descent 3 servers on one machine must not share, checked before
 * every launch (servers/ServerRegistry.ts, under its launch lock):
 *
 * - the game UDP port (-useport, default 2092): the second server's bind
 *   fails and it runs without network (init.cpp:1808, networking.cpp:746);
 * - the GameSpy UDP port (-gamespyport, default 20142, opened on every
 *   launch, gamespy.cpp:144, init.cpp:1883);
 * - the console TCP port (RemoteConsolePort): Pyrodeck would log in to the
 *   other server;
 * - the server config file: a playlist rotation rewrites its MissionName;
 * - the Startup Commands file, when one exists or a launch writes Pyrodeck's
 *   block into it: each launch rewrites it;
 * - the temp directory (-tempdir): the second server exits "Unable to
 *   create lock file" (init.cpp:2040, ddio_CreateLockFile).
 *
 * UDP ports collide only on the same -useip address, or when either server
 * binds every address. A clash between two settings the operator made is
 * refused, never changed. Where the profile sets nothing, Pyrodeck fills in
 * the server's defaults instead: its own temp directory always, and a free
 * GameSpy port when another server holds the default. Log files of the same
 * name get a suffix.
 */

/** Another server's launch, for the checks. */
export interface OtherLaunch {
  name: string;
  launch: LaunchConfig;
  pid: number | null;
  /** Why it holds its launch ("running", ...), for the message. */
  why: string;
  /** Its Startup Commands file exists or its launch wrote a block into it. */
  startupFileUsed: boolean;
}

export interface LaunchCheckInput {
  name: string;
  launch: LaunchConfig;
  /** The launch's Startup Commands file exists, or the launch writes a block into it. */
  startupFileUsed: boolean;
  /** The temp directory Pyrodeck gives this server when the profile sets none. */
  defaultTempDir: string;
  others: OtherLaunch[];
}

export type LaunchCheck =
  | { ok: true; launch: LaunchConfig }
  | { ok: false; error: string };

/** The ports and files a launch holds. */
export interface LaunchFootprint {
  /** The -useip address; null when the server binds every address. */
  bindIp: string | null;
  gamePort: number;
  gameSpyPort: number;
  consolePort: number;
  configPath: string;
  startupPath: string;
  /** The -tempdir; null for the engine's default (<system temp>/Descent3/cache). */
  tempDir: string | null;
  logPath: string | null;
}

export function launchFootprint(launch: LaunchConfig): LaunchFootprint {
  const options = mergeLaunchOptions(launch.defaultOptions, launch.launchOptions);
  const ports = effectivePorts(options);
  const bind = options?.bindIp;
  return {
    bindIp: bind && bind !== "0.0.0.0" ? bind : null,
    gamePort: ports.game,
    gameSpyPort: ports.gameSpy,
    consolePort: launch.telnetPort,
    configPath: path.resolve(launch.gamePath, launch.configFile),
    startupPath: startupFilePath(launch),
    tempDir: options?.tempDir ? path.resolve(options.tempDir) : null,
    logPath: launch.logPath ? path.resolve(launch.logPath) : null,
  };
}

/** UDP sockets on these binds collide on equal ports. */
function bindsOverlap(a: string | null, b: string | null): boolean {
  return a === null || b === null || a === b;
}

function heldBy(other: OtherLaunch): string {
  return `"${other.name}" (${other.why}${other.pid !== null ? `, PID ${other.pid}` : ""})`;
}

/** Ports from this one up that the GameSpy default may move to. */
const GAMESPY_SEARCH = 200;

/** `name` with -2, -3 ... before its extension, the first not in `taken`. */
function suffixed(file: string, taken: ReadonlySet<string>): string {
  const ext = path.extname(file);
  const stem = file.slice(0, file.length - ext.length);
  for (let n = 2; ; n++) {
    const candidate = `${stem}-${n}${ext}`;
    if (!taken.has(path.resolve(candidate))) return candidate;
  }
}

/**
 * Check a launch against the other servers' and fill in Pyrodeck's
 * defaults. Pure: the caller holds the launch lock and knows which files
 * exist.
 */
export function checkLaunch(input: LaunchCheckInput): LaunchCheck {
  const own = input.launch.launchOptions ?? null;
  const defaults: LaunchOptions = {};
  if (!own?.tempDir) defaults.tempDir = input.defaultTempDir;
  let launch: LaunchConfig = { ...input.launch, defaultOptions: Object.keys(defaults).length > 0 ? defaults : null };
  const others = input.others.map((o) => ({ ...o, at: launchFootprint(o.launch) }));
  const errors: string[] = [];
  const me = launchFootprint(launch);
  const prefix = `Cannot start "${input.name}":`;

  for (const o of others) {
    if (me.consolePort === o.at.consolePort) {
      errors.push(
        `${prefix} console port ${me.consolePort}/tcp is used by ${heldBy(o)}; Pyrodeck would log in to that server. ` +
          "Give one of them its own RemoteConsolePort in its server config.",
      );
    }
    if (bindsOverlap(me.bindIp, o.at.bindIp) && (me.gamePort === o.at.gamePort || me.gamePort === o.at.gameSpyPort)) {
      errors.push(
        `${prefix} game port ${me.gamePort}/udp is used by ${heldBy(o)}; the second server would run without network. ` +
          "Give one of them its own game port (Launch Options, -useport).",
      );
    }
    if (me.configPath === o.at.configPath) {
      errors.push(
        `${prefix} its server config ${me.configPath} is the one ${heldBy(o)} runs from; a playlist rotation rewrites ` +
          "it. Give one profile its own config file (duplicate the profile).",
      );
    }
    if (me.startupPath === o.at.startupPath && (input.startupFileUsed || o.startupFileUsed)) {
      errors.push(
        `${prefix} its Startup Commands file ${me.startupPath} is also used by ${heldBy(o)}, and each launch ` +
          "rewrites it. Give one of the profiles its own Startup Commands file (the profile's startupFile).",
      );
    }
    if (own?.tempDir && me.tempDir === (o.at.tempDir ?? null)) {
      errors.push(
        `${prefix} temp directory ${me.tempDir} is used by ${heldBy(o)}; the second server would exit with ` +
          '"Unable to create lock file". Give one of them its own temp directory (Launch Options, -tempdir), or ' +
          "clear it so that Pyrodeck gives each server its own.",
      );
    }
  }

  // GameSpy: an operator's port is checked; the default moves to a free one.
  const gameSpyClash = (port: number) =>
    others.find((o) => bindsOverlap(me.bindIp, o.at.bindIp) && (port === o.at.gameSpyPort || port === o.at.gamePort));
  const clash = gameSpyClash(me.gameSpyPort);
  if (clash) {
    if (own?.gameSpyPort !== undefined) {
      errors.push(
        `${prefix} GameSpy port ${me.gameSpyPort}/udp is used by ${heldBy(clash)}. Give one of them its own ` +
          "GameSpy port (Launch Options, -gamespyport), or clear it so that Pyrodeck picks a free one.",
      );
    } else {
      let free: number | null = null;
      for (let p = D3_DEFAULT_GAMESPY_PORT + 1; p <= D3_DEFAULT_GAMESPY_PORT + GAMESPY_SEARCH && p <= 65535; p++) {
        if (p !== me.gamePort && !gameSpyClash(p)) {
          free = p;
          break;
        }
      }
      if (free === null) {
        errors.push(`${prefix} no free GameSpy port near ${D3_DEFAULT_GAMESPY_PORT}/udp; set one (Launch Options, -gamespyport).`);
      } else {
        defaults.gameSpyPort = free;
        launch = { ...launch, defaultOptions: { ...defaults } };
      }
    }
  }

  // Default temp directory: a clash with another server's explicit one is refused too.
  if (!own?.tempDir) {
    const t = others.find((o) => o.at.tempDir === path.resolve(input.defaultTempDir));
    if (t) {
      errors.push(
        `${prefix} its temp directory ${input.defaultTempDir} is set as the -tempdir of ${heldBy(t)}. Clear that ` +
          "profile's temp directory, or give this one its own (Launch Options, -tempdir).",
      );
    }
  }

  if (errors.length > 0) return { ok: false, error: errors.join(" ") };

  // Same log name (two profiles of one name launched in the same second): a suffix.
  if (me.logPath) {
    const taken = new Set(others.map((o) => o.at.logPath).filter((p): p is string => p !== null));
    if (taken.has(me.logPath)) launch = { ...launch, logPath: suffixed(launch.logPath!, taken) };
  }
  return { ok: true, launch };
}

/**
 * The temp directory Pyrodeck gives a server whose profile sets none: short
 * (the engine keeps 99 bytes of an argument), the same for a server across
 * Pyrodeck restarts, and different for each server and each Pyrodeck config
 * directory on the machine.
 */
export function defaultTempDir(configDir: string, serverId: string, base: string = os.tmpdir()): string {
  const tag = crypto.createHash("sha256").update(`${path.resolve(configDir)}\0${serverId}`).digest("hex").slice(0, 12);
  const name = `pyrodeck-${tag}`;
  const dir = path.join(base, name);
  if (Buffer.byteLength(dir) <= MAX_ENGINE_ARG_BYTES) return dir;
  // A temp directory with a very long path: /tmp, or the drive's root on Windows.
  return process.platform === "win32" ? path.join(path.parse(path.resolve(base)).root, name) : path.join("/tmp", name);
}
