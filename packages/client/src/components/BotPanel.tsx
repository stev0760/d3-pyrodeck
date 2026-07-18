import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ChevronDown, ChevronRight } from "lucide-react";

interface BotEntry {
  index: number;
  callsign: string;
  slot: number;
  ship: string;
  difficulty: string;
  alive: boolean;
}

interface BotStatus {
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

interface BotPanelProps {
  sendCommand: (command: string) => void;
  onBots: (callback: (data: unknown) => void) => () => void;
  onBotStats: (callback: (data: unknown) => void) => () => void;
  hasShips: boolean;
  hasDifficulty: boolean;
}

const SHIPS = ["pyro", "phoenix", "magnum", "blackpyro"];
const DIFFICULTIES = ["trainee", "rookie", "hotshot", "ace", "insane"];

function shieldsColor(shields: number): string {
  if (shields >= 80) return "text-green-400";
  if (shields >= 40) return "text-yellow-400";
  if (shields > 0) return "text-orange-400";
  return "text-red-400";
}

export function BotPanel({
  sendCommand,
  onBots,
  onBotStats,
  hasShips,
  hasDifficulty,
}: BotPanelProps) {
  const [bots, setBots] = useState<BotEntry[]>([]);
  const [botStats, setBotStats] = useState<Map<number, BotStatus>>(new Map());
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [newName, setNewName] = useState("");
  const [newShip, setNewShip] = useState("pyro");
  const [newDifficulty, setNewDifficulty] = useState("hotshot");
  const [confirmRemoveAll, setConfirmRemoveAll] = useState(false);

  const refresh = useCallback(() => {
    sendCommand("$botlist");
  }, [sendCommand]);

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

  const toggleExpand = (index: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

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
        <h3 className="text-sm font-score tracking-wide text-muted-foreground mb-2">Add Bot</h3>
        <div className="flex gap-2 items-end">
          <div className="flex-1">
            <label className="block text-sm font-score tracking-wide text-muted-foreground mb-1">Name</label>
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
              <label className="block text-sm font-score tracking-wide text-muted-foreground mb-1">Ship</label>
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
              <label className="block text-sm font-score tracking-wide text-muted-foreground mb-1">
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
          <Button onClick={addBot} disabled={!newName.trim()} className="font-score tracking-wide">
            Add
          </Button>
        </div>
      </div>

      {/* Bot List */}
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-score tracking-wide text-foreground">
          Active Bots ({bots.length})
        </h3>
        <div className="flex gap-2">
          <Button variant="secondary" size="xs" onClick={refresh} className="font-score tracking-wide">
            Refresh
          </Button>
          {bots.length > 0 && (
            confirmRemoveAll ? (
              <div className="flex items-center gap-2">
                <span className="text-xs text-destructive">Remove all bots?</span>
                <Button
                  variant="destructive"
                  size="xs"
                  onClick={() => {
                    sendCommand("$removebots");
                    setConfirmRemoveAll(false);
                    setTimeout(refresh, 500);
                  }}
                  className="font-score tracking-wide"
                >
                  Remove All
                </Button>
                <Button
                  variant="secondary"
                  size="xs"
                  onClick={() => setConfirmRemoveAll(false)}
                  className="font-score tracking-wide"
                >
                  Cancel
                </Button>
              </div>
            ) : (
              <Button
                variant="destructive"
                size="xs"
                onClick={() => setConfirmRemoveAll(true)}
                className="font-score tracking-wide"
              >
                Remove All
              </Button>
            )
          )}
        </div>
      </div>

      {bots.length === 0 ? (
        <p className="text-sm font-score tracking-wide text-muted-foreground">No bots active</p>
      ) : (
        <div className="overflow-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs font-score tracking-wide text-muted-foreground border-b border-border">
                <th className="pb-1 w-6"></th>
                <th className="pb-1">#</th>
                <th className="pb-1">Name</th>
                <th className="pb-1">State</th>
                <th className="pb-1">Shields</th>
                <th className="pb-1">Target</th>
                <th className="pb-1">Ship</th>
                <th className="pb-1">Difficulty</th>
                <th className="pb-1 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {bots.map((bot) => {
                const stats = botStats.get(bot.index);
                const isExpanded = expanded.has(bot.index);
                return (
                  <BotRow
                    key={bot.index}
                    bot={bot}
                    stats={stats}
                    isExpanded={isExpanded}
                    onToggle={() => toggleExpand(bot.index)}
                    hasDifficulty={hasDifficulty}
                    sendCommand={sendCommand}
                    refresh={refresh}
                  />
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function BotRow({
  bot,
  stats,
  isExpanded,
  onToggle,
  hasDifficulty,
  sendCommand,
  refresh,
}: {
  bot: BotEntry;
  stats: BotStatus | undefined;
  isExpanded: boolean;
  onToggle: () => void;
  hasDifficulty: boolean;
  sendCommand: (cmd: string) => void;
  refresh: () => void;
}) {
  return (
    <>
      <tr
        className="border-b border-border/50 text-foreground/80 cursor-pointer hover:bg-muted/30"
        onClick={onToggle}
      >
        <td className="py-1.5 text-muted-foreground">
          {stats ? (
            isExpanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />
          ) : null}
        </td>
        <td className="py-1.5 text-muted-foreground">{bot.index}</td>
        <td className="py-1.5">{bot.callsign}</td>
        <td className="py-1.5">
          {stats ? (
            <Badge
              variant={bot.alive ? "outline" : "destructive"}
              className="text-[10px] capitalize"
            >
              {stats.state}
            </Badge>
          ) : (
            <Badge variant={bot.alive ? "outline" : "destructive"} className="text-[10px]">
              {bot.alive ? "Alive" : "Dead"}
            </Badge>
          )}
        </td>
        <td className="py-1.5">
          {stats ? (
            <span className={`font-mono text-xs ${shieldsColor(stats.shields)}`}>
              {Math.round(stats.shields)}
            </span>
          ) : (
            <span className="text-muted-foreground">&mdash;</span>
          )}
        </td>
        <td className="py-1.5 text-xs">
          {stats ? (
            <span className={stats.target ? "text-foreground/70" : "text-muted-foreground"}>
              {stats.target ?? "none"}
            </span>
          ) : (
            <span className="text-muted-foreground">&mdash;</span>
          )}
        </td>
        <td className="py-1.5 text-muted-foreground">{bot.ship}</td>
        <td className="py-1.5" onClick={(e) => e.stopPropagation()}>
          {hasDifficulty ? (
            <select
              value={bot.difficulty.toLowerCase()}
              onChange={(e) =>
                sendCommand(`$botdifficulty ${bot.index} ${e.target.value}`)
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
        <td className="py-1.5 text-right" onClick={(e) => e.stopPropagation()}>
          <Button
            variant="secondary"
            size="xs"
            onClick={() => {
              sendCommand(`$removebot ${bot.index}`);
              setTimeout(refresh, 500);
            }}
            className="h-8 px-2 font-score tracking-wide hover:bg-destructive hover:text-white"
          >
            Remove
          </Button>
        </td>
      </tr>
      {isExpanded && stats && (
        <tr className="border-b border-border/30 bg-muted/20">
          <td></td>
          <td colSpan={8} className="py-2 px-2">
            <div className="flex gap-6 text-xs font-score tracking-wide">
              <div>
                <span className="text-muted-foreground">Role: </span>
                <span className="text-foreground capitalize">{stats.role}</span>
              </div>
              <div>
                <span className="text-muted-foreground">Lean: </span>
                <span className="text-foreground capitalize">{stats.lean}</span>
              </div>
              <div>
                <span className="text-muted-foreground">Speed: </span>
                <span className="text-foreground font-mono">{stats.speed.toFixed(1)}</span>
              </div>
              <div>
                <span className="text-muted-foreground">Slot: </span>
                <span className="text-foreground">{stats.slot}</span>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
