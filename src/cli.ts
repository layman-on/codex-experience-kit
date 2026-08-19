#!/usr/bin/env node
import { spawn } from "node:child_process";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import { experienceWebviewRiskMetadata, type ExperienceWebviewRiskMetadata } from "./core/experience-project.js";
import {
  CodexExperienceRuntime,
  resolveCodexExperienceLibraryPath,
  type CodexExperienceAppearanceOptions,
  type CodexExperienceDirectApplyOptions,
} from "./node/codex-experience-runtime.js";
import { MacOSCodexSessionProvider } from "./node/codex-app-session.js";
import {
  inspectIsolatedCodexInstance,
  installIsolatedCodexLauncher,
  openIsolatedCodexInstance,
} from "./node/isolated-codex-instance.js";
import {
  buildExperienceProject,
  checkExperienceProject,
  initializeExperienceProject,
  packExperienceProject,
  startExperienceDevServer,
} from "./node/experience-project-tools.js";
import { launchElectronExperiencePreview, type ElectronExperiencePreviewHandle } from "./node/electron-preview-launcher.js";

const VALUE_FLAGS = new Set([
  "--id", "--name", "--framework", "--port", "--library", "--seed", "--dark-seed", "--contrast", "--appearance",
]);

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function positional(args: string[]): string | undefined {
  for (let index = 1; index < args.length; index += 1) {
    const value = args[index]!;
    if (VALUE_FLAGS.has(value)) { index += 1; continue; }
    if (!value.startsWith("--")) return value;
  }
  return undefined;
}

function help(): void {
  console.log(`codex-experience <command>

Authoring:
  init [directory] [--id id] [--name name] [--framework react|vue]
  dev [directory] [--port port] [--no-open] [--native] [--allow-unrestricted-remote-content]
  build [directory]
  check [directory]
  pack [directory]

Direct Codex control (an external host is not required):
  apply [project|dist|zip|id] [--seed color] [--appearance light|dark] [--allow-restart] [--allow-unrestricted-remote-content]
  appearance [--seed color] [--dark-seed color] [--contrast soft|standard|high] [--appearance light|dark]
  cancel
  status
  install <dist|zip> [--replace]
  list

Secondary Codex account:
  instance status
  instance open
  instance install-launcher

Common runtime option:
  --library <directory>    Override the default ~/Library/Application Support/CodexExperienceKit`);
}

function openPreview(url: string): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.on("error", () => undefined);
  child.unref();
}

function appearanceOptions(args: string[]): CodexExperienceAppearanceOptions {
  const contrast = flag(args, "--contrast");
  if (contrast && contrast !== "soft" && contrast !== "standard" && contrast !== "high") {
    throw new Error("--contrast must be soft, standard, or high");
  }
  const appearance = flag(args, "--appearance");
  if (appearance && appearance !== "light" && appearance !== "dark") {
    throw new Error("--appearance must be light or dark");
  }
  return {
    ...(flag(args, "--seed") ? { seed: flag(args, "--seed") } : {}),
    ...(flag(args, "--dark-seed") ? { darkSeed: flag(args, "--dark-seed") } : {}),
    ...(contrast ? { contrast } : {}),
    ...(appearance ? { appearance } : {}),
  } as CodexExperienceAppearanceOptions;
}

function print(value: unknown, json: boolean): void {
  if (json || typeof value !== "string") console.log(JSON.stringify(value, null, 2));
  else console.log(value);
}

function warnRemoteContent(risk: ExperienceWebviewRiskMetadata): void {
  if (!risk.warning || risk.securityMode === "strict") return;
  console.warn(`[remote-content:${risk.riskLevel}] ${risk.warning}`);
  if (risk.riskLevel === "critical") {
    console.warn("Only continue when you trust this project and every remote page it can load.");
  }
}

async function initFramework(args: string[]): Promise<"react" | "vue"> {
  const explicit = flag(args, "--framework");
  if (explicit) {
    if (explicit !== "react" && explicit !== "vue") throw new Error("--framework must be react or vue");
    return explicit;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) return "react";
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log("Framework:\n  1. React (default)\n  2. Vue");
    const answer = (await prompt.question("Select [1]: ")).trim().toLowerCase();
    if (!answer || answer === "1" || answer === "react") return "react";
    if (answer === "2" || answer === "vue") return "vue";
    throw new Error("Framework selection must be 1/react or 2/vue");
  } finally {
    prompt.close();
  }
}

async function withRuntime<T>(args: string[], work: (runtime: CodexExperienceRuntime) => Promise<T>): Promise<T> {
  const libraryPath = flag(args, "--library");
  const runtime = new CodexExperienceRuntime({ ...(libraryPath ? { libraryPath } : {}) });
  try {
    await runtime.initialize();
    return await work(runtime);
  } finally {
    await runtime.shutdown().catch(() => undefined);
  }
}

async function isolatedInstanceContext(args: string[]) {
  const libraryPath = flag(args, "--library") ?? resolveCodexExperienceLibraryPath();
  const identity = await new MacOSCodexSessionProvider().getIdentity();
  const status = await inspectIsolatedCodexInstance(libraryPath, identity.executablePath);
  return { libraryPath, identity, status };
}

const args = process.argv.slice(2);
const command = args[0];
const target = positional(args) ?? process.cwd();

try {
  if (command === "init") {
    const id = flag(args, "--id");
    const name = flag(args, "--name");
    const selectedFramework = await initFramework(args);
    const directory = await initializeExperienceProject(target, {
      ...(id ? { id } : {}),
      ...(name ? { name } : {}),
      framework: selectedFramework,
    });
    console.log(`Created ${selectedFramework === "react" ? "React" : "Vue"} Experience project at ${directory}`);
  } else if (command === "build") {
    const result = await buildExperienceProject(target);
    warnRemoteContent(experienceWebviewRiskMetadata(result.manifest.webviews));
    console.log(`Built ${result.manifest.id} with ${result.surfaces.length} surfaces into ${result.directory}`);
  } else if (command === "check") {
    const project = await checkExperienceProject(target);
    warnRemoteContent(experienceWebviewRiskMetadata(project.manifest.webviews));
    console.log(`Valid ${project.manifest.id}@${project.manifest.version} (${project.surfaces.length} surfaces)`);
  } else if (command === "pack") {
    const result = await packExperienceProject(target);
    console.log(`Packed ${result.path} (${result.bytes} bytes)`);
  } else if (command === "dev") {
    const port = flag(args, "--port");
    const server = await startExperienceDevServer(target, {
      ...(port ? { port: Number(port) } : {}),
      allowUnrestrictedRemoteContent: args.includes("--allow-unrestricted-remote-content"),
    });
    warnRemoteContent(server.remoteContentRisk);
    console.log(`Experience preview: ${server.url}`);
    let nativePreview: ElectronExperiencePreviewHandle | undefined;
    let shuttingDown = false;
    const shutdown = () => {
      if (shuttingDown) return;
      shuttingDown = true;
      void (async () => {
        await nativePreview?.close().catch(() => undefined);
        await server.close();
      })().finally(() => process.exit(0));
    };
    if (args.includes("--native")) {
      try {
        nativePreview = await launchElectronExperiencePreview({
          projectPath: target,
          url: server.url,
          allowUnrestrictedRemoteContent: args.includes("--allow-unrestricted-remote-content"),
          onExit: () => shutdown(),
        });
        console.log("Native Electron preview opened (WebContentsView remote-content backend available).");
      } catch (error) {
        await server.close();
        throw error;
      }
    } else if (!args.includes("--no-open")) openPreview(server.url);
    process.once("SIGINT", shutdown); process.once("SIGTERM", shutdown);
  } else if (command === "apply") {
    const options: CodexExperienceDirectApplyOptions = {
      ...appearanceOptions(args),
      allowRestart: args.includes("--allow-restart"),
      replaceInstalled: args.includes("--replace"),
      allowUnrestrictedRemoteContent: args.includes("--allow-unrestricted-remote-content"),
    };
    const result = await withRuntime(args, (runtime) => runtime.apply(target, options));
    print(result, args.includes("--json"));
  } else if (command === "appearance") {
    const status = await withRuntime(args, (runtime) => runtime.patchAppearance(appearanceOptions(args)));
    print(status, args.includes("--json"));
  } else if (command === "cancel") {
    const status = await withRuntime(args, (runtime) => runtime.cancel());
    print(status, args.includes("--json"));
  } else if (command === "status") {
    const status = await withRuntime(args, (runtime) => runtime.getStatus());
    print(status, true);
  } else if (command === "install") {
    const source = positional(args);
    if (!source) throw new Error("install requires a built dist directory or ZIP");
    const installed = await withRuntime(args, (runtime) => runtime.install(source, {
      conflict: args.includes("--replace") ? "replace" : "reject",
    }));
    print(installed, args.includes("--json"));
  } else if (command === "list") {
    const catalog = await withRuntime(args, (runtime) => runtime.list());
    print(catalog, true);
  } else if (command === "instance") {
    const operation = args[1] ?? "status";
    const { identity, status } = await isolatedInstanceContext(args);
    if (operation === "status") {
      print(status, true);
    } else if (operation === "install-launcher") {
      if (!status.initialized) throw new Error("No initialized secondary Codex instance was found");
      const launcherPath = await installIsolatedCodexLauncher({
        executablePath: identity.executablePath,
        profilePath: status.profilePath,
        codexHomePath: status.codexHomePath,
        launcherPath: status.launcherPath,
      });
      print({ installed: true, launcherPath }, true);
    } else if (operation === "open") {
      if (!status.initialized) throw new Error("No initialized secondary Codex instance was found");
      const launcherPath = await installIsolatedCodexLauncher({
        executablePath: identity.executablePath,
        profilePath: status.profilePath,
        codexHomePath: status.codexHomePath,
        launcherPath: status.launcherPath,
      });
      const result = await openIsolatedCodexInstance({
        executablePath: identity.executablePath,
        profilePath: status.profilePath,
        codexHomePath: status.codexHomePath,
      });
      print({ opened: true, reused: result.reused, pid: result.pid, launcherPath }, true);
    } else {
      throw new Error("instance operation must be status, open, or install-launcher");
    }
  } else if (!command || command === "help" || command === "--help" || command === "-h") {
    help();
  } else {
    help();
    process.exitCode = 1;
  }
} catch (error) {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : null;
  console.error(`${code ? `[${code}] ` : ""}${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
