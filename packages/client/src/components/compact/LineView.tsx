import { useCallback, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { ArrowDown } from "lucide-react";
import type { LineBuffer, LineKind } from "@/lib/lineBuffer";
import { cn } from "@/lib/utils";

interface LineViewProps {
  buffer: LineBuffer;
  /** Which kinds to show; all by default. */
  kinds?: readonly LineKind[];
  /** Lines rendered at once; older ones come in on request. */
  window?: number;
  emptyText?: string;
  className?: string;
}

const KIND_CLASS: Record<LineKind, string> = {
  out: "text-foreground/85",
  err: "text-destructive",
  cmd: "text-primary",
  sys: "text-muted-foreground italic",
};

/**
 * Console text as wrapped monospace rows, following the tail while the
 * reader is at the bottom and offering a way back down once they scroll up.
 * A plain list, not a terminal: it reflows to any width, selects and copies
 * like text, and costs nothing when hidden.
 */
export function LineView({ buffer, kinds, window: windowSize = 500, emptyText = "Nothing yet.", className }: LineViewProps) {
  const subscribe = useCallback((cb: () => void) => buffer.subscribe(cb), [buffer]);
  const version = useSyncExternalStore(subscribe, () => buffer.version, () => 0);
  const [shown, setShown] = useState(windowSize);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const [behind, setBehind] = useState(0);
  const seenRef = useRef(version);

  const all = kinds ? buffer.lines().filter((l) => kinds.includes(l.kind)) : buffer.lines();
  const lines = all.length > shown ? all.slice(all.length - shown) : all;
  const hidden = all.length - lines.length;

  // Follow the tail when the reader is there; count what they miss otherwise.
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    if (atBottomRef.current) {
      el.scrollTop = el.scrollHeight;
      seenRef.current = version;
      if (behind) setBehind(0);
    } else if (version !== seenRef.current) {
      setBehind((b) => b + 1);
      seenRef.current = version;
    }
  }, [version, lines.length, behind]);

  const onScroll = () => {
    const el = scrollerRef.current;
    if (!el) return;
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
    const nowAtBottom = gap < 32;
    if (nowAtBottom && !atBottomRef.current) setBehind(0);
    atBottomRef.current = nowAtBottom;
  };

  const jumpToLatest = () => {
    const el = scrollerRef.current;
    if (!el) return;
    atBottomRef.current = true;
    el.scrollTop = el.scrollHeight;
    setBehind(0);
  };

  return (
    <div className={cn("relative flex-1 min-h-0 flex flex-col", className)}>
      <div
        ref={scrollerRef}
        onScroll={onScroll}
        className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-3 py-2 font-mono text-[13px] leading-snug select-text"
      >
        {hidden > 0 && (
          <button
            type="button"
            onClick={() => setShown((s) => s + windowSize)}
            className="block w-full text-center text-xs text-muted-foreground py-2 mb-1 rounded-md bg-muted/40 active:bg-muted font-sans"
          >
            Show {Math.min(hidden, windowSize)} earlier lines ({hidden} more)
          </button>
        )}
        {all.length === 0 && <p className="text-sm text-muted-foreground font-sans py-2">{emptyText}</p>}
        {lines.map((line) => (
          <div key={line.id} className={cn("whitespace-pre-wrap break-words", KIND_CLASS[line.kind])}>
            {line.kind === "cmd" ? `> ${line.text}` : line.text || " "}
          </div>
        ))}
      </div>
      {behind > 0 && (
        <button
          type="button"
          onClick={jumpToLatest}
          className="absolute bottom-3 right-3 flex items-center gap-1 rounded-full bg-primary text-primary-foreground px-3 h-9 text-sm font-score tracking-wide shadow-lg"
        >
          <ArrowDown className="size-4" aria-hidden="true" />
          {behind} new
        </button>
      )}
    </div>
  );
}
