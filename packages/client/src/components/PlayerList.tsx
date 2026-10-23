import { Fragment, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { usePlayers } from "@/hooks/usePlayers";

interface PlayerListProps {
  sendCommand: (command: string) => void;
  onPlayers: (callback: (data: unknown) => void) => () => void;
  notify: (message: string, type?: "error" | "info") => void;
}

/** The kick or ban being confirmed for one row. */
interface PendingAction {
  name: string;
  kind: "kick" | "ban";
  reason: string;
  hostsDeny: boolean;
  nameBan: boolean;
}

export function PlayerList({ sendCommand, onPlayers, notify }: PlayerListProps) {
  const { players, addressOf, refresh, autoRefresh, setAutoRefresh, kick, ban } = usePlayers({ sendCommand, onPlayers });
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [busy, setBusy] = useState(false);

  // $kick/$ban take a slot; the server looks it up by name with $players
  // ($scores is sorted by score, so its row order is not the slot).
  const confirm = async () => {
    if (!pending) return;
    setBusy(true);
    try {
      const result =
        pending.kind === "kick"
          ? await kick(pending.name, pending.reason)
          : await ban(pending.name, { reason: pending.reason, hostsDeny: pending.hostsDeny, nameBan: pending.nameBan });
      notify(result.message, "info");
      setPending(null);
      refresh();
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-score tracking-wide text-foreground">
          Players ({players.filter((p) => !p.isObserver).length})
        </h2>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1 text-sm font-score tracking-wide text-muted-foreground">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
              className="rounded"
            />
            Auto
          </label>
          <Button variant="secondary" size="xs" onClick={refresh} className="font-score tracking-wide">
            Refresh
          </Button>
        </div>
      </div>

      {players.length === 0 ? (
        <p className="text-sm font-score tracking-wide text-muted-foreground">No player data yet</p>
      ) : (
        <div className="overflow-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs font-score tracking-wide text-muted-foreground border-b border-border">
                <th className="pb-1">Player</th>
                <th className="pb-1 text-right">Pts</th>
                <th className="pb-1 text-right">K</th>
                <th className="pb-1 text-right">D</th>
                <th className="pb-1 text-right">S</th>
                <th className="pb-1 text-right">Ping</th>
                <th className="pb-1 text-right hidden sm:table-cell">Address</th>
                <th className="pb-1 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {players.map((p, i) => (
                <Fragment key={`${p.name}-${i}`}>
                <tr
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
                  <td className="py-1.5 text-right font-mono text-xs text-muted-foreground hidden sm:table-cell">
                    {p.isBot ? "" : (addressOf(p.name) ?? "—")}
                  </td>
                  <td className="py-1.5 text-right">
                    {!p.isObserver && (
                      <div className="flex gap-1 justify-end">
                        <Button
                          variant="secondary"
                          size="xs"
                          onClick={() =>
                            setPending({ name: p.name, kind: "kick", reason: "", hostsDeny: true, nameBan: false })
                          }
                          className="h-8 px-2 font-score tracking-wide hover:bg-primary hover:text-primary-foreground"
                        >
                          Kick
                        </Button>
                        {!p.isBot && (
                          <Button
                            variant="secondary"
                            size="xs"
                            onClick={() =>
                              setPending({ name: p.name, kind: "ban", reason: "", hostsDeny: true, nameBan: false })
                            }
                            className="h-8 px-2 font-score tracking-wide hover:bg-destructive hover:text-white"
                          >
                            Ban
                          </Button>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
                {pending?.name === p.name && (
                  <tr className="border-b border-border/50 bg-muted/30">
                    <td colSpan={8} className="py-2 px-1">
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <span className="font-score tracking-wide">
                          {pending.kind === "kick" ? "Kick" : "Ban"} {p.name}
                        </span>
                        <input
                          autoFocus
                          value={pending.reason}
                          onChange={(e) => setPending({ ...pending, reason: e.target.value })}
                          onKeyDown={(e) => e.key === "Enter" && void confirm()}
                          placeholder="Reason, said in chat first"
                          maxLength={100}
                          className="flex-1 min-w-40 bg-input border border-border rounded-md px-2 py-1 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                        />
                        {pending.kind === "ban" && (
                          <>
                            <label className="flex items-center gap-1">
                              <input
                                type="checkbox"
                                checked={pending.hostsDeny}
                                onChange={(e) => setPending({ ...pending, hostsDeny: e.target.checked })}
                              />
                              Address into hosts.deny
                            </label>
                            <label className="flex items-center gap-1">
                              <input
                                type="checkbox"
                                checked={pending.nameBan}
                                onChange={(e) => setPending({ ...pending, nameBan: e.target.checked })}
                              />
                              Ban the name
                            </label>
                          </>
                        )}
                        <Button size="xs" onClick={() => void confirm()} disabled={busy} className="font-score tracking-wide">
                          {busy ? "..." : pending.kind === "kick" ? "Kick" : "Ban"}
                        </Button>
                        <Button variant="ghost" size="xs" onClick={() => setPending(null)} disabled={busy}>
                          Cancel
                        </Button>
                      </div>
                    </td>
                  </tr>
                )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
