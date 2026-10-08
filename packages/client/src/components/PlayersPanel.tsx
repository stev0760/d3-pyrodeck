import { useState } from "react";
import { Button } from "@/components/ui/button";
import { PlayerList } from "./PlayerList.tsx";
import { PlayerHistory } from "./PlayerHistory.tsx";

interface PlayersPanelProps {
  connected: boolean;
  sendCommand: (command: string) => void;
  onPlayers: (callback: (data: unknown) => void) => () => void;
  notify: (message: string, type?: "error" | "info") => void;
}

/** The Players tab: who is on now, and the join/leave history. */
export function PlayersPanel({ connected, sendCommand, onPlayers, notify }: PlayersPanelProps) {
  // null: follow the connection (in game while connected, history otherwise).
  const [view, setView] = useState<"live" | "history" | null>(null);
  const shown = connected ? (view ?? "live") : "history";

  return (
    <div className="h-full flex flex-col gap-2 min-h-0">
      <div className="flex gap-1">
        <Button
          size="xs"
          variant={shown === "live" ? "default" : "secondary"}
          onClick={() => setView("live")}
          disabled={!connected}
          className="font-score tracking-wide"
        >
          In game
        </Button>
        <Button
          size="xs"
          variant={shown === "history" ? "default" : "secondary"}
          onClick={() => setView("history")}
          className="font-score tracking-wide"
        >
          History
        </Button>
      </div>
      <div className="flex-1 min-h-0">
        {shown === "live" ? (
          <PlayerList sendCommand={sendCommand} onPlayers={onPlayers} notify={notify} />
        ) : (
          <PlayerHistory notify={notify} />
        )}
      </div>
    </div>
  );
}
