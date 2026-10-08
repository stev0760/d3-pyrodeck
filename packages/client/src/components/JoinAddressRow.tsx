import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

/** GET /api/profiles/:id/join-address (server: launcher/joinAddress.ts). */
interface JoinAddress {
  host: string | null;
  port: number;
  address: string | null;
  hostSource: "setting" | "bind-address" | "mission-host" | null;
  lanOnly: boolean;
}

const SOURCE_LABEL: Record<NonNullable<JoinAddress["hostSource"]>, string> = {
  setting: "Join Host setting",
  "bind-address": "bind address",
  "mission-host": "mission host URL",
};

/** Copy text; navigator.clipboard needs a secure origin, so fall back to a selection copy over plain http. */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the selection copy
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  document.body.removeChild(area);
  return ok;
}

/**
 * The host:port players type into the game's Direct TCP/IP join screen, with
 * a copy button. The host comes from the global Join Host setting (editable
 * here), the profile's bind address, or the mission host's public URL.
 */
export function JoinAddressRow({ profileId, refreshKey }: { profileId: string; refreshKey?: unknown }) {
  const [join, setJoin] = useState<JoinAddress | null>(null);
  const [editing, setEditing] = useState(false);
  const [hostInput, setHostInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/profiles/${encodeURIComponent(profileId)}/join-address`, {
        credentials: "include",
      });
      setJoin(res.ok ? ((await res.json()) as JoinAddress) : null);
    } catch {
      setJoin(null);
    }
  }, [profileId]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const saveHost = async () => {
    setError(null);
    try {
      const res = await fetch("/api/pyrodeck/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ joinHost: hostInput.trim() || null }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "Failed to save");
        return;
      }
      setEditing(false);
      await load();
    } catch {
      setError("Failed to save");
    }
  };

  const copy = async () => {
    if (!join?.address) return;
    if (await copyText(join.address)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } else {
      setError("Copy failed; select the address by hand.");
    }
  };

  if (!join) return null;

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5 bg-muted rounded-md px-2 py-1 text-xs">
        <span className="text-muted-foreground shrink-0">Join: </span>
        <span className="flex-1 min-w-0 text-foreground/80 break-all font-mono text-[11px] select-all">
          {join.address ?? `?:${join.port}`}
        </span>
        {join.address && (
          <Button variant="outline" size="xs" onClick={() => void copy()} className="shrink-0 px-1.5">
            {copied ? "Copied" : "Copy"}
          </Button>
        )}
        <Button
          variant="ghost"
          size="xs"
          onClick={() => {
            setHostInput(join.hostSource === "setting" ? (join.host ?? "") : "");
            setError(null);
            setEditing((e) => !e);
          }}
          className="shrink-0 px-1.5 text-muted-foreground"
        >
          {join.host ? "Host" : "Set host"}
        </Button>
      </div>
      {!editing && (
        <p className="text-[10px] text-muted-foreground leading-snug">
          {join.host
            ? `Host from the ${SOURCE_LABEL[join.hostSource ?? "setting"]}${join.lanOnly ? "; a local address, so only players on this network can use it" : ""}. Players enter it under Multiplayer → Direct TCP/IP.`
            : "Pyrodeck doesn't know the address players reach this machine at. Set the Join Host."}
        </p>
      )}
      {editing && (
        <div className="space-y-1">
          <label className="block text-[10px] text-muted-foreground">
            Join Host (all profiles): host name or IPv4 address players reach this machine at
            <input
              type="text"
              value={hostInput}
              onChange={(e) => setHostInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void saveHost()}
              placeholder="d3.example.org"
              className="w-full mt-0.5 bg-input border border-border rounded-md px-2 py-1 text-xs text-foreground font-mono focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </label>
          <div className="flex gap-1.5">
            <Button size="xs" onClick={() => void saveHost()} className="flex-1 font-score tracking-wide">
              Save
            </Button>
            <Button variant="ghost" size="xs" onClick={() => setEditing(false)} className="flex-1 font-score tracking-wide">
              Cancel
            </Button>
          </div>
          <p className="text-[10px] text-muted-foreground">Leave it empty and save to clear it.</p>
        </div>
      )}
      {error && <p className="text-[11px] text-destructive break-words">{error}</p>}
    </div>
  );
}
