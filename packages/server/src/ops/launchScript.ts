import path from "node:path";
import type { PriorityClass } from "./processPriority.js";

/**
 * Import a server from the batch file or shell script that used to launch it:
 * find the line that starts `Descent3 -dedicated <cfg> ...`, read its flags the
 * way the engine does, and plan a profile from it.
 *
 * How the engine reads its command line (Matcen fork, Descent3/args.cpp):
 * - A flag matches case-insensitively, with any of the prefixes "-", "--" or
 *   "+" (SkipArgPrefix and FindArg, args.cpp:91-128), so "-UsePort",
 *   "--useport" and "+useport" are the same flag.
 * - The first occurrence wins: FindArg scans from argument 1 up (args.cpp:115).
 * - A flag's value is simply the next argument (GameArgs[t + 1]).
 * - At most 30 arguments, each cut to 100 bytes (MAX_ARGS, MAX_CHARS_PER_ARG,
 *   args.h:22-23; args.cpp:81-83).
 * - "-d" (exactly, lower case) also names the server config
 *   (FindArgChar("-dedicated", 'd'), dedicated_server.cpp:322).
 */

export type ScriptShell = "cmd" | "sh";

interface FlagInfo {
  /** Takes the next argument as its value. */
  value: boolean;
  /** Another name for the same setting. */
  alias?: string;
  /** Where the engine reads it. */
  source: string;
}

/** Flags the open-source engine reads that matter to a server, by canonical (prefix-free, lower-case) name. */
export const ENGINE_FLAGS: Readonly<Record<string, FlagInfo>> = {
  dedicated: { value: true, source: "dedicated_server.cpp:322" },
  autoexec: { value: true, source: "netgames/dmfc/dmfcbase.cpp:4921" },
  useport: { value: true, source: "init.cpp:1813" },
  host: { value: true, alias: "useport", source: "init.cpp:1811 (+host)" },
  pxoport: { value: true, source: "init.cpp:1819" },
  gamespyport: { value: true, source: "gamespy.cpp:144" },
  gspyfile: { value: true, source: "gamespy.cpp:113" },
  useip: { value: true, source: "networking.cpp:591" },
  ip: { value: true, alias: "useip", source: "networking.cpp:593 (+ip)" },
  framecap: { value: true, source: "init.cpp:1091" },
  limitframe: { value: true, source: "init.cpp:1081" },
  nomultibmp: { value: false, source: "init.cpp:1078" },
  tempdir: { value: true, source: "init.cpp:1971" },
  timeout: { value: true, source: "init.cpp:1877" },
  additionaldir: { value: true, source: "init.cpp:1437" },
  loglevel: { value: true, source: "sdlmain.cpp:236" },
  logfile: { value: false, source: "sdlmain.cpp:239" },
  nosound: { value: false, source: "init.cpp:1930" },
  nomusic: { value: false, source: "init.cpp:1930" },
  nonetwork: { value: false, source: "init.cpp:1872" },
  lowmem: { value: false, source: "init.cpp:1066" },
  superlowmem: { value: false, source: "init.cpp:1068" },
  himem: { value: false, source: "init.cpp:1073" },
};

/** Flags old launchers passed that the open-source engine does not read (docs/D3SERVER3_AUDIT.md §1). */
const NOT_READ: Readonly<Record<string, boolean>> = { setdir: true, nocrashbox: false };

const ENGINE_MAX_ARGS = 30;
const ENGINE_MAX_ARG_BYTES = 99;

/**
 * The flag name the engine would match `arg` against (SkipArgPrefix,
 * args.cpp:91): "--x", "-x" and "+x" become "x", lower-cased. Null for a
 * value that is not a flag ("-", "--", "++", "plain").
 */
export function canonicalFlag(arg: string): string | null {
  if (arg.length < 2) return null;
  if (arg.startsWith("--")) return arg.length > 2 ? arg.slice(2).toLowerCase() : null;
  if (arg[0] === "-") return arg.slice(1).toLowerCase();
  if (arg[0] === "+" && arg[1] !== "+") return arg.slice(1).toLowerCase();
  return null;
}

// ---------------------------------------------------------------------------
// Tokenizing
// ---------------------------------------------------------------------------

type Tok = { kind: "word"; text: string; quoted: boolean } | { kind: "sep" } | { kind: "redirect"; needsTarget: boolean };

/**
 * Split one line into words, command separators and redirections, with the
 * shell's quoting: cmd groups with double quotes and escapes with ^; sh also
 * has single quotes, backslash escapes and ";" and "#" comments.
 */
function tokenize(line: string, shell: ScriptShell): Tok[] {
  const out: Tok[] = [];
  let buf = "";
  let inWord = false;
  let quoted = false;
  let quote: '"' | "'" | null = null;
  const flush = () => {
    if (inWord) out.push({ kind: "word", text: buf, quoted });
    buf = "";
    inWord = false;
    quoted = false;
  };
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) {
        quote = null;
      } else if (shell === "sh" && quote === '"' && c === "\\" && i + 1 < line.length && '"\\$`'.includes(line[i + 1])) {
        buf += line[++i];
      } else {
        buf += c;
      }
      continue;
    }
    if (c === '"' || (shell === "sh" && c === "'")) {
      quote = c;
      inWord = true;
      quoted = true;
      continue;
    }
    if ((shell === "cmd" && c === "^") || (shell === "sh" && c === "\\")) {
      if (i + 1 < line.length) {
        buf += line[++i];
        inWord = true;
      }
      continue;
    }
    if (shell === "sh" && c === "#" && !inWord) break;
    if (c === " " || c === "\t") {
      flush();
      continue;
    }
    if (c === ">" || c === "<") {
      // "2>" / "1>>": a digit-only word glued to the operator is its descriptor.
      if (inWord && !quoted && /^\d+$/.test(buf)) {
        buf = "";
        inWord = false;
      }
      flush();
      let j = i + 1;
      if (line[j] === ">") j++;
      let needsTarget = true;
      if (line[j] === "&") {
        // ">&1", "2>&1": the target is a descriptor, part of the operator.
        j++;
        while (j < line.length && /\d/.test(line[j])) j++;
        needsTarget = false;
      }
      out.push({ kind: "redirect", needsTarget });
      i = j - 1;
      continue;
    }
    if (c === "&" && shell === "sh" && line[i + 1] === ">") {
      // bash "&>file"
      flush();
      out.push({ kind: "redirect", needsTarget: true });
      i += line[i + 2] === ">" ? 2 : 1;
      continue;
    }
    if (c === "|" || c === "&" || (shell === "sh" && c === ";")) {
      flush();
      if (line[i + 1] === c) i++;
      out.push({ kind: "sep" });
      continue;
    }
    buf += c;
    inWord = true;
  }
  flush();
  return out;
}

interface Word {
  text: string;
  quoted: boolean;
}

/** Commands on a line, redirections and their targets removed. */
function splitCommands(tokens: Tok[]): Word[][] {
  const commands: Word[][] = [[]];
  let skipNext = false;
  for (const t of tokens) {
    if (t.kind === "sep") {
      commands.push([]);
      skipNext = false;
    } else if (t.kind === "redirect") {
      skipNext = t.needsTarget;
    } else if (skipNext) {
      skipNext = false;
    } else {
      commands[commands.length - 1].push({ text: t.text, quoted: t.quoted });
    }
  }
  return commands.filter((c) => c.length > 0);
}

// ---------------------------------------------------------------------------
// Script-level handling
// ---------------------------------------------------------------------------

/** Stands for "the directory the script is in", unknown when only its text is given. */
const SCRIPT_DIR = "\u0001SCRIPTDIR\u0001";

function detectShell(text: string, fileName?: string): ScriptShell {
  const ext = fileName ? path.extname(fileName).toLowerCase() : "";
  if (ext === ".bat" || ext === ".cmd") return "cmd";
  if (ext === ".sh") return "sh";
  if (/^#!/.test(text) || /\$\(|\$\{|^\s*export\s/m.test(text)) return "sh";
  if (/%~dp0|^\s*@?echo\s+off|^\s*rem\s|[A-Za-z]:\\/im.test(text)) return "cmd";
  return "sh";
}

/** Replace the shells' ways of naming the script's own directory with SCRIPT_DIR. */
function markScriptDir(line: string, shell: ScriptShell): string {
  if (shell === "cmd") {
    return line.replace(/%~dp0/gi, SCRIPT_DIR).replace(/%cd%/gi, SCRIPT_DIR);
  }
  // Only the substitution itself is replaced: quotes around it stay, so
  // "$(dirname "$0")/Descent3" keeps its outer pair.
  const zero = String.raw`(?:"\$\{?0\}?"|\$\{?0\}?|"\$\{?BASH_SOURCE(?:\[0\])?\}?"|\$\{?BASH_SOURCE(?:\[0\])?\}?)`;
  return line
    .replace(new RegExp(String.raw`\$\(\s*dirname\s+${zero}\s*\)`, "g"), SCRIPT_DIR)
    .replace(/\$\{0%\/\*\}/g, SCRIPT_DIR)
    .replace(new RegExp(String.raw`\$\(\s*cd\s+"?${SCRIPT_DIR}"?\s*(?:&&|;)\s*pwd\s*\)`, "g"), SCRIPT_DIR)
    .replace(/\$\(\s*pwd\s*\)|\$\{?PWD\}?/g, SCRIPT_DIR);
}

function substituteVars(line: string, vars: Map<string, string>, shell: ScriptShell): string {
  if (shell === "cmd") {
    return line.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (m, name: string) => vars.get(name.toLowerCase()) ?? m);
  }
  return line.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (m, a?: string, b?: string) => {
    const v = vars.get((a ?? b)!);
    return v ?? m;
  });
}

/** Resolve SCRIPT_DIR in a finished value: a leading "<script dir>/" is dropped (relative to the script). */
function resolveScriptDir(value: string): { value: string; usedScriptDir: boolean } {
  if (!value.includes(SCRIPT_DIR)) return { value, usedScriptDir: false };
  const v = value.replace(new RegExp(`${SCRIPT_DIR}[\\\\/]*`, "g"), "");
  return { value: v === "" ? "." : v, usedScriptDir: true };
}

function joinContinuations(text: string, shell: ScriptShell): string[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let acc = "";
  const cont = shell === "cmd" ? /\^$/ : /\\$/;
  for (const raw of lines) {
    if (cont.test(raw)) {
      acc += raw.slice(0, -1);
      continue;
    }
    out.push(acc + raw);
    acc = "";
  }
  if (acc) out.push(acc);
  return out;
}

const CMD_SKIP = /^(rem\b|::|echo\b|title\b|pause\b|exit\b|goto\b|:|cls\b|color\b|setlocal\b|endlocal\b|timeout\b|choice\b|mode\b|if\b|for\b)/i;
const SH_SKIP = /^(echo\b|printf\b|set\s+-|trap\b|wait\b|sleep\b|exit\b|ulimit\b|umask\b|if\b|fi\b|for\b|while\b|until\b|done\b|case\b|esac\b|read\b|shift\b|source\b|\.\s)/;

const START_PRIORITY: Record<string, PriorityClass> = {
  low: "below-normal",
  belownormal: "below-normal",
  normal: "normal",
  abovenormal: "above-normal",
  high: "high",
  realtime: "high",
};

function niceToPriority(n: number): PriorityClass {
  if (n >= 5) return "below-normal";
  if (n <= -10) return "high";
  if (n < 0) return "above-normal";
  return "normal";
}

interface Prefixed {
  words: Word[];
  workingDir: string | null;
  priorityHint: PriorityClass | null;
}

/** Drop what wraps the program on its line: start/call (cmd); exec, nohup, env, nice, screen, … (sh). */
function stripWrappers(input: Word[], shell: ScriptShell): Prefixed {
  const words = [...input];
  let workingDir: string | null = null;
  let priorityHint: PriorityClass | null = null;
  const lower = () => words[0]?.text.toLowerCase();

  if (shell === "cmd") {
    while (lower() === "call") words.shift();
    if (lower() === "start") {
      words.shift();
      let titled = false;
      for (;;) {
        const w = words[0];
        if (!w) break;
        if (!w.quoted && w.text.startsWith("/")) {
          words.shift();
          const sw = w.text.slice(1).toLowerCase();
          if (sw === "d") workingDir = words.shift()?.text ?? null;
          else if (sw === "affinity" || sw === "node") words.shift();
          else if (START_PRIORITY[sw]) priorityHint = START_PRIORITY[sw];
          else if (sw.startsWith("d")) workingDir = w.text.slice(2); // "/dC:\D3"
          continue;
        }
        // start takes its first quoted argument as the window title, unless
        // flags follow it directly (then it is the program).
        const next = words[1];
        if (w.quoted && !titled && next && canonicalFlag(next.text) === null) {
          words.shift();
          titled = true;
          continue;
        }
        break;
      }
    }
    return { words, workingDir, priorityHint };
  }

  for (;;) {
    const w = lower();
    if (w === undefined) break;
    if (["exec", "nohup", "command", "builtin", "setsid"].includes(w)) {
      words.shift();
    } else if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0].text)) {
      words.shift();
    } else if (w === "env") {
      words.shift();
      while (words[0] && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0].text) || words[0].text.startsWith("-"))) {
        const opt = words.shift()!.text;
        if (opt === "-u" || opt === "-C") words.shift();
      }
    } else if (w === "nice") {
      words.shift();
      let n = 10;
      if (words[0]?.text === "-n") {
        words.shift();
        n = Number(words.shift()?.text ?? 10);
      } else if (/^--adjustment=/.test(words[0]?.text ?? "")) {
        n = Number(words.shift()!.text.split("=")[1]);
      } else if (/^-\d+$|^--\d+$/.test(words[0]?.text ?? "")) {
        n = Number(words.shift()!.text.replace(/^-/, ""));
      }
      if (Number.isFinite(n)) priorityHint = niceToPriority(n);
    } else if (w === "ionice" || w === "taskset" || w === "stdbuf" || w === "timeout" || w === "sudo") {
      words.shift();
      while (words[0] && words[0].text.startsWith("-")) {
        const opt = words.shift()!.text;
        if (["-c", "-n", "-p", "-u", "-g", "-o", "-e", "-i", "-k", "-s"].includes(opt)) words.shift();
      }
      // taskset MASK / timeout DURATION take one positional before the command.
      if ((w === "taskset" || w === "timeout") && words[1]) words.shift();
    } else if (w === "screen") {
      words.shift();
      while (words[0] && words[0].text.startsWith("-")) {
        const opt = words.shift()!.text;
        if (/S$|^-[ct]$|^-Logfile$/.test(opt)) words.shift();
      }
    } else {
      break;
    }
  }
  return { words, workingDir, priorityHint };
}

function isDedicatedWord(text: string): boolean {
  return text === "-d" || canonicalFlag(text) === "dedicated";
}

export interface LaunchScript {
  shell: ScriptShell;
  /** The command that starts the server, as written (continuations joined), or null when none was found. */
  commandLine: string | null;
  /** The program, as written, with any "script directory" prefix removed. */
  executable: string | null;
  /** Directory the script changes to before the launch (cd, pushd, start /d), as written. */
  workingDir: string | null;
  /** The script refers to its own directory (%~dp0, $(dirname "$0")), which is unknown here. */
  usesScriptDir: boolean;
  /** Arguments after the program, quotes removed, as the engine receives them. */
  args: string[];
  /** Recognised flags by canonical name, value or true; the first occurrence, as the engine reads it. */
  flags: Record<string, string | true>;
  /** A priority the script asked for (start /high, nice -n 10). */
  priorityHint: PriorityClass | null;
  warnings: string[];
}

/** Read a launch script. Never throws; what it cannot use is listed in `warnings`. */
export function parseLaunchScript(text: string, fileName?: string): LaunchScript {
  const shell = detectShell(text, fileName);
  const result: LaunchScript = {
    shell,
    commandLine: null,
    executable: null,
    workingDir: null,
    usesScriptDir: false,
    args: [],
    flags: {},
    priorityHint: null,
    warnings: [],
  };
  const vars = new Map<string, string>();
  const key = (name: string) => (shell === "cmd" ? name.toLowerCase() : name);
  const finish = (value: string) => {
    const r = resolveScriptDir(value);
    if (r.usedScriptDir) result.usesScriptDir = true;
    return r.value;
  };

  for (const original of joinContinuations(text, shell)) {
    let line = original.trim();
    if (!line) continue;
    if (shell === "cmd") {
      line = line.replace(/^@+/, "").trim();
      if (CMD_SKIP.test(line) || /^[A-Za-z]:$/.test(line)) continue;
    } else {
      line = line.replace(/^(then|do|else)\s+/, "");
      if (line.startsWith("#") || SH_SKIP.test(line)) continue;
      line = line.replace(/^export\s+/, "");
    }
    line = substituteVars(markScriptDir(line, shell), vars, shell);

    // Variable assignments: cmd `set NAME=value` / `set "NAME=value"`; sh `NAME=value` alone on its line.
    if (shell === "cmd") {
      const set = /^set\s+"?([A-Za-z_][A-Za-z0-9_]*)=(.*?)"?\s*$/i.exec(line);
      if (set) {
        vars.set(key(set[1]), set[2].trim());
        continue;
      }
    }
    const commands = splitCommands(tokenize(line, shell));
    if (shell === "sh" && commands.length === 1 && commands[0].length === 1) {
      const set = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(commands[0][0].text);
      if (set) {
        vars.set(key(set[1]), set[2]);
        continue;
      }
    }

    for (const command of commands) {
      const first = command[0].text.toLowerCase();
      if (first === "cd" || first === "chdir" || first === "pushd") {
        const target = command.slice(1).filter((w) => !/^\/d$/i.test(w.text));
        if (target.length > 0) result.workingDir = target.map((w) => w.text).join(" ");
        continue;
      }
      if (result.commandLine !== null) continue;

      let words = command;
      // The launch inside one argument (sh -c "…", tmux new -d "…"): read that argument as the command.
      const inner = words.find((w) => /\s/.test(w.text) && w.text.split(/\s+/).some(isDedicatedWord));
      if (inner) {
        words = splitCommands(tokenize(inner.text, shell))[0] ?? [];
      } else if (!words.some((w) => isDedicatedWord(w.text))) {
        continue;
      }
      result.commandLine = original.trim();
      const wrapped = stripWrappers(words, shell);
      if (wrapped.workingDir) result.workingDir = wrapped.workingDir;
      if (wrapped.priorityHint) result.priorityHint = wrapped.priorityHint;
      const [exe, ...rest] = wrapped.words;
      if (!exe || isDedicatedWord(exe.text)) {
        result.warnings.push("The launch line names no program before its flags.");
        result.args = (exe ? [exe, ...rest] : rest).map((w) => finish(w.text));
      } else {
        result.executable = finish(exe.text);
        result.args = rest.map((w) => finish(w.text));
      }
    }
  }

  if (result.workingDir !== null) result.workingDir = finish(result.workingDir);
  if (result.commandLine === null) {
    result.warnings.push("No line in the script starts the server with -dedicated <config>.");
    return result;
  }
  readFlags(result);
  return result;
}

function readFlags(result: LaunchScript): void {
  const { args, flags, warnings } = result;
  if (args.length + 1 > ENGINE_MAX_ARGS) {
    warnings.push(`The engine reads only the first ${ENGINE_MAX_ARGS} command-line arguments; this line has ${args.length + 1}.`);
  }
  for (const a of args) {
    if (Buffer.byteLength(a) > ENGINE_MAX_ARG_BYTES) {
      warnings.push(`"${a.slice(0, 40)}…" is longer than the ${ENGINE_MAX_ARG_BYTES} characters the engine keeps per argument.`);
    }
  }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const name = arg === "-d" ? "dedicated" : canonicalFlag(arg);
    if (name === null) {
      warnings.push(`"${arg}" is not a flag or a flag's value; it is kept but nothing reads it.`);
      continue;
    }
    const info = ENGINE_FLAGS[name];
    const canonical = info?.alias ?? name;
    if (info) {
      let value: string | true = true;
      if (info.value) {
        if (i + 1 >= args.length) {
          warnings.push(`${arg} needs a value and has none.`);
          continue;
        }
        value = args[++i];
      }
      if (canonical in flags) {
        if (canonical !== "additionaldir") warnings.push(`${arg} appears more than once; the engine uses the first.`);
      } else {
        flags[canonical] = value;
      }
      continue;
    }
    if (name in NOT_READ) {
      warnings.push(`${arg} is not read by the open-source engine (older launchers and Pyro builds passed it).`);
      if (NOT_READ[name] && i + 1 < args.length) i++;
      continue;
    }
    const next = args[i + 1];
    if (next !== undefined && canonicalFlag(next) === null) {
      warnings.push(`${arg} is not a flag Pyrodeck knows; "${next}" is taken as its value.`);
      i++;
    } else {
      warnings.push(`${arg} is not a flag Pyrodeck knows.`);
    }
  }
}

// ---------------------------------------------------------------------------
// From script to profile
// ---------------------------------------------------------------------------

export interface ImportPlan {
  name: string;
  /** Directory with the game data and the config, or null when the script does not say. */
  gamePath: string | null;
  executablePath: string | null;
  /** Config file name inside gamePath. */
  configFile: string | null;
  /** Arguments Pyrodeck does not apply itself; kept on the profile and shown to the operator. */
  importedArgs: string[];
  notes: string[];
}

/**
 * Plan a profile. Pyrodeck starts the server in the game directory and passes
 * `-dedicated ./<config>` (ProcessManager.buildLaunchArgs), so the game
 * directory is where the script ran the server from: the directory it changed
 * to, else the program's directory, else the config's.
 */
export function planImport(script: LaunchScript): ImportPlan {
  const p = script.shell === "cmd" ? path.win32 : path.posix;
  const same = (a: string, b: string) =>
    script.shell === "cmd" ? p.normalize(a).toLowerCase() === p.normalize(b).toLowerCase() : p.normalize(a) === p.normalize(b);
  const absolute = (v: string | null) => (v && v !== "." && p.isAbsolute(v) ? p.normalize(v).replace(/[\\/]+$/, "") : null);
  const notes: string[] = [];

  const cfg = typeof script.flags.dedicated === "string" ? script.flags.dedicated : null;
  const exe = script.executable;
  const gamePath = absolute(script.workingDir) ?? (exe ? absolute(p.dirname(exe)) : null) ?? (cfg ? absolute(p.dirname(cfg)) : null);
  if (!gamePath) {
    notes.push(
      script.usesScriptDir || script.workingDir === "."
        ? "The script runs the server from its own directory. Set the Game Path to the directory the script is in."
        : "The script does not say which directory the server runs in. Set the Game Path to the Descent 3 directory.",
    );
  }

  let configFile: string | null = null;
  if (cfg) {
    configFile = p.basename(cfg);
    const dir = p.dirname(cfg);
    if (dir !== ".") {
      const cfgDir = p.isAbsolute(dir) ? dir : null;
      if (!cfgDir || !gamePath || !same(cfgDir, gamePath)) {
        notes.push(`Pyrodeck reads ${configFile} from the Game Path; copy it there from ${dir} if it is not there already.`);
      }
    }
  } else {
    notes.push("The script gives no server config (-dedicated <file>).");
  }

  let executablePath: string | null = null;
  if (exe) {
    const exeAbs = absolute(exe);
    if (exeAbs && gamePath && same(p.dirname(exeAbs), gamePath)) executablePath = p.basename(exeAbs);
    else if (exeAbs) executablePath = exeAbs;
    else executablePath = exe.replace(/^\.[\\/]/, "");
  }

  // Everything but -dedicated <cfg> goes to importedArgs; Pyrodeck passes its
  // own -autoexec (the game directory's autoexec.dmfc) when that file exists.
  const importedArgs: string[] = [];
  for (let i = 0; i < script.args.length; i++) {
    const arg = script.args[i];
    const name = arg === "-d" ? "dedicated" : canonicalFlag(arg);
    if (name === "dedicated") {
      i++;
      continue;
    }
    if (name === "autoexec" && i + 1 < script.args.length) {
      const value = script.args[i + 1];
      const own = p.basename(value).toLowerCase() === "autoexec.dmfc" && (p.dirname(value) === "." || (gamePath !== null && same(p.dirname(value), gamePath)));
      if (own) {
        i++;
        continue;
      }
      notes.push(
        `The script passes -autoexec ${value}. Pyrodeck passes the Game Path's autoexec.dmfc (Config tab, Startup Commands) instead; copy the commands there.`,
      );
    }
    importedArgs.push(arg);
  }
  if (importedArgs.length > 0) {
    notes.push("Launch flags Pyrodeck does not apply are kept on the profile as imported flags, for reference.");
  }
  if (script.priorityHint && script.priorityHint !== "normal") {
    notes.push(`The script started the server at ${script.priorityHint} priority: Settings > Process priority does that in Pyrodeck.`);
  }

  const name = configFile ? configFile.replace(/\.[^.]+$/, "") : "Imported server";
  return { name, gamePath, executablePath, configFile, importedArgs, notes };
}

const MAX_IMPORTED_ARGS = 60;
const MAX_IMPORTED_ARG_LENGTH = 260;

/** Coerce untrusted importedArgs into a list of plain strings; null when nothing is left. */
export function sanitizeImportedArgs(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const out = raw
    .filter((a): a is string => typeof a === "string")
    // eslint-disable-next-line no-control-regex
    .filter((a) => a.length > 0 && a.length <= MAX_IMPORTED_ARG_LENGTH && !/[\x00-\x1f]/.test(a))
    .slice(0, MAX_IMPORTED_ARGS);
  return out.length > 0 ? out : null;
}
