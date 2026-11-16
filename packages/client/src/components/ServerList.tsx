import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  isActiveState,
  launchRows,
  missionLine,
  refusalLines,
  rowStateLabel,
  runningCount,
  type ServerRow,
} from "@/lib/servers";
import type { ServerActionError } from "../hooks/useLauncher.ts";

/** The dot colour of a server's state (the Launch panel's palette). */
export function rowColor(row: ServerRow): string {
  if (row.held && !isActiveState(row.state)) return "bg-amber-400";
  if (row.playlist?.status === "restarting" || row.playlist?.status === "holding") return "bg-amber-400 animate-pulse";
  switch (row.state) {
    case "running":
      return "bg-emerald-500";
    case "starting":
    case "stopping":
      return "bg-primary animate-pulse";
    case "crashed":
      return "bg-destructive";
    default:
      return "bg-muted-foreground";
  }
}

/** The facts under a row's name: game type, mission and level, humans of max; the playlist; the ports. */
export function rowFacts(row: ServerRow): { line1: string; playlist: string | null; ports: string } {
  const humans =
    row.humans != null && row.maxPlayers != null
      ? `${row.humans}/${row.maxPlayers} humans`
      : row.maxPlayers != null
        ? `max ${row.maxPlayers}`
        : null;
  const line1 = [row.gameType, missionLine(row), humans].filter(Boolean).join(" · ");
  const ports = row.ports
    ? [
        row.ports.game != null ? `game ${row.ports.game}` : null,
        row.ports.console != null ? `console ${row.ports.console}` : null,
        row.ports.gameSpy != null && row.ports.gameSpy !== 20142 ? `GameSpy ${row.ports.gameSpy}` : null,
      ]
        .filter(Boolean)
        .join(", ")
    : "";
  const playlist = row.playlist ? `Playlist: ${row.playlist.name}` : null;
  return { line1, playlist, ports };
}

/**
 * Launch mode's way in: one row per server (each profile's, and the one
 * launched without a profile when used) with its live state, mission and
 * level, humans, game type, playlist and ports, and its own Start or Stop.
 * A click selects the server every tab then shows. Several can run at once.
 */
export function ServerList({
  servers,
  selectedId,
  onSelect,
  onStart,
  onStop,
  busy,
  actionError,
  canStart,
}: {
  servers: readonly ServerRow[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onStart: (id: string) => void;
  onStop: (id: string) => void;
  /** Servers with a start or stop in flight. */
  busy: ReadonlySet<string>;
  /** The last refused start or stop, under its row. */
  actionError: ServerActionError | null;
  /** Whether a row's server has what a launch needs (a game path and an executable). */
  canStart: (row: ServerRow) => boolean;
}) {
  const rows = launchRows(servers);
  const running = runningCount(servers);

  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-score tracking-wide text-muted-foreground">Servers</h3>
        <span className="text-[11px] text-muted-foreground">
          {running === 0 ? "none running" : `${running} running`}
        </span>
      </div>
      <ul className="space-y-1" aria-label="Servers">
        {rows.map((row) => {
          const selected = row.id === selectedId;
          const active = isActiveState(row.state);
          const inFlight = busy.has(row.id);
          const { line1, playlist, ports } = rowFacts(row);
          const refused = actionError?.serverId === row.id ? refusalLines(actionError.message) : null;
          return (
            <li key={row.id}>
              <div
                role="button"
                tabIndex={0}
                aria-pressed={selected}
                aria-label={`${row.name}: ${rowStateLabel(row)}`}
                onClick={() => onSelect(row.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onSelect(row.id);
                  }
                }}
                className={cn(
                  "rounded-md border px-2 py-1.5 cursor-pointer transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
                  selected ? "border-primary/70 bg-primary/10" : "border-border bg-muted/30 hover:bg-muted/60",
                )}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span className={cn("w-2 h-2 rounded-full shrink-0", rowColor(row))} aria-hidden="true" />
                  <span className={cn("flex-1 min-w-0 truncate text-sm", selected ? "text-foreground font-medium" : "text-foreground/80")}>
                    {row.name}
                  </span>
                  <span className="text-[10px] font-score tracking-wide text-muted-foreground capitalize shrink-0">
                    {rowStateLabel(row)}
                  </span>
                  {active ? (
                    <Button
                      variant="outline"
                      size="xs"
                      disabled={inFlight || row.state === "stopping"}
                      onClick={(e) => {
                        e.stopPropagation();
                        onStop(row.id);
                      }}
                      className="shrink-0 h-6 px-2 font-score tracking-wide text-destructive border-destructive/40 hover:bg-destructive/10 hover:text-destructive"
                      aria-label={`Stop ${row.name}`}
                    >
                      Stop
                    </Button>
                  ) : (
                    <Button
                      variant="outline"
                      size="xs"
                      disabled={inFlight || !canStart(row)}
                      onClick={(e) => {
                        e.stopPropagation();
                        onStart(row.id);
                      }}
                      className="shrink-0 h-6 px-2 font-score tracking-wide"
                      aria-label={`Start ${row.name}`}
                    >
                      {inFlight ? "…" : "Start"}
                    </Button>
                  )}
                </div>
                {line1 && <p className="pl-4 text-[10px] text-muted-foreground truncate">{line1}</p>}
                {playlist && <p className="pl-4 text-[10px] text-foreground/70 truncate">{playlist}</p>}
                {ports && <p className="pl-4 text-[10px] text-muted-foreground truncate">{ports}</p>}
                {row.held && !active && (
                  <p className="pl-4 text-[10px] text-amber-400 break-words">
                    Still running from before Pyrodeck restarted ({row.held.why}); its ports stay taken.
                  </p>
                )}
              </div>
              {refused && (
                <div className="mt-0.5 text-[11px] text-destructive bg-destructive/10 border border-destructive/40 rounded-md px-2 py-1 space-y-0.5 break-words">
                  {refused.map((line) => (
                    <p key={line}>{line}</p>
                  ))}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
