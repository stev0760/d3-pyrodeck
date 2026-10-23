import { useState } from "react";
import { Terminal, Eraser } from "lucide-react";
import { useSession } from "@/session/SessionProvider";
import type { HashRouter } from "@/hooks/useHashRoute";
import { useCommandHistory } from "@/hooks/useCommandHistory";
import { Screen } from "../Screen.tsx";
import { ShellStatus } from "../ShellStatus.tsx";
import { ConsoleInput, type QuickCommand } from "../ConsoleInput.tsx";
import { CommandSheet } from "../CommandSheet.tsx";
import { SegmentedControl } from "@/components/compact/SegmentedControl";
import { EmptyState } from "@/components/compact/EmptyState";
import { LineView } from "@/components/compact/LineView";

const VIEWS = [
  { value: "console", label: "Console" },
  { value: "output", label: "Output" },
] as const;

// Read-only queries, safe to fire with one tap. Never $netgameinfo: each
// call leaks an engine buffer on a dedicated server (useServerInfo).
const FAVORITES: QuickCommand[] = [
  { cmd: "$scores", label: "Scores" },
  { cmd: "$players", label: "Players" },
];
const BOT_FAVORITES: QuickCommand[] = [{ cmd: "$botlist", label: "Bots" }];
const POPULATION_FAVORITES: QuickCommand[] = [{ cmd: "$botpopulation", label: "Population" }];

/** The telnet console, and in launch mode the game's own output. */
export function ConsoleScreen({ router }: { router: HashRouter }) {
  const { mode, isConnected, hasProcess, connection, consoleBuffer, processBuffer } = useSession();
  const view = router.route.path[1] === "output" ? "output" : "console";
  const { history, remember } = useCommandHistory();
  const [sheetOpen, setSheetOpen] = useState(false);

  const send = (command: string) => {
    const cmd = command.trim();
    if (!cmd) return;
    consoleBuffer.line(cmd, "cmd");
    connection.sendCommand(cmd);
    remember(cmd);
  };

  const favorites = [
    ...FAVORITES,
    ...(connection.hasFeature("bots") ? BOT_FAVORITES : []),
    ...(connection.hasFeature("population") ? POPULATION_FAVORITES : []),
  ];
  const buffer = view === "output" ? processBuffer : consoleBuffer;
  const showing = view === "output" ? hasProcess : isConnected;

  return (
    <Screen
      root
      title="Console"
      scroll={false}
      actions={
        <>
          {showing && (
            <button
              type="button"
              onClick={() => buffer.clear()}
              aria-label="Clear"
              className="size-10 flex items-center justify-center rounded-lg text-muted-foreground active:bg-muted/60"
            >
              <Eraser className="size-5" />
            </button>
          )}
          <ShellStatus />
        </>
      }
    >
      {mode === "launch" && (
        <div className="px-3 pt-3 pb-1 shrink-0">
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
          <LineView buffer={processBuffer} emptyText="Waiting for the server to print something." />
        ) : (
          <EmptyState icon={<Terminal />} title="No server output" hint="Launch a server to see what it prints." />
        )
      ) : isConnected ? (
        <>
          <LineView buffer={consoleBuffer} kinds={["out", "cmd", "sys"]} emptyText="Console ready. Type a command below, or pick one." />
          <ConsoleInput
            onSend={send}
            history={history}
            favorites={favorites}
            hasFeature={connection.hasFeature}
            onOpenCommands={() => setSheetOpen(true)}
          />
        </>
      ) : (
        <EmptyState
          icon={<Terminal />}
          title="Not connected"
          hint={mode === "connect" ? "Connect to a server from the Server tab." : "Launch a server from the Server tab."}
        />
      )}

      <CommandSheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        hasFeature={connection.hasFeature}
        onRun={(cmd) => {
          send(cmd);
          setSheetOpen(false);
        }}
      />
    </Screen>
  );
}
