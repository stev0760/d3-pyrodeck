import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import {
  getJson,
  sendJson,
  shortTime,
  type PlayerRules,
  type PlayerSettings,
  type RulesState,
  query,
} from "@/lib/players";
import { useSession } from "@/session/SessionProvider";

const inputClass =
  "bg-input border border-border rounded-md px-2 py-1 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring";

interface LookupState {
  settings: PlayerSettings;
  lookup: { profileId: string | null; used: number; unlimited: boolean | null };
}

function NumberField({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (n: number) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-xs">
      <input
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className={`${inputClass} w-16 font-mono`}
      />
      {label}
    </label>
  );
}

/**
 * Nickname rules, the profanity monitor and the address lookup setting
 * (server: routes/playerRules.ts, routes/players.ts). The rules are every
 * server's; the lookup count, the offenders and Forgive are the selected
 * server's.
 */
export function RulesPanel({ notify }: { notify: (message: string, type?: "error" | "info") => void }) {
  const { eventProfileId, serverName } = useSession();
  const [state, setState] = useState<RulesState | null>(null);
  const [draft, setDraft] = useState<PlayerRules | null>(null);
  const [words, setWords] = useState("");
  const [lookup, setLookup] = useState<LookupState | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const [rules, players] = await Promise.all([
        getJson<RulesState>(`/api/players/rules${query({ profileId: eventProfileId })}`),
        getJson<LookupState>(`/api/players/settings${query({ profileId: eventProfileId })}`),
      ]);
      setState(rules);
      setDraft(rules.rules);
      setWords(rules.rules.profanity.words.join("\n"));
      setLookup(players);
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err));
    }
  }, [notify, eventProfileId]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    if (!draft || !lookup) return;
    setSaving(true);
    try {
      await sendJson("PUT", "/api/players/rules", {
        nickname: draft.nickname,
        profanity: { ...draft.profanity, words: words.split("\n") },
      });
      await sendJson("PUT", "/api/players/settings", {
        ipLookup: lookup.settings.ipLookup,
        ipLookupBudget: lookup.settings.ipLookupBudget,
      });
      notify("Rules saved.", "info");
      await load();
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  if (!state || !draft || !lookup) return <p className="text-sm text-muted-foreground font-score">Loading rules...</p>;
  const recent = state.recent.filter((a) => !eventProfileId || a.profileId === eventProfileId);
  const nick = draft.nickname;
  const prof = draft.profanity;
  const setNick = (patch: Partial<typeof nick>) => setDraft({ ...draft, nickname: { ...nick, ...patch } });
  const setProf = (patch: Partial<typeof prof>) => setDraft({ ...draft, profanity: { ...prof, ...patch } });
  const setLookupSetting = (patch: Partial<PlayerSettings>) =>
    setLookup({ ...lookup, settings: { ...lookup.settings, ...patch } });

  return (
    <div className="h-full overflow-auto space-y-5 pr-1">
      <p className="text-[11px] text-muted-foreground">
        The rules apply to all servers. Lookups used, rule actions and profanity counts below are{" "}
        {serverName ? <span className="text-foreground/80">{serverName}</span> : "the selected server"}'s.
      </p>
      <section className="space-y-2">
        <h2 className="text-sm font-score tracking-wide">Nickname rules</h2>
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" checked={nick.enabled} onChange={(e) => setNick({ enabled: e.target.checked })} />
          Kick joining players whose name breaks a rule (the reason is said in chat first)
        </label>
        <div className={`space-y-1.5 pl-5 ${nick.enabled ? "" : "opacity-50"}`}>
          <label className="flex items-center gap-2 text-xs">
            <input type="checkbox" checked={nick.rejectEmpty} onChange={(e) => setNick({ rejectEmpty: e.target.checked })} />
            Empty or only spaces (INVALID NICKNAME)
          </label>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={nick.rejectPercent}
              onChange={(e) => setNick({ rejectPercent: e.target.checked })}
            />
            Contains % (INVALID NICKNAME; the server's mod code prints some names as format strings)
          </label>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={nick.rejectControl}
              onChange={(e) => setNick({ rejectControl: e.target.checked })}
            />
            Contains control characters (HACKED NICKNAME)
          </label>
          <NumberField
            label="Minimum length (0 = none)"
            value={nick.minLength}
            min={0}
            max={31}
            onChange={(n) => setNick({ minLength: n })}
          />
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-score tracking-wide">Profanity monitor</h2>
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" checked={prof.enabled} onChange={(e) => setProf({ enabled: e.target.checked })} />
          Watch general chat for the words below
        </label>
        <div className={`space-y-1.5 pl-5 ${prof.enabled ? "" : "opacity-50"}`}>
          <NumberField
            label="private warnings first"
            value={prof.warnings}
            min={0}
            max={10}
            onChange={(n) => setProf({ warnings: n })}
          />
          <NumberField label="kicks next" value={prof.kicks} min={0} max={10} onChange={(n) => setProf({ kicks: n })} />
          <label className="flex items-center gap-2 text-xs">
            <input type="checkbox" checked={prof.ban} onChange={(e) => setProf({ ban: e.target.checked })} />
            Then ban the name and the address (off: keep kicking)
          </label>
          <NumberField
            label="seconds after an action before another line counts"
            value={prof.cooldownSeconds}
            min={0}
            max={600}
            onChange={(n) => setProf({ cooldownSeconds: n })}
          />
          <p className="text-[11px] text-muted-foreground leading-snug">
            One word or phrase per line, matched as whole words without regard to case; a trailing * matches any ending.
            Counts are per player and reset when the server restarts. Team and private chat never reach the server
            console, so only general chat is watched. A chat line names its sender as the sender's game claims it.
          </p>
          <textarea
            value={words}
            onChange={(e) => setWords(e.target.value)}
            rows={8}
            className={`${inputClass} w-full max-w-md font-mono`}
            aria-label="Word list"
          />
          <Button
            variant="ghost"
            size="xs"
            onClick={() => setWords(state.defaultWords.join("\n"))}
            className="font-score"
          >
            Restore the default list
          </Button>
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-score tracking-wide">Addresses of joining players</h2>
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={lookup.settings.ipLookup}
            onChange={(e) => setLookupSetting({ ipLookup: e.target.checked })}
          />
          Look up each joining player's address with one $playerinfo
        </label>
        <div className="pl-5">
          <NumberField
            label="lookups per server run on servers other than Matcen 0.9.3+"
            value={lookup.settings.ipLookupBudget}
            min={0}
            max={30}
            onChange={(n) => setLookupSetting({ ipLookupBudget: n })}
          />
        </div>
        <p className="text-[11px] text-muted-foreground leading-snug">
          $playerinfo writes into a 16 KB text buffer that a dedicated server never empties (the same defect that made
          $netgameinfo crash servers); about 40 queries crash a retail server. Matcen 0.9.3 and later clear it every
          frame.{" "}
          {lookup.lookup.unlimited === true
            ? "This server does: no limit applies."
            : lookup.lookup.profileId
              ? `This server does not: ${lookup.lookup.used} of ${lookup.settings.ipLookupBudget} used this run.`
              : ""}
        </p>
      </section>

      <Button onClick={() => void save()} disabled={saving} className="font-score tracking-wide">
        {saving ? "Saving..." : "Save rules"}
      </Button>

      {(recent.length > 0 || state.offenders.length > 0) && (
        <section className="space-y-2">
          <h2 className="text-sm font-score tracking-wide">Recent rule actions</h2>
          <table className="w-full text-sm">
            <tbody>
              {recent.map((a, i) => (
                <tr key={i} className="border-b border-border/50">
                  <td className="py-1 font-mono text-xs whitespace-nowrap">{shortTime(a.time)}</td>
                  <td className="py-1 text-xs">{a.name}</td>
                  <td className="py-1 text-xs">
                    {a.rule}: {a.action}
                  </td>
                  <td className={`py-1 text-xs ${a.ok ? "text-muted-foreground" : "text-destructive"}`}>
                    {a.detail}
                    {a.ok ? "" : " (failed)"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {state.offenders.length > 0 && (
            <>
              <h3 className="text-xs font-score tracking-wide text-muted-foreground">Profanity counts this run</h3>
              {state.offenders.map((o) => (
                <div key={o.name} className="flex items-center gap-2 text-xs">
                  <span>{o.name}</span>
                  <span className="text-muted-foreground">
                    {o.offences} offence{o.offences === 1 ? "" : "s"}, last: {o.lastAction ?? "—"}
                  </span>
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() =>
                      void sendJson("POST", "/api/players/rules/forgive", { name: o.name, profileId: eventProfileId }).then(load, (err) =>
                        notify(err instanceof Error ? err.message : String(err)),
                      )
                    }
                  >
                    Forgive
                  </Button>
                </div>
              ))}
            </>
          )}
        </section>
      )}
    </div>
  );
}
