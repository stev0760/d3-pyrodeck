import { useSession } from "@/session/SessionProvider";
import { cn } from "@/lib/utils";

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

/** The one-glance state in a root screen's header: the process in launch mode, the console link in connect mode. */
export function ShellStatus() {
  const { mode, isConnected, connection, processState } = useSession();
  let label: string;
  let color: string;
  if (connection.wsReconnecting) {
    label = "Reconnecting";
    color = "bg-primary animate-pulse";
  } else if (mode === "launch") {
    const state = processState ?? "stopped";
    label = state.charAt(0).toUpperCase() + state.slice(1);
    color = stateColor(state);
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
  return (
    <span className="flex items-center gap-1.5 text-[11px] font-score tracking-wide text-muted-foreground pr-1">
      <StatusDot className={color} />
      {label}
    </span>
  );
}
