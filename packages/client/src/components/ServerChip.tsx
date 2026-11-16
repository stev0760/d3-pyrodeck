import { useSession } from "@/session/SessionProvider";
import { cn } from "@/lib/utils";
import { rowStateLabel } from "@/lib/servers";
import { rowColor } from "./ServerList.tsx";

/**
 * The server every tab is about, named in the header so a command never
 * goes to the wrong one: its state dot, its name and its state. In Connect
 * mode, the remote console. `onClick` makes it the way to another server.
 */
export function ServerChip({ className, onClick }: { className?: string; onClick?: () => void }) {
  const { mode, server, serverName, isConnected, processState } = useSession();
  let name: string;
  let label: string;
  let dot: string;
  if (mode === "connect") {
    name = isConnected && serverName ? serverName : "Not connected";
    label = isConnected ? "connected" : "";
    dot = isConnected ? "bg-emerald-500" : "bg-muted-foreground";
  } else if (server) {
    name = server.name;
    // The launcher status is fresher than the list for the selected server.
    const row = processState && processState !== server.state ? { ...server, state: processState } : server;
    label = rowStateLabel(row);
    dot = rowColor(row);
  } else {
    name = "No server";
    label = "";
    dot = "bg-muted-foreground";
  }
  const body = (
    <>
      <span className={cn("w-2 h-2 rounded-full shrink-0", dot)} aria-hidden="true" />
      <span className="truncate text-foreground font-medium">{name}</span>
      {label && <span className="shrink-0 text-muted-foreground capitalize">{label}</span>}
    </>
  );
  const classes = cn(
    "inline-flex items-center gap-1.5 min-w-0 max-w-full rounded-md border border-border bg-muted/40 px-2 py-0.5 text-xs font-score tracking-wide",
    className,
  );
  return onClick ? (
    <button type="button" onClick={onClick} className={cn(classes, "hover:bg-muted/70")} aria-label={`Server: ${name}. Change server`}>
      {body}
    </button>
  ) : (
    <span className={classes} aria-label={`Server: ${name}`} title={name}>
      {body}
    </span>
  );
}
