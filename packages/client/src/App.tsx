import { useState, useEffect, useRef } from "react";
import { useAuth } from "./hooks/useAuth.ts";
import { useServerConnection } from "./hooks/useServerConnection.ts";
import { useToast } from "./hooks/useToast.ts";
import { useLauncher } from "./hooks/useLauncher.ts";
import { useServerInfo } from "./hooks/useServerInfo.ts";
import { LoginPage } from "./components/LoginPage.tsx";
import { SetupPage } from "./components/SetupPage.tsx";
import { ConnectionForm } from "./components/ConnectionForm.tsx";
import { SavedServers } from "./components/SavedServers.tsx";
import { Console } from "./components/Console.tsx";
import { PlayersPanel } from "./components/PlayersPanel.tsx";
import { BansPanel } from "./components/BansPanel.tsx";
import { RulesPanel } from "./components/RulesPanel.tsx";
import { BotPanel } from "./components/BotPanel.tsx";
import { ConfigEditor } from "./components/ConfigEditor.tsx";
import { CommandReference } from "./components/CommandReference.tsx";
import { ToastContainer } from "./components/ToastContainer.tsx";
import { ModeToggle, type AppMode } from "./components/ModeToggle.tsx";
import { LaunchPanel } from "./components/LaunchPanel.tsx";
import { ServerSidebar } from "./components/ServerSidebar.tsx";
import { ServerConsole } from "./components/ServerConsole.tsx";
import { PlaylistEditor } from "./components/PlaylistEditor.tsx";
import { LogsPanel } from "./components/LogsPanel.tsx";
import { SettingsPanel } from "./components/SettingsPanel.tsx";
import { UpdateBanner } from "./components/UpdateBanner.tsx";
import { usePlaylist } from "./hooks/usePlaylist.ts";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Menu, Server as ServerIcon, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

type Tab = "console" | "players" | "bots" | "config" | "server-output" | "playlists" | "logs" | "bans" | "rules" | "settings";

function Dashboard({ onLogout, showLogout }: { onLogout: () => void; showLogout: boolean }) {
  const {
    connectionState,
    capabilities,
    error,
    wsConnected,
    wsReconnecting,
    connect,
    disconnect,
    sendCommand,
    onOutput,
    onProcessOutput,
    onPlayers,
    onBots,
    onBotStats,
    onBotMode,
    onServerInfo,
    onLevelChanged,
    onPlaylistEvent,
    hasFeature,
  } = useServerConnection();

  const launcher = useLauncher();
  const { toasts, addToast, dismissToast } = useToast();
  const playlistHook = usePlaylist({ onPlaylistEvent, notify: addToast });
  const serverInfoHook = useServerInfo({
    sendCommand,
    onServerInfo,
    onLevelChanged,
    connected: connectionState === "ready",
  });
  const prevErrorRef = useRef<string | null>(null);

  // Surface server errors as toasts
  useEffect(() => {
    if (error && error !== prevErrorRef.current) {
      addToast(error);
    }
    prevErrorRef.current = error;
  }, [error, addToast]);

  // Surface launcher errors as toasts
  const prevLauncherErrorRef = useRef<string | null>(null);
  useEffect(() => {
    if (launcher.error && launcher.error !== prevLauncherErrorRef.current) {
      addToast(launcher.error);
    }
    prevLauncherErrorRef.current = launcher.error;
  }, [launcher.error, addToast]);

  const [mode, setMode] = useState<AppMode>(() => {
    return (localStorage.getItem("pyrodeck-mode") as AppMode) ?? "connect";
  });
  const [activeTab, setActiveTab] = useState<Tab>(() =>
    mode === "launch" ? "server-output" : "console"
  );
  const [connectHost, setConnectHost] = useState("localhost");
  const [connectPort, setConnectPort] = useState(2092);
  const [leftSheetOpen, setLeftSheetOpen] = useState(false);
  const [serverSheetOpen, setServerSheetOpen] = useState(false);

  const handleModeChange = (newMode: AppMode) => {
    setMode(newMode);
    localStorage.setItem("pyrodeck-mode", newMode);
    setActiveTab(newMode === "launch" ? "server-output" : "console");
  };

  const isConnected = connectionState === "ready" && wsConnected;
  const processState = launcher.processStatus?.state;

  // Auto-close the left panel sheet only when transitioning INTO an active state,
  // not on every change while already connected (which would close it when the
  // user deliberately opens it to, e.g., stop the server).
  const prevConnectionStateRef = useRef(connectionState);
  const prevProcessStateRef = useRef(processState);
  useEffect(() => {
    const justConnected = connectionState === "ready" && prevConnectionStateRef.current !== "ready";
    const justLaunched = processState === "running" && prevProcessStateRef.current === "starting";
    if (justConnected || justLaunched) {
      setLeftSheetOpen(false);
    }
    prevConnectionStateRef.current = connectionState;
    prevProcessStateRef.current = processState;
  }, [connectionState, processState]);
  const hasProcess = mode === "launch" && (
    processState === "starting" || processState === "running" ||
    processState === "stopping" || processState === "crashed"
  );

  // "primary" tabs stay inline; "more" tabs (Launch-only management screens)
  // collapse into a dropdown so the bar stays short and responsive.
  const tabs: { id: Tab; label: string; show: boolean; group: "primary" | "more" }[] = [
    { id: "server-output", label: "Output", show: mode === "launch", group: "primary" },
    { id: "console", label: "Console", show: true, group: "primary" },
    { id: "players", label: "Players", show: true, group: "primary" },
    { id: "bots", label: "Bots", show: isConnected && hasFeature("bots"), group: "primary" },
    { id: "config", label: "Config", show: mode === "launch", group: "more" },
    { id: "playlists", label: "Playlists", show: mode === "launch", group: "more" },
    { id: "logs", label: "Logs", show: mode === "launch", group: "more" },
    { id: "bans", label: "Bans", show: true, group: "more" },
    { id: "rules", label: "Rules", show: true, group: "more" },
    { id: "settings", label: "Settings", show: true, group: "more" },
  ];

  const handleServerSelect = (host: string, port: number) => {
    setConnectHost(host);
    setConnectPort(port);
  };

  // Keep activeTab valid when tabs change visibility
  const visibleTabs = tabs.filter((t) => t.show);
  const primaryTabs = visibleTabs.filter((t) => t.group === "primary");
  const moreTabs = visibleTabs.filter((t) => t.group === "more");
  const activeMoreTab = moreTabs.find((t) => t.id === activeTab);
  useEffect(() => {
    if (!visibleTabs.find((t) => t.id === activeTab)) {
      setActiveTab(visibleTabs[0]?.id ?? "console");
    }
  }, [visibleTabs, activeTab]);

  const serverSidebarProps = {
    mode,
    serverInfo: serverInfoHook.serverInfo,
    actions: {
      ...serverInfoHook,
      // In Launch mode, route through launcher.stop() so ProcessManager
      // knows the exit is intentional (state → "stopped" not "crashed").
      // In Connect mode, send raw quit since we don't own the process.
      quitServer: mode === "launch"
        ? () => { launcher.stop(); }
        : serverInfoHook.quitServer,
    },
    playlists: playlistHook.playlists,
    playlistStatus: playlistHook.status,
    onActivatePlaylist: (id: string) => playlistHook.activatePlaylist(id, launcher.selectedProfileId || undefined),
    onDeactivatePlaylist: playlistHook.deactivatePlaylist,
    onResumePlaylist: playlistHook.resumePlaylist,
  };

  const leftSidebarContent = (
    <>
      <ModeToggle mode={mode} onChange={handleModeChange} />
      {mode === "connect" ? (
        <>
          <SavedServers onSelect={handleServerSelect} />
          <ConnectionForm
            connectionState={connectionState}
            capabilities={capabilities}
            error={error}
            onConnect={connect}
            onDisconnect={disconnect}
            initialHost={connectHost}
            initialPort={connectPort}
          />
        </>
      ) : (
        <LaunchPanel launcher={launcher} />
      )}
    </>
  );

  return (
    <div className="h-screen bg-background text-foreground flex flex-col">
      {/* Header */}
      <header className="flex items-center justify-between px-4 py-2 border-b border-border bg-card shrink-0">
        <div className="flex items-center gap-3">
          {/* Hamburger — phone only (<md) */}
          <Button
            variant="ghost"
            size="icon-xs"
            className="md:hidden shrink-0"
            onClick={() => setLeftSheetOpen(true)}
          >
            <Menu />
            <span className="sr-only">Open panel</span>
          </Button>
          <h1 className="text-2xl font-logo tracking-wide text-primary">D3 Pyrodeck</h1>
          <span className="hidden sm:inline text-[10px] text-muted-foreground">v{__APP_VERSION__}</span>
          {capabilities && capabilities.version > 0 && (
            <Badge variant="secondary" className="hidden sm:inline-flex">
              {capabilities.fork} v{capabilities.forkVersion}
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-3">
          {/* Server sheet trigger — phone only (<md) */}
          {isConnected && (
            <Button
              variant="ghost"
              size="icon-xs"
              className="md:hidden"
              onClick={() => setServerSheetOpen(true)}
            >
              <ServerIcon />
              <span className="sr-only">Server controls</span>
            </Button>
          )}
          {isConnected && (
            <Badge
              variant={wsConnected ? "outline" : "destructive"}
              className="hidden md:inline-flex"
            >
              WS: {wsConnected ? "live" : "disconnected"}
            </Badge>
          )}
          {showLogout && (
            <Button variant="ghost" size="xs" onClick={onLogout} className="font-menu tracking-wide text-sm text-muted-foreground border border-border/60">
              Logout
            </Button>
          )}
        </div>
      </header>

      {/* Compact top bar — tablet only (md, not lg+) */}
      <div className="hidden md:flex lg:hidden items-center gap-3 px-3 py-2 border-b border-border bg-sidebar shrink-0">
        <ModeToggle mode={mode} onChange={handleModeChange} />
        <div className="flex flex-1 items-center gap-2 min-w-0">
          {mode === "connect" && isConnected && (
            <Badge variant="outline" className="text-xs shrink-0">Connected</Badge>
          )}
          {mode === "connect" && !isConnected && (
            <span className="text-xs text-muted-foreground">Not connected</span>
          )}
          {mode === "launch" && processState && (
            <Badge
              variant={processState === "running" ? "outline" : "secondary"}
              className="text-xs capitalize shrink-0"
            >
              {processState}
            </Badge>
          )}
        </div>
        <Button variant="secondary" size="xs" className="shrink-0" onClick={() => setLeftSheetOpen(true)}>
          Panel
        </Button>
      </div>

      <UpdateBanner />

      {/* Reconnection banner */}
      {wsReconnecting && (
        <div className="px-4 py-2 bg-primary/10 border-b border-primary/30 text-primary text-sm text-center shrink-0">
          Connection lost — Reconnecting...
        </div>
      )}

      <div className="flex flex-1 min-h-0">
        {/* Left sidebar — desktop only (lg+) */}
        <aside className="hidden lg:flex w-72 shrink-0 border-r border-border bg-sidebar p-3 overflow-y-auto flex-col">
          {leftSidebarContent}
        </aside>

        {/* Center content */}
        <Tabs
          value={activeTab}
          onValueChange={(v) => setActiveTab(v as Tab)}
          className="flex-1 min-w-0 gap-0"
        >
          <TabsList
            variant="line"
            className="w-full justify-start px-2 border-b border-border rounded-none h-10 flex-nowrap gap-0"
          >
            {primaryTabs.map((tab) => (
              <TabsTrigger key={tab.id} value={tab.id} className="shrink-0 font-score tracking-wide">
                {tab.label}
              </TabsTrigger>
            ))}
            {moreTabs.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger
                  className={cn(
                    "ml-auto shrink-0 inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-sm font-score tracking-wide whitespace-nowrap transition-colors outline-none",
                    "focus-visible:ring-[3px] focus-visible:ring-ring/50",
                    activeMoreTab
                      ? "text-foreground"
                      : "text-foreground/60 hover:text-foreground",
                  )}
                >
                  {activeMoreTab ? activeMoreTab.label : "More"}
                  <ChevronDown className="size-4" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {moreTabs.map((tab) => (
                    <DropdownMenuItem
                      key={tab.id}
                      active={tab.id === activeTab}
                      onSelect={() => setActiveTab(tab.id)}
                      className="font-score tracking-wide"
                    >
                      {tab.label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </TabsList>

          <TabsContent value="server-output" className="p-3 min-h-0">
            {hasProcess ? (
              <ServerConsole onProcessOutput={onProcessOutput} />
            ) : (
              <div className="h-full flex items-center justify-center">
                <p className="text-muted-foreground text-lg font-score tracking-wide">
                  Launch a Descent 3 server to see output here
                </p>
              </div>
            )}
          </TabsContent>

          <TabsContent value="console" className="p-3 min-h-0">
            {isConnected ? (
              <div className="h-full flex flex-col">
                <div className="flex-1 min-h-0">
                  <Console onCommand={sendCommand} onOutput={onOutput} />
                </div>
                <CommandReference
                  sendCommand={sendCommand}
                  hasFeature={hasFeature}
                />
              </div>
            ) : (
              <div className="h-full flex items-center justify-center">
                <p className="text-muted-foreground text-lg font-score tracking-wide">
                  {mode === "connect"
                    ? "Connect to a Descent 3 server to get started"
                    : "Launch a Descent 3 server to get started"}
                </p>
              </div>
            )}
          </TabsContent>

          <TabsContent value="players" className="p-3 min-h-0">
            <PlayersPanel connected={isConnected} sendCommand={sendCommand} onPlayers={onPlayers} notify={addToast} />
          </TabsContent>

          <TabsContent value="bots" className="p-3 min-h-0">
            {isConnected && (
              <BotPanel
                sendCommand={sendCommand}
                onBots={onBots}
                onBotStats={onBotStats}
                onBotMode={onBotMode}
                hasShips={hasFeature("ships")}
                hasDifficulty={hasFeature("difficulty")}
                hasTeams={hasFeature("teams")}
              />
            )}
          </TabsContent>

          <TabsContent value="config" className="p-3 min-h-0">
            <ConfigEditor
              profiles={launcher.profiles}
              selectedProfileId={launcher.selectedProfileId}
              onRefreshProfiles={launcher.fetchProfiles}
            />
          </TabsContent>

          <TabsContent value="playlists" className="p-3 min-h-0">
            <PlaylistEditor
              playlists={playlistHook.playlists}
              status={playlistHook.status}
              loading={playlistHook.loading}
              error={playlistHook.error}
              onCreatePlaylist={playlistHook.createPlaylist}
              onUpdatePlaylist={playlistHook.updatePlaylist}
              onDeletePlaylist={playlistHook.deletePlaylist}
              onActivate={(id) => playlistHook.activatePlaylist(id, launcher.selectedProfileId || undefined)}
              onDeactivate={playlistHook.deactivatePlaylist}
              selectedProfileId={launcher.selectedProfileId || undefined}
            />
          </TabsContent>

          <TabsContent value="logs" className="p-3 min-h-0">
            <LogsPanel />
          </TabsContent>

          <TabsContent value="bans" className="p-3 min-h-0">
            <BansPanel notify={addToast} />
          </TabsContent>

          <TabsContent value="rules" className="p-3 min-h-0">
            <RulesPanel notify={addToast} />
          </TabsContent>

          <TabsContent value="settings" className="p-3 min-h-0">
            <SettingsPanel notify={addToast} showSessions={showLogout} />
          </TabsContent>
        </Tabs>

        {/* Right sidebar — tablet+ inline (md and lg+) */}
        {isConnected && (
          <ServerSidebar
            {...serverSidebarProps}
            className="hidden md:flex flex-col md:w-48 lg:w-64 shrink-0 border-l border-border bg-sidebar overflow-y-auto"
          />
        )}
      </div>

      {/* Left panel Sheet — phone (<md) and tablet (md) both use this */}
      <Sheet open={leftSheetOpen} onOpenChange={setLeftSheetOpen}>
        <SheetContent side="left" className="w-72 p-0 bg-sidebar">
          <SheetTitle className="sr-only">Navigation Panel</SheetTitle>
          <div className="flex flex-col h-full overflow-y-auto p-3">
            {leftSidebarContent}
          </div>
        </SheetContent>
      </Sheet>

      {/* Server sidebar Sheet — phone only (<md) */}
      {isConnected && (
        <Sheet open={serverSheetOpen} onOpenChange={setServerSheetOpen}>
          <SheetContent side="right" className="w-80 p-0 bg-sidebar overflow-y-auto">
            <SheetTitle className="sr-only">Server Controls</SheetTitle>
            <ServerSidebar
              {...serverSidebarProps}
              className="w-full border-l-0 shrink-0 flex flex-col"
            />
          </SheetContent>
        </Sheet>
      )}

      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}

function App() {
  const { authenticated, checking, authRequired, needsSetup, login, setup, logout } = useAuth();

  if (checking) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <p className="text-muted-foreground">Loading...</p>
      </div>
    );
  }

  if (needsSetup) {
    return <SetupPage onSetup={setup} />;
  }

  if (!authenticated) {
    return <LoginPage onLogin={login} />;
  }

  return (
    <TooltipProvider>
      <Dashboard onLogout={logout} showLogout={authRequired} />
    </TooltipProvider>
  );
}

export default App;
