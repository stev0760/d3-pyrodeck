import { useEffect, type ReactNode } from "react";
import { ChevronLeft } from "lucide-react";
import { cn } from "@/lib/utils";

interface ScreenProps {
  /** Shown in the header on stacked screens; always in the window title. */
  title: string;
  /** A tab's own screen: the wordmark instead of a back button. */
  root?: boolean;
  onBack?: () => void;
  /** Controls on the header's right. */
  actions?: ReactNode;
  /** Let the body scroll (default); off for screens with their own scroller. */
  scroll?: boolean;
  children: ReactNode;
  className?: string;
}

/**
 * One phone screen: a 48 px header under the status bar and a body that
 * fills the rest. Stacked screens get a back button and their title; tab
 * roots get the wordmark.
 */
export function Screen({ title, root = false, onBack, actions, scroll = true, children, className }: ScreenProps) {
  useEffect(() => {
    document.title = root ? "D3 Pyrodeck" : `${title} · D3 Pyrodeck`;
  }, [title, root]);

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <header className="shrink-0 bg-card border-b border-border pt-safe">
        <div className="h-12 flex items-center gap-1 pl-3 pr-3">
          {root ? (
            <h1 className="flex-1 min-w-0 truncate font-logo text-xl tracking-wide text-primary leading-none pt-0.5">
              D3 Pyrodeck
            </h1>
          ) : (
            <>
              <button
                type="button"
                onClick={onBack}
                aria-label="Back"
                className="size-10 -ml-2 flex items-center justify-center rounded-lg text-primary active:bg-muted/60"
              >
                <ChevronLeft className="size-7" />
              </button>
              <h1 className="flex-1 min-w-0 truncate font-score tracking-wide text-base text-foreground">{title}</h1>
            </>
          )}
          {actions && <div className="flex items-center gap-1 shrink-0">{actions}</div>}
        </div>
      </header>
      <div className={cn("flex-1 min-h-0 flex flex-col", scroll && "overflow-y-auto overscroll-contain", className)}>
        {children}
      </div>
    </div>
  );
}
