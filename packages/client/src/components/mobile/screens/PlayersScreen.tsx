import { useSession } from "@/session/SessionProvider";
import type { HashRouter } from "@/hooks/useHashRoute";
import { Screen } from "../Screen.tsx";
import { ShellStatus } from "../ShellStatus.tsx";
import { PlayersPanel } from "@/components/PlayersPanel";

/** Who is in the game, and who has been. */
export function PlayersScreen(_props: { router: HashRouter }) {
  const { isConnected, connection, toast } = useSession();
  return (
    <Screen root title="Players" actions={<ShellStatus />}>
      <div className="p-3">
        <PlayersPanel
          connected={isConnected}
          sendCommand={connection.sendCommand}
          onPlayers={connection.onPlayers}
          notify={toast.addToast}
        />
      </div>
    </Screen>
  );
}
