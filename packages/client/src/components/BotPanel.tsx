import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useBots, cleanBotName, SHIPS, DIFFICULTIES, BOT_NAME_MAX, type BotEntry, type BotStatus } from "@/hooks/useBots";

interface BotPanelProps {
  sendCommand: (command: string) => void;
  onBots: (callback: (data: unknown) => void) => () => void;
  onBotStats: (callback: (data: unknown) => void) => () => void;
  onBotMode: (callback: (data: unknown) => void) => () => void;
  hasShips: boolean;
  hasDifficulty: boolean;
  /** Server advertises `teams`: $addbot takes a 4th, 1-based team argument. */
  hasTeams: boolean;
}

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
  onBotMode,
  hasShips,
  hasDifficulty,
  hasTeams,
}: BotPanelProps) {
  const { bots, botStats, teamCount, showTeam, refresh, addBot: sendAddBot, removeBot, removeAll, setDifficulty } = useBots({
    sendCommand,
    onBots,
    onBotStats,
    onBotMode,
    hasShips,
    hasDifficulty,
    hasTeams,
  });
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [newName, setNewName] = useState("");
  const [newShip, setNewShip] = useState("pyro");
  const [newDifficulty, setNewDifficulty] = useState("hotshot");
  const [newTeam, setNewTeam] = useState("");
  const [confirmRemoveAll, setConfirmRemoveAll] = useState(false);

  const toggleExpand = (index: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const addBot = () => {
    if (sendAddBot({ name: newName, ship: newShip, difficulty: newDifficulty, team: newTeam })) setNewName("");
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
              onChange={(e) => setNewName(cleanBotName(e.target.value))}
              maxLength={BOT_NAME_MAX}
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
          {showTeam && (
            <div>
              <label className="block text-sm font-score tracking-wide text-muted-foreground mb-1">Team</label>
              <select
                value={newTeam}
                onChange={(e) => setNewTeam(e.target.value)}
                className="px-2 py-1.5 bg-input border border-border rounded-md text-sm text-foreground"
              >
                <option value="">auto</option>
                {Array.from({ length: Math.min(teamCount, 4) }, (_, i) => (
                  <option key={i + 1} value={String(i + 1)}>
                    {i + 1}
                  </option>
                ))}
              </select>
            </div>
          )}
          <Button onClick={addBot} disabled={!cleanBotName(newName)} className="font-score tracking-wide">
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
                    removeAll();
                    setConfirmRemoveAll(false);
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
                    onSetDifficulty={(d) => setDifficulty(bot.index, d)}
                    onRemove={() => removeBot(bot.index)}
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
  onSetDifficulty,
  onRemove,
}: {
  bot: BotEntry;
  stats: BotStatus | undefined;
  isExpanded: boolean;
  onToggle: () => void;
  hasDifficulty: boolean;
  onSetDifficulty: (difficulty: string) => void;
  onRemove: () => void;
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
              onChange={(e) => onSetDifficulty(e.target.value)}
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
            onClick={onRemove}
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
