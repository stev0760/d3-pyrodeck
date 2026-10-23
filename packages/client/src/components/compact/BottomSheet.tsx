import type { ReactNode } from "react";
import { Sheet, SheetContent, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

interface BottomSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
}

/**
 * A sheet that rises from the bottom of a phone screen: grab handle, title,
 * its own scrolling body, and the safe-area inset below. Built on the same
 * Dialog the desktop sheets use, so it closes on Escape and a tap outside.
 */
export function BottomSheet({ open, onOpenChange, title, description, children, className }: BottomSheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        showCloseButton={false}
        className={cn(
          "rounded-t-2xl border-t border-border bg-card text-card-foreground p-0 gap-0 max-h-[85dvh] flex flex-col",
          className,
        )}
      >
        <div className="flex justify-center pt-2 pb-1 shrink-0" aria-hidden="true">
          <div className="h-1 w-10 rounded-full bg-muted-foreground/40" />
        </div>
        <div className="px-4 pb-2 shrink-0">
          <SheetTitle className="font-score tracking-wide text-base">{title}</SheetTitle>
          {description ? (
            <SheetDescription className="mt-0.5">{description}</SheetDescription>
          ) : (
            <SheetDescription className="sr-only">{title}</SheetDescription>
          )}
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
          {children}
        </div>
      </SheetContent>
    </Sheet>
  );
}
