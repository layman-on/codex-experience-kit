import { ExperienceKitError } from "../core/errors.js";
import { experienceSurfaceKey, type ExperienceProjectApplyReceipt, type ExperienceProjectPayload } from "../core/experience-project.js";
import type { AppearanceTokenModes } from "../core/appearance-tokens.js";
import type { CodexContextEvent, CodexContextSnapshot, CodexContextSource } from "../core/codex-context.js";
import { CdpClient, type CdpClientOptions, type CdpEvent } from "./cdp-client.js";
import {
  buildExperienceProjectCancelScript,
  buildExperienceProjectCdpPlan,
  buildExperienceProjectContextPatchScript,
  buildExperienceProjectContextEventScript,
  buildExperienceProjectContextProbeScript,
  buildExperienceProjectProbeScript,
  buildExperienceProjectStageScript,
  buildExperienceProjectTokenPatchScript,
  type ExperienceProjectCdpPlan,
} from "./experience-project-injection.js";
import { startNativeActionBroker, stopNativeActionBroker } from "./native-action-broker.js";

interface RemoteObject { value?: unknown; description?: string; objectId?: string }
interface Evaluation { result?: RemoteObject; exceptionDetails?: unknown }
interface Registration { identifier?: string }
interface AttachedTarget {
  sessionId?: unknown;
  targetInfo?: { type?: unknown; targetId?: unknown; url?: unknown };
}
interface ActivePlan {
  generation: number;
  payload: ExperienceProjectPayload;
  plan: ExperienceProjectCdpPlan;
}

const CHILD_READY_TIMEOUT_MS = 8_000;

function text(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

export class ExperienceProjectCdpTarget {
  readonly id: string;
  private readonly client: CdpClient;
  private guardScriptId: string | null = null;
  private readonly contextSource: CodexContextSource | undefined;
  private readonly onContextError: ((error: unknown) => void) | undefined;
  private readonly nativeActions: { libraryPath: string; codexExecutablePath: string } | undefined;
  private unsubscribeContext: (() => void) | null = null;
  private contextOperation: Promise<void> = Promise.resolve();
  private activePlan: ActivePlan | null = null;
  private planGeneration = 0;
  private childErrors: Error[] = [];
  private replayOperation: Promise<void> = Promise.resolve();
  private readonly unsubscribeProtocolEvents: Array<() => void>;

  constructor(webSocketUrl: string, options: CdpClientOptions & {
    id?: string;
    contextSource?: CodexContextSource;
    onContextError?: (error: unknown) => void;
    nativeActions?: { libraryPath: string; codexExecutablePath: string };
  } = {}) {
    this.id = options.id ?? `cdp:${new URL(webSocketUrl).host}`;
    this.client = new CdpClient(webSocketUrl, options);
    this.contextSource = options.contextSource;
    this.onContextError = options.onContextError;
    this.nativeActions = options.nativeActions;
    this.unsubscribeProtocolEvents = [
      this.client.on("Target.attachedToTarget", (event) => { void this.handleAttachedTarget(event); }),
      this.client.on("Page.loadEventFired", () => { this.scheduleReplay(); }),
    ];
  }

  async apply(payload: ExperienceProjectPayload, signal: AbortSignal): Promise<ExperienceProjectApplyReceipt> {
    const nativeActionBroker = this.nativeActions && payload.manifest.permissions.includes("host.actions")
      ? await startNativeActionBroker({
          libraryPath: this.nativeActions.libraryPath,
          webSocketUrl: this.client.webSocketUrl,
          codexExecutablePath: this.nativeActions.codexExecutablePath,
        })
      : null;
    const active: ActivePlan = {
      generation: ++this.planGeneration,
      payload,
      plan: buildExperienceProjectCdpPlan(payload, {
        ...(nativeActionBroker ? { nativeActionBinding: nativeActionBroker.bindingName } : {}),
      }),
    };
    this.activePlan = active;
    this.childErrors = [];
    try {
      await this.client.call("Runtime.enable", {}, signal);
      await this.client.call("Page.enable", {}, signal);
      // `sandbox="allow-scripts"` deliberately gives Experience frames an
      // opaque origin. Chromium exposes those OOPIFs as child CDP targets, so
      // the main page session cannot execute their application code.
      await this.client.call("Target.setAutoAttach", {
        autoAttach: true,
        flatten: true,
        waitForDebuggerOnStart: true,
      }, signal);
      const result = await this.installHost(active.plan, signal) as Record<string, unknown>;
      if (result.ok !== true || result.activeProjectId !== payload.manifest.id
        || result.digest !== payload.digest || result.declaredSurfaceCount !== payload.surfaces.length) {
        throw new ExperienceKitError("project-cdp/verify", "Codex rejected the staged Experience host runtime");
      }
      await this.waitForSurfaceRuntime(active, signal);
      await this.attachContextSource();
      return { targetId: this.id };
    } catch (error) {
      this.detachContextSource();
      if (this.activePlan === active) this.activePlan = null;
      await this.rollback().catch(() => undefined);
      if (this.nativeActions) await stopNativeActionBroker(this.nativeActions.libraryPath).catch(() => undefined);
      throw error;
    }
  }

  async patchTokens(tokens: AppearanceTokenModes, appearance?: "light" | "dark"): Promise<void> {
    const result = await this.evaluate(buildExperienceProjectTokenPatchScript(tokens, appearance)) as Record<string, unknown>;
    if (result.ok !== true) throw new ExperienceKitError("project-cdp/patch", "No active Experience Runtime accepted the appearance token update");
  }

  async getCodexContext(): Promise<CodexContextSnapshot | null> {
    const result = await this.evaluate(buildExperienceProjectContextProbeScript()).catch(() => null);
    if (!result || typeof result !== "object" || Array.isArray(result)) return null;
    const snapshot = result as Partial<CodexContextSnapshot>;
    return snapshot.connection && Array.isArray(snapshot.threads) && (typeof snapshot.activeThreadId === "string" || snapshot.activeThreadId === null)
      ? snapshot as CodexContextSnapshot
      : null;
  }

  async patchCodexContext(snapshot: CodexContextSnapshot): Promise<void> {
    const result = await this.evaluate(buildExperienceProjectContextPatchScript(snapshot)) as Record<string, unknown>;
    if (result.ok !== true) throw new ExperienceKitError("project-cdp/context", "No active Experience Runtime accepted the Codex context update");
  }

  async emitCodexContextEvent(event: CodexContextEvent, snapshot: CodexContextSnapshot): Promise<void> {
    const result = await this.evaluate(buildExperienceProjectContextEventScript(event, snapshot)) as Record<string, unknown>;
    if (result.ok !== true) throw new ExperienceKitError("project-cdp/context-event", "No active Experience Runtime accepted the Codex context event");
  }

  async cancel(receipt: ExperienceProjectApplyReceipt | null): Promise<void> {
    this.detachContextSource();
    this.activePlan = null;
    this.planGeneration += 1;
    try { await this.rollback(receipt?.documentScriptId); }
    finally { if (this.nativeActions) await stopNativeActionBroker(this.nativeActions.libraryPath); }
  }

  async probe(): Promise<{ projectId: string; digest: string } | null> {
    const result = await this.evaluate(buildExperienceProjectProbeScript()).catch(() => null);
    if (!result || typeof result !== "object" || Array.isArray(result)) return null;
    const value = result as Record<string, unknown>;
    return typeof value.projectId === "string" && typeof value.digest === "string"
      ? { projectId: value.projectId, digest: value.digest }
      : null;
  }

  async close(): Promise<void> {
    this.detachContextSource();
    this.activePlan = null;
    for (const unsubscribe of this.unsubscribeProtocolEvents.splice(0)) unsubscribe();
    await this.client.close();
  }

  private async handleAttachedTarget(event: CdpEvent): Promise<void> {
    const attached = event.params as AttachedTarget;
    const sessionId = typeof attached.sessionId === "string" ? attached.sessionId : event.sessionId;
    if (!sessionId) return;
    const active = this.activePlan;
    let matched = false;
    try {
      if (attached.targetInfo?.type !== "iframe") return;
      await this.client.call("Runtime.enable", {}, undefined, sessionId);
      const name = await this.evaluateInSession("window.name", sessionId, false);
      if (typeof name !== "string" || !active) return;
      const source = active.plan.childSources.get(name);
      if (!source || this.activePlan !== active) return;
      matched = true;
      await this.evaluateInSession(source, sessionId, false);
    } catch (error) {
      if (matched && active && this.activePlan === active) {
        this.childErrors.push(new ExperienceKitError(
          "project-cdp/child",
          `Unable to initialize an isolated Experience iframe: ${text(error)}`,
          { cause: error },
        ));
      }
    } finally {
      // Auto-attach pauses every new iframe target, including Codex-owned
      // frames. Resume unmatched targets immediately and never strand one on
      // an Experience error.
      await this.client.call("Runtime.runIfWaitingForDebugger", {}, undefined, sessionId).catch(() => undefined);
    }
  }

  private scheduleReplay(): void {
    const active = this.activePlan;
    if (!active) return;
    this.replayOperation = this.replayOperation
      .catch(() => undefined)
      .then(async () => {
        if (this.activePlan !== active) return;
        this.childErrors = [];
        await this.installHost(active.plan);
        await this.waitForSurfaceRuntime(active);
        if (this.contextSource && this.activePlan === active) {
          await this.patchCodexContext(this.contextSource.getSnapshot());
        }
      })
      .catch((error) => { this.onContextError?.(error); });
  }

  private async installHost(plan: ExperienceProjectCdpPlan, signal?: AbortSignal): Promise<unknown> {
    const stage = await this.client.call<Evaluation>("Runtime.evaluate", {
      expression: buildExperienceProjectStageScript(),
      awaitPromise: false,
      returnByValue: false,
    }, signal);
    if (stage.exceptionDetails || typeof stage.result?.objectId !== "string") {
      throw new ExperienceKitError("project-cdp/stage", stage.result?.description ?? "Codex did not create an Experience staging object");
    }
    const objectId = stage.result.objectId;
    try {
      const staged = await this.client.call<Evaluation>("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: "function(documentHtml){this.documentHtml=documentHtml;return true}",
        arguments: [{ value: plan.documentHtml }],
        awaitPromise: false,
        returnByValue: true,
      }, signal);
      if (staged.exceptionDetails || staged.result?.value !== true) {
        throw new ExperienceKitError("project-cdp/stage", staged.result?.description ?? "Codex did not accept the Experience document payload");
      }
    } finally {
      await this.client.call("Runtime.releaseObject", { objectId }).catch(() => undefined);
    }
    return this.evaluate(plan.hostSource, signal);
  }

  private async waitForSurfaceRuntime(active: ActivePlan, signal?: AbortSignal): Promise<void> {
    const declared = active.payload.surfaces.map(experienceSurfaceKey);
    const requiredRoots = active.payload.surfaces
      .filter((surface) => surface.target === "app-shell")
      .map(experienceSurfaceKey);
    const deadline = Date.now() + CHILD_READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw signal.reason ?? new DOMException("Operation aborted", "AbortError");
      if (this.activePlan !== active) throw new ExperienceKitError("project-cdp/superseded", "Experience installation was superseded");
      const childError = this.childErrors.shift();
      if (childError) throw childError;
      const result = await this.evaluate(buildExperienceProjectProbeScript(), signal).catch(() => null);
      if (result && typeof result === "object" && !Array.isArray(result)) {
        const probe = result as Record<string, unknown>;
        const mounted = Array.isArray(probe.surfacesMounted) ? probe.surfacesMounted.filter((item): item is string => typeof item === "string") : [];
        const ready = Array.isArray(probe.surfacesReady) ? probe.surfacesReady.filter((item): item is string => typeof item === "string") : [];
        const pending = Array.isArray(probe.surfacesPending) ? probe.surfacesPending.filter((item): item is string => typeof item === "string") : [];
        const classified = new Set([...mounted, ...pending]);
        const valid = probe.projectId === active.payload.manifest.id
          && probe.digest === active.payload.digest
          && probe.declaredSurfaceCount === declared.length
          && classified.size === declared.length
          && declared.every((key) => classified.has(key))
          && mounted.every((key) => ready.includes(key))
          && requiredRoots.every((key) => ready.includes(key));
        if (valid) return;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const childError = this.childErrors.shift();
    if (childError) throw childError;
    throw new ExperienceKitError(
      "project-cdp/child-timeout",
      "Experience iframe runtime did not initialize inside Codex's isolated child target",
    );
  }

  private async attachContextSource(): Promise<void> {
    this.detachContextSource();
    if (!this.contextSource) return;
    this.unsubscribeContext = this.contextSource.subscribe((event, snapshot) => {
      this.contextOperation = this.contextOperation
        .catch(() => undefined)
        .then(() => this.emitCodexContextEvent(event, snapshot))
        .catch((error) => { this.onContextError?.(error); });
    });
    await this.patchCodexContext(this.contextSource.getSnapshot());
  }

  private detachContextSource(): void {
    this.unsubscribeContext?.();
    this.unsubscribeContext = null;
  }

  private async evaluate(expression: string, signal?: AbortSignal): Promise<unknown> {
    const evaluation = await this.client.call<Evaluation>("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    }, signal);
    if (evaluation.exceptionDetails) {
      throw new ExperienceKitError("project-cdp/evaluate", evaluation.result?.description ?? "Experience Runtime evaluation failed");
    }
    return evaluation.result?.value;
  }

  private async evaluateInSession(expression: string, sessionId: string, awaitPromise: boolean): Promise<unknown> {
    const evaluation = await this.client.call<Evaluation>("Runtime.evaluate", {
      expression,
      awaitPromise,
      returnByValue: true,
    }, undefined, sessionId);
    if (evaluation.exceptionDetails) {
      throw new ExperienceKitError("project-cdp/child-evaluate", evaluation.result?.description ?? "Experience child runtime evaluation failed");
    }
    return evaluation.result?.value;
  }

  private async rollback(legacyDocumentScriptId?: string): Promise<void> {
    const errors: unknown[] = [];
    try {
      const result = await this.evaluate(buildExperienceProjectCancelScript()) as Record<string, unknown>;
      if (result?.ok !== true || result.activeProjectId !== null) throw new Error("Experience Runtime cancellation did not verify");
    } catch (error) { errors.push(error); }
    await this.client.call("Target.setAutoAttach", {
      autoAttach: false,
      flatten: true,
      waitForDebuggerOnStart: false,
    }).catch((error) => errors.push(error));
    if (legacyDocumentScriptId) {
      try {
        await this.client.call("Page.removeScriptToEvaluateOnNewDocument", { identifier: legacyDocumentScriptId });
      } catch (error) {
        try { await this.ensureGuard(); } catch (guardError) { errors.push(new AggregateError([error, guardError])); }
      }
    }
    if (errors.length > 0) {
      throw new ExperienceKitError("project-cdp/cancel", "Unable to fully cancel the experience project", {
        cause: errors.length === 1 ? errors[0] : new AggregateError(errors),
      });
    }
  }

  private async ensureGuard(): Promise<void> {
    if (this.guardScriptId) return;
    const registration = await this.client.call<Registration>("Page.addScriptToEvaluateOnNewDocument", {
      source: buildExperienceProjectCancelScript(),
    });
    if (!registration.identifier) throw new ExperienceKitError("project-cdp/guard", "Unable to register the Experience Runtime cancellation guard");
    this.guardScriptId = registration.identifier;
  }
}
