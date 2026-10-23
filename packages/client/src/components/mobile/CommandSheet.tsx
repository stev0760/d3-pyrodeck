import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { BottomSheet } from "@/components/compact/BottomSheet";
import { ConfirmDialog } from "@/components/compact/ConfirmDialog";
import { buildCommand, hasInputs, selectValueOf, visibleCategories, type CommandDef } from "@/lib/commands";
import { cn } from "@/lib/utils";

interface CommandSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  hasFeature: (feature: string) => boolean;
  onRun: (command: string) => void;
}

/**
 * Every console command the server offers, by group. A command without
 * arguments runs on a tap; one with arguments opens to its fields and a Run
 * button; the one that cannot be undone asks first.
 */
export function CommandSheet({ open, onOpenChange, hasFeature, onRun }: CommandSheetProps) {
  const categories = visibleCategories(hasFeature);
  const [categoryId, setCategoryId] = useState(categories[0]?.id ?? "players");
  const [openCmd, setOpenCmd] = useState<string | null>(null);
  const [args, setArgs] = useState<Record<string, string>>({});
  const [selects, setSelects] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<{ def: CommandDef; command: string } | null>(null);

  const category = categories.find((c) => c.id === categoryId) ?? categories[0];
  const keyOf = (def: CommandDef) => `${def.cmd} ${def.label}`;

  const run = (def: CommandDef, command: string) => {
    if (def.confirm) {
      setPending({ def, command });
      return;
    }
    onRun(command);
    setOpenCmd(null);
    setArgs({});
    setSelects({});
  };

  return (
    <>
      <BottomSheet open={open} onOpenChange={onOpenChange} title="Commands" className="h-[85dvh]">
        <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-3 no-scrollbar" role="tablist" aria-label="Command groups">
          {categories.map((c) => (
            <button
              key={c.id}
              type="button"
              role="tab"
              aria-selected={c.id === category?.id}
              onClick={() => {
                setCategoryId(c.id);
                setOpenCmd(null);
              }}
              className={cn(
                "shrink-0 h-9 px-3 rounded-full text-sm font-score tracking-wide whitespace-nowrap",
                c.id === category?.id ? "bg-secondary text-primary" : "bg-muted text-muted-foreground",
              )}
            >
              {c.label}
            </button>
          ))}
        </div>
        <div className="-mx-4 divide-y divide-border/60">
          {category?.commands.map((def) => {
            const k = keyOf(def);
            const expanded = openCmd === k;
            const needsInput = hasInputs(def);
            return (
              <div key={k}>
                <button
                  type="button"
                  onClick={() => {
                    if (!needsInput) run(def, def.cmd);
                    else setOpenCmd(expanded ? null : k);
                  }}
                  className="w-full min-h-12 flex items-center gap-3 px-4 py-2 text-left active:bg-muted/60"
                >
                  <span className="flex-1 min-w-0">
                    <span className="block text-base leading-tight">{def.label}</span>
                    <span className="block font-mono text-[13px] text-muted-foreground truncate">{def.cmd}</span>
                  </span>
                  {needsInput ? (
                    <ChevronRight
                      className={cn("size-5 text-muted-foreground/70 transition-transform", expanded && "rotate-90")}
                      aria-hidden="true"
                    />
                  ) : (
                    <span className="text-xs font-score tracking-wide text-primary">Send</span>
                  )}
                </button>
                {expanded && (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      run(def, buildCommand(def, args, selects));
                    }}
                    className="px-4 pb-3 flex flex-col gap-2"
                  >
                    {def.args?.map((arg, i) => (
                      <input
                        key={arg.name}
                        type={arg.type ?? "text"}
                        inputMode={arg.type === "number" ? "numeric" : undefined}
                        placeholder={arg.placeholder}
                        value={args[arg.name] ?? ""}
                        onChange={(e) => setArgs((prev) => ({ ...prev, [arg.name]: e.target.value }))}
                        autoFocus={i === 0}
                        autoCapitalize="off"
                        autoCorrect="off"
                        spellCheck={false}
                        aria-label={arg.placeholder}
                        className="h-11 px-3 rounded-xl bg-input border border-border text-base text-foreground font-mono focus:outline-none focus:ring-2 focus:ring-ring/60"
                      />
                    ))}
                    {def.select?.map((sel) => (
                      <select
                        key={sel.name}
                        value={selectValueOf(sel, selects)}
                        onChange={(e) => setSelects((prev) => ({ ...prev, [sel.name]: e.target.value }))}
                        aria-label={sel.name}
                        className="h-11 px-3 rounded-xl bg-input border border-border text-base text-foreground focus:outline-none focus:ring-2 focus:ring-ring/60"
                      >
                        {sel.options.map((opt) => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                    ))}
                    <button
                      type="submit"
                      className="h-11 rounded-xl bg-primary text-primary-foreground font-score tracking-wide text-base active:bg-primary/80"
                    >
                      Run {def.cmd}
                    </button>
                  </form>
                )}
              </div>
            );
          })}
        </div>
      </BottomSheet>
      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(o) => !o && setPending(null)}
        title={pending?.def.confirm ?? ""}
        description={pending?.command}
        confirmLabel={pending?.def.label ?? "Run"}
        destructive
        onConfirm={() => {
          if (pending) onRun(pending.command);
          setPending(null);
          setOpenCmd(null);
        }}
      />
    </>
  );
}
