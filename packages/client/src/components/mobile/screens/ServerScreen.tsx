import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { useSession } from "@/session/SessionProvider";
import type { HashRouter } from "@/hooks/useHashRoute";
import { Screen } from "../Screen.tsx";
import { ShellStatus, StatusDot, stateColor } from "../ShellStatus.tsx";
import { SegmentedControl } from "@/components/compact/SegmentedControl";
import { SectionCard } from "@/components/compact/SectionCard";
import { ListRow } from "@/components/compact/ListRow";
import { BigButton } from "@/components/compact/BigButton";
import { ConfirmDialog } from "@/components/compact/ConfirmDialog";
import { SavedServers } from "@/components/SavedServers";
import { ConnectionForm } from "@/components/ConnectionForm";
import { ServerSidebar } from "@/components/ServerSidebar";
import { ServerListRow } from "../ServerPicker.tsx";
import { launchRows, refusalLines, runningCount } from "@/lib/servers";

const MODE_OPTIONS = [
  { value: "connect", label: "Connect" },
  { value: "launch", label: "Launch" },
] as const;

/** The home screen: the servers, the one on screen, and the button that starts or stops it. */
export function ServerScreen({ router }: { router: HashRouter }) {
  const {
    mode,
    setMode,
    launcher,
    connection,
    serverInfo,
    playlist,
    isConnected,
    processState,
    servers,
    selectedServerId,
    selectServer,
    serverName,
  } = useSession();
  const [confirmStop, setConfirmStop] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [connectHost, setConnectHost] = useState("localhost");
  const [connectPort, setConnectPort] = useState(2092);

  const state = processState ?? "stopped";
  const active = state === "starting" || state === "running" || state === "stopping";
  const rows = launchRows(servers).filter((r) => r.kind === "profile" || r.state !== "stopped" || !!r.held);
  const running = runningCount(servers);
  const status = launcher.processStatus;
  const pid = status?.pid;
  const busy = !!selectedServerId && launcher.busy.has(selectedServerId);
  const refused =
    launcher.actionError && launcher.actionError.serverId === selectedServerId
      ? refusalLines(launcher.actionError.message)
      : null;

  const sidebarProps = {
    serverInfo: serverInfo.serverInfo,
    actions: {
      ...serverInfo,
      quitServer: mode === "launch" ? () => void launcher.stop(selectedServerId) : serverInfo.quitServer,
    },
    serverName,
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
            <SectionCard
              title="Servers"
              action={<span className="text-xs text-muted-foreground">{running === 0 ? "none running" : `${running} running`}</span>}
              flush
            >
              {rows.length === 0 && (
                <p className="px-4 py-3 text-sm text-muted-foreground">No servers yet. Create a profile under Manage profiles.</p>
              )}
              {rows.map((row) => (
                <ServerListRow key={row.id} row={row} selected={row.id === selectedServerId} onClick={() => selectServer(row.id)} />
              ))}
            </SectionCard>

            {selectedServerId && (
              <SectionCard title={serverName ?? "Server"} flush>
                <div className="px-4 py-2 flex items-center gap-2 flex-wrap">
                  <StatusDot className={stateColor(state)} />
                  <span className="font-score tracking-wide capitalize">{state}</span>
                  {pid && active && (
                    <Badge variant="secondary" className="text-[11px]">
                      PID {pid}
                    </Badge>
                  )}
                  {active && status?.adopted && (
                    <Badge variant="outline" className="text-[11px]">
                      Re-attached
                    </Badge>
                  )}
                  {state === "crashed" && status?.exitCode != null && (
                    <Badge variant="destructive" className="text-[11px]">
                      exit {status.exitCode}
                    </Badge>
                  )}
                </div>
                <div className="px-4 pt-1 pb-2">
                  {active ? (
                    <BigButton variant="destructive" onClick={() => setConfirmStop(true)} disabled={state === "stopping" || busy}>
                      {state === "stopping" ? "Stopping…" : `Stop ${serverName ?? "Server"}`}
                    </BigButton>
                  ) : (
                    <BigButton onClick={() => void launcher.launch(selectedServerId)} disabled={busy}>
                      {busy ? "Starting…" : `Launch ${serverName ?? "Server"}`}
                    </BigButton>
                  )}
                  {refused && (
                    <div className="mt-2 text-sm text-destructive space-y-1 break-words">
                      {refused.map((line) => (
                        <p key={line}>{line}</p>
                      ))}
                    </div>
                  )}
                  {status?.log?.state === "failed" && (
                    <p className="text-sm text-destructive mt-2">Log not being written. {status.log.message}</p>
                  )}
                </div>
                <ListRow
                  title="Manage profiles"
                  subtitle="Edit, create, import, supervisor, autostart"
                  chevron
                  onClick={() => router.navigate(["more", "profiles"])}
                />
              </SectionCard>
            )}

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

      <ConfirmDialog
        open={confirmStop}
        onOpenChange={setConfirmStop}
        title={`Stop ${serverName ?? "the server"}?`}
        description={`${serverName ?? "The server"} shuts down and everyone on it is disconnected. Other servers keep running.`}
        confirmLabel="Stop"
        destructive
        busy={stopping}
        onConfirm={async () => {
          setStopping(true);
          await launcher.stop(selectedServerId);
          setStopping(false);
          setConfirmStop(false);
        }}
      />
    </Screen>
  );
}
