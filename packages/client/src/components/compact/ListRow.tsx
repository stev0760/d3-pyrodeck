import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

interface ListRowProps {
  icon?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  /** Text or a control on the right; a chevron is added with `chevron`. */
  trailing?: ReactNode;
  chevron?: boolean;
  onClick?: () => void;
  /** Render as a link instead of a button (hash routes). */
  href?: string;
  destructive?: boolean;
  disabled?: boolean;
  className?: string;
}

/**
 * One tappable row of a list: at least 48 px tall, a title with an optional
 * subtitle, something on the right. A button, a link, or plain content when
 * neither `onClick` nor `href` is given.
 */
export function ListRow({
  icon,
  title,
  subtitle,
  trailing,
  chevron = false,
  onClick,
  href,
  destructive = false,
  disabled = false,
  className,
}: ListRowProps) {
  const inner = (
    <>
      {icon && (
        <span className={cn("shrink-0 flex items-center justify-center size-6 [&_svg]:size-5", destructive ? "text-destructive" : "text-muted-foreground")}>
          {icon}
        </span>
      )}
      <span className="flex-1 min-w-0 flex flex-col">
        <span className={cn("text-base leading-tight truncate", destructive ? "text-destructive" : "text-foreground")}>{title}</span>
        {subtitle && <span className="text-sm text-muted-foreground leading-snug truncate">{subtitle}</span>}
      </span>
      {trailing && <span className="shrink-0 text-sm text-muted-foreground flex items-center">{trailing}</span>}
      {chevron && <ChevronRight className="shrink-0 size-5 text-muted-foreground/70" aria-hidden="true" />}
    </>
  );
  const classes = cn(
    "w-full min-h-12 flex items-center gap-3 px-4 py-2 text-left",
    (onClick || href) && !disabled && "active:bg-muted/60",
    disabled && "opacity-50",
    className,
  );
  if (href && !disabled) {
    return (
      <a href={href} className={classes} onClick={onClick}>
        {inner}
      </a>
    );
  }
  if (onClick) {
    return (
      <button type="button" className={classes} onClick={onClick} disabled={disabled}>
        {inner}
      </button>
    );
  }
  return <div className={classes}>{inner}</div>;
}
