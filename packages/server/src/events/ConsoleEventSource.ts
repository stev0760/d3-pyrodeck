import { serverEvents, type ServerEvents } from "./ServerEvents.js";
import { LineSplitter, isBotName, parseConsoleLines, SERVER_CALLSIGN, type ConsoleLine } from "./consoleLines.js";

/**
 * How long a bot's join waits for the "added in slot"/"spawned" line that
 * names its slot. The engine prints the game DLL's join line first, then the
 * slot line from the same console command.
 */
const BOT_SLOT_WAIT_MS = 500;

/**
 * Turns one console connection's output into player and level events on the
 * shared bus: player.joined, player.left, player.chat, level.started.
 */
export class ConsoleEventSource {
  private readonly splitter = new LineSplitter();
  /** Bots in the game, by callsign, with their slot when known. */
  private readonly bots = new Map<string, number | undefined>();
  private readonly pendingBotJoins = new Map<string, ReturnType<typeof setTimeout>>();
  /** Slots announced by a bot line before the bot's join line. */
  private readonly earlyBotSlots = new Map<string, number>();
  /** Humans just kicked or banned, so their "disconnected!" can say so. */
  private readonly removedHumans = new Map<string, "kicked" | "banned">();

  constructor(
    readonly profileId: string,
    private readonly bus: ServerEvents = serverEvents,
  ) {}

  feed(chunk: string): void {
    for (const line of this.splitter.push(chunk)) this.onLine(line);
  }

  dispose(): void {
    for (const timer of this.pendingBotJoins.values()) clearTimeout(timer);
    this.pendingBotJoins.clear();
  }

  private onLine(line: string): void {
    for (const parsed of parseConsoleLines(line)) this.onMessage(parsed);
  }

  private onMessage(parsed: ConsoleLine): void {
    const profileId = this.profileId;

    switch (parsed.kind) {
      case "level":
        this.bus.emitEvent("level.started", { profileId, level: parsed.level });
        break;
      case "chat":
        if (parsed.name !== SERVER_CALLSIGN) {
          this.bus.emitEvent("player.chat", { profileId, name: parsed.name, text: parsed.text });
        }
        break;
      case "join":
        if (isBotName(parsed.name)) this.botJoined(parsed.name);
        else this.bus.emitEvent("player.joined", { profileId, name: parsed.name, bot: false });
        break;
      case "leave": {
        this.bots.delete(parsed.name);
        const removed = this.removedHumans.get(parsed.name);
        this.removedHumans.delete(parsed.name);
        this.bus.emitEvent("player.left", {
          profileId,
          name: parsed.name,
          bot: isBotName(parsed.name),
          reason: parsed.how === "left" ? "left the game" : (removed ?? "disconnected"),
        });
        break;
      }
      case "removed":
        if (isBotName(parsed.name)) {
          const slot = this.bots.get(parsed.name);
          this.bots.delete(parsed.name);
          this.bus.emitEvent("player.left", {
            profileId,
            name: parsed.name,
            bot: true,
            ...(slot !== undefined ? { slot } : {}),
            reason: parsed.how,
          });
        } else {
          this.removedHumans.set(parsed.name, parsed.how);
        }
        break;
      case "bot-added": {
        const pending = this.pendingBotJoins.get(parsed.name);
        if (pending) {
          clearTimeout(pending);
          this.pendingBotJoins.delete(parsed.name);
          this.emitBotJoin(parsed.name, parsed.slot);
        } else {
          this.earlyBotSlots.set(parsed.name, parsed.slot);
        }
        break;
      }
      case "bot-removed":
        this.bots.delete(parsed.name);
        this.bus.emitEvent("player.left", {
          profileId,
          name: parsed.name,
          slot: parsed.slot,
          bot: true,
          reason: "bot removed",
        });
        break;
      case "bots-cleared":
        for (const [name, slot] of this.bots) {
          this.bus.emitEvent("player.left", { profileId, name, slot, bot: true, reason: "bot removed" });
        }
        this.bots.clear();
        break;
    }
  }

  private botJoined(name: string): void {
    const early = this.earlyBotSlots.get(name);
    if (early !== undefined) {
      this.earlyBotSlots.delete(name);
      this.emitBotJoin(name, early);
      return;
    }
    // A bot already in the game is re-entering at a level start; its slot is known.
    if (this.bots.has(name)) {
      this.emitBotJoin(name, this.bots.get(name));
      return;
    }
    if (this.pendingBotJoins.has(name)) return;
    this.pendingBotJoins.set(
      name,
      setTimeout(() => {
        this.pendingBotJoins.delete(name);
        this.emitBotJoin(name, undefined);
      }, BOT_SLOT_WAIT_MS),
    );
  }

  private emitBotJoin(name: string, slot: number | undefined): void {
    this.bots.set(name, slot);
    this.bus.emitEvent("player.joined", {
      profileId: this.profileId,
      name,
      bot: true,
      ...(slot !== undefined ? { slot } : {}),
    });
  }
}
