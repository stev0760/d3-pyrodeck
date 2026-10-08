import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import net from "node:net";
import nodemailer from "nodemailer";
import {
  MailBatcher,
  composeMail,
  describeEvent,
  isSelected,
  sendMail,
  smtpTransportOptions,
  type DescribedEvent,
} from "./MailNotifier.js";
import {
  DEFAULT_MAIL_EVENTS,
  DEFAULT_MAIL_SETTINGS,
  sanitizeStoredMail,
  toMailView,
  validateMailSettings,
} from "./mailSettings.js";

const ev = (text: string, key = text): DescribedEvent => ({ at: Date.now(), profileId: "p1", text, categories: ["crashed"], key });

describe("MailBatcher", () => {
  let sent: string[][];
  let batcher: MailBatcher;

  beforeEach(() => {
    vi.useFakeTimers();
    sent = [];
    batcher = new MailBatcher({
      minIntervalMs: 60_000,
      gatherMs: 10_000,
      send: async (events) => {
        sent.push(events.map((e) => e.text));
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends a burst as one mail after the gather delay", async () => {
    batcher.push(ev("crashed"));
    await vi.advanceTimersByTimeAsync(4_000);
    batcher.push(ev("relaunched"));
    expect(sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(sent).toEqual([["crashed", "relaunched"]]);
  });

  it("sends at most one mail per minute, listing what arrived in between", async () => {
    batcher.push(ev("a"));
    await vi.advanceTimersByTimeAsync(10_000); // first mail at 10 s
    expect(sent).toHaveLength(1);
    batcher.push(ev("b"));
    await vi.advanceTimersByTimeAsync(20_000);
    batcher.push(ev("c"));
    await vi.advanceTimersByTimeAsync(39_000); // 59 s after the first mail
    expect(sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sent).toEqual([["a"], ["b", "c"]]);
  });

  it("lists an event emitted twice once", async () => {
    batcher.push(ev("started", "k"));
    batcher.push(ev("started", "k"));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sent).toEqual([["started"]]);
  });

  it("drops the queue when cleared", async () => {
    batcher.push(ev("a"));
    batcher.clear();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sent).toEqual([]);
    expect(batcher.pending()).toBe(0);
  });
});

describe("describeEvent", () => {
  it("maps start reasons to their checklist entries; playlist restarts are never mailed", () => {
    const started = (reason: "manual" | "playlist" | "relaunch" | "schedule") =>
      describeEvent("server.started", { profileId: "p1", pid: 42, args: [], reason }).categories;
    expect(started("manual")).toEqual(["started"]);
    expect(started("relaunch")).toEqual(["relaunched"]);
    expect(started("schedule")).toEqual(["started", "schedule"]);
    expect(started("playlist")).toEqual([]);
  });

  it("describes crashes, hangs, kicks, bans and skipped schedule actions", () => {
    expect(describeEvent("server.crashed", { profileId: "p1", pid: 1, code: null, signal: "SIGSEGV" }).text).toBe(
      "Server crashed (signal SIGSEGV)",
    );
    expect(describeEvent("server.hung", { profileId: "p1", pid: 1, silentForMs: 120_400 }).text).toBe(
      "Server stopped answering its console (120 s)",
    );
    const kick = describeEvent("player.kicked", { profileId: "p1", name: "Griefer", ip: "203.0.113.9", reason: "spam" });
    expect(kick).toMatchObject({ text: "Kicked Griefer (203.0.113.9): spam", categories: ["kicked"] });
    expect(describeEvent("player.banned", { profileId: "p1", name: "X", reason: "operator" }).categories).toEqual(["banned"]);
    expect(
      describeEvent("player.banned", { profileId: "p1", name: "X", reason: "profanity (third warning)" }).categories,
    ).toEqual(["profanityBan"]);
    expect(describeEvent("schedule.skipped", { profileId: "p1", action: "start", reason: "busy" }).text).toBe(
      "Scheduled start skipped: busy",
    );
  });

  it("is selected when any of its checklist entries is ticked", () => {
    const e = describeEvent("server.started", { profileId: "p1", pid: 1, args: [], reason: "schedule" });
    expect(isSelected(e, { ...DEFAULT_MAIL_EVENTS, started: false, schedule: true })).toBe(true);
    expect(isSelected(e, { ...DEFAULT_MAIL_EVENTS, started: false, schedule: false })).toBe(false);
  });
});

describe("composeMail", () => {
  it("puts the first event and the count in the subject and lists every event", () => {
    const events = [
      { ...ev("Server crashed (exit code 139)"), at: new Date(2026, 9, 7, 21, 4, 5).getTime() },
      { ...ev("Server relaunched by Pyrodeck (PID 7)"), at: new Date(2026, 9, 7, 21, 4, 9).getTime() },
    ];
    const mail = composeMail(events, new Map([["p1", "Friday CTF"]]), { host: "box" });
    expect(mail.subject).toBe("[Pyrodeck box] Friday CTF: Server crashed (exit code 139) (+1 more)");
    expect(mail.text).toContain("2026-10-07 21:04:05  [Friday CTF] Server crashed (exit code 139)");
    expect(mail.text).toContain("2026-10-07 21:04:09  [Friday CTF] Server relaunched by Pyrodeck (PID 7)");
    const capped = composeMail(events, new Map(), { host: "box", dropped: 3 });
    expect(capped.subject).toMatch(/\(\+4 more\)$/);
    expect(capped.text).toContain("… and 3 more events.");
  });
});

describe("sendMail", () => {
  const settings = {
    ...DEFAULT_MAIL_SETTINGS,
    enabled: true,
    host: "smtp.example.org",
    user: "alerts@example.org",
    password: "hunter2",
    from: "alerts@example.org",
    recipients: ["op@example.org", "second@example.org"],
  };

  it("builds the message nodemailer would send (jsonTransport, nothing leaves the machine)", async () => {
    const json = nodemailer.createTransport({ jsonTransport: true });
    let raw = "";
    const transport = {
      sendMail: async (data: Parameters<typeof json.sendMail>[0]) => {
        const info = await json.sendMail(data);
        raw = info.message;
        return info;
      },
    };
    const result = await sendMail(settings, { subject: "Server crashed", text: "body" }, transport);
    expect(result.ok).toBe(true);
    const message = JSON.parse(raw) as { from: { address: string }; to: { address: string }[]; subject: string; text: string };
    expect(message.from.address).toBe("alerts@example.org");
    expect(message.to.map((t) => t.address)).toEqual(["op@example.org", "second@example.org"]);
    expect(message.subject).toBe("Server crashed");
    expect(message.text).toBe("body");
    expect(raw).not.toContain("hunter2");
  });

  it("delivers over SMTP to a local sink, with the password only in AUTH", async () => {
    const sink = await smtpSink();
    try {
      const result = await sendMail(
        { ...settings, host: "127.0.0.1", port: sink.port, tls: "none" },
        composeMail([ev("Server crashed (signal SIGSEGV)")], new Map([["p1", "Friday CTF"]]), { host: "box" }),
      );
      expect(result).toMatchObject({ ok: true, accepted: ["op@example.org", "second@example.org"], rejected: [] });
      expect(sink.got.auth).toEqual(["alerts@example.org", "hunter2"]);
      expect(sink.got.rcpt).toEqual(["op@example.org", "second@example.org"]);
      expect(sink.got.data).toContain("Subject: [Pyrodeck box] Friday CTF: Server crashed (signal SIGSEGV)");
      expect(sink.got.data).not.toContain("hunter2");
    } finally {
      sink.close();
    }
  });

  it("returns a transport failure as an error, not a throw", async () => {
    const failing = { sendMail: async () => Promise.reject(new Error("connect ECONNREFUSED 127.0.0.1:25")) };
    const result = await sendMail(settings, { subject: "x", text: "y" }, failing);
    expect(result).toMatchObject({ ok: false, error: "connect ECONNREFUSED 127.0.0.1:25" });
  });

  it("maps the security setting to nodemailer's options", () => {
    expect(smtpTransportOptions({ ...settings, tls: "tls", port: 465 })).toMatchObject({ secure: true, requireTLS: false, ignoreTLS: false });
    expect(smtpTransportOptions({ ...settings, tls: "starttls" })).toMatchObject({ secure: false, requireTLS: true, ignoreTLS: false });
    expect(smtpTransportOptions({ ...settings, tls: "none" })).toMatchObject({ secure: false, requireTLS: false, ignoreTLS: true });
    expect(smtpTransportOptions({ ...settings, user: "" }).auth).toBeUndefined();
  });
});

describe("validateMailSettings", () => {
  it("is off by default and never reports the password", () => {
    expect(DEFAULT_MAIL_SETTINGS.enabled).toBe(false);
    const view = toMailView({ ...DEFAULT_MAIL_SETTINGS, password: "hunter2" });
    expect(view).not.toHaveProperty("password");
    expect(view.passwordSet).toBe(true);
    expect(JSON.stringify(view)).not.toContain("hunter2");
  });

  it("keeps the stored password when none is sent and clears it on an empty string", () => {
    const current = { ...DEFAULT_MAIL_SETTINGS, password: "hunter2" };
    expect(validateMailSettings({ host: "smtp.example.org" }, current).settings.password).toBe("hunter2");
    expect(validateMailSettings({ password: "" }, current).settings.password).toBe("");
  });

  it("needs host, From and a recipient to enable, and checks the addresses", () => {
    expect(validateMailSettings({ enabled: true }).errors).toHaveLength(3);
    const ok = validateMailSettings({
      enabled: true,
      host: "smtp.example.org",
      user: "alerts@example.org",
      recipients: "op@example.org, second@example.org",
    });
    expect(ok.errors).toEqual([]);
    expect(ok.settings.from).toBe("alerts@example.org"); // From defaults to the login when it is an address
    expect(ok.settings.recipients).toEqual(["op@example.org", "second@example.org"]);
    expect(validateMailSettings({ recipients: ["not an address", "x@y.org\r\nBcc: z@q.org"] }).errors).toHaveLength(1);
    expect(validateMailSettings({ host: "smtp.example.org\r\nRCPT" }).errors.length).toBeGreaterThan(0);
  });

  it("defaults the port to the security mode and warns about plain-text logins", () => {
    expect(validateMailSettings({ tls: "tls" }).settings.port).toBe(465);
    const plain = validateMailSettings({ tls: "none", user: "u" });
    expect(plain.settings.port).toBe(25);
    expect(plain.warnings).toHaveLength(1);
  });

  it("loads stored settings that no longer validate as disabled", () => {
    expect(sanitizeStoredMail({ enabled: true, host: "" }).enabled).toBe(false);
    expect(sanitizeStoredMail(undefined)).toEqual(DEFAULT_MAIL_SETTINGS);
  });
});

/**
 * A minimal SMTP sink on 127.0.0.1 (no TLS): enough of RFC 5321 and
 * AUTH PLAIN for nodemailer to deliver one message.
 */
async function smtpSink() {
  const got = { auth: [] as string[], rcpt: [] as string[], data: "" };
  const server = net.createServer((socket) => {
    let buf = "";
    let inData = false;
    const reply = (line: string) => socket.write(`${line}\r\n`);
    reply("220 sink ESMTP");
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf-8");
      for (;;) {
        if (inData) {
          const end = buf.indexOf("\r\n.\r\n");
          if (end < 0) return;
          got.data = buf.slice(0, end);
          buf = buf.slice(end + 5);
          inData = false;
          reply("250 queued");
          continue;
        }
        const nl = buf.indexOf("\r\n");
        if (nl < 0) return;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        const [verb, , initial] = line.split(" ");
        switch (verb.toUpperCase()) {
          case "EHLO":
            reply("250-sink");
            reply("250 AUTH PLAIN");
            break;
          case "AUTH": {
            // AUTH PLAIN <base64 of "\0user\0password">
            const [, user, pass] = Buffer.from(initial ?? "", "base64").toString("utf-8").split("\0");
            got.auth = [user, pass];
            reply("235 ok");
            break;
          }
          case "RCPT":
            got.rcpt.push(/<([^>]+)>/.exec(line)?.[1] ?? "");
            reply("250 ok");
            break;
          case "DATA":
            inData = true;
            reply("354 go");
            break;
          case "QUIT":
            socket.end("221 bye\r\n");
            return;
          default:
            reply("250 ok");
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { got, port: (server.address() as net.AddressInfo).port, close: () => server.close() };
}
