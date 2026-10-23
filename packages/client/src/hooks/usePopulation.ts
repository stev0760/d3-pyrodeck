import { useState, useEffect, useCallback } from "react";

/** The `$botpopulation` status line (server parser/parsers/botpopulation.ts). */
export interface BotPopulation {
  manager: boolean;
  target: number;
  reserve: number;
  humans: number;
  bots: number;
  seatsUsed: number;
  seats: number;
  botLimit: number;
  note?: string;
}

interface UsePopulationOptions {
  sendCommand: (command: string) => void;
  onBotPopulation: (callback: (data: unknown) => void) => () => void;
  /** The server advertises the `population` feature and the console is up. */
  enabled: boolean;
}

/**
 * The population manager's state, polled every 5 s (the status line is a
 * plain print, unlike $netgameinfo). The setters send the matching console
 * command and ask for the status again right after.
 */
export function usePopulation({ sendCommand, onBotPopulation, enabled }: UsePopulationOptions) {
  const [population, setPopulation] = useState<BotPopulation | null>(null);

  const refresh = useCallback(() => {
    sendCommand("$botpopulation");
  }, [sendCommand]);

  useEffect(() => {
    const unsubscribe = onBotPopulation((data: unknown) => {
      const payload = data as BotPopulation;
      if (payload && typeof payload.target === "number") setPopulation(payload);
    });
    return unsubscribe;
  }, [onBotPopulation]);

  useEffect(() => {
    if (!enabled) {
      setPopulation(null);
      return;
    }
    refresh();
    const interval = setInterval(refresh, 5000);
    return () => clearInterval(interval);
  }, [enabled, refresh]);

  const mutate = useCallback(
    (args: string) => {
      sendCommand(`$botpopulation ${args}`);
      setTimeout(refresh, 300);
    },
    [sendCommand, refresh],
  );

  return {
    population,
    refresh,
    setManager: (on: boolean) => mutate(on ? "on" : "off"),
    setTarget: (n: number) => mutate(`target ${Math.max(0, Math.trunc(n))}`),
    setReserve: (n: number) => mutate(`reserve ${Math.max(1, Math.trunc(n))}`),
  };
}
