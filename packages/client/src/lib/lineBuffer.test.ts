import { describe, it, expect } from "vitest";
import { LineBuffer } from "./lineBuffer.ts";

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("LineBuffer", () => {
  it("joins chunks that split a line and keeps the trailing partial", () => {
    const b = new LineBuffer();
    b.push("Game Name: Pyro");
    expect(b.lines()).toEqual([]);
    b.push("deck Server\nMission Name: cann");
    expect(b.lines().map((l) => l.text)).toEqual(["Game Name: Pyrodeck Server"]);
    b.push("ery.mn3\n");
    expect(b.lines().map((l) => l.text)).toEqual(["Game Name: Pyrodeck Server", "Mission Name: cannery.mn3"]);
  });

  it("normalises CRLF and lone CR line endings", () => {
    const b = new LineBuffer();
    b.push("a\r\nb\rc\n");
    expect(b.lines().map((l) => l.text)).toEqual(["a", "b", "c"]);
  });

  it("keeps partial lines apart per kind", () => {
    const b = new LineBuffer();
    b.push("out-part", "out");
    b.push("err-part", "err");
    b.push(" done\n", "out");
    expect(b.lines()).toMatchObject([{ kind: "out", text: "out-part done" }]);
    b.flush("err");
    expect(b.lines()).toMatchObject([
      { kind: "out", text: "out-part done" },
      { kind: "err", text: "err-part" },
    ]);
  });

  it("drops the oldest lines beyond the cap", () => {
    const b = new LineBuffer(3);
    b.push("1\n2\n3\n4\n5\n");
    expect(b.lines().map((l) => l.text)).toEqual(["3", "4", "5"]);
    expect(b.lines().map((l) => l.id)).toEqual([3, 4, 5]);
  });

  it("replaces the array on change so a snapshot can be compared by identity", () => {
    const b = new LineBuffer();
    const before = b.lines();
    b.push("x\n");
    expect(b.lines()).not.toBe(before);
    const after = b.lines();
    b.push("partial only");
    expect(b.lines()).toBe(after);
  });

  it("snapshots by kind with the requested line ending", () => {
    const b = new LineBuffer();
    b.line("$scores", "cmd");
    b.push("Pilot  Pts\n", "out");
    b.push("boom\n", "err");
    expect(b.snapshot(["cmd", "out"], "\r\n")).toBe("$scores\r\nPilot  Pts\r\n");
    expect(b.snapshot()).toBe("$scores\nPilot  Pts\nboom\n");
    expect(new LineBuffer().snapshot()).toBe("");
  });

  it("bumps the version on every change and notifies once per batch", async () => {
    const b = new LineBuffer();
    let calls = 0;
    const unsubscribe = b.subscribe(() => {
      calls += 1;
    });
    b.push("a\n");
    b.push("b\n");
    b.line("c");
    expect(b.version).toBe(3);
    expect(calls).toBe(0);
    await tick();
    expect(calls).toBe(1);
    unsubscribe();
    b.push("d\n");
    await tick();
    expect(calls).toBe(1);
  });

  it("clears", async () => {
    const b = new LineBuffer();
    b.push("a\nb");
    b.clear();
    expect(b.lines()).toEqual([]);
    b.push("\n");
    expect(b.lines().map((l) => l.text)).toEqual([""]);
    await tick();
  });
});
