import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { getJson, sendJson, shortTime, type BansState } from "@/lib/players";

const inputClass =
  "bg-input border border-border rounded-md px-2 py-1 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring";

const SOURCE_TEXT: Record<BansState["hostsDeny"]["source"], string> = {
  setting: "set by hand",
  "server log": "where the last launched server said it reads it",
  default: "the server's default directory",
};

/**
 * hosts.deny (address bans the engine reads) and Pyrodeck's name bans
 * (server: routes/bans.ts).
 */
export function BansPanel({ notify }: { notify: (message: string, type?: "error" | "info") => void }) {
  const [state, setState] = useState<BansState | null>(null);
  const [entry, setEntry] = useState("");
  const [entryReason, setEntryReason] = useState("");
  const [pattern, setPattern] = useState("");
  const [patternReason, setPatternReason] = useState("");
  const [pathInput, setPathInput] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const s = await getJson<BansState>("/api/bans");
      setState(s);
      setPathInput(s.settings.hostsDenyPath ?? "");
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err));
    }
  }, [notify]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (fn: () => Promise<{ message?: string } | unknown>) => {
    setBusy(true);
    try {
      const result = (await fn()) as { message?: string };
      if (result?.message) notify(result.message, "info");
      await load();
      return true;
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const addEntry = async () => {
    if (await run(() => sendJson("POST", "/api/bans/hosts", { entry, reason: entryReason }))) {
      setEntry("");
      setEntryReason("");
    }
  };

  const addName = async () => {
    if (await run(() => sendJson("POST", "/api/bans/names", { pattern, reason: patternReason }))) {
      setPattern("");
      setPatternReason("");
    }
  };

  if (!state) return <p className="text-sm text-muted-foreground font-score">Loading bans...</p>;
  const deny = state.hostsDeny;
  const entries = deny.lines.filter((l) => l.entry);
  const ignored = deny.lines.filter((l) => l.error);

  return (
    <div className="@container h-full overflow-auto space-y-5 pr-1">
      <p className="text-[11px] text-muted-foreground">
        Bans apply to all servers: the name bans are checked on every server's joins, and after an edit of hosts.deny
        every server's console gets <span className="font-mono">$rehash</span>.
      </p>
      <section className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-score tracking-wide">Address bans (hosts.deny)</h2>
          <Button
            variant="secondary"
            size="xs"
            className="ml-auto font-score"
            disabled={busy}
            onClick={() => void run(() => sendJson("POST", "/api/bans/rehash"))}
          >
            Reload on server ($rehash)
          </Button>
        </div>
        <p className="text-[11px] text-muted-foreground leading-snug">
          The server refuses a joining player whose address matches a line here. It reads the file when a game starts
          and on <span className="font-mono">$rehash</span>, which Pyrodeck sends after every change
          {state.settings.rehashOnLevelStart ? " and at each level start" : ""}. Unlike the console's{" "}
          <span className="font-mono">$ban</span>, these survive restarts.
        </p>
        <p className="text-[11px] font-mono break-all">
          {deny.path} <span className="font-sans text-muted-foreground">({SOURCE_TEXT[deny.source]}{deny.exists ? "" : "; not created yet"})</span>
        </p>
        {state.consoleIsLocal === false && (
          <p className="text-[11px] text-amber-400">
            The open console is to another machine. This file is on the machine running Pyrodeck, so it does not apply to
            that server.
          </p>
        )}
        {deny.error && <p className="text-[11px] text-destructive">{deny.error}</p>}
        {deny.allow.exists && deny.allow.entries.length > 0 && (
          <p className="text-[11px] text-amber-400">
            hosts.allow lists {deny.allow.entries.join(", ")}: those addresses are let in even when hosts.deny matches.
          </p>
        )}

        <div className="flex flex-wrap gap-2">
          <input
            value={entry}
            onChange={(e) => setEntry(e.target.value)}
            placeholder="203.0.113.9, 203.0.113.* or 203.0.113.0/24"
            className={`${inputClass} font-mono w-full @sm:w-64`}
          />
          <input
            value={entryReason}
            onChange={(e) => setEntryReason(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && entry && void addEntry()}
            placeholder="Reason (kept by Pyrodeck)"
            className={`${inputClass} flex-1 min-w-40`}
          />
          <Button size="xs" disabled={busy || !entry.trim()} onClick={() => void addEntry()} className="font-score">
            Add
          </Button>
        </div>

        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs font-score tracking-wide text-muted-foreground border-b border-border">
              <th className="pb-1">Entry</th>
              <th className="pb-1">Reason</th>
              <th className="pb-1">Added</th>
              <th className="pb-1" />
            </tr>
          </thead>
          <tbody>
            {entries.length === 0 && (
              <tr>
                <td colSpan={4} className="py-2 text-xs text-muted-foreground">
                  No address bans.
                </td>
              </tr>
            )}
            {entries.map((l) => (
              <tr key={l.line} className="border-b border-border/50">
                <td className="py-1 font-mono text-xs">{l.entry}</td>
                <td className="py-1 text-xs">
                  {l.reason || <span className="text-muted-foreground">—</span>}
                  {l.name && <span className="text-muted-foreground"> ({l.name})</span>}
                </td>
                <td className="py-1 font-mono text-xs whitespace-nowrap">{l.addedAt ? shortTime(l.addedAt) : "by hand"}</td>
                <td className="py-1 text-right">
                  <Button
                    variant="ghost"
                    size="xs"
                    disabled={busy}
                    onClick={() => void run(() => sendJson("DELETE", `/api/bans/hosts/${encodeURIComponent(l.entry!)}`))}
                  >
                    Remove
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {ignored.length > 0 && (
          <div className="text-[11px] text-amber-400 space-y-0.5">
            <p>The server ignores these lines (kept as they are):</p>
            {ignored.map((l) => (
              <p key={l.line} className="font-mono">
                {l.line}: {JSON.stringify(l.text)} — {l.error}
              </p>
            ))}
          </div>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-score tracking-wide">Name bans</h2>
        <p className="text-[11px] text-muted-foreground leading-snug">
          The game has no name ban, so Pyrodeck kicks a joining player whose name matches, saying why first. Names match
          without regard to case; <span className="font-mono">Name*</span> matches every name starting with Name. A
          name is easy to borrow: ban the address too when you can.
        </p>
        <div className="flex flex-wrap gap-2">
          <input
            value={pattern}
            onChange={(e) => setPattern(e.target.value)}
            placeholder="Callsign or Prefix*"
            className={`${inputClass} w-full @sm:w-48`}
          />
          <input
            value={patternReason}
            onChange={(e) => setPatternReason(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && pattern && void addName()}
            placeholder="Reason, said in chat"
            className={`${inputClass} flex-1 min-w-40`}
          />
          <Button size="xs" disabled={busy || !pattern.trim()} onClick={() => void addName()} className="font-score">
            Add
          </Button>
        </div>
        <table className="w-full text-sm">
          <tbody>
            {state.nameBans.length === 0 && (
              <tr>
                <td className="py-2 text-xs text-muted-foreground">No name bans.</td>
              </tr>
            )}
            {state.nameBans.map((b) => (
              <tr key={b.id} className="border-b border-border/50">
                <td className="py-1 font-mono text-xs">{b.pattern}</td>
                <td className="py-1 text-xs">{b.reason || <span className="text-muted-foreground">—</span>}</td>
                <td className="py-1 font-mono text-xs whitespace-nowrap">{shortTime(b.createdAt)}</td>
                <td className="py-1 text-right">
                  <Button
                    variant="ghost"
                    size="xs"
                    disabled={busy}
                    onClick={() => void run(() => sendJson("DELETE", `/api/bans/names/${b.id}`))}
                  >
                    Remove
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-score tracking-wide">Settings</h2>
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={state.settings.rehashOnLevelStart}
            onChange={(e) =>
              void run(() => sendJson("PUT", "/api/bans/settings", { rehashOnLevelStart: e.target.checked }))
            }
          />
          Send $rehash at every level start
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            placeholder={state.detectedLocalDir ? `${state.detectedLocalDir}/netgames/hosts.deny` : "Default location"}
            className={`${inputClass} font-mono flex-1 min-w-0 @sm:min-w-64`}
          />
          <Button
            variant="secondary"
            size="xs"
            disabled={busy}
            onClick={() => void run(() => sendJson("PUT", "/api/bans/settings", { hostsDenyPath: pathInput.trim() || null }))}
            className="font-score"
          >
            Save path
          </Button>
        </div>
        <p className="text-[11px] text-muted-foreground leading-snug">
          Leave empty to use the file the server reads: <span className="font-mono">netgames/hosts.deny</span> in its
          writable directory (on Linux <span className="font-mono">~/.local/share/Outrage Entertainment/Descent 3</span>,
          on Windows <span className="font-mono">%APPDATA%\Outrage Entertainment\Descent 3</span>), as a launched server
          reports it. Retail 1.4/1.5 servers read the file in their install directory instead.
        </p>
      </section>
    </div>
  );
}
