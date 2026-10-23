import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { BottomSheet } from "./BottomSheet.tsx";
import { ListRow } from "./ListRow.tsx";
import { BigButton } from "./BigButton.tsx";
import type { PlayerScore, BanOptions } from "@/hooks/usePlayers";
import { cn } from "@/lib/utils";

interface PlayerCardsProps {
  players: PlayerScore[];
  addressOf: (name: string) => string | undefined;
  onKick: (name: string, reason: string) => Promise<{ message: string }>;
  onBan: (name: string, options: BanOptions) => Promise<{ message: string }>;
  notify: (message: string, type?: "error" | "info") => void;
  /** Called after a kick or ban went through, to refresh the list. */
  onChanged?: () => void;
}

type Action = { kind: "kick" | "ban"; player: PlayerScore };

/**
 * The scoreboard as tappable rows: one per player with the score the game
 * prints, a tap opening that player's actions in a sheet. Kick and ban ask
 * for the reason the way the desktop table does, with full-size controls.
 */
export function PlayerCards({ players, addressOf, onKick, onBan, notify, onChanged }: PlayerCardsProps) {
  const [selected, setSelected] = useState<PlayerScore | null>(null);
  const [action, setAction] = useState<Action | null>(null);
  const [reason, setReason] = useState("");
  const [hostsDeny, setHostsDeny] = useState(true);
  const [nameBan, setNameBan] = useState(false);
  const [busy, setBusy] = useState(false);

  const close = () => {
    setSelected(null);
    setAction(null);
    setReason("");
    setHostsDeny(true);
    setNameBan(false);
  };

  const confirm = async () => {
    if (!action) return;
    setBusy(true);
    try {
      const result =
        action.kind === "kick"
          ? await onKick(action.player.name, reason)
          : await onBan(action.player.name, { reason, hostsDeny, nameBan });
      notify(result.message, "info");
      close();
      onChanged?.();
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (players.length === 0) {
    return <p className="px-4 py-6 text-center text-sm text-muted-foreground">No player data yet.</p>;
  }

  const current = action?.player ?? selected;

  return (
    <div className="@container">
      <div className="divide-y divide-border/60">
        {players.map((p, i) => {
          const address = p.isBot ? undefined : addressOf(p.name);
          return (
            <button
              key={`${p.name}-${i}`}
              type="button"
              disabled={p.isObserver}
              onClick={() => setSelected(p)}
              className={cn(
                "w-full min-h-14 flex items-center gap-3 px-4 py-2 text-left active:bg-muted/60",
                p.isObserver && "opacity-40",
              )}
            >
              <span className="flex-1 min-w-0">
                <span className="flex items-center gap-1.5 min-w-0">
                  <span className={cn("text-base truncate", p.isBot ? "text-muted-foreground" : "text-foreground")}>{p.name}</span>
                  {p.isBot && (
                    <Badge variant="secondary" className="text-[10px] py-0 px-1 shrink-0">
                      BOT
                    </Badge>
                  )}
                  {p.isObserver && (
                    <Badge variant="secondary" className="text-[10px] py-0 px-1 shrink-0">
                      OBS
                    </Badge>
                  )}
                </span>
                <span className="block text-xs text-muted-foreground font-mono truncate">
                  {address ?? (p.isBot ? "bot" : "address unknown")}
                  {p.ping !== null && ` · ${p.ping} ms`}
                </span>
              </span>
              <span className="shrink-0 flex items-baseline gap-2 font-mono tabular-nums">
                <span className="text-lg text-foreground">{p.points}</span>
                <span className="text-xs text-muted-foreground">
                  {p.kills}/{p.deaths}/{p.suicides}
                </span>
              </span>
            </button>
          );
        })}
      </div>
      <p className="px-4 pt-2 text-[11px] text-muted-foreground">Points · kills/deaths/suicides. Tap a player for actions.</p>

      <BottomSheet
        open={current !== null}
        onOpenChange={(open) => !open && close()}
        title={current?.name ?? ""}
        description={
          current
            ? `${current.points} points · ${current.kills} kills, ${current.deaths} deaths, ${current.suicides} suicides${current.ping !== null ? ` · ${current.ping} ms` : ""}`
            : undefined
        }
      >
        {current && !action && (
          <div className="-mx-4">
            {!current.isBot && addressOf(current.name) && (
              <p className="px-4 pb-2 text-sm font-mono text-muted-foreground">{addressOf(current.name)}</p>
            )}
            <ListRow title={`Kick ${current.name}`} subtitle="Removed from the game; can rejoin" chevron onClick={() => setAction({ kind: "kick", player: current })} />
            {!current.isBot && (
              <ListRow
                title={`Ban ${current.name}`}
                subtitle="Kicked and kept out"
                chevron
                destructive
                onClick={() => setAction({ kind: "ban", player: current })}
              />
            )}
          </div>
        )}
        {current && action && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void confirm();
            }}
            className="flex flex-col gap-3"
          >
            <label className="flex flex-col gap-1">
              <span className="text-sm text-muted-foreground">Reason, said in chat first</span>
              <input
                autoFocus
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                maxLength={100}
                placeholder="Reason"
                className="h-11 px-3 rounded-xl bg-input border border-border text-base text-foreground focus:outline-none focus:ring-2 focus:ring-ring/60"
              />
            </label>
            {action.kind === "ban" && (
              <>
                <label className="flex items-center justify-between gap-3 min-h-11">
                  <span className="text-base">Address into hosts.deny</span>
                  <Switch checked={hostsDeny} onCheckedChange={setHostsDeny} />
                </label>
                <label className="flex items-center justify-between gap-3 min-h-11">
                  <span className="text-base">Ban the name too</span>
                  <Switch checked={nameBan} onCheckedChange={setNameBan} />
                </label>
              </>
            )}
            <BigButton type="submit" variant="destructive" disabled={busy}>
              {busy ? "…" : action.kind === "kick" ? `Kick ${current.name}` : `Ban ${current.name}`}
            </BigButton>
            <BigButton type="button" variant="secondary" onClick={() => setAction(null)} disabled={busy}>
              Back
            </BigButton>
          </form>
        )}
      </BottomSheet>
    </div>
  );
}
