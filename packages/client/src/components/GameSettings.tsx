import { useState } from "react";

interface GameSettingsProps {
  sendCommand: (command: string) => void;
}

function SettingRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between py-2 border-b border-zinc-800/50">
      <span className="text-sm text-zinc-400">{label}</span>
      <div className="flex items-center gap-2">{children}</div>
    </div>
  );
}

function NumberSetting({
  label,
  command,
  defaultValue,
  min,
  max,
  suffix,
  sendCommand,
}: {
  label: string;
  command: string;
  defaultValue: string;
  min?: number;
  max?: number;
  suffix?: string;
  sendCommand: (cmd: string) => void;
}) {
  const [value, setValue] = useState(defaultValue);

  return (
    <SettingRow label={label}>
      <input
        type="number"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        min={min}
        max={max}
        className="w-20 px-2 py-1 bg-zinc-800 border border-zinc-700 rounded text-sm text-zinc-100 text-right focus:outline-none focus:ring-1 focus:ring-amber-500"
      />
      {suffix && <span className="text-xs text-zinc-500">{suffix}</span>}
      <button
        onClick={() => sendCommand(`${command} ${value}`)}
        className="px-2 py-1 text-xs bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded transition-colors"
      >
        Apply
      </button>
    </SettingRow>
  );
}

export function GameSettings({ sendCommand }: GameSettingsProps) {
  const [pps, setPps] = useState(12);
  const [hudNames, setHudNames] = useState("full");
  const [warpLevel, setWarpLevel] = useState("1");
  const [confirmQuit, setConfirmQuit] = useState(false);

  return (
    <div className="h-full overflow-auto">
      {/* Live Settings */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 mb-4">
        <h3 className="text-sm font-medium text-zinc-300 mb-3">
          Live Game Settings
        </h3>

        <NumberSetting
          label="Max Players"
          command="$setmaxplayers"
          defaultValue="8"
          min={1}
          max={16}
          sendCommand={sendCommand}
        />

        <SettingRow label="Packets Per Second">
          <input
            type="range"
            min={5}
            max={20}
            value={pps}
            onChange={(e) => setPps(parseInt(e.target.value))}
            className="w-24"
          />
          <span className="text-sm text-zinc-300 w-6 text-right">{pps}</span>
          <button
            onClick={() => sendCommand(`$setpps ${pps}`)}
            className="px-2 py-1 text-xs bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded transition-colors"
          >
            Apply
          </button>
        </SettingRow>

        <NumberSetting
          label="Time Limit"
          command="$settimelimit"
          defaultValue="0"
          min={0}
          suffix="min"
          sendCommand={sendCommand}
        />

        <NumberSetting
          label="Kill/Score Goal"
          command="$setgoallimit"
          defaultValue="0"
          min={0}
          sendCommand={sendCommand}
        />

        <NumberSetting
          label="Respawn Time"
          command="$setrespawntime"
          defaultValue="5"
          min={0}
          suffix="sec"
          sendCommand={sendCommand}
        />

        <SettingRow label="HUD Names">
          <select
            value={hudNames}
            onChange={(e) => {
              setHudNames(e.target.value);
              sendCommand(`$serverhudnames ${e.target.value}`);
            }}
            className="px-2 py-1 bg-zinc-800 border border-zinc-700 rounded text-sm text-zinc-100"
          >
            <option value="none">None</option>
            <option value="team">Team Only</option>
            <option value="full">Full</option>
          </select>
        </SettingRow>
      </div>

      {/* Server Control */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
        <h3 className="text-sm font-medium text-zinc-300 mb-3">
          Server Control
        </h3>

        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => sendCommand("$endlevel")}
            className="px-3 py-1.5 text-sm bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded transition-colors"
          >
            End Level
          </button>

          <div className="flex items-center gap-1">
            <input
              type="number"
              value={warpLevel}
              onChange={(e) => setWarpLevel(e.target.value)}
              min={1}
              className="w-14 px-2 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-sm text-zinc-100 text-center focus:outline-none"
            />
            <button
              onClick={() => sendCommand(`$warp ${warpLevel}`)}
              className="px-3 py-1.5 text-sm bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded transition-colors"
            >
              Warp
            </button>
          </div>

          <button
            onClick={() => sendCommand("$balance")}
            className="px-3 py-1.5 text-sm bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded transition-colors"
          >
            Balance Teams
          </button>

          {!confirmQuit ? (
            <button
              onClick={() => setConfirmQuit(true)}
              className="px-3 py-1.5 text-sm bg-red-900/50 hover:bg-red-800 text-red-300 rounded transition-colors"
            >
              Quit Server
            </button>
          ) : (
            <div className="flex items-center gap-1">
              <span className="text-xs text-red-400">Are you sure?</span>
              <button
                onClick={() => {
                  sendCommand("Quit");
                  setConfirmQuit(false);
                }}
                className="px-2 py-1 text-xs bg-red-700 hover:bg-red-600 text-white rounded"
              >
                Yes, Quit
              </button>
              <button
                onClick={() => setConfirmQuit(false)}
                className="px-2 py-1 text-xs bg-zinc-700 hover:bg-zinc-600 text-zinc-300 rounded"
              >
                Cancel
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
