import { describe, it, expect } from "vitest";
import { canonicalFlag, parseLaunchScript, planImport } from "./launchScript.js";

describe("canonicalFlag (the engine's SkipArgPrefix + case-insensitive match)", () => {
  it("strips -, -- and +, and lower-cases", () => {
    expect(canonicalFlag("-UsePort")).toBe("useport");
    expect(canonicalFlag("--useport")).toBe("useport");
    expect(canonicalFlag("+host")).toBe("host");
    expect(canonicalFlag("-")).toBeNull();
    expect(canonicalFlag("--")).toBeNull();
    expect(canonicalFlag("++x")).toBeNull();
    expect(canonicalFlag("server.cfg")).toBeNull();
  });
});

describe("parseLaunchScript: Windows batch files", () => {
  it("reads a D3Server3-style line with quoted paths containing spaces", () => {
    const bat = [
      "@echo off",
      "rem Friday CTF server",
      'cd /d "C:\\Games\\Descent 3"',
      'start "D3 CTF" /min /high "C:\\Games\\Descent 3\\main.exe" -dedicated "ctf server.cfg" -autoexec "C:\\Games\\Descent 3\\ctf.dmfc" -useport 2118 -gamespyport 20208 -gspyfile gamespy.cfg -framecap 30 -nomultibmp',
      "exit",
    ].join("\r\n");
    const s = parseLaunchScript(bat, "ctf.bat");
    expect(s.shell).toBe("cmd");
    expect(s.workingDir).toBe("C:\\Games\\Descent 3");
    expect(s.executable).toBe("C:\\Games\\Descent 3\\main.exe");
    expect(s.priorityHint).toBe("high");
    expect(s.flags).toEqual({
      dedicated: "ctf server.cfg",
      autoexec: "C:\\Games\\Descent 3\\ctf.dmfc",
      useport: "2118",
      gamespyport: "20208",
      gspyfile: "gamespy.cfg",
      framecap: "30",
      nomultibmp: true,
    });
    expect(s.warnings).toEqual([]);

    const plan = planImport(s);
    expect(plan.gamePath).toBe("C:\\Games\\Descent 3");
    expect(plan.executablePath).toBe("main.exe");
    expect(plan.configFile).toBe("ctf server.cfg");
    expect(plan.name).toBe("ctf server");
    expect(plan.importedArgs).toEqual([
      "-autoexec",
      "C:\\Games\\Descent 3\\ctf.dmfc",
      "-useport",
      "2118",
      "-gamespyport",
      "20208",
      "-gspyfile",
      "gamespy.cfg",
      "-framecap",
      "30",
      "-nomultibmp",
    ]);
    expect(plan.notes.join(" ")).toMatch(/Startup Commands/);
    expect(plan.notes.join(" ")).toMatch(/high priority/);
  });

  it("strips %~dp0, matches flags case-insensitively with any prefix, keeps the first of a repeat", () => {
    const s = parseLaunchScript('%~dp0main.exe -DEDICATED server.cfg +host 2092 --UseIP 192.0.2.4 -useport 9999 -nocrashbox\n', "go.cmd");
    expect(s.executable).toBe("main.exe");
    expect(s.usesScriptDir).toBe(true);
    expect(s.flags).toMatchObject({ dedicated: "server.cfg", useport: "2092", useip: "192.0.2.4" });
    expect(s.warnings).toEqual([
      "-useport appears more than once; the engine uses the first.",
      "-nocrashbox is not read by the open-source engine (older launchers and Pyro builds passed it).",
    ]);
    const plan = planImport(s);
    expect(plan.gamePath).toBeNull();
    expect(plan.notes[0]).toMatch(/directory the script is in/);
  });

  it("follows set variables, ^ continuations and a /d start directory, and drops redirections", () => {
    const bat = [
      "@echo off",
      'set "D3=D:\\D3 Server"',
      "set CFG=anarchy.cfg",
      'start "" /d "%D3%" /belownormal "%D3%\\Descent3.exe" ^',
      "  -dedicated %CFG% ^",
      "  -useport 2118 > server.log 2>&1",
    ].join("\n");
    const s = parseLaunchScript(bat, "a.bat");
    expect(s.workingDir).toBe("D:\\D3 Server");
    expect(s.executable).toBe("D:\\D3 Server\\Descent3.exe");
    expect(s.args).toEqual(["-dedicated", "anarchy.cfg", "-useport", "2118"]);
    expect(s.priorityHint).toBe("below-normal");
  });

  it("reads -d as the config flag and a quoted program right after start", () => {
    const s = parseLaunchScript('start "C:\\D3\\main.exe" -d "C:\\Servers\\hoard.cfg"', "h.bat");
    expect(s.executable).toBe("C:\\D3\\main.exe");
    expect(s.flags.dedicated).toBe("C:\\Servers\\hoard.cfg");
    const plan = planImport(s);
    expect(plan.gamePath).toBe("C:\\D3");
    expect(plan.configFile).toBe("hoard.cfg");
    expect(plan.notes.join(" ")).toMatch(/copy it there from C:\\Servers/);
  });

  it("says so when no line launches a server", () => {
    const s = parseLaunchScript("@echo off\necho hello\npause\n", "x.bat");
    expect(s.commandLine).toBeNull();
    expect(s.warnings).toEqual(["No line in the script starts the server with -dedicated <config>."]);
  });
});

describe("parseLaunchScript: shell scripts", () => {
  it("reads cd into the script directory, exec, quotes and a log redirect", () => {
    const sh = [
      "#!/bin/sh",
      "# start the Matcen server",
      'cd "$(dirname "$0")"',
      "exec ./Descent3 -dedicated ./matcen-dedicated.cfg -useport 2118 -gamespyport 20208 >> server.log 2>&1 &",
    ].join("\n");
    const s = parseLaunchScript(sh, "run.sh");
    expect(s.shell).toBe("sh");
    expect(s.workingDir).toBe(".");
    expect(s.usesScriptDir).toBe(true);
    expect(s.executable).toBe("./Descent3");
    expect(s.args).toEqual(["-dedicated", "./matcen-dedicated.cfg", "-useport", "2118", "-gamespyport", "20208"]);
    const plan = planImport(s);
    expect(plan.gamePath).toBeNull();
    expect(plan.executablePath).toBe("Descent3");
    expect(plan.configFile).toBe("matcen-dedicated.cfg");
    expect(plan.importedArgs).toEqual(["-useport", "2118", "-gamespyport", "20208"]);
  });

  it("keeps the quotes around a script-directory prefix", () => {
    const forms = [
      '"$(dirname "$0")/Descent3" -dedicated "my server.cfg"',
      '"${0%/*}/Descent3" -dedicated "my server.cfg"',
      '"$PWD/Descent3" -dedicated "my server.cfg"',
      'DIR="$(cd "$(dirname "$0")" && pwd)"\n"$DIR/Descent3" -dedicated "my server.cfg"',
    ];
    for (const sh of forms) {
      const s = parseLaunchScript(sh, "x.sh");
      expect(s.executable).toBe("Descent3");
      expect(s.flags.dedicated).toBe("my server.cfg");
      expect(s.usesScriptDir).toBe(true);
    }
  });

  it("handles variables, single quotes, backslash continuations, nohup and nice", () => {
    const sh = [
      "#!/bin/bash",
      'D3DIR="/opt/descent 3"',
      'cd "$D3DIR" || exit 1',
      "nohup nice -n 10 \\",
      "  \"$D3DIR/Descent3\" -dedicated 'team anarchy.cfg' \\",
      "  -framecap 60 | tee -a d3.log",
    ].join("\n");
    const s = parseLaunchScript(sh, "d3.sh");
    expect(s.workingDir).toBe("/opt/descent 3");
    expect(s.executable).toBe("/opt/descent 3/Descent3");
    expect(s.flags).toEqual({ dedicated: "team anarchy.cfg", framecap: "60" });
    expect(s.priorityHint).toBe("below-normal");
    const plan = planImport(s);
    expect(plan.gamePath).toBe("/opt/descent 3");
    expect(plan.executablePath).toBe("Descent3");
    expect(plan.configFile).toBe("team anarchy.cfg");
    expect(plan.importedArgs).toEqual(["-framecap", "60"]);
  });

  it("finds the launch inside screen and inside a quoted tmux command", () => {
    const screen = parseLaunchScript("screen -dmS d3 /srv/d3/Descent3 -dedicated ctf.cfg\n", "s.sh");
    expect(screen.executable).toBe("/srv/d3/Descent3");
    expect(planImport(screen).gamePath).toBe("/srv/d3");
    const tmux = parseLaunchScript("tmux new-session -d -s d3 '/srv/d3/Descent3 -dedicated ctf.cfg -useport 2118'\n", "t.sh");
    expect(tmux.executable).toBe("/srv/d3/Descent3");
    expect(tmux.flags).toEqual({ dedicated: "ctf.cfg", useport: "2118" });
  });

  it("keeps the game directory's own autoexec.dmfc out of the imported flags", () => {
    const s = parseLaunchScript("cd /srv/d3\n./Descent3 -dedicated ctf.cfg -autoexec /srv/d3/autoexec.dmfc -tempdir /tmp/d3a\n", "x.sh");
    const plan = planImport(s);
    expect(plan.gamePath).toBe("/srv/d3");
    expect(plan.importedArgs).toEqual(["-tempdir", "/tmp/d3a"]);
  });

  it("warns about values without flags, flags without values, unknown flags and over-long arguments", () => {
    const long = "x".repeat(120);
    const s = parseLaunchScript(`./Descent3 -dedicated a.cfg stray -weird val -useport\n./Descent3 -dedicated b.cfg\n-${long}`, "w.sh");
    expect(s.flags.dedicated).toBe("a.cfg");
    expect(s.warnings).toEqual([
      '"stray" is not a flag or a flag\'s value; it is kept but nothing reads it.',
      '-weird is not a flag Pyrodeck knows; "val" is taken as its value.',
      "-useport needs a value and has none.",
    ]);
    const tooLong = parseLaunchScript(`./Descent3 -dedicated a.cfg -tempdir /${long}`, "l.sh");
    expect(tooLong.warnings[0]).toMatch(/longer than the 99 characters/);
  });
});
