import { execFile, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { ExperienceKitError } from "../core/errors.js";
import { createCodexLaunchEnvironment } from "./codex-app-session.js";

export const ISOLATED_CODEX_SLOT = "secondary";
export const CODEX_USER_DATA_ENVIRONMENT = "CODEX_ELECTRON_USER_DATA_PATH";
export const CODEX_HOME_ENVIRONMENT = "CODEX_HOME";
const execFileAsync = promisify(execFile);

export interface LaunchIsolatedCodexInstanceOptions {
  executablePath: string;
  profilePath: string;
  codexHomePath: string;
  environment?: NodeJS.ProcessEnv;
  spawnProcess?: typeof spawn;
}

export interface IsolatedCodexLaunchResult {
  pid: number;
  profilePath: string;
  codexHomePath: string;
}

export interface OpenIsolatedCodexInstanceResult extends IsolatedCodexLaunchResult {
  reused: boolean;
}

export interface IsolatedCodexInstanceStatus {
  slot: typeof ISOLATED_CODEX_SLOT;
  initialized: boolean;
  authenticated: boolean;
  running: boolean;
  pids: number[];
  profilePath: string;
  codexHomePath: string;
  launcherPath: string;
}

export interface InstallIsolatedCodexLauncherOptions {
  executablePath: string;
  profilePath: string;
  codexHomePath: string;
  launcherPath?: string;
}

const SECONDARY_LAUNCHER_NAME = "Codex Secondary.app";
const SECONDARY_LAUNCHER_BUNDLE_ID = "dev.codex-experience-kit.secondary";

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

export function resolveIsolatedCodexProfilePath(libraryPath: string): string {
  if (!path.isAbsolute(libraryPath)) throw new ExperienceKitError("isolated-instance/library", "Experience library path must be absolute");
  return path.join(libraryPath, "isolated-instances", ISOLATED_CODEX_SLOT, "user-data");
}

export function resolveIsolatedCodexHomePath(libraryPath: string): string {
  if (!path.isAbsolute(libraryPath)) throw new ExperienceKitError("isolated-instance/library", "Experience library path must be absolute");
  return path.join(libraryPath, "isolated-instances", ISOLATED_CODEX_SLOT, "codex-home");
}

export function resolveIsolatedCodexLauncherPath(homeDirectory = os.homedir()): string {
  if (!path.isAbsolute(homeDirectory)) throw new ExperienceKitError("isolated-instance/home", "Home directory must be absolute");
  return path.join(homeDirectory, "Applications", SECONDARY_LAUNCHER_NAME);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

export async function installIsolatedCodexLauncher(options: InstallIsolatedCodexLauncherOptions): Promise<string> {
  for (const [value, label] of [[options.executablePath, "Codex executable"], [options.profilePath, "Profile"], [options.codexHomePath, "CODEX_HOME"]] as const) {
    if (!path.isAbsolute(value)) throw new ExperienceKitError("isolated-instance/launcher-path", `${label} path must be absolute`);
  }
  await fs.access(options.executablePath);
  const launcherPath = options.launcherPath ?? resolveIsolatedCodexLauncherPath();
  if (!path.isAbsolute(launcherPath) || path.extname(launcherPath) !== ".app") {
    throw new ExperienceKitError("isolated-instance/launcher-path", "Launcher path must be an absolute .app bundle path");
  }
  const contents = path.join(launcherPath, "Contents");
  const executableDirectory = path.join(contents, "MacOS");
  const resources = path.join(contents, "Resources");
  const launcherExecutable = path.join(executableDirectory, "CodexSecondary");
  await Promise.all([
    fs.mkdir(executableDirectory, { recursive: true, mode: 0o700 }),
    fs.mkdir(resources, { recursive: true, mode: 0o700 }),
  ]);
  const script = `#!/bin/zsh
unset ELECTRON_RUN_AS_NODE NODE_OPTIONS NODE_PATH NODE_ENV ELECTRON_ENABLE_LOGGING ELECTRON_NO_ATTACH_CONSOLE CODEX_ELECTRON_AGENT_RUN_ID CODEX_ELECTRON_CHROMIUM_SWITCHES
export ${CODEX_USER_DATA_ENVIRONMENT}=${shellQuote(options.profilePath)}
export ${CODEX_HOME_ENVIRONMENT}=${shellQuote(options.codexHomePath)}
exec ${shellQuote(options.executablePath)} ${shellQuote(`--user-data-dir=${options.profilePath}`)}
`;
  const appPath = path.resolve(path.dirname(options.executablePath), "..", "..");
  const iconSource = path.join(appPath, "Contents", "Resources", "electron.icns");
  const iconAvailable = await fs.access(iconSource).then(() => true, () => false);
  if (iconAvailable) await fs.copyFile(iconSource, path.join(resources, "CodexSecondary.icns"));
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleDisplayName</key><string>Codex Secondary</string>
  <key>CFBundleExecutable</key><string>CodexSecondary</string>
  <key>CFBundleIdentifier</key><string>${xml(SECONDARY_LAUNCHER_BUNDLE_ID)}</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>Codex Secondary</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  ${iconAvailable ? "<key>CFBundleIconFile</key><string>CodexSecondary.icns</string>" : ""}
  <key>NSHighResolutionCapable</key><true/>
</dict></plist>
`;
  await Promise.all([
    fs.writeFile(launcherExecutable, script, { mode: 0o700 }),
    fs.writeFile(path.join(contents, "Info.plist"), plist, { mode: 0o600 }),
    fs.writeFile(path.join(contents, "PkgInfo"), "APPL????", { mode: 0o600 }),
  ]);
  await fs.chmod(launcherExecutable, 0o700);
  return launcherPath;
}

export async function inspectIsolatedCodexInstance(
  libraryPath: string,
  executablePath: string,
  homeDirectory = os.homedir(),
): Promise<IsolatedCodexInstanceStatus> {
  const profilePath = resolveIsolatedCodexProfilePath(libraryPath);
  const codexHomePath = resolveIsolatedCodexHomePath(libraryPath);
  const initialized = await Promise.all([
    fs.access(profilePath).then(() => true, () => false),
    fs.access(path.join(codexHomePath, "state_5.sqlite")).then(() => true, () => false),
  ]).then((values) => values.every(Boolean));
  const authenticated = await fs.access(path.join(codexHomePath, "auth.json")).then(() => true, () => false);
  const pids = await findIsolatedCodexInstancePids(executablePath, profilePath);
  return {
    slot: ISOLATED_CODEX_SLOT,
    initialized,
    authenticated,
    running: pids.length > 0,
    pids,
    profilePath,
    codexHomePath,
    launcherPath: resolveIsolatedCodexLauncherPath(homeDirectory),
  };
}

export async function openIsolatedCodexInstance(
  options: LaunchIsolatedCodexInstanceOptions,
): Promise<OpenIsolatedCodexInstanceResult> {
  const pids = await findIsolatedCodexInstancePids(options.executablePath, options.profilePath);
  if (pids[0]) return { pid: pids[0], profilePath: options.profilePath, codexHomePath: options.codexHomePath, reused: true };
  return { ...await launchIsolatedCodexInstance(options), reused: false };
}

export function createIsolatedCodexEnvironment(
  profilePath: string,
  codexHomePath: string,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  if (!path.isAbsolute(profilePath)) throw new ExperienceKitError("isolated-instance/profile", "Isolated Codex profile path must be absolute");
  if (!path.isAbsolute(codexHomePath)) throw new ExperienceKitError("isolated-instance/codex-home", "Isolated Codex home path must be absolute");
  const environment = createCodexLaunchEnvironment(source);
  delete environment.CODEX_ELECTRON_AGENT_RUN_ID;
  delete environment.CODEX_ELECTRON_CHROMIUM_SWITCHES;
  environment[CODEX_USER_DATA_ENVIRONMENT] = profilePath;
  environment[CODEX_HOME_ENVIRONMENT] = codexHomePath;
  return environment;
}

export function createIsolatedCodexArguments(profilePath: string): string[] {
  if (!path.isAbsolute(profilePath)) throw new ExperienceKitError("isolated-instance/profile", "Isolated Codex profile path must be absolute");
  return [`--user-data-dir=${profilePath}`];
}

export async function findIsolatedCodexInstancePids(executablePath: string, profilePath: string): Promise<number[]> {
  if (!path.isAbsolute(executablePath)) throw new ExperienceKitError("isolated-instance/executable", "Codex executable path must be absolute");
  if (!path.isAbsolute(profilePath)) throw new ExperienceKitError("isolated-instance/profile", "Isolated Codex profile path must be absolute");
  const { stdout } = await execFileAsync("/bin/ps", ["-ax", "-o", "pid=", "-o", "command="], { maxBuffer: 8 * 1024 * 1024 });
  const prefix = `${executablePath} `;
  const profileArgument = `--user-data-dir=${profilePath}`;
  return stdout.split("\n").flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(.+)$/u);
    if (!match || !match[2]?.startsWith(prefix) || !match[2].includes(profileArgument)) return [];
    const pid = Number(match[1]);
    return Number.isSafeInteger(pid) && pid > 0 ? [pid] : [];
  });
}

export async function stopIsolatedCodexInstance(executablePath: string, profilePath: string, timeoutMs = 8_000): Promise<number[]> {
  const pids = await findIsolatedCodexInstancePids(executablePath, profilePath);
  for (const pid of pids) process.kill(pid, "SIGTERM");
  const deadline = Date.now() + timeoutMs;
  while (pids.some(processExists) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
  const remaining = pids.filter(processExists);
  if (remaining.length > 0) throw new ExperienceKitError("isolated-instance/stop", "Secondary Codex did not close in time; conversation sync was not started");
  return pids;
}

export async function launchIsolatedCodexInstance(
  options: LaunchIsolatedCodexInstanceOptions,
): Promise<IsolatedCodexLaunchResult> {
  if (process.platform !== "darwin") throw new ExperienceKitError("isolated-instance/platform", "Isolated Codex instances are currently supported only on macOS");
  if (!path.isAbsolute(options.executablePath)) throw new ExperienceKitError("isolated-instance/executable", "Codex executable path must be absolute");
  if (!path.isAbsolute(options.profilePath)) throw new ExperienceKitError("isolated-instance/profile", "Isolated Codex profile path must be absolute");
  if (!path.isAbsolute(options.codexHomePath)) throw new ExperienceKitError("isolated-instance/codex-home", "Isolated Codex home path must be absolute");
  await fs.access(options.executablePath);
  await Promise.all([
    fs.mkdir(options.profilePath, { recursive: true, mode: 0o700 }),
    fs.mkdir(options.codexHomePath, { recursive: true, mode: 0o700 }),
  ]);
  await Promise.all([
    fs.chmod(options.profilePath, 0o700).catch(() => undefined),
    fs.chmod(options.codexHomePath, 0o700).catch(() => undefined),
  ]);
  const child: ChildProcess = (options.spawnProcess ?? spawn)(options.executablePath, createIsolatedCodexArguments(options.profilePath), {
    detached: true,
    stdio: "ignore",
    env: createIsolatedCodexEnvironment(options.profilePath, options.codexHomePath, options.environment),
  });
  if (!child.pid) throw new ExperienceKitError("isolated-instance/launch", "Codex isolated instance did not return a process id");
  child.unref();
  return { pid: child.pid, profilePath: options.profilePath, codexHomePath: options.codexHomePath };
}
