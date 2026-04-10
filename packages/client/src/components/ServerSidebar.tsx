import { useState, useCallback } from "react";
import type { NetGameInfo, useServerInfo } from "../hooks/useServerInfo.ts";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";

type ServerInfoActions = ReturnType<typeof useServerInfo>;

interface ServerSidebarProps {
  serverInfo: NetGameInfo | null;
  actions: ServerInfoActions;
}

function Stepper({
  label,
  value,
  onIncrement,
  onDecrement,
  min,
  suffix,
}: {
  label: string;
  value: number | string;
  onIncrement: () => void;
  onDecrement: () => void;
  min?: number;
  suffix?: string;
}) {
  const canDecrement = min === undefined || Number(value) > min;

  return (
    <div className="flex items-center justify-between py-1.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="flex items-center gap-1">
        <Button
          variant="secondary"
          size="icon-xs"
          onClick={onDecrement}
          disabled={!canDecrement}
        >
          -
        </Button>
        <span className="text-sm text-foreground w-10 text-center font-mono tabular-nums">
          {value}
          {suffix && <span className="text-muted-foreground text-[10px] ml-0.5">{suffix}</span>}
        </span>
        <Button
          variant="secondary"
          size="icon-xs"
          onClick={onIncrement}
        >
          +
        </Button>
      </div>
    </div>
  );
}

function InfoRow({
  label,
  value,
}: {
  label: string;
  value: string | number | null | undefined;
}) {
  if (value === null || value === undefined) return null;
  return (
    <div className="flex items-center justify-between py-0.5">
      <span className="text-[10px] text-muted-foreground uppercase tracking-wider">
        {label}
      </span>
      <span className="text-xs text-foreground/80 truncate ml-2 max-w-[140px] text-right">
        {value}
      </span>
    </div>
  );
}

export function ServerSidebar({ serverInfo, actions }: ServerSidebarProps) {
  const [warpLevel, setWarpLevel] = useState("1");
  const [confirmQuit, setConfirmQuit] = useState(false);

  const info = serverInfo;

  const handleWarp = useCallback(() => {
    const level = parseInt(warpLevel, 10);
    if (level > 0) actions.warp(level);
  }, [warpLevel, actions]);

  return (
    <aside className="w-64 shrink-0 border-l border-border bg-sidebar flex flex-col overflow-y-auto">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <h2 className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
          Server
        </h2>
        <Button variant="ghost" size="xs" onClick={actions.refresh} className="text-[10px]">
          Refresh
        </Button>
      </div>

      {!info ? (
        <div className="p-3 text-xs text-muted-foreground">Loading server info...</div>
      ) : (
        <div className="flex flex-col flex-1">
          {/* Server Info */}
          <div className="px-3 py-2">
            <InfoRow label="Game" value={info.gameName} />
            <InfoRow label="Mission" value={info.missionName} />
            <InfoRow label="Mode" value={info.scriptName} />
            <InfoRow label="Network" value={info.networkModel} />
            {info.timeLeft && (
              <InfoRow label="Time Left" value={info.timeLeft} />
            )}
          </div>

          <Separator />

          {/* Settings */}
          <div className="px-3 py-2">
            <h3 className="text-[10px] text-muted-foreground uppercase tracking-wider font-semibold mb-1">
              Settings
            </h3>
            <Stepper
              label="Max Players"
              value={info.maxPlayers}
              onIncrement={() => actions.setMaxPlayers(info.maxPlayers + 1)}
              onDecrement={() => actions.setMaxPlayers(info.maxPlayers - 1)}
              min={1}
            />
            <Stepper
              label="PPS"
              value={info.pps}
              onIncrement={() => actions.setPps(info.pps + 5)}
              onDecrement={() => actions.setPps(info.pps - 5)}
              min={5}
            />
            <Stepper
              label="Time Limit"
              value={info.timeLimit}
              onIncrement={() => actions.setTimeLimit(info.timeLimit + 5)}
              onDecrement={() => actions.setTimeLimit(info.timeLimit - 5)}
              min={0}
              suffix="m"
            />
            <Stepper
              label="Kill Goal"
              value={info.goalLimit}
              onIncrement={() => actions.setGoalLimit(info.goalLimit + 5)}
              onDecrement={() => actions.setGoalLimit(info.goalLimit - 5)}
              min={0}
            />
          </div>

          <Separator />

          {/* Quick Actions */}
          <div className="px-3 py-2">
            <h3 className="text-[10px] text-muted-foreground uppercase tracking-wider font-semibold mb-2">
              Actions
            </h3>
            <div className="flex flex-col gap-1.5">
              <Button
                variant="secondary"
                size="sm"
                onClick={actions.endLevel}
                className="w-full justify-start"
              >
                End Level
              </Button>

              <div className="flex gap-1">
                <input
                  type="number"
                  value={warpLevel}
                  onChange={(e) => setWarpLevel(e.target.value)}
                  min={1}
                  className="flex-1 px-2 py-1.5 bg-input border border-border rounded-md text-xs text-foreground text-center focus:outline-none focus:ring-1 focus:ring-ring"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleWarp();
                  }}
                />
                <Button variant="secondary" size="sm" onClick={handleWarp}>
                  Warp
                </Button>
              </div>

              <Button
                variant="secondary"
                size="sm"
                onClick={actions.balanceTeams}
                className="w-full justify-start"
              >
                Balance Teams
              </Button>
            </div>
          </div>

          {/* Danger Zone */}
          <div className="px-3 py-2 mt-auto">
            <Separator className="mb-2" />
            {!confirmQuit ? (
              <Button
                variant="destructive"
                size="sm"
                onClick={() => setConfirmQuit(true)}
                className="w-full"
              >
                Quit Server
              </Button>
            ) : (
              <div className="space-y-1.5">
                <p className="text-[10px] text-destructive text-center">
                  Are you sure?
                </p>
                <div className="flex gap-1">
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => {
                      actions.quitServer();
                      setConfirmQuit(false);
                    }}
                    className="flex-1"
                  >
                    Yes, Quit
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setConfirmQuit(false)}
                    className="flex-1"
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </aside>
  );
}
