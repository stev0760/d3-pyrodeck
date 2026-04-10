import { Button } from "@/components/ui/button";

export type AppMode = "connect" | "launch";

interface ModeToggleProps {
  mode: AppMode;
  onChange: (mode: AppMode) => void;
}

export function ModeToggle({ mode, onChange }: ModeToggleProps) {
  return (
    <div className="flex bg-muted rounded-lg p-0.5 mb-3">
      <Button
        variant={mode === "connect" ? "secondary" : "ghost"}
        size="xs"
        onClick={() => onChange("connect")}
        className={`flex-1 ${mode === "connect" ? "text-primary" : "text-muted-foreground"}`}
      >
        Connect
      </Button>
      <Button
        variant={mode === "launch" ? "secondary" : "ghost"}
        size="xs"
        onClick={() => onChange("launch")}
        className={`flex-1 ${mode === "launch" ? "text-primary" : "text-muted-foreground"}`}
      >
        Launch
      </Button>
    </div>
  );
}
