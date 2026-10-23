/**
 * The console commands the panel knows: what the Command Reference lists on a
 * desktop and the command sheet offers on a phone. Grouped, with the arguments
 * each takes, and gated on the server's advertised features where a group
 * only exists on the Matcen fork.
 */

export interface CommandDef {
  cmd: string;
  label: string;
  args?: { name: string; placeholder: string; type?: "number" | "text" }[];
  select?: { name: string; options: { value: string; label: string }[] }[];
  /** Ask before sending (a command that cannot be undone). */
  confirm?: string;
}

export interface CommandCategory {
  id: string;
  label: string;
  commands: CommandDef[];
  requireFeature?: string;
}

export const CATEGORIES: CommandCategory[] = [
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
          {
            name: "team",
            options: [
              { value: "", label: "Team..." },
              { value: "1", label: "Team 1" },
              { value: "2", label: "Team 2" },
              { value: "3", label: "Team 3" },
              { value: "4", label: "Team 4" },
            ],
          },
        ],
      },
      {
        cmd: "$removebot",
        label: "Remove Bot",
        args: [{ name: "index", placeholder: "bot index", type: "number" }],
      },
      { cmd: "$removebots", label: "Remove All Bots", confirm: "Remove every bot from the game?" },
      { cmd: "$botlist", label: "Bot List" },
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
    ],
  },
  {
    id: "bot-debug",
    label: "Bot Debug",
    requireFeature: "bots",
    commands: [
      {
        cmd: "$botstat",
        label: "Bot Stat",
        args: [{ name: "index", placeholder: "index or all", type: "text" }],
      },
      {
        cmd: "$botmov",
        label: "Bot Mov Log",
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
      { cmd: "$botmode", label: "Game Mode" },
      { cmd: "$botobj", label: "Objective State" },
      { cmd: "$nav", label: "Nav Toggles" },
      {
        // Toggle names churn every Matcen build (Tier 3, spec §2.7) — free
        // text instead of a list; "Nav Toggles" above prints the live table.
        cmd: "$nav",
        label: "Nav Set",
        args: [{ name: "toggle", placeholder: "toggle (see Nav Toggles)", type: "text" }],
        select: [
          {
            name: "state",
            options: [
              { value: "on", label: "On" },
              { value: "off", label: "Off" },
            ],
          },
        ],
      },
      {
        cmd: "$nav dump",
        label: "Nav Dump",
        args: [{ name: "file", placeholder: "file (optional)", type: "text" }],
      },
      { cmd: "$bothelp", label: "Bot Help" },
      { cmd: "$servercaps", label: "Server Caps" },
    ],
  },
];


/** The categories a server offers, by its advertised features. */
export function visibleCategories(hasFeature: (feature: string) => boolean): CommandCategory[] {
  return CATEGORIES.filter((cat) => !cat.requireFeature || hasFeature(cat.requireFeature));
}

/** Whether a command needs arguments before it can be sent. */
export function hasInputs(def: CommandDef): boolean {
  return (def.args?.length ?? 0) > 0 || (def.select?.length ?? 0) > 0;
}

/** The value a select shows and sends: the chosen one, else its first option. */
export function selectValueOf(
  sel: NonNullable<CommandDef["select"]>[number],
  chosen: Record<string, string>,
): string {
  return chosen[sel.name] ?? sel.options[0]?.value ?? "";
}

/** The command line for a definition and the values typed or chosen for it. */
export function buildCommand(
  def: CommandDef,
  args: Record<string, string>,
  selects: Record<string, string>,
): string {
  const parts = [def.cmd];
  for (const arg of def.args ?? []) {
    const val = args[arg.name]?.trim();
    if (val) parts.push(val);
  }
  for (const sel of def.select ?? []) {
    const val = selectValueOf(sel, selects);
    if (val) parts.push(val);
  }
  return parts.join(" ");
}

export interface CommandMatch {
  category: CommandCategory;
  def: CommandDef;
}

/**
 * Commands whose name or label contains the query, the ones starting with it
 * first. A query of "$" alone lists everything the server offers.
 */
export function searchCommands(query: string, hasFeature: (feature: string) => boolean, limit = 8): CommandMatch[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const starts: CommandMatch[] = [];
  const contains: CommandMatch[] = [];
  for (const category of visibleCategories(hasFeature)) {
    for (const def of category.commands) {
      const cmd = def.cmd.toLowerCase();
      const label = def.label.toLowerCase();
      if (cmd.startsWith(q) || label.startsWith(q)) starts.push({ category, def });
      else if (cmd.includes(q) || label.includes(q)) contains.push({ category, def });
    }
  }
  return [...starts, ...contains].slice(0, limit);
}
