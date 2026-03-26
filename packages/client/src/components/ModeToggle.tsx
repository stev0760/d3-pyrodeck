export type AppMode = "connect" | "launch";

interface ModeToggleProps {
  mode: AppMode;
  onChange: (mode: AppMode) => void;
}

export function ModeToggle({ mode, onChange }: ModeToggleProps) {
  return (
    <div className="flex bg-zinc-800 rounded p-0.5 mb-3">
      <button
        onClick={() => onChange("connect")}
        className={`flex-1 text-xs font-medium py-1.5 rounded transition-colors ${
          mode === "connect"
            ? "bg-zinc-700 text-amber-400"
            : "text-zinc-500 hover:text-zinc-300"
        }`}
      >
        Connect
      </button>
      <button
        onClick={() => onChange("launch")}
        className={`flex-1 text-xs font-medium py-1.5 rounded transition-colors ${
          mode === "launch"
            ? "bg-zinc-700 text-amber-400"
            : "text-zinc-500 hover:text-zinc-300"
        }`}
      >
        Launch
      </button>
    </div>
  );
}
