import { describe, it, expect } from "vitest";
import { TelnetConnection } from "./TelnetConnection.js";

// Test the echo stripping logic by accessing it through a subclass
class TestableConnection extends TelnetConnection {
  // Expose stripEcho for direct testing
  testStripEcho(command: string, response: string): string {
    // @ts-expect-error accessing private method for testing
    return this.stripEcho(command, response);
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
      "Viper [BOT]:         5      6 1 1 0",
    ].join("\n");

    const result = conn.testStripEcho("$scores", response);
    expect(result).toContain("Pilot");
    expect(result).toContain("Viper [BOT]");
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
