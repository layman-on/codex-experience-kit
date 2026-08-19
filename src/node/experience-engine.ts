import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { errorMessage, ExperienceKitError } from "../core/errors.js";
import type {
  ImportExperienceProjectOptions,
  InstalledExperienceProject,
  ExperienceDevelopmentProject,
  ExperienceProjectApplyReceipt,
  ExperienceProjectBundle,
  ExperienceProjectImportSource,
  ExperienceProjectSourceKind,
} from "../core/experience-project.js";
import type { AppearanceTokenModes } from "../core/appearance-tokens.js";
import type { CodexContextSource } from "../core/codex-context.js";
import {
  MacOSCodexSessionProvider,
  type CodexSessionConnection,
  type CodexSessionGeneration,
  type CodexSessionInstance,
  type CodexSessionPlan,
  type CodexSessionProvider,
  type CodexSessionRecord,
} from "./codex-app-session.js";
import { ExperienceProjectCdpTarget } from "./experience-project-cdp-target.js";
import { ExperienceDevelopmentRegistry } from "./experience-development-registry.js";
import { ExperienceProjectLibrary } from "./experience-project-library.js";

export type ExperienceRuntimePhase = "idle" | "applying" | "active" | "cancelling" | "error";

export interface ExperienceRuntimeStatus {
  phase: ExperienceRuntimePhase;
  projectId: string | null;
  projectKind: ExperienceProjectSourceKind | null;
  operation: number;
  error: string | null;
  recoveryRequired: boolean;
  codexAppAvailable: boolean;
  sessionState: "disconnected" | "ready";
  codexInstanceId: string | null;
  codexProcessGeneration: CodexSessionGeneration;
}

export interface ExperienceEngineOptions {
  libraryPath: string;
  statePath?: string;
  targetDiscoveryTimeoutMs?: number;
  sessionProvider?: CodexSessionProvider;
  targetFactory?: (webSocketUrl: string, connection?: CodexSessionConnection) => ExperienceProjectCdpTarget;
  contextSource?: CodexContextSource;
}

export interface ApplyExperienceProjectOptions {
  tokens: AppearanceTokenModes;
  appearance?: "light" | "dark";
  targetId?: string;
  allowRestart?: boolean;
  allowUnrestrictedRemoteContent?: boolean;
}

export interface PatchExperienceAppearanceOptions {
  tokens?: AppearanceTokenModes;
  appearance?: "light" | "dark";
}

export interface ExperienceProjectApplyPlan extends CodexSessionPlan {
  projectId: string;
  projectKind: ExperienceProjectSourceKind;
  hotSwitch: boolean;
}

export interface ExperienceDevelopmentRefreshResult {
  project: ExperienceDevelopmentProject;
  reapplied: boolean;
  status: ExperienceRuntimeStatus;
}

interface EngineState {
  version: 2;
  session: CodexSessionRecord | null;
  active: {
    projectId: string;
    projectKind: ExperienceProjectSourceKind;
    runtimeProjectId: string;
    digest: string;
    receipt: ExperienceProjectApplyReceipt;
    tokens: AppearanceTokenModes;
    appearance: "light" | "dark";
    allowUnrestrictedRemoteContent?: boolean;
  } | null;
  updatedAt: string;
}

interface LegacyEngineState {
  version: 1;
  session: CodexSessionRecord | null;
  active: {
    projectId: string;
    digest: string;
    receipt: ExperienceProjectApplyReceipt;
    tokens: AppearanceTokenModes;
    appearance: "light" | "dark";
  } | null;
  updatedAt: string;
}

export class ExperienceEngine {
  readonly library: ExperienceProjectLibrary;
  readonly development: ExperienceDevelopmentRegistry;
  private readonly provider: CodexSessionProvider;
  private readonly statePath: string;
  private readonly lockPath: string;
  private readonly timeout: number;
  private readonly targetFactory: (webSocketUrl: string, connection?: CodexSessionConnection) => ExperienceProjectCdpTarget;
  private readonly instanceId = randomUUID();
  private readonly listeners = new Set<(status: ExperienceRuntimeStatus) => void>();
  private target: ExperienceProjectCdpTarget | null = null;
  private session: CodexSessionRecord | null = null;
  private active: EngineState["active"] = null;
  private receipt: ExperienceProjectApplyReceipt | null = null;
  private abort: AbortController | null = null;
  private initialized = false;
  private closed = false;
  private lockHeld = false;
  private busy = false;
  private currentOperation: Promise<unknown> | null = null;
  private status: ExperienceRuntimeStatus = {
    phase: "idle", projectId: null, projectKind: null, operation: 0, error: null,
    recoveryRequired: false, codexAppAvailable: false, sessionState: "disconnected",
    codexInstanceId: null,
    codexProcessGeneration: "unknown",
  };

  constructor(options: ExperienceEngineOptions) {
    if (!options.libraryPath) throw new ExperienceKitError("runtime/config", "Experience Engine libraryPath is required");
    const nativeActionsEnabled = options.sessionProvider === undefined;
    this.library = new ExperienceProjectLibrary(options.libraryPath);
    this.development = new ExperienceDevelopmentRegistry(options.libraryPath);
    this.provider = options.sessionProvider ?? new MacOSCodexSessionProvider({ libraryPath: options.libraryPath });
    this.statePath = options.statePath ?? path.join(options.libraryPath, "experience-engine-state.json");
    this.lockPath = path.join(options.libraryPath, ".experience-engine.lock");
    this.timeout = options.targetDiscoveryTimeoutMs ?? 20_000;
    this.targetFactory = options.targetFactory ?? ((url, connection) => new ExperienceProjectCdpTarget(url, {
      id: "codex-app",
      ...(options.contextSource ? { contextSource: options.contextSource } : {}),
      ...(connection && nativeActionsEnabled ? {
        nativeActions: {
          libraryPath: options.libraryPath,
          codexExecutablePath: connection.record.executablePath,
        },
      } : {}),
    }));
  }

  async initialize(): Promise<ExperienceRuntimeStatus> {
    if (this.initialized) return this.getStatus();
    await this.acquireLock();
    try {
      await Promise.all([this.library.initialize(), this.development.initialize()]);
      const [stored, available] = await Promise.all([this.readState(), this.provider.isAvailable()]);
      this.session = stored?.session ?? null;
      this.active = stored?.active ?? null;
      this.receipt = this.active?.receipt ?? null;
      this.update({ codexAppAvailable: available });
      await this.reconcileSession();
      this.initialized = true;
      await this.persist();
      return this.getStatus();
    } catch (error) {
      await this.releaseLock();
      throw error;
    }
  }

  subscribe(listener: (status: ExperienceRuntimeStatus) => void): () => void {
    this.listeners.add(listener);
    listener(this.getStatus());
    return () => this.listeners.delete(listener);
  }

  getStatus(): ExperienceRuntimeStatus { return { ...this.status }; }
  requiresRecovery(): boolean { return this.status.recoveryRequired; }
  hasLiveTransaction(): boolean { return this.busy; }

  async listCodexInstances(): Promise<CodexSessionInstance[]> {
    await this.ensureInitialized();
    if (this.provider.listInstances) return this.provider.listInstances(this.session);
    if (!this.session) return [];
    return [{
      id: this.session.instanceId ?? `pid-${this.session.pid}`,
      label: "Connected Codex",
      role: this.session.instanceRole ?? "primary",
      pid: this.session.pid,
      processStartedAt: this.session.processStartedAt,
      profilePath: this.session.profilePath ?? null,
      debugPort: this.session.port,
      state: this.target ? "connected" : "connectable",
      connected: Boolean(this.target),
      restartable: this.session.instanceRole !== "custom",
    }];
  }

  async reconcile(): Promise<ExperienceRuntimeStatus> {
    return this.exclusive(async () => {
      await this.ensureInitialized();
      await this.reconcileSession();
      await this.persist();
      return this.getStatus();
    });
  }

  async discardStaleRecovery(): Promise<ExperienceRuntimeStatus> {
    return this.exclusive(async () => {
      await this.ensureInitialized();
      if (!this.status.recoveryRequired) return this.getStatus();
      this.receipt = null;
      this.active = null;
      this.update({
        phase: "idle",
        projectId: null,
        projectKind: null,
        error: null,
        recoveryRequired: false,
        sessionState: this.target ? "ready" : "disconnected",
      });
      await this.persist();
      return this.getStatus();
    });
  }

  importProject(source: ExperienceProjectImportSource, options?: ImportExperienceProjectOptions): Promise<InstalledExperienceProject> {
    return this.library.importProject(source, options);
  }
  listProjects(): Promise<InstalledExperienceProject[]> { return this.library.listProjects(); }
  loadProject(id: string): Promise<ExperienceProjectBundle> { return this.library.loadProject(id); }

  linkDevelopmentProject(sourcePath: string): Promise<ExperienceDevelopmentProject> {
    return this.development.linkProject(sourcePath);
  }
  listDevelopmentProjects(): Promise<ExperienceDevelopmentProject[]> { return this.development.listProjects(); }
  loadDevelopmentProject(id: string): Promise<ExperienceProjectBundle> { return this.development.loadProject(id); }

  async removeProject(id: string): Promise<void> {
    await this.ensureInitialized();
    if (this.active?.projectKind === "installed" && this.active.projectId === id) {
      throw new ExperienceKitError("runtime/active", "Cancel the active experience before removing it");
    }
    await this.library.removeProject(id);
  }

  async removeDevelopmentProject(id: string): Promise<void> {
    await this.ensureInitialized();
    if (this.active?.projectKind === "development" && this.active.projectId === id) {
      throw new ExperienceKitError("runtime/active", "Cancel the active development experience before unlinking it");
    }
    await this.development.removeProject(id);
  }

  async planApply(projectId: string, targetId?: string): Promise<ExperienceProjectApplyPlan> {
    await this.ensureInitialized();
    await this.library.loadProject(projectId);
    return this.planSelection("installed", projectId, targetId);
  }

  async planApplyDevelopment(projectId: string, targetId?: string): Promise<ExperienceProjectApplyPlan> {
    await this.ensureInitialized();
    await this.development.loadProject(projectId);
    return this.planSelection("development", projectId, targetId);
  }

  async applyProject(projectId: string, options: ApplyExperienceProjectOptions): Promise<ExperienceRuntimeStatus> {
    return this.applySelection("installed", projectId, options);
  }

  async applyDevelopmentProject(projectId: string, options: ApplyExperienceProjectOptions): Promise<ExperienceRuntimeStatus> {
    return this.applySelection("development", projectId, options);
  }

  private async applySelection(
    projectKind: ExperienceProjectSourceKind,
    projectId: string,
    options: ApplyExperienceProjectOptions,
  ): Promise<ExperienceRuntimeStatus> {
    return this.exclusive(async () => {
      await this.ensureInitialized();
      const project = await this.loadSelection(projectKind, projectId);
      this.assertRemoteContentGrant(project, options.allowUnrestrictedRemoteContent);
      const currentInstanceId = this.session?.instanceId ?? null;
      const switchingTarget = Boolean(options.targetId && currentInstanceId && options.targetId !== currentInstanceId);
      if (switchingTarget) {
        if (this.target && this.receipt) await this.target.cancel(this.receipt);
        await this.target?.close().catch(() => undefined);
        this.target = null;
        this.session = null;
        this.receipt = null;
        this.active = null;
        this.update({
          phase: "idle",
          projectId: null,
          projectKind: null,
          recoveryRequired: false,
          sessionState: "disconnected",
          codexInstanceId: null,
          error: null,
        });
        await this.persist();
      }
      const operation = this.status.operation + 1;
      this.update({ phase: "applying", projectId, projectKind, operation, error: null });
      const abort = new AbortController();
      this.abort = abort;
      const previous = this.active
        ? { ...this.active, receipt: { ...this.active.receipt }, tokens: structuredClone(this.active.tokens) }
        : null;
      try {
        if (!this.target) {
          const connection = await this.provider.acquire({
            previous: this.session,
            ...(options.targetId ? { targetId: options.targetId } : {}),
            allowRestart: options.allowRestart ?? false,
            timeoutMs: this.timeout,
            signal: abort.signal,
          });
          await this.attach(connection);
          // The verified CDP session is reusable even when the first project
          // injection fails. Persist it before mutating the renderer so a
          // retry never asks the user to restart Codex again.
          await this.persist();
        }
        if (this.receipt) await this.target!.cancel(this.receipt);
        const receipt = await this.target!.apply({
          ...project,
          tokens: structuredClone(options.tokens),
          appearance: options.appearance ?? "light",
          allowUnrestrictedRemoteContent: options.allowUnrestrictedRemoteContent === true,
        }, abort.signal);
        this.receipt = receipt;
        this.active = {
          projectId,
          projectKind,
          runtimeProjectId: project.manifest.id,
          digest: project.digest,
          receipt,
          tokens: structuredClone(options.tokens),
          appearance: options.appearance ?? "light",
          allowUnrestrictedRemoteContent: options.allowUnrestrictedRemoteContent === true,
        };
        this.update({ phase: "active", projectId, projectKind, error: null, recoveryRequired: false });
        await this.persist();
        return this.getStatus();
      } catch (error) {
        let restored = false;
        if (previous && this.target) {
          try {
            const previousProject = await this.loadSelection(previous.projectKind, previous.projectId);
            const restoredReceipt = await this.target.apply({
              ...previousProject,
              tokens: previous.tokens,
              appearance: previous.appearance,
              allowUnrestrictedRemoteContent: previous.allowUnrestrictedRemoteContent === true,
            }, new AbortController().signal);
            this.receipt = restoredReceipt;
            this.active = { ...previous, receipt: restoredReceipt };
            restored = true;
          } catch {
            this.receipt = null;
            this.active = null;
          }
        }
        if (restored && previous) {
          this.update({
            phase: "active",
            projectId: previous.projectId,
            projectKind: previous.projectKind,
            error: null,
            recoveryRequired: false,
          });
          await this.persist().catch(() => undefined);
        } else {
          // A renderer failure invalidates the page-target WebSocket but not
          // the verified loopback Codex session. Drop only the target so the
          // next Apply discovers the reconstructed page without restarting
          // Codex again.
          await this.target?.close().catch(() => undefined);
          this.target = null;
          this.update({ phase: "error", error: errorMessage(error), recoveryRequired: this.active !== null });
          await this.persist().catch(() => undefined);
        }
        throw new ExperienceKitError("runtime/apply", `Unable to apply experience ${projectId}: ${errorMessage(error)}`, { cause: error });
      } finally {
        if (this.abort === abort) this.abort = null;
      }
    });
  }

  async refreshDevelopmentProject(
    projectId: string,
    options: { allowUnrestrictedRemoteContent?: boolean; forceReapply?: boolean } = {},
  ): Promise<ExperienceDevelopmentRefreshResult> {
    return this.exclusive(async () => {
      await this.ensureInitialized();
      const previousMetadata = await this.development.getProject(projectId);
      const previousProject = await this.development.loadProject(projectId);
      const candidate = await this.development.readSourceProject(projectId);
      const isActive = this.active?.projectKind === "development" && this.active.projectId === projectId;
      if (isActive) this.assertRemoteContentGrant(candidate, options.allowUnrestrictedRemoteContent ?? this.active?.allowUnrestrictedRemoteContent);
      if (candidate.digest === previousProject.digest && !(isActive && options.forceReapply === true)) {
        const project = await this.development.replaceSnapshot(projectId, candidate);
        return { project, reapplied: false, status: this.getStatus() };
      }
      if (!isActive) {
        const project = await this.development.replaceSnapshot(projectId, candidate);
        return { project, reapplied: false, status: this.getStatus() };
      }
      if (!this.target || !this.active) {
        throw new ExperienceKitError("development/recovery", "Reconnect or cancel the active development experience before refreshing it");
      }

      const previousActive = {
        ...this.active,
        receipt: { ...this.active.receipt },
        tokens: structuredClone(this.active.tokens),
      };
      this.update({ phase: "applying", projectId, projectKind: "development", operation: this.status.operation + 1, error: null });
      let candidateReceipt: ExperienceProjectApplyReceipt | null = null;
      let snapshotCommitted = false;
      const allowUnrestrictedRemoteContent = options.allowUnrestrictedRemoteContent ?? previousActive.allowUnrestrictedRemoteContent ?? false;
      try {
        await this.target.cancel(this.receipt);
        candidateReceipt = await this.target.apply({
          ...candidate,
          tokens: previousActive.tokens,
          appearance: previousActive.appearance,
          allowUnrestrictedRemoteContent,
        }, new AbortController().signal);
        const project = await this.development.replaceSnapshot(projectId, candidate);
        snapshotCommitted = true;
        this.receipt = candidateReceipt;
        this.active = {
          ...previousActive,
          runtimeProjectId: candidate.manifest.id,
          digest: candidate.digest,
          receipt: candidateReceipt,
          allowUnrestrictedRemoteContent,
        };
        this.update({ phase: "active", projectId, projectKind: "development", error: null, recoveryRequired: false });
        await this.persist();
        return { project, reapplied: true, status: this.getStatus() };
      } catch (error) {
        const rollbackErrors: unknown[] = [];
        if (candidateReceipt) {
          await this.target.cancel(candidateReceipt).catch((rollbackError) => rollbackErrors.push(rollbackError));
        }
        if (snapshotCommitted) {
          await this.development.replaceSnapshot(projectId, previousProject, { refreshedAt: previousMetadata.refreshedAt })
            .catch((rollbackError) => rollbackErrors.push(rollbackError));
        }
        try {
          const restoredReceipt = await this.target.apply({
            ...previousProject,
            tokens: previousActive.tokens,
            appearance: previousActive.appearance,
            allowUnrestrictedRemoteContent: previousActive.allowUnrestrictedRemoteContent === true,
          }, new AbortController().signal);
          this.receipt = restoredReceipt;
          this.active = { ...previousActive, receipt: restoredReceipt };
          this.update({
            phase: "active",
            projectId: previousActive.projectId,
            projectKind: previousActive.projectKind,
            error: null,
            recoveryRequired: false,
          });
          await this.persist();
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
          this.receipt = null;
          this.active = previousActive;
          this.update({ phase: "error", error: errorMessage(error), recoveryRequired: true });
          await this.persist().catch(() => undefined);
        }
        throw new ExperienceKitError(
          "development/refresh",
          `Unable to refresh development experience ${projectId}: ${errorMessage(error)}`,
          { cause: rollbackErrors.length > 0 ? new AggregateError([error, ...rollbackErrors]) : error },
        );
      }
    });
  }

  async patchTokens(tokens: AppearanceTokenModes, appearance?: "light" | "dark"): Promise<ExperienceRuntimeStatus> {
    return this.patchAppearance({ tokens, ...(appearance ? { appearance } : {}) });
  }

  async patchAppearance(options: PatchExperienceAppearanceOptions): Promise<ExperienceRuntimeStatus> {
    await this.ensureInitialized();
    if (!this.target || !this.active) throw new ExperienceKitError("runtime/inactive", "No experience is active");
    const tokens = options.tokens ?? this.active.tokens;
    await this.target.patchTokens(tokens, options.appearance);
    this.active.tokens = structuredClone(tokens);
    if (options.appearance) this.active.appearance = options.appearance;
    await this.persist();
    return this.getStatus();
  }

  async cancelProject(): Promise<ExperienceRuntimeStatus> {
    this.abort?.abort(new DOMException("Experience application cancelled", "AbortError"));
    const pending = this.currentOperation;
    if (pending) await pending.catch(() => undefined);
    return this.exclusive(async () => {
      await this.ensureInitialized();
      this.update({ phase: "cancelling", operation: this.status.operation + 1, error: null });
      try {
        if (this.target) await this.target.cancel(this.receipt);
        else if (this.active) {
          const plan = await this.provider.plan(this.session, this.session?.instanceId);
          if (plan.codexRunning) await this.provider.restartWithoutDebugging(undefined, this.session);
          this.session = null;
        }
        this.receipt = null;
        this.active = null;
        this.update({ phase: "idle", projectId: null, projectKind: null, error: null, recoveryRequired: false });
        await this.persist();
        return this.getStatus();
      } catch (error) {
        this.update({ phase: "error", error: errorMessage(error), recoveryRequired: true });
        throw error;
      }
    });
  }

  async shutdown(options: { mode?: "preserve" | "cancel" } = {}): Promise<void> {
    if (this.closed) return;
    try {
      if (options.mode === "cancel" && this.initialized) await this.cancelProject();
      await this.target?.close().catch(() => undefined);
      this.target = null;
    } finally {
      this.closed = true;
      await this.releaseLock();
    }
  }

  private async planSelection(
    projectKind: ExperienceProjectSourceKind,
    projectId: string,
    targetId?: string,
  ): Promise<ExperienceProjectApplyPlan> {
    if (this.target && this.session && (!targetId || targetId === this.session.instanceId)) {
      return {
        projectId,
        projectKind,
        codexAppAvailable: this.status.codexAppAvailable,
        reusableSession: true,
        codexRunning: true,
        requiresRestart: false,
        requiresTargetSelection: false,
        selectedInstanceId: this.session.instanceId ?? null,
        instances: await this.listCodexInstances(),
        hotSwitch: true,
      };
    }
    const plan = await this.provider.plan(this.session, targetId);
    this.update({ codexAppAvailable: plan.codexAppAvailable });
    return {
      ...plan,
      projectId,
      projectKind,
      hotSwitch: plan.reusableSession && (!this.session || plan.selectedInstanceId === this.session.instanceId),
    };
  }

  private loadSelection(projectKind: ExperienceProjectSourceKind, projectId: string): Promise<ExperienceProjectBundle> {
    return projectKind === "development"
      ? this.development.loadProject(projectId)
      : this.library.loadProject(projectId);
  }

  private assertRemoteContentGrant(project: ExperienceProjectBundle, granted = false): void {
    if (project.manifest.webviews?.securityMode === "unrestricted" && !granted) {
      throw new ExperienceKitError(
        "runtime/unrestricted-remote-content",
        "This Experience requests unrestricted remote content. Explicitly grant allowUnrestrictedRemoteContent only if you trust the project and every remote page it loads.",
      );
    }
  }

  private async attach(connection: CodexSessionConnection): Promise<void> {
    await this.target?.close().catch(() => undefined);
    const target = this.targetFactory(connection.webSocketUrl, connection);
    this.target = target;
    this.session = { ...connection.record };
    this.update({
      sessionState: "ready",
      codexInstanceId: connection.record.instanceId ?? null,
      codexProcessGeneration: "same",
    });
    if (this.active) {
      const probe = await target.probe().catch(() => null);
      if (probe?.projectId === this.active.runtimeProjectId && probe.digest === this.active.digest) {
        this.update({ phase: "active", projectId: this.active.projectId, projectKind: this.active.projectKind, recoveryRequired: false, error: null });
      } else {
        this.update({ phase: "error", projectId: this.active.projectId, projectKind: this.active.projectKind, recoveryRequired: true, error: "The persisted experience runtime could not be verified" });
      }
    }
  }

  private async reconcileSession(): Promise<void> {
    if (this.target) {
      try {
        const probe = await this.target.probe();
        if (!this.active) {
          this.update({ sessionState: "ready", codexProcessGeneration: "same" });
          return;
        }
        if (probe?.projectId === this.active.runtimeProjectId && probe.digest === this.active.digest) {
          this.update({
            phase: "active",
            projectId: this.active.projectId,
            projectKind: this.active.projectKind,
            recoveryRequired: false,
            error: null,
            sessionState: "ready",
            codexProcessGeneration: "same",
          });
          return;
        }
        this.update({
          phase: "error",
          projectId: this.active.projectId,
          projectKind: this.active.projectKind,
          recoveryRequired: true,
          error: "The active experience runtime could not be verified",
          sessionState: "ready",
          codexProcessGeneration: "same",
        });
        return;
      } catch {
        await this.target.close().catch(() => undefined);
        this.target = null;
        this.update({ sessionState: "disconnected" });
      }
    }

    if (!this.session) {
      if (this.active) {
        this.update({
          phase: "error",
          projectId: this.active.projectId,
          projectKind: this.active.projectKind,
          recoveryRequired: true,
          error: "The previous experience session could not be reconnected",
        });
      }
      return;
    }

    const result = this.provider.reconcile
      ? await this.provider.reconcile(this.session, Math.min(2_500, this.timeout)).catch(() => ({
          generation: "unknown" as const,
          connection: null,
        }))
      : {
          generation: "unknown" as const,
          connection: await this.provider.reconnect(this.session, Math.min(2_500, this.timeout)).catch(() => null),
        };

    if (result.generation === "replaced" || result.generation === "exited") {
      this.receipt = null;
      this.active = null;
      this.session = null;
      this.update({
        phase: "idle",
        projectId: null,
        projectKind: null,
        error: null,
        recoveryRequired: false,
        sessionState: "disconnected",
        codexInstanceId: null,
        codexProcessGeneration: result.generation,
      });
    } else {
      this.update({ codexProcessGeneration: result.generation });
    }

    if (result.connection) {
      await this.attach(result.connection);
      if (result.generation === "replaced") {
        this.update({ codexProcessGeneration: "replaced" });
      }
      return;
    }

    if (this.active) {
      this.update({
        phase: "error",
        projectId: this.active.projectId,
        projectKind: this.active.projectKind,
        recoveryRequired: true,
        error: result.generation === "same"
          ? "The Codex process is still running, but its experience connection is temporarily unavailable"
          : "The previous experience session could not be reconnected",
      });
    }
  }

  private async exclusive<T>(work: () => Promise<T>): Promise<T> {
    if (this.busy) throw new ExperienceKitError("runtime/busy", "Another experience operation is in progress");
    this.busy = true;
    const operation = work();
    this.currentOperation = operation;
    try { return await operation; } finally {
      if (this.currentOperation === operation) this.currentOperation = null;
      this.busy = false;
    }
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) await this.initialize();
    if (this.closed) throw new ExperienceKitError("runtime/closed", "Experience Engine is closed");
  }

  private update(next: Partial<ExperienceRuntimeStatus>): void {
    this.status = { ...this.status, ...next };
    for (const listener of this.listeners) listener(this.getStatus());
  }

  private async persist(): Promise<void> {
    const state: EngineState = { version: 2, session: this.session, active: this.active, updatedAt: new Date().toISOString() };
    await fs.mkdir(path.dirname(this.statePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.statePath}.${this.instanceId}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporary, this.statePath);
  }

  private async readState(): Promise<EngineState | null> {
    try {
      const value = JSON.parse(await fs.readFile(this.statePath, "utf8")) as EngineState | LegacyEngineState;
      if (value.version === 2) return value;
      if (value.version !== 1) return null;
      return {
        version: 2,
        session: value.session,
        active: value.active ? {
          ...value.active,
          projectKind: "installed",
          runtimeProjectId: value.active.projectId,
        } : null,
        updatedAt: value.updatedAt,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      return null;
    }
  }

  private async acquireLock(): Promise<void> {
    await fs.mkdir(path.dirname(this.lockPath), { recursive: true, mode: 0o700 });
    try {
      await fs.writeFile(this.lockPath, JSON.stringify({ pid: process.pid, instanceId: this.instanceId }), { flag: "wx", mode: 0o600 });
      this.lockHeld = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = JSON.parse(await fs.readFile(this.lockPath, "utf8").catch(() => "{}")) as { pid?: number };
      if (owner.pid && this.processExists(owner.pid)) throw new ExperienceKitError("runtime/in-use", "This Experience Engine library is already in use");
      await fs.unlink(this.lockPath).catch(() => undefined);
      await fs.writeFile(this.lockPath, JSON.stringify({ pid: process.pid, instanceId: this.instanceId }), { flag: "wx", mode: 0o600 });
      this.lockHeld = true;
    }
  }

  private processExists(pid: number): boolean {
    try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
  }

  private async releaseLock(): Promise<void> {
    if (!this.lockHeld) return;
    this.lockHeld = false;
    const owner = JSON.parse(await fs.readFile(this.lockPath, "utf8").catch(() => "{}")) as { instanceId?: string };
    if (owner.instanceId === this.instanceId) await fs.unlink(this.lockPath).catch(() => undefined);
  }
}
