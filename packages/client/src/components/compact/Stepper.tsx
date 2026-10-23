import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface StepperProps {
  label: string;
  value: number | string;
  onIncrement: () => void;
  onDecrement: () => void;
  min?: number;
  max?: number;
  suffix?: string;
  /** "sm" is the desktop sidebar's row; "lg" has thumb-sized buttons. */
  size?: "sm" | "lg";
  /** A second line under the label. */
  hint?: string;
  disabled?: boolean;
}

/** A labelled value with minus and plus buttons. */
export function Stepper({
  label,
  value,
  onIncrement,
  onDecrement,
  min,
  max,
  suffix,
  size = "sm",
  hint,
  disabled = false,
}: StepperProps) {
  const canDecrement = min === undefined || Number(value) > min;
  const canIncrement = max === undefined || Number(value) < max;
  const large = size === "lg";

  return (
    <div className={cn("flex items-center justify-between", large ? "py-2 gap-3" : "py-1.5")}>
      <span className={cn("min-w-0", large ? "flex flex-col" : "text-xs text-muted-foreground")}>
        <span className={large ? "text-base text-foreground" : undefined}>{label}</span>
        {large && hint && <span className="text-xs text-muted-foreground leading-snug">{hint}</span>}
      </span>
      <div className={cn("flex items-center shrink-0", large ? "gap-2" : "gap-1")}>
        <Button
          variant="secondary"
          size={large ? "icon-lg" : "icon-xs"}
          onClick={onDecrement}
          disabled={disabled || !canDecrement}
          aria-label={`${label} down`}
          className={large ? "size-11 rounded-xl text-lg" : undefined}
        >
          -
        </Button>
        <span
          className={cn(
            "text-foreground text-center font-mono tabular-nums",
            large ? "text-lg w-12" : "text-sm w-10",
          )}
        >
          {value}
          {suffix && <span className={cn("text-muted-foreground ml-0.5", large ? "text-xs" : "text-[10px]")}>{suffix}</span>}
        </span>
        <Button
          variant="secondary"
          size={large ? "icon-lg" : "icon-xs"}
          onClick={onIncrement}
          disabled={disabled || !canIncrement}
          aria-label={`${label} up`}
          className={large ? "size-11 rounded-xl text-lg" : undefined}
        >
          +
        </Button>
      </div>
    </div>
  );
}
