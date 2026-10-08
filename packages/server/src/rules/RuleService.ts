import { serverEvents, type ServerEventMap, type ServerEvents } from "../events/ServerEvents.js";
import { isBotName } from "../events/consoleLines.js";
import type { ConsoleProvider } from "../players/consoleLink.js";
import { chatName, sayToAll, sayToSlot } from "../players/playerActions.js";
import type { PlayerRules } from "./ruleSettings.js";
import { checkNickname, compileWordList, Escalation, type OffenderView } from "./rules.js";

type Result = { ok: true; message?: string } | { ok: false; error: string };

export interface RuleServiceDeps {
  rules: () => PlayerRules;
  console: ConsoleProvider;
  /** The slot a player in the game is known to have. */
  slotOf: (profileId: string, name: string) => number | undefined;
  kick: (profileId: string, name: string, reason: string, slot?: number) => Promise<Result>;
  ban: (
    profileId: string,
    name: string,
    reason: string,
    opts: { hostsDeny: boolean; nameBan: boolean; slot?: number },
  ) => Promise<Result>;
  bus?: ServerEvents;
  now?: () => number;
  log?: (message: string) => void;
}

export interface RuleAction {
  time: string;
  profileId: string;
  name: string;
  rule: "nickname" | "profanity";
  action: "warn" | "kick" | "ban";
  detail: string;
  ok: boolean;
}

const MAX_RECENT = 50;

/**
 * Applies the nickname rules to each human's new session and the profanity
 * monitor to player chat.
 */
export class RuleService {
  private readonly bus: ServerEvents;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private readonly escalations = new Map<string, Escalation>();
  private readonly recentActions: RuleAction[] = [];
  private readonly handlers: Array<() => void> = [];
  private matcher: { words: readonly string[]; match: (text: string) => string | null } | null = null;

  constructor(private readonly deps: RuleServiceDeps) {
    this.bus = deps.bus ?? serverEvents;
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? ((m) => console.log(`[Rules] ${m}`));
  }

  start(): void {
    const on = <K extends keyof ServerEventMap>(name: K, fn: (p: ServerEventMap[K]) => Promise<void> | void) => {
      const wrapped = (p: ServerEventMap[K]) => {
        Promise.resolve()
          .then(() => fn(p))
          .catch((err) => this.log(`${name} rule failed: ${err instanceof Error ? err.message : String(err)}`));
      };
      this.bus.onEvent(name, wrapped);
      this.handlers.push(() => this.bus.offEvent(name, wrapped));
    };
    on("player.identified", (p) => this.onIdentified(p));
    on("player.chat", (p) => this.onChat(p));
    for (const ev of ["server.started", "server.stopped", "server.crashed"] as const) {
      on(ev, (p) => this.escalation(p.profileId).reset());
    }
  }

  stop(): void {
    for (const off of this.handlers.splice(0)) off();
  }

  /** Rule actions taken recently, newest first. */
  recent(): RuleAction[] {
    return [...this.recentActions].reverse();
  }

  offenders(profileId: string): OffenderView[] {
    return this.escalation(profileId).list();
  }

  /** Clear a player's profanity count. */
  forgive(profileId: string, name: string): void {
    this.escalation(profileId).forget(name);
  }

  private escalation(profileId: string): Escalation {
    let e = this.escalations.get(profileId);
    if (!e) {
      e = new Escalation(() => this.deps.rules().profanity);
      this.escalations.set(profileId, e);
    }
    return e;
  }

  private match(text: string): string | null {
    const words = this.deps.rules().profanity.words;
    if (!this.matcher || this.matcher.words !== words) {
      this.matcher = { words, match: compileWordList(words) };
    }
    return this.matcher.match(text);
  }

  private record(action: Omit<RuleAction, "time">): void {
    this.recentActions.push({ time: new Date(this.now()).toISOString(), ...action });
    if (this.recentActions.length > MAX_RECENT) this.recentActions.shift();
  }

  private async onIdentified(p: ServerEventMap["player.identified"]): Promise<void> {
    const verdict = checkNickname(p.name, this.deps.rules().nickname);
    if (verdict.ok) return;
    const reason = `${verdict.label} (${verdict.detail})`;
    const result = await this.deps.kick(p.profileId, p.name, reason, p.slot);
    this.record({ profileId: p.profileId, name: p.name, rule: "nickname", action: "kick", detail: reason, ok: result.ok });
    if (!result.ok) this.log(`Nickname rule on ${JSON.stringify(p.name)}: ${result.error}`);
  }

  private async onChat(p: ServerEventMap["player.chat"]): Promise<void> {
    const rules = this.deps.rules().profanity;
    if (!rules.enabled || isBotName(p.name)) return;
    const word = this.match(p.text);
    if (!word) return;
    const step = this.escalation(p.profileId).hit(p.name, this.now());
    if (!step.action) return;
    const slot = this.deps.slotOf(p.profileId, p.name);
    const name = chatName(p.name);
    let result: Result;
    let detail: string;

    if (step.action === "warn") {
      const left = rules.warnings - step.warnings;
      const next = rules.kicks > 0 || !rules.ban ? "kick" : "ban";
      detail = `warning ${step.warnings} of ${rules.warnings}`;
      const text =
        left > 0
          ? `${name}, watch your language (warning ${step.warnings} of ${rules.warnings})`
          : `${name}, watch your language. Last warning before a ${next}`;
      const link = this.deps.console(p.profileId);
      if (link) {
        await link.send(slot !== undefined ? sayToSlot(slot, text) : sayToAll(text));
        result = { ok: true };
      } else {
        result = { ok: false, error: "no console" };
      }
    } else if (step.action === "kick") {
      detail = `kick ${step.kicks}${rules.ban ? ` of ${rules.kicks}` : ""}`;
      result = await this.deps.kick(p.profileId, p.name, "language", slot);
    } else {
      detail = "ban (name and address)";
      result = await this.deps.ban(p.profileId, p.name, "language", { hostsDeny: true, nameBan: true, slot });
    }
    this.log(`Profanity from ${JSON.stringify(p.name)} ("${word}"): ${detail}${result.ok ? "" : ` failed: ${result.error}`}`);
    this.record({ profileId: p.profileId, name: p.name, rule: "profanity", action: step.action, detail, ok: result.ok });
  }
}
