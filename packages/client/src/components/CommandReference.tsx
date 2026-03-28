import { useState, useCallback, useEffect } from "react";

interface CommandDef {
  cmd: string;
  label: string;
  args?: { name: string; placeholder: string; type?: "number" | "text" }[];
  /** If true, show a select dropdown instead of text input */
  select?: { name: string; options: { value: string; label: string }[] }[];
}

interface CommandCategory {
  id: string;
  label: string;
  commands: CommandDef[];
  /** Only show this category when a feature flag is present */
  requireFeature?: string;
}

const CATEGORIES: CommandCategory[] = [
  {
    id: "players",
    label: "Players",
    commands: [
      { cmd: "$players", label: "Players" },
      { cmd: "$scores", label: "Scores" },
      {
        cmd: "$playerinfo",
        label: "Player Info",
        args: [{ name: "pnum", placeholder: "pnum", type: "number" }],
      },
      {
        cmd: "$kick",
        label: "Kick",
        args: [{ name: "pnum", placeholder: "pnum", type: "number" }],
      },
      {
        cmd: "$ban",
        label: "Ban",
        args: [{ name: "pnum", placeholder: "pnum", type: "number" }],
      },
      { cmd: "$banlist", label: "Ban List" },
      {
        cmd: "$removeban",
        label: "Remove Ban",
        args: [{ name: "index", placeholder: "index", type: "number" }],
      },
    ],
  },
  {
    id: "teams",
    label: "Teams",
    commands: [
      {
        cmd: "$changeteam",
        label: "Change Team",
        args: [
          { name: "pnum", placeholder: "pnum", type: "number" },
          { name: "team", placeholder: "team name", type: "text" },
        ],
      },
      { cmd: "$balance", label: "Balance" },
      {
        cmd: "$allowteamchange",
        label: "Allow Team Change",
        select: [
          {
            name: "toggle",
            options: [
              { value: "on", label: "On" },
              { value: "off", label: "Off" },
            ],
          },
        ],
      },
      {
        cmd: "$autobalance",
        label: "Auto-Balance",
        select: [
          {
            name: "toggle",
            options: [
              { value: "on", label: "On" },
              { value: "off", label: "Off" },
            ],
          },
        ],
      },
      {
        cmd: "$setteamname",
        label: "Set Team Name",
        args: [
          { name: "teamnum", placeholder: "team #", type: "number" },
          { name: "name", placeholder: "new name", type: "text" },
        ],
      },
    ],
  },
  {
    id: "server",
    label: "Server",
    commands: [
      {
        cmd: "$wait",
        label: "Wait",
        select: [
          {
            name: "toggle",
            options: [
              { value: "on", label: "On" },
              { value: "off", label: "Off" },
            ],
          },
        ],
      },
      { cmd: "$netgameinfo", label: "Game Info" },
      {
        cmd: "$serverhudnames",
        label: "HUD Names",
        select: [
          {
            name: "level",
            options: [
              { value: "full", label: "Full" },
              { value: "team", label: "Team" },
              { value: "none", label: "None" },
            ],
          },
        ],
      },
      {
        cmd: "say",
        label: "Say",
        args: [{ name: "message", placeholder: "message", type: "text" }],
      },
    ],
  },
  {
    id: "stats",
    label: "Stats",
    commands: [
      { cmd: "$savestats", label: "Save Stats" },
      {
        cmd: "$autosavelevel",
        label: "Auto-Save Level",
        select: [
          {
            name: "toggle",
            options: [
              { value: "on", label: "On" },
              { value: "off", label: "Off" },
            ],
          },
        ],
      },
      {
        cmd: "$autosavedisconnect",
        label: "Auto-Save Disconnect",
        select: [
          {
            name: "toggle",
            options: [
              { value: "on", label: "On" },
              { value: "off", label: "Off" },
            ],
          },
        ],
      },
      {
        cmd: "$statmsgs",
        label: "Stat Messages",
        select: [
          {
            name: "toggle",
            options: [
              { value: "on", label: "On" },
              { value: "off", label: "Off" },
            ],
          },
        ],
      },
      {
        cmd: "$killmsgfilter",
        label: "Kill Msg Filter",
        select: [
          {
            name: "level",
            options: [
              { value: "full", label: "Full" },
              { value: "simple", label: "Simple" },
              { value: "none", label: "None" },
            ],
          },
        ],
      },
    ],
  },
  {
    id: "bots",
    label: "Bots",
    requireFeature: "bots",
    commands: [
      {
        cmd: "$addbot",
        label: "Add Bot",
        args: [
          { name: "name", placeholder: "name", type: "text" },
        ],
        select: [
          {
            name: "ship",
            options: [
              { value: "", label: "Ship..." },
              { value: "pyro", label: "Pyro" },
              { value: "phoenix", label: "Phoenix" },
              { value: "magnum", label: "Magnum" },
              { value: "blackpyro", label: "Black Pyro" },
            ],
          },
          {
            name: "difficulty",
            options: [
              { value: "", label: "Difficulty..." },
              { value: "trainee", label: "Trainee" },
              { value: "rookie", label: "Rookie" },
              { value: "hotshot", label: "Hotshot" },
              { value: "ace", label: "Ace" },
              { value: "insane", label: "Insane" },
            ],
          },
        ],
      },
      {
        cmd: "$removebot",
        label: "Remove Bot",
        args: [{ name: "index", placeholder: "bot index", type: "number" }],
      },
      { cmd: "$removebots", label: "Remove All Bots" },
      { cmd: "$botlist", label: "Bot List" },
      {
        cmd: "$botstat",
        label: "Bot Status",
        args: [{ name: "index", placeholder: "index or all", type: "text" }],
      },
      {
        cmd: "$botdifficulty",
        label: "Bot Difficulty",
        args: [
          { name: "index", placeholder: "index or all", type: "text" },
        ],
        select: [
          {
            name: "level",
            options: [
              { value: "trainee", label: "Trainee" },
              { value: "rookie", label: "Rookie" },
              { value: "hotshot", label: "Hotshot" },
              { value: "ace", label: "Ace" },
              { value: "insane", label: "Insane" },
            ],
          },
        ],
      },
      { cmd: "$servercaps", label: "Server Caps" },
    ],
  },
];

interface CommandReferenceProps {
  sendCommand: (command: string) => void;
  hasFeature: (feature: string) => boolean;
}

function CommandButton({
  def,
  sendCommand,
}: {
  def: CommandDef;
  sendCommand: (cmd: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [argValues, setArgValues] = useState<Record<string, string>>({});
  const [selectValues, setSelectValues] = useState<Record<string, string>>({});

  const hasInputs = (def.args && def.args.length > 0) || (def.select && def.select.length > 0);

  const execute = useCallback(() => {
    const parts = [def.cmd];

    // Add text/number args first
    if (def.args) {
      for (const arg of def.args) {
        const val = argValues[arg.name]?.trim();
        if (val) parts.push(val);
      }
    }

    // Add select values
    if (def.select) {
      for (const sel of def.select) {
        const val = selectValues[sel.name];
        if (val) parts.push(val);
      }
    }

    sendCommand(parts.join(" "));
    setArgValues({});
    setSelectValues({});
    setExpanded(false);
  }, [def, argValues, selectValues, sendCommand]);

  if (!hasInputs) {
    return (
      <button
        onClick={() => sendCommand(def.cmd)}
        className="px-2.5 py-1 text-xs bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-amber-400 border border-zinc-700 rounded transition-colors font-mono"
        title={def.cmd}
      >
        {def.label}
      </button>
    );
  }

  if (!expanded) {
    return (
      <button
        onClick={() => setExpanded(true)}
        className="px-2.5 py-1 text-xs bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-amber-400 border border-zinc-700 rounded transition-colors font-mono"
        title={`${def.cmd} (click to expand)`}
      >
        {def.label}
        <span className="ml-1 text-zinc-600">...</span>
      </button>
    );
  }

  return (
    <div className="flex items-center gap-1.5 bg-zinc-800/80 border border-zinc-600 rounded px-2 py-1">
      <span className="text-xs text-amber-500/70 font-mono shrink-0">{def.cmd}</span>

      {def.args?.map((arg) => (
        <input
          key={arg.name}
          type={arg.type || "text"}
          placeholder={arg.placeholder}
          value={argValues[arg.name] || ""}
          onChange={(e) =>
            setArgValues((prev) => ({ ...prev, [arg.name]: e.target.value }))
          }
          onKeyDown={(e) => {
            if (e.key === "Enter") execute();
            if (e.key === "Escape") setExpanded(false);
          }}
          autoFocus={def.args?.indexOf(arg) === 0}
          className="w-16 px-1.5 py-0.5 text-xs bg-zinc-900 border border-zinc-700 rounded text-zinc-100 placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-amber-500/50"
        />
      ))}

      {def.select?.map((sel) => (
        <select
          key={sel.name}
          value={selectValues[sel.name] || sel.options[0]?.value || ""}
          onChange={(e) =>
            setSelectValues((prev) => ({ ...prev, [sel.name]: e.target.value }))
          }
          className="px-1 py-0.5 text-xs bg-zinc-900 border border-zinc-700 rounded text-zinc-100 focus:outline-none focus:ring-1 focus:ring-amber-500/50"
        >
          {sel.options.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      ))}

      <button
        onClick={execute}
        className="px-1.5 py-0.5 text-xs bg-amber-600 hover:bg-amber-500 text-black rounded transition-colors font-medium"
      >
        Run
      </button>
      <button
        onClick={() => setExpanded(false)}
        className="px-1 py-0.5 text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
      >
        ✕
      </button>
    </div>
  );
}

export function CommandReference({ sendCommand, hasFeature }: CommandReferenceProps) {
  const [expanded, setExpanded] = useState(() => {
    try {
      return localStorage.getItem("pyrodeck-cmdref-expanded") === "true";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem("pyrodeck-cmdref-expanded", String(expanded));
    } catch {
      // ignore
    }
  }, [expanded]);

  const visibleCategories = CATEGORIES.filter(
    (cat) => !cat.requireFeature || hasFeature(cat.requireFeature),
  );

  return (
    <div className="shrink-0 border-t border-zinc-800">
      {/* Toggle bar */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-3 py-1.5 text-xs text-zinc-500 hover:text-zinc-300 hover:bg-zinc-900/50 transition-colors"
      >
        <span className="font-medium">Command Reference</span>
        <svg
          className={`w-3.5 h-3.5 transition-transform ${expanded ? "rotate-180" : ""}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 15l7-7 7 7" />
        </svg>
      </button>

      {/* Expanded panel */}
      {expanded && (
        <div className="px-3 pb-3 max-h-64 overflow-y-auto">
          <div className="space-y-3">
            {visibleCategories.map((cat) => (
              <div key={cat.id}>
                <h4 className="text-[10px] uppercase tracking-wider text-zinc-600 font-semibold mb-1.5">
                  {cat.label}
                </h4>
                <div className="flex flex-wrap gap-1.5">
                  {cat.commands.map((def) => (
                    <CommandButton
                      key={def.cmd}
                      def={def}
                      sendCommand={sendCommand}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
