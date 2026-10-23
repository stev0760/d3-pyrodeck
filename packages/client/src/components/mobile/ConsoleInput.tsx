import { useRef, useState, type FormEvent } from "react";
import { Send, Terminal, History } from "lucide-react";
import { searchCommands, hasInputs, type CommandDef } from "@/lib/commands";
import { cn } from "@/lib/utils";

export interface QuickCommand {
  cmd: string;
  label: string;
}

interface ConsoleInputProps {
  onSend: (command: string) => void;
  /** Most recent first. */
  history: readonly string[];
  /** Read-only queries safe to send with one tap. */
  favorites: readonly QuickCommand[];
  hasFeature: (feature: string) => boolean;
  onOpenCommands: () => void;
  disabled?: boolean;
}

/**
 * The console's keyboard: a text field with Send, a row of chips above it
 * (favourites and recent commands while the field is empty, matching
 * commands while a `$` word is being typed), and a way into the command sheet.
 */
export function ConsoleInput({ onSend, history, favorites, hasFeature, onOpenCommands, disabled = false }: ConsoleInputProps) {
  const [value, setValue] = useState("");
  const [showHistory, setShowHistory] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    const cmd = value.trim();
    if (!cmd || disabled) return;
    onSend(cmd);
    setValue("");
    inputRef.current?.focus();
  };

  const fill = (text: string) => {
    setValue(text);
    setShowHistory(false);
    inputRef.current?.focus();
  };

  const typingCommand = value.trim().startsWith("$") && !value.includes(" ");
  const matches = typingCommand ? searchCommands(value.trim(), hasFeature) : [];
  const recent = history.slice(0, 6);

  const pick = (def: CommandDef) => {
    if (hasInputs(def)) fill(`${def.cmd} `);
    else {
      onSend(def.cmd);
      setValue("");
    }
  };

  return (
    <div className="shrink-0 border-t border-border bg-card">
      {/* Chips */}
      <div className="flex gap-2 overflow-x-auto px-3 pt-2 pb-1 no-scrollbar" aria-label="Suggestions">
        {typingCommand && matches.length > 0
          ? matches.map(({ def }) => (
              <Chip key={`${def.cmd} ${def.label}`} onClick={() => pick(def)} mono>
                {def.cmd}
              </Chip>
            ))
          : showHistory && recent.length > 0
            ? recent.map((cmd) => (
                <Chip key={cmd} onClick={() => fill(cmd)} mono>
                  {cmd}
                </Chip>
              ))
            : value.trim() === "" &&
              favorites.map((f) => (
                <Chip key={f.cmd} onClick={() => onSend(f.cmd)}>
                  {f.label}
                </Chip>
              ))}
      </div>
      <form onSubmit={submit} className="flex items-center gap-2 px-3 pb-2">
        <button
          type="button"
          onClick={onOpenCommands}
          aria-label="Commands"
          className="size-11 shrink-0 flex items-center justify-center rounded-xl bg-muted text-muted-foreground active:bg-muted/70"
        >
          <Terminal className="size-5" />
        </button>
        {history.length > 0 && (
          <button
            type="button"
            onClick={() => setShowHistory((s) => !s)}
            aria-label="Recent commands"
            aria-pressed={showHistory}
            className={cn(
              "size-11 shrink-0 flex items-center justify-center rounded-xl active:bg-muted/70",
              showHistory ? "bg-secondary text-primary" : "bg-muted text-muted-foreground",
            )}
          >
            <History className="size-5" />
          </button>
        )}
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Command, e.g. $scores"
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="send"
          disabled={disabled}
          aria-label="Console command"
          className="flex-1 min-w-0 h-11 px-3 rounded-xl bg-input border border-border font-mono text-base text-foreground placeholder:text-muted-foreground placeholder:font-sans focus:outline-none focus:ring-2 focus:ring-ring/60"
        />
        <button
          type="submit"
          disabled={disabled || value.trim() === ""}
          aria-label="Send"
          className="size-11 shrink-0 flex items-center justify-center rounded-xl bg-primary text-primary-foreground disabled:opacity-40 active:bg-primary/80"
        >
          <Send className="size-5" />
        </button>
      </form>
    </div>
  );
}

function Chip({ children, onClick, mono = false }: { children: string; onClick: () => void; mono?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "shrink-0 h-8 px-3 rounded-full bg-muted text-sm text-foreground/90 active:bg-secondary whitespace-nowrap",
        mono && "font-mono text-[13px]",
      )}
    >
      {children}
    </button>
  );
}
