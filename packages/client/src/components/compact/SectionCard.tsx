import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface SectionCardProps {
  title?: ReactNode;
  /** A control on the title row's right. */
  action?: ReactNode;
  children: ReactNode;
  /** Remove the inner padding so list rows can run edge to edge. */
  flush?: boolean;
  className?: string;
}

/** A card with the panel's section heading style. */
export function SectionCard({ title, action, children, flush = false, className }: SectionCardProps) {
  return (
    <section className={cn("bg-card border border-border rounded-xl", flush ? "py-2" : "p-4", className)}>
      {(title || action) && (
        <div className={cn("flex items-center justify-between gap-2", flush ? "px-4 pb-1" : "mb-3")}>
          {title && (
            <h2 className="text-xs font-score tracking-wide uppercase text-muted-foreground truncate">{title}</h2>
          )}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}
