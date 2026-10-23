import { useEffect, useState } from "react";
import { FileText, Bot, Ship, Terminal, FolderOpen } from "lucide-react";
import { useSession } from "@/session/SessionProvider";
import type { HashRouter } from "@/hooks/useHashRoute";
import { useCompanions, type ClassifiedGameFile } from "@/hooks/useCompanions";
import { Screen } from "../Screen.tsx";
import { RawFileScreen } from "./RawFileScreen.tsx";
import { SectionCard } from "@/components/compact/SectionCard";
import { ListRow } from "@/components/compact/ListRow";
import { SegmentedControl } from "@/components/compact/SegmentedControl";
import { BottomSheet } from "@/components/compact/BottomSheet";
import { BigButton } from "@/components/compact/BigButton";
import { ConfirmDialog } from "@/components/compact/ConfirmDialog";
import { EmptyState } from "@/components/compact/EmptyState";
import { RosterEditor } from "@/components/compact/RosterEditor";
import { ServerConfigForm } from "@/components/ServerConfigForm";

const VIEWS = [
  { value: "form", label: "Form" },
  { value: "raw", label: "Raw" },
] as const;

const TYPE_LABEL: Record<ClassifiedGameFile["type"], string> = {
  "server-config": "Server configs",
  "bot-roster": "Bot rosters",
  "ship-settings": "Ship settings",
  "startup-commands": "Startup commands",
  unknown: "Other files",
};

/**
 * The selected profile's configuration: the server config and its companion
 * files as a list, each opening to a form or the raw text.
 */
export function ConfigScreen({ router }: { router: HashRouter }) {
  const { launcher } = useSession();
  const profile = launcher.profiles.find((p) => p.id === launcher.selectedProfileId);
  const sub = router.route.path[2];

  if (!profile) {
    return (
      <Screen title="Config" onBack={router.back}>
        <EmptyState
          icon={<FileText />}
          title="No profile selected"
          hint="Pick a profile on the Server tab; its files are edited here."
        />
      </Screen>
    );
  }

  switch (sub) {
    case "server":
      return <ServerConfigScreen router={router} profileId={profile.id} configFile={profile.configFile} />;
    case "roster":
      return <RosterScreen router={router} profileId={profile.id} configFile={profile.configFile} />;
    case "raw":
      return (
        <RawFileScreen
          router={router}
          profileId={profile.id}
          filename={router.route.params.get("file") ?? undefined}
          hint={
            router.route.params.get("file") === "autoexec.dmfc"
              ? "One DMFC command per line, e.g. $killmsgfilter simple. Applied at the next launch. The lines between # pyrodeck: begin and # pyrodeck: end are the profile's Teams and Hoard settings, rewritten at every launch."
              : undefined
          }
        />
      );
    case "files":
      return <GameFilesScreen router={router} profileId={profile.id} />;
  }
  return <ConfigIndex router={router} profileId={profile.id} profileName={profile.name} configFile={profile.configFile} />;
}

function ConfigIndex({
  router,
  profileId,
  profileName,
  configFile,
}: {
  router: HashRouter;
  profileId: string;
  profileName: string;
  configFile: string;
}) {
  const c = useCompanions(profileId, configFile);
  const [rosterSheet, setRosterSheet] = useState<"create" | "link" | null>(null);
  const [rosterName, setRosterName] = useState("bots.cfg");
  const [rosterFiles, setRosterFiles] = useState<ClassifiedGameFile[]>([]);
  const [confirm, setConfirm] = useState<{ title: string; description: string; label: string; run: () => Promise<unknown> } | null>(null);
  const [busy, setBusy] = useState(false);
  const go = (...path: string[]) => router.navigate(["more", "config", ...path]);
  const raw = (file: string) => router.navigate(["more", "config", "raw"], { file });

  const { listGameFiles } = c;
  useEffect(() => {
    if (rosterSheet === "link") void listGameFiles().then((files) => setRosterFiles(files.filter((f) => f.type === "bot-roster")));
  }, [rosterSheet, listGameFiles]);

  const run = async () => {
    if (!confirm) return;
    setBusy(true);
    await confirm.run();
    setBusy(false);
    setConfirm(null);
  };

  const comp = c.companions;
  return (
    <Screen title="Config" onBack={router.back}>
      <div className="p-4 space-y-4">
        <p className="text-sm text-muted-foreground">
          <span className="text-foreground">{profileName}</span> · changes take effect after the server restarts.
        </p>
        {c.error && (
          <p className="text-sm text-destructive bg-destructive/10 border border-destructive/40 rounded-lg px-3 py-2 break-words">{c.error}</p>
        )}
        <SectionCard title="Server config" flush>
          <ListRow icon={<FileText />} title="Server config" subtitle={configFile} chevron onClick={() => go("server")} />
        </SectionCard>

        <SectionCard title="Companion files" flush>
          {comp?.botConfig ? (
            <ListRow
              icon={<Bot />}
              title="Bot roster"
              subtitle={comp.botConfig.exists ? comp.botConfig.filename : `${comp.botConfig.filename} (missing)`}
              chevron
              onClick={() => go("roster")}
            />
          ) : (
            <ListRow
              icon={<Bot />}
              title="Bot roster"
              subtitle="None linked: create the sample roster or link a file"
              chevron
              onClick={() => go("roster")}
            />
          )}
          {comp?.multiSettingsFile ? (
            <ListRow
              icon={<Ship />}
              title="Ship settings"
              subtitle={comp.multiSettingsFile.exists ? comp.multiSettingsFile.filename : `${comp.multiSettingsFile.filename} (missing)`}
              chevron
              disabled={!comp.multiSettingsFile.exists}
              onClick={() => raw(comp.multiSettingsFile!.filename)}
            />
          ) : (
            <ListRow
              icon={<Ship />}
              title="Ship settings"
              subtitle="Ship allow and ban rules (MultiSettingsFile). Tap to create."
              onClick={() =>
                setConfirm({
                  title: "Create ship settings?",
                  description: "companion.mps is created and the server config points at it.",
                  label: "Create",
                  run: () => c.createCompanionFile("companion.mps", "[multi settings file]\n", "MultiSettingsFile"),
                })
              }
            />
          )}
          {comp?.autoexec.exists ? (
            <ListRow icon={<Terminal />} title="Startup commands" subtitle="autoexec.dmfc" chevron onClick={() => raw("autoexec.dmfc")} />
          ) : (
            <ListRow
              icon={<Terminal />}
              title="Startup commands"
              subtitle="DMFC commands applied at launch (-autoexec). Tap to create."
              onClick={() =>
                setConfirm({
                  title: "Create autoexec.dmfc?",
                  description: "An empty startup command file in the game directory.",
                  label: "Create",
                  run: () => c.createCompanionFile("autoexec.dmfc", "", ""),
                })
              }
            />
          )}
        </SectionCard>

        <SectionCard flush>
          <ListRow icon={<FolderOpen />} title="All game files" subtitle="Every config file in the game directory" chevron onClick={() => go("files")} />
        </SectionCard>
      </div>

      <BottomSheet open={rosterSheet === "create"} onOpenChange={(o) => !o && setRosterSheet(null)} title="New bot roster">
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (await c.createRosterFromSample(rosterName.trim())) setRosterSheet(null);
          }}
          className="flex flex-col gap-3"
        >
          <p className="text-sm text-muted-foreground">Starts as the Matcen sample roster, with the population settings explained in the file.</p>
          <input
            value={rosterName}
            onChange={(e) => setRosterName(e.target.value)}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            aria-label="Roster file name"
            className="h-11 px-3 rounded-xl bg-input border border-border font-mono text-base text-foreground focus:outline-none focus:ring-2 focus:ring-ring/60"
          />
          <BigButton type="submit" disabled={!rosterName.trim()}>
            Create {rosterName.trim() || "the roster"}
          </BigButton>
        </form>
      </BottomSheet>
      <BottomSheet open={rosterSheet === "link"} onOpenChange={(o) => !o && setRosterSheet(null)} title="Link a roster">
        <div className="-mx-4">
          {rosterFiles.length === 0 && <p className="px-4 py-3 text-sm text-muted-foreground">No roster files in the game directory.</p>}
          {rosterFiles.map((f) => (
            <ListRow
              key={f.filename}
              title={f.filename}
              subtitle={f.meta.botCount ? `${f.meta.botCount} bots at start` : undefined}
              onClick={async () => {
                if (await c.linkCompanionFile(f.filename, "BotConfig")) setRosterSheet(null);
              }}
            />
          ))}
        </div>
      </BottomSheet>
      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(o) => !o && !busy && setConfirm(null)}
        title={confirm?.title ?? ""}
        description={confirm?.description}
        confirmLabel={confirm?.label ?? "OK"}
        busy={busy}
        onConfirm={run}
      />
    </Screen>
  );
}

function ServerConfigScreen({ router, profileId, configFile }: { router: HashRouter; profileId: string; configFile: string }) {
  const [view, setView] = useState<"form" | "raw">("form");
  if (view === "raw") {
    return <RawFileScreen router={{ ...router, back: () => setView("form") }} profileId={profileId} filename={configFile} />;
  }
  return (
    <Screen title="Server config" onBack={router.back}>
      <div className="p-3 space-y-3">
        <SegmentedControl value={view} options={VIEWS} onChange={setView} aria-label="Editor" />
        <div className="@container flex flex-col min-h-0">
          <ServerConfigForm profileId={profileId} onSaved={() => {}} />
        </div>
      </div>
    </Screen>
  );
}

function RosterScreen({ router, profileId, configFile }: { router: HashRouter; profileId: string; configFile: string }) {
  const c = useCompanions(profileId, configFile);
  const [view, setView] = useState<"form" | "raw">("form");
  const [sheet, setSheet] = useState<"create" | "link" | null>(null);
  const [rosterName, setRosterName] = useState("bots.cfg");
  const [rosterFiles, setRosterFiles] = useState<ClassifiedGameFile[]>([]);
  const [confirmUnlink, setConfirmUnlink] = useState(false);

  const { listGameFiles } = c;
  useEffect(() => {
    if (sheet === "link") void listGameFiles().then((files) => setRosterFiles(files.filter((f) => f.type === "bot-roster")));
  }, [sheet, listGameFiles]);

  const ref = c.companions?.botConfig ?? null;
  if (c.companions && (!ref || !ref.exists)) {
    return (
      <Screen title="Bot roster" onBack={router.back}>
        <div className="p-4 space-y-4">
          {ref && !ref.exists && (
            <p className="text-sm text-destructive">
              The server config names <span className="font-mono">{ref.filename}</span>, but the file is missing.
            </p>
          )}
          {c.error && <p className="text-sm text-destructive">{c.error}</p>}
          <SectionCard flush>
            <ListRow icon={<Bot />} title="Create the sample roster" subtitle="Reaper, Phantom, Viper and Shadow; the population manager keeping 12 players" chevron onClick={() => setSheet("create")} />
            <ListRow icon={<FolderOpen />} title="Link an existing roster" subtitle="A roster file already in the game directory" chevron onClick={() => setSheet("link")} />
          </SectionCard>
        </div>
        <BottomSheet open={sheet === "create"} onOpenChange={(o) => !o && setSheet(null)} title="New bot roster">
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const name = rosterName.trim() || ref?.filename || "bots.cfg";
              if (await c.createRosterFromSample(name)) setSheet(null);
            }}
            className="flex flex-col gap-3"
          >
            <input
              value={rosterName}
              onChange={(e) => setRosterName(e.target.value)}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              aria-label="Roster file name"
              className="h-11 px-3 rounded-xl bg-input border border-border font-mono text-base text-foreground focus:outline-none focus:ring-2 focus:ring-ring/60"
            />
            <BigButton type="submit">Create {rosterName.trim() || "the roster"}</BigButton>
          </form>
        </BottomSheet>
        <BottomSheet open={sheet === "link"} onOpenChange={(o) => !o && setSheet(null)} title="Link a roster">
          <div className="-mx-4">
            {rosterFiles.length === 0 && <p className="px-4 py-3 text-sm text-muted-foreground">No roster files in the game directory.</p>}
            {rosterFiles.map((f) => (
              <ListRow
                key={f.filename}
                title={f.filename}
                subtitle={f.meta.botCount ? `${f.meta.botCount} bots at start` : undefined}
                onClick={async () => {
                  if (await c.linkCompanionFile(f.filename, "BotConfig")) setSheet(null);
                }}
              />
            ))}
          </div>
        </BottomSheet>
      </Screen>
    );
  }

  if (view === "raw" && ref) {
    return <RawFileScreen router={{ ...router, back: () => setView("form") }} profileId={profileId} filename={ref.filename} />;
  }

  return (
    <Screen title="Bot roster" onBack={router.back}>
      <div className="p-3 space-y-3">
        <SegmentedControl value={view} options={VIEWS} onChange={setView} aria-label="Editor" />
        {c.companions ? (
          <div className="flex flex-col min-h-0">
            <RosterEditor profileId={profileId} onSaved={() => void c.refresh()} />
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Loading…</p>
        )}
        {ref && (
          <SectionCard flush>
            <ListRow
              title="Unlink this roster"
              subtitle={`The config stops naming ${ref.filename}; the file stays`}
              destructive
              onClick={() => setConfirmUnlink(true)}
            />
          </SectionCard>
        )}
      </div>
      <ConfirmDialog
        open={confirmUnlink}
        onOpenChange={setConfirmUnlink}
        title="Unlink the roster?"
        description={`BotConfig= is removed from ${configFile}. The next launch runs without bots from a roster; ${ref?.filename ?? "the file"} is kept.`}
        confirmLabel="Unlink"
        destructive
        onConfirm={async () => {
          await c.unlinkCompanion("BotConfig");
          setConfirmUnlink(false);
        }}
      />
    </Screen>
  );
}

function GameFilesScreen({ router, profileId }: { router: HashRouter; profileId: string }) {
  const { listGameFiles } = useCompanions(profileId, undefined);
  const [files, setFiles] = useState<ClassifiedGameFile[] | null>(null);
  useEffect(() => {
    void listGameFiles().then(setFiles);
  }, [listGameFiles]);

  const groups = (["server-config", "bot-roster", "ship-settings", "startup-commands", "unknown"] as const)
    .map((type) => ({ type, files: (files ?? []).filter((f) => f.type === type) }))
    .filter((g) => g.files.length > 0);

  return (
    <Screen title="Game files" onBack={router.back}>
      <div className="p-4 space-y-4">
        {files === null && <p className="text-sm text-muted-foreground">Reading the game directory…</p>}
        {files !== null && groups.length === 0 && <EmptyState title="No config files" hint="Nothing ending in .cfg, .mps or .dmfc in the game directory." />}
        {groups.map((g) => (
          <SectionCard key={g.type} title={TYPE_LABEL[g.type]} flush>
            {g.files.map((f) => (
              <ListRow
                key={f.filename}
                title={f.filename}
                subtitle={
                  f.type === "server-config"
                    ? [f.meta.gameName, f.meta.missionName].filter(Boolean).join(" · ") || undefined
                    : f.type === "bot-roster"
                      ? f.meta.botCount
                        ? `${f.meta.botCount} bots at start`
                        : undefined
                      : f.type === "startup-commands"
                        ? `${f.meta.commands ?? "?"} commands`
                        : undefined
                }
                chevron
                onClick={() => router.navigate(["more", "config", "raw"], { file: f.filename })}
              />
            ))}
          </SectionCard>
        ))}
      </div>
    </Screen>
  );
}
