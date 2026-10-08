import { describe, it, expect } from "vitest";
import {
  parseDedicatedCfg,
  entriesToStructured,
  structuredToString,
  parseMpsFile,
  generateMpsFile,
  parseBotRoster,
  generateBotRoster,
  extractTelnetConfig,
  generateDedicatedCfg,
  PYRODECK_DEFAULTS,
} from "./ConfigGenerator.js";

// ---------------------------------------------------------------------------
// parseDedicatedCfg
// ---------------------------------------------------------------------------

describe("parseDedicatedCfg", () => {
  it("parses basic key=value lines", () => {
    const entries = parseDedicatedCfg("GameName=My Server\nPPS=20\n");
    expect(entries).toEqual([
      { key: "GameName", value: "My Server" },
      { key: "PPS", value: "20" },
    ]);
  });

  it("skips comments and blank lines", () => {
    const entries = parseDedicatedCfg("# comment\n; also comment\n\nGameName=Test\n");
    expect(entries).toHaveLength(1);
    expect(entries[0].key).toBe("GameName");
  });

  it("preserves duplicate keys (AllowPowerup)", () => {
    const entries = parseDedicatedCfg(
      "AllowPowerup=Energy\nAllowPowerup=Shield\nAllowPowerup=Mega\n",
    );
    expect(entries).toHaveLength(3);
    expect(entries.map((e) => e.value)).toEqual(["Energy", "Shield", "Mega"]);
  });

  it("handles value containing equals sign", () => {
    const entries = parseDedicatedCfg("MOTD=Welcome=to=server\n");
    expect(entries[0].value).toBe("Welcome=to=server");
  });

  it("strips the [server config file] tag line", () => {
    const entries = parseDedicatedCfg("[server config file]\nGameName=Test\n");
    // Tag line has no = so it's skipped
    expect(entries).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// entriesToStructured
// ---------------------------------------------------------------------------

describe("entriesToStructured", () => {
  it("applies D3 engine defaults for missing keys", () => {
    const data = entriesToStructured([]);
    expect(data.gameName).toBe("Generic D3 Game");
    expect(data.pps).toBe(10);
    expect(data.randomizeRespawn).toBe(true);
    expect(data.difficulty).toBe(2);
    expect(data.maxPlayers).toBe(8);
    expect(data.respawnTime).toBe(60);
  });

  it("parses standard fields correctly", () => {
    const entries = parseDedicatedCfg(
      "[server config file]\n" +
      "GameName=Bot Arena\n" +
      "MissionName=fury.mn3\n" +
      "Scriptname=Anarchy.d3m\n" +
      "MaxPlayers=8\n" +
      "PPS=20\n" +
      "Timelimit=20\n" +
      "Killgoal=25\n" +
      "RespawnTime=30\n" +
      "SetDifficulty=2\n" +
      "AllowRemoteConsole=1\n" +
      "RemoteConsolePort=2092\n" +
      "ConsolePassword=secret\n",
    );
    const data = entriesToStructured(entries);
    expect(data.gameName).toBe("Bot Arena");
    expect(data.pps).toBe(20);
    expect(data.timeLimit).toBe(20);
    expect(data.killGoal).toBe(25);
    expect(data.respawnTime).toBe(30);
    expect(data.allowRemoteConsole).toBe(true);
    expect(data.consolePassword).toBe("secret");
    expect(data.networkModel).toBe("client-server");
  });

  it("normalizes Scriptname with and without .d3m extension", () => {
    const withExt = entriesToStructured(parseDedicatedCfg("Scriptname=Anarchy.d3m\n"));
    expect(withExt.scriptName).toBe("Anarchy.d3m");

    const withoutExt = entriesToStructured(parseDedicatedCfg("Scriptname=Anarchy\n"));
    expect(withoutExt.scriptName).toBe("Anarchy.d3m");
  });

  it("detects peer2peer network model", () => {
    const data = entriesToStructured(parseDedicatedCfg("Peer2Peer=1\n"));
    expect(data.networkModel).toBe("peer2peer");
  });

  it("detects permissable network model", () => {
    const data = entriesToStructured(parseDedicatedCfg("Permissable=1\n"));
    expect(data.networkModel).toBe("permissable");
  });

  it("collects AllowPowerup and DisallowPowerup lists", () => {
    const entries = parseDedicatedCfg(
      "AllowPowerup=Energy\nAllowPowerup=Shield\nDisallowPowerup=ProxMinePowerup\n",
    );
    const data = entriesToStructured(entries);
    expect(data.allowedPowerups).toEqual(["Energy", "Shield"]);
    expect(data.disallowedPowerups).toEqual(["ProxMinePowerup"]);
  });

  it("parses boolean flags correctly", () => {
    const data = entriesToStructured(
      parseDedicatedCfg("AccurateCollisions=1\nBrightPlayers=1\nAllowMouselook=1\n"),
    );
    expect(data.accurateCollisions).toBe(true);
    expect(data.brightPlayers).toBe(true);
    expect(data.allowMouselook).toBe(true);
  });

  it("parses BotConfig and MultiSettingsFile references", () => {
    const data = entriesToStructured(
      parseDedicatedCfg("BotConfig=bots.cfg\nMultiSettingsFile=ships.mps\n"),
    );
    expect(data.botConfigFile).toBe("bots.cfg");
    expect(data.multiSettingsFile).toBe("ships.mps");
  });
});

// ---------------------------------------------------------------------------
// structuredToString — round-trip
// ---------------------------------------------------------------------------

describe("structuredToString", () => {
  it("generates a valid cfg string from structured data", () => {
    const data = entriesToStructured(
      parseDedicatedCfg(
        "[server config file]\n" +
        "GameName=Test Server\n" +
        "MissionName=fury.mn3\n" +
        "Scriptname=Anarchy.d3m\n" +
        "MaxPlayers=8\n" +
        "PPS=20\n" +
        "Timelimit=15\n" +
        "Killgoal=0\n" +
        "AllowRemoteConsole=1\n" +
        "RemoteConsolePort=2092\n" +
        "ConsolePassword=test\n",
      ),
    );
    const output = structuredToString(data);
    expect(output).toMatch(/^\[server config file\]/);
    expect(output).toContain("GameName=Test Server");
    expect(output).toContain("PPS=20");
    expect(output).toContain("AllowRemoteConsole=1");
    expect(output).toContain("ConsolePassword=test");
  });

  it("round-trips key fields faithfully", () => {
    const original =
      "[server config file]\n" +
      "GameName=Round Trip Server\n" +
      "MissionName=bedlam.mn3\n" +
      "Scriptname=CTF.d3m\n" +
      "MaxPlayers=12\n" +
      "PPS=30\n" +
      "Timelimit=0\n" +
      "Killgoal=0\n" +
      "RespawnTime=30\n" +
      "SetDifficulty=1\n" +
      "NumTeams=2\n" +
      "AllowRemoteConsole=1\n" +
      "RemoteConsolePort=2093\n" +
      "ConsolePassword=roundtrip\n" +
      "DisallowPowerup=ProxMinePowerup\n" +
      "DisallowPowerup=Betty4Pack\n";

    const entries = parseDedicatedCfg(original);
    const data = entriesToStructured(entries);
    const output = structuredToString(data);
    const reparsed = entriesToStructured(parseDedicatedCfg(output));

    expect(reparsed.gameName).toBe("Round Trip Server");
    expect(reparsed.missionName).toBe("bedlam.mn3");
    expect(reparsed.scriptName).toBe("CTF.d3m");
    expect(reparsed.maxPlayers).toBe(12);
    expect(reparsed.pps).toBe(30);
    expect(reparsed.difficulty).toBe(1);
    expect(reparsed.consolePassword).toBe("roundtrip");
    expect(reparsed.disallowedPowerups).toEqual(["ProxMinePowerup", "Betty4Pack"]);
  });

  it("only emits Peer2Peer=1 when networkModel is peer2peer", () => {
    const data = entriesToStructured(parseDedicatedCfg("Peer2Peer=1\n"));
    const output = structuredToString(data);
    expect(output).toContain("Peer2Peer=1");
    expect(output).not.toContain("Permissable=1");
  });

  it("omits RandomizeRespawn=0 only when explicitly disabled", () => {
    const withDefault = entriesToStructured([]);
    const outputDefault = structuredToString(withDefault);
    // randomizeRespawn=true is the default — we don't emit the CVar
    expect(outputDefault).not.toContain("RandomizeRespawn");

    const withDisabled = entriesToStructured(parseDedicatedCfg("RandomizeRespawn=0\n"));
    const outputDisabled = structuredToString(withDisabled);
    expect(outputDisabled).toContain("RandomizeRespawn=0");
  });
});

// ---------------------------------------------------------------------------
// MPS file parse / generate
// ---------------------------------------------------------------------------

describe("parseMpsFile", () => {
  it("extracts SHIPBAN entries", () => {
    const content = "SHIPBAN\tBlack Pyro\nSHIPBAN\tPhoenix\n";
    const result = parseMpsFile(content);
    expect(result.bannedShips).toEqual(["Black Pyro", "Phoenix"]);
  });

  it("ignores non-SHIPBAN entries and comments", () => {
    const content = "# comment\nNAME\tMy Server\nSHIPBAN\tMagnum-AHT\n";
    const result = parseMpsFile(content);
    expect(result.bannedShips).toEqual(["Magnum-AHT"]);
  });

  it("returns empty bannedShips for empty file", () => {
    expect(parseMpsFile("").bannedShips).toEqual([]);
    expect(parseMpsFile("# just a comment\n").bannedShips).toEqual([]);
  });
});

describe("generateMpsFile", () => {
  it("generates SHIPBAN lines", () => {
    const output = generateMpsFile({ bannedShips: ["Black Pyro", "Phoenix"] });
    expect(output).toContain("SHIPBAN\tBlack Pyro");
    expect(output).toContain("SHIPBAN\tPhoenix");
  });

  it("returns empty string for no bans", () => {
    expect(generateMpsFile({ bannedShips: [] })).toBe("");
  });

  it("round-trips correctly", () => {
    const original = { bannedShips: ["Black Pyro", "Magnum-AHT"] };
    const reparsed = parseMpsFile(generateMpsFile(original));
    expect(reparsed.bannedShips).toEqual(original.bannedShips);
  });
});

// ---------------------------------------------------------------------------
// Bot roster parse / generate
// ---------------------------------------------------------------------------

describe("parseBotRoster", () => {
  it("parses a basic bot roster", () => {
    const content =
      "BotCount=3\n" +
      "BotDifficulty=hotshot\n" +
      "BotName1=Viper\n" +
      "BotShip1=pyro\n" +
      "BotName2=Reaper\n" +
      "BotShip2=phoenix\n" +
      "BotDifficulty2=ace\n" +
      "BotName3=Shadow\n" +
      "BotShip3=blackpyro\n";

    const result = parseBotRoster(content);
    expect(result.botCount).toBe(3);
    expect(result.defaultDifficulty).toBe("hotshot");
    expect(result.bots).toHaveLength(3);
    expect(result.bots[0]).toEqual({ name: "Viper", ship: "pyro", difficulty: undefined });
    expect(result.bots[1]).toEqual({ name: "Reaper", ship: "phoenix", difficulty: "ace" });
    expect(result.bots[2]).toEqual({ name: "Shadow", ship: "blackpyro", difficulty: undefined });
  });

  it("handles missing BotName entries gracefully", () => {
    // BotCount=2 but only BotName1 defined
    const result = parseBotRoster("BotCount=2\nBotName1=Alpha\nBotShip1=pyro\n");
    expect(result.bots).toHaveLength(1);
  });
});

describe("generateBotRoster", () => {
  it("generates a valid roster file", () => {
    const data = {
      botCount: 2,
      defaultDifficulty: "hotshot",
      bots: [
        { name: "Viper", ship: "pyro" },
        { name: "Reaper", ship: "phoenix", difficulty: "ace" },
      ],
    };
    const output = generateBotRoster(data);
    expect(output).toContain("BotCount=2");
    expect(output).toContain("BotDifficulty=hotshot");
    expect(output).toContain("BotName1=Viper");
    expect(output).toContain("BotShip1=pyro");
    expect(output).toContain("BotName2=Reaper");
    expect(output).toContain("BotDifficulty2=ace");
  });

  it("round-trips correctly", () => {
    const original = {
      botCount: 2,
      defaultDifficulty: "rookie",
      bots: [
        { name: "Alpha", ship: "pyro", difficulty: undefined },
        { name: "Beta", ship: "magnum", difficulty: "insane" },
      ],
    };
    const reparsed = parseBotRoster(generateBotRoster(original));
    expect(reparsed.botCount).toBe(2);
    expect(reparsed.defaultDifficulty).toBe("rookie");
    expect(reparsed.bots[0].name).toBe("Alpha");
    expect(reparsed.bots[1].difficulty).toBe("insane");
  });
});

// ---------------------------------------------------------------------------
// Remote console settings
// ---------------------------------------------------------------------------

describe("remote console settings", () => {
  it("reads AllowRemoteConsole as the engine does: 1 is remote, 0 or absent is local only", () => {
    const remote = extractTelnetConfig(parseDedicatedCfg("AllowRemoteConsole=1\nRemoteConsolePort=2106\nConsolePassword=pw\n"));
    expect(remote).toEqual({ allowRemote: true, port: 2106, password: "pw" });
    expect(extractTelnetConfig(parseDedicatedCfg("AllowRemoteConsole=0\nConsolePassword=pw\n"))).toEqual({
      allowRemote: false,
      port: 2092,
      password: "pw",
    });
    expect(extractTelnetConfig(parseDedicatedCfg("ConsolePassword=pw\n")).allowRemote).toBe(false);
  });

  it("generates new configs with a local-only console, a port and a password", () => {
    const cfg = generateDedicatedCfg({ remoteConsolePort: 2106 });
    expect(cfg).toContain("AllowRemoteConsole=0\n");
    expect(cfg).toContain("RemoteConsolePort=2106\n");
    const telnet = extractTelnetConfig(parseDedicatedCfg(cfg));
    expect(telnet.allowRemote).toBe(false);
    expect(telnet.password).toMatch(/^[0-9a-f]{8}$/);
  });

  it("still writes AllowRemoteConsole=1 when asked", () => {
    expect(generateDedicatedCfg({ allowRemoteConsole: true })).toContain("AllowRemoteConsole=1\n");
  });

  it("recommends a local-only console for new structured configs", () => {
    expect(PYRODECK_DEFAULTS.allowRemoteConsole).toBe(false);
  });
});
