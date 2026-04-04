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
    // Default to appropriate console tab for each mode
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

  return (
    <div className="h-screen bg-zinc-950 text-zinc-100 flex flex-col">
      {/* Header */}
      <header className="flex items-center justify-between px-4 py-2 border-b border-zinc-800 bg-zinc-900 shrink-0">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-bold text-amber-500">D3 Pyrodeck</h1>
          {capabilities && capabilities.version > 0 && (
            <span className="text-xs text-zinc-500 bg-zinc-800 px-2 py-0.5 rounded">
              {capabilities.fork} v{capabilities.forkVersion}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          {isConnected && (
            <span className={`text-xs ${wsConnected ? "text-emerald-500" : "text-red-400"}`}>
              WS: {wsConnected ? "live" : "disconnected"}
            </span>
          )}
          <button
            onClick={onLogout}
            className="text-xs text-zinc-500 hover:text-zinc-400"
          >
            Logout
          </button>
        </div>
      </header>

      {/* Reconnection banner */}
      {wsReconnecting && (
        <div className="px-4 py-2 bg-amber-900/50 border-b border-amber-700/50 text-amber-300 text-sm text-center shrink-0">
          Connection lost — Reconnecting...
        </div>
      )}

      <div className="flex flex-1 min-h-0">
        {/* Sidebar */}
        <aside className="w-72 shrink-0 border-r border-zinc-800 p-3 overflow-y-auto flex flex-col">
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
        <main className="flex-1 flex flex-col min-w-0">
          {/* Tabs */}
          <div className="flex border-b border-zinc-800 px-2 shrink-0">
            {tabs
              .filter((t) => t.show)
              .map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                    activeTab === tab.id
                      ? "border-amber-500 text-amber-400"
                      : "border-transparent text-zinc-500 hover:text-zinc-300"
                  }`}
                >
                  {tab.label}
                </button>
              ))}
          </div>

          {/* Tab content */}
          <div className="flex-1 min-h-0 p-3">
            {activeTab === "server-output" && (
              <div className="h-full flex flex-col">
                {hasProcess ? (
                  <ServerConsole onProcessOutput={onProcessOutput} />
                ) : (
                  <div className="h-full flex items-center justify-center">
                    <p className="text-zinc-600 text-lg">
                      Launch a D3 server to see output here
                    </p>
                  </div>
                )}
              </div>
            )}

            {activeTab === "console" && (
              <div className="h-full flex flex-col">
                {isConnected ? (
                  <>
                    <div className="flex-1 min-h-0">
                      <Console onCommand={sendCommand} onOutput={onOutput} />
                    </div>
                    <CommandReference
                      sendCommand={sendCommand}
                      hasFeature={hasFeature}
                    />
                  </>
                ) : (
                  <div className="h-full flex items-center justify-center">
                    <p className="text-zinc-600 text-lg">
                      {mode === "connect"
                        ? "Connect to a D3 server to get started"
                        : "Launch a D3 server to get started"}
                    </p>
                  </div>
                )}
              </div>
            )}

            {activeTab === "players" && isConnected && (
              <PlayerList sendCommand={sendCommand} onPlayers={onPlayers} />
            )}

            {activeTab === "bots" && isConnected && (
              <BotPanel
                sendCommand={sendCommand}
                onBots={onBots}
                hasShips={hasFeature("ships")}
                hasDifficulty={hasFeature("difficulty")}
              />
            )}

            {activeTab === "config" && (
              <ConfigEditor
                profiles={launcher.profiles}
                onRefreshProfiles={launcher.fetchProfiles}
              />
            )}
          </div>
        </main>

        {/* Right sidebar — server dashboard */}
        {isConnected && (
          <ServerSidebar
            serverInfo={serverInfoHook.serverInfo}
            actions={serverInfoHook}
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
      <div className="min-h-screen bg-zinc-950 flex items-center justify-center">
        <p className="text-zinc-500">Loading...</p>
      </div>
    );
  }

  if (!authenticated) {
    return <LoginPage onLogin={login} />;
  }

  return <Dashboard onLogout={logout} />;
}

export default App;
