import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CODEX_HOME_ENVIRONMENT,
  CODEX_USER_DATA_ENVIRONMENT,
  createIsolatedCodexArguments,
  createIsolatedCodexEnvironment,
  installIsolatedCodexLauncher,
  resolveIsolatedCodexHomePath,
  resolveIsolatedCodexLauncherPath,
  resolveIsolatedCodexProfilePath,
} from "../src/node/isolated-codex-instance.js";

describe("isolated Codex instance", () => {
  const cleanup: string[] = [];
  afterEach(async () => { await Promise.all(cleanup.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))); });

  it("derives a fixed secondary profile below the package library", () => {
    expect(resolveIsolatedCodexProfilePath("/tmp/experience-library")).toBe(
      path.join("/tmp/experience-library", "isolated-instances", "secondary", "user-data"),
    );
    expect(resolveIsolatedCodexHomePath("/tmp/experience-library")).toBe(
      path.join("/tmp/experience-library", "isolated-instances", "secondary", "codex-home"),
    );
  });

  it("sets only the supported Codex profile override and drops inherited Electron controls", () => {
    const environment = createIsolatedCodexEnvironment("/tmp/experience-secondary/user-data", "/tmp/experience-secondary/codex-home", {
      PATH: "/usr/bin:/bin",
      NODE_OPTIONS: "--require attack.js",
      ELECTRON_RUN_AS_NODE: "1",
      CODEX_ELECTRON_AGENT_RUN_ID: "parent-agent",
      CODEX_ELECTRON_CHROMIUM_SWITCHES: "{\"remote-debugging-port\":\"9222\"}",
      CODEX_HOME: "/Users/example/.codex",
    });
    expect(environment).toMatchObject({
      PATH: "/usr/bin:/bin",
      [CODEX_USER_DATA_ENVIRONMENT]: "/tmp/experience-secondary/user-data",
      [CODEX_HOME_ENVIRONMENT]: "/tmp/experience-secondary/codex-home",
    });
    expect(environment).not.toHaveProperty("NODE_OPTIONS");
    expect(environment).not.toHaveProperty("ELECTRON_RUN_AS_NODE");
    expect(environment).not.toHaveProperty("CODEX_ELECTRON_AGENT_RUN_ID");
    expect(environment).not.toHaveProperty("CODEX_ELECTRON_CHROMIUM_SWITCHES");
  });

  it("isolates Chromium before Electron's single-instance handoff can reuse the primary account", () => {
    expect(createIsolatedCodexArguments("/tmp/experience secondary")).toEqual([
      "--user-data-dir=/tmp/experience secondary",
    ]);
  });

  it("installs a persistent macOS launcher for reopening the existing account after reboot", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cek-secondary-launcher-"));
    cleanup.push(directory);
    const executablePath = path.join(directory, "Official Codex.app", "Contents", "MacOS", "Codex");
    const iconPath = path.join(directory, "Official Codex.app", "Contents", "Resources", "electron.icns");
    const profilePath = path.join(directory, "library", "isolated-instances", "secondary", "user-data");
    const codexHomePath = path.join(directory, "library", "isolated-instances", "secondary", "codex-home");
    const launcherPath = resolveIsolatedCodexLauncherPath(path.join(directory, "home"));
    await Promise.all([
      fs.mkdir(path.dirname(executablePath), { recursive: true }),
      fs.mkdir(path.dirname(iconPath), { recursive: true }),
      fs.mkdir(profilePath, { recursive: true }),
      fs.mkdir(codexHomePath, { recursive: true }),
    ]);
    await Promise.all([fs.writeFile(executablePath, "binary", { mode: 0o700 }), fs.writeFile(iconPath, "icon")]);
    await expect(installIsolatedCodexLauncher({ executablePath, profilePath, codexHomePath, launcherPath })).resolves.toBe(launcherPath);
    const launcherExecutable = path.join(launcherPath, "Contents", "MacOS", "CodexSecondary");
    const [script, plist] = await Promise.all([
      fs.readFile(launcherExecutable, "utf8"),
      fs.readFile(path.join(launcherPath, "Contents", "Info.plist"), "utf8"),
    ]);
    expect(script).toMatch(/^#!\/bin\/zsh\n/);
    expect(script).toContain(`CODEX_HOME='${codexHomePath}'`);
    expect(script).toContain(`--user-data-dir=${profilePath}`);
    expect(plist).toContain("dev.codex-experience-kit.secondary");
    expect(plist).toContain("CodexSecondary.icns");
    if (process.platform === "darwin") {
      expect(() => execFileSync("/bin/zsh", ["-n", launcherExecutable])).not.toThrow();
    }
  });
});
