import { Server, Terminal, Users, Bot, Ellipsis } from "lucide-react";
import type { Tab } from "@/lib/hashRoute";
import { cn } from "@/lib/utils";

const ITEMS: { tab: Tab; label: string; Icon: typeof Server }[] = [
  { tab: "server", label: "Server", Icon: Server },
  { tab: "console", label: "Console", Icon: Terminal },
  { tab: "players", label: "Players", Icon: Users },
  { tab: "bots", label: "Bots", Icon: Bot },
  { tab: "more", label: "More", Icon: Ellipsis },
];

interface TabBarProps {
  tab: Tab;
  onSelect: (tab: Tab) => void;
  /** The server is connected and has the bot commands. */
  botsEnabled: boolean;
}

/** The five sections, thumb-high, above the home indicator. */
export function TabBar({ tab, onSelect, botsEnabled }: TabBarProps) {
  return (
    <nav className="shrink-0 bg-sidebar border-t border-border pb-safe" aria-label="Sections">
      <div className="flex h-14">
        {ITEMS.map(({ tab: t, label, Icon }) => {
          const active = t === tab;
          const dim = t === "bots" && !botsEnabled;
          return (
            <button
              key={t}
              type="button"
              onClick={() => onSelect(t)}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex-1 min-w-0 flex flex-col items-center justify-center gap-1",
                active ? "text-primary" : dim ? "text-muted-foreground/40" : "text-muted-foreground",
              )}
            >
              <Icon className="size-6" strokeWidth={active ? 2.25 : 1.75} aria-hidden="true" />
              <span className="text-[11px] font-score tracking-wide leading-none">{label}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
