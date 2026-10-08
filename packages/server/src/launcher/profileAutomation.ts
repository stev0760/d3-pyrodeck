/**
 * Console automation for the launched profile: periodic commands and the
 * player-scaled respawn time. A run starts with `server.started`, gets the
 * console when Pyrodeck's session to that server is ready, and ends when the
 * process stops or crashes. Joins and leaves arrive as `player.joined` and
 * `player.left` on the server event bus.
 */
import type { ServerEvents } from "../events/ServerEvents.js";
import type { ServerConnection } from "../connection/ServerConnection.js";
import { PeriodicCommandScheduler, sanitizeStoredPeriodic, type SendLine } from "./periodicCommands.js";
import { RespawnScaler, sanitizeStoredRespawnScaling } from "./respawnScaling.js";

export interface AutomationSettings {
  periodicCommands?: unknown;
  respawnScaling?: unknown;
}

export interface ProfileAutomationOptions {
  /** The profile's stored settings, or null when the profile is gone. */
  loadProfile: (profileId: string) => Promise<AutomationSettings | null>;
  periodic?: PeriodicCommandScheduler;
  respawn?: RespawnScaler;
}

export class ProfileAutomation {
  readonly periodic: PeriodicCommandScheduler;
  readonly respawn: RespawnScaler;
  private readonly loadProfile: ProfileAutomationOptions["loadProfile"];
  private profileId: string | null = null;
  private pid: number | null = null;
  /** Settles when the current run's settings are loaded. */
  private armed: Promise<void> = Promise.resolve();

  constructor(options: ProfileAutomationOptions) {
    this.loadProfile = options.loadProfile;
    this.periodic = options.periodic ?? new PeriodicCommandScheduler();
    this.respawn = options.respawn ?? new RespawnScaler();
  }

  /** Subscribe to the server event bus. */
  listen(bus: ServerEvents): void {
    bus.onEvent("server.started", ({ profileId, pid }) => void this.serverStarted(profileId, pid));
    bus.onEvent("server.stopped", ({ pid }) => this.serverDown(pid));
    bus.onEvent("server.crashed", ({ pid }) => this.serverDown(pid));
    bus.onEvent("player.joined", ({ profileId, name }) => {
      if (profileId === this.profileId) this.respawn.playerJoined(name);
    });
    bus.onEvent("player.left", ({ profileId, name }) => {
      if (profileId === this.profileId) this.respawn.playerLeft(name);
    });
  }

  /** A server process started: load the profile's settings and arm a new run. */
  serverStarted(profileId: string, pid: number): Promise<void> {
    if (pid === this.pid) return this.armed; // the same start reported twice
    this.pid = pid;
    this.profileId = profileId;
    this.periodic.stop();
    this.respawn.stop();
    this.armed = this.loadProfile(profileId)
      .catch(() => null)
      .then((profile) => {
        if (this.pid !== pid) return;
        this.periodic.arm(String(pid), sanitizeStoredPeriodic(profile?.periodicCommands));
        this.respawn.arm(sanitizeStoredRespawnScaling(profile?.respawnScaling));
      });
    return this.armed;
  }

  /** Pyrodeck's console session to the launched server is ready. */
  async consoleReady(profileId: string, connection: ServerConnection): Promise<void> {
    await this.armed;
    if (profileId !== this.profileId || this.pid === null) return;
    const send: SendLine = async (line) => {
      if (!connection.isConnected()) throw new Error("console not connected");
      return connection.send(line);
    };
    this.periodic.consoleReady(send);
    this.respawn.consoleReady(send);
  }

  /** The process is gone. With a pid, only that run ends. */
  serverDown(pid?: number): void {
    if (pid !== undefined && this.pid !== null && pid !== this.pid) return;
    this.pid = null;
    this.profileId = null;
    this.periodic.stop();
    this.respawn.stop();
  }
}
