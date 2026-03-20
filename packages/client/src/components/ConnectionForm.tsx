import { useState, type FormEvent } from "react";
import type { ConnectionState, ServerCapabilities } from "../hooks/useServerConnection.ts";

interface ConnectionFormProps {
  connectionState: ConnectionState;
  capabilities: ServerCapabilities | null;
  error: string | null;
  onConnect: (host: string, port: number, password: string) => Promise<boolean>;
  onDisconnect: () => Promise<void>;
}

const STATE_COLORS: Record<ConnectionState, string> = {
  disconnected: "bg-zinc-500",
  connecting: "bg-amber-500 animate-pulse",
  probing: "bg-amber-500 animate-pulse",
  ready: "bg-emerald-500",
};

const STATE_LABELS: Record<ConnectionState, string> = {
  disconnected: "Disconnected",
  connecting: "Connecting...",
  probing: "Probing capabilities...",
  ready: "Connected",
};

export function ConnectionForm({
  connectionState,
  capabilities,
  error,
  onConnect,
  onDisconnect,
}: ConnectionFormProps) {
  const [host, setHost] = useState("localhost");
  const [port, setPort] = useState("2092");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  const isConnected = connectionState === "ready";

  const handleConnect = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    await onConnect(host, parseInt(port, 10), password);
    setLoading(false);
  };

  const handleDisconnect = async () => {
    setLoading(true);
    await onDisconnect();
    setLoading(false);
  };

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
      {/* Status bar */}
      <div className="flex items-center gap-2 mb-4">
        <div className={`w-2.5 h-2.5 rounded-full ${STATE_COLORS[connectionState]}`} />
        <span className="text-sm text-zinc-400">
          {STATE_LABELS[connectionState]}
        </span>
        {capabilities && capabilities.version > 0 && (
          <span className="text-xs text-zinc-600 ml-auto">
            {capabilities.fork} v{capabilities.forkVersion}
          </span>
        )}
      </div>

      {!isConnected ? (
        <form onSubmit={handleConnect} className="space-y-3">
          <div className="grid grid-cols-[1fr_80px] gap-2">
            <div>
              <label className="block text-xs text-zinc-500 mb-1">Host</label>
              <input
                type="text"
                value={host}
                onChange={(e) => setHost(e.target.value)}
                className="w-full px-2 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-sm text-zinc-100 focus:outline-none focus:ring-1 focus:ring-amber-500"
                placeholder="localhost"
                disabled={loading}
              />
            </div>
            <div>
              <label className="block text-xs text-zinc-500 mb-1">Port</label>
              <input
                type="number"
                value={port}
                onChange={(e) => setPort(e.target.value)}
                className="w-full px-2 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-sm text-zinc-100 focus:outline-none focus:ring-1 focus:ring-amber-500"
                disabled={loading}
              />
            </div>
          </div>

          <div>
            <label className="block text-xs text-zinc-500 mb-1">
              Console Password
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-2 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-sm text-zinc-100 focus:outline-none focus:ring-1 focus:ring-amber-500"
              placeholder="Server console password"
              disabled={loading}
            />
          </div>

          {error && <p className="text-sm text-red-400">{error}</p>}

          <button
            type="submit"
            disabled={loading || !host || !password}
            className="w-full py-1.5 px-3 bg-amber-600 hover:bg-amber-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white text-sm font-medium rounded transition-colors"
          >
            {loading ? "Connecting..." : "Connect"}
          </button>
        </form>
      ) : (
        <div>
          <p className="text-sm text-zinc-400 mb-3">
            Connected to{" "}
            <span className="text-zinc-200 font-mono">{host}:{port}</span>
          </p>
          <button
            onClick={handleDisconnect}
            disabled={loading}
            className="w-full py-1.5 px-3 bg-zinc-700 hover:bg-zinc-600 text-zinc-200 text-sm font-medium rounded transition-colors"
          >
            Disconnect
          </button>
        </div>
      )}
    </div>
  );
}
