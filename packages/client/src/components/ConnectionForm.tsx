import { useState, useEffect, type FormEvent } from "react";
import type { ConnectionState, ServerCapabilities } from "../hooks/useServerConnection.ts";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

interface ConnectionFormProps {
  connectionState: ConnectionState;
  capabilities: ServerCapabilities | null;
  error: string | null;
  onConnect: (host: string, port: number, password: string) => Promise<boolean>;
  onDisconnect: () => Promise<void>;
  initialHost?: string;
  initialPort?: number;
}

const STATE_COLORS: Record<ConnectionState, string> = {
  disconnected: "bg-muted-foreground",
  connecting: "bg-primary animate-pulse",
  probing: "bg-primary animate-pulse",
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
  initialHost,
  initialPort,
}: ConnectionFormProps) {
  const [host, setHost] = useState(initialHost ?? "localhost");
  const [port, setPort] = useState(String(initialPort ?? 2092));
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (initialHost) setHost(initialHost);
    if (initialPort) setPort(String(initialPort));
  }, [initialHost, initialPort]);

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
    <div className="bg-card border border-border rounded-lg p-4">
      {/* Status bar */}
      <div className="flex items-center gap-2 mb-4">
        <div className={`w-2.5 h-2.5 rounded-full ${STATE_COLORS[connectionState]}`} />
        <span className="text-sm font-score tracking-wide text-foreground/70">
          {STATE_LABELS[connectionState]}
        </span>
        {capabilities && capabilities.version > 0 && (
          <Badge variant="secondary" className="ml-auto text-[10px]">
            {capabilities.fork} v{capabilities.forkVersion}
          </Badge>
        )}
      </div>

      {!isConnected ? (
        <form onSubmit={handleConnect} className="space-y-3">
          <div className="grid grid-cols-[1fr_80px] gap-2">
            <div>
              <label className="block text-sm font-score tracking-wide text-muted-foreground mb-1">Host</label>
              <input
                type="text"
                value={host}
                onChange={(e) => setHost(e.target.value)}
                className="w-full px-2 py-1.5 bg-input border border-border rounded-md text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                placeholder="localhost"
                disabled={loading}
              />
            </div>
            <div>
              <label className="block text-sm font-score tracking-wide text-muted-foreground mb-1">Port</label>
              <input
                type="number"
                value={port}
                onChange={(e) => setPort(e.target.value)}
                className="w-full px-2 py-1.5 bg-input border border-border rounded-md text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                disabled={loading}
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-score tracking-wide text-muted-foreground mb-1">
              Console Password
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-2 py-1.5 bg-input border border-border rounded-md text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              placeholder="Server console password"
              disabled={loading}
            />
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <Button
            type="submit"
            disabled={loading || !host || !password}
            className="w-full font-score tracking-wide"
          >
            {loading ? "Connecting..." : "Connect"}
          </Button>
        </form>
      ) : (
        <div>
          <p className="text-sm text-foreground/70 mb-3">
            Connected to{" "}
            <span className="text-foreground font-mono">{host}:{port}</span>
          </p>
          <Button
            variant="secondary"
            onClick={handleDisconnect}
            disabled={loading}
            className="w-full font-score tracking-wide"
          >
            Disconnect
          </Button>
        </div>
      )}
    </div>
  );
}
