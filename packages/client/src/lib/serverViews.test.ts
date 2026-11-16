import { describe, it, expect } from "vitest";
import { ServerViews, parseTimeLeft } from "./serverViews.ts";
import { routeMessage, type WsMessage } from "./servers.ts";

/** What the connection hook does with a message: route it, then apply it to its server's view. */
function deliver(views: ServerViews, msg: WsMessage): void {
  const route = routeMessage(msg);
  if (route.scope === "server") views.apply(route.serverId, msg);
}

const tagged = (serverId: string, type: string, payload: Record<string, unknown>): WsMessage => ({ type, serverId, payload });

describe("ServerViews: messages sorted by serverId", () => {
  it("keeps each server's console text apart", () => {
    const views = new ServerViews();
    deliver(views, tagged("anarchy", "output", { raw: "anarchy says hi\n" }));
    deliver(views, tagged("ctf", "output", { raw: "ctf line 1\nctf line 2\n" }));
    deliver(views, tagged("anarchy", "output", { raw: "anarchy again\n" }));
    expect(views.get("anarchy").console.lines().map((l) => l.text)).toEqual(["anarchy says hi", "anarchy again"]);
    expect(views.get("ctf").console.lines().map((l) => l.text)).toEqual(["ctf line 1", "ctf line 2"]);
  });

  it("keeps partial lines apart per server", () => {
    const views = new ServerViews();
    deliver(views, tagged("a", "output", { raw: "half of a" }));
    deliver(views, tagged("b", "output", { raw: "b whole\n" }));
    deliver(views, tagged("a", "output", { raw: " line\n" }));
    expect(views.get("a").console.lines().map((l) => l.text)).toEqual(["half of a line"]);
    expect(views.get("b").console.lines().map((l) => l.text)).toEqual(["b whole"]);
  });

  it("keeps each server's game output apart, stdout and stderr", () => {
    const views = new ServerViews();
    deliver(views, tagged("a", "process_output", { stream: "stdout", data: "a out\n" }));
    deliver(views, tagged("b", "process_output", { stream: "stderr", data: "b err\n" }));
    expect(views.get("a").process.lines()).toMatchObject([{ kind: "out", text: "a out" }]);
    expect(views.get("b").process.lines()).toMatchObject([{ kind: "err", text: "b err" }]);
    expect(views.get("a").console.lines()).toHaveLength(0);
  });

  it("drops the untagged greeting instead of giving it to some server", () => {
    const views = new ServerViews();
    deliver(views, { type: "connection_state", payload: { state: "ready" } });
    deliver(views, { type: "output", payload: { raw: "whose?\n" } });
    expect(views.ids()).toEqual([]);
  });

  it("tracks each server's console login, capabilities, process and level", () => {
    const views = new ServerViews();
    deliver(views, tagged("a", "connection_state", { state: "ready" }));
    deliver(views, tagged("a", "capabilities", { version: 1, fork: "Matcen", forkVersion: "0.10.17", features: ["bots"] }));
    deliver(views, tagged("b", "process_state", { state: "starting" }));
    deliver(views, tagged("b", "level_changed", { level: "level2" }));
    expect(views.get("a")).toMatchObject({ connectionState: "ready", capabilities: { features: ["bots"] }, processState: null });
    expect(views.get("b")).toMatchObject({ connectionState: "disconnected", capabilities: null, processState: "starting", level: "level2" });
  });

  it("keeps each server's playlist status, and patches only that server's on a vote", () => {
    const views = new ServerViews();
    const base = { status: "active", activePlaylistId: "p1", currentIndex: 0, currentEntry: null, gameEndAt: null, voteOptions: [], voteDeadline: null };
    deliver(views, tagged("a", "playlist_status", base));
    deliver(views, tagged("b", "playlist_status", { ...base, activePlaylistId: "p2" }));
    deliver(views, tagged("b", "playlist_vote_announce", { options: [{ id: "e", label: "E", missionName: "e.mn3" }], deadline: 99 }));
    expect(views.get("a").playlist).toMatchObject({ status: "active", activePlaylistId: "p1" });
    expect(views.get("b").playlist).toMatchObject({ status: "voting", activePlaylistId: "p2", voteDeadline: 99 });
  });

  it("forgets a server's info when its console logs out, so the next login asks again", () => {
    const views = new ServerViews(() => 1000);
    deliver(views, tagged("a", "connection_state", { state: "ready" }));
    views.patch("a", { infoAsked: true });
    deliver(views, tagged("a", "serverinfo", { gameName: "A", timeLimit: 10, timeLeft: "5:00" }));
    expect(views.get("a").anchor).toEqual({ seconds: 300, at: 1000 });
    deliver(views, tagged("b", "connection_state", { state: "disconnected" }));
    expect(views.get("a").info).not.toBeNull();
    deliver(views, tagged("a", "connection_state", { state: "disconnected" }));
    expect(views.get("a")).toMatchObject({ info: null, infoAsked: false, anchor: null });
  });

  it("starts a server's clock at its full limit on a new level", () => {
    let now = 0;
    const views = new ServerViews(() => now);
    deliver(views, tagged("a", "serverinfo", { timeLimit: 15, timeLeft: "1:00" }));
    now = 5000;
    deliver(views, tagged("a", "level_changed", { level: "level3" }));
    expect(views.get("a").anchor).toEqual({ seconds: 900, at: 5000 });
  });

  it("marks every console logged out after a reconnect's hello, until Pyrodeck greets it again", () => {
    const views = new ServerViews();
    deliver(views, tagged("a", "connection_state", { state: "ready" }));
    deliver(views, tagged("b", "connection_state", { state: "ready" }));
    views.resetConsoles();
    expect(views.get("a").connectionState).toBe("disconnected");
    deliver(views, tagged("b", "connection_state", { state: "ready" }));
    expect(views.get("b").connectionState).toBe("ready");
    expect(views.get("a").connectionState).toBe("disconnected");
  });

  it("replaces a view on a change and keeps it while nothing changed (a stable snapshot)", () => {
    const views = new ServerViews();
    const a1 = views.get("a");
    const b1 = views.get("b");
    expect(views.get("a")).toBe(a1);
    deliver(views, tagged("a", "process_state", { state: "running" }));
    const a2 = views.get("a");
    expect(a2).not.toBe(a1);
    expect(a2.console).toBe(a1.console);
    expect(views.get("b")).toBe(b1);
  });

  it("notifies subscribers of a change", () => {
    const views = new ServerViews();
    let calls = 0;
    const off = views.subscribe(() => calls++);
    deliver(views, tagged("a", "process_state", { state: "running" }));
    off();
    deliver(views, tagged("a", "process_state", { state: "stopped" }));
    expect(calls).toBe(1);
  });
});

describe("parseTimeLeft", () => {
  it("reads M:SS and H:MM:SS", () => {
    expect(parseTimeLeft("4:05")).toBe(245);
    expect(parseTimeLeft("1:00:00")).toBe(3600);
    expect(parseTimeLeft("x")).toBe(0);
  });
});
