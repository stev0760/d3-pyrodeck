import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { autostartSummary, sentence, type AutostartInfo, type AutostartRun } from "@/lib/autostart";
import { formatTime, TONE_DOT } from "@/lib/supervisor";

/**
 * Launch panel: which profile starts with Pyrodeck, and what its autostart did
 * this run, crash-loop guard included. Hidden while no profile is set and
 * nothing happened. `run` comes with the launcher status poll; `info` (where
 * the choice comes from) is fetched by the panel.
 */
export function AutostartStatus({
  info,
  run,
  onChanged,
}: {
  info: AutostartInfo | null;
  run: AutostartRun | null;
  onChanged: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const r = run ?? info?.run ?? null;
  const effective = info?.effective ?? null;
  if (!r || (r.state === "off" && !effective)) return null;

  const summary = autostartSummary(r);
  const name = r.profileName ? `"${r.profileName}"` : "the profile";
  const count = `failure ${r.failures} of ${r.maxFailures}`;

  const cancelRetry = async () => {
    setError(null);
    const res = await fetch("/api/launcher/autostart/cancel", { method: "POST", credentials: "include" });
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
          {effective?.error ? (
            <p className="text-destructive break-words">{sentence(effective.error)}.</p>
          ) : effective ? (
            <p>
              Starts <span className="font-medium text-foreground/80">{effective.profileName}</span> when Pyrodeck starts
              {effective.source === "env" ? (
                <>
                  {" "}(set by <span className="font-mono">PYRODECK_AUTOSTART_PROFILE</span>)
                </>
              ) : (
                " (Edit → Start when Pyrodeck starts)"
              )}
              .
            </p>
          ) : (
            <p>No profile starts with Pyrodeck now; this is what happened at startup.</p>
          )}
          {line}
        </div>
        {error && <p className="text-[11px] text-destructive break-words">{error}</p>}
      </div>
    </>
  );
}

/**
 * Profile edit form: "Start when Pyrodeck starts". One profile at a time
 * (ticking this one replaces another); locked while PYRODECK_AUTOSTART_PROFILE
 * is set, since the environment wins.
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
  const locked = env !== null;
  const shown = locked ? info?.effective?.source === "env" && info.effective.profileId === profileId : checked;
  const replaced =
    !locked && checked && info?.settingProfileId && info.settingProfileId !== profileId
      ? profileNames.get(info.settingProfileId) ?? null
      : null;
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
            Locked: <span className="font-mono">PYRODECK_AUTOSTART_PROFILE</span> is set to "{env}" and wins over this
            setting{info?.effective?.error ? ` (${info.effective.error})` : ""}.
          </>
        ) : (
          <>
            Launches this profile when Pyrodeck starts, as the Launch button does, unless a server is already
            running. With Pyrodeck as a service, the game comes back after a reboot. One profile at a time
            {replaced ? `: this replaces "${replaced}"` : ""}. Takes effect the next time Pyrodeck starts.
          </>
        )}
      </p>
    </div>
  );
}
