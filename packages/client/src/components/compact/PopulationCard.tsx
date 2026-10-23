import { Switch } from "@/components/ui/switch";
import { SectionCard } from "./SectionCard.tsx";
import { Stepper } from "./Stepper.tsx";
import type { BotPopulation } from "@/hooks/usePopulation";

interface PopulationCardProps {
  population: BotPopulation | null;
  onManager: (on: boolean) => void;
  onTarget: (n: number) => void;
  onReserve: (n: number) => void;
  /** "phone": thumb-sized steppers in a section card; "desktop": the Bots tab's card style, small steppers side by side. */
  density?: "phone" | "desktop";
}

/**
 * The population manager as the server reports it: on or off, the player
 * count it keeps, the seats it leaves free, and who is in the game now.
 * Changes go to the live server; the roster file keeps the next launch's
 * values (the Config screen).
 */
export function PopulationCard({ population, onManager, onTarget, onReserve, density = "phone" }: PopulationCardProps) {
  const p = population;
  if (density === "desktop") return <DesktopPopulationCard population={p} onManager={onManager} onTarget={onTarget} onReserve={onReserve} />;
  return (
    <SectionCard
      title="Population"
      action={
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <span>{p ? (p.manager ? "Manager on" : "Manager off") : "…"}</span>
          <Switch
            checked={p?.manager ?? false}
            disabled={!p}
            onCheckedChange={onManager}
            aria-label="Population manager"
          />
        </label>
      }
    >
      {p ? (
        <>
          <p className="text-sm text-foreground/90 mb-1">
            <span className="font-mono tabular-nums">{p.humans}</span> human{p.humans === 1 ? "" : "s"} +{" "}
            <span className="font-mono tabular-nums">{p.bots}</span> bot{p.bots === 1 ? "" : "s"} in{" "}
            <span className="font-mono tabular-nums">
              {p.seatsUsed}/{p.seats}
            </span>{" "}
            seats · up to <span className="font-mono tabular-nums">{p.botLimit}</span> bots
          </p>
          <Stepper
            size="lg"
            label="Target players"
            hint="Humans plus bots kept in the game; 0 turns the manager off"
            value={p.target}
            min={0}
            max={32}
            onIncrement={() => onTarget(p.target + 1)}
            onDecrement={() => onTarget(p.target - 1)}
          />
          <Stepper
            size="lg"
            label="Reserved seats"
            hint="Always left free for humans"
            value={p.reserve}
            min={1}
            max={8}
            onIncrement={() => onReserve(p.reserve + 1)}
            onDecrement={() => onReserve(p.reserve - 1)}
          />
          {p.note && <p className="text-xs text-muted-foreground leading-snug mt-1 whitespace-pre-wrap">{p.note}</p>}
          <p className="text-[11px] text-muted-foreground mt-2">
            Live settings for this game. The next launch reads the roster file (Config → Bot roster).
          </p>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">Asking the server…</p>
      )}
    </SectionCard>
  );
}

/** The same controls in the desktop Bots tab's card style, between Add Bot and the bot table. */
function DesktopPopulationCard({ population: p, onManager, onTarget, onReserve }: Omit<PopulationCardProps, "density">) {
  return (
    <div className="bg-card border border-border rounded-lg p-3 mb-3">
      <div className="flex items-center justify-between mb-1">
        <h3 className="text-sm font-score tracking-wide text-muted-foreground">Population</h3>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>{p ? (p.manager ? "Manager on" : "Manager off") : "…"}</span>
          <Switch
            checked={p?.manager ?? false}
            disabled={!p}
            onCheckedChange={onManager}
            aria-label="Population manager"
            className="h-5 w-9 [&_[data-slot=switch-thumb]]:size-4 [&_[data-slot=switch-thumb]]:data-[state=checked]:translate-x-4"
          />
        </label>
      </div>
      {p ? (
        <>
          <p className="text-xs text-foreground/80 mb-1">
            <span className="font-mono tabular-nums">{p.humans}</span> human{p.humans === 1 ? "" : "s"} +{" "}
            <span className="font-mono tabular-nums">{p.bots}</span> bot{p.bots === 1 ? "" : "s"} in{" "}
            <span className="font-mono tabular-nums">
              {p.seatsUsed}/{p.seats}
            </span>{" "}
            seats · up to <span className="font-mono tabular-nums">{p.botLimit}</span> bots
          </p>
          <div className="grid grid-cols-2 gap-x-6">
            <Stepper
              label="Target players"
              value={p.target}
              min={0}
              max={32}
              onIncrement={() => onTarget(p.target + 1)}
              onDecrement={() => onTarget(p.target - 1)}
            />
            <Stepper
              label="Reserved seats"
              value={p.reserve}
              min={1}
              max={8}
              onIncrement={() => onReserve(p.reserve + 1)}
              onDecrement={() => onReserve(p.reserve - 1)}
            />
          </div>
          {p.note && <p className="text-[11px] text-muted-foreground leading-snug mt-1 whitespace-pre-wrap">{p.note}</p>}
          <p className="text-[10px] text-muted-foreground mt-1">
            Humans plus bots kept in the game (0 turns the manager off) and the seats always left free. Live for this
            game; the next launch reads the roster file (Config → Bot Roster).
          </p>
        </>
      ) : (
        <p className="text-xs text-muted-foreground">Asking the server…</p>
      )}
    </div>
  );
}
