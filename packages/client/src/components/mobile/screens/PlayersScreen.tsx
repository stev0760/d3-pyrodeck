import { RefreshCw, Users } from "lucide-react";
import { useSession } from "@/session/SessionProvider";
import type { HashRouter } from "@/hooks/useHashRoute";
import { usePlayers } from "@/hooks/usePlayers";
import { Screen } from "../Screen.tsx";
import { ShellStatus } from "../ShellStatus.tsx";
import { SegmentedControl } from "@/components/compact/SegmentedControl";
import { SectionCard } from "@/components/compact/SectionCard";
import { EmptyState } from "@/components/compact/EmptyState";
import { PlayerCards } from "@/components/compact/PlayerCards";
import { Switch } from "@/components/ui/switch";
import { PlayerHistory } from "@/components/PlayerHistory";

const VIEWS = [
  { value: "game", label: "In game" },
  { value: "history", label: "History" },
] as const;

/** Who is in the game, and who has been. */
export function PlayersScreen({ router }: { router: HashRouter }) {
  const { isConnected, toast } = useSession();
  const view = router.route.path[1] === "history" ? "history" : "game";

  return (
    <Screen root title="Players" actions={<ShellStatus />}>
      <div className="px-3 pt-3 pb-1">
        <SegmentedControl
          value={view}
          options={VIEWS}
          onChange={(v) => router.navigate(v === "history" ? ["players", "history"] : ["players"], undefined, { replace: true })}
          aria-label="Players view"
        />
      </div>
      {view === "history" ? (
        <div className="p-3 overflow-x-auto">
          <PlayerHistory notify={toast.addToast} />
        </div>
      ) : isConnected ? (
        <InGame />
      ) : (
        <EmptyState icon={<Users />} title="Not connected" hint="The scoreboard needs the console. Players who were on before are under History." />
      )}
    </Screen>
  );
}

function InGame() {
  const { connection, toast } = useSession();
  const { players, addressOf, refresh, autoRefresh, setAutoRefresh, kick, ban } = usePlayers({
    sendCommand: connection.sendCommand,
    onPlayers: connection.onPlayers,
  });
  const inGame = players.filter((p) => !p.isObserver).length;

  return (
    <div className="p-3">
      <SectionCard
        flush
        title={`Players (${inGame})`}
        action={
          <span className="flex items-center gap-3">
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              Auto
              <Switch checked={autoRefresh} onCheckedChange={setAutoRefresh} aria-label="Refresh every 5 seconds" className="h-6 w-10 [&_[data-slot=switch-thumb]]:size-5 [&_[data-slot=switch-thumb]]:data-[state=checked]:translate-x-4" />
            </label>
            <button
              type="button"
              onClick={refresh}
              aria-label="Refresh"
              className="size-9 flex items-center justify-center rounded-lg text-muted-foreground active:bg-muted/60"
            >
              <RefreshCw className="size-4" />
            </button>
          </span>
        }
      >
        <PlayerCards
          players={players}
          addressOf={addressOf}
          onKick={kick}
          onBan={ban}
          notify={toast.addToast}
          onChanged={refresh}
        />
      </SectionCard>
    </div>
  );
}
