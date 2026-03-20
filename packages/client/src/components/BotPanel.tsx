import { useState, useEffect, useCallback } from "react";

interface BotEntry {
  index: number;
  callsign: string;
  slot: number;
  ship: string;
  difficulty: string;
  alive: boolean;
}

interface BotPanelProps {
  sendCommand: (command: string) => void;
  onOutput: (callback: (data: string) => void) => () => void;
  hasShips: boolean;
  hasDifficulty: boolean;
}

const SHIPS = ["pyro", "phoenix", "magnum", "blackpyro"];
const DIFFICULTIES = ["trainee", "rookie", "hotshot", "ace", "insane"];

export function BotPanel({
  sendCommand,
  onOutput,
  hasShips,
  hasDifficulty,
}: BotPanelProps) {
  const [bots, setBots] = useState<BotEntry[]>([]);
  const [newName, setNewName] = useState("");
  const [newShip, setNewShip] = useState("pyro");
  const [newDifficulty, setNewDifficulty] = useState("hotshot");

  const refresh = useCallback(() => {
    sendCommand("$botlist");
  }, [sendCommand]);

  // Auto-refresh bot list
  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 5000);
    return () => clearInterval(interval);
  }, [refresh]);

  // Parse $botlist output
  useEffect(() => {
    let buffer = "";
    let collecting = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;

    const unsubscribe = onOutput((data: string) => {
      if (data.includes("No bots active")) {
        setBots([]);
        return;
      }

      if (data.includes("Bot ") && data.includes("slot=")) {
        collecting = true;
        buffer = data;
      } else if (collecting) {
        buffer += data;
      }

      if (collecting) {
        if (timeout) clearTimeout(timeout);
        timeout = setTimeout(() => {
          const parsed: BotEntry[] = [];
          for (const line of buffer.split("\n")) {
            const match = line
              .trim()
              .match(
                /Bot (\d+): '(.+?)' slot=(\d+) ship=(\S+) diff=(\S+) \((alive|dead)\)/,
              );
            if (match) {
              parsed.push({
                index: parseInt(match[1], 10),
                callsign: match[2],
                slot: parseInt(match[3], 10),
                ship: match[4],
                difficulty: match[5],
                alive: match[6] === "alive",
              });
            }
          }
          if (parsed.length > 0) setBots(parsed);
          collecting = false;
          buffer = "";
        }, 300);
      }
    });

    return unsubscribe;
  }, [onOutput]);

  const addBot = () => {
    if (!newName.trim()) return;
    let cmd = `$addbot ${newName.trim()}`;
    if (hasShips) cmd += ` ${newShip}`;
    if (hasDifficulty) cmd += ` ${newDifficulty}`;
    sendCommand(cmd);
    setNewName("");
    setTimeout(refresh, 500);
  };

  return (
    <div className="h-full flex flex-col">
      {/* Add Bot Form */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-3 mb-3">
        <h3 className="text-xs text-zinc-500 font-medium mb-2">Add Bot</h3>
        <div className="flex gap-2 items-end">
          <div className="flex-1">
            <label className="block text-xs text-zinc-500 mb-1">Name</label>
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Bot name"
              className="w-full px-2 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-sm text-zinc-100 focus:outline-none focus:ring-1 focus:ring-amber-500"
              onKeyDown={(e) => e.key === "Enter" && addBot()}
            />
          </div>
          {hasShips && (
            <div>
              <label className="block text-xs text-zinc-500 mb-1">Ship</label>
              <select
                value={newShip}
                onChange={(e) => setNewShip(e.target.value)}
                className="px-2 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-sm text-zinc-100"
              >
                {SHIPS.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
          )}
          {hasDifficulty && (
            <div>
              <label className="block text-xs text-zinc-500 mb-1">
                Difficulty
              </label>
              <select
                value={newDifficulty}
                onChange={(e) => setNewDifficulty(e.target.value)}
                className="px-2 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-sm text-zinc-100"
              >
                {DIFFICULTIES.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            </div>
          )}
          <button
            onClick={addBot}
            disabled={!newName.trim()}
            className="px-3 py-1.5 bg-amber-600 hover:bg-amber-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white text-sm font-medium rounded transition-colors"
          >
            Add
          </button>
        </div>
      </div>

      {/* Bot List */}
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-medium text-zinc-300">
          Active Bots ({bots.length})
        </h3>
        <div className="flex gap-2">
          <button
            onClick={refresh}
            className="px-2 py-0.5 text-xs bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded"
          >
            Refresh
          </button>
          {bots.length > 0 && (
            <button
              onClick={() => {
                sendCommand("$removebots");
                setTimeout(refresh, 500);
              }}
              className="px-2 py-0.5 text-xs bg-red-900/50 hover:bg-red-700 text-red-300 rounded"
            >
              Remove All
            </button>
          )}
        </div>
      </div>

      {bots.length === 0 ? (
        <p className="text-sm text-zinc-600">No bots active</p>
      ) : (
        <div className="overflow-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-zinc-500 border-b border-zinc-800">
                <th className="pb-1 font-medium">#</th>
                <th className="pb-1 font-medium">Name</th>
                <th className="pb-1 font-medium">Ship</th>
                <th className="pb-1 font-medium">Difficulty</th>
                <th className="pb-1 font-medium">Status</th>
                <th className="pb-1 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {bots.map((bot) => (
                <tr
                  key={bot.index}
                  className="border-b border-zinc-800/50 text-zinc-300"
                >
                  <td className="py-1.5 text-zinc-500">{bot.index}</td>
                  <td className="py-1.5">{bot.callsign}</td>
                  <td className="py-1.5 text-zinc-400">{bot.ship}</td>
                  <td className="py-1.5">
                    {hasDifficulty ? (
                      <select
                        value={bot.difficulty.toLowerCase()}
                        onChange={(e) =>
                          sendCommand(
                            `$botdifficulty ${bot.index} ${e.target.value}`,
                          )
                        }
                        className="px-1 py-0.5 bg-zinc-800 border border-zinc-700 rounded text-xs text-zinc-300"
                      >
                        {DIFFICULTIES.map((d) => (
                          <option key={d} value={d}>
                            {d}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span className="text-zinc-400">{bot.difficulty}</span>
                    )}
                  </td>
                  <td className="py-1.5">
                    <span
                      className={`text-xs px-1.5 py-0.5 rounded ${
                        bot.alive
                          ? "bg-emerald-900/50 text-emerald-400"
                          : "bg-red-900/50 text-red-400"
                      }`}
                    >
                      {bot.alive ? "Alive" : "Dead"}
                    </span>
                  </td>
                  <td className="py-1.5 text-right">
                    <button
                      onClick={() => {
                        sendCommand(`$removebot ${bot.index}`);
                        setTimeout(refresh, 500);
                      }}
                      className="px-1.5 py-0.5 text-[10px] bg-zinc-800 hover:bg-red-600 text-zinc-400 hover:text-white rounded transition-colors"
                    >
                      Remove
                    </button>
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
