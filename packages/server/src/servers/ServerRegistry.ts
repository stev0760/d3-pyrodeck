import fs from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_TIMING,
  ServerInstance,
  type GameProcess,
  type InstanceSettings,
  type InstanceTiming,
  type LaunchGuard,
  type LaunchPass,
  type ProcessHost,
} from "./ServerInstance.js";
import { sessionManager } from "../session/sessionStore.js";
import { CONNECT_OWNER, type ServerSession, type SessionManager } from "../session/SessionManager.js";
import { serverBroadcast } from "../ws/wsHub.js";
import { setDefaultServerResolver } from "../ws/wsHub.js";
import { pyrodeckConfig } from "../routes/pyrodeck-config.js";
import { playlistManager, rotationHealth } from "../launcher/playlistInstance.js";
import { PlaylistManager, savedRotationToResume } from "../launcher/PlaylistManager.js";
import { RotationHealthMonitor } from "../launcher/RotationHealthMonitor.js";
import { NO_PROFILE_ID, scopedEvents, serverEvents, type ScopedServerEvents, type ServerEvents } from "../events/ServerEvents.js";
import { logServerEvents } from "../events/serverEventLog.js";
import {
  AUTOSTART_ENV,
  AUTOSTART_LIST_ENV,
  chooseAutostartProfile,
  readAutostartEnv,
  readAutostartListEnv,
  type AutostartChoice,
  type AutostartProfileRef,
} from "../launcher/autostartSettings.js";
import type { ServerConnection } from "../connection/ServerConnection.js";
import type { SupervisorOptions } from "../launcher/Supervisor.js";
import type { AutostartOptions } from "../launcher/Autostart.js";
import type { SupervisorSettings } from "../launcher/supervisorSettings.js";
import { ServerProfileManager, type ServerProfile } from "../config/ServerProfile.js";
import { startupFilePath, type LaunchConfig } from "../launcher/ProcessManager.js";
import { clearRunRecord, readRunRecord, writeRunRecord, SERVER_RUN_FILE, type RunRecord } from "../launcher/runRecord.js";
import { checkLaunch, defaultTempDir, type OtherLaunch } from "./launchConflicts.js";
import {
  CONNECT_SERVER_ID,
  LAUNCH_SERVER_ID,
  PLAYLIST_STATE_FILE,
  RESERVED_SERVER_IDS,
  isServerIdSafe,
  readServerRunRecords,
  readServersFile,
  serverDir,
  serverIdOfRecord,
  serverIdsWithPlaylistState,
  upgradeConfigDir,
  writeServersFile,
  type ServersFile,
} from "./serverStore.js";

export { CONNECT_SERVER_ID, LAUNCH_SERVER_ID } from "./serverStore.js";

/** The Pyrodeck settings the servers read (pyrodeck.json). */
export type RegistrySettings = InstanceSettings & { supervisor: SupervisorSettings };

export interface RegistryOptions {
  /** Where profiles.json, servers.json and servers/<id>/ are kept. */
  configDir: string;
  settings: () => RegistrySettings;
  sessions: SessionManager;
  /** The shared bus; each server gets a view of it scoped to its own events. */
  bus: ServerEvents;
  /** A server's message to the browsers (ws/wsHub.ts serverBroadcast). */
  broadcast: (serverId: string, type: string, payload: Record<string, unknown>) => void;
  /** The playlist and its restart check of the server that keeps `<config>/playlist-state.json`. */
  legacyPlaylist?: PlaylistManager;
  legacyRotationHealth?: RotationHealthMonitor;
  /** The environment autostart reads (PYRODECK_AUTOSTART_PROFILE, PYRODECK_AUTOSTART_PROFILES). */
  env?: Readonly<Record<string, string | undefined>>;
  /** Save pyrodeck.json `autostart.profileId` (kept as the first of the autostart list for a downgrade). */
  saveAutostartSetting?: (profileId: string | null) => Promise<void>;
  /** Where Pyrodeck's per-server temp directories go. Default: the system's. */
  tempBase?: string;
  // Stand-ins for tests:
  createProcess?: (serverId: string, events: ServerEvents) => GameProcess;
  createConnection?: () => ServerConnection;
  host?: Partial<ProcessHost>;
  supervisor?: Omit<SupervisorOptions, "events">;
  autostart?: Omit<AutostartOptions, "events">;
  timing?: Partial<InstanceTiming>;
}

/** A flat route's server: the one it names, else the only one running (see resolveAlias). */
export type AliasResult = { server: ServerInstance } | { code: number; error: string };

/** What GET /api/launcher/autostart and GET /api/servers report about autostart. */
export interface AutostartPlan {
  source: "env" | "setting" | null;
  /** The names the environment gives (PYRODECK_AUTOSTART_PROFILE first), else []. */
  envNames: string[];
  /** The profiles ticked "Start when Pyrodeck starts", in order. */
  settingProfileIds: string[];
  /** The profiles that start, with where each comes from. */
  profiles: AutostartProfileRef[];
  /** Names or ids that match no profile (nothing starts for them). */
  errors: string[];
}

/** Profiles listed for the registry: profiles.json, read again each time (it is small). */
async function listProfiles(configDir: string): Promise<ServerProfile[]> {
  return new ServerProfileManager(configDir, "").list().catch(() => []);
}

async function fileExists(file: string): Promise<boolean> {
  try {
    return (await fs.stat(file)).isFile();
  } catch {
    return false;
  }
}

/**
 * The game servers Pyrodeck runs, by id: one per profile (its id is the
 * profile's), and LAUNCH_SERVER_ID for the global dedicated.cfg without a
 * profile. Connect mode's console session is not a server here; it shows in
 * the list as CONNECT_SERVER_ID.
 *
 * The registry owns what the servers share: the launch lock and the launch
 * checks (no two servers on one port, config file, Startup Commands file or
 * temp directory), servers.json (the autostart list, the legacy owner), the
 * copy of one running server's record in running-server.json for an older
 * Pyrodeck, and which server is the default one: the server the flat routes
 * of a single-server Pyrodeck and a WebSocket that never said hello mean.
 */
export class ServerRegistry implements LaunchGuard {
  private readonly servers = new Map<string, ServerInstance>();
  private readonly scopes = new Map<string, ScopedServerEvents>();
  private readonly names = new Map<string, string>();
  private readonly addListeners: Array<(server: ServerInstance) => void> = [];
  private readonly reservations = new Map<string, LaunchConfig>();
  private file: ServersFile | null = null;
  private legacyRecord: RunRecord | null = null;
  private initPromise: Promise<void> | null = null;
  private initialized = false;
  /** The default server while none or several run (see defaultServerId). */
  private sticky: string | null = null;
  /** The last server (not Connect mode) that was the default. */
  private stickyServer: string | null = null;
  private lock: Promise<void> = Promise.resolve();
  private legacyQueue: Promise<void> = Promise.resolve();
  private autostartPlanned: AutostartPlan | null = null;
  private resumed: Promise<void> | null = null;

  constructor(private readonly opts: RegistryOptions) {}

  get configDir(): string {
    return this.opts.configDir;
  }

  // ---------------------------------------------------------------------------
  // The servers
  // ---------------------------------------------------------------------------

  /**
   * Bring the config directory up to date (serverStore.ts upgradeConfigDir)
   * and create a server for every profile and one without a profile. Once;
   * later calls wait for the first.
   */
  init(): Promise<void> {
    this.initPromise ??= this.doInit();
    return this.initPromise;
  }

  private async doInit(): Promise<void> {
    const profiles = await listProfiles(this.opts.configDir);
    const upgrade = await upgradeConfigDir({
      configDir: this.opts.configDir,
      profiles,
      autostartProfileId: this.opts.settings().autostart.profileId,
    });
    for (const note of upgrade.notes) console.log(`[Pyrodeck] ${note}`);
    this.file = upgrade.file;
    // pyrodeck.json keeps the first of the list, for an older Pyrodeck (and the next upgrade's comparison).
    const first = this.file.autostart[0] ?? null;
    if (this.opts.settings().autostart.profileId !== first) await this.opts.saveAutostartSetting?.(first);
    this.legacyRecord = upgrade.legacyRecord;
    this.rememberNames(profiles);
    const owner = this.file.legacyOwner;
    if (owner && owner !== LAUNCH_SERVER_ID && !profiles.some((p) => p.id === owner) && upgrade.legacyRecord === null) {
      // The profile that kept the old playlist state is gone: the server without a profile keeps it.
      this.file = { ...this.file, legacyOwner: LAUNCH_SERVER_ID };
      await writeServersFile(this.opts.configDir, this.file);
    }
    this.sticky = this.file.legacyOwner ?? LAUNCH_SERVER_ID;
    this.create(LAUNCH_SERVER_ID);
    for (const p of profiles) {
      if (!isServerIdSafe(p.id) || RESERVED_SERVER_IDS.has(p.id)) {
        console.warn(`[Pyrodeck] Profile "${p.name}" has the id "${p.id}", which cannot name a server; it cannot be launched.`);
        continue;
      }
      this.create(p.id);
    }
    this.initialized = true;
  }

  /** Whether init() has run: the servers exist. */
  isReady(): boolean {
    return this.initialized;
  }

  private create(id: string): ServerInstance {
    const existing = this.servers.get(id);
    if (existing) return existing;
    const legacy = this.file?.legacyOwner === id;
    const events = scopedEvents(this.opts.bus, id === LAUNCH_SERVER_ID ? NO_PROFILE_ID : id);
    const dir = serverDir(this.opts.configDir, id);
    const playlist = legacy
      ? (this.opts.legacyPlaylist ?? new PlaylistManager(this.opts.configDir))
      : new PlaylistManager(this.opts.configDir, { statePath: path.join(dir, PLAYLIST_STATE_FILE) });
    const server = new ServerInstance({
      id,
      profileId: id === LAUNCH_SERVER_ID ? null : id,
      configDir: this.opts.configDir,
      settings: this.opts.settings,
      sessions: this.opts.sessions,
      playlist,
      rotationHealth: legacy ? this.opts.legacyRotationHealth : undefined,
      broadcast: (type, payload) => this.opts.broadcast(id, type, payload),
      wireSessionToClients: (session) => wireSessionToClients(id, session, this.opts.broadcast),
      events,
      launchGuard: this,
      runRecordPath: path.join(dir, SERVER_RUN_FILE),
      onRunRecord: () => this.syncLegacyRunRecord(),
      autostartChoice: async () => this.autostartChoiceFor(id),
      autostartEnv: readAutostartEnv(this.opts.env ?? {}),
      process: this.opts.createProcess?.(id, events),
      createConnection: this.opts.createConnection,
      host: this.opts.host,
      supervisor: this.opts.supervisor,
      autostart: this.opts.autostart,
      timing: { ...DEFAULT_TIMING, ...this.opts.timing },
    });
    server.supervisor.applySettings(this.opts.settings().supervisor);
    this.servers.set(id, server);
    this.scopes.set(id, events);
    for (const listener of this.addListeners) listener(server);
    return server;
  }

  get(id: string): ServerInstance | undefined {
    return this.servers.get(id);
  }

  list(): ServerInstance[] {
    return [...this.servers.values()];
  }

  /** The server of a profile, created when the profile was added after Pyrodeck started; undefined for an unknown id. */
  async ensure(id: string): Promise<ServerInstance | undefined> {
    const existing = this.servers.get(id);
    if (existing) return existing;
    if (!this.initialized || !isServerIdSafe(id) || RESERVED_SERVER_IDS.has(id)) return undefined;
    const profiles = await listProfiles(this.opts.configDir);
    this.rememberNames(profiles);
    if (!profiles.some((p) => p.id === id)) return undefined;
    return this.create(id);
  }

  /** Run `listener` for every server, now and when one is added. */
  onAdd(listener: (server: ServerInstance) => void): void {
    this.addListeners.push(listener);
    for (const server of this.servers.values()) listener(server);
  }

  /** The profile's name, or a label for the server without one. */
  nameOf(id: string): string {
    if (id === LAUNCH_SERVER_ID) return "Launched without a profile";
    if (id === CONNECT_SERVER_ID) return "Connect mode";
    return this.names.get(id) ?? id;
  }

  private rememberNames(profiles: readonly ServerProfile[]): void {
    for (const p of profiles) this.names.set(p.id, p.name);
  }

  /** Re-read the profiles: names, and servers of profiles deleted while idle are dropped. */
  async refreshProfiles(): Promise<ServerProfile[]> {
    const profiles = await listProfiles(this.opts.configDir);
    this.rememberNames(profiles);
    const ids = new Set(profiles.map((p) => p.id));
    for (const [id, server] of this.servers) {
      if (id === LAUNCH_SERVER_ID || ids.has(id)) continue;
      const idle =
        server.heldLaunch() === null &&
        !server.consoleSession() &&
        !server.playlist.isActive() &&
        server.supervisor.snapshot().pendingRelaunch === null;
      if (idle) this.drop(id);
    }
    if (this.initialized) for (const p of profiles) if (isServerIdSafe(p.id) && !RESERVED_SERVER_IDS.has(p.id)) this.create(p.id);
    return profiles;
  }

  private drop(id: string): void {
    const server = this.servers.get(id);
    if (!server) return;
    server.dispose();
    this.scopes.get(id)?.dispose();
    this.servers.delete(id);
    this.scopes.delete(id);
    if (this.sticky === id) this.sticky = null;
    if (this.stickyServer === id) this.stickyServer = null;
  }

  /** Servers whose process is starting or running (a stopping one still holds its ports: heldLaunch). */
  running(): ServerInstance[] {
    return this.list().filter((s) => s.process.isRunning());
  }

  /** Stop every timer and listener (Pyrodeck shutting down, tests). The game processes keep running. */
  dispose(): void {
    for (const id of [...this.servers.keys()]) this.drop(id);
  }

  // ---------------------------------------------------------------------------
  // The default server
  // ---------------------------------------------------------------------------

  /** A server (or Connect mode) with a process or a console session open. */
  private isActive(id: string): boolean {
    if (id === CONNECT_SERVER_ID) return this.opts.sessions.getOwned(CONNECT_OWNER) !== undefined;
    const server = this.servers.get(id);
    return !!server && (server.heldLaunch() !== null || server.consoleSession() !== undefined);
  }

  private activeSince(id: string): number {
    if (id === CONNECT_SERVER_ID) {
      return this.opts.sessions.getOwned(CONNECT_OWNER)?.connectionInfo.connectedAt.getTime() ?? Infinity;
    }
    return this.servers.get(id)?.process.getStatus().startedAt?.getTime() ?? Infinity;
  }

  private setSticky(id: string): void {
    this.sticky = id;
    if (id !== CONNECT_SERVER_ID) this.stickyServer = id;
  }

  /**
   * The default server: what a client of a single-server Pyrodeck means by
   * "the server". The one running when one runs (or Connect mode's session
   * when that is all there is); with several, the one that was the default
   * already, else the one started first; with none, the last default. Null
   * before init(): every message then reaches every socket, as before.
   */
  defaultServerId(): string | null {
    if (!this.initialized) return null;
    if (this.sticky && this.isActive(this.sticky)) return this.sticky;
    const active = [...this.servers.keys(), CONNECT_SERVER_ID].filter((id) => this.isActive(id));
    if (active.length > 0) {
      active.sort((a, b) => this.activeSince(a) - this.activeSince(b));
      this.setSticky(active[0]);
      return active[0];
    }
    return this.sticky ?? LAUNCH_SERVER_ID;
  }

  /** The default server, or the last server that was the default while Connect mode is. */
  defaultServer(): ServerInstance | undefined {
    const id = this.defaultServerId();
    if (id && this.servers.has(id)) return this.servers.get(id);
    return (this.stickyServer ? this.servers.get(this.stickyServer) : undefined) ?? this.servers.get(LAUNCH_SERVER_ID);
  }

  /** A flat route named this server: it becomes the default while the default has nothing running. */
  prefer(id: string): void {
    if (!this.servers.has(id)) return;
    const current = this.defaultServerId();
    if (!current || !this.isActive(current)) this.setSticky(id);
  }

  /**
   * The server a flat route of a single-server Pyrodeck acts on: the profile
   * it names; else, for a route that changes something, the only server
   * running (409 naming `route` when several run), else the default server.
   */
  async resolveAlias(profileId: string | undefined, options: { changing: boolean; route: string }): Promise<AliasResult> {
    if (!this.initialized) await this.init();
    if (profileId) {
      const server = await this.ensure(profileId);
      if (!server) return { code: 404, error: `Profile not found: ${profileId}` };
      this.prefer(server.id);
      return { server };
    }
    if (options.changing) {
      const running = this.running();
      if (running.length === 1) return { server: running[0] };
      if (running.length > 1) {
        return {
          code: 409,
          error: `${running.length} servers are running (${running.map((s) => `"${this.nameOf(s.id)}"`).join(", ")}); name one: ${options.route}`,
        };
      }
    }
    const server = this.defaultServer();
    if (!server) return { code: 409, error: "No server is set up" };
    return { server };
  }

  /** Connect mode's open session, if any. */
  connectSession(): ServerSession | undefined {
    return this.opts.sessions.getOwned(CONNECT_OWNER);
  }

  // ---------------------------------------------------------------------------
  // Launch checks
  // ---------------------------------------------------------------------------

  /** Run `task` alone: one launch check at a time across every server. */
  private withLock<T>(task: () => Promise<T>): Promise<T> {
    const run = this.lock.then(task);
    this.lock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async startupFileUsed(launch: LaunchConfig): Promise<boolean> {
    return (launch.autoexecBlock?.length ?? 0) > 0 || (await fileExists(startupFilePath(launch)));
  }

  /** The launches the other servers hold, and the ones being started. */
  private async othersOf(serverId: string): Promise<OtherLaunch[]> {
    const others: OtherLaunch[] = [];
    for (const [id, server] of this.servers) {
      if (id === serverId) continue;
      const held = server.heldLaunch();
      const reserved = this.reservations.get(id);
      const launch = held?.launch ?? reserved;
      if (!launch) continue;
      others.push({
        name: this.nameOf(id),
        launch,
        pid: held?.pid ?? null,
        why: held?.why ?? "starting",
        startupFileUsed: await this.startupFileUsed(launch),
      });
    }
    return others;
  }

  /** The temp directory Pyrodeck gives a server whose profile sets none. */
  defaultTempDir(serverId: string): string {
    return defaultTempDir(this.opts.configDir, serverId, this.opts.tempBase);
  }

  /**
   * LaunchGuard: check a launch against the other servers' under the launch
   * lock, fill in the server's defaults, and hold its ports until release().
   * A stale lock in Pyrodeck's temp directory for the server is removed (the
   * server is down, so no process of its holds it).
   */
  reserve(serverId: string, launch: LaunchConfig): Promise<LaunchPass> {
    return this.withLock(async (): Promise<LaunchPass> => {
      const check = checkLaunch({
        name: this.nameOf(serverId),
        launch: { ...launch, defaultOptions: null },
        startupFileUsed: await this.startupFileUsed(launch),
        defaultTempDir: this.defaultTempDir(serverId),
        others: await this.othersOf(serverId),
      });
      if (!check.ok) {
        console.warn(`[Pyrodeck] ${check.error}`);
        return check;
      }
      const tempDir = check.launch.defaultOptions?.tempDir;
      if (tempDir) await fs.rm(path.join(tempDir, ".lock"), { force: true }).catch(() => {});
      this.reservations.set(serverId, check.launch);
      let released = false;
      return {
        ok: true,
        launch: check.launch,
        release: () => {
          if (released) return;
          released = true;
          if (this.reservations.get(serverId) === check.launch) this.reservations.delete(serverId);
        },
      };
    });
  }

  // ---------------------------------------------------------------------------
  // Re-attach, autostart, settings
  // ---------------------------------------------------------------------------

  /**
   * Re-attach every server to the game it ran before Pyrodeck restarted:
   * each server's run.json, and running-server.json (an older Pyrodeck's, or
   * the copy kept for one) for the server it names. A game that still runs
   * but cannot be logged in to holds its ports against other launches.
   */
  async reattachAll(): Promise<void> {
    await this.init();
    const records = await readServerRunRecords(this.opts.configDir);
    for (const id of records.keys()) if (!RESERVED_SERVER_IDS.has(id) || id === LAUNCH_SERVER_ID) this.create(id);
    const legacy = this.legacyRecord;
    const legacyId = legacy ? serverIdOfRecord(legacy) : null;
    if (legacyId && isServerIdSafe(legacyId) && (!RESERVED_SERVER_IDS.has(legacyId) || legacyId === LAUNCH_SERVER_ID)) {
      this.create(legacyId);
    }
    for (const server of this.list()) {
      await server.reattach(legacy && server.id === legacyId ? [legacy] : []);
    }
    this.syncLegacyRunRecord();
    await this.legacyQueue;
  }

  /** Which profiles start with Pyrodeck: the environment's when set, else those ticked. */
  async autostartPlan(): Promise<AutostartPlan> {
    const profiles = await listProfiles(this.opts.configDir);
    const envNames = readAutostartListEnv(this.opts.env ?? {});
    const file = this.file ?? (await readServersFile(this.opts.configDir));
    const settingProfileIds = file?.autostart ?? (this.opts.settings().autostart.profileId ? [this.opts.settings().autostart.profileId!] : []);
    const plan: AutostartPlan = { source: null, envNames, settingProfileIds, profiles: [], errors: [] };
    if (envNames.length > 0) {
      plan.source = "env";
      for (const name of envNames) {
        const choice = chooseAutostartProfile(name, null, profiles);
        if (!choice) continue;
        if ("error" in choice) plan.errors.push(choice.error);
        else if (!plan.profiles.some((p) => p.id === choice.profile.id)) plan.profiles.push(choice.profile);
      }
    } else if (settingProfileIds.length > 0) {
      plan.source = "setting";
      for (const id of settingProfileIds) {
        const choice = chooseAutostartProfile(null, id, profiles);
        if (!choice) continue;
        if ("error" in choice) plan.errors.push(choice.error);
        else plan.profiles.push(choice.profile);
      }
    }
    return plan;
  }

  private autostartChoiceFor(id: string): AutostartChoice | null {
    const plan = this.autostartPlanned;
    if (!plan?.source) return null;
    const profile = plan.profiles.find((p) => p.id === id);
    return profile ? { source: plan.source, profile } : null;
  }

  /**
   * Launch every server a playlist rotation was restarting when Pyrodeck stopped and that is down now (the old game
   * had quit and the new one was not launched yet): ServerInstance.resumeRotation. Once, after reattachAll() and
   * before autostart (runAutostart() calls it). The servers are found from their saved playlist states as well as
   * from the servers there are: a state left by a profile that no longer exists is skipped, with a log line.
   */
  resumeRotations(): Promise<void> {
    this.resumed ??= this.doResumeRotations();
    return this.resumed;
  }

  private async doResumeRotations(): Promise<void> {
    await this.init();
    const profiles = await listProfiles(this.opts.configDir);
    this.rememberNames(profiles);
    const known = new Set(profiles.map((p) => p.id));
    const ids = new Set([...this.servers.keys(), ...(await serverIdsWithPlaylistState(this.opts.configDir))]);
    for (const id of ids) {
      try {
        await this.resumeRotationOf(id, known);
      } catch (err) {
        // Autostart and the other servers go on.
        console.warn(`[Playlist] Could not resume the rotation of "${this.nameOf(id)}": ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  private async resumeRotationOf(id: string, profileIds: ReadonlySet<string>): Promise<void> {
    const server = this.servers.get(id) ?? (await this.ensure(id));
    if (server && (id === LAUNCH_SERVER_ID || profileIds.has(id))) {
      await server.resumeRotation(this.nameOf(id));
      return;
    }
    if (profileIds.has(id)) return; // a profile whose id cannot name a server (init said so)
    const entry = server
      ? await server.rotationToResume()
      : await savedRotationToResume(this.opts.configDir, path.join(serverDir(this.opts.configDir, id), PLAYLIST_STATE_FILE));
    if (entry) {
      console.warn(
        `[Playlist] The restart of "${this.nameOf(id)}" into "${entry.label}" was under way when Pyrodeck stopped, but its profile no longer exists; not launching it`,
      );
    }
  }

  /** Autostart (once), after reattachAll() and resumeRotations(): every listed profile's server, each with its own crash-loop guard. */
  async runAutostart(): Promise<void> {
    await this.init();
    if (this.autostartPlanned) return;
    await this.resumeRotations();
    const plan = await this.autostartPlan();
    this.autostartPlanned = plan;
    for (const error of plan.errors) console.error(`[Autostart] Nothing started: ${error}.`);
    for (const p of plan.profiles) await this.ensure(p.id);
    await Promise.all(this.list().map((s) => s.runAutostart()));
  }

  /** The autostart plan this run used (null before runAutostart). */
  plannedAutostart(): AutostartPlan | null {
    return this.autostartPlanned;
  }

  /**
   * Tick or untick "Start when Pyrodeck starts" for a profile. Several may be
   * on; pyrodeck.json keeps the first, for a downgrade. Takes effect at the
   * next start of Pyrodeck.
   */
  async setAutostart(profileId: string, on: boolean): Promise<string[]> {
    const file = this.file ?? (await readServersFile(this.opts.configDir)) ?? {
      version: 1 as const,
      autostart: this.opts.settings().autostart.profileId ? [this.opts.settings().autostart.profileId!] : [],
      legacyOwner: null,
    };
    const list = file.autostart.filter((id) => id !== profileId);
    if (on) list.push(profileId);
    const next: ServersFile = { ...file, autostart: list };
    if (list.join("\n") !== file.autostart.join("\n")) await writeServersFile(this.opts.configDir, next);
    this.file = this.file ? next : this.file;
    const first = list[0] ?? null;
    if (this.opts.settings().autostart.profileId !== first) await this.opts.saveAutostartSetting?.(first);
    return list;
  }

  /** Supervisor settings are Pyrodeck's (pyrodeck.json): every server's supervisor follows them. */
  applySupervisorSettings(settings: SupervisorSettings): void {
    for (const server of this.servers.values()) server.supervisor.applySettings(settings);
  }

  /** The server that keeps `<config>/playlist-state.json` for a downgrade. */
  legacyOwner(): string | null {
    return this.file?.legacyOwner ?? null;
  }

  /**
   * Keep running-server.json for a Pyrodeck that ran one server: the record
   * of the legacy owner when it runs, else of the server started first; none
   * when no server runs.
   */
  private syncLegacyRunRecord(): void {
    this.legacyQueue = this.legacyQueue
      .then(async () => {
        const live = this.list().filter((s) => s.process.isRunning() && s.process.getStatus().pid !== null);
        const owner = this.legacyOwner();
        const chosen =
          live.find((s) => s.id === owner) ??
          live.sort(
            (a, b) =>
              (a.process.getStatus().startedAt?.getTime() ?? 0) - (b.process.getStatus().startedAt?.getTime() ?? 0),
          )[0];
        if (!chosen) {
          await clearRunRecord(this.opts.configDir);
          return;
        }
        const record = await readRunRecord(serverDir(this.opts.configDir, chosen.id), SERVER_RUN_FILE);
        if (record && record.pid === chosen.process.getStatus().pid) await writeRunRecord(this.opts.configDir, record);
      })
      .catch((err) => {
        console.warn(`[Pyrodeck] Could not update running-server.json: ${err instanceof Error ? err.message : err}`);
      });
  }

  /** Wait until running-server.json is up to date (tests). */
  legacyRecordSettled(): Promise<void> {
    return this.legacyQueue;
  }
}

/** Which session each server's console output goes out from, so a session is wired once. */
const wiredSessions = new Map<string, string>();

/**
 * Stream a ready console session's output to the browsers as `serverId`'s
 * `output`, and its loss as `connection_state` disconnected. Once per session.
 */
export function wireSessionToClients(
  serverId: string,
  session: ServerSession,
  broadcast: (serverId: string, type: string, payload: Record<string, unknown>) => void = serverBroadcast,
): void {
  if (wiredSessions.get(serverId) === session.id) return;
  wiredSessions.set(serverId, session.id);
  session.connection.onData((data: string) => broadcast(serverId, "output", { raw: data }));
  session.connection.onDisconnect((reason: string) => {
    if (wiredSessions.get(serverId) === session.id) wiredSessions.delete(serverId);
    broadcast(serverId, "connection_state", { state: "disconnected", reason });
  });
}

const CONFIG_DIR = process.env.PYRODECK_CONFIG_DIR ?? "./config";

/** The env names autostart reads, for messages. */
export const AUTOSTART_ENV_NAMES = [AUTOSTART_ENV, AUTOSTART_LIST_ENV] as const;

logServerEvents(serverEvents);

/** The one registry; routes resolve their server from it. Its servers exist once init() has run (launcherRoutes). */
export const serverRegistry = new ServerRegistry({
  configDir: CONFIG_DIR,
  settings: () => pyrodeckConfig.get(),
  sessions: sessionManager,
  bus: serverEvents,
  broadcast: serverBroadcast,
  legacyPlaylist: playlistManager,
  legacyRotationHealth: rotationHealth,
  env: process.env,
  saveAutostartSetting: async (profileId) => {
    await pyrodeckConfig.save({ autostart: { profileId } });
  },
});

setDefaultServerResolver(() => serverRegistry.defaultServerId());
