import { useState, useEffect, useCallback } from "react";

interface PlayerScore {
  name: string;
  pnum: number; // D3 player slot number (1-based, 0 is server)
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

  // Auto-refresh
  useEffect(() => {
    if (!autoRefresh) return;
    refresh();
    const interval = setInterval(refresh, 5000);
    return () => clearInterval(interval);
  }, [autoRefresh, refresh]);

  // Receive structured player data from server-side parser
  useEffect(() => {
    const unsubscribe = onPlayers((data: unknown) => {
      const payload = data as { players: PlayerScore[] };
      if (payload.players) {
        // Add pnum (1-based slot order) since server parser doesn't include it
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
        <h2 className="text-sm font-medium text-zinc-300">
          Players ({players.filter((p) => !p.isObserver).length})
        </h2>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1 text-xs text-zinc-500">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
              className="rounded"
            />
            Auto
          </label>
          <button
            onClick={refresh}
            className="px-2 py-0.5 text-xs bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded"
          >
            Refresh
          </button>
        </div>
      </div>

      {players.length === 0 ? (
        <p className="text-sm text-zinc-600">No player data yet</p>
      ) : (
        <div className="overflow-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-zinc-500 border-b border-zinc-800">
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
                  className={`border-b border-zinc-800/50 ${
                    p.isObserver
                      ? "opacity-40"
                      : p.isBot
                        ? "text-zinc-400"
                        : "text-zinc-200"
                  }`}
                >
                  <td className="py-1.5">
                    <span className="flex items-center gap-1.5">
                      {p.name}
                      {p.isBot && (
                        <span className="text-[10px] px-1 py-0.5 bg-zinc-800 text-zinc-500 rounded">
                          BOT
                        </span>
                      )}
                      {p.isObserver && (
                        <span className="text-[10px] px-1 py-0.5 bg-zinc-800 text-zinc-500 rounded">
                          OBS
                        </span>
                      )}
                    </span>
                  </td>
                  <td className="py-1.5 text-right font-mono">{p.points}</td>
                  <td className="py-1.5 text-right font-mono">{p.kills}</td>
                  <td className="py-1.5 text-right font-mono">{p.deaths}</td>
                  <td className="py-1.5 text-right font-mono">{p.suicides}</td>
                  <td className="py-1.5 text-right font-mono text-zinc-500">
                    {p.ping === null ? "---" : p.ping}
                  </td>
                  <td className="py-1.5 text-right">
                    {!p.isObserver && (
                      <div className="flex gap-1 justify-end">
                        <button
                          onClick={() => sendCommand(`$kick ${p.pnum}`)}
                          className="px-1.5 py-0.5 text-[10px] bg-zinc-800 hover:bg-amber-600 text-zinc-400 hover:text-white rounded transition-colors"
                        >
                          Kick
                        </button>
                        <button
                          onClick={() => sendCommand(`$ban ${p.pnum}`)}
                          className="px-1.5 py-0.5 text-[10px] bg-zinc-800 hover:bg-red-600 text-zinc-400 hover:text-white rounded transition-colors"
                        >
                          Ban
                        </button>
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
