import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { access, constants as fsConstants, realpath } from "node:fs/promises";
import { createServer } from "node:net";
import { basename, join, normalize } from "node:path";
import { promisify } from "node:util";
import { ExperienceKitError, errorMessage } from "../core/errors.js";
import {
  resolveCdpPageWebSocketUrl,
  type CdpPageTargetInfo,
} from "./cdp-discovery.js";

const execFileAsync = promisify(execFile);
const CODEX_BUNDLE_ID = "com.openai.codex";
const OPENAI_TEAM_ID = "2DC432GLL2";
const CODEX_EXIT_SETTLE_MS = 1_000;
const CODEX_DEBUG_STABILITY_MS = 1_500;
const CODEX_NORMAL_STABILITY_MS = 2_500;
const CODEX_NORMAL_LAUNCH_TIMEOUT_MS = 8_000;
const UNSAFE_INHERITED_LAUNCH_ENVIRONMENT = new Set([
  "ELECTRON_ENABLE_LOGGING",
  "ELECTRON_NO_ATTACH_CONSOLE",
  "ELECTRON_RUN_AS_NODE",
  "NODE_ENV",
  "NODE_OPTIONS",
  "NODE_PATH",
]);

export interface CodexAppIdentity {
  appPath: string;
  executablePath: string;
  bundleId: string;
  teamId: string;
}

export interface CodexSessionRecord {
  origin: string;
  port: number;
  pid: number;
  processStartedAt: string;
  appPath: string;
  executablePath: string;
  instanceId?: string;
  instanceRole?: CodexSessionInstanceRole;
  profilePath?: string | null;
}

export interface CodexSessionConnection {
  record: CodexSessionRecord;
  webSocketUrl: string;
  reused: boolean;
}

export interface CodexSessionPlan {
  codexAppAvailable: boolean;
  reusableSession: boolean;
  codexRunning: boolean;
  requiresRestart: boolean;
  requiresTargetSelection?: boolean;
  selectedInstanceId?: string | null;
  instances?: CodexSessionInstance[];
}

export type CodexSessionInstanceRole = "primary" | "secondary" | "custom";
export type CodexSessionInstanceState = "connected" | "connectable" | "restart-required" | "unavailable";

export interface CodexSessionInstance {
  id: string;
  label: string;
  role: CodexSessionInstanceRole;
  pid: number;
  processStartedAt: string;
  profilePath: string | null;
  debugPort: number | null;
  state: CodexSessionInstanceState;
  connected: boolean;
  restartable: boolean;
}

export type CodexSessionGeneration = "same" | "replaced" | "exited" | "unknown";

/**
 * Result of comparing a persisted connection record with the Codex process
 * generation that exists now. A connection may point at a newly discovered
 * debug-enabled Codex process when the previous generation has been replaced.
 */
export interface CodexSessionReconciliation {
  generation: CodexSessionGeneration;
  connection: CodexSessionConnection | null;
}

export interface AcquireCodexSessionOptions {
  previous: CodexSessionRecord | null;
  targetId?: string;
  allowRestart: boolean;
  timeoutMs: number;
  signal: AbortSignal;
}

export interface CodexSessionProvider {
  isAvailable(): Promise<boolean>;
  listInstances?(previous: CodexSessionRecord | null): Promise<CodexSessionInstance[]>;
  plan(previous: CodexSessionRecord | null, targetId?: string): Promise<CodexSessionPlan>;
  reconnect(previous: CodexSessionRecord, timeoutMs: number, signal?: AbortSignal): Promise<CodexSessionConnection | null>;
  reconcile?(
    previous: CodexSessionRecord,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<CodexSessionReconciliation>;
  acquire(options: AcquireCodexSessionOptions): Promise<CodexSessionConnection>;
  restartWithoutDebugging(signal?: AbortSignal, previous?: CodexSessionRecord | null): Promise<void>;
}

export function createCodexDebugArguments(port: number): string[] {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new ExperienceKitError("codex/port", "Codex debugging port is invalid");
  }
  return [
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${port}`,
  ];
}

/**
 * LaunchServices inherits selected caller environment values. A project may be
 * running below npm, Electron, or a test runner; those Node/Electron controls
 * must never leak into the signed Codex desktop process.
 */
export function createCodexLaunchEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment = { ...source };
  for (const name of UNSAFE_INHERITED_LAUNCH_ENVIRONMENT) delete environment[name];
  return environment;
}

export function createCodexOpenArguments(appPath: string, appArguments: readonly string[] = []): string[] {
  if (!appPath) throw new ExperienceKitError("codex/app-path", "Codex application path is empty");
  return [
    "-a",
    appPath,
    ...(appArguments.length > 0 ? ["--args", ...appArguments] : []),
  ];
}

export function createCodexNewInstanceOpenArguments(appPath: string, appArguments: readonly string[] = []): string[] {
  const args = createCodexOpenArguments(appPath, appArguments);
  return ["-n", ...args];
}

export function parseCodexUserDataDirectory(command: string): string | null {
  const value = command.match(/(?:^|\s)--user-data-dir(?:=|\s+)(.*?)(?=\s--[a-z0-9-]+(?:=|\s)|$)/iu)?.[1]?.trim();
  return value ? normalize(value) : null;
}

export function codexInstanceId(profilePath: string | null): string {
  if (!profilePath) return "primary";
  return `profile-${createHash("sha256").update(normalize(profilePath)).digest("hex").slice(0, 12)}`;
}

export function selectCodexSessionInstance(
  instances: readonly CodexSessionInstance[],
  previous: CodexSessionRecord | null,
  targetId?: string,
): CodexSessionInstance | null {
  if (targetId) {
    if (targetId === "primary" && instances.length === 0) return null;
    const selected = instances.find((instance) => instance.id === targetId);
    if (!selected) throw new ExperienceKitError("codex/instance-not-found", `Codex instance was not found: ${targetId}`);
    return selected;
  }
  if (previous) {
    const selected = instances.find((instance) => (
      (previous.instanceId ? instance.id === previous.instanceId : instance.pid === previous.pid)
      && instance.pid === previous.pid
      && instance.processStartedAt === previous.processStartedAt
    ));
    if (selected) return selected;
  }
  return instances.length === 1 ? instances[0]! : null;
}

export function codexMainPageTargetRank(target: CdpPageTargetInfo): number {
  let url: URL;
  try {
    url = new URL(target.url);
  } catch {
    return Number.NEGATIVE_INFINITY;
  }
  if (url.protocol !== "app:" || url.pathname !== "/index.html") return Number.NEGATIVE_INFINITY;
  const initialRoute = url.searchParams.get("initialRoute") ?? "";
  if (initialRoute === "/avatar-overlay" || initialRoute.startsWith("/avatar-overlay/")) {
    return Number.NEGATIVE_INFINITY;
  }
  return initialRoute ? 90 : 100;
}

export function isCodexMainPageTarget(target: CdpPageTargetInfo): boolean {
  return Number.isFinite(codexMainPageTargetRank(target));
}

export function parseCodexLoopbackDebugPort(command: string): number | null {
  const address = command.match(/(?:^|\s)--remote-debugging-address(?:=|\s+)([^\s]+)(?=\s|$)/u)?.[1];
  if (address !== "127.0.0.1" && address !== "localhost" && address !== "::1" && address !== "[::1]") return null;
  const value = command.match(/(?:^|\s)--remote-debugging-port(?:=|\s+)(\d{1,5})(?=\s|$)/u)?.[1];
  const port = Number(value);
  return Number.isSafeInteger(port) && port >= 1 && port <= 65_535 ? port : null;
}

interface RunningCodexInstance {
  id: string;
  label: string;
  role: CodexSessionInstanceRole;
  pid: number;
  processStartedAt: string;
  profilePath: string | null;
  debugPort: number | null;
  restartable: boolean;
}

export interface MacOSCodexSessionProviderOptions {
  libraryPath?: string;
  spawnProcess?: typeof spawn;
}

export class MacOSCodexSessionProvider implements CodexSessionProvider {
  private identity: CodexAppIdentity | null = null;
  private readonly libraryPath: string | null;
  private readonly spawnProcess: typeof spawn;

  constructor(options: MacOSCodexSessionProviderOptions = {}) {
    this.libraryPath = options.libraryPath ?? null;
    this.spawnProcess = options.spawnProcess ?? spawn;
  }

  async getIdentity(): Promise<CodexAppIdentity> {
    return { ...await this.resolveIdentity() };
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.resolveIdentity();
      return true;
    } catch {
      return false;
    }
  }

  async listInstances(previous: CodexSessionRecord | null): Promise<CodexSessionInstance[]> {
    const identity = await this.resolveIdentity();
    const running = await this.findRunningInstances(identity);
    return Promise.all(running.map(async (instance) => {
      const connected = Boolean(
        previous
        && (previous.instanceId ? previous.instanceId === instance.id : previous.pid === instance.pid)
        && previous.pid === instance.pid
        && previous.processStartedAt === instance.processStartedAt
        && previous.port === instance.debugPort,
      );
      let connectable = false;
      if (instance.debugPort) {
        connectable = await this.connectionForInstance(identity, instance, 1_200).then(Boolean, () => false);
      }
      return {
        ...instance,
        connected: connected && connectable,
        state: connected && connectable
          ? "connected"
          : connectable
            ? "connectable"
            : instance.restartable ? "restart-required" : "unavailable",
      };
    }));
  }

  async plan(previous: CodexSessionRecord | null, targetId?: string): Promise<CodexSessionPlan> {
    let identity: CodexAppIdentity;
    try {
      identity = await this.resolveIdentity();
    } catch {
      return {
        codexAppAvailable: false,
        reusableSession: false,
        codexRunning: false,
        requiresRestart: false,
      };
    }
    const instances = await this.listInstances(previous);
    const selected = selectCodexSessionInstance(instances, previous, targetId);
    const codexRunning = instances.length > 0;
    const reusableSession = selected?.state === "connected" || selected?.state === "connectable";
    return {
      codexAppAvailable: true,
      reusableSession,
      codexRunning,
      requiresRestart: Boolean(selected && !reusableSession && selected.restartable),
      requiresTargetSelection: instances.length > 1 && !selected,
      selectedInstanceId: selected?.id ?? (instances.length === 0 ? "primary" : null),
      instances,
    };
  }

  async reconnect(
    previous: CodexSessionRecord,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<CodexSessionConnection | null> {
    const identity = await this.resolveIdentity();
    if (
      previous.appPath !== identity.appPath
      || previous.executablePath !== identity.executablePath
      || previous.origin !== `http://127.0.0.1:${previous.port}`
      || !Number.isSafeInteger(previous.pid)
    ) return null;
    if (!(await this.pidMatchesExecutable(previous.pid, identity.executablePath))) return null;
    if (await this.processStartedAt(previous.pid) !== previous.processStartedAt) return null;
    if (!(await this.portBelongsToCodex(previous.port, identity.executablePath))) return null;
    try {
      const instances = await this.findRunningInstances(identity);
      const instance = instances.find((candidate) => candidate.pid === previous.pid && candidate.processStartedAt === previous.processStartedAt);
      if (!instance || instance.debugPort !== previous.port) return null;
      const connection = await this.connectionForInstance(identity, instance, timeoutMs);
      return connection ? { ...connection, reused: true } : null;
    } catch {
      if (signal?.aborted) throw signal.reason;
      return null;
    }
  }

  async reconcile(
    previous: CodexSessionRecord,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<CodexSessionReconciliation> {
    this.throwIfAborted(signal);
    const connection = await this.reconnect(previous, timeoutMs, signal).catch((error) => {
      if (signal?.aborted) throw signal.reason;
      return null;
    });
    if (connection) return { generation: "same", connection };

    // Do not adopt a different Codex instance while the recorded process is
    // still alive. Its renderer may only be reconstructing and its injected
    // Experience may still exist even though CDP is temporarily unavailable.
    if (await this.isSameProcessGeneration(previous)) {
      return { generation: "same", connection: null };
    }

    let identity: CodexAppIdentity;
    try {
      identity = await this.resolveIdentity();
    } catch {
      return { generation: "unknown", connection: null };
    }
    const discovered = await this.discoverRunningConnection(identity, timeoutMs, signal, previous.instanceId).catch((error) => {
      if (signal?.aborted) throw signal.reason;
      return null;
    });
    if (discovered) return { generation: "replaced", connection: discovered };

    const running = await this.findMainProcessIds(identity.executablePath).catch(() => []);
    return {
      generation: running.length > 0 ? "replaced" : "exited",
      connection: null,
    };
  }

  async acquire(options: AcquireCodexSessionOptions): Promise<CodexSessionConnection> {
    this.throwIfAborted(options.signal);
    if (options.previous && (!options.targetId || options.targetId === options.previous.instanceId)) {
      const existing = await this.reconnect(options.previous, 1_200, options.signal);
      if (existing) return existing;
    }
    const identity = await this.resolveIdentity();
    const instances = await this.listInstances(options.previous);
    let selected = selectCodexSessionInstance(instances, options.previous, options.targetId);
    if (!selected && instances.length > 1) {
      throw new ExperienceKitError("codex/target-selection-required", "Multiple Codex instances are running; select a target instance before applying");
    }
    if (selected?.state === "connected" || selected?.state === "connectable") {
      const raw = (await this.findRunningInstances(identity)).find((instance) => instance.id === selected!.id && instance.pid === selected!.pid);
      const connection = raw ? await this.connectionForInstance(identity, raw, 1_200) : null;
      if (connection) return { ...connection, reused: true };
    }
    if (selected && !selected.restartable) {
      throw new ExperienceKitError("codex/instance-not-restartable", `Codex instance ${selected.label} was not launched by the Kit and has no reusable CDP connection`);
    }
    if (selected && !options.allowRestart) {
      throw new ExperienceKitError(
        "codex/restart-required",
        `${selected.label} must restart once to enable the local experience connection`,
      );
    }
    if (selected) {
      await this.stopInstance(selected.pid, options.signal);
      await this.delay(CODEX_EXIT_SETTLE_MS, options.signal);
    }
    const port = await this.reserveLoopbackPort();
    this.throwIfAborted(options.signal);
    const launchTarget = selected ? {
      id: selected.id,
      label: selected.label,
      role: selected.role,
      profilePath: selected.profilePath,
    } : { id: "primary", label: "Primary Codex", role: "primary" as const, profilePath: null };
    try {
      await this.launchInstance(identity, launchTarget, createCodexDebugArguments(port));
      return await this.waitForConnection(identity, port, launchTarget.id, options.timeoutMs, options.signal);
    } catch (error) {
      if (options.signal.aborted) throw options.signal.reason;
      try {
        for (const instance of await this.findRunningInstances(identity)) {
          if (instance.id === launchTarget.id) await this.stopInstance(instance.pid, options.signal);
        }
        await this.launchInstance(identity, launchTarget, []);
        await this.waitForStableMainProcess(
          identity,
          launchTarget.id,
          CODEX_NORMAL_LAUNCH_TIMEOUT_MS,
          CODEX_NORMAL_STABILITY_MS,
          options.signal,
        );
      } catch (recoveryError) {
        throw new ExperienceKitError(
          "codex/launch-recovery",
          `Unable to launch Codex experience mode, and the normal Codex relaunch also failed: ${errorMessage(recoveryError)}`,
          { cause: new AggregateError([error, recoveryError]) },
        );
      }
      if (error instanceof ExperienceKitError) throw error;
      throw new ExperienceKitError("codex/launch", "Unable to launch Codex experience mode", { cause: error });
    }
  }

  async restartWithoutDebugging(signal?: AbortSignal, previous?: CodexSessionRecord | null): Promise<void> {
    const identity = await this.resolveIdentity();
    const instances = await this.listInstances(previous ?? null);
    let selected = previous
      ? instances.find((instance) => (previous.instanceId ? instance.id === previous.instanceId : instance.pid === previous.pid)) ?? null
      : instances.length === 1 ? instances[0]! : null;
    if (!selected && previous?.instanceId) {
      selected = {
        id: previous.instanceId,
        label: previous.instanceRole === "secondary" ? "Secondary Codex" : "Primary Codex",
        role: previous.instanceRole ?? "primary",
        pid: previous.pid,
        processStartedAt: previous.processStartedAt,
        profilePath: previous.profilePath ?? null,
        debugPort: previous.port,
        state: "restart-required",
        connected: false,
        restartable: previous.instanceRole !== "custom",
      };
    }
    if (!selected) throw new ExperienceKitError("codex/target-selection-required", "Select a Codex instance before restarting it");
    if (!selected.restartable) throw new ExperienceKitError("codex/instance-not-restartable", `${selected.label} cannot be safely restarted by the Kit`);
    if (instances.some((instance) => instance.pid === selected!.pid)) {
      await this.stopInstance(selected.pid, signal);
      await this.delay(CODEX_EXIT_SETTLE_MS, signal);
    }
    await this.launchInstance(identity, selected, []);
    await this.waitForStableMainProcess(
      identity,
      selected.id,
      CODEX_NORMAL_LAUNCH_TIMEOUT_MS,
      CODEX_NORMAL_STABILITY_MS,
      signal,
    );
  }

  private async waitForConnection(
    identity: CodexAppIdentity,
    port: number,
    instanceId: string,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<CodexSessionConnection> {
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown = null;
    let sawMainProcess = false;
    while (Date.now() < deadline) {
      this.throwIfAborted(signal);
      const instances = await this.findRunningInstances(identity);
      const launched = instances.find((instance) => instance.id === instanceId && instance.debugPort === port);
      if (launched) sawMainProcess = true;
      else if (sawMainProcess) {
        throw new ExperienceKitError(
          "codex/launch-exited",
          "Codex exited before its local experience connection became stable",
        );
      }
      try {
        if (!(await this.portBelongsToCodex(port, identity.executablePath))) {
          throw new ExperienceKitError("codex/endpoint-owner", "Debugging endpoint is not owned by Codex");
        }
        await resolveCdpPageWebSocketUrl(`http://127.0.0.1:${port}`, {
          timeoutMs: Math.min(1_200, Math.max(1, deadline - Date.now())),
          accept: isCodexMainPageTarget,
          rank: codexMainPageTargetRank,
        });
        await this.delay(
          Math.min(CODEX_DEBUG_STABILITY_MS, Math.max(1, deadline - Date.now())),
          signal,
        );
        const stable = (await this.findRunningInstances(identity))
          .find((instance) => instance.id === instanceId && instance.debugPort === port);
        if (!stable) throw new ExperienceKitError("codex/process", "Selected Codex instance was not found after launch");
        const connection = await this.connectionForInstance(identity, stable, Math.min(1_200, Math.max(1, deadline - Date.now())));
        if (!connection) throw new ExperienceKitError("codex/endpoint-owner", "Selected Codex debugging endpoint disappeared during startup");
        return { ...connection, reused: false };
      } catch (error) {
        lastError = error;
        await this.delay(Math.min(250, Math.max(1, deadline - Date.now())), signal);
      }
    }
    throw new ExperienceKitError(
      "codex/discovery",
      `Codex started without an available page target: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
      { cause: lastError },
    );
  }

  private async discoverRunningConnection(
    identity: CodexAppIdentity,
    timeoutMs: number,
    signal?: AbortSignal,
    instanceId?: string,
  ): Promise<CodexSessionConnection | null> {
    const instances = await this.findRunningInstances(identity);
    const candidates = instanceId
      ? instances.filter((instance) => instance.id === instanceId)
      : instances.length === 1 ? instances : [];
    for (const instance of candidates) {
      this.throwIfAborted(signal);
      if (!instance.debugPort) continue;
      try {
        const connection = await this.connectionForInstance(identity, instance, timeoutMs);
        if (connection) return { ...connection, reused: true };
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
      }
    }
    return null;
  }

  private async connectionForInstance(
    identity: CodexAppIdentity,
    instance: RunningCodexInstance,
    timeoutMs: number,
  ): Promise<CodexSessionConnection | null> {
    const port = instance.debugPort;
    if (!port || !(await this.portBelongsToCodex(port, identity.executablePath))) return null;
    const webSocketUrl = await resolveCdpPageWebSocketUrl(`http://127.0.0.1:${port}`, {
      timeoutMs,
      accept: isCodexMainPageTarget,
      rank: codexMainPageTargetRank,
    });
    return {
      record: {
        origin: `http://127.0.0.1:${port}`,
        port,
        pid: instance.pid,
        processStartedAt: instance.processStartedAt,
        appPath: identity.appPath,
        executablePath: identity.executablePath,
        instanceId: instance.id,
        instanceRole: instance.role,
        profilePath: instance.profilePath,
      },
      webSocketUrl,
      reused: true,
    };
  }

  private async findRunningInstances(identity: CodexAppIdentity): Promise<RunningCodexInstance[]> {
    const pids = await this.findMainProcessIds(identity.executablePath);
    return Promise.all(pids.map(async (pid) => {
      const command = await this.processCommand(pid);
      const profilePath = parseCodexUserDataDirectory(command);
      const secondaryProfile = this.libraryPath
        ? normalize(join(this.libraryPath, "isolated-instances", "secondary", "user-data"))
        : null;
      const role: CodexSessionInstanceRole = !profilePath
        ? "primary"
        : secondaryProfile && profilePath === secondaryProfile ? "secondary" : "custom";
      return {
        id: codexInstanceId(profilePath),
        label: role === "primary"
          ? "Primary Codex"
          : role === "secondary" ? "Secondary Codex" : `Codex profile · ${basename(profilePath!)}`,
        role,
        pid,
        processStartedAt: await this.processStartedAt(pid),
        profilePath,
        debugPort: parseCodexLoopbackDebugPort(command),
        restartable: role !== "custom",
      };
    }));
  }

  private async launchInstance(
    identity: CodexAppIdentity,
    instance: Pick<RunningCodexInstance, "id" | "label" | "role" | "profilePath">,
    appArguments: readonly string[],
  ): Promise<void> {
    if (instance.role === "primary") {
      await execFileAsync("/usr/bin/open", createCodexNewInstanceOpenArguments(identity.appPath, appArguments), {
        timeout: 5_000,
        maxBuffer: 256 * 1024,
        env: createCodexLaunchEnvironment(),
      });
      return;
    }
    if (instance.role !== "secondary" || !instance.profilePath || !this.libraryPath) {
      throw new ExperienceKitError("codex/instance-not-restartable", `${instance.label} cannot be safely launched by the Kit`);
    }
    const codexHomePath = join(this.libraryPath, "isolated-instances", "secondary", "codex-home");
    const environment = createCodexLaunchEnvironment();
    delete environment.CODEX_ELECTRON_AGENT_RUN_ID;
    delete environment.CODEX_ELECTRON_CHROMIUM_SWITCHES;
    environment.CODEX_ELECTRON_USER_DATA_PATH = instance.profilePath;
    environment.CODEX_HOME = codexHomePath;
    const child: ChildProcess = this.spawnProcess(identity.executablePath, [
      `--user-data-dir=${instance.profilePath}`,
      ...appArguments,
    ], { detached: true, stdio: "ignore", env: environment });
    if (!child.pid) throw new ExperienceKitError("codex/launch", `${instance.label} did not return a process id`);
    child.unref();
  }

  private async stopInstance(pid: number, signal?: AbortSignal): Promise<void> {
    if (!Number.isSafeInteger(pid) || pid <= 1) throw new ExperienceKitError("codex/process", "Codex instance pid is invalid");
    try { process.kill(pid, "SIGTERM"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      this.throwIfAborted(signal);
      if (!this.processExists(pid)) return;
      await this.delay(200, signal);
    }
    throw new ExperienceKitError("codex/quit-timeout", `Codex instance ${pid} did not exit within the safe timeout`);
  }

  private async waitForStableMainProcess(
    identity: CodexAppIdentity,
    instanceId: string,
    timeoutMs: number,
    stabilityMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let stableSince = 0;
    let sawMainProcess = false;
    while (Date.now() < deadline) {
      this.throwIfAborted(signal);
      const running = (await this.findRunningInstances(identity)).some((instance) => instance.id === instanceId);
      if (running) {
        sawMainProcess = true;
        if (stableSince === 0) stableSince = Date.now();
        if (Date.now() - stableSince >= stabilityMs) return;
      } else {
        if (sawMainProcess) {
          throw new ExperienceKitError("codex/normal-launch-exited", "Codex exited during normal relaunch");
        }
        stableSince = 0;
      }
      await this.delay(Math.min(200, Math.max(1, deadline - Date.now())), signal);
    }
    throw new ExperienceKitError(
      "codex/normal-launch-timeout",
      sawMainProcess
        ? "Codex did not remain stable after normal relaunch"
        : "Codex process was not found after normal relaunch",
    );
  }

  private async resolveIdentity(): Promise<CodexAppIdentity> {
    if (this.identity) return this.identity;
    if (process.platform !== "darwin") {
      throw new ExperienceKitError("codex/platform", "Codex experience sessions currently support macOS only");
    }
    const candidates = new Set<string>([
      "/Applications/Codex.app",
      "/Applications/ChatGPT.app",
      join(process.env.HOME || "", "Applications", "Codex.app"),
      join(process.env.HOME || "", "Applications", "ChatGPT.app"),
    ]);
    try {
      const result = await execFileAsync("/usr/bin/mdfind", [
        `kMDItemCFBundleIdentifier == "${CODEX_BUNDLE_ID}"`,
      ], { timeout: 3_000, maxBuffer: 256 * 1024 });
      for (const line of result.stdout.split("\n")) {
        if (line.trim().endsWith(".app")) candidates.add(line.trim());
      }
    } catch {
      // Fixed paths remain authoritative fallbacks.
    }
    for (const candidate of candidates) {
      if (!candidate) continue;
      try {
        const appPath = await realpath(candidate);
        await access(join(appPath, "Contents", "Info.plist"), fsConstants.R_OK);
        const bundleId = await this.readPlistValue(appPath, ":CFBundleIdentifier");
        if (bundleId !== CODEX_BUNDLE_ID) continue;
        const executableName = await this.readPlistValue(appPath, ":CFBundleExecutable");
        const executablePath = join(appPath, "Contents", "MacOS", executableName);
        await access(executablePath, fsConstants.X_OK);
        const teamId = await this.readSigningTeam(appPath);
        if (teamId !== OPENAI_TEAM_ID) continue;
        this.identity = { appPath, executablePath, bundleId, teamId };
        return this.identity;
      } catch {
        // Continue until the exact official identity is found.
      }
    }
    throw new ExperienceKitError("codex/not-found", "No OpenAI-signed Codex application was found");
  }

  private async readPlistValue(appPath: string, key: string): Promise<string> {
    const result = await execFileAsync("/usr/libexec/PlistBuddy", [
      "-c", `Print ${key}`, join(appPath, "Contents", "Info.plist"),
    ], { timeout: 3_000, maxBuffer: 64 * 1024 });
    return result.stdout.trim();
  }

  private async readSigningTeam(appPath: string): Promise<string> {
    try {
      const result = await execFileAsync("/usr/bin/codesign", ["-dv", "--verbose=4", appPath], {
        timeout: 5_000,
        maxBuffer: 256 * 1024,
      });
      return `${result.stdout}\n${result.stderr}`.match(/^TeamIdentifier=(.+)$/mu)?.[1]?.trim() || "";
    } catch (error) {
      const output = `${(error as { stdout?: string }).stdout || ""}\n${(error as { stderr?: string }).stderr || ""}`;
      return output.match(/^TeamIdentifier=(.+)$/mu)?.[1]?.trim() || "";
    }
  }

  private async findMainProcessIds(executablePath: string): Promise<number[]> {
    const result = await execFileAsync("/bin/ps", ["-axo", "pid=,command="], {
      timeout: 3_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    const ids: number[] = [];
    for (const line of result.stdout.split("\n")) {
      const match = line.match(/^\s*(\d+)\s+(.+)$/u);
      if (!match || !(match[2] ?? "").startsWith(executablePath)) continue;
      const pid = Number(match[1]);
      if (await this.pidMatchesExecutable(pid, executablePath)) ids.push(pid);
    }
    return ids;
  }

  private async pidMatchesExecutable(pid: number, executablePath: string): Promise<boolean> {
    try {
      const result = await execFileAsync("/usr/sbin/lsof", ["-a", "-p", String(pid), "-d", "txt", "-Fn"], {
        timeout: 2_000,
        maxBuffer: 256 * 1024,
      });
      const actual = result.stdout.split("\n").find((line) => line.startsWith("n"))?.slice(1);
      return Boolean(actual) && await realpath(actual!) === await realpath(executablePath);
    } catch {
      return false;
    }
  }

  private async isSameProcessGeneration(previous: CodexSessionRecord): Promise<boolean> {
    if (!Number.isSafeInteger(previous.pid) || previous.pid <= 1) return false;
    if (!(await this.pidMatchesExecutable(previous.pid, previous.executablePath))) return false;
    return await this.processStartedAt(previous.pid).catch(() => "") === previous.processStartedAt;
  }

  private async portBelongsToCodex(port: number, executablePath: string): Promise<boolean> {
    try {
      const result = await execFileAsync("/usr/sbin/lsof", [
        "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t",
      ], { timeout: 2_000, maxBuffer: 64 * 1024 });
      const pids = [...new Set(result.stdout
        .split("\n")
        .map((value) => Number(value.trim()))
        .filter((pid) => Number.isSafeInteger(pid) && pid > 1))];
      if (pids.length === 0) return false;
      for (const pid of pids) {
        if (!(await this.pidIsCodexDescendant(pid, executablePath))) return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  private async pidIsCodexDescendant(pid: number, executablePath: string): Promise<boolean> {
    let current = pid;
    for (let depth = 0; current > 1 && depth < 32; depth += 1) {
      if (await this.pidMatchesExecutable(current, executablePath)) return true;
      try {
        const result = await execFileAsync("/bin/ps", ["-p", String(current), "-o", "ppid="], {
          timeout: 1_000,
          maxBuffer: 16 * 1024,
        });
        const parent = Number(result.stdout.trim());
        if (!Number.isSafeInteger(parent) || parent < 1 || parent === current) return false;
        current = parent;
      } catch {
        return false;
      }
    }
    return false;
  }

  private async processStartedAt(pid: number): Promise<string> {
    const result = await execFileAsync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
      timeout: 1_000,
      maxBuffer: 16 * 1024,
    });
    const value = result.stdout.trim();
    if (!value) throw new ExperienceKitError("codex/process-start", "Unable to read Codex process start time");
    return value;
  }

  private async processCommand(pid: number): Promise<string> {
    const result = await execFileAsync("/bin/ps", ["-p", String(pid), "-o", "command="], {
      timeout: 1_000,
      maxBuffer: 64 * 1024,
    });
    return result.stdout.trim();
  }

  private processExists(pid: number): boolean {
    try { process.kill(pid, 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
  }

  private reserveLoopbackPort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = createServer();
      server.unref();
      server.once("error", reject);
      server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
        const address = server.address();
        const port = typeof address === "object" && address ? address.port : 0;
        server.close((error) => {
          if (error) reject(error);
          else if (!port) reject(new ExperienceKitError("codex/port", "Unable to reserve a local port"));
          else resolve(port);
        });
      });
    });
  }

  private delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, milliseconds);
      const abort = () => {
        clearTimeout(timer);
        reject(signal?.reason ?? new DOMException("Operation aborted", "AbortError"));
      };
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
    });
  }

  private throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw signal.reason ?? new DOMException("Operation aborted", "AbortError");
  }
}
