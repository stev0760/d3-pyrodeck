import { useState, useCallback } from "react";
import type { NetGameInfo, useServerInfo } from "../hooks/useServerInfo.ts";

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
      <span className="text-xs text-zinc-400">{label}</span>
      <div className="flex items-center gap-1">
        <button
          onClick={onDecrement}
          disabled={!canDecrement}
          className="w-6 h-6 flex items-center justify-center text-xs bg-zinc-800 hover:bg-zinc-700 disabled:opacity-30 disabled:hover:bg-zinc-800 text-zinc-300 rounded transition-colors"
        >
          -
        </button>
        <span className="text-sm text-zinc-200 w-10 text-center font-mono tabular-nums">
          {value}
          {suffix && <span className="text-zinc-500 text-[10px] ml-0.5">{suffix}</span>}
        </span>
        <button
          onClick={onIncrement}
          className="w-6 h-6 flex items-center justify-center text-xs bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded transition-colors"
        >
          +
        </button>
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
      <span className="text-[10px] text-zinc-500 uppercase tracking-wider">
        {label}
      </span>
      <span className="text-xs text-zinc-300 truncate ml-2 max-w-[140px] text-right">
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
    <aside className="w-64 shrink-0 border-l border-zinc-800 flex flex-col overflow-y-auto">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-800">
        <h2 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">
          Server
        </h2>
        <button
          onClick={actions.refresh}
          className="text-[10px] text-zinc-600 hover:text-amber-500 transition-colors"
          title="Refresh server info"
        >
          Refresh
        </button>
      </div>

      {!info ? (
        <div className="p-3 text-xs text-zinc-600">Loading server info...</div>
      ) : (
        <div className="flex flex-col flex-1">
          {/* Server Info */}
          <div className="px-3 py-2 border-b border-zinc-800/50">
            <InfoRow label="Game" value={info.gameName} />
            <InfoRow label="Mission" value={info.missionName} />
            <InfoRow label="Mode" value={info.scriptName} />
            <InfoRow label="Network" value={info.networkModel} />
            {info.timeLeft && (
              <InfoRow label="Time Left" value={info.timeLeft} />
            )}
          </div>

          {/* Settings */}
          <div className="px-3 py-2 border-b border-zinc-800/50">
            <h3 className="text-[10px] text-zinc-600 uppercase tracking-wider font-semibold mb-1">
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

          {/* Quick Actions */}
          <div className="px-3 py-2 border-b border-zinc-800/50">
            <h3 className="text-[10px] text-zinc-600 uppercase tracking-wider font-semibold mb-2">
              Actions
            </h3>
            <div className="flex flex-col gap-1.5">
              <button
                onClick={actions.endLevel}
                className="w-full px-2 py-1.5 text-xs bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded transition-colors text-left"
              >
                End Level
              </button>

              <div className="flex gap-1">
                <input
                  type="number"
                  value={warpLevel}
                  onChange={(e) => setWarpLevel(e.target.value)}
                  min={1}
                  className="flex-1 px-2 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-xs text-zinc-100 text-center focus:outline-none focus:border-amber-600"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleWarp();
                  }}
                />
                <button
                  onClick={handleWarp}
                  className="px-3 py-1.5 text-xs bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded transition-colors"
                >
                  Warp
                </button>
              </div>

              <button
                onClick={actions.balanceTeams}
                className="w-full px-2 py-1.5 text-xs bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded transition-colors text-left"
              >
                Balance Teams
              </button>
            </div>
          </div>

          {/* Danger Zone */}
          <div className="px-3 py-2 mt-auto">
            {!confirmQuit ? (
              <button
                onClick={() => setConfirmQuit(true)}
                className="w-full px-2 py-1.5 text-xs bg-red-950/50 hover:bg-red-900/50 text-red-400 border border-red-900/30 rounded transition-colors"
              >
                Quit Server
              </button>
            ) : (
              <div className="space-y-1.5">
                <p className="text-[10px] text-red-400 text-center">
                  Are you sure?
                </p>
                <div className="flex gap-1">
                  <button
                    onClick={() => {
                      actions.quitServer();
                      setConfirmQuit(false);
                    }}
                    className="flex-1 px-2 py-1.5 text-xs bg-red-700 hover:bg-red-600 text-white rounded transition-colors"
                  >
                    Yes, Quit
                  </button>
                  <button
                    onClick={() => setConfirmQuit(false)}
                    className="flex-1 px-2 py-1.5 text-xs bg-zinc-700 hover:bg-zinc-600 text-zinc-300 rounded transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </aside>
  );
}
