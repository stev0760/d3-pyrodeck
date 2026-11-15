import { describeDownloads, type PlaylistDownloads as Downloads } from "@/lib/playlistDownloads";

/**
 * One line on the active playlist's download links ("Downloads: 9 hosted, 3
 * ship with the game, 1 failed"). Compact: the missions that need a look go in
 * the tooltip; otherwise they are listed under the line.
 */
export function PlaylistDownloads({ downloads, compact = false }: { downloads: Downloads; compact?: boolean }) {
  const { line, problems, warn } = describeDownloads(downloads);
  const tone = warn ? "text-amber-400" : "text-muted-foreground";
  return (
    <div className="text-[10px] space-y-0.5">
      <p className={`${tone} break-words`} title={compact && problems.length > 0 ? problems.join("\n") : undefined}>
        {line}
      </p>
      {!compact &&
        problems.map((p) => (
          <p key={p} className="text-muted-foreground break-words pl-2">
            {p}
          </p>
        ))}
    </div>
  );
}
