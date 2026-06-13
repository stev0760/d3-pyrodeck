import net from "node:net";
import type { ServerConnection } from "./ServerConnection.js";

const RESPONSE_TIMEOUT_MS = 200;
const CONNECT_TIMEOUT_MS = 5000;
const AUTH_TIMEOUT_MS = 5000;

interface QueuedCommand {
  command: string;
  resolve: (response: string) => void;
  reject: (error: Error) => void;
}

/**
 * Raw TCP connection to a D3 dedicated server's remote console.
 *
 * D3's "telnet" console is plain TCP text — no IAC negotiation needed.
 * Commands are sent one at a time via a serial queue to prevent output
 * interleaving. Responses are collected using a silence timeout (~200ms).
 */
export class TelnetConnection implements ServerConnection {
  private socket: net.Socket | null = null;
  private connected = false;
  private dataCallbacks: Array<(data: string) => void> = [];
  private disconnectCallbacks: Array<(reason: string) => void> = [];

  private commandQueue: QueuedCommand[] = [];
  private processing = false;

  isConnected(): boolean {
    return this.connected;
  }

  async connect(host: string, port: number, password: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new net.Socket();
      let settled = false;

      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          socket.destroy();
          reject(new Error(`Connection to ${host}:${port} timed out`));
        }
      }, CONNECT_TIMEOUT_MS);

      socket.connect(port, host, () => {
        clearTimeout(timeout);
        this.socket = socket;
        this.connected = true;
        // Authenticate BEFORE setting up general listeners so auth handler
        // has exclusive access to incoming data.
        this.authenticate(password).then(
          () => {
            if (!settled) {
              settled = true;
              this.setupListeners();
              resolve();
            }
          },
          (err) => {
            if (!settled) {
              settled = true;
              this.disconnect();
              reject(err);
            }
          },
        );
      });

      socket.on("error", (err: NodeJS.ErrnoException) => {
        clearTimeout(timeout);
        if (!settled) {
          settled = true;
          reject(new Error(`Connection failed: ${err.message || err.code || String(err)}`));
        }
      });
    });
  }

  private setupListeners(): void {
    if (!this.socket) return;

    this.socket.on("data", (chunk: Buffer) => {
      // Strip D3's inline color codes from raw bytes before UTF-8 conversion.
      // D3 uses \x01 + 3 RGB bytes as color markers. These bytes can be any
      // value and produce garbled text if converted to UTF-8 as-is.
      const cleaned = this.stripD3ColorCodes(chunk);
      const text = cleaned.toString("utf-8");

      // Emit cleaned data to all listeners (for console passthrough)
      for (const cb of this.dataCallbacks) {
        cb(text);
      }
    });

    this.socket.on("close", () => {
      this.connected = false;
      for (const cb of this.disconnectCallbacks) {
        cb("Connection closed");
      }
    });

    this.socket.on("error", (err) => {
      this.connected = false;
      for (const cb of this.disconnectCallbacks) {
        cb(`Connection error: ${err.message}`);
      }
    });
  }

  /**
   * D3 console auth: server sends a password prompt, we send the password.
   * If auth fails, the server closes the connection.
   */
  private async authenticate(password: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.socket) {
        reject(new Error("Not connected"));
        return;
      }

      let authBuffer = "";
      let passwordSent = false;
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("Authentication timed out"));
      }, AUTH_TIMEOUT_MS);

      const onData = (chunk: Buffer) => {
        // Strip D3 color codes before converting to text
        const cleaned = this.stripD3ColorCodes(chunk);
        const text = cleaned.toString("utf-8");
        authBuffer += text;

        // D3 sends "Enter server password:" prompt. Send password exactly once.
        if (!passwordSent && authBuffer.toLowerCase().includes("password")) {
          passwordSent = true;
          this.socket!.write(password + "\r\n");

          // D3 closes the connection on bad password, stays open on good.
          // After sending password, wait briefly then resolve if still connected.
          setTimeout(() => {
            if (this.connected) {
              cleanup();
              resolve();
            }
          }, 1000);
        }
      };

      const onClose = () => {
        cleanup();
        reject(new Error("Authentication failed — server closed connection"));
      };

      const cleanup = () => {
        clearTimeout(timeout);
        this.socket?.removeListener("data", onData);
        this.socket?.removeListener("close", onClose);
      };

      this.socket.on("data", onData);
      this.socket.on("close", onClose);
    });
  }

  /**
   * Send a command and collect the response.
   * Commands are queued and executed serially to prevent output interleaving.
   */
  async send(command: string): Promise<string> {
    if (!this.connected || !this.socket) {
      throw new Error("Not connected");
    }

    return new Promise((resolve, reject) => {
      this.commandQueue.push({ command, resolve, reject });
      this.processQueue();
    });
  }

  private async processQueue(): Promise<void> {
    if (this.processing || this.commandQueue.length === 0) return;
    this.processing = true;

    while (this.commandQueue.length > 0) {
      const item = this.commandQueue.shift()!;
      try {
        const response = await this.executeCommand(item.command);
        item.resolve(response);
      } catch (err) {
        item.reject(err instanceof Error ? err : new Error(String(err)));
      }
    }

    this.processing = false;
  }

  /**
   * Execute a single command: send it, then collect output using a
   * silence-based timeout. D3 has no response terminators, so we wait
   * for output to settle (~200ms of silence) before returning.
   *
   * The command echo (e.g. "[127.0.0.1] $servercaps") is stripped.
   */
  private executeCommand(command: string): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!this.socket || !this.connected) {
        reject(new Error("Not connected"));
        return;
      }

      let responseBuffer = "";
      let silenceTimer: ReturnType<typeof setTimeout> | null = null;

      const onData = (chunk: Buffer) => {
        const cleaned = this.stripD3ColorCodes(chunk);
        responseBuffer += cleaned.toString("utf-8");

        // Reset the silence timer on each chunk
        if (silenceTimer) clearTimeout(silenceTimer);
        silenceTimer = setTimeout(() => {
          cleanup();
          resolve(this.stripEcho(command, responseBuffer));
        }, RESPONSE_TIMEOUT_MS);
      };

      const onClose = () => {
        cleanup();
        if (responseBuffer) {
          resolve(this.stripEcho(command, responseBuffer));
        } else {
          reject(new Error("Connection closed during command"));
        }
      };

      const cleanup = () => {
        if (silenceTimer) clearTimeout(silenceTimer);
        this.socket?.removeListener("data", onData);
        this.socket?.removeListener("close", onClose);
      };

      this.socket.on("data", onData);
      this.socket.on("close", onClose);

      // Send the command
      this.socket.write(command + "\r\n");

      // Start initial silence timer in case there's no response at all
      silenceTimer = setTimeout(() => {
        cleanup();
        resolve(this.stripEcho(command, responseBuffer));
      }, RESPONSE_TIMEOUT_MS);
    });
  }

  /**
   * Strip D3's inline color codes from raw byte data.
   * D3 uses \x01 followed by 3 RGB bytes as color markers.
   * These must be removed before UTF-8 conversion to avoid garbled output.
   */
  private stripD3ColorCodes(data: Buffer): Buffer {
    const result: number[] = [];
    let i = 0;
    while (i < data.length) {
      // Strip null bytes — D3 sends \x00 as line prefixes in some responses
      if (data[i] === 0x00) {
        i++;
        continue;
      }
      if (data[i] === 0x01 && i + 3 < data.length) {
        // Skip the \x01 marker and 3 RGB bytes
        i += 4;
      } else {
        result.push(data[i]);
        i++;
      }
    }
    return Buffer.from(result);
  }

  /**
   * Strip the command echo line from the response.
   * D3 echoes commands back prefixed with the client IP:
   *   [127.0.0.1] $servercaps
   */
  private stripEcho(command: string, response: string): string {
    const lines = response.split("\n");
    const filtered = lines.filter((line) => {
      const trimmed = line.trim();
      // Match echo pattern: optional [IP] prefix followed by the command
      if (trimmed.match(/^(\[[\d.]+\]\s*)?/) && trimmed.includes(command)) {
        // Only strip if the line is just the echo (with optional IP prefix), not a data line
        const withoutIp = trimmed.replace(/^\[[\d.]+\]\s*/, "");
        if (withoutIp === command) return false;
      }
      return true;
    });
    return filtered.join("\n").trim();
  }

  onData(callback: (data: string) => void): void {
    this.dataCallbacks.push(callback);
  }

  onDisconnect(callback: (reason: string) => void): void {
    this.disconnectCallbacks.push(callback);
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this.dataCallbacks = [];
    this.disconnectCallbacks = [];
    this.commandQueue = [];
    this.processing = false;
  }
}
