import { Terminal } from "lucide-react";
import { useSession } from "@/session/SessionProvider";
import type { HashRouter } from "@/hooks/useHashRoute";
import { Screen } from "../Screen.tsx";
import { ShellStatus } from "../ShellStatus.tsx";
import { SegmentedControl } from "@/components/compact/SegmentedControl";
import { EmptyState } from "@/components/compact/EmptyState";
import { Console } from "@/components/Console";
import { ServerConsole } from "@/components/ServerConsole";
import { CommandReference } from "@/components/CommandReference";

const VIEWS = [
  { value: "console", label: "Console" },
  { value: "output", label: "Output" },
] as const;

/** The telnet console, and in launch mode the game's own output. */
export function ConsoleScreen({ router }: { router: HashRouter }) {
  const { mode, isConnected, hasProcess, connection, consoleBuffer, processBuffer } = useSession();
  const view = router.route.path[1] === "output" ? "output" : "console";
  const typedCommand = (command: string) => {
    consoleBuffer.line(command, "cmd");
    connection.sendCommand(command);
  };

  return (
    <Screen root title="Console" actions={<ShellStatus />} scroll={false}>
      {mode === "launch" && (
        <div className="px-3 pt-3 shrink-0">
          <SegmentedControl
            value={view}
            options={VIEWS}
            onChange={(v) => router.navigate(v === "output" ? ["console", "output"] : ["console"], undefined, { replace: true })}
            aria-label="Console view"
          />
        </div>
      )}
      {view === "output" ? (
        hasProcess ? (
          <div className="flex-1 min-h-0 p-3">
            <ServerConsole onProcessOutput={connection.onProcessOutput} replay={processBuffer.lines()} />
          </div>
        ) : (
          <EmptyState icon={<Terminal />} title="No server output" hint="Launch a server to see what it prints." />
        )
      ) : isConnected ? (
        <div className="flex-1 min-h-0 flex flex-col p-3">
          <div className="flex-1 min-h-0">
            <Console onCommand={typedCommand} onOutput={connection.onOutput} replay={consoleBuffer.lines()} />
          </div>
          <CommandReference sendCommand={connection.sendCommand} hasFeature={connection.hasFeature} />
        </div>
      ) : (
        <EmptyState
          icon={<Terminal />}
          title="Not connected"
          hint={mode === "connect" ? "Connect to a server from the Server tab." : "Launch a server from the Server tab."}
        />
      )}
    </Screen>
  );
}
