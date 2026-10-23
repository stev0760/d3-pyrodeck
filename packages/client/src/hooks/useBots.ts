import { useState, useEffect, useCallback } from "react";

export interface BotEntry {
  index: number;
  callsign: string;
  slot: number;
  ship: string;
  difficulty: string;
  alive: boolean;
}

export interface BotStatus {
  index: number;
  callsign: string;
  slot: number;
  state: string;
  role: string;
  lean: string;
  speed: number;
  shields: number;
  target: string | null;
}

export const SHIPS = ["pyro", "phoenix", "magnum", "blackpyro"];
export const DIFFICULTIES = ["trainee", "rookie", "hotshot", "ace", "insane"];
// The server cuts the base name to 14 characters (19-char callsign minus
// "[BOT]") and splits $addbot arguments on whitespace.
export const BOT_NAME_MAX = 14;

/** A bot base name as the server will use it: one token, at most 14 characters. */
export function cleanBotName(raw: string): string {
  return raw.replace(/\s+/g, "").slice(0, BOT_NAME_MAX);
}

export interface NewBot {
  name: string;
  ship?: string;
  difficulty?: string;
  /** 1-based team, "" or undefined for auto-balance. */
  team?: string;
}

interface UseBotsOptions {
  sendCommand: (command: string) => void;
  onBots: (callback: (data: unknown) => void) => () => void;
  onBotStats: (callback: (data: unknown) => void) => () => void;
  onBotMode: (callback: (data: unknown) => void) => () => void;
  hasShips: boolean;
  hasDifficulty: boolean;
  /** Server advertises `teams`: $addbot takes a 4th, 1-based team argument. */
  hasTeams: boolean;
}

/**
 * The bots in the game: `$botlist` every 5 s, `$botstat all` every 2.5 s
 * while any exist, `$botmode` once for the team count. The actions send the
 * matching console commands and refresh shortly after.
 */
export function useBots({ sendCommand, onBots, onBotStats, onBotMode, hasShips, hasDifficulty, hasTeams }: UseBotsOptions) {
  const [bots, setBots] = useState<BotEntry[]>([]);
  const [botStats, setBotStats] = useState<Map<number, BotStatus>>(new Map());
  const [teamCount, setTeamCount] = useState(0);

  // The team argument is positional after ship and difficulty, and only
  // means something in a team game ($botmode reports the team count).
  const showTeam = hasTeams && hasShips && hasDifficulty && teamCount >= 2;

  const refresh = useCallback(() => {
    sendCommand("$botlist");
  }, [sendCommand]);

  useEffect(() => {
    if (hasTeams) sendCommand("$botmode");
  }, [hasTeams, sendCommand]);

  useEffect(() => {
    const unsubscribe = onBotMode((data: unknown) => {
      const payload = data as { teams?: number };
      if (typeof payload.teams === "number") setTeamCount(payload.teams);
    });
    return unsubscribe;
  }, [onBotMode]);

  const refreshStats = useCallback(() => {
    sendCommand("$botstat all");
  }, [sendCommand]);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 5000);
    return () => clearInterval(interval);
  }, [refresh]);

  // Poll $botstat all every 2.5s when bots exist
  useEffect(() => {
    if (bots.length === 0) return;
    refreshStats();
    const interval = setInterval(refreshStats, 2500);
    return () => clearInterval(interval);
  }, [bots.length, refreshStats]);

  useEffect(() => {
    const unsubscribe = onBots((data: unknown) => {
      const payload = data as { bots: BotEntry[] };
      if (payload.bots) {
        setBots(payload.bots);
      }
    });
    return unsubscribe;
  }, [onBots]);

  useEffect(() => {
    const unsubscribe = onBotStats((data: unknown) => {
      const payload = data as { bots: BotStatus[] };
      if (payload.bots) {
        const map = new Map<number, BotStatus>();
        for (const b of payload.bots) {
          map.set(b.index, b);
        }
        setBotStats(map);
      }
    });
    return unsubscribe;
  }, [onBotStats]);

  const addBot = useCallback(
    (bot: NewBot) => {
      const name = cleanBotName(bot.name);
      if (!name) return false;
      // Arguments are positional: difficulty is read only after a ship, team
      // only after a difficulty.
      let cmd = `$addbot ${name}`;
      if (hasShips) {
        cmd += ` ${bot.ship || SHIPS[0]}`;
        if (hasDifficulty) {
          cmd += ` ${bot.difficulty || "hotshot"}`;
          if (showTeam && bot.team) cmd += ` ${bot.team}`;
        }
      }
      sendCommand(cmd);
      setTimeout(refresh, 500);
      return true;
    },
    [hasShips, hasDifficulty, showTeam, sendCommand, refresh],
  );

  const removeBot = useCallback(
    (index: number) => {
      sendCommand(`$removebot ${index}`);
      setTimeout(refresh, 500);
    },
    [sendCommand, refresh],
  );

  const removeAll = useCallback(() => {
    sendCommand("$removebots");
    setTimeout(refresh, 500);
  }, [sendCommand, refresh]);

  const setDifficulty = useCallback(
    (index: number, difficulty: string) => {
      sendCommand(`$botdifficulty ${index} ${difficulty}`);
    },
    [sendCommand],
  );

  return { bots, botStats, teamCount, showTeam, refresh, refreshStats, addBot, removeBot, removeAll, setDifficulty };
}
