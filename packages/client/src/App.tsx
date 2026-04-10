import { useState, useEffect, useRef } from "react";
import { useAuth } from "./hooks/useAuth.ts";
import { useServerConnection } from "./hooks/useServerConnection.ts";
import { useToast } from "./hooks/useToast.ts";
import { useLauncher } from "./hooks/useLauncher.ts";
import { useServerInfo } from "./hooks/useServerInfo.ts";
import { LoginPage } from "./components/LoginPage.tsx";
import { ConnectionForm } from "./components/ConnectionForm.tsx";
import { SavedServers } from "./components/SavedServers.tsx";
import { Console } from "./components/Console.tsx";
import { PlayerList } from "./components/PlayerList.tsx";
import { BotPanel } from "./components/BotPanel.tsx";
import { ConfigEditor } from "./components/ConfigEditor.tsx";
import { CommandReference } from "./components/CommandReference.tsx";
import { ToastContainer } from "./components/ToastContainer.tsx";
import { ModeToggle, type AppMode } from "./components/ModeToggle.tsx";
import { LaunchPanel } from "./components/LaunchPanel.tsx";
import { ServerSidebar } from "./components/ServerSidebar.tsx";
import { ServerConsole } from "./components/ServerConsole.tsx";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";

type Tab = "console" | "players" | "bots" | "config" | "server-output";

function Dashboard({ onLogout }: { onLogout: () => void }) {
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
    onServerInfo,
    hasFeature,
  } = useServerConnection();

  const launcher = useLauncher();
  const serverInfoHook = useServerInfo({
    sendCommand,
    onServerInfo,
    connected: connectionState === "ready",
  });
  const { toasts, addToast, dismissToast } = useToast();
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

  const handleModeChange = (newMode: AppMode) => {
    setMode(newMode);
    localStorage.setItem("pyrodeck-mode", newMode);
    setActiveTab(newMode === "launch" ? "server-output" : "console");
  };

  const isConnected = connectionState === "ready";
  const processState = launcher.processStatus?.state;
  const hasProcess = mode === "launch" && (
    processState === "starting" || processState === "running" ||
    processState === "stopping" || processState === "crashed"
  );

  const tabs: { id: Tab; label: string; show: boolean }[] = [
    { id: "server-output", label: "Server Output", show: mode === "launch" },
    { id: "console", label: "Telnet Console", show: true },
    { id: "players", label: "Players", show: isConnected },
    { id: "bots", label: "Bots", show: isConnected && hasFeature("bots") },
    { id: "config", label: "D3 Server Config", show: mode === "launch" },
  ];

  const handleServerSelect = (host: string, port: number) => {
    setConnectHost(host);
    setConnectPort(port);
  };

  // Keep activeTab valid when tabs change visibility
  const visibleTabs = tabs.filter((t) => t.show);
  useEffect(() => {
    if (!visibleTabs.find((t) => t.id === activeTab)) {
      setActiveTab(visibleTabs[0]?.id ?? "console");
    }
  }, [visibleTabs, activeTab]);

  return (
    <div className="h-screen bg-background text-foreground flex flex-col">
      {/* Header */}
      <header className="flex items-center justify-between px-4 py-2 border-b border-border bg-card shrink-0">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-bold text-primary">D3 Pyrodeck</h1>
          {capabilities && capabilities.version > 0 && (
            <Badge variant="secondary">
              {capabilities.fork} v{capabilities.forkVersion}
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-3">
          {isConnected && (
            <Badge variant={wsConnected ? "outline" : "destructive"}>
              WS: {wsConnected ? "live" : "disconnected"}
            </Badge>
          )}
          <Button variant="ghost" size="xs" onClick={onLogout}>
            Logout
          </Button>
        </div>
      </header>

      {/* Reconnection banner */}
      {wsReconnecting && (
        <div className="px-4 py-2 bg-primary/10 border-b border-primary/30 text-primary text-sm text-center shrink-0">
          Connection lost — Reconnecting...
        </div>
      )}

      <div className="flex flex-1 min-h-0">
        {/* Sidebar */}
        <aside className="w-72 shrink-0 border-r border-border bg-sidebar p-3 overflow-y-auto flex flex-col">
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
        </aside>

        {/* Center content */}
        <Tabs
          value={activeTab}
          onValueChange={(v) => setActiveTab(v as Tab)}
          className="flex-1 min-w-0 gap-0"
        >
          <TabsList variant="line" className="w-full justify-start px-2 border-b border-border rounded-none h-10">
            {visibleTabs.map((tab) => (
              <TabsTrigger key={tab.id} value={tab.id}>
                {tab.label}
              </TabsTrigger>
            ))}
          </TabsList>

          <TabsContent value="server-output" className="p-3 min-h-0">
            {hasProcess ? (
              <ServerConsole onProcessOutput={onProcessOutput} />
            ) : (
              <div className="h-full flex items-center justify-center">
                <p className="text-muted-foreground text-lg">
                  Launch a D3 server to see output here
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
                <p className="text-muted-foreground text-lg">
                  {mode === "connect"
                    ? "Connect to a D3 server to get started"
                    : "Launch a D3 server to get started"}
                </p>
              </div>
            )}
          </TabsContent>

          <TabsContent value="players" className="p-3 min-h-0">
            {isConnected && (
              <PlayerList sendCommand={sendCommand} onPlayers={onPlayers} />
            )}
          </TabsContent>

          <TabsContent value="bots" className="p-3 min-h-0">
            {isConnected && (
              <BotPanel
                sendCommand={sendCommand}
                onBots={onBots}
                hasShips={hasFeature("ships")}
                hasDifficulty={hasFeature("difficulty")}
              />
            )}
          </TabsContent>

          <TabsContent value="config" className="p-3 min-h-0">
            <ConfigEditor
              profiles={launcher.profiles}
              onRefreshProfiles={launcher.fetchProfiles}
            />
          </TabsContent>
        </Tabs>

        {/* Right sidebar — server dashboard */}
        {isConnected && (
          <ServerSidebar
            serverInfo={serverInfoHook.serverInfo}
            actions={{
              ...serverInfoHook,
              // In Launch mode, route through launcher.stop() so ProcessManager
              // knows the exit is intentional (state → "stopped" not "crashed").
              // In Connect mode, send raw quit since we don't own the process.
              quitServer: mode === "launch"
                ? () => { launcher.stop(); }
                : serverInfoHook.quitServer,
            }}
          />
        )}
      </div>

      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}

function App() {
  const { authenticated, checking, login, logout } = useAuth();

  if (checking) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <p className="text-muted-foreground">Loading...</p>
      </div>
    );
  }

  if (!authenticated) {
    return <LoginPage onLogin={login} />;
  }

  return (
    <TooltipProvider>
      <Dashboard onLogout={logout} />
    </TooltipProvider>
  );
}

export default App;
