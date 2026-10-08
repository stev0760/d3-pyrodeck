/**
 * The game server's environment, built from Pyrodeck's own rather than
 * inherited whole. Pyrodeck's environment holds its secrets
 * (PYRODECK_ADMIN_PASSWORD, PYRODECK_SESSION_SECRET), and a service manager
 * or a shell may add others (cloud tokens, database URLs) that the game has
 * no use for and must not see: it runs third-party missions and scripts, and
 * a crash dump or a `/proc/<pid>/environ` read would expose them.
 *
 * Only the variables below are passed on, and never a PYRODECK_* one. Every
 * secret Pyrodeck reads from its environment is a PYRODECK_* variable, so
 * that rule covers them by name; the allowlist drops everything else unknown.
 *
 * What is kept, and why:
 * - PATH, HOME, USER, LOGNAME, SHELL, TMPDIR/TMP/TEMP, TZ: the process basics.
 * - LANG, LANGUAGE, LC_*: the locale.
 * - XDG_*: the engine's writable directory (SDL's preference path) is under
 *   XDG_DATA_HOME when it is set; dropping it would move the server's
 *   netgames/hosts.deny away from where Pyrodeck edits it (bans/BanStore.ts).
 * - SDL_*: SDL settings an operator sets on purpose (SDL_VIDEODRIVER below).
 * - D3_*: the engine's own variables (D3_LOCAL, D3_DIR in sdlmain.cpp).
 * - LD_LIBRARY_PATH: a build that loads its libraries from outside the system path.
 * - On Windows, the system variables a process needs to start at all and to
 *   open sockets (SystemRoot above all), and the profile folders.
 *
 * Names are compared without regard to case, as Windows does.
 */

const KEEP_NAMES = new Set(
  [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "TMPDIR",
    "TMP",
    "TEMP",
    "TZ",
    "LANG",
    "LANGUAGE",
    "LD_LIBRARY_PATH",
    // Windows
    "SYSTEMROOT",
    "SYSTEMDRIVE",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "USERPROFILE",
    "USERNAME",
    "USERDOMAIN",
    "COMPUTERNAME",
    "APPDATA",
    "LOCALAPPDATA",
    "PROGRAMDATA",
    "PROGRAMFILES",
    "PROGRAMFILES(X86)",
    "PROGRAMW6432",
    "COMMONPROGRAMFILES",
    "COMMONPROGRAMFILES(X86)",
    "COMMONPROGRAMW6432",
    "HOMEDRIVE",
    "HOMEPATH",
    "PUBLIC",
    "ALLUSERSPROFILE",
    "NUMBER_OF_PROCESSORS",
    "PROCESSOR_ARCHITECTURE",
    "OS",
  ].map((n) => n.toUpperCase()),
);

const KEEP_PREFIXES = ["LC_", "XDG_", "SDL_", "D3_"];

/** Never passed to the game, whatever else says so. */
const SECRET_PREFIX = "PYRODECK_";

/** Whether a variable of Pyrodeck's environment reaches the game server. */
export function isPassedToGame(name: string): boolean {
  const upper = name.toUpperCase();
  if (upper.startsWith(SECRET_PREFIX)) return false;
  return KEEP_NAMES.has(upper) || KEEP_PREFIXES.some((p) => upper.startsWith(p));
}

/**
 * The variables Pyrodeck sets for the game on purpose. A dedicated server
 * draws nothing, but SDL still initialises video: the dummy driver keeps it
 * from looking for a display. An SDL_VIDEODRIVER in Pyrodeck's environment wins.
 */
export function launchEnvDefaults(parent: Readonly<Record<string, string | undefined>>): Record<string, string> {
  return { SDL_VIDEODRIVER: parent.SDL_VIDEODRIVER ?? "dummy" };
}

/**
 * The environment to spawn the game server with: the allowed part of
 * `parent` plus `deliberate`. A PYRODECK_* name is dropped from either.
 */
export function buildChildEnv(
  parent: Readonly<Record<string, string | undefined>>,
  deliberate: Readonly<Record<string, string>> = launchEnvDefaults(parent),
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(parent)) {
    if (value !== undefined && isPassedToGame(name)) env[name] = value;
  }
  for (const [name, value] of Object.entries(deliberate)) {
    if (!name.toUpperCase().startsWith(SECRET_PREFIX)) env[name] = value;
  }
  return env;
}
