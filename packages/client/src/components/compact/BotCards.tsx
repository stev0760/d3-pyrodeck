import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { BottomSheet } from "./BottomSheet.tsx";
import { BigButton } from "./BigButton.tsx";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { SegmentedControl } from "./SegmentedControl.tsx";
import { DIFFICULTIES, type BotEntry, type BotStatus } from "@/hooks/useBots";
import { cn } from "@/lib/utils";

interface BotCardsProps {
  bots: BotEntry[];
  stats: Map<number, BotStatus>;
  hasDifficulty: boolean;
  onSetDifficulty: (index: number, difficulty: string) => void;
  onRemove: (index: number) => void;
}

function shieldsColor(shields: number): string {
  if (shields >= 80) return "text-green-400";
  if (shields >= 40) return "text-yellow-400";
  if (shields > 0) return "text-orange-400";
  return "text-red-400";
}

function shieldsBar(shields: number): string {
  if (shields >= 80) return "bg-green-400";
  if (shields >= 40) return "bg-yellow-400";
  if (shields > 0) return "bg-orange-400";
  return "bg-red-400";
}

const DIFFICULTY_OPTIONS = DIFFICULTIES.map((d) => ({ value: d, label: d.charAt(0).toUpperCase() + d.slice(1) }));

/** The live bots as rows; a tap opens one bot's state and its actions. */
export function BotCards({ bots, stats, hasDifficulty, onSetDifficulty, onRemove }: BotCardsProps) {
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const selected = selectedIndex === null ? null : (bots.find((b) => b.index === selectedIndex) ?? null);
  const selectedStats = selected ? stats.get(selected.index) : undefined;

  if (bots.length === 0) {
    return <p className="px-4 py-6 text-center text-sm text-muted-foreground">No bots in the game.</p>;
  }

  return (
    <div className="@container">
      <div className="divide-y divide-border/60">
        {bots.map((bot) => {
          const s = stats.get(bot.index);
          const state = s ? s.state : bot.alive ? "alive" : "dead";
          return (
            <button
              key={bot.index}
              type="button"
              onClick={() => setSelectedIndex(bot.index)}
              className="w-full min-h-14 flex items-center gap-3 px-4 py-2 text-left active:bg-muted/60"
            >
              <span className="flex-1 min-w-0">
                <span className="flex items-center gap-2 min-w-0">
                  <span className="text-base text-foreground truncate">{bot.callsign}</span>
                  <Badge variant={bot.alive ? "outline" : "destructive"} className="text-[10px] capitalize shrink-0">
                    {state}
                  </Badge>
                </span>
                <span className="block text-xs text-muted-foreground truncate">
                  {bot.ship} · {bot.difficulty.toLowerCase()}
                  {s?.target ? ` · on ${s.target}` : ""}
                </span>
              </span>
              <span className="shrink-0 w-16 flex flex-col items-end gap-1">
                <span className={cn("font-mono text-sm tabular-nums", s ? shieldsColor(s.shields) : "text-muted-foreground")}>
                  {s ? Math.round(s.shields) : "—"}
                </span>
                <span className="h-1 w-full rounded-full bg-muted overflow-hidden">
                  {s && (
                    <span
                      className={cn("block h-full rounded-full", shieldsBar(s.shields))}
                      style={{ width: `${Math.max(0, Math.min(100, s.shields))}%` }}
                    />
                  )}
                </span>
              </span>
            </button>
          );
        })}
      </div>
      <p className="px-4 pt-2 text-[11px] text-muted-foreground">Shields on the right. Tap a bot for its state and actions.</p>

      <BottomSheet
        open={selected !== null}
        onOpenChange={(open) => !open && setSelectedIndex(null)}
        title={selected?.callsign ?? ""}
        description={selected ? `Bot ${selected.index} in slot ${selected.slot} · ${selected.ship}` : undefined}
      >
        {selected && (
          <div className="flex flex-col gap-4">
            {selectedStats && (
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                <dt className="text-muted-foreground">State</dt>
                <dd className="capitalize">{selectedStats.state}</dd>
                <dt className="text-muted-foreground">Shields</dt>
                <dd className={cn("font-mono", shieldsColor(selectedStats.shields))}>{Math.round(selectedStats.shields)}</dd>
                <dt className="text-muted-foreground">Target</dt>
                <dd>{selectedStats.target ?? "none"}</dd>
                <dt className="text-muted-foreground">Role</dt>
                <dd className="capitalize">{selectedStats.role}</dd>
                <dt className="text-muted-foreground">Lean</dt>
                <dd className="capitalize">{selectedStats.lean}</dd>
                <dt className="text-muted-foreground">Speed</dt>
                <dd className="font-mono">{selectedStats.speed.toFixed(1)}</dd>
              </dl>
            )}
            {hasDifficulty && (
              <div>
                <p className="text-sm text-muted-foreground mb-1">Difficulty</p>
                <SegmentedControl
                  value={selected.difficulty.toLowerCase()}
                  options={DIFFICULTY_OPTIONS}
                  onChange={(d) => onSetDifficulty(selected.index, d)}
                  aria-label="Difficulty"
                />
              </div>
            )}
            <BigButton variant="destructive" onClick={() => setConfirmRemove(true)}>
              Remove {selected.callsign}
            </BigButton>
          </div>
        )}
      </BottomSheet>

      <ConfirmDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        title={`Remove ${selected?.callsign ?? "this bot"}?`}
        description="The bot leaves the game. With the population manager on, another may take its place."
        confirmLabel="Remove"
        destructive
        onConfirm={() => {
          if (selected) onRemove(selected.index);
          setConfirmRemove(false);
          setSelectedIndex(null);
        }}
      />
    </div>
  );
}
