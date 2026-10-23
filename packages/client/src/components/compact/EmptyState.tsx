import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface EmptyStateProps {
  icon?: ReactNode;
  title: ReactNode;
  hint?: ReactNode;
  action?: ReactNode;
  className?: string;
}

/** What a screen shows when there is nothing to show yet. */
export function EmptyState({ icon, title, hint, action, className }: EmptyStateProps) {
  return (
    <div className={cn("flex-1 flex flex-col items-center justify-center text-center gap-2 p-8", className)}>
      {icon && <div className="text-muted-foreground/60 [&_svg]:size-10 mb-1">{icon}</div>}
      <p className="font-score tracking-wide text-muted-foreground">{title}</p>
      {hint && <p className="text-sm text-muted-foreground/80 max-w-xs">{hint}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
