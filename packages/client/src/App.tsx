import { useState, useEffect, useRef, useCallback } from "react";
import { useAuth } from "./hooks/useAuth.ts";
import { useMediaQuery } from "./hooks/useMediaQuery.ts";
import { useIsMobile } from "./hooks/useIsMobile.ts";
import { SessionProvider, useSession } from "./session/SessionProvider.tsx";
import { MobileApp, type ShellProps } from "./components/mobile/MobileApp.tsx";
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
import { ServerChip } from "./components/ServerChip.tsx";
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
    connection,
    launcher,
    toast,
    playlist: playlistHook,
    serverInfo: serverInfoHook,
    mode,
    setMode,
    isConnected,
    processState,
    hasProcess,
    consoleBuffer,
    processBuffer,
    servers,
    serverId,
    serverName,
    selectedServerId,
  } = useSession();
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
    onBotPopulation,
    hasFeature,
  } = connection;
  const { toasts, addToast, dismissToast } = toast;

  // A command typed at the console goes into the server's buffer too, so it
  // is there when the console is opened again (or on a phone).
  const typedCommand = useCallback(
    (command: string) => {
      consoleBuffer.line(command, "cmd");
      sendCommand(command);
    },
    [consoleBuffer, sendCommand],
  );
  /** Panels holding one server's state remount on a switch of server: nothing of the last one stays. */
  const serverKey = serverId ?? "none";

  // The left panel is inline from lg up and the server sidebar from md up;
  // below that each lives in a Sheet. Render each in one place only, or the
  // hidden copy keeps polling beside the visible one.
  const isLg = useMediaQuery("(min-width: 1024px)");
  const isMd = useMediaQuery("(min-width: 768px)");

  const [activeTab, setActiveTab] = useState<Tab>(() =>
    mode === "launch" ? "server-output" : "console"
  );
  const [connectHost, setConnectHost] = useState("localhost");
  const [connectPort, setConnectPort] = useState(2092);
  const [leftSheetOpen, setLeftSheetOpen] = useState(false);
  const [serverSheetOpen, setServerSheetOpen] = useState(false);

  const handleModeChange = (newMode: AppMode) => {
    setMode(newMode);
    setActiveTab(newMode === "launch" ? "server-output" : "console");
  };

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

  // "primary" tabs stay inline; "more" tabs (Launch-only management screens)
  // collapse into a dropdown so the bar stays short and responsive.
  // Bans and Settings are every server's, the rest the selected server's.
  const tabs: { id: Tab; label: string; show: boolean; group: "primary" | "more"; note?: string }[] = [
    { id: "server-output", label: "Output", show: mode === "launch", group: "primary" },
    { id: "console", label: "Console", show: true, group: "primary" },
    { id: "players", label: "Players", show: true, group: "primary" },
    { id: "bots", label: "Bots", show: isConnected && hasFeature("bots"), group: "primary" },
    { id: "config", label: "Config", show: mode === "launch", group: "more" },
    { id: "playlists", label: "Playlists", show: mode === "launch", group: "more" },
    { id: "logs", label: "Logs", show: mode === "launch", group: "more" },
    { id: "bans", label: "Bans", show: true, group: "more", note: "all servers" },
    { id: "rules", label: "Rules", show: true, group: "more" },
    { id: "settings", label: "Settings", show: true, group: "more", note: "all servers" },
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
        ? () => { void launcher.stop(selectedServerId); }
        : serverInfoHook.quitServer,
    },
    serverName,
    playlists: playlistHook.playlists,
    playlistStatus: playlistHook.status,
    onActivatePlaylist: (id: string) => void playlistHook.activatePlaylist(id),
    onDeactivatePlaylist: () => void playlistHook.deactivatePlaylist(),
    onResumePlaylist: () => void playlistHook.resumePlaylist(),
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
    <div className="h-dvh bg-background text-foreground flex flex-col">
      {/* Header */}
      <header className="flex items-center justify-between px-4 py-2 border-b border-border bg-card shrink-0">
        <div className="flex items-center gap-3 min-w-0">
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
          <h1 className="text-2xl font-logo tracking-wide text-primary shrink-0">D3 Pyrodeck</h1>
          <span className="hidden sm:inline text-[10px] text-muted-foreground shrink-0">v{__APP_VERSION__}</span>
          <ServerChip className="max-w-[16rem]" />
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
          {isLg && leftSidebarContent}
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
                      {tab.note && (
                        <span className="ml-auto pl-3 text-[10px] font-sans tracking-normal text-muted-foreground">{tab.note}</span>
                      )}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </TabsList>

          <TabsContent value="server-output" className="p-3 min-h-0">
            {hasProcess ? (
              <ServerConsole key={serverKey} onProcessOutput={onProcessOutput} replay={processBuffer.lines()} />
            ) : (
              <div className="h-full flex items-center justify-center">
                <p className="text-muted-foreground text-lg font-score tracking-wide">
                  {serverName ? `Start ${serverName} to see its output here` : "Launch a Descent 3 server to see output here"}
                </p>
              </div>
            )}
          </TabsContent>

          <TabsContent value="console" className="p-3 min-h-0">
            {isConnected ? (
              <div className="h-full flex flex-col">
                <div className="flex-1 min-h-0">
                  <Console key={serverKey} onCommand={typedCommand} onOutput={onOutput} replay={consoleBuffer.lines()} />
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
                    : serverName
                      ? `${serverName}: no console yet. Start it from the server list.`
                      : "Launch a Descent 3 server to get started"}
                </p>
              </div>
            )}
          </TabsContent>

          <TabsContent value="players" className="p-3 min-h-0">
            <PlayersPanel key={serverKey} connected={isConnected} sendCommand={sendCommand} onPlayers={onPlayers} notify={addToast} />
          </TabsContent>

          <TabsContent value="bots" className="p-3 min-h-0">
            {isConnected && (
              <BotPanel
                key={serverKey}
                sendCommand={sendCommand}
                onBots={onBots}
                onBotStats={onBotStats}
                onBotMode={onBotMode}
                hasShips={hasFeature("ships")}
                hasDifficulty={hasFeature("difficulty")}
                hasTeams={hasFeature("teams")}
                hasPopulation={hasFeature("population")}
                onBotPopulation={onBotPopulation}
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
              onActivate={(id) => void playlistHook.activatePlaylist(id)}
              onDeactivate={() => void playlistHook.deactivatePlaylist()}
              selectedProfileId={launcher.selectedProfileId || undefined}
              servers={servers}
              selectedServerId={serverId}
              serverName={serverName}
            />
          </TabsContent>

          <TabsContent value="logs" className="p-3 min-h-0">
            <LogsPanel />
          </TabsContent>

          <TabsContent value="bans" className="p-3 min-h-0">
            <BansPanel notify={addToast} />
          </TabsContent>

          <TabsContent value="rules" className="p-3 min-h-0">
            <RulesPanel key={serverKey} notify={addToast} />
          </TabsContent>

          <TabsContent value="settings" className="p-3 min-h-0">
            <SettingsPanel notify={addToast} showSessions={showLogout} />
          </TabsContent>
        </Tabs>

        {/* Right sidebar — tablet+ inline (md and lg+) */}
        {isConnected && isMd && (
          <ServerSidebar
            key={serverKey}
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
            {!isLg && leftSidebarContent}
          </div>
        </SheetContent>
      </Sheet>

      {/* Server sidebar Sheet — phone only (<md) */}
      {isConnected && !isMd && (
        <Sheet open={serverSheetOpen} onOpenChange={setServerSheetOpen}>
          <SheetContent side="right" className="w-80 p-0 bg-sidebar overflow-y-auto">
            <SheetTitle className="sr-only">Server Controls</SheetTitle>
            <ServerSidebar
              key={serverKey}
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

/** The phone shell below 768 px (unless the operator chose otherwise), the full layout above. */
function Shell(props: ShellProps) {
  const isMobile = useIsMobile();
  return isMobile ? <MobileApp {...props} /> : <Dashboard {...props} />;
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
      <SessionProvider>
        <Shell onLogout={logout} showLogout={authRequired} />
      </SessionProvider>
    </TooltipProvider>
  );
}

export default App;
