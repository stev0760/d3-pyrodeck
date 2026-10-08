/**
 * Launch options: engine command-line flags a profile adds after
 * `-dedicated <cfg>`. Every flag here is read by the open-source engine
 * (Matcen tree; file:line):
 *
 *   -useip <IPv4>     networking/networking.cpp:591-599 parses it with
 *                     inet_addr(), so only a dotted IPv4 literal works; a host
 *                     name parses as INADDR_NONE and is ignored. nw_GetThisIP()
 *                     returns it (:847-852) and the server binds every socket
 *                     to it: the game UDP socket (:746-751), the remote
 *                     console (Descent3/dedicated_server.cpp:1435-1452) and
 *                     the GameSpy socket (Descent3/gamespy.cpp:142-153).
 *   -useport <n>      Descent3/init.cpp:1808-1817: the game UDP port, default
 *                     D3_DEFAULT_PORT 2092 (Descent3/descent.h:148-150).
 *   -framecap <fps>   Descent3/init.cpp:1091-1099: minimum frame time of
 *                     1000/fps whole milliseconds; default 60 fps, which also
 *                     replaces the 30 ms a dedicated server would otherwise
 *                     get from :1081-1090. 0 divides by zero.
 *   -nomultibmp       Descent3/init.cpp:1078-1079: no pilot logo exchange
 *                     (Use_file_xfer = 0; Descent3/multi_server.cpp:2703-2714,
 *                     Descent3/multi.cpp:1974).
 *   -gamespyport <n>  Descent3/gamespy.cpp:144-151: the GameSpy query UDP port,
 *                     default GAMESPY_LISTENPORT 20142 (:73). The socket is
 *                     opened on every launch (Descent3/init.cpp:1883).
 *   -gspyfile <file>  Descent3/gamespy.cpp:113-128: the tracker list, looked up
 *                     under the game directory (cf_LocatePath), default
 *                     gamespy.cfg.
 *
 * The engine keeps at most 99 characters of an argument (MAX_CHARS_PER_ARG in
 * Descent3/args.h); every value accepted here is shorter.
 */

/** Game UDP port when -useport is not given (D3_DEFAULT_PORT, Descent3/descent.h). */
export const D3_DEFAULT_GAME_PORT = 2092;
/** GameSpy query port when -gamespyport is not given (GAMESPY_LISTENPORT, Descent3/gamespy.cpp). */
export const D3_DEFAULT_GAMESPY_PORT = 20142;
/** Remote console port when RemoteConsolePort is not set (Descent3/dedicated_server.cpp:154). */
export const D3_DEFAULT_CONSOLE_PORT = 2092;

export const FRAME_CAP_MIN = 1;
export const FRAME_CAP_MAX = 999;
const GAMESPY_FILE_MAX = 64;

export interface LaunchOptions {
  /** -useip: the IPv4 address every server socket binds to. */
  bindIp?: string;
  /** -useport: the game UDP port. */
  gamePort?: number;
  /** -framecap: server frames per second. */
  frameCap?: number;
  /** -nomultibmp: no pilot logo exchange. */
  noMultiBmp?: boolean;
  /** -gamespyport: the GameSpy query UDP port. */
  gameSpyPort?: number;
  /** -gspyfile: tracker list file name in the game directory. */
  gameSpyFile?: string;
}

export interface LaunchOptionsCheck {
  /** The options to store, or null when none are set. Not to be saved when `errors` is non-empty. */
  options: LaunchOptions | null;
  errors: string[];
  warnings: string[];
}

const IPV4_OCTET = "(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
const IPV4_RE = new RegExp(`^${IPV4_OCTET}(\\.${IPV4_OCTET}){3}$`);

/** Empty strings and null mean "not set". */
function present(v: unknown): boolean {
  return v !== undefined && v !== null && !(typeof v === "string" && v.trim() === "");
}

function toInt(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v.trim()) : v;
  return typeof n === "number" && Number.isInteger(n) ? n : null;
}

function checkPort(label: string, v: unknown, errors: string[]): number | undefined {
  if (!present(v)) return undefined;
  const n = toInt(v);
  if (n === null || n < 1 || n > 65535) {
    errors.push(`${label} must be a whole number from 1 to 65535.`);
    return undefined;
  }
  return n;
}

/** Validate untrusted launch options (strings or numbers from the profile form). */
export function validateLaunchOptions(raw: unknown): LaunchOptionsCheck {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const errors: string[] = [];
  const warnings: string[] = [];
  const out: LaunchOptions = {};

  if (present(r.bindIp)) {
    const ip = typeof r.bindIp === "string" ? r.bindIp.trim() : "";
    if (!IPV4_RE.test(ip)) {
      errors.push(
        "The bind address must be an IPv4 address such as 192.168.1.20. The engine reads -useip with inet_addr(), " +
          "so a host name would be ignored.",
      );
    } else if (ip === "255.255.255.255") {
      // inet_addr returns INADDR_NONE for it, which the engine treats as "not set".
      errors.push("255.255.255.255 is not a usable bind address.");
    } else {
      out.bindIp = ip;
      if (ip === "0.0.0.0") {
        warnings.push("Bind address 0.0.0.0 means all addresses, the same as leaving it empty.");
      } else if (ip.startsWith("127.")) {
        warnings.push(`Bind address ${ip} is loopback: players on other machines cannot join.`);
      }
    }
  }

  const gamePort = checkPort("The game port", r.gamePort, errors);
  if (gamePort !== undefined) {
    out.gamePort = gamePort;
    if (gamePort < 1024) {
      warnings.push(`Game port ${gamePort} is below 1024; on Linux the server needs extra privileges to bind it.`);
    }
  }

  if (present(r.frameCap)) {
    const n = toInt(r.frameCap);
    if (n === null || n < FRAME_CAP_MIN || n > FRAME_CAP_MAX) {
      errors.push(`The frame cap must be a whole number from ${FRAME_CAP_MIN} to ${FRAME_CAP_MAX} frames per second.`);
    } else {
      out.frameCap = n;
    }
  }

  if (r.noMultiBmp === true) out.noMultiBmp = true;

  const gameSpyPort = checkPort("The GameSpy port", r.gameSpyPort, errors);
  if (gameSpyPort !== undefined) out.gameSpyPort = gameSpyPort;

  if (present(r.gameSpyFile)) {
    const f = typeof r.gameSpyFile === "string" ? r.gameSpyFile.trim() : "";
    if (!/^[A-Za-z0-9._-]+$/.test(f) || f === "." || f === ".." || f.length > GAMESPY_FILE_MAX) {
      errors.push(
        `The GameSpy file must be a plain file name in the game directory (letters, digits, . _ -; at most ${GAMESPY_FILE_MAX} characters).`,
      );
    } else {
      out.gameSpyFile = f;
    }
  }

  const ports = effectivePorts(out);
  if ((out.gamePort !== undefined || out.gameSpyPort !== undefined) && ports.game === ports.gameSpy) {
    warnings.push(
      `The game port and the GameSpy port are both ${ports.game}/udp: the GameSpy socket will fail to bind (the game still runs).`,
    );
  }

  return { options: Object.keys(out).length > 0 ? out : null, errors, warnings };
}

/** Options as stored in profiles.json, made safe for use: anything invalid is dropped. */
export function sanitizeStoredLaunchOptions(raw: unknown): LaunchOptions | null {
  const check = validateLaunchOptions(raw);
  return check.errors.length === 0 ? check.options : null;
}

/** The command-line flags for these options, in a fixed order. */
export function launchOptionArgs(options: LaunchOptions | null | undefined): string[] {
  if (!options) return [];
  const args: string[] = [];
  if (options.bindIp) args.push("-useip", options.bindIp);
  if (options.gamePort !== undefined) args.push("-useport", String(options.gamePort));
  if (options.frameCap !== undefined) args.push("-framecap", String(options.frameCap));
  if (options.noMultiBmp) args.push("-nomultibmp");
  if (options.gameSpyPort !== undefined) args.push("-gamespyport", String(options.gameSpyPort));
  if (options.gameSpyFile) args.push("-gspyfile", options.gameSpyFile);
  return args;
}

/**
 * The address Pyrodeck reaches the launched server's remote console at, or
 * null for 127.0.0.1. From dedicated_server.cpp (InitDedicatedSocket,
 * ListenDedicatedSocket):
 *
 * - AllowRemoteConsole=0 (the engine's default): every engine (retail 1.4,
 *   upstream, Matcen) accepts console connections from 127.0.0.1 only, and
 *   Matcen 0.10.8+ also listens on 127.0.0.1 only. Pyrodeck connects to
 *   127.0.0.1 whatever -useip says (see localConsoleUseipNote for the older
 *   engines that listen on the -useip address instead).
 * - AllowRemoteConsole=1: the console listens on nw_GetThisIP(), the -useip
 *   address when one is given (else every interface), so with -useip a
 *   connection to the loopback address would be refused.
 */
export function consoleHostFor(options: LaunchOptions | null | undefined, allowRemoteConsole: boolean): string | null {
  if (!allowRemoteConsole) return null;
  const ip = options?.bindIp;
  return ip && ip !== "0.0.0.0" ? ip : null;
}

/**
 * AllowRemoteConsole=0 with -useip on an engine older than Matcen 0.10.8:
 * the console listens on the -useip address only, but accepts 127.0.0.1
 * only, so no local connection gets in (one to the -useip address comes
 * from that address). Pyrodeck cannot tell the engine apart before it logs
 * in, so it says this wherever the combination is saved, launched or fails.
 */
export function localConsoleUseipNote(options: LaunchOptions | null | undefined, allowRemoteConsole: boolean): string | null {
  const bind = consoleHostFor(options, true);
  if (allowRemoteConsole || !bind || bind === "127.0.0.1") return null;
  return (
    `AllowRemoteConsole=0 with bind address ${bind} (-useip): Matcen 0.10.8 and later keep the console on ` +
    `127.0.0.1, where Pyrodeck logs in. Older engines (retail 1.4, upstream Descent 3, Matcen before 0.10.8) ` +
    `put it on ${bind} but accept only 127.0.0.1, so Pyrodeck cannot log in to them; on those, clear the bind ` +
    "address, or set AllowRemoteConsole=1 and keep the console port closed in the firewall."
  );
}

/**
 * What to tell the operator about a profile's console: that an
 * AllowRemoteConsole=1 console is open to the network, or the -useip case
 * above. Empty for the recommended AllowRemoteConsole=0.
 */
export function consoleWarnings(
  options: LaunchOptions | null | undefined,
  allowRemoteConsole: boolean,
  consolePort: number,
): string[] {
  if (allowRemoteConsole) {
    return [
      `AllowRemoteConsole=1: the server's console (TCP port ${consolePort}, password sent in clear) is reachable ` +
        "from the network; firewall it. Pyrodeck on this machine does not need it; only Connect mode from " +
        "another machine does.",
    ];
  }
  const note = localConsoleUseipNote(options, allowRemoteConsole);
  return note ? [note] : [];
}

export interface EffectivePorts {
  /** Game UDP port. */
  game: number;
  /** GameSpy query UDP port. */
  gameSpy: number;
}

export function effectivePorts(options: LaunchOptions | null | undefined): EffectivePorts {
  return {
    game: options?.gamePort ?? D3_DEFAULT_GAME_PORT,
    gameSpy: options?.gameSpyPort ?? D3_DEFAULT_GAMESPY_PORT,
  };
}

/** The ports one profile's server holds while it runs. */
export interface ProfilePorts {
  name: string;
  /** Game UDP port. */
  game: number;
  /** GameSpy query UDP port. */
  gameSpy: number;
  /** Remote console TCP port (RemoteConsolePort); null when the config can't be read. */
  console: number | null;
}

/**
 * Ports this profile shares with other profiles (or with another TCP service
 * on this machine, such as the mission host). The game and GameSpy sockets
 * are UDP and the console is TCP, so a UDP port and a TCP port with the same
 * number do not collide. Pyrodeck runs one server at a time, so a shared port
 * is a warning: the two profiles cannot run at once.
 */
export function findPortConflicts(
  self: ProfilePorts,
  others: readonly ProfilePorts[],
  tcpServices: readonly { name: string; port: number }[] = [],
): string[] {
  const warnings: string[] = [];
  for (const other of others) {
    const shared: string[] = [];
    if (self.game === other.game) shared.push(`game port ${self.game}/udp`);
    else if (self.game === other.gameSpy) shared.push(`game port ${self.game}/udp (its GameSpy port)`);
    if (self.gameSpy === other.gameSpy) shared.push(`GameSpy port ${self.gameSpy}/udp`);
    else if (self.gameSpy === other.game) shared.push(`GameSpy port ${self.gameSpy}/udp (its game port)`);
    if (self.console !== null && self.console === other.console) {
      shared.push(`console port ${self.console}/tcp`);
    }
    if (shared.length > 0) {
      warnings.push(`Profile "${other.name}" uses the same ${shared.join(", ")}; the two cannot run at the same time.`);
    }
  }
  for (const svc of tcpServices) {
    if (self.console !== null && self.console === svc.port) {
      warnings.push(`The console port ${self.console}/tcp is also the ${svc.name} port.`);
    }
  }
  return warnings;
}
