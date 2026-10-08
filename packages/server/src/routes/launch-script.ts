import type { FastifyInstance } from "fastify";
import fs from "node:fs/promises";
import path from "node:path";
import { pyrodeckConfig } from "./pyrodeck-config.js";
import { validateExecutable, validateGamePath } from "../config/PyrodeckConfig.js";
import { parseDedicatedCfg, getCfgValue } from "../launcher/ConfigGenerator.js";
import { parseLaunchScript, planImport } from "../ops/launchScript.js";

/** Import a server profile from the batch file or shell script that launched it. */

const MAX_SCRIPT_BYTES = 64 * 1024;

export async function launchScriptRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /api/launch-script/preview  { text, fileName? }
   * Read the script and plan a profile, checking the paths on this machine.
   * Nothing is created: the client creates the profile with POST /api/profiles
   * { name, existingConfigFile, gamePath, executablePath, importedArgs }.
   */
  app.post("/api/launch-script/preview", async (request, reply) => {
    const { text, fileName } = (request.body ?? {}) as { text?: unknown; fileName?: unknown };
    if (typeof text !== "string" || !text.trim()) {
      return reply.status(400).send({ error: "Paste the script or pick the file first." });
    }
    if (Buffer.byteLength(text) > MAX_SCRIPT_BYTES) {
      return reply.status(400).send({ error: `A launch script is at most ${MAX_SCRIPT_BYTES / 1024} KB.` });
    }
    const script = parseLaunchScript(text, typeof fileName === "string" ? fileName : undefined);
    const plan = planImport(script);
    const gamePath = plan.gamePath ?? pyrodeckConfig.get().gamePath;

    // The paths may come from another machine: say what exists on this one.
    const checks = {
      gamePath: gamePath ? await validateGamePath(gamePath) : { valid: false, errors: ["No game path"] },
      executable: plan.executablePath
        ? await validateExecutable(plan.executablePath, gamePath)
        : { valid: false, errors: ["The script names no program"] },
      configFile: { valid: false, errors: [] as string[] },
    };
    let name = plan.name;
    if (gamePath && plan.configFile) {
      try {
        const cfg = await fs.readFile(path.join(gamePath, plan.configFile), "utf-8");
        checks.configFile.valid = true;
        const gameName = getCfgValue(parseDedicatedCfg(cfg), "GameName");
        if (gameName) name = gameName;
      } catch {
        checks.configFile.errors.push(`${plan.configFile} is not in ${gamePath}`);
      }
    }
    return { script, profile: { ...plan, name, gamePath }, checks };
  });
}
