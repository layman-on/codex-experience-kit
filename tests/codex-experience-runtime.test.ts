import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  AcquireCodexSessionOptions,
  CodexSessionProvider,
  CodexSessionRecord,
} from "../src/node/codex-app-session.js";
import {
  CodexExperienceRuntime,
  resolveCodexExperienceLibraryPath,
} from "../src/node/codex-experience-runtime.js";
import { initializeExperienceProject } from "../src/node/experience-project-tools.js";
import { SimulatedCdpServer } from "./helpers/simulated-cdp.js";
import { writeProject } from "./helpers/experience-project-fixture.js";

class Provider implements CodexSessionProvider {
  connected = false;
  acquireCount = 0;
  readonly record: CodexSessionRecord = {
    origin: "http://127.0.0.1:9222",
    port: 9222,
    pid: 4242,
    processStartedAt: "today",
    appPath: "/Applications/Codex.app",
    executablePath: "/Applications/Codex.app/Contents/MacOS/Codex",
  };

  constructor(private readonly url: string) {}
  async isAvailable() { return true; }
  async plan() { return { codexAppAvailable: true, reusableSession: this.connected, codexRunning: true, requiresRestart: !this.connected }; }
  async reconnect(previous: CodexSessionRecord) { return this.connected && previous.pid === this.record.pid ? { record: this.record, webSocketUrl: this.url, reused: true } : null; }
  async acquire(options: AcquireCodexSessionOptions) {
    if (!options.allowRestart) throw new Error("restart required");
    this.connected = true;
    this.acquireCount += 1;
    return { record: this.record, webSocketUrl: this.url, reused: false };
  }
  async restartWithoutDebugging() { this.connected = false; }
}

describe("CodexExperienceRuntime direct package control", () => {
  const clean: Array<() => Promise<void>> = [];
  afterEach(async () => { while (clean.length) await clean.pop()?.(); });

  it("uses the package-owned macOS library location by default", () => {
    expect(resolveCodexExperienceLibraryPath("/Users/example")).toBe(
      "/Users/example/Library/Application Support/CodexExperienceKit",
    );
  });

  it("builds, applies, hot-refreshes, patches appearance, and cancels without an external host", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cek-direct-"));
    clean.push(() => fs.rm(root, { recursive: true, force: true }));
    const server = new SimulatedCdpServer();
    const url = await server.start();
    clean.push(() => server.close());
    const provider = new Provider(url);
    const runtime = new CodexExperienceRuntime({
      libraryPath: path.join(root, "library"),
      sessionProvider: provider,
    });
    clean.push(() => runtime.shutdown());
    const project = path.join(root, "project");
    await initializeExperienceProject(project, { id: "private.direct", name: "Direct Experience" });
    await fs.symlink(path.join(process.cwd(), "node_modules"), path.join(project, "node_modules"), "junction");

    await expect(runtime.apply(project)).rejects.toMatchObject({ code: "direct/restart-confirmation-required" });
    const applied = await runtime.apply(project, { allowRestart: true });
    expect(applied).toMatchObject({ projectKind: "development", projectName: "Direct Experience", status: { phase: "active" } });
    expect(provider.acquireCount).toBe(1);

    const reinstalled = await runtime.apply(project);
    expect(reinstalled).toMatchObject({ hotUpdated: true, status: { phase: "active", projectKind: "development" } });
    expect(provider.acquireCount).toBe(1);

    await fs.writeFile(
      path.join(project, "src/surfaces/overlay/index.tsx"),
      'import "./styles.css";\nexport default function Overlay() { return <div data-updated="true">Updated</div>; }\n',
    );
    const refreshed = await runtime.apply(project, { seed: "#008577", appearance: "dark" });
    expect(refreshed).toMatchObject({ hotUpdated: true, status: { phase: "active", projectKind: "development" } });
    expect(provider.acquireCount).toBe(1);
    await expect(runtime.patchAppearance({ appearance: "light" })).resolves.toMatchObject({ phase: "active" });
    await expect(runtime.cancel()).resolves.toMatchObject({ phase: "idle", projectId: null });
    expect(server.scripts.size).toBe(0);

    const builtPackage = path.join(root, "built-package");
    await writeProject(builtPackage, { id: "private.installed", name: "Installed Experience" });
    await expect(runtime.install(builtPackage)).resolves.toMatchObject({ id: "private.installed" });
    await expect(runtime.list()).resolves.toMatchObject({ installed: [{ id: "private.installed" }] });
    await expect(runtime.apply("private.installed")).resolves.toMatchObject({ projectKind: "installed", status: { phase: "active" } });
    await expect(runtime.install(builtPackage, { conflict: "replace" })).rejects.toMatchObject({ code: "direct/active-replace" });
    await runtime.cancel();
  });

  it("turns an unreachable persisted development receipt into normal restart consent on explicit Apply", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cek-direct-stale-recovery-"));
    clean.push(() => fs.rm(root, { recursive: true, force: true }));
    const server = new SimulatedCdpServer();
    const url = await server.start();
    clean.push(() => server.close());
    const provider = new Provider(url);
    const libraryPath = path.join(root, "library");
    const project = path.join(root, "project");
    await initializeExperienceProject(project, { id: "private.stale-recovery", name: "Stale Recovery" });
    await fs.symlink(path.join(process.cwd(), "node_modules"), path.join(project, "node_modules"), "junction");

    const first = new CodexExperienceRuntime({ libraryPath, sessionProvider: provider });
    await expect(first.apply(project, { allowRestart: true })).resolves.toMatchObject({ status: { phase: "active" } });
    await first.shutdown();
    provider.connected = false;

    const recovered = new CodexExperienceRuntime({ libraryPath, sessionProvider: provider });
    clean.push(() => recovered.shutdown());
    await expect(recovered.getStatus()).resolves.toMatchObject({ phase: "error", recoveryRequired: true });
    await expect(recovered.apply(project)).rejects.toMatchObject({ code: "direct/restart-confirmation-required" });
    await expect(recovered.getStatus()).resolves.toMatchObject({ phase: "idle", recoveryRequired: false });
    await expect(recovered.apply(project, { allowRestart: true })).resolves.toMatchObject({ status: { phase: "active", recoveryRequired: false } });
    await recovered.cancel();
  });
});
