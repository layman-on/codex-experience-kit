import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { ExperienceKitError } from "../core/errors.js";
import { resolveIsolatedCodexHomePath, resolveIsolatedCodexProfilePath } from "./isolated-codex-instance.js";

const execFileAsync = promisify(execFile);
const BROKER_DIRECTORY = "native-actions";
const BROKER_STATE = "broker-state.json";
const BROKER_READY_TIMEOUT_MS = 4_000;

export interface NativeActionBrokerOptions {
  libraryPath: string;
  webSocketUrl: string;
  codexExecutablePath: string;
}

export interface NativeActionBrokerConnection {
  bindingName: string;
  pid: number;
  profilePath: string;
  codexHomePath: string;
}

interface NativeActionBrokerConfiguration extends NativeActionBrokerConnection {
  instanceId: string;
  webSocketUrl: string;
  codexExecutablePath: string;
  sourceCodexHome: string;
  statePath: string;
  configPath: string;
}

interface NativeActionBrokerState extends Omit<NativeActionBrokerConnection, "codexHomePath"> {
  version: 1;
  instanceId: string;
  configPath: string;
  codexHomePath?: string;
  ready: boolean;
  startedAt: string;
}

function brokerPaths(libraryPath: string): { directory: string; statePath: string } {
  if (!path.isAbsolute(libraryPath)) throw new ExperienceKitError("native-actions/library", "Experience library path must be absolute");
  const directory = path.join(libraryPath, BROKER_DIRECTORY);
  return { directory, statePath: path.join(directory, BROKER_STATE) };
}

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

async function brokerProcessMatches(pid: number): Promise<boolean> {
  if (!Number.isSafeInteger(pid) || pid < 1 || !processExists(pid)) return false;
  const { stdout } = await execFileAsync("/bin/ps", ["-p", String(pid), "-o", "command="]).catch(() => ({ stdout: "" }));
  return stdout.includes("isolated-instance-broker-worker");
}

async function readState(statePath: string): Promise<NativeActionBrokerState | null> {
  try {
    const value = JSON.parse(await fs.readFile(statePath, "utf8")) as Partial<NativeActionBrokerState>;
    return value.version === 1 && typeof value.instanceId === "string" && typeof value.bindingName === "string"
      && typeof value.pid === "number" && typeof value.profilePath === "string" && typeof value.configPath === "string"
      ? value as NativeActionBrokerState
      : null;
  } catch { return null; }
}

export async function stopNativeActionBroker(libraryPath: string): Promise<void> {
  const { statePath } = brokerPaths(libraryPath);
  const state = await readState(statePath);
  if (state && await brokerProcessMatches(state.pid)) {
    process.kill(state.pid, "SIGTERM");
    const deadline = Date.now() + 1_500;
    while (Date.now() < deadline && processExists(state.pid)) await new Promise((resolve) => setTimeout(resolve, 50));
    if (processExists(state.pid) && await brokerProcessMatches(state.pid)) process.kill(state.pid, "SIGKILL");
  }
  if (state?.configPath) await fs.unlink(state.configPath).catch(() => undefined);
  await fs.unlink(statePath).catch(() => undefined);
}

export async function startNativeActionBroker(options: NativeActionBrokerOptions): Promise<NativeActionBrokerConnection> {
  if (process.platform !== "darwin") throw new ExperienceKitError("native-actions/platform", "Native Experience actions are currently supported only on macOS");
  const { directory, statePath } = brokerPaths(options.libraryPath);
  await stopNativeActionBroker(options.libraryPath);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const instanceId = randomUUID();
  const bindingName = `__codexExperienceNative_${randomBytes(18).toString("hex")}`;
  const profilePath = resolveIsolatedCodexProfilePath(options.libraryPath);
  const codexHomePath = resolveIsolatedCodexHomePath(options.libraryPath);
  const inheritedCodexHome = process.env.CODEX_HOME?.trim();
  const sourceCodexHome = inheritedCodexHome || path.join(os.homedir(), ".codex");
  if (!path.isAbsolute(sourceCodexHome) || sourceCodexHome === codexHomePath) {
    throw new ExperienceKitError("native-actions/codex-home", "Primary CODEX_HOME is invalid or aliases the secondary account");
  }
  const configPath = path.join(directory, `broker-${instanceId}.json`);
  const workerPath = fileURLToPath(new URL("./isolated-instance-broker-worker.js", import.meta.url));
  const configuration: NativeActionBrokerConfiguration = {
    instanceId,
    bindingName,
    pid: 0,
    profilePath,
    codexHomePath,
    sourceCodexHome,
    webSocketUrl: options.webSocketUrl,
    codexExecutablePath: options.codexExecutablePath,
    statePath,
    configPath,
  };
  await fs.writeFile(configPath, `${JSON.stringify(configuration)}\n`, { mode: 0o600 });
  const environment = { ...process.env };
  if (process.versions.electron) environment.ELECTRON_RUN_AS_NODE = "1";
  const child = spawn(process.execPath, [workerPath, configPath], {
    detached: true,
    stdio: "ignore",
    env: environment,
  });
  if (!child.pid) {
    await fs.unlink(configPath).catch(() => undefined);
    throw new ExperienceKitError("native-actions/start", "Native action broker did not return a process id");
  }
  child.unref();
  const deadline = Date.now() + BROKER_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const state = await readState(statePath);
    if (state?.instanceId === instanceId && state.ready && state.pid === child.pid && await brokerProcessMatches(child.pid)) {
      return { bindingName, pid: child.pid, profilePath, codexHomePath };
    }
    if (!processExists(child.pid)) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (processExists(child.pid) && await brokerProcessMatches(child.pid)) process.kill(child.pid, "SIGTERM");
  await Promise.all([fs.unlink(configPath).catch(() => undefined), fs.unlink(statePath).catch(() => undefined)]);
  throw new ExperienceKitError("native-actions/start", "Native action broker did not become ready");
}
