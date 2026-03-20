import { useState, useEffect, useCallback } from "react";

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
      <button
        onClick={() => setShowAdd(true)}
        className="text-xs text-zinc-500 hover:text-zinc-400 mb-2"
      >
        + Save a server
      </button>
    );
  }

  return (
    <div className="mb-3">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs text-zinc-500 font-medium">Saved Servers</span>
        <button
          onClick={() => setShowAdd(!showAdd)}
          className="text-xs text-zinc-500 hover:text-zinc-400"
        >
          {showAdd ? "Cancel" : "+ Add"}
        </button>
      </div>

      {showAdd && (
        <div className="space-y-1 mb-2 p-2 bg-zinc-800 rounded">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Display name"
            className="w-full px-2 py-1 bg-zinc-700 border border-zinc-600 rounded text-xs text-zinc-100 focus:outline-none"
          />
          <div className="grid grid-cols-[1fr_60px] gap-1">
            <input
              type="text"
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder="Host"
              className="w-full px-2 py-1 bg-zinc-700 border border-zinc-600 rounded text-xs text-zinc-100 focus:outline-none"
            />
            <input
              type="number"
              value={port}
              onChange={(e) => setPort(e.target.value)}
              className="w-full px-2 py-1 bg-zinc-700 border border-zinc-600 rounded text-xs text-zinc-100 focus:outline-none"
            />
          </div>
          <button
            onClick={handleAdd}
            disabled={!name || !host}
            className="w-full py-1 text-xs bg-amber-600 hover:bg-amber-500 disabled:bg-zinc-700 text-white rounded"
          >
            Save
          </button>
        </div>
      )}

      <div className="space-y-1">
        {servers.map((s) => (
          <div
            key={s.id}
            className="flex items-center gap-2 p-1.5 bg-zinc-800 rounded hover:bg-zinc-750 group cursor-pointer"
            onClick={() => onSelect(s.host, s.port)}
          >
            <div className="flex-1 min-w-0">
              <div className="text-xs text-zinc-200 truncate">{s.name}</div>
              <div className="text-xs text-zinc-500 font-mono truncate">
                {s.host}:{s.port}
              </div>
            </div>
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleDelete(s.id);
              }}
              className="text-zinc-600 hover:text-red-400 text-xs opacity-0 group-hover:opacity-100 transition-opacity"
            >
              x
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
