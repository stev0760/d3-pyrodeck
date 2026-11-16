import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { autostartLocked, autostartSummary, sentence, type AutostartInfo, type AutostartRun } from "@/lib/autostart";
import { formatTime, TONE_DOT } from "@/lib/supervisor";

/** "A", "A and B", "A, B and C". */
function listNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * Launch panel: which profiles start with Pyrodeck (several may), and what
 * the selected server's autostart did this run, crash-loop guard included.
 * Hidden while no profile starts with Pyrodeck and nothing happened. `run`
 * comes with the selected server's status poll; `info` (where the choice
 * comes from) is fetched by the panel.
 */
export function AutostartStatus({
  info,
  run,
  serverId,
  onChanged,
}: {
  info: AutostartInfo | null;
  run: AutostartRun | null;
  /** The selected server: its run is shown, and Cancel drops its retry. */
  serverId: string | null;
  onChanged: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const r = run ?? info?.run ?? null;
  const effective = info?.effective ?? null;
  const starting = info?.profiles ?? [];
  if (!r || (r.state === "off" && !effective && starting.length === 0)) return null;

  const summary = autostartSummary(r);
  const name = r.profileName ? `"${r.profileName}"` : "the profile";
  const count = `failure ${r.failures} of ${r.maxFailures}`;
  const fromEnv = info?.env !== null && info?.env !== undefined ? "PYRODECK_AUTOSTART_PROFILE" : info?.envList ? "PYRODECK_AUTOSTART_PROFILES" : null;
  const listedHere = starting.some((p) => p.profileId === serverId);

  const cancelRetry = async () => {
    setError(null);
    if (!serverId) return;
    const res = await fetch(`/api/servers/${encodeURIComponent(serverId)}/autostart/cancel`, { method: "POST", credentials: "include" });
    if (!res.ok) setError((await res.json().catch(() => ({}))).error ?? "Failed to cancel");
    onChanged();
  };

  let line: React.ReactNode = null;
  switch (r.state) {
    case "error":
      // The same error as the choice above: say it once.
      line =
        effective?.error === r.reason ? (
          <p>Nothing was started.</p>
        ) : (
          <p className="text-destructive break-words">Nothing was started: {r.reason}.</p>
        );
      break;
    case "skipped":
      line = <p className="break-words">Not started at startup: {r.reason}.</p>;
      break;
    case "launching":
      line = <p>Launching {name}{r.failures > 0 ? ` (${count} so far)` : ""}…</p>;
      break;
    case "retrying":
      line = (
        <div className="space-y-0.5">
          <p className="text-amber-400 break-words">
            {sentence(r.reason)} ({count}).
          </p>
          <div className="flex items-center justify-between gap-2">
            <span className="text-amber-400">Trying again at {r.nextAttemptAt ? formatTime(r.nextAttemptAt) : "?"}</span>
            <Button variant="outline" size="xs" onClick={() => void cancelRetry()} className="font-score tracking-wide">
              Cancel
            </Button>
          </div>
        </div>
      );
      break;
    case "watching":
      line = (
        <p>
          Started {name}; it counts as up once it runs past {r.watchUntil ? formatTime(r.watchUntil) : "?"}
          {r.failures > 0 ? ` (${count} so far)` : ""}.
        </p>
      );
      break;
    case "relaunching":
      line = (
        <p className="text-amber-400 break-words">
          {sentence(r.reason)} ({count}).{" "}
          {r.relaunchPending ? "The supervisor relaunches it." : "No relaunch is pending: launch it by hand."}
        </p>
      );
      break;
    case "started":
      line = (
        <p>
          Started {name} at startup{r.at ? `; up at ${formatTime(r.at)}` : ""} ({r.reason}).
        </p>
      );
      break;
    case "failed":
      line = (
        <p className="text-destructive break-words">
          Gave up{r.at ? ` at ${formatTime(r.at)}` : ""}: {r.reason}. Launch the server to start again.
        </p>
      );
      break;
    case "cancelled":
      line = <p className="break-words">Stopped watching{r.at ? ` at ${formatTime(r.at)}` : ""}: {r.reason}.</p>;
      break;
  }

  return (
    <>
      <Separator />
      <div className="space-y-1.5">
        <div className="w-full flex items-center justify-between gap-2">
          <span className="text-sm font-score tracking-wide text-muted-foreground">Autostart</span>
          <span className="flex items-center gap-1.5 min-w-0">
            <span className={`w-2 h-2 rounded-full shrink-0 ${TONE_DOT[summary.tone]}`} />
            <span className="text-[11px] text-muted-foreground truncate">{summary.text}</span>
          </span>
        </div>
        <div className="text-[11px] text-muted-foreground space-y-0.5">
          {starting.length > 0 ? (
            <p>
              Starts{" "}
              <span className="font-medium text-foreground/80">{listNames(starting.map((p) => p.profileName))}</span>{" "}
              when Pyrodeck starts
              {fromEnv ? (
                <>
                  {" "}(set by <span className="font-mono">{fromEnv}</span>)
                </>
              ) : (
                " (Edit → Start when Pyrodeck starts)"
              )}
              .{!listedHere && r.state === "off" ? " Not this server." : ""}
            </p>
          ) : effective?.error ? null : (
            <p>No profile starts with Pyrodeck now; this is what happened at startup.</p>
          )}
          {(info?.errors ?? (effective?.error ? [effective.error] : [])).map((e) => (
            <p key={e} className="text-destructive break-words">
              {sentence(e)}.
            </p>
          ))}
          {r.state !== "off" && line}
        </div>
        {error && <p className="text-[11px] text-destructive break-words">{error}</p>}
      </div>
    </>
  );
}

/**
 * Profile edit form: "Start when Pyrodeck starts". Several profiles may
 * start with Pyrodeck; locked while PYRODECK_AUTOSTART_PROFILE or
 * PYRODECK_AUTOSTART_PROFILES is set, since the environment wins.
 */
export function AutostartField({
  checked,
  onChange,
  info,
  profileId,
  profileNames,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  info: AutostartInfo | null;
  profileId: string;
  profileNames: ReadonlyMap<string, string>;
}) {
  const env = info?.env ?? null;
  const envList = info?.envList ?? null;
  const locked = autostartLocked(info);
  const shown = locked ? (info?.profiles ?? []).some((p) => p.profileId === profileId) : checked;
  const others = (info?.settingProfileIds ?? (info?.settingProfileId ? [info.settingProfileId] : []))
    .filter((id) => id !== profileId)
    .map((id) => profileNames.get(id) ?? id);
  return (
    <div className="space-y-1 border-t border-border pt-2">
      <label className="flex items-center gap-2 text-xs text-foreground/80">
        <input
          type="checkbox"
          checked={shown}
          disabled={locked || !info}
          onChange={(e) => onChange(e.target.checked)}
        />
        Start when Pyrodeck starts
      </label>
      <p className="text-[10px] text-muted-foreground leading-snug">
        {locked ? (
          <>
            Locked: <span className="font-mono">{env !== null ? "PYRODECK_AUTOSTART_PROFILE" : "PYRODECK_AUTOSTART_PROFILES"}</span>{" "}
            is set to "{env ?? envList}" and wins over this setting{info?.effective?.error ? ` (${info.effective.error})` : ""}.
          </>
        ) : (
          <>
            Launches this profile's server when Pyrodeck starts, as its Start button does, unless it is already
            running. With Pyrodeck as a service, the game comes back after a reboot. Several profiles can start
            with Pyrodeck
            {others.length > 0 ? ` (also ticked: ${others.join(", ")})` : ""}. Takes effect the next time Pyrodeck
            starts.
          </>
        )}
      </p>
    </div>
  );
}
