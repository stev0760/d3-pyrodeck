import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import type { Playlist, PlaylistStatus } from "../hooks/usePlaylist.ts";

interface PlaylistPanelProps {
  playlists: Playlist[];
  status: PlaylistStatus;
  onActivate: (id: string) => void;
  onDeactivate: () => void;
}

/** Format seconds into M:SS */
function formatCountdown(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function StatusDot({ status }: { status: PlaylistStatus["status"] }) {
  const colors: Record<PlaylistStatus["status"], string> = {
    inactive: "bg-muted-foreground",
    active: "bg-green-500",
    voting: "bg-amber-400",
    restarting: "bg-primary",
  };
  return (
    <span
      className={`inline-block w-2 h-2 rounded-full shrink-0 ${colors[status]}`}
      title={status}
    />
  );
}

export function PlaylistPanel({ playlists, status, onActivate, onDeactivate }: PlaylistPanelProps) {
  const [now, setNow] = useState(Date.now());
  const [showSelect, setShowSelect] = useState(false);

  // Update countdown every second
  useEffect(() => {
    if (!status.gameEndAt) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [status.gameEndAt]);

  const activePlaylist = playlists.find((p) => p.id === status.activePlaylistId);

  return (
    <div className="px-3 py-2">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-1.5">
          <StatusDot status={status.status} />
          <h3 className="text-[10px] text-muted-foreground uppercase tracking-wider font-semibold">
            Playlist
          </h3>
        </div>
        {status.status !== "inactive" && (
          <button
            onClick={onDeactivate}
            className="text-[10px] text-muted-foreground hover:text-destructive transition-colors"
          >
            Stop
          </button>
        )}
      </div>

      {status.status === "inactive" ? (
        <div className="space-y-1.5">
          {playlists.length === 0 ? (
            <p className="text-[10px] text-muted-foreground italic">
              No playlists. Create one in the Playlists tab.
            </p>
          ) : showSelect ? (
            <div className="space-y-1">
              <select
                className="w-full px-2 py-1 bg-muted border border-border rounded text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                defaultValue=""
                onChange={(e) => {
                  if (e.target.value) {
                    onActivate(e.target.value);
                    setShowSelect(false);
                  }
                }}
              >
                <option value="">Select playlist...</option>
                {playlists.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.entries.length} missions)
                  </option>
                ))}
              </select>
              <button
                onClick={() => setShowSelect(false)}
                className="text-[10px] text-muted-foreground hover:text-foreground transition-colors"
              >
                Cancel
              </button>
            </div>
          ) : (
            <Button
              variant="secondary"
              size="sm"
              className="w-full"
              onClick={() => setShowSelect(true)}
              disabled={playlists.length === 0}
            >
              Activate Playlist
            </Button>
          )}
        </div>
      ) : (
        <div className="space-y-1.5">
          {/* Active playlist name */}
          <p className="text-xs font-medium text-foreground truncate">
            {activePlaylist?.name ?? "Unknown playlist"}
          </p>

          {/* Status label */}
          {status.status === "restarting" && (
            <p className="text-[10px] text-primary animate-pulse">
              Rotating mission...
            </p>
          )}
          {status.status === "voting" && (
            <p className="text-[10px] text-amber-400">
              Vote in progress
              {status.voteDeadline && (
                <> — {formatCountdown(status.voteDeadline - now)}</>
              )}
            </p>
          )}

          {/* Current mission */}
          {status.currentEntry && (
            <div className="text-[10px] text-muted-foreground">
              <span className="text-foreground/60">Now:</span>{" "}
              <span className="text-foreground/80">{status.currentEntry.label}</span>
            </div>
          )}

          {/* Timer */}
          {status.gameEndAt && status.status !== "restarting" && (
            <div className="text-[10px] text-muted-foreground">
              <span className="text-foreground/60">Time left:</span>{" "}
              <span className="font-mono text-foreground/80">
                {formatCountdown(status.gameEndAt - now)}
              </span>
            </div>
          )}

          {/* Next mission preview for sequential mode */}
          {activePlaylist && activePlaylist.mode === "sequential" && activePlaylist.entries.length > 1 && (
            (() => {
              const nextIdx = (status.currentIndex + 1) % activePlaylist.entries.length;
              const next = activePlaylist.entries[nextIdx];
              return next ? (
                <div className="text-[10px] text-muted-foreground">
                  <span className="text-foreground/60">Next:</span>{" "}
                  <span>{next.label}</span>
                </div>
              ) : null;
            })()
          )}

          {/* Vote options */}
          {status.status === "voting" && status.voteOptions.length > 0 && (
            <div className="mt-1 space-y-0.5">
              <p className="text-[10px] text-muted-foreground font-medium">Vote options:</p>
              {status.voteOptions.map((opt, i) => (
                <div key={opt.id} className="text-[10px] text-foreground/70">
                  {i + 1}. {opt.label}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
