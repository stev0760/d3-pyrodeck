import { useState } from "react";
import { Bot, Plus, RefreshCw } from "lucide-react";
import { useSession } from "@/session/SessionProvider";
import type { HashRouter } from "@/hooks/useHashRoute";
import { useBots, cleanBotName, BOT_NAME_MAX, SHIPS, DIFFICULTIES } from "@/hooks/useBots";
import { usePopulation } from "@/hooks/usePopulation";
import { Screen } from "../Screen.tsx";
import { ShellStatus } from "../ShellStatus.tsx";
import { SectionCard } from "@/components/compact/SectionCard";
import { EmptyState } from "@/components/compact/EmptyState";
import { ListRow } from "@/components/compact/ListRow";
import { BottomSheet } from "@/components/compact/BottomSheet";
import { BigButton } from "@/components/compact/BigButton";
import { ConfirmDialog } from "@/components/compact/ConfirmDialog";
import { PopulationCard } from "@/components/compact/PopulationCard";
import { BotCards } from "@/components/compact/BotCards";

const SELECT = "h-11 px-3 rounded-xl bg-input border border-border text-base text-foreground focus:outline-none focus:ring-2 focus:ring-ring/60";

/** The bots in the game. */
export function BotsScreen({ router }: { router: HashRouter }) {
  const { isConnected, connection } = useSession();
  const hasBots = isConnected && connection.hasFeature("bots");

  if (!hasBots) {
    return (
      <Screen root title="Bots" actions={<ShellStatus />}>
        <EmptyState
          icon={<Bot />}
          title={isConnected ? "No bot support" : "Not connected"}
          hint={
            isConnected
              ? "This server does not run the Matcen bot commands."
              : "Bots appear once the console is connected to a Matcen server."
          }
        />
      </Screen>
    );
  }
  return <LiveBots router={router} />;
}

function LiveBots({ router }: { router: HashRouter }) {
  const { connection, mode } = useSession();
  const hasShips = connection.hasFeature("ships");
  const hasDifficulty = connection.hasFeature("difficulty");
  const hasTeams = connection.hasFeature("teams");
  const hasPopulation = connection.hasFeature("population");
  const bots = useBots({
    sendCommand: connection.sendCommand,
    onBots: connection.onBots,
    onBotStats: connection.onBotStats,
    onBotMode: connection.onBotMode,
    hasShips,
    hasDifficulty,
    hasTeams,
  });
  const population = usePopulation({
    sendCommand: connection.sendCommand,
    onBotPopulation: connection.onBotPopulation,
    enabled: hasPopulation,
  });

  const [addOpen, setAddOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newShip, setNewShip] = useState(SHIPS[0]);
  const [newDifficulty, setNewDifficulty] = useState("hotshot");
  const [newTeam, setNewTeam] = useState("");
  const [confirmRemoveAll, setConfirmRemoveAll] = useState(false);

  const submitAdd = () => {
    if (bots.addBot({ name: newName, ship: newShip, difficulty: newDifficulty, team: newTeam })) {
      setNewName("");
      setAddOpen(false);
    }
  };

  return (
    <Screen
      root
      title="Bots"
      actions={
        <>
          <button
            type="button"
            onClick={bots.refresh}
            aria-label="Refresh"
            className="size-10 flex items-center justify-center rounded-lg text-muted-foreground active:bg-muted/60"
          >
            <RefreshCw className="size-5" />
          </button>
          <button
            type="button"
            onClick={() => setAddOpen(true)}
            aria-label="Add bot"
            className="size-10 flex items-center justify-center rounded-lg text-primary active:bg-muted/60"
          >
            <Plus className="size-6" />
          </button>
          <ShellStatus />
        </>
      }
    >
      <div className="p-3 space-y-3">
        {hasPopulation && (
          <PopulationCard
            population={population.population}
            onManager={population.setManager}
            onTarget={population.setTarget}
            onReserve={population.setReserve}
          />
        )}

        <SectionCard flush title={`In the game (${bots.bots.length})`}>
          <BotCards
            bots={bots.bots}
            stats={bots.botStats}
            hasDifficulty={hasDifficulty}
            onSetDifficulty={bots.setDifficulty}
            onRemove={bots.removeBot}
          />
          <div className="px-4 pt-3">
            <BigButton variant="secondary" onClick={() => setAddOpen(true)}>
              Add a bot
            </BigButton>
          </div>
        </SectionCard>

        <SectionCard flush>
          {mode === "launch" && (
            <ListRow
              title="Startup roster"
              subtitle="Who joins at launch, and the population settings the next launch reads"
              chevron
              onClick={() => router.navigate(["more", "config"])}
            />
          )}
          {bots.bots.length > 0 && (
            <ListRow title="Remove all bots" destructive onClick={() => setConfirmRemoveAll(true)} />
          )}
        </SectionCard>
      </div>

      <BottomSheet open={addOpen} onOpenChange={setAddOpen} title="Add a bot">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submitAdd();
          }}
          className="flex flex-col gap-3"
        >
          <label className="flex flex-col gap-1">
            <span className="text-sm text-muted-foreground">Name (up to {BOT_NAME_MAX} characters, no spaces)</span>
            <input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(cleanBotName(e.target.value))}
              maxLength={BOT_NAME_MAX}
              placeholder="Reaper"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              className="h-11 px-3 rounded-xl bg-input border border-border text-base text-foreground focus:outline-none focus:ring-2 focus:ring-ring/60"
            />
          </label>
          {hasShips && (
            <label className="flex flex-col gap-1">
              <span className="text-sm text-muted-foreground">Ship</span>
              <select value={newShip} onChange={(e) => setNewShip(e.target.value)} className={SELECT}>
                {SHIPS.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>
          )}
          {hasShips && hasDifficulty && (
            <label className="flex flex-col gap-1">
              <span className="text-sm text-muted-foreground">Difficulty</span>
              <select value={newDifficulty} onChange={(e) => setNewDifficulty(e.target.value)} className={SELECT}>
                {DIFFICULTIES.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            </label>
          )}
          {bots.showTeam && (
            <label className="flex flex-col gap-1">
              <span className="text-sm text-muted-foreground">Team</span>
              <select value={newTeam} onChange={(e) => setNewTeam(e.target.value)} className={SELECT}>
                <option value="">auto</option>
                {Array.from({ length: Math.min(bots.teamCount, 4) }, (_, i) => (
                  <option key={i + 1} value={String(i + 1)}>
                    Team {i + 1}
                  </option>
                ))}
              </select>
            </label>
          )}
          <BigButton type="submit" disabled={!cleanBotName(newName)}>
            Add {cleanBotName(newName) || "bot"}
          </BigButton>
        </form>
      </BottomSheet>

      <ConfirmDialog
        open={confirmRemoveAll}
        onOpenChange={setConfirmRemoveAll}
        title="Remove every bot?"
        description="All bots leave the game. With the population manager on, it fills the seats again."
        confirmLabel="Remove all"
        destructive
        onConfirm={() => {
          bots.removeAll();
          setConfirmRemoveAll(false);
        }}
      />
    </Screen>
  );
}
