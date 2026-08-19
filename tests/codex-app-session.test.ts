import { describe, expect, it } from "vitest";
import {
  codexMainPageTargetRank,
  createCodexDebugArguments,
  createCodexLaunchEnvironment,
  createCodexOpenArguments,
  isCodexMainPageTarget,
  parseCodexLoopbackDebugPort,
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
});
