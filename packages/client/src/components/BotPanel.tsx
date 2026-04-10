import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

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
  onBots: (callback: (data: unknown) => void) => () => void;
  hasShips: boolean;
  hasDifficulty: boolean;
}

const SHIPS = ["pyro", "phoenix", "magnum", "blackpyro"];
const DIFFICULTIES = ["trainee", "rookie", "hotshot", "ace", "insane"];

export function BotPanel({
  sendCommand,
  onBots,
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

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 5000);
    return () => clearInterval(interval);
  }, [refresh]);

  useEffect(() => {
    const unsubscribe = onBots((data: unknown) => {
      const payload = data as { bots: BotEntry[] };
      if (payload.bots) {
        setBots(payload.bots);
      }
    });
    return unsubscribe;
  }, [onBots]);

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
      <div className="bg-card border border-border rounded-lg p-3 mb-3">
        <h3 className="text-xs text-muted-foreground font-medium mb-2">Add Bot</h3>
        <div className="flex gap-2 items-end">
          <div className="flex-1">
            <label className="block text-xs text-muted-foreground mb-1">Name</label>
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Bot name"
              className="w-full px-2 py-1.5 bg-input border border-border rounded-md text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              onKeyDown={(e) => e.key === "Enter" && addBot()}
            />
          </div>
          {hasShips && (
            <div>
              <label className="block text-xs text-muted-foreground mb-1">Ship</label>
              <select
                value={newShip}
                onChange={(e) => setNewShip(e.target.value)}
                className="px-2 py-1.5 bg-input border border-border rounded-md text-sm text-foreground"
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
              <label className="block text-xs text-muted-foreground mb-1">
                Difficulty
              </label>
              <select
                value={newDifficulty}
                onChange={(e) => setNewDifficulty(e.target.value)}
                className="px-2 py-1.5 bg-input border border-border rounded-md text-sm text-foreground"
              >
                {DIFFICULTIES.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            </div>
          )}
          <Button onClick={addBot} disabled={!newName.trim()}>
            Add
          </Button>
        </div>
      </div>

      {/* Bot List */}
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-medium text-foreground">
          Active Bots ({bots.length})
        </h3>
        <div className="flex gap-2">
          <Button variant="secondary" size="xs" onClick={refresh}>
            Refresh
          </Button>
          {bots.length > 0 && (
            <Button
              variant="destructive"
              size="xs"
              onClick={() => {
                sendCommand("$removebots");
                setTimeout(refresh, 500);
              }}
            >
              Remove All
            </Button>
          )}
        </div>
      </div>

      {bots.length === 0 ? (
        <p className="text-sm text-muted-foreground">No bots active</p>
      ) : (
        <div className="overflow-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground border-b border-border">
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
                  className="border-b border-border/50 text-foreground/80"
                >
                  <td className="py-1.5 text-muted-foreground">{bot.index}</td>
                  <td className="py-1.5">{bot.callsign}</td>
                  <td className="py-1.5 text-muted-foreground">{bot.ship}</td>
                  <td className="py-1.5">
                    {hasDifficulty ? (
                      <select
                        value={bot.difficulty.toLowerCase()}
                        onChange={(e) =>
                          sendCommand(
                            `$botdifficulty ${bot.index} ${e.target.value}`,
                          )
                        }
                        className="px-1 py-0.5 bg-input border border-border rounded-md text-xs text-foreground"
                      >
                        {DIFFICULTIES.map((d) => (
                          <option key={d} value={d}>
                            {d}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span className="text-muted-foreground">{bot.difficulty}</span>
                    )}
                  </td>
                  <td className="py-1.5">
                    <Badge variant={bot.alive ? "outline" : "destructive"} className="text-[10px]">
                      {bot.alive ? "Alive" : "Dead"}
                    </Badge>
                  </td>
                  <td className="py-1.5 text-right">
                    <Button
                      variant="secondary"
                      size="xs"
                      onClick={() => {
                        sendCommand(`$removebot ${bot.index}`);
                        setTimeout(refresh, 500);
                      }}
                      className="text-[10px] h-5 px-1.5 hover:bg-destructive hover:text-white"
                    >
                      Remove
                    </Button>
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
