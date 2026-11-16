import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  getJson,
  query,
  shortTime,
  toLocalInput,
  type HistoryProfile,
  type HistoryRow,
  type NameIpEntry,
  type PlayerSession,
} from "@/lib/players";
import { useSession } from "@/session/SessionProvider";

type View = "history" | "who" | "addresses";

const inputClass =
  "bg-input border border-border rounded-md px-2 py-1 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring";

/**
 * Join/leave history per server profile, "who was on" between two times, and
 * the name/address index (server: routes/players.ts).
 */
export function PlayerHistory({ notify }: { notify: (message: string, type?: "error" | "info") => void }) {
  // Opens on the selected server's history; any server's can be picked.
  const { eventProfileId } = useSession();
  const [view, setView] = useState<View>("history");
  const [profiles, setProfiles] = useState<HistoryProfile[]>([]);
  const [profileId, setProfileId] = useState<string>("");
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<HistoryRow[]>([]);
  const [total, setTotal] = useState(0);
  const [sessions, setSessions] = useState<PlayerSession[]>([]);
  const [addresses, setAddresses] = useState<NameIpEntry[]>([]);
  const [from, setFrom] = useState(() => toLocalInput(new Date(Date.now() - 24 * 3600_000)));
  const [to, setTo] = useState(() => toLocalInput(new Date()));
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    getJson<{ active: string | null; profiles: HistoryProfile[] }>("/api/players/profiles")
      .then((d) => {
        setProfiles(d.profiles);
        const own = d.profiles.find((p) => p.profileId === eventProfileId)?.profileId;
        setProfileId((cur) => cur || own || d.active || d.profiles[0]?.profileId || "");
      })
      .catch((err) => notify(err instanceof Error ? err.message : String(err)));
  }, [notify, eventProfileId]);

  const load = useCallback(async () => {
    if (!profileId) return;
    setLoading(true);
    try {
      if (view === "history") {
        const d = await getJson<{ rows: HistoryRow[]; total: number }>(
          `/api/players/history${query({ profileId, q, limit: 300 })}`,
        );
        setRows(d.rows);
        setTotal(d.total);
      } else if (view === "who") {
        const d = await getJson<{ sessions: PlayerSession[] }>(
          `/api/players/sessions${query({
            profileId,
            q,
            from: from ? new Date(from).toISOString() : undefined,
            to: to ? new Date(to).toISOString() : undefined,
          })}`,
        );
        setSessions(d.sessions);
      } else {
        const d = await getJson<{ entries: NameIpEntry[] }>(`/api/players/addresses${query({ profileId, q })}`);
        setAddresses(d.entries);
      }
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [profileId, view, q, from, to, notify]);

  useEffect(() => {
    void load();
  }, [load]);

  const views: { id: View; label: string }[] = [
    { id: "history", label: "Joins & leaves" },
    { id: "who", label: "Who was on" },
    { id: "addresses", label: "Name ↔ address" },
  ];

  return (
    <div className="h-full flex flex-col gap-2 min-h-0">
      <div className="flex flex-wrap items-center gap-2">
        {views.map((v) => (
          <Button
            key={v.id}
            size="xs"
            variant={view === v.id ? "default" : "secondary"}
            onClick={() => setView(v.id)}
            className="font-score tracking-wide"
          >
            {v.label}
          </Button>
        ))}
        <select
          value={profileId}
          onChange={(e) => setProfileId(e.target.value)}
          className={`${inputClass} ml-auto max-w-48`}
          aria-label="Server"
        >
          {profiles.length === 0 && <option value="">No history yet</option>}
          {profiles.map((p) => (
            <option key={p.profileId} value={p.profileId}>
              {p.label} ({p.rows})
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search name or address"
          className={`${inputClass} flex-1 min-w-40`}
        />
        {view === "who" && (
          <>
            <input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} className={inputClass} />
            <span className="text-xs text-muted-foreground">to</span>
            <input type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} className={inputClass} />
          </>
        )}
        <Button variant="secondary" size="xs" onClick={() => void load()} disabled={loading} className="font-score">
          {loading ? "..." : "Refresh"}
        </Button>
      </div>

      <div className="flex-1 min-h-0 overflow-auto">
        {view === "history" && (
          <>
            <p className="text-[11px] text-muted-foreground mb-1">
              {total} matching row{total === 1 ? "" : "s"}
              {total > rows.length ? `, newest ${rows.length} shown` : ""}. Re-entering at a level start is not a new
              row.
            </p>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs font-score tracking-wide text-muted-foreground border-b border-border">
                  <th className="pb-1">Time</th>
                  <th className="pb-1">Event</th>
                  <th className="pb-1">Player</th>
                  <th className="pb-1 text-right">Slot</th>
                  <th className="pb-1">Address</th>
                  <th className="pb-1 hidden md:table-cell">Note</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className={`border-b border-border/50 ${r.bot ? "text-muted-foreground" : ""}`}>
                    <td className="py-1 font-mono text-xs whitespace-nowrap">{shortTime(r.time)}</td>
                    <td className="py-1 text-xs">{r.event === "join" ? "joined" : "left"}</td>
                    <td className="py-1">
                      <span className="flex items-center gap-1.5">
                        {r.name || <em className="text-muted-foreground">(empty)</em>}
                        {r.bot && (
                          <Badge variant="secondary" className="text-[10px] py-0 px-1">
                            BOT
                          </Badge>
                        )}
                      </span>
                    </td>
                    <td className="py-1 text-right font-mono text-xs">{r.slot ?? ""}</td>
                    <td className="py-1 font-mono text-xs">{r.ip ?? ""}</td>
                    <td className="py-1 text-xs text-muted-foreground hidden md:table-cell">{r.reason ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}

        {view === "who" && (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs font-score tracking-wide text-muted-foreground border-b border-border">
                <th className="pb-1">Player</th>
                <th className="pb-1">Address</th>
                <th className="pb-1">Joined</th>
                <th className="pb-1">Left</th>
                <th className="pb-1 hidden md:table-cell">How</th>
              </tr>
            </thead>
            <tbody>
              {sessions.length === 0 && (
                <tr>
                  <td colSpan={5} className="py-2 text-xs text-muted-foreground">
                    Nobody in that window.
                  </td>
                </tr>
              )}
              {sessions.map((s, i) => (
                <tr key={i} className={`border-b border-border/50 ${s.bot ? "text-muted-foreground" : ""}`}>
                  <td className="py-1">
                    {s.name || <em className="text-muted-foreground">(empty)</em>}
                    {s.bot && (
                      <Badge variant="secondary" className="ml-1.5 text-[10px] py-0 px-1">
                        BOT
                      </Badge>
                    )}
                  </td>
                  <td className="py-1 font-mono text-xs">{s.ip ?? ""}</td>
                  <td className="py-1 font-mono text-xs whitespace-nowrap">{shortTime(s.joinedAt)}</td>
                  <td className="py-1 font-mono text-xs whitespace-nowrap">{s.leftAt ? shortTime(s.leftAt) : "still on"}</td>
                  <td className="py-1 text-xs text-muted-foreground hidden md:table-cell">{s.reason ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {view === "addresses" && (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs font-score tracking-wide text-muted-foreground border-b border-border">
                <th className="pb-1">Name</th>
                <th className="pb-1">Address</th>
                <th className="pb-1 text-right">Sessions</th>
                <th className="pb-1">First seen</th>
                <th className="pb-1">Last seen</th>
              </tr>
            </thead>
            <tbody>
              {addresses.length === 0 && (
                <tr>
                  <td colSpan={5} className="py-2 text-xs text-muted-foreground">
                    No addresses recorded. Addresses come from one $playerinfo per player joining (Rules tab).
                  </td>
                </tr>
              )}
              {addresses.map((a) => (
                <tr key={`${a.name}|${a.ip}`} className="border-b border-border/50">
                  <td className="py-1">
                    <button className="hover:underline" onClick={() => setQ(a.name)}>
                      {a.name}
                    </button>
                  </td>
                  <td className="py-1 font-mono text-xs">
                    <button className="hover:underline" onClick={() => setQ(a.ip)}>
                      {a.ip}
                    </button>
                  </td>
                  <td className="py-1 text-right font-mono text-xs">{a.count}</td>
                  <td className="py-1 font-mono text-xs whitespace-nowrap">{shortTime(a.firstSeen)}</td>
                  <td className="py-1 font-mono text-xs whitespace-nowrap">{shortTime(a.lastSeen)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
