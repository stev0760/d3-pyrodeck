import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { isServableMission, type MissionHostSettings } from "./missionHostSettings.js";

/**
 * Mission host: a second HTTP listener, separate from the admin API, that
 * serves the server's custom missions to clients that join without them
 * (Quake 3 sv_allowDownload parity). It answers GET/HEAD /missions/<file>.mn3
 * and nothing else; the admin routes, auth and static files live on another
 * server object and cannot be reached through it.
 *
 * What the client does with the link, from the Matcen engine source (D3
 * 1.5-derived; Descent3/mission_download.cpp unless noted):
 *
 * - The server answers MP_ASK_FOR_URL with the URL lines of the loaded
 *   mission's .msn (msn_DoAskForURL, :515; never for the retail missions,
 *   :547). The client lists them and downloads the one picked
 *   (msn_CheckGetMission, :602) into <missions dir>/<server's mission name>
 *   (:345). A link ending in .zip is unzipped (:325, :431); anything else is
 *   saved as the .mn3 as-is, so this host serves the .mn3 itself.
 * - The current client (msn_DownloadWithStatus, :309) checks the scheme with
 *   stricmp("http:"/"https:"), splits the link at "/", and hands
 *   "scheme://host[:port]" to D3::HttpClient (netcon/inetfile/httpclient.cpp),
 *   a cpp-httplib 0.28 Client with follow_location(true) and a 5 s connect
 *   timeout. It sends "GET /<path> HTTP/1.1" (origin-form) with Host, an
 *   accept-anything Accept and Connection: close; because it passes a
 *   content receiver, httplib adds no User-Agent and no Accept-Encoding. No
 *   Range. It reads Content-Length, chunked and close-delimited bodies alike,
 *   and keeps the body only on status 200.
 * - No TLS: the fork's vcpkg manifest builds cpp-httplib with features
 *   brotli;core, so CPPHTTPLIB_OPENSSL_SUPPORT is off and httplib::Client
 *   throws std::invalid_argument on an https link, uncaught. Plain http only.
 * - Progress arithmetic (:316, :461-465): `int starttime = timer_GetTime();`
 *   then every 500 ms `time_elapsed = timer_GetTime() - starttime;` and, once
 *   httplib's progress callback has reported a Content-Length,
 *   `received_bytes / time_elapsed` as an integer division. time_elapsed is 0
 *   for up to the first wall-clock second, so a body that starts arriving in
 *   the first ~0.5 s divides by zero (SIGFPE) about half the time. httplib
 *   calls the progress callback only for bodies with a Content-Length. This
 *   host sends Content-Length (the 1999 client below relies on it) and holds
 *   each GET for FIRST_BYTE_DELAY_MS: the request left the client after it
 *   read starttime, so by the time it has seen a Content-Length a full second
 *   has passed and time_elapsed is at least 1. (The client's window freezes
 *   until the download ends, because its first check sees 0 of 0 bytes and
 *   blocks on the transfer; it does that on any slow start.)
 * - The 1999-era client (netcon/inetfile/Chttpget.cpp in the source import
 *   df209742, used by retail-derived builds) refuses any ':' after
 *   "http://" (port 80 only), sends its request with bare LF line endings
 *   (which Node's strict parser answers with 400, hence insecureHTTPParser on
 *   this listener only: it reads no bodies and proxies nothing), needs CRLF
 *   in the response, follows only 301, and stops at Content-Length.
 */

/** Hold each GET this long before the first byte (see the progress arithmetic above). */
export const FIRST_BYTE_DELAY_MS = 1000;
/** Concurrent connections; a server has at most 32 players. */
const MAX_CONNECTIONS = 64;
/** Time allowed to receive a request's headers. */
const REQUEST_TIMEOUT_MS = 10_000;

export interface MissionHostLogger {
  info(msg: string): void;
  warn(msg: string): void;
}

export interface MissionHostOptions {
  /** Directory to serve from, resolved per request; null serves nothing. */
  getMissionsDir: () => string | null;
  /** Bind address; default all interfaces. */
  host?: string;
  firstByteDelayMs?: number;
  logger?: MissionHostLogger;
}

export interface MissionHostStatus {
  enabled: boolean;
  /** The configured port, or the bound one once listening. */
  port: number;
  bound: boolean;
  /** Why the listener is not bound (bind failure), or null. */
  error: string | null;
  publicBaseUrl: string | null;
  missionsDir: string | null;
}

const BASE_HEADERS = {
  Connection: "close",
  "X-Content-Type-Options": "nosniff",
};

function sendPlain(res: http.ServerResponse, status: number, body: string, extra: Record<string, string> = {}): void {
  const buf = Buffer.from(`${body}\n`, "utf-8");
  res.writeHead(status, {
    ...BASE_HEADERS,
    ...extra,
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": String(buf.length),
  });
  res.end(buf);
}

/** The requested mission name, or null for any path but /missions/<one segment>. */
function missionNameFromUrl(rawUrl: string | undefined): string | null {
  const pathPart = (rawUrl ?? "").split("?")[0];
  const m = /^\/missions\/([^/]+)$/.exec(pathPart);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return null;
  }
}

function bindErrorMessage(port: number, err: NodeJS.ErrnoException): string {
  if (err.code === "EADDRINUSE") return `Port ${port} is already in use (EADDRINUSE).`;
  if (err.code === "EACCES") {
    return `Not allowed to listen on port ${port} (EACCES). Ports below 1024 need privileges; listen on a high port and forward the public port to it.`;
  }
  return `Cannot listen on port ${port}: ${err.message}`;
}

export class MissionHost {
  private readonly opts: MissionHostOptions;
  private settings: MissionHostSettings = { enabled: false, port: 0, publicBaseUrl: null };
  private server: http.Server | null = null;
  private boundPort: number | null = null;
  private error: string | null = null;
  private queue: Promise<void> = Promise.resolve();

  constructor(opts: MissionHostOptions) {
    this.opts = opts;
  }

  setLogger(logger: MissionHostLogger): void {
    this.opts.logger = logger;
  }

  getStatus(): MissionHostStatus {
    return {
      enabled: this.settings.enabled,
      port: this.boundPort ?? this.settings.port,
      bound: this.server !== null,
      error: this.error,
      publicBaseUrl: this.settings.publicBaseUrl,
      missionsDir: this.opts.getMissionsDir(),
    };
  }

  /**
   * Bring the listener in line with `settings`: start, stop, or move it to a
   * new port. A bind failure is reported in the status, not thrown. Calls are
   * serialized.
   */
  apply(settings: MissionHostSettings): Promise<MissionHostStatus> {
    const run = () => this.applyNow(settings);
    this.queue = this.queue.then(run, run);
    return this.queue.then(() => this.getStatus());
  }

  stop(): Promise<MissionHostStatus> {
    return this.apply({ ...this.settings, enabled: false });
  }

  private async applyNow(settings: MissionHostSettings): Promise<void> {
    const portChanged = settings.port !== this.settings.port;
    this.settings = { ...settings };
    if (!settings.enabled) {
      await this.closeServer();
      this.error = null;
      return;
    }
    if (this.server && !portChanged) return;
    await this.closeServer();
    await this.listen(settings.port);
  }

  private async listen(port: number): Promise<void> {
    const server = http.createServer(
      {
        insecureHTTPParser: true,
        requestTimeout: REQUEST_TIMEOUT_MS,
        headersTimeout: REQUEST_TIMEOUT_MS,
      },
      (req, res) => {
        this.handle(req, res).catch((err: unknown) => {
          this.opts.logger?.warn(`mission host: ${err instanceof Error ? err.message : String(err)}`);
          if (!res.headersSent) sendPlain(res, 500, "Internal error");
          else res.destroy();
        });
      },
    );
    server.maxConnections = MAX_CONNECTIONS;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen({ port, host: this.opts.host }, () => {
          server.off("error", reject);
          resolve();
        });
      });
    } catch (err) {
      this.error = bindErrorMessage(port, err as NodeJS.ErrnoException);
      this.opts.logger?.warn(`mission host: ${this.error}`);
      return;
    }
    server.on("error", (err) => this.opts.logger?.warn(`mission host: ${err.message}`));
    const addr = server.address();
    this.server = server;
    this.boundPort = typeof addr === "object" && addr ? addr.port : port;
    this.error = null;
    this.opts.logger?.info(`mission host listening on port ${this.boundPort}`);
  }

  private async closeServer(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.boundPort = null;
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const name = missionNameFromUrl(req.url);
    if (req.method !== "GET" && req.method !== "HEAD") {
      if (name === null) return sendPlain(res, 404, "Not found");
      return sendPlain(res, 405, "Method not allowed", { Allow: "GET, HEAD" });
    }
    const missionsDir = this.opts.getMissionsDir();
    if (name === null || !missionsDir) return sendPlain(res, 404, "Not found");

    let entries: string[];
    try {
      entries = await fs.readdir(missionsDir);
    } catch {
      return sendPlain(res, 404, "Not found");
    }
    if (!isServableMission(name, entries)) return sendPlain(res, 404, "Not found");

    let handle: fs.FileHandle;
    try {
      handle = await fs.open(path.join(missionsDir, name), "r");
    } catch {
      return sendPlain(res, 404, "Not found");
    }
    let streaming = false;
    try {
      // Size and bytes both come from this descriptor: a mission-link rewrite
      // renames a new file over the name, and this response keeps the old one.
      const stat = await handle.stat();
      if (!stat.isFile()) return sendPlain(res, 404, "Not found");

      if (req.method === "GET") {
        const delay = this.opts.firstByteDelayMs ?? FIRST_BYTE_DELAY_MS;
        if (delay > 0) {
          const gone = new AbortController();
          const onClose = () => gone.abort();
          res.once("close", onClose);
          try {
            await sleep(delay, undefined, { signal: gone.signal });
          } catch {
            return; // the client went away
          } finally {
            res.off("close", onClose);
          }
        }
      }

      res.writeHead(200, {
        ...BASE_HEADERS,
        "Content-Type": "application/octet-stream",
        "Content-Length": String(stat.size),
        "Accept-Ranges": "none",
      });
      if (req.method === "HEAD" || stat.size === 0) {
        res.end();
        return;
      }
      streaming = true;
      const stream = handle.createReadStream({ start: 0, end: stat.size - 1 });
      try {
        await pipeline(stream, res);
        const who = req.socket.remoteAddress ?? "?";
        this.opts.logger?.info(`mission host: sent ${name} (${stat.size} bytes) to ${who}`);
      } catch (err) {
        // Most often the player cancelled the download.
        this.opts.logger?.warn(
          `mission host: ${name} not completed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } finally {
      // createReadStream closes the handle itself when it ends or fails.
      if (!streaming) await handle.close().catch(() => {});
    }
  }
}
