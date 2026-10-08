import { WEEKDAYS, type ProfileSchedule, type ScheduleEntry } from "@/lib/ops";

const INPUT_CLASS =
  "bg-input border border-border rounded-md px-1.5 py-1 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring";

export const EMPTY_SCHEDULE: ProfileSchedule = { enabled: false, windows: [], stopWaitMinutes: 15 };

/**
 * Weekly start/stop windows for one profile (profile edit form). Times are
 * the Pyrodeck machine's local time; an end at or before the start is the
 * next day.
 */
export function ScheduleFields({
  value,
  onChange,
  timeZone,
}: {
  value: ProfileSchedule;
  onChange: (v: ProfileSchedule) => void;
  timeZone: string | null;
}) {
  const set = (patch: Partial<ProfileSchedule>) => onChange({ ...value, ...patch });
  const setWindow = (i: number, patch: Partial<ProfileSchedule["windows"][number]>) =>
    set({ windows: value.windows.map((w, j) => (j === i ? { ...w, ...patch } : w)) });

  return (
    <div className="space-y-1.5 border-t border-border pt-2">
      <p className="text-sm font-score tracking-wide text-muted-foreground">Schedule</p>
      <label className="flex items-center gap-2 text-xs text-foreground/80">
        <input type="checkbox" checked={value.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
        Start and stop this server on a weekly schedule
      </label>
      {value.windows.map((w, i) => (
        <div key={i} className="flex items-center gap-1">
          <select
            value={w.day}
            onChange={(e) => setWindow(i, { day: Number(e.target.value) })}
            className={`${INPUT_CLASS} w-14`}
            aria-label="Day"
          >
            {WEEKDAYS.map((d, n) => (
              <option key={d} value={n}>
                {d}
              </option>
            ))}
          </select>
          <input
            type="time"
            value={w.start}
            onChange={(e) => setWindow(i, { start: e.target.value })}
            className={`${INPUT_CLASS} min-w-0 flex-1 font-mono`}
            aria-label="Start"
          />
          <span className="text-[10px] text-muted-foreground">to</span>
          <input
            type="time"
            value={w.end}
            onChange={(e) => setWindow(i, { end: e.target.value })}
            className={`${INPUT_CLASS} min-w-0 flex-1 font-mono`}
            aria-label="End"
          />
          <button
            onClick={() => set({ windows: value.windows.filter((_, j) => j !== i) })}
            className="text-muted-foreground hover:text-destructive px-1 text-sm"
            aria-label="Remove window"
          >
            &times;
          </button>
        </div>
      ))}
      <button
        onClick={() => set({ windows: [...value.windows, { day: 5, start: "20:00", end: "23:00" }] })}
        className="text-[11px] text-primary hover:underline"
      >
        + Add window
      </button>
      <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        At a window's end, wait up to
        <input
          type="number"
          min={0}
          max={240}
          value={value.stopWaitMinutes}
          onChange={(e) => set({ stopWaitMinutes: Number(e.target.value) })}
          className={`${INPUT_CLASS} w-14 font-mono`}
        />
        min for players to leave
      </label>
      <p className="text-[10px] text-muted-foreground leading-snug">
        At a window's start Pyrodeck launches this profile if no server is running. At its end it stops the server as
        soon as no player is on (bots don't count), and after the wait at the latest; players get one warning in chat.
        An end at or before the start runs past midnight. Times are the Pyrodeck machine's clock
        {timeZone ? ` (${timeZone})` : ""}.
      </p>
    </div>
  );
}

/** One line for the Launch panel: what the schedule does next for this profile. */
export function describeNextAction(entry: ScheduleEntry | undefined): string | null {
  if (!entry || !entry.enabled) return null;
  if (entry.pendingStop) return `Schedule: stopping when the last player leaves, by ${entry.pendingStop.deadlineLocal}`;
  if (!entry.next) return null;
  return `Schedule: next ${entry.next.action} ${entry.next.atLocal}`;
}
