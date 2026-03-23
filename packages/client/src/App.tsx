import { useState } from "react";
import { useAuth } from "./hooks/useAuth.ts";
import { useServerConnection } from "./hooks/useServerConnection.ts";
import { LoginPage } from "./components/LoginPage.tsx";
import { ConnectionForm } from "./components/ConnectionForm.tsx";
import { SavedServers } from "./components/SavedServers.tsx";
import { Console } from "./components/Console.tsx";
import { PlayerList } from "./components/PlayerList.tsx";
import { BotPanel } from "./components/BotPanel.tsx";
import { ConfigEditor } from "./components/ConfigEditor.tsx";
import { GameSettings } from "./components/GameSettings.tsx";
import { CommandReference } from "./components/CommandReference.tsx";

type Tab = "console" | "players" | "bots" | "config" | "settings";

function Dashboard({ onLogout }: { onLogout: () => void }) {
  const {
    connectionState,
    capabilities,
    error,
    wsConnected,
    connect,
    disconnect,
    sendCommand,
    onOutput,
    onPlayers,
    onBots,
    hasFeature,
  } = useServerConnection();

  const [activeTab, setActiveTab] = useState<Tab>("console");
  const [connectHost, setConnectHost] = useState("localhost");
  const [connectPort, setConnectPort] = useState(2092);

  const isConnected = connectionState === "ready";

  const tabs: { id: Tab; label: string; show: boolean }[] = [
    { id: "console", label: "Console", show: true },
    { id: "players", label: "Players", show: isConnected },
    { id: "bots", label: "Bots", show: isConnected && hasFeature("bots") },
    { id: "config", label: "Config", show: true },
    { id: "settings", label: "Settings", show: isConnected },
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

      <div className="flex flex-1 min-h-0">
        {/* Sidebar */}
        <aside className="w-72 shrink-0 border-r border-zinc-800 p-3 overflow-y-auto flex flex-col">
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
        </aside>

        {/* Main content */}
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
                      Connect to a D3 server to get started
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

            {activeTab === "config" && <ConfigEditor />}

            {activeTab === "settings" && isConnected && (
              <GameSettings sendCommand={sendCommand} />
            )}
          </div>
        </main>
      </div>
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
