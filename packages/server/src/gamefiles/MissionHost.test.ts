import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { FIRST_BYTE_DELAY_MS, MissionHost } from "./MissionHost.js";

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

/** A request whose path goes on the wire exactly as given (no normalization). */
function request(port: number, rawPath: string, method = "GET", headers: Record<string, string> = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: rawPath, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}

/** Raw bytes on a socket, read until the server closes it. */
function rawExchange(port: number, bytes: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const sock = net.connect(port, "127.0.0.1", () => sock.write(bytes));
    sock.on("data", (c: Buffer) => chunks.push(c));
    sock.on("end", () => resolve(Buffer.concat(chunks)));
    sock.on("error", reject);
    sock.setTimeout(5000, () => sock.destroy(new Error("timeout")));
  });
}

describe("MissionHost listener", () => {
  let root: string;
  let missionsDir: string;
  let host: MissionHost;
  let port: number;
  const mission = Buffer.from(Array.from({ length: 300_000 }, (_, i) => (i * 7) % 256));

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "pyrodeck-host-"));
    missionsDir = path.join(root, "missions");
    await fs.mkdir(missionsDir);
    await fs.writeFile(path.join(missionsDir, "bedlam.mn3"), mission);
    await fs.writeFile(path.join(missionsDir, "My Map.mn3"), Buffer.from("spaced"));
    await fs.writeFile(path.join(missionsDir, "d3.mn3"), Buffer.from("retail"));
    await fs.writeFile(path.join(missionsDir, "bedlam.mn3.pyrodeck-orig"), Buffer.from("backup"));
    await fs.writeFile(path.join(missionsDir, "readme.txt"), Buffer.from("text"));
    await fs.mkdir(path.join(missionsDir, "dir.mn3"));
    await fs.writeFile(path.join(root, "secret.mn3"), Buffer.from("outside the missions dir"));

    host = new MissionHost({ getMissionsDir: () => missionsDir, host: "127.0.0.1", firstByteDelayMs: 0 });
    const status = await host.apply({ enabled: true, port: 0, publicBaseUrl: "http://127.0.0.1" });
    expect(status.bound).toBe(true);
    port = status.port;
  });

  afterAll(async () => {
    await host.stop();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("streams a listed .mn3 byte-identical, with Content-Length and no chunking", async () => {
    const res = await request(port, "/missions/bedlam.mn3");
    expect(res.status).toBe(200);
    expect(res.headers["content-length"]).toBe(String(mission.length));
    expect(res.headers["content-type"]).toBe("application/octet-stream");
    expect(res.headers["transfer-encoding"]).toBeUndefined();
    expect(res.headers.connection).toBe("close");
    expect(res.body.equals(mission)).toBe(true);
  });

  it("decodes a percent-encoded name", async () => {
    const res = await request(port, "/missions/My%20Map.mn3");
    expect(res.status).toBe(200);
    expect(res.body.toString()).toBe("spaced");
  });

  it("answers HEAD with the length and no body, and ignores Range", async () => {
    const head = await request(port, "/missions/bedlam.mn3", "HEAD");
    expect(head.status).toBe(200);
    expect(head.headers["content-length"]).toBe(String(mission.length));
    expect(head.body.length).toBe(0);

    const ranged = await request(port, "/missions/bedlam.mn3", "GET", { Range: "bytes=100-199" });
    expect(ranged.status).toBe(200);
    expect(ranged.headers["accept-ranges"]).toBe("none");
    expect(ranged.body.length).toBe(mission.length);
  });

  it.each([
    ["a retail mission, even when present", "/missions/d3.mn3"],
    ["a traversal path", "/missions/../secret.mn3"],
    ["an encoded traversal", "/missions/..%2fsecret.mn3"],
    ["an encoded traversal (dots too)", "/missions/%2e%2e%2fsecret.mn3"],
    ["a nested path", "/missions/sub/bedlam.mn3"],
    ["a non-.mn3 file", "/missions/readme.txt"],
    ["a backup copy", "/missions/bedlam.mn3.pyrodeck-orig"],
    ["a directory named .mn3", "/missions/dir.mn3"],
    ["an unknown file", "/missions/nothere.mn3"],
    ["a wrong-case name", "/missions/Bedlam.mn3"],
    ["a broken escape", "/missions/%E0%A4%A.mn3"],
    ["the missions directory", "/missions/"],
    ["the root", "/"],
    ["an admin API path", "/api/health"],
    ["another admin API path", "/api/pyrodeck/config"],
    ["a login path", "/api/auth/login"],
  ])("404s %s", async (_label, rawPath) => {
    const res = await request(port, rawPath);
    expect(res.status).toBe(404);
    expect(res.body.toString()).toBe("Not found\n");
  });

  it("refuses other methods", async () => {
    expect((await request(port, "/missions/bedlam.mn3", "POST")).status).toBe(405);
    expect((await request(port, "/api/auth/login", "POST")).status).toBe(404);
  });

  it("serves the 1999-era client's bare-LF request (Chttpget.cpp)", async () => {
    const reply = await rawExchange(
      port,
      "GET /missions/bedlam.mn3 HTTP/1.1\nAccept: */*\nAccept-Encoding: deflate\nHost: 127.0.0.1\n\n\n",
    );
    const headerEnd = reply.indexOf("\r\n\r\n");
    const head = reply.subarray(0, headerEnd).toString("latin1");
    expect(head).toMatch(/^HTTP\/1\.1 200 /);
    expect(head).toMatch(new RegExp(`\r\nContent-Length: ${mission.length}\r\n`));
    expect(reply.subarray(headerEnd + 4).equals(mission)).toBe(true);
  });

  it("follows the configured directory per request", async () => {
    const other = path.join(root, "other");
    await fs.mkdir(other, { recursive: true });
    await fs.writeFile(path.join(other, "fresh.mn3"), Buffer.from("fresh"));
    const moved = new MissionHost({ getMissionsDir: () => other, host: "127.0.0.1", firstByteDelayMs: 0 });
    const status = await moved.apply({ enabled: true, port: 0, publicBaseUrl: "http://127.0.0.1" });
    try {
      expect((await request(status.port, "/missions/fresh.mn3")).status).toBe(200);
      expect((await request(status.port, "/missions/bedlam.mn3")).status).toBe(404);
    } finally {
      await moved.stop();
    }
  });
});

describe("MissionHost lifecycle", () => {
  let missionsDir: string;

  beforeAll(async () => {
    missionsDir = await fs.mkdtemp(path.join(os.tmpdir(), "pyrodeck-host-life-"));
    await fs.writeFile(path.join(missionsDir, "bedlam.mn3"), Buffer.from("mission"));
  });

  afterAll(async () => {
    await fs.rm(missionsDir, { recursive: true, force: true });
  });

  it("holds the first byte of a GET (not a HEAD) for the configured delay", async () => {
    expect(FIRST_BYTE_DELAY_MS).toBeGreaterThanOrEqual(1000);
    const host = new MissionHost({ getMissionsDir: () => missionsDir, host: "127.0.0.1", firstByteDelayMs: 250 });
    const { port } = await host.apply({ enabled: true, port: 0, publicBaseUrl: "http://127.0.0.1" });
    try {
      let t = Date.now();
      expect((await request(port, "/missions/bedlam.mn3")).status).toBe(200);
      expect(Date.now() - t).toBeGreaterThanOrEqual(240);
      t = Date.now();
      expect((await request(port, "/missions/bedlam.mn3", "HEAD")).status).toBe(200);
      expect(Date.now() - t).toBeLessThan(240);
    } finally {
      await host.stop();
    }
  });

  it("starts, stops and reports a bind failure without throwing", async () => {
    const blocker = net.createServer();
    await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", () => r()));
    const busyPort = (blocker.address() as net.AddressInfo).port;
    const host = new MissionHost({ getMissionsDir: () => missionsDir, host: "127.0.0.1", firstByteDelayMs: 0 });
    try {
      const busy = await host.apply({ enabled: true, port: busyPort, publicBaseUrl: "http://127.0.0.1" });
      expect(busy.bound).toBe(false);
      expect(busy.error).toMatch(/EADDRINUSE/);

      const up = await host.apply({ enabled: true, port: 0, publicBaseUrl: "http://127.0.0.1" });
      expect(up.bound).toBe(true);
      expect(up.error).toBeNull();
      expect((await request(up.port, "/missions/bedlam.mn3")).status).toBe(200);

      const down = await host.apply({ enabled: false, port: 0, publicBaseUrl: "http://127.0.0.1" });
      expect(down.bound).toBe(false);
      await expect(request(up.port, "/missions/bedlam.mn3")).rejects.toThrow(/ECONNREFUSED/);
    } finally {
      await host.stop();
      await new Promise<void>((r) => blocker.close(() => r()));
    }
  });
});
