import { describe, it, expect } from "vitest";
import { buildChildEnv, isPassedToGame, launchEnvDefaults } from "./childEnv.js";

/** What a Pyrodeck service typically runs with (systemd unit, Ansible, a shell). */
const SERVICE_ENV: Record<string, string> = {
  PATH: "/usr/local/bin:/usr/bin",
  HOME: "/home/d3host",
  USER: "d3host",
  LOGNAME: "d3host",
  SHELL: "/bin/bash",
  TMPDIR: "/tmp/d3",
  TZ: "Europe/Berlin",
  LANG: "en_US.UTF-8",
  LANGUAGE: "en_US",
  LC_ALL: "en_US.UTF-8",
  LC_TIME: "de_DE.UTF-8",
  XDG_DATA_HOME: "/srv/d3/data",
  LD_LIBRARY_PATH: "/opt/d3/lib",
  D3_LOCAL: "/opt/d3",
  SDL_AUDIODRIVER: "dummy",
  // Pyrodeck's own settings and secrets
  PYRODECK_ADMIN_PASSWORD: "hunter2",
  PYRODECK_SESSION_SECRET: "0123456789abcdef",
  PYRODECK_PORT: "3001",
  PYRODECK_HOST: "127.0.0.1",
  PYRODECK_TRUST_PROXY: "1",
  PYRODECK_AUTOSTART_PROFILE: "Public CTF",
  PYRODECK_CONFIG_DIR: "/var/lib/pyrodeck",
  PYRODECK_LOG_RETENTION_DAYS: "30",
  // Things a service manager or a shell adds that the game has no use for
  AWS_SECRET_ACCESS_KEY: "aws-secret",
  DATABASE_URL: "postgres://u:p@db/x",
  GITHUB_TOKEN: "ghp_x",
  NODE_OPTIONS: "--max-old-space-size=512",
  INVOCATION_ID: "abc",
  JOURNAL_STREAM: "8:1234",
  DISPLAY: ":0",
};

describe("buildChildEnv", () => {
  const env = buildChildEnv(SERVICE_ENV);

  it("passes no PYRODECK_* variable", () => {
    expect(Object.keys(env).filter((k) => k.toUpperCase().startsWith("PYRODECK_"))).toEqual([]);
    expect(Object.values(env)).not.toContain("hunter2");
    expect(Object.values(env)).not.toContain("0123456789abcdef");
  });

  it("drops other variables the game has no use for", () => {
    for (const name of ["AWS_SECRET_ACCESS_KEY", "DATABASE_URL", "GITHUB_TOKEN", "NODE_OPTIONS", "INVOCATION_ID", "DISPLAY"]) {
      expect(env, name).not.toHaveProperty(name);
    }
  });

  it("keeps what the game needs, unchanged", () => {
    for (const name of [
      "PATH",
      "HOME",
      "USER",
      "LOGNAME",
      "SHELL",
      "TMPDIR",
      "TZ",
      "LANG",
      "LANGUAGE",
      "LC_ALL",
      "LC_TIME",
      "XDG_DATA_HOME",
      "LD_LIBRARY_PATH",
      "D3_LOCAL",
      "SDL_AUDIODRIVER",
    ]) {
      expect(env[name], name).toBe(SERVICE_ENV[name]);
    }
  });

  it("sets SDL_VIDEODRIVER=dummy unless the environment chose a driver", () => {
    expect(env.SDL_VIDEODRIVER).toBe("dummy");
    expect(buildChildEnv({ ...SERVICE_ENV, SDL_VIDEODRIVER: "offscreen" }).SDL_VIDEODRIVER).toBe("offscreen");
    expect(launchEnvDefaults({})).toEqual({ SDL_VIDEODRIVER: "dummy" });
  });

  it("is exactly the allowed variables plus the launch's own", () => {
    expect(Object.keys(env).sort()).toEqual(
      [
        "PATH",
        "HOME",
        "USER",
        "LOGNAME",
        "SHELL",
        "TMPDIR",
        "TZ",
        "LANG",
        "LANGUAGE",
        "LC_ALL",
        "LC_TIME",
        "XDG_DATA_HOME",
        "LD_LIBRARY_PATH",
        "D3_LOCAL",
        "SDL_AUDIODRIVER",
        "SDL_VIDEODRIVER",
      ].sort(),
    );
  });

  it("keeps the Windows system variables, whatever their case", () => {
    const win = buildChildEnv({
      Path: "C:\\Windows\\system32",
      SystemRoot: "C:\\Windows",
      windir: "C:\\Windows",
      ComSpec: "C:\\Windows\\system32\\cmd.exe",
      TEMP: "C:\\Users\\d3\\AppData\\Local\\Temp",
      USERPROFILE: "C:\\Users\\d3",
      APPDATA: "C:\\Users\\d3\\AppData\\Roaming",
      LOCALAPPDATA: "C:\\Users\\d3\\AppData\\Local",
      "ProgramFiles(x86)": "C:\\Program Files (x86)",
      Pyrodeck_Admin_Password: "hunter2",
    });
    expect(win).toMatchObject({
      Path: "C:\\Windows\\system32",
      SystemRoot: "C:\\Windows",
      windir: "C:\\Windows",
      ComSpec: "C:\\Windows\\system32\\cmd.exe",
      APPDATA: "C:\\Users\\d3\\AppData\\Roaming",
      "ProgramFiles(x86)": "C:\\Program Files (x86)",
    });
    expect(win).not.toHaveProperty("Pyrodeck_Admin_Password");
  });

  it("never passes a PYRODECK_* variable, even one the launch sets itself", () => {
    expect(buildChildEnv({ PATH: "/bin" }, { PYRODECK_SIDECAR: "1", SDL_VIDEODRIVER: "dummy" })).toEqual({
      PATH: "/bin",
      SDL_VIDEODRIVER: "dummy",
    });
  });

  it("skips unset variables", () => {
    expect(buildChildEnv({ PATH: "/bin", HOME: undefined })).toEqual({ PATH: "/bin", SDL_VIDEODRIVER: "dummy" });
  });
});

describe("isPassedToGame", () => {
  it.each([
    ["PATH", true],
    ["lc_ctype", true],
    ["XDG_RUNTIME_DIR", true],
    ["PYRODECK_ADMIN_PASSWORD", false],
    ["pyrodeck_session_secret", false],
    ["PYRODECK_SIDECAR", false],
    ["SSH_AUTH_SOCK", false],
    ["LD_PRELOAD", false],
  ])("%s → %s", (name, passed) => {
    expect(isPassedToGame(name)).toBe(passed);
  });
});
