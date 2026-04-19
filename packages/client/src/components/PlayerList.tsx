import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

interface PlayerScore {
  name: string;
  pnum: number;
  points: number;
  kills: number;
  deaths: number;
  suicides: number;
  ping: number | null;
  isBot: boolean;
  isObserver: boolean;
}

interface PlayerListProps {
  sendCommand: (command: string) => void;
  onPlayers: (callback: (data: unknown) => void) => () => void;
}

export function PlayerList({ sendCommand, onPlayers }: PlayerListProps) {
  const [players, setPlayers] = useState<PlayerScore[]>([]);
  const [autoRefresh, setAutoRefresh] = useState(true);

  const refresh = useCallback(() => {
    sendCommand("$scores");
  }, [sendCommand]);

  useEffect(() => {
    if (!autoRefresh) return;
    refresh();
    const interval = setInterval(refresh, 5000);
    return () => clearInterval(interval);
  }, [autoRefresh, refresh]);

  useEffect(() => {
    const unsubscribe = onPlayers((data: unknown) => {
      const payload = data as { players: PlayerScore[] };
      if (payload.players) {
        const withPnum = payload.players.map((p, i) => ({
          ...p,
          pnum: i + 1,
        }));
        setPlayers(withPnum);
      }
    });
    return unsubscribe;
  }, [onPlayers]);

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-medium text-foreground">
          Players ({players.filter((p) => !p.isObserver).length})
        </h2>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
              className="rounded"
            />
            Auto
          </label>
          <Button variant="secondary" size="xs" onClick={refresh}>
            Refresh
          </Button>
        </div>
      </div>

      {players.length === 0 ? (
        <p className="text-sm text-muted-foreground">No player data yet</p>
      ) : (
        <div className="overflow-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground border-b border-border">
                <th className="pb-1 font-medium">Player</th>
                <th className="pb-1 font-medium text-right">Pts</th>
                <th className="pb-1 font-medium text-right">K</th>
                <th className="pb-1 font-medium text-right">D</th>
                <th className="pb-1 font-medium text-right">S</th>
                <th className="pb-1 font-medium text-right">Ping</th>
                <th className="pb-1 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {players.map((p, i) => (
                <tr
                  key={`${p.name}-${i}`}
                  className={`border-b border-border/50 ${
                    p.isObserver
                      ? "opacity-40"
                      : p.isBot
                        ? "text-muted-foreground"
                        : "text-foreground"
                  }`}
                >
                  <td className="py-1.5">
                    <span className="flex items-center gap-1.5">
                      {p.name}
                      {p.isBot && (
                        <Badge variant="secondary" className="text-[10px] py-0 px-1">
                          BOT
                        </Badge>
                      )}
                      {p.isObserver && (
                        <Badge variant="secondary" className="text-[10px] py-0 px-1">
                          OBS
                        </Badge>
                      )}
                    </span>
                  </td>
                  <td className="py-1.5 text-right font-mono">{p.points}</td>
                  <td className="py-1.5 text-right font-mono">{p.kills}</td>
                  <td className="py-1.5 text-right font-mono">{p.deaths}</td>
                  <td className="py-1.5 text-right font-mono">{p.suicides}</td>
                  <td className="py-1.5 text-right font-mono text-muted-foreground">
                    {p.ping === null ? "---" : p.ping}
                  </td>
                  <td className="py-1.5 text-right">
                    {!p.isObserver && (
                      <div className="flex gap-1 justify-end">
                        <Button
                          variant="secondary"
                          size="xs"
                          onClick={() => sendCommand(`$kick ${p.pnum}`)}
                          className="h-8 px-2 hover:bg-primary hover:text-primary-foreground"
                        >
                          Kick
                        </Button>
                        <Button
                          variant="secondary"
                          size="xs"
                          onClick={() => sendCommand(`$ban ${p.pnum}`)}
                          className="h-8 px-2 hover:bg-destructive hover:text-white"
                        >
                          Ban
                        </Button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
