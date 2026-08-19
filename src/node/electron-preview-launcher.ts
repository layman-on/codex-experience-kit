import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ExperienceKitError } from "../core/errors.js";

export interface ElectronExperiencePreviewOptions {
  projectPath: string;
  url: string;
  allowUnrestrictedRemoteContent?: boolean;
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
}

export interface ElectronExperiencePreviewHandle {
  readonly process: ChildProcess;
  close(): Promise<void>;
}

function electronExecutable(projectPath: string): string {
  const fromProject = createRequire(path.join(path.resolve(projectPath), "package.json"));
  try {
    const executable = fromProject("electron") as unknown;
    if (typeof executable === "string" && executable.length > 0) return executable;
  } catch (error) {
    throw new ExperienceKitError(
      "tool/native-preview-electron",
      "Native preview requires project-local Electron. Install it with: npm install --save-dev electron",
      { cause: error },
    );
  }
  throw new ExperienceKitError("tool/native-preview-electron", "The project-local Electron package did not expose an executable");
}

export async function launchElectronExperiencePreview(options: ElectronExperiencePreviewOptions): Promise<ElectronExperiencePreviewHandle> {
  const projectPath = path.resolve(options.projectPath);
  const executable = electronExecutable(projectPath);
  const entry = fileURLToPath(new URL("./electron-preview-main.js", import.meta.url));
  const args = [entry, "--project", projectPath, "--url", options.url];
  if (options.allowUnrestrictedRemoteContent) args.push("--allow-unrestricted-remote-content");
  const child = spawn(executable, args, { stdio: "inherit" });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  child.once("exit", (code, signal) => options.onExit?.(code, signal));
  return {
    process: child,
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      await new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
        child.kill("SIGTERM");
      });
    },
  };
}
