import { ChevronDown } from "lucide-react";
import { useSession } from "@/session/SessionProvider";
import { cn } from "@/lib/utils";
import { rowStateLabel } from "@/lib/servers";
import { rowColor } from "@/components/ServerList";
import { useOpenServerPicker } from "./ServerPicker.tsx";

/** The dot colour for a game process state (the Launch panel's palette). */
export function stateColor(state: string | undefined): string {
  switch (state) {
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

export function StatusDot({ className }: { className: string }) {
  return <span className={cn("inline-block size-2 rounded-full shrink-0", className)} aria-hidden="true" />;
}

/**
 * The one-glance state in a screen's header: in launch mode the server on
 * screen (its name and state; a tap opens the server picker), in connect
 * mode the console link.
 */
export function ShellStatus() {
  const { mode, isConnected, connection, processState, server, serverName } = useSession();
  const openPicker = useOpenServerPicker();
  let label: string;
  let color: string;
  let name: string | null = null;
  if (connection.wsReconnecting) {
    label = "Reconnecting";
    color = "bg-primary animate-pulse";
  } else if (mode === "launch") {
    const row = server && processState && processState !== server.state ? { ...server, state: processState } : server;
    label = row ? rowStateLabel(row) : "No server";
    label = label.charAt(0).toUpperCase() + label.slice(1);
    color = row ? rowColor(row) : stateColor(undefined);
    name = serverName;
  } else if (isConnected) {
    label = "Connected";
    color = "bg-emerald-500";
  } else if (connection.connectionState === "connecting" || connection.connectionState === "probing") {
    label = "Connecting";
    color = "bg-primary animate-pulse";
  } else {
    label = "Offline";
    color = "bg-muted-foreground";
  }
  const body = (
    <>
      <StatusDot className={color} />
      {name && <span className="min-w-0 max-w-[9rem] truncate text-foreground">{name}</span>}
      <span className="shrink-0">{label}</span>
      {mode === "launch" && openPicker && <ChevronDown className="size-3.5 shrink-0" aria-hidden="true" />}
    </>
  );
  const classes = "flex items-center gap-1.5 min-w-0 text-[11px] font-score tracking-wide text-muted-foreground pr-1";
  if (mode === "launch" && openPicker) {
    return (
      <button
        type="button"
        onClick={openPicker}
        className={cn(classes, "h-10 pl-2 -mr-1 rounded-lg active:bg-muted/60")}
        aria-label={`Server: ${name ?? "none"}, ${label}. Change server`}
      >
        {body}
      </button>
    );
  }
  return <span className={classes}>{body}</span>;
}
