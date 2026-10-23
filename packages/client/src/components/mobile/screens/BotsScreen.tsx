import { Bot } from "lucide-react";
import { useSession } from "@/session/SessionProvider";
import type { HashRouter } from "@/hooks/useHashRoute";
import { Screen } from "../Screen.tsx";
import { ShellStatus } from "../ShellStatus.tsx";
import { EmptyState } from "@/components/compact/EmptyState";
import { BotPanel } from "@/components/BotPanel";

/** The bots in the game. */
export function BotsScreen(_props: { router: HashRouter }) {
  const { isConnected, connection } = useSession();
  const hasBots = isConnected && connection.hasFeature("bots");
  return (
    <Screen root title="Bots" actions={<ShellStatus />}>
      {hasBots ? (
        <div className="p-3">
          <BotPanel
            sendCommand={connection.sendCommand}
            onBots={connection.onBots}
            onBotStats={connection.onBotStats}
            onBotMode={connection.onBotMode}
            hasShips={connection.hasFeature("ships")}
            hasDifficulty={connection.hasFeature("difficulty")}
            hasTeams={connection.hasFeature("teams")}
          />
        </div>
      ) : (
        <EmptyState
          icon={<Bot />}
          title={isConnected ? "No bot support" : "Not connected"}
          hint={
            isConnected
              ? "This server does not run the Matcen bot commands."
              : "Bots appear once the console is connected to a Matcen server."
          }
        />
      )}
    </Screen>
  );
}
