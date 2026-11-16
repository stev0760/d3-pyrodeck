import { Rocket, FileText, ListMusic, ScrollText, Ban, BookOpen, Settings, LogOut, Monitor } from "lucide-react";
import { useSession } from "@/session/SessionProvider";
import type { HashRouter } from "@/hooks/useHashRoute";
import { setLayoutOverride } from "@/hooks/useIsMobile";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Screen } from "../Screen.tsx";
import { ShellStatus } from "../ShellStatus.tsx";
import { SectionCard } from "@/components/compact/SectionCard";
import { ListRow } from "@/components/compact/ListRow";
import { LaunchPanel } from "@/components/LaunchPanel";
import { ConfigScreen } from "./ConfigScreen.tsx";
import { PlaylistEditor } from "@/components/PlaylistEditor";
import { LogsPanel } from "@/components/LogsPanel";
import { BansPanel } from "@/components/BansPanel";
import { RulesPanel } from "@/components/RulesPanel";
import { SettingsPanel } from "@/components/SettingsPanel";

interface MoreScreenProps {
  router: HashRouter;
  onLogout: () => void;
  showLogout: boolean;
}

/** Everything that is not a tab of its own, and the screens behind it. */
export function MoreScreen({ router, onLogout, showLogout }: MoreScreenProps) {
  const { mode, launcher, playlist, toast, connection, servers, serverId, serverName } = useSession();
  const sub = router.route.path[1];
  const back = () => router.back();
  const go = (...path: string[]) => router.navigate(["more", ...path]);

  switch (sub) {
    case "profiles":
      return (
        <Screen title="Profiles" onBack={back} actions={<ShellStatus />}>
          <div className="p-3">
            <LaunchPanel launcher={launcher} />
          </div>
        </Screen>
      );
    case "config":
      return <ConfigScreen router={router} />;
    case "playlists":
      return (
        <Screen title="Playlists" onBack={back} actions={<ShellStatus />}>
          <div className="p-3 min-h-full flex flex-col">
            <PlaylistEditor
              playlists={playlist.playlists}
              status={playlist.status}
              loading={playlist.loading}
              error={playlist.error}
              onCreatePlaylist={playlist.createPlaylist}
              onUpdatePlaylist={playlist.updatePlaylist}
              onDeletePlaylist={playlist.deletePlaylist}
              onActivate={(id) => void playlist.activatePlaylist(id)}
              onDeactivate={() => void playlist.deactivatePlaylist()}
              selectedProfileId={launcher.selectedProfileId || undefined}
              servers={servers}
              selectedServerId={serverId}
              serverName={serverName}
            />
          </div>
        </Screen>
      );
    case "logs":
      return (
        <Screen title="Logs" onBack={back} actions={<ShellStatus />}>
          <div className="p-3">
            <LogsPanel />
          </div>
        </Screen>
      );
    case "bans":
      return (
        <Screen title="Bans" onBack={back}>
          <div className="p-3">
            <BansPanel notify={toast.addToast} />
          </div>
        </Screen>
      );
    case "rules":
      return (
        <Screen title="Rules" onBack={back} actions={<ShellStatus />}>
          <div className="p-3">
            <RulesPanel notify={toast.addToast} />
          </div>
        </Screen>
      );
    case "settings":
      return (
        <Screen title="Settings" onBack={back}>
          <div className="p-3 space-y-3">
            <SectionCard title="Layout">
              <label className="flex items-center justify-between gap-3 min-h-10">
                <span className="flex items-center gap-3">
                  <Monitor className="size-5 text-muted-foreground" aria-hidden="true" />
                  <span>
                    <span className="block text-base">Use the desktop layout on this phone</span>
                    <span className="block text-sm text-muted-foreground">The full three-column panel. Switch back from Settings there.</span>
                  </span>
                </span>
                <Switch checked={false} onCheckedChange={(on) => setLayoutOverride(on ? "desktop" : "auto")} aria-label="Use the desktop layout" />
              </label>
            </SectionCard>
            <SettingsPanel notify={toast.addToast} showSessions={showLogout} />
          </div>
        </Screen>
      );
  }

  const caps = connection.capabilities;
  return (
    <Screen root title="More" actions={<ShellStatus />}>
      <div className="p-4 space-y-4">
        {mode === "launch" && (
          <SectionCard title={serverName ?? "Server"} flush>
            <ListRow icon={<Rocket />} title="Profiles" subtitle="Edit, create, import; supervisor, autostart, mission downloads" chevron onClick={() => go("profiles")} />
            <ListRow icon={<FileText />} title="Config" subtitle="Server config, bot roster, startup commands" chevron onClick={() => go("config")} />
            <ListRow icon={<ListMusic />} title="Playlists" subtitle="Mission rotations and voting" chevron onClick={() => go("playlists")} />
            <ListRow icon={<ScrollText />} title="Logs" subtitle="Server logs and retention" chevron onClick={() => go("logs")} />
          </SectionCard>
        )}
        <SectionCard title="Moderation" flush>
          <ListRow icon={<Ban />} title="Bans" subtitle="Addresses and names, all servers" chevron onClick={() => go("bans")} />
          <ListRow icon={<BookOpen />} title="Rules" subtitle="Nicknames and the profanity monitor" chevron onClick={() => go("rules")} />
        </SectionCard>
        <SectionCard title="Pyrodeck" flush>
          <ListRow icon={<Settings />} title="Settings" subtitle="Email alerts, priority, updates, layout; all servers" chevron onClick={() => go("settings")} />
          {showLogout && <ListRow icon={<LogOut />} title="Log out" onClick={onLogout} />}
        </SectionCard>
        <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground pb-2">
          <span>D3 Pyrodeck v{__APP_VERSION__}</span>
          {caps && caps.version > 0 && (
            <Badge variant="secondary" className="text-[10px]">
              {caps.fork} v{caps.forkVersion}
            </Badge>
          )}
        </div>
      </div>
    </Screen>
  );
}
