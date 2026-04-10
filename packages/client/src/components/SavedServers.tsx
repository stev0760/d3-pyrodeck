import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";

interface SavedServer {
  id: string;
  name: string;
  host: string;
  port: number;
}

interface SavedServersProps {
  onSelect: (host: string, port: number) => void;
}

export function SavedServers({ onSelect }: SavedServersProps) {
  const [servers, setServers] = useState<SavedServer[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [name, setName] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("2092");

  const fetchServers = useCallback(async () => {
    try {
      const res = await fetch("/api/servers/saved", { credentials: "include" });
      if (res.ok) setServers(await res.json());
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    fetchServers();
  }, [fetchServers]);

  const handleAdd = async () => {
    await fetch("/api/servers/saved", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ name, host, port: parseInt(port, 10) }),
    });
    setShowAdd(false);
    setName("");
    setHost("");
    setPort("2092");
    fetchServers();
  };

  const handleDelete = async (id: string) => {
    await fetch(`/api/servers/saved/${id}`, {
      method: "DELETE",
      credentials: "include",
    });
    fetchServers();
  };

  if (servers.length === 0 && !showAdd) {
    return (
      <Button
        variant="ghost"
        size="xs"
        onClick={() => setShowAdd(true)}
        className="mb-2 text-muted-foreground"
      >
        + Save a server
      </Button>
    );
  }

  return (
    <div className="mb-3">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs text-muted-foreground font-medium">Saved Servers</span>
        <Button
          variant="ghost"
          size="xs"
          onClick={() => setShowAdd(!showAdd)}
        >
          {showAdd ? "Cancel" : "+ Add"}
        </Button>
      </div>

      {showAdd && (
        <div className="space-y-1 mb-2 p-2 bg-muted rounded-md">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Display name"
            className="w-full px-2 py-1 bg-input border border-border rounded-md text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          />
          <div className="grid grid-cols-[1fr_60px] gap-1">
            <input
              type="text"
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder="Host"
              className="w-full px-2 py-1 bg-input border border-border rounded-md text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            />
            <input
              type="number"
              value={port}
              onChange={(e) => setPort(e.target.value)}
              className="w-full px-2 py-1 bg-input border border-border rounded-md text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
          <Button
            size="xs"
            onClick={handleAdd}
            disabled={!name || !host}
            className="w-full"
          >
            Save
          </Button>
        </div>
      )}

      <div className="space-y-1">
        {servers.map((s) => (
          <div
            key={s.id}
            className="flex items-center gap-2 p-1.5 bg-muted rounded-md hover:bg-accent group cursor-pointer transition-colors"
            onClick={() => onSelect(s.host, s.port)}
          >
            <div className="flex-1 min-w-0">
              <div className="text-xs text-foreground truncate">{s.name}</div>
              <div className="text-xs text-muted-foreground font-mono truncate">
                {s.host}:{s.port}
              </div>
            </div>
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleDelete(s.id);
              }}
              className="text-muted-foreground hover:text-destructive text-xs opacity-0 group-hover:opacity-100 transition-opacity"
            >
              x
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
