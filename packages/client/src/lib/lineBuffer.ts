/**
 * A bounded store of console lines that outlives the components showing it.
 *
 * Both consoles (the telnet console and the game process output) arrive as
 * chunks that may split a line in the middle and, on a debug build, at
 * hundreds of lines a second. The buffer joins partial lines per kind, keeps
 * the last `max` lines, and tells subscribers once per animation frame (or
 * macrotask outside a browser), so it can sit above React without turning
 * every chunk into a render.
 *
 * `version` changes on every append; `useSyncExternalStore(subscribe, () =>
 * buffer.version)` is the way to read it from a component.
 */

export type LineKind = "out" | "err" | "cmd" | "sys";

export interface Line {
  id: number;
  kind: LineKind;
  text: string;
}

export class LineBuffer {
  private store: Line[] = [];
  private tails = new Map<LineKind, string>();
  private listeners = new Set<() => void>();
  private nextId = 1;
  private scheduled = false;
  /** Increments on every change; stable while nothing was appended. */
  version = 0;

  constructor(private readonly max = 2000) {}

  /** Append a chunk of text; a trailing partial line waits for its newline. */
  push(chunk: string, kind: LineKind = "out"): void {
    if (!chunk) return;
    const text = (this.tails.get(kind) ?? "") + chunk.replace(/\r\n?/g, "\n");
    const parts = text.split("\n");
    const tail = parts.pop() ?? "";
    for (const part of parts) this.append(kind, part);
    this.tails.set(kind, tail);
    if (parts.length > 0) this.notify();
  }

  /** Append one whole line (a typed command, a note from Pyrodeck). */
  line(text: string, kind: LineKind = "sys"): void {
    this.append(kind, text);
    this.notify();
  }

  /** Turn a kind's pending partial line into a line of its own. */
  flush(kind?: LineKind): void {
    const kinds = kind ? [kind] : [...this.tails.keys()];
    let changed = false;
    for (const k of kinds) {
      const tail = this.tails.get(k);
      if (tail) {
        this.append(k, tail);
        this.tails.set(k, "");
        changed = true;
      }
    }
    if (changed) this.notify();
  }

  /** The lines, oldest first. The array is replaced on every change, never mutated in place. */
  lines(): readonly Line[] {
    return this.store;
  }

  /** The text of the lines, for replaying into a terminal. */
  snapshot(kinds?: readonly LineKind[], eol = "\n"): string {
    const picked = kinds ? this.store.filter((l) => kinds.includes(l.kind)) : this.store;
    return picked.length === 0 ? "" : picked.map((l) => l.text).join(eol) + eol;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  clear(): void {
    this.store = [];
    this.tails.clear();
    this.notify();
  }

  private append(kind: LineKind, text: string): void {
    const next = this.store.length >= this.max ? this.store.slice(this.store.length - this.max + 1) : this.store.slice();
    next.push({ id: this.nextId++, kind, text });
    this.store = next;
  }

  private notify(): void {
    this.version += 1;
    if (this.scheduled) return;
    this.scheduled = true;
    const run = () => {
      this.scheduled = false;
      for (const listener of this.listeners) listener();
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
    else setTimeout(run, 0);
  }
}
