import type { FastifyInstance } from "fastify";
import { pyrodeckConfig } from "./pyrodeck-config.js";
import { playerTracker } from "./players.js";
import { banService } from "./bans.js";
import { RuleService } from "../rules/RuleService.js";
import { DEFAULT_PROFANITY_WORDS, validatePlayerRules } from "../rules/ruleSettings.js";
import { activeConsoleLink } from "../players/activeConsole.js";
import { activeConsoleProfileId } from "../events/consoleEventHub.js";

export const ruleService = new RuleService({
  rules: () => pyrodeckConfig.get().playerRules,
  console: activeConsoleLink,
  slotOf: (profileId, name) =>
    playerTracker.present(profileId).find((p) => p.name.toLowerCase() === name.toLowerCase())?.slot,
  kick: (profileId, name, reason, slot) => banService.kick(profileId, name, reason, slot),
  ban: (profileId, name, reason, opts) => banService.ban(profileId, name, reason, opts),
});

export async function playerRulesRoutes(app: FastifyInstance): Promise<void> {
  ruleService.start();
  app.addHook("onClose", async () => ruleService.stop());

  /** GET /api/players/rules: the rules, the default word list, recent actions and this run's offenders. */
  app.get("/api/players/rules", async () => {
    const profileId = activeConsoleProfileId();
    return {
      rules: pyrodeckConfig.get().playerRules,
      defaultWords: DEFAULT_PROFANITY_WORDS,
      recent: ruleService.recent(),
      offenders: profileId ? ruleService.offenders(profileId) : [],
    };
  });

  /** PUT /api/players/rules  { nickname?: {...}, profanity?: {...} } */
  app.put("/api/players/rules", async (request, reply) => {
    const check = validatePlayerRules(request.body, pyrodeckConfig.get().playerRules);
    if (check.errors.length > 0) {
      return reply.status(400).send({ error: check.errors.join(" "), errors: check.errors });
    }
    await pyrodeckConfig.save({ playerRules: check.rules });
    return { rules: check.rules };
  });

  /** POST /api/players/rules/forgive  { name }: clear a player's profanity count on the open server. */
  app.post("/api/players/rules/forgive", async (request, reply) => {
    const { name } = (request.body ?? {}) as { name?: unknown };
    const profileId = activeConsoleProfileId();
    if (!profileId || typeof name !== "string") return reply.status(400).send({ error: "name is required" });
    ruleService.forgive(profileId, name);
    return { ok: true };
  });
}
