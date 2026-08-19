import { describe, expect, it } from "vitest";
import {
  codexMainPageTargetRank,
  codexInstanceId,
  createCodexDebugArguments,
  createCodexLaunchEnvironment,
  createCodexNewInstanceOpenArguments,
  createCodexOpenArguments,
  isCodexMainPageTarget,
  parseCodexLoopbackDebugPort,
  parseCodexUserDataDirectory,
  selectCodexSessionInstance,
} from "../src/node/codex-app-session.js";

describe("Codex macOS launch boundary", () => {
  it("binds CDP to loopback and validates the port", () => {
    expect(createCodexDebugArguments(9341)).toEqual([
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=9341",
    ]);
    expect(() => createCodexDebugArguments(0)).toThrow(/port is invalid/u);
  });

  it("launches the verified app without forcing a duplicate instance", () => {
    expect(createCodexOpenArguments("/Applications/ChatGPT.app", ["--flag=value"])).toEqual([
      "-a",
      "/Applications/ChatGPT.app",
      "--args",
      "--flag=value",
    ]);
    expect(createCodexOpenArguments("/Applications/ChatGPT.app")).toEqual([
      "-a",
      "/Applications/ChatGPT.app",
    ]);
  });

  it("can explicitly launch another verified app instance", () => {
    expect(createCodexNewInstanceOpenArguments("/Applications/Codex.app", ["--flag=value"])).toEqual([
      "-n",
      "-a",
      "/Applications/Codex.app",
      "--args",
      "--flag=value",
    ]);
  });

  it("does not leak Node or Electron controls from the caller", () => {
    const environment = createCodexLaunchEnvironment({
      HOME: "/Users/example",
      PATH: "/usr/bin:/bin",
      NODE_ENV: "production",
      NODE_OPTIONS: "--require ./hook.cjs",
      NODE_PATH: "/tmp/node-modules",
      ELECTRON_RUN_AS_NODE: "1",
      ELECTRON_ENABLE_LOGGING: "1",
      ELECTRON_NO_ATTACH_CONSOLE: "1",
    });
    expect(environment).toEqual({
      HOME: "/Users/example",
      PATH: "/usr/bin:/bin",
    });
  });

  it("selects the primary Codex page instead of the avatar overlay", () => {
    const overlay = {
      id: "overlay",
      type: "page" as const,
      title: "Codex",
      url: "app://-/index.html?initialRoute=%2Favatar-overlay",
      webSocketDebuggerUrl: "ws://127.0.0.1:9341/devtools/page/overlay",
    };
    const main = {
      ...overlay,
      id: "main",
      url: "app://-/index.html",
      webSocketDebuggerUrl: "ws://127.0.0.1:9341/devtools/page/main",
    };
    expect(isCodexMainPageTarget(overlay)).toBe(false);
    expect(isCodexMainPageTarget(main)).toBe(true);
    expect(codexMainPageTargetRank(main)).toBeGreaterThan(codexMainPageTargetRank(overlay));
  });

  it("adopts only an explicitly loopback-bound debugging process", () => {
    expect(parseCodexLoopbackDebugPort(
      "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT --remote-debugging-address=127.0.0.1 --remote-debugging-port=53135",
    )).toBe(53135);
    expect(parseCodexLoopbackDebugPort(
      "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT --remote-debugging-port=53135",
    )).toBeNull();
    expect(parseCodexLoopbackDebugPort(
      "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT --remote-debugging-address=0.0.0.0 --remote-debugging-port=53135",
    )).toBeNull();
  });

  it("derives stable instance ids from primary and profile launches", () => {
    const profile = "/Users/example/Library/Application Support/CodexExperienceKit/isolated-instances/secondary/user-data";
    expect(parseCodexUserDataDirectory(
      `/Applications/Codex.app/Contents/MacOS/Codex --user-data-dir=${profile} --remote-debugging-address=127.0.0.1 --remote-debugging-port=53135`,
    )).toBe(profile);
    expect(codexInstanceId(null)).toBe("primary");
    expect(codexInstanceId(profile)).toMatch(/^profile-[0-9a-f]{12}$/u);
    expect(codexInstanceId(profile)).toBe(codexInstanceId(profile));
  });

  it("requires an explicit selection when multiple Codex instances exist", () => {
    const instances = [
      { id: "primary", label: "Primary Codex", role: "primary" as const, pid: 10, processStartedAt: "one", profilePath: null, debugPort: 9001, state: "connectable" as const, connected: false, restartable: true },
      { id: "profile-abc", label: "Secondary Codex", role: "secondary" as const, pid: 20, processStartedAt: "two", profilePath: "/secondary", debugPort: 9002, state: "connected" as const, connected: true, restartable: true },
    ];
    expect(selectCodexSessionInstance(instances, null)).toBeNull();
    expect(selectCodexSessionInstance(instances, null, "primary")?.pid).toBe(10);
    expect(selectCodexSessionInstance(instances, {
      origin: "http://127.0.0.1:9002", port: 9002, pid: 20, processStartedAt: "two",
      appPath: "/Applications/Codex.app", executablePath: "/Applications/Codex.app/Contents/MacOS/Codex",
      instanceId: "profile-abc",
    })?.id).toBe("profile-abc");
  });
});
