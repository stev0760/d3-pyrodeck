import { describe, it, expect } from "vitest";
import { ConsoleQuitWatch, parseConsoleQuit } from "./consoleQuit.js";

describe("parseConsoleQuit", () => {
  it("reads the echo of a console quit", () => {
    expect(parseConsoleQuit("[127.0.0.1] quit")).toBe("127.0.0.1");
    expect(parseConsoleQuit("[10.0.0.5] QUIT now\r")).toBe("10.0.0.5");
  });

  it("returns null for anything else", () => {
    expect(parseConsoleQuit("[127.0.0.1] $quit")).toBeNull();
    expect(parseConsoleQuit("[127.0.0.1] quitter")).toBeNull();
    expect(parseConsoleQuit("*Hunter says: [1.2.3.4] quit")).toBeNull();
    expect(parseConsoleQuit("")).toBeNull();
  });
});

describe("ConsoleQuitWatch", () => {
  it("passes the console quit echo to its callback, across chunks", () => {
    const quits: string[] = [];
    const watch = new ConsoleQuitWatch((from) => quits.push(from));
    watch.push("*Hunter has joined CTF\r\n[192.168.1.4] qu");
    watch.push("it\r\n");
    expect(quits).toEqual(["192.168.1.4"]);
  });

  it("drops a partial line when a new process starts", () => {
    const quits: string[] = [];
    const watch = new ConsoleQuitWatch((from) => quits.push(from));
    watch.push("[127.0.0.1] qu");
    watch.reset();
    watch.push("it\r\n");
    expect(quits).toEqual([]);
  });
});
