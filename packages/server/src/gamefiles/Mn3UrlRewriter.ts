import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";

/**
 * Mission download links: rewrite the URL lines of the .msn inside a .mn3.
 *
 * When a client joins a server whose mission it lacks, it asks the server for
 * download links, and the server answers with the URL lines of the mission's
 * .msn (Descent3/Mission.cpp, URL command; mission_download.cpp,
 * msn_DoAskForURL). Old missions carry dead 1999-era links, and the engine has
 * no override, so Pyrodeck edits the links inside the server's copy of the
 * .mn3. Facts from the engine source that shape this module:
 *
 * - A .mn3 is a HOG2 archive (cfile/hogfile.h): 68-byte header (magic "HOG2",
 *   u32 nfiles, u32 file_data_offset), then 48-byte entries (char name[36],
 *   u32 flags, u32 len, u32 timestamp), then the payloads back to back in entry
 *   order from file_data_offset. Little-endian. Entries must stay sorted.
 * - The engine opens "<mission stem>.msn" from the archive ("d3_2" maps to
 *   "d3"). Lines are read into a 128-byte buffer; the operand after the
 *   command is cut to 95 characters (char operand[96]).
 * - URL is a mission-level command: a URL line after the first LEVEL line is a
 *   load error. The engine keeps up to 5 URLs (MAX_MISSION_URL_COUNT).
 * - Any unknown command is a load error, so nothing but URL lines is written.
 * - Clients download only http:// and https:// links. A link ending in .zip is
 *   unzipped; any other body is saved as the mission file.
 * - The client's download screen formats "Downloading: %s" into a 100-byte
 *   stack buffer (mission_download.cpp, msn_DownloadWithStatus: char
 *   fmturl[MSN_MAX_STRING_LEN]; sprintf), the same in the 1999 source. A link
 *   longer than 86 characters overflows it, so 86 is the limit written here,
 *   not the 95 the .msn parser keeps.
 * - https is not dependable: the client's HTTP client (cpp-httplib, built
 *   without OpenSSL from the fork's vcpkg manifest) throws on an https link
 *   and nothing catches it, and the 1999-era client rejects it. Allowed, with
 *   a warning, for client builds that do have TLS.
 * - The join checksum covers level geometry and ships, not the .msn, so a
 *   rewritten .msn does not stop clients that hold the original mission from
 *   joining.
 * - The fork never offers links for the retail missions.
 *
 * Every rewrite goes through a temp file and a rename, after verifying the new
 * archive reads back. The first rewrite keeps the untouched file as
 * "<name>.mn3.pyrodeck-orig" (never overwritten), which restore puts back.
 */

const HOG2_MAGIC = "HOG2";
const HEADER_SIZE = 68;
const ENTRY_SIZE = 48;
const NAME_SIZE = 36;
const MAX_ENTRIES = 65_536;
const COPY_CHUNK = 1 << 20;

/** Longest URL the engine reads back intact (char operand[96]). */
export const MSN_URL_MAX = 95;
/**
 * Longest URL Pyrodeck writes: sprintf(fmturl[100], "Downloading: %s", url)
 * on the client needs 13 + length + 1 <= 100.
 */
export const MISSION_URL_MAX = 86;
/** URL lines the engine keeps (MAX_MISSION_URL_COUNT). */
export const MSN_URL_COUNT = 5;
export const BACKUP_SUFFIX = ".pyrodeck-orig";
const TEMP_SUFFIX = ".pyrodeck-tmp";

/** Retail missions: the fork never advertises download links for these. */
const RETAIL_MISSIONS = new Set(["d3.mn3", "d3_2.mn3", "training.mn3", "merc.mn3"]);

interface HogEntry {
  name: string;
  len: number;
  /** Absolute file offset of the payload. */
  offset: number;
  /** Absolute file offset of this entry's 48-byte record. */
  recordPos: number;
}

interface HogTable {
  nfiles: number;
  dataOffset: number;
  entries: HogEntry[];
  fileSize: number;
}

export class Mn3Error extends Error {}

/** Read and validate a HOG2 header and entry table. Throws Mn3Error on anything malformed. */
async function readHogTable(handle: fs.FileHandle): Promise<HogTable> {
  const { size: fileSize } = await handle.stat();
  const header = Buffer.alloc(HEADER_SIZE);
  const { bytesRead } = await handle.read(header, 0, HEADER_SIZE, 0);
  if (bytesRead < HEADER_SIZE || header.toString("latin1", 0, 4) !== HOG2_MAGIC) {
    throw new Mn3Error("not a .mn3 mission (no HOG2 header)");
  }
  const nfiles = header.readUInt32LE(4);
  const dataOffset = header.readUInt32LE(8);
  if (nfiles === 0 || nfiles > MAX_ENTRIES) {
    throw new Mn3Error(`not a .mn3 mission (implausible file count ${nfiles})`);
  }
  const tableEnd = HEADER_SIZE + nfiles * ENTRY_SIZE;
  if (dataOffset < tableEnd || dataOffset > fileSize) {
    throw new Mn3Error("not a .mn3 mission (data offset outside the file)");
  }

  const table = Buffer.alloc(nfiles * ENTRY_SIZE);
  const tableRead = await handle.read(table, 0, table.length, HEADER_SIZE);
  if (tableRead.bytesRead < table.length) throw new Mn3Error("truncated entry table");

  const entries: HogEntry[] = [];
  let offset = dataOffset;
  for (let i = 0; i < nfiles; i++) {
    const base = i * ENTRY_SIZE;
    const nul = table.indexOf(0, base);
    const nameEnd = nul >= base && nul < base + NAME_SIZE ? nul : base + NAME_SIZE;
    const name = table.toString("latin1", base, nameEnd);
    const len = table.readUInt32LE(base + 40);
    entries.push({ name, len, offset, recordPos: HEADER_SIZE + base });
    offset += len;
  }
  if (offset > fileSize) throw new Mn3Error("truncated archive (payloads run past the end of the file)");
  return { nfiles, dataOffset, entries, fileSize };
}

/** The .msn the engine loads for this mission file (MN3_TO_MSN_NAME), falling back to the first .msn. */
function findMsnEntry(table: HogTable, missionFile: string): HogEntry {
  let stem = path.basename(missionFile).replace(/\.mn3$/i, "");
  if (stem.toLowerCase() === "d3_2") stem = "d3";
  const wanted = `${stem}.msn`.toLowerCase();
  const exact = table.entries.find((e) => e.name.toLowerCase() === wanted);
  const any = exact ?? table.entries.find((e) => e.name.toLowerCase().endsWith(".msn"));
  if (!any) throw new Mn3Error("not a .mn3 mission (no .msn inside)");
  return any;
}

async function readBlob(handle: fs.FileHandle, offset: number, len: number): Promise<Buffer> {
  const blob = Buffer.alloc(len);
  const { bytesRead } = await handle.read(blob, 0, len, offset);
  if (bytesRead < len) throw new Mn3Error("truncated .msn");
  return blob;
}

// ---------------------------------------------------------------------------
// .msn text
// ---------------------------------------------------------------------------

/** First whitespace-delimited token of a .msn line, upper-cased (the engine compares case-insensitively). */
function commandOf(line: string): string {
  return line.trim().split(/[ \t]+/, 1)[0]?.toUpperCase() ?? "";
}

/** Mission-level URL operands (before the first LEVEL line), as the engine stores them. */
export function readMsnUrls(text: string): string[] {
  const urls: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const cmd = commandOf(line);
    if (cmd === "LEVEL") break;
    if (cmd === "URL" && urls.length < MSN_URL_COUNT) {
      const operand = line.trim().slice(3).trim().slice(0, MSN_URL_MAX);
      if (operand) urls.push(operand);
    }
  }
  return urls;
}

/**
 * Replace the mission-level URL lines with one `URL <url>` line. The new line
 * takes the place of the first existing URL line, or goes just before the
 * first LEVEL line when there is none. Every other byte, including each line's
 * own ending, is kept.
 */
export function rewriteMsnUrls(text: string, url: string): string {
  // ["line", "\r\n", "line", "\n", ..., "last"] — endings kept per line.
  const parts = text.split(/(\r?\n)/);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const newLine = `URL ${url}`;

  const out: string[] = [];
  let placed = false;
  let inMission = true; // before the first LEVEL line
  for (let i = 0; i < parts.length; i += 2) {
    const line = parts[i];
    const ending = parts[i + 1] ?? "";
    const cmd = commandOf(line);
    if (inMission && cmd === "LEVEL") {
      inMission = false;
      if (!placed) {
        out.push(newLine, eol);
        placed = true;
      }
    }
    if (inMission && cmd === "URL") {
      if (!placed) {
        // Keep the line's own "URL<whitespace>" prefix (most files use tabs).
        const prefix = /^\s*\S+[ \t]+/.exec(line)?.[0] ?? "URL ";
        out.push(`${prefix}${url}`, ending);
        placed = true;
      }
      continue; // drop the old line (and its ending)
    }
    out.push(line, ending);
  }
  let result = out.join("");
  if (!placed) {
    // No LEVEL line at all: append, terminating the last line first.
    if (result && !result.endsWith("\n")) result += eol;
    result += `${newLine}${eol}`;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface UrlValidation {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/** Check a download link against what the engine and clients can use. */
export function validateMissionUrl(raw: string): UrlValidation {
  const url = raw.trim();
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!url) {
    errors.push("Enter a link.");
    return { valid: false, errors, warnings };
  }
  if (!/^[\x21-\x7e]+$/.test(url)) {
    errors.push("The link must be plain ASCII with no spaces.");
  }
  if (url.length > MISSION_URL_MAX) {
    errors.push(
      `The link is ${url.length} characters; clients handle at most ${MISSION_URL_MAX} (a longer one overflows the download screen's text buffer).`,
    );
  }
  let parsed: URL | null = null;
  try {
    parsed = new URL(url);
  } catch {
    errors.push("Not a valid URL.");
  }
  if (parsed) {
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      errors.push("Clients only download http:// and https:// links.");
    } else if (!url.startsWith("http://") && !url.startsWith("https://")) {
      // The client's HTTP library matches the scheme in lower case only.
      errors.push("Write the scheme in lower case (http://).");
    }
    if (parsed.protocol === "https:") {
      warnings.push(
        "Many clients cannot fetch https:// links: 1999-era clients refuse them and current builds without TLS crash on them. Prefer http://.",
      );
    }
    if (!parsed.hostname) errors.push("The link has no host.");
    const last = url.split("?")[0].split("/").pop() ?? "";
    if (!last) {
      errors.push("The link must end in a file name (the client names the download after it).");
    } else if (!/\.(zip|mn3)$/i.test(last)) {
      warnings.push(
        "The link does not end in .zip or .mn3. Clients unzip a .zip and save anything else as the mission file.",
      );
    }
  }
  return { valid: errors.length === 0, errors, warnings };
}

/** Whether a mission filename may be rewritten at all (a plain *.mn3 basename, not retail). */
export function checkMissionFilename(file: string): string | null {
  if (!file || file !== path.basename(file) || file.includes("\\") || file.includes("\0")) {
    return "Invalid mission file name.";
  }
  if (!/\.mn3$/i.test(file)) return "Only .mn3 missions carry download links.";
  if (RETAIL_MISSIONS.has(file.toLowerCase())) {
    return "Retail missions never offer download links; the engine refuses to advertise them.";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Archive rewrite / restore
// ---------------------------------------------------------------------------

/** Copy [start, start+length) of src into dst at the dst's current end. */
async function copyRange(
  src: fs.FileHandle,
  dst: fs.FileHandle,
  start: number,
  length: number,
): Promise<void> {
  const buf = Buffer.alloc(Math.min(COPY_CHUNK, Math.max(length, 1)));
  let done = 0;
  while (done < length) {
    const want = Math.min(buf.length, length - done);
    const { bytesRead } = await src.read(buf, 0, want, start + done);
    if (bytesRead === 0) throw new Mn3Error("unexpected end of file while copying");
    await dst.write(buf, 0, bytesRead);
    done += bytesRead;
  }
}

/**
 * Read the .msn text (latin1, byte-exact) and the table of a mission file.
 * `missionFile` names the mission when `filePath` is a backup or temp copy,
 * so the same .msn is chosen as for the mission itself.
 */
export async function readMn3Msn(
  filePath: string,
  missionFile: string = filePath,
): Promise<{ text: string; table: HogTable; msn: HogEntry }> {
  const handle = await fs.open(filePath, "r");
  try {
    const table = await readHogTable(handle);
    const msn = findMsnEntry(table, missionFile);
    const blob = await readBlob(handle, msn.offset, msn.len);
    return { text: blob.toString("latin1"), table, msn };
  } finally {
    await handle.close();
  }
}

/** Rename, translating "file busy" (Windows: the server has the mission open) into a clear error. */
async function replaceFile(tempPath: string, target: string): Promise<void> {
  try {
    await fs.rename(tempPath, target);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EBUSY" || code === "EPERM" || code === "EACCES") {
      throw new Mn3Error(
        `Cannot replace ${path.basename(target)} (${code}): the file is in use or read-only. Stop the server that has this mission loaded and try again.`,
      );
    }
    throw err;
  }
}

/**
 * Write a copy of `filePath` whose .msn is `newMsn`, verify it reads back,
 * then rename it over the original.
 */
async function writeWithMsn(filePath: string, newMsn: Buffer): Promise<void> {
  const tempPath = `${filePath}${TEMP_SUFFIX}`;
  const src = await fs.open(filePath, "r");
  let dst: fs.FileHandle | null = null;
  try {
    const table = await readHogTable(src);
    const msn = findMsnEntry(table, filePath);

    dst = await fs.open(tempPath, "w");
    // Header + entry table + any gap before the payloads, with the .msn length patched.
    const head = Buffer.alloc(table.dataOffset);
    await src.read(head, 0, head.length, 0);
    head.writeUInt32LE(newMsn.length, msn.recordPos + 40);
    await dst.write(head, 0, head.length);
    await copyRange(src, dst, table.dataOffset, msn.offset - table.dataOffset);
    await dst.write(newMsn, 0, newMsn.length);
    const after = msn.offset + msn.len;
    await copyRange(src, dst, after, table.fileSize - after);
    await dst.sync();
    await dst.close();
    dst = null;

    // Read the new archive back before it replaces anything.
    const check = await readMn3Msn(tempPath, filePath);
    if (Buffer.from(check.text, "latin1").compare(newMsn) !== 0) {
      throw new Mn3Error("verification failed: the rewritten .msn does not read back");
    }
    if (check.table.nfiles !== table.nfiles) throw new Mn3Error("verification failed: entry count changed");

    await src.close();
    await replaceFile(tempPath, filePath);
  } catch (err) {
    await dst?.close().catch(() => {});
    await src.close().catch(() => {});
    await fs.unlink(tempPath).catch(() => {});
    throw err;
  }
}

export interface UrlRewriteResult {
  urls: string[];
  backupCreated: boolean;
  backupPath: string;
}

/**
 * Set the mission's download link: back the file up once, then replace its
 * mission-level URL lines with `url`.
 */
export async function setMissionUrl(filePath: string, rawUrl: string): Promise<UrlRewriteResult> {
  const nameError = checkMissionFilename(path.basename(filePath));
  if (nameError) throw new Mn3Error(nameError);
  const validation = validateMissionUrl(rawUrl);
  if (!validation.valid) throw new Mn3Error(validation.errors.join(" "));
  const url = rawUrl.trim();

  // Validates the archive before anything is copied or written.
  const { text } = await readMn3Msn(filePath);
  const newText = rewriteMsnUrls(text, url);

  const backupPath = `${filePath}${BACKUP_SUFFIX}`;
  let backupCreated = false;
  try {
    await fs.copyFile(filePath, backupPath, fsConstants.COPYFILE_EXCL);
    backupCreated = true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }

  if (newText !== text) {
    await writeWithMsn(filePath, Buffer.from(newText, "latin1"));
  }
  return { urls: readMsnUrls(newText), backupCreated, backupPath };
}

/**
 * Put the backed-up original back and delete the backup. Refuses when the
 * mission's level content no longer matches the backup (the .mn3 was
 * replaced by another version since), so a stale backup never overwrites it.
 */
export async function restoreMissionUrl(filePath: string): Promise<{ urls: string[] }> {
  const backupPath = `${filePath}${BACKUP_SUFFIX}`;
  try {
    await fs.access(backupPath);
  } catch {
    throw new Mn3Error("No Pyrodeck backup of this mission exists; its links are the original ones.");
  }
  const current = await readMn3Msn(filePath);
  const original = await readMn3Msn(backupPath, filePath);
  const sameContent =
    current.table.nfiles === original.table.nfiles &&
    current.table.entries.every((e, i) => {
      const o = original.table.entries[i];
      return e.name === o.name && (e.name === current.msn.name || e.len === o.len);
    });
  if (!sameContent) {
    throw new Mn3Error(
      `${path.basename(filePath)} no longer matches its backup (the mission was replaced). Delete ${path.basename(backupPath)} by hand if it is stale.`,
    );
  }

  const tempPath = `${filePath}${TEMP_SUFFIX}`;
  try {
    await fs.copyFile(backupPath, tempPath);
    await replaceFile(tempPath, filePath);
  } catch (err) {
    await fs.unlink(tempPath).catch(() => {});
    throw err;
  }
  await fs.unlink(backupPath);
  return { urls: readMsnUrls(original.text) };
}
