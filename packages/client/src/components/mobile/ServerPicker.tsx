import { createContext, useContext } from "react";
import { useSession } from "@/session/SessionProvider";
import { BottomSheet } from "@/components/compact/BottomSheet";
import { ListRow } from "@/components/compact/ListRow";
import { rowColor, rowFacts } from "@/components/ServerList";
import { launchRows, rowStateLabel, runningCount, type ServerRow } from "@/lib/servers";
import { StatusDot } from "./ShellStatus.tsx";

/** The phone shell's way to the server picker, from any screen's header. */
export const ServerPickerContext = createContext<(() => void) | null>(null);

export function useOpenServerPicker(): (() => void) | null {
  return useContext(ServerPickerContext);
}

/** One server as a list row: its state dot, name, facts and state. */
export function ServerListRow({ row, selected, onClick }: { row: ServerRow; selected: boolean; onClick: () => void }) {
  const { line1, playlist } = rowFacts(row);
  return (
    <ListRow
      icon={<StatusDot className={rowColor(row)} />}
      title={<span className={selected ? "text-primary" : undefined}>{row.name}</span>}
      subtitle={[line1, playlist].filter(Boolean).join(" · ") || undefined}
      trailing={
        <span className="flex flex-col items-end gap-0.5">
          <span className="font-score tracking-wide text-xs capitalize">{rowStateLabel(row)}</span>
          {selected && <span className="text-primary font-score tracking-wide text-[11px]">shown</span>}
        </span>
      }
      onClick={onClick}
    />
  );
}

/**
 * A bottom sheet listing every server Pyrodeck runs; a tap shows that server
 * on every screen.
 */
export function ServerPickerSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { servers, selectedServerId, selectServer } = useSession();
  const rows = launchRows(servers);
  const running = runningCount(servers);
  return (
    <BottomSheet
      open={open}
      onOpenChange={onOpenChange}
      title="Servers"
      description={running === 0 ? "None running" : `${running} of ${rows.length} running`}
    >
      <div className="-mx-4">
        {rows.length === 0 && (
          <p className="px-4 py-3 text-sm text-muted-foreground">No servers yet. Create a profile under More → Profiles.</p>
        )}
        {rows.map((row) => (
          <ServerListRow
            key={row.id}
            row={row}
            selected={row.id === selectedServerId}
            onClick={() => {
              selectServer(row.id);
              onOpenChange(false);
            }}
          />
        ))}
      </div>
    </BottomSheet>
  );
}
