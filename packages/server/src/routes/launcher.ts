import type { FastifyInstance } from "fastify";
import fs from "node:fs/promises";
import path from "node:path";
import { ProcessManager } from "../launcher/ProcessManager.js";
import {
  parseDedicatedCfg,
  extractTelnetConfig,
} from "../launcher/ConfigGenerator.js";
import { TelnetConnection } from "../connection/TelnetConnection.js";
import {
  parseServercaps,
  VANILLA_CAPS,
  type ServerCapabilities,
} from "../parser/parsers/servercaps.js";
import { sessionManager, serializeCaps } from "./server.js";
import { wsBroadcast } from "./command.js";
import { pyrodeckConfig } from "./pyrodeck-config.js";

export const processManager = new ProcessManager();

// Wire process events to WebSocket broadcasts
processManager.on("stateChange", (state: string) => {
  wsBroadcast("process_state", { state });
});

processManager.on("stdout", (data: string) => {
  wsBroadcast("process_output", { stream: "stdout", data });
});

processManager.on("stderr", (data: string) => {
  wsBroadcast("process_output", { stream: "stderr", data });
});

export async function launcherRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/launcher/start", async (request, reply) => {
    if (processManager.isRunning()) {
      return reply.status(409).send({ error: "Server is already running" });
    }

    const body = request.body as {
      configFile?: string;
      telnetPort?: number;
    };

    const config = pyrodeckConfig.get();
    if (!config.d3InstallPath || !config.d3Executable) {
      return reply.status(400).send({
        error: "D3 installation path and executable not configured",
      });
    }

    const configFile = body.configFile ?? config.defaultConfigFile;
    const cfgPath = path.join(config.d3InstallPath, configFile);

    // Parse the config file to get telnet password
    let telnetPort = body.telnetPort ?? config.defaultTelnetPort;
    let telnetPassword = "";

    try {
      const cfgContent = await fs.readFile(cfgPath, "utf-8");
      const entries = parseDedicatedCfg(cfgContent);
      const telnetCfg = extractTelnetConfig(entries);

      if (!telnetCfg.enabled) {
        return reply.status(400).send({
          error:
            "AllowRemoteConsole is not enabled in " +
            configFile +
            ". Pyrodeck requires remote console access.",
        });
      }

      telnetPort = telnetCfg.port;
      telnetPassword = telnetCfg.password ?? "";
    } catch {
      return reply.status(400).send({
        error: `Cannot read config file: ${configFile}`,
      });
    }

    if (!telnetPassword) {
      return reply.status(400).send({
        error:
          "ConsolePassword not set in " +
          configFile +
          ". Pyrodeck needs a password to connect.",
      });
    }

    // Disconnect any existing session
    const existing = sessionManager.getActive();
    if (existing) {
      sessionManager.remove(existing.id);
    }

    // Start the D3 process
    try {
      await processManager.start({
        d3Path: config.d3InstallPath,
        executable: config.d3Executable,
        configFile,
        telnetPort,
        telnetPassword,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ error: message });
    }

    // Auto-connect telnet when ready
    processManager.once("telnetReady", async (port: number) => {
      app.log.info("D3 server telnet ready on port %d, auto-connecting...", port);

      try {
        const connection = new TelnetConnection();
        const session = sessionManager.create(
          connection,
          "localhost",
          port,
          telnetPassword,
        );

        sessionManager.updateState(session.id, "connecting");
        await connection.connect("localhost", port, telnetPassword);

        // Probe capabilities
        sessionManager.updateState(session.id, "probing");
        let capabilities: ServerCapabilities;
        try {
          const capsResponse = await connection.send("$servercaps");
          const parsed = parseServercaps(capsResponse);
          capabilities = parsed ?? { ...VANILLA_CAPS, features: new Set() };
        } catch {
          capabilities = { ...VANILLA_CAPS, features: new Set() };
        }

        sessionManager.updateCapabilities(session.id, capabilities);
        sessionManager.updateState(session.id, "ready");

        // Wire up graceful quit
        processManager.sendQuitFn = async () => {
          try {
            await connection.send("quit");
          } catch {
            // Connection may already be dead
          }
        };

        // Broadcast to WS clients
        wsBroadcast("connection_state", { state: "ready" });
        wsBroadcast("capabilities", serializeCaps(capabilities));

        app.log.info(
          "Launch Mode: auto-connected to D3 server (session %s)",
          session.id,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        app.log.error("Launch Mode: telnet auto-connect failed: %s", message);
        wsBroadcast("error", { message: `Auto-connect failed: ${message}` });
      }
    });

    return {
      status: processManager.getStatus(),
      message: "Server starting",
    };
  });

  app.post("/api/launcher/stop", async (_request, reply) => {
    if (!processManager.isRunning()) {
      return reply.status(409).send({ error: "Server is not running" });
    }

    // Clean up session
    const session = sessionManager.getActive();
    if (session) {
      sessionManager.remove(session.id);
    }
    processManager.sendQuitFn = null;

    await processManager.stop();

    wsBroadcast("connection_state", { state: "disconnected" });

    return { ok: true, status: processManager.getStatus() };
  });

  app.get("/api/launcher/status", async () => {
    return processManager.getStatus();
  });

  app.get("/api/launcher/detect", async (_request, reply) => {
    const config = pyrodeckConfig.get();
    if (!config.d3InstallPath) {
      return reply.status(400).send({ error: "D3 path not configured" });
    }

    const d3Path = config.d3InstallPath;
    const configFiles: string[] = [];
    const hogFiles: string[] = [];

    try {
      const entries = await fs.readdir(d3Path);
      for (const entry of entries) {
        const lower = entry.toLowerCase();
        if (lower.endsWith(".cfg")) configFiles.push(entry);
        if (lower.endsWith(".hog")) hogFiles.push(entry);
      }
    } catch {
      return reply.status(500).send({ error: "Cannot read D3 directory" });
    }

    return { configFiles, hogFiles };
  });
}
