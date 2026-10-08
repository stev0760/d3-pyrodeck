import { describe, it, expect } from "vitest";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { TelnetConnection } from "./TelnetConnection.js";

// Test the echo stripping logic by accessing it through a subclass
class TestableConnection extends TelnetConnection {
  // Expose stripEcho for direct testing
  testStripEcho(command: string, response: string): string {
    // @ts-expect-error accessing private method for testing
    return this.stripEcho(command, response);
  }

  testStripColors(data: Buffer): { cleaned: Buffer; carry: Buffer } {
    // @ts-expect-error accessing private method for testing
    return this.stripD3ColorCodes(data);
  }
}

describe("TelnetConnection echo stripping", () => {
  const conn = new TestableConnection();

  it("strips command echo with IP prefix", () => {
    const response = [
      "[127.0.0.1] $servercaps",
      "SERVERCAPS version=1 fork=Matcen fork_version=0.8.0 features=bots",
    ].join("\n");

    const result = conn.testStripEcho("$servercaps", response);
    expect(result).toBe(
      "SERVERCAPS version=1 fork=Matcen fork_version=0.8.0 features=bots",
    );
  });

  it("strips echo with different IP", () => {
    const response = [
      "[192.168.1.50] $scores",
      "Pilot                Points K D S Ping",
      "Viper[BOT]:          5      6 1 1 0",
    ].join("\n");

    const result = conn.testStripEcho("$scores", response);
    expect(result).toContain("Pilot");
    expect(result).toContain("Viper[BOT]");
    expect(result).not.toContain("[192.168.1.50]");
  });

  it("returns response unchanged when no echo present", () => {
    const response = "No bots active";
    const result = conn.testStripEcho("$botlist", response);
    expect(result).toBe("No bots active");
  });

  it("handles empty response", () => {
    const result = conn.testStripEcho("$help", "");
    expect(result).toBe("");
  });
});

describe("TelnetConnection color-code stripping", () => {
  const conn = new TestableConnection();

  it("strips a complete \\x01+RGB marker", () => {
    const buf = Buffer.concat([
      Buffer.from("Hi"),
      Buffer.from([0x01, 0xff, 0x00, 0x00]),
      Buffer.from("there"),
    ]);
    const { cleaned, carry } = conn.testStripColors(buf);
    expect(cleaned.toString("utf-8")).toBe("Hithere");
    expect(carry.length).toBe(0);
  });

  it("strips null line-prefix bytes", () => {
    const buf = Buffer.from([0x00, 0x41, 0x00, 0x42]); // \0 A \0 B
    const { cleaned } = conn.testStripColors(buf);
    expect(cleaned.toString("utf-8")).toBe("AB");
  });

  it("carries a marker split across chunks instead of leaking bytes", () => {
    // Chunk 1 ends mid-marker: "A" + \x01 + R (G and B not yet arrived)
    const chunk1 = Buffer.concat([Buffer.from("A"), Buffer.from([0x01, 0xaa])]);
    const r1 = conn.testStripColors(chunk1);
    expect(r1.cleaned.toString("utf-8")).toBe("A");
    expect([...r1.carry]).toEqual([0x01, 0xaa]); // held back, not leaked

    // Chunk 2 supplies the rest of the RGB plus real text
    const chunk2 = Buffer.concat([Buffer.from([0xbb, 0xcc]), Buffer.from("B")]);
    const r2 = conn.testStripColors(Buffer.concat([r1.carry, chunk2]));
    expect(r2.cleaned.toString("utf-8")).toBe("B");
    expect(r2.carry.length).toBe(0);
  });
});

describe("TelnetConnection login refusals", () => {
  /** A console stand-in on 127.0.0.1 that handles each connection with `onConnection`. */
  async function withConsole(onConnection: (socket: net.Socket) => void, run: (port: number) => Promise<void>): Promise<void> {
    const server = net.createServer(onConnection);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      await run((server.address() as AddressInfo).port);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  it("says the server closed before the prompt when it refuses the peer (AllowRemoteConsole=0)", async () => {
    await withConsole(
      (socket) => socket.end(),
      async (port) => {
        await expect(new TelnetConnection().connect("127.0.0.1", port, "pw")).rejects.toThrow(
          /closed the connection before asking for the password/,
        );
      },
    );
  });

  it("says authentication failed when it closes after the password", async () => {
    await withConsole(
      (socket) => {
        socket.write("Enter server password: ");
        socket.once("data", () => socket.end());
      },
      async (port) => {
        await expect(new TelnetConnection().connect("127.0.0.1", port, "wrong")).rejects.toThrow(/^Authentication failed/);
      },
    );
  });
});
