import fs from "node:fs/promises";

/**
 * Pyrodeck's block in the Startup Commands file (autoexec.dmfc). DMFC reads
 * one startup script only (`-autoexec <file>` or its default;
 * ParseStartupScript, netgames/dmfc/dmfcbase.cpp:4912-4960), so profile
 * settings that must hold from launch share the operator's file: Pyrodeck
 * owns the lines between the markers, rewrites them at every launch, and
 * leaves every other line as the operator wrote it. The block goes last, so
 * the profile's settings win over the same command typed above it.
 *
 * DMFC runs every line as a `$` command, putting a `$` in front when the line
 * lacks one, and drops unknown commands silently (dmfcbase.cpp:3476-3491), so
 * the marker lines (`$#` ...) and blank lines do nothing.
 */

const BEGIN_PREFIX = "# pyrodeck: begin";
const END_PREFIX = "# pyrodeck: end";
export const AUTOEXEC_BLOCK_BEGIN = `${BEGIN_PREFIX} (written at each launch from the profile; edits here are replaced)`;
export const AUTOEXEC_BLOCK_END = END_PREFIX;

function isBegin(line: string): boolean {
  return line.trim().startsWith(BEGIN_PREFIX);
}

function isEnd(line: string): boolean {
  return line.trim().startsWith(END_PREFIX);
}

/** The file's lines without Pyrodeck's block. A begin marker with no end loses only itself. */
function stripBlock(lines: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (isBegin(lines[i])) {
      const end = lines.findIndex((l, j) => j > i && isEnd(l));
      if (end !== -1) i = end;
      continue;
    }
    if (isEnd(lines[i])) continue; // a stray end marker is ours too
    out.push(lines[i]);
  }
  return out;
}

/**
 * The Startup Commands text with Pyrodeck's block set to `blockLines` (none:
 * the block is removed). Idempotent; operator lines are kept as written.
 * Returns `content` unchanged when there is nothing to change.
 */
export function mergeAutoexecBlock(content: string, blockLines: readonly string[]): string {
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.split(/\r?\n/);
  const hasBlock = lines.some((l) => isBegin(l) || isEnd(l));
  if (!hasBlock && blockLines.length === 0) return content;

  const kept = stripBlock(lines);
  while (kept.length > 0 && kept[kept.length - 1].trim() === "") kept.pop();

  const parts = [...kept];
  if (blockLines.length > 0) {
    if (parts.length > 0) parts.push("");
    parts.push(AUTOEXEC_BLOCK_BEGIN, ...blockLines, AUTOEXEC_BLOCK_END);
  }
  return parts.length > 0 ? parts.join(eol) + eol : "";
}

/**
 * Bring the block in the Startup Commands file at `filePath` up to date.
 * Creates the file only when there is a block to write; never deletes it.
 */
export async function syncAutoexecBlock(
  filePath: string,
  blockLines: readonly string[],
): Promise<"unchanged" | "written" | "created"> {
  for (const line of blockLines) {
    if (/[\r\n]/.test(line)) throw new Error(`Startup Commands line contains a line break: ${JSON.stringify(line)}`);
  }
  let content: string | null;
  try {
    content = await fs.readFile(filePath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    content = null;
  }
  if (content === null) {
    if (blockLines.length === 0) return "unchanged";
    await fs.writeFile(filePath, mergeAutoexecBlock("", blockLines));
    return "created";
  }
  const merged = mergeAutoexecBlock(content, blockLines);
  if (merged === content) return "unchanged";
  await fs.writeFile(filePath, merged);
  return "written";
}
