import { Switch } from "@/components/ui/switch";
import { SectionCard } from "./SectionCard.tsx";
import { Stepper } from "./Stepper.tsx";
import type { BotPopulation } from "@/hooks/usePopulation";

interface PopulationCardProps {
  population: BotPopulation | null;
  onManager: (on: boolean) => void;
  onTarget: (n: number) => void;
  onReserve: (n: number) => void;
}

/**
 * The population manager as the server reports it: on or off, the player
 * count it keeps, the seats it leaves free, and who is in the game now.
 * Changes go to the live server; the roster file keeps the next launch's
 * values (the Config screen).
 */
export function PopulationCard({ population, onManager, onTarget, onReserve }: PopulationCardProps) {
  const p = population;
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
