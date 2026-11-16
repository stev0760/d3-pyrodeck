import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { useSession } from "@/session/SessionProvider";
import type { HashRouter } from "@/hooks/useHashRoute";
import type { ServerProfile } from "@/hooks/useLauncher";
import { Screen } from "../Screen.tsx";
import { ShellStatus, StatusDot, stateColor } from "../ShellStatus.tsx";
import { SegmentedControl } from "@/components/compact/SegmentedControl";
import { SectionCard } from "@/components/compact/SectionCard";
import { ListRow } from "@/components/compact/ListRow";
import { BigButton } from "@/components/compact/BigButton";
import { BottomSheet } from "@/components/compact/BottomSheet";
import { ConfirmDialog } from "@/components/compact/ConfirmDialog";
import { SavedServers } from "@/components/SavedServers";
import { ConnectionForm } from "@/components/ConnectionForm";
import { ServerSidebar } from "@/components/ServerSidebar";

const MODE_OPTIONS = [
  { value: "connect", label: "Connect" },
  { value: "launch", label: "Launch" },
] as const;

function profilePaths(p: ServerProfile): string {
  const exe = p.executablePath ?? "";
  return exe ? exe.split(/[\\/]/).pop() ?? exe : p.configFile;
}

/** The home screen: what the server is doing and the one button that changes it. */
export function ServerScreen({ router }: { router: HashRouter }) {
  const { mode, setMode, launcher, connection, serverInfo, playlist, isConnected, processState } = useSession();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [connectHost, setConnectHost] = useState("localhost");
  const [connectPort, setConnectPort] = useState(2092);

  const state = processState ?? "stopped";
  const active = state === "starting" || state === "running" || state === "stopping";
  const selected = launcher.profiles.find((p) => p.id === launcher.selectedProfileId);
  const live = launcher.profiles.find((p) => p.id === launcher.processStatus?.activeProfileId);
  const selectedIsLive = active && !!live && !!selected && live.id === selected.id;
  const otherRunning = active && !!live && !!selected && live.id !== selected.id;
  const pid = launcher.processStatus?.pid;

  const sidebarProps = {
    serverInfo: serverInfo.serverInfo,
    actions: {
      ...serverInfo,
      quitServer: mode === "launch" ? () => void launcher.stop() : serverInfo.quitServer,
    },
    playlists: playlist.playlists,
    playlistStatus: playlist.status,
    onActivatePlaylist: (id: string) => void playlist.activatePlaylist(id),
    onDeactivatePlaylist: () => void playlist.deactivatePlaylist(),
    onResumePlaylist: () => void playlist.resumePlaylist(),
    className: "w-full border-l-0 border border-border rounded-xl bg-card",
  };

  return (
    <Screen root title="Server" actions={<ShellStatus />}>
      <div className="p-4 space-y-4">
        <SegmentedControl value={mode} options={MODE_OPTIONS} onChange={setMode} aria-label="Mode" />

        {mode === "launch" ? (
          <>
            <SectionCard title="Game server" flush>
              <ListRow
                title={selected?.name ?? "Choose a profile"}
                subtitle={selected ? profilePaths(selected) : "No profile selected"}
                chevron
                onClick={() => setPickerOpen(true)}
              />
              <div className="px-4 py-2 flex items-center gap-2 flex-wrap">
                <StatusDot className={stateColor(state)} />
                <span className="font-score tracking-wide capitalize">{state}</span>
                {pid && active && (
                  <Badge variant="secondary" className="text-[11px]">
                    PID {pid}
                  </Badge>
                )}
                {active && launcher.processStatus?.adopted && (
                  <Badge variant="outline" className="text-[11px]">
                    Re-attached
                  </Badge>
                )}
                {state === "crashed" && launcher.processStatus?.exitCode != null && (
                  <Badge variant="destructive" className="text-[11px]">
                    exit {launcher.processStatus.exitCode}
                  </Badge>
                )}
              </div>
              <div className="px-4 pt-1 pb-2">
                {selectedIsLive ? (
                  <BigButton variant="destructive" onClick={() => setConfirmStop(true)} disabled={state === "stopping"}>
                    {state === "stopping" ? "Stopping…" : "Stop Server"}
                  </BigButton>
                ) : (
                  <BigButton
                    onClick={() => selected && void launcher.launch(selected.id)}
                    disabled={!selected || active}
                  >
                    {state === "starting" ? "Starting…" : "Launch Server"}
                  </BigButton>
                )}
                {otherRunning && (
                  <p className="text-sm text-muted-foreground mt-2">
                    <span className="text-foreground/80">{live?.name}</span> is running. Stop it before launching this one.
                  </p>
                )}
                {launcher.processStatus?.log?.state === "failed" && (
                  <p className="text-sm text-destructive mt-2">
                    Log not being written. {launcher.processStatus.log.message}
                  </p>
                )}
              </div>
              <ListRow
                title="Manage profiles"
                subtitle="Edit, create, import, supervisor, autostart"
                chevron
                onClick={() => router.navigate(["more", "profiles"])}
              />
            </SectionCard>

            {isConnected && <ServerSidebar mode="launch" {...sidebarProps} />}
          </>
        ) : (
          <>
            <SectionCard title="Saved servers">
              <SavedServers
                onSelect={(host, port) => {
                  setConnectHost(host);
                  setConnectPort(port);
                }}
              />
            </SectionCard>
            <SectionCard title="Console">
              <ConnectionForm
                connectionState={connection.connectionState}
                capabilities={connection.capabilities}
                error={connection.error}
                onConnect={connection.connect}
                onDisconnect={connection.disconnect}
                initialHost={connectHost}
                initialPort={connectPort}
              />
            </SectionCard>
            {isConnected && <ServerSidebar mode="connect" {...sidebarProps} />}
          </>
        )}
      </div>

      <BottomSheet open={pickerOpen} onOpenChange={setPickerOpen} title="Profiles">
        <div className="-mx-4">
          {launcher.profiles.length === 0 && (
            <p className="px-4 py-3 text-sm text-muted-foreground">No profiles yet. Create one under Manage profiles.</p>
          )}
          {launcher.profiles.map((p) => (
            <ListRow
              key={p.id}
              title={p.name}
              subtitle={p.configFile}
              trailing={
                p.id === live?.id && active ? (
                  <span className="text-emerald-400 font-score tracking-wide text-xs">running</span>
                ) : p.id === selected?.id ? (
                  <span className="text-primary font-score tracking-wide text-xs">selected</span>
                ) : undefined
              }
              onClick={() => {
                launcher.setSelectedProfileId(p.id);
                setPickerOpen(false);
              }}
            />
          ))}
        </div>
      </BottomSheet>

      <ConfirmDialog
        open={confirmStop}
        onOpenChange={setConfirmStop}
        title="Stop the server?"
        description={`${live?.name ?? "The server"} shuts down and everyone on it is disconnected.`}
        confirmLabel="Stop"
        destructive
        busy={stopping}
        onConfirm={async () => {
          setStopping(true);
          await launcher.stop();
          setStopping(false);
          setConfirmStop(false);
        }}
      />
    </Screen>
  );
}
