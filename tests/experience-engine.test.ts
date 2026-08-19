import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { generateAppearanceTokens } from "../src/core/appearance-tokens.js";
import type {
  AcquireCodexSessionOptions,
  CodexSessionProvider,
  CodexSessionReconciliation,
  CodexSessionRecord,
} from "../src/node/codex-app-session.js";
import { ExperienceEngine } from "../src/node/experience-engine.js";
import { ExperienceProjectCdpTarget } from "../src/node/experience-project-cdp-target.js";
import { SimulatedCdpServer } from "./helpers/simulated-cdp.js";
import { writeProject } from "./helpers/experience-project-fixture.js";

class Provider implements CodexSessionProvider {
  connected = false;
  acquireCount = 0;
  reconciliation: CodexSessionReconciliation | null = null;
  readonly record: CodexSessionRecord = { origin: "http://127.0.0.1:9222", port: 9222, pid: 4242, processStartedAt: "today", appPath: "/Applications/Codex.app", executablePath: "/Applications/Codex.app/Contents/MacOS/Codex" };
  constructor(private readonly url: string) {}
  async isAvailable() { return true; }
  async plan() { return { codexAppAvailable: true, reusableSession: this.connected, codexRunning: true, requiresRestart: !this.connected }; }
  async reconnect(previous: CodexSessionRecord) { return this.connected && previous.pid === this.record.pid ? { record: this.record, webSocketUrl: this.url, reused: true } : null; }
  async reconcile(previous: CodexSessionRecord) {
    if (this.reconciliation) return this.reconciliation;
    const connection = await this.reconnect(previous);
    return { generation: connection ? "same" as const : "unknown" as const, connection };
  }
  async acquire(options: AcquireCodexSessionOptions) {
    if (this.connected) return { record: this.record, webSocketUrl: this.url, reused: true };
    if (!options.allowRestart) throw Object.assign(new Error("restart required"), { code: "codex/restart-required" });
    this.connected = true;
    this.acquireCount += 1;
    return { record: this.record, webSocketUrl: this.url, reused: false };
  }
  async restartWithoutDebugging() { this.connected = false; }
}

class RejectingTarget extends ExperienceProjectCdpTarget {
  constructor() { super("ws://127.0.0.1:9/devtools/page/rejecting"); }
  override async apply(): Promise<never> { throw new Error("synthetic injection failure"); }
}

describe("ExperienceEngine simulation", () => {
  const clean: Array<() => Promise<void>> = [];
  afterEach(async () => { while (clean.length) await clean.pop()?.(); });
  it("imports, applies after explicit restart consent, hot-switches tokens, and cancels", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ctk-engine-")); clean.push(() => fs.rm(root, { recursive: true, force: true }));
    const server = new SimulatedCdpServer(); const url = await server.start(); clean.push(() => server.close());
    const provider = new Provider(url);
    const engine = new ExperienceEngine({ libraryPath: path.join(root, "library"), statePath: path.join(root, "state.json"), sessionProvider: provider }); clean.push(() => engine.shutdown());
    await engine.initialize();
    const source = path.join(root, "source"); await writeProject(source, { id: "engine.portal" });
    await engine.importProject({ kind: "directory", path: source });
    expect(await engine.planApply("engine.portal")).toMatchObject({ requiresRestart: true, hotSwitch: false });
    const tokens = generateAppearanceTokens({ seed: "#6750A4" }).modes;
    await expect(engine.applyProject("engine.portal", { tokens })).rejects.toMatchObject({ code: "runtime/apply" });
    await expect(engine.applyProject("engine.portal", { tokens, allowRestart: true })).resolves.toMatchObject({ phase: "active", projectId: "engine.portal" });
    expect(provider.acquireCount).toBe(1);
    await expect(engine.patchTokens(generateAppearanceTokens({ seed: "#008577" }).modes, "dark")).resolves.toMatchObject({ phase: "active" });
    await expect(engine.cancelProject()).resolves.toMatchObject({ phase: "idle", projectId: null });
    expect(server.scripts.size).toBe(0);
  });

  it("refreshes an active linked directory without another Codex restart and keeps the last valid snapshot", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ctk-engine-development-")); clean.push(() => fs.rm(root, { recursive: true, force: true }));
    const server = new SimulatedCdpServer(); const url = await server.start(); clean.push(() => server.close());
    const provider = new Provider(url);
    const engine = new ExperienceEngine({ libraryPath: path.join(root, "library"), statePath: path.join(root, "state.json"), sessionProvider: provider }); clean.push(() => engine.shutdown());
    await engine.initialize();
    const source = path.join(root, "editable"); await writeProject(source, { id: "engine.development" });
    const linked = await engine.linkDevelopmentProject(source);
    expect(await engine.planApplyDevelopment(linked.id)).toMatchObject({ projectKind: "development", requiresRestart: true });
    const tokens = generateAppearanceTokens({ seed: "#6750A4" }).modes;
    await expect(engine.applyDevelopmentProject(linked.id, { tokens, allowRestart: true })).resolves.toMatchObject({
      phase: "active", projectId: linked.id, projectKind: "development",
    });
    expect(provider.acquireCount).toBe(1);
    const original = await engine.development.loadProject(linked.id);

    await fs.writeFile(path.join(source, "index.html"), '<!doctype html><html><body><codex-experience-surface target="app-shell" plane="overlay"><div>Updated development experience</div></codex-experience-surface></body></html>');
    const refreshed = await engine.refreshDevelopmentProject(linked.id);
    expect(refreshed.reapplied).toBe(true);
    expect(refreshed.project.digest).not.toBe(original.digest);
    expect(provider.acquireCount).toBe(1);
    await expect(engine.getStatus()).toMatchObject({ phase: "active", projectId: linked.id, projectKind: "development" });
    await expect(engine["target"]?.probe()).resolves.toMatchObject({ projectId: "engine.development", digest: refreshed.project.digest });

    await fs.writeFile(path.join(source, "index.html"), '<!doctype html><img src="https://example.invalid/nope.png"><codex-experience-surface target="app-shell" plane="overlay"></codex-experience-surface>');
    await expect(engine.refreshDevelopmentProject(linked.id)).rejects.toThrow("External URL is not allowed");
    await expect(engine.development.loadProject(linked.id)).resolves.toMatchObject({ digest: refreshed.project.digest });
    await expect(engine.cancelProject()).resolves.toMatchObject({ phase: "idle", projectId: null, projectKind: null });
  });

  it("requires the host to grant an unrestricted project before connecting to Codex", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ctk-engine-unrestricted-")); clean.push(() => fs.rm(root, { recursive: true, force: true }));
    const server = new SimulatedCdpServer(); const url = await server.start(); clean.push(() => server.close());
    const provider = new Provider(url);
    const engine = new ExperienceEngine({ libraryPath: path.join(root, "library"), statePath: path.join(root, "state.json"), sessionProvider: provider }); clean.push(() => engine.shutdown());
    await engine.initialize();
    const source = path.join(root, "source"); await writeProject(source, { id: "engine.unrestricted" });
    await fs.writeFile(path.join(source, "experience.manifest.json"), JSON.stringify({
      apiVersion: 1,
      id: "engine.unrestricted",
      name: "Unrestricted",
      version: "1.0.0",
      entry: "index.html",
      permissions: ["appearance.tokens", "remote.webview"],
      webviews: { securityMode: "unrestricted" },
    }));
    await engine.importProject({ kind: "directory", path: source });
    const tokens = generateAppearanceTokens({ seed: "#6750A4" }).modes;
    await expect(engine.applyProject("engine.unrestricted", { tokens, allowRestart: true })).rejects.toMatchObject({
      code: "runtime/unrestricted-remote-content",
    });
    expect(provider.acquireCount).toBe(0);
    await expect(engine.applyProject("engine.unrestricted", {
      tokens,
      allowRestart: true,
      allowUnrestrictedRemoteContent: true,
    })).resolves.toMatchObject({ phase: "active", projectId: "engine.unrestricted" });
    expect(provider.acquireCount).toBe(1);
    await engine.cancelProject();
  });

  it("persists a reusable CDP session before injection so a failed first apply never requires another restart", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ctk-engine-retry-")); clean.push(() => fs.rm(root, { recursive: true, force: true }));
    const statePath = path.join(root, "state.json");
    const provider = new Provider("ws://127.0.0.1:9/devtools/page/rejecting");
    const source = path.join(root, "source"); await writeProject(source, { id: "engine.retry" });
    const tokens = generateAppearanceTokens({ seed: "#6750A4" }).modes;

    const first = new ExperienceEngine({
      libraryPath: path.join(root, "library"),
      statePath,
      sessionProvider: provider,
      targetFactory: () => new RejectingTarget(),
    });
    await first.initialize();
    await first.importProject({ kind: "directory", path: source });
    await expect(first.applyProject("engine.retry", { tokens, allowRestart: true })).rejects.toThrow("synthetic injection failure");
    await first.shutdown();
    await expect(fs.readFile(statePath, "utf8").then(JSON.parse)).resolves.toMatchObject({
      version: 2,
      session: { pid: provider.record.pid, port: provider.record.port },
      active: null,
    });

    const retry = new ExperienceEngine({
      libraryPath: path.join(root, "library"),
      statePath,
      sessionProvider: provider,
      targetFactory: () => new RejectingTarget(),
    });
    clean.push(() => retry.shutdown());
    await retry.initialize();
    await expect(retry.planApply("engine.retry")).resolves.toMatchObject({
      reusableSession: true,
      requiresRestart: false,
      hotSwitch: true,
    });
  });

  it("rediscovers a reconstructed page target after an apply crash without restarting Codex again", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ctk-engine-target-recovery-")); clean.push(() => fs.rm(root, { recursive: true, force: true }));
    const server = new SimulatedCdpServer(); const url = await server.start(); clean.push(() => server.close());
    const provider = new Provider(url);
    let targetCount = 0;
    const engine = new ExperienceEngine({
      libraryPath: path.join(root, "library"),
      statePath: path.join(root, "state.json"),
      sessionProvider: provider,
      targetFactory: (webSocketUrl) => ++targetCount === 1 ? new RejectingTarget() : new ExperienceProjectCdpTarget(webSocketUrl),
    });
    clean.push(() => engine.shutdown());
    await engine.initialize();
    const source = path.join(root, "source"); await writeProject(source, { id: "engine.target-recovery" });
    await engine.importProject({ kind: "directory", path: source });
    const tokens = generateAppearanceTokens({ seed: "#6750A4" }).modes;

    await expect(engine.applyProject("engine.target-recovery", { tokens, allowRestart: true })).rejects.toThrow("synthetic injection failure");
    await expect(engine.planApply("engine.target-recovery")).resolves.toMatchObject({ requiresRestart: false, reusableSession: true });
    await expect(engine.applyProject("engine.target-recovery", { tokens })).resolves.toMatchObject({
      phase: "active",
      projectId: "engine.target-recovery",
    });
    expect(provider.acquireCount).toBe(1);
    await engine.cancelProject();
  });

  it("reconnects an active injection after only the service restarts", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ctk-engine-service-restart-")); clean.push(() => fs.rm(root, { recursive: true, force: true }));
    const server = new SimulatedCdpServer(); const url = await server.start(); clean.push(() => server.close());
    const provider = new Provider(url);
    const libraryPath = path.join(root, "library");
    const statePath = path.join(root, "state.json");
    const source = path.join(root, "source"); await writeProject(source, { id: "engine.service-restart" });
    const tokens = generateAppearanceTokens({ seed: "#6750A4" }).modes;

    const first = new ExperienceEngine({ libraryPath, statePath, sessionProvider: provider });
    await first.initialize();
    await first.importProject({ kind: "directory", path: source });
    await first.applyProject("engine.service-restart", { tokens, allowRestart: true });
    await first.shutdown();

    const restartedService = new ExperienceEngine({ libraryPath, statePath, sessionProvider: provider });
    clean.push(() => restartedService.shutdown());
    await expect(restartedService.initialize()).resolves.toMatchObject({
      phase: "active",
      projectId: "engine.service-restart",
      sessionState: "ready",
      codexProcessGeneration: "same",
      recoveryRequired: false,
    });
    expect(provider.acquireCount).toBe(1);
    await restartedService.cancelProject();
  });

  it("invalidates the old receipt and adopts a new CDP generation after Codex and the service restart", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ctk-engine-both-restart-")); clean.push(() => fs.rm(root, { recursive: true, force: true }));
    const server = new SimulatedCdpServer(); const url = await server.start(); clean.push(() => server.close());
    const provider = new Provider(url);
    const libraryPath = path.join(root, "library");
    const statePath = path.join(root, "state.json");
    const source = path.join(root, "source"); await writeProject(source, { id: "engine.both-restart" });
    const tokens = generateAppearanceTokens({ seed: "#6750A4" }).modes;

    const first = new ExperienceEngine({ libraryPath, statePath, sessionProvider: provider });
    await first.initialize();
    await first.importProject({ kind: "directory", path: source });
    await first.applyProject("engine.both-restart", { tokens, allowRestart: true });
    const persistedActiveState = await fs.readFile(statePath, "utf8");
    // Tear down the synthetic renderer cleanly, then restore only the durable
    // record to model a real process restart (the old renderer is gone).
    await first.cancelProject();
    await first.shutdown();
    await fs.writeFile(statePath, persistedActiveState);

    const replacementRecord = { ...provider.record, pid: 5252, processStartedAt: "tomorrow" };
    provider.reconciliation = {
      generation: "replaced",
      connection: { record: replacementRecord, webSocketUrl: url, reused: true },
    };
    const restartedService = new ExperienceEngine({ libraryPath, statePath, sessionProvider: provider });
    clean.push(() => restartedService.shutdown());
    await expect(restartedService.initialize()).resolves.toMatchObject({
      phase: "idle",
      projectId: null,
      sessionState: "ready",
      codexProcessGeneration: "replaced",
      recoveryRequired: false,
    });
    await expect(fs.readFile(statePath, "utf8").then(JSON.parse)).resolves.toMatchObject({
      session: { pid: replacementRecord.pid, processStartedAt: replacementRecord.processStartedAt },
      active: null,
    });
    await expect(restartedService.planApply("engine.both-restart")).resolves.toMatchObject({
      reusableSession: true,
      requiresRestart: false,
      hotSwitch: true,
    });
  });
});
