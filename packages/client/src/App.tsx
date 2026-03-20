import { useAuth } from "./hooks/useAuth.ts";
import { useServerConnection } from "./hooks/useServerConnection.ts";
import { LoginPage } from "./components/LoginPage.tsx";
import { ConnectionForm } from "./components/ConnectionForm.tsx";
import { Console } from "./components/Console.tsx";

function Dashboard() {
  const {
    connectionState,
    capabilities,
    error,
    connect,
    disconnect,
    sendCommand,
    onOutput,
  } = useServerConnection();

  const isConnected = connectionState === "ready";

  return (
    <div className="h-screen bg-zinc-950 text-zinc-100 flex flex-col">
      {/* Header */}
      <header className="flex items-center justify-between px-4 py-2 border-b border-zinc-800 bg-zinc-900 shrink-0">
        <h1 className="text-lg font-bold text-amber-500">D3 Pyrodeck</h1>
        {capabilities && capabilities.version > 0 && (
          <span className="text-xs text-zinc-500">
            {capabilities.fork} v{capabilities.forkVersion} |{" "}
            {capabilities.features.join(", ")}
          </span>
        )}
      </header>

      <div className="flex flex-1 min-h-0">
        {/* Sidebar */}
        <aside className="w-72 shrink-0 border-r border-zinc-800 p-3 overflow-y-auto">
          <ConnectionForm
            connectionState={connectionState}
            capabilities={capabilities}
            error={error}
            onConnect={connect}
            onDisconnect={disconnect}
          />
        </aside>

        {/* Main content */}
        <main className="flex-1 flex flex-col min-w-0 p-3">
          {isConnected ? (
            <div className="flex-1 min-h-0">
              <Console
                onCommand={sendCommand}
                onOutput={onOutput}
              />
            </div>
          ) : (
            <div className="flex-1 flex items-center justify-center">
              <p className="text-zinc-600 text-lg">
                Connect to a D3 server to get started
              </p>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

function App() {
  const { authenticated, checking, login } = useAuth();

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

  return <Dashboard />;
}

export default App;
