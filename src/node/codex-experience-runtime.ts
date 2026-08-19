import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  generateAppearanceTokens,
  type AppearanceContrast,
  type AppearanceTokenModes,
} from "../core/appearance-tokens.js";
import { ExperienceKitError } from "../core/errors.js";
import { MacOSCodexSessionProvider, type CodexSessionInstance } from "./codex-app-session.js";
import type {
  ExperienceDevelopmentProject,
  ExperienceProjectImportSource,
  ExperienceProjectSourceKind,
  ImportExperienceProjectOptions,
  InstalledExperienceProject,
} from "../core/experience-project.js";
import {
  ExperienceEngine,
  type ExperienceEngineOptions,
  type ExperienceProjectApplyPlan,
  type ExperienceRuntimeStatus,
} from "./experience-engine.js";
import { readExperienceProjectPackage } from "./experience-project-package.js";
import { buildExperienceProject } from "./experience-project-tools.js";
import {
  IsolatedCodexWorkflow,
  type OpenConfiguredIsolatedCodexOptions,
  type OpenConfiguredIsolatedCodexResult,
  type OpenManagedIsolatedCodexResult,
} from "./isolated-codex-workflow.js";
import type { CodexTransferCatalog } from "./codex-instance-transfer.js";
import type { IsolatedCodexInstanceStatus } from "./isolated-codex-instance.js";

export interface CodexExperienceRuntimeOptions extends Omit<ExperienceEngineOptions, "libraryPath"> {
  libraryPath?: string;
  engine?: ExperienceEngine;
  security?: {
    allowUnrestrictedRemoteContent?: boolean;
  };
}

export interface CodexExperienceAppearanceOptions {
  tokens?: AppearanceTokenModes;
  seed?: string;
  darkSeed?: string;
  contrast?: AppearanceContrast;
  appearance?: "light" | "dark";
}

export interface CodexExperienceDirectApplyOptions extends CodexExperienceAppearanceOptions {
  targetId?: string;
  allowRestart?: boolean;
  replaceInstalled?: boolean;
  allowUnrestrictedRemoteContent?: boolean;
}

export interface CodexExperienceDirectApplyResult {
  projectId: string;
  projectKind: ExperienceProjectSourceKind;
  projectName: string;
  hotUpdated: boolean;
  plan: ExperienceProjectApplyPlan | null;
  status: ExperienceRuntimeStatus;
}

export interface CodexExperienceCatalog {
  installed: InstalledExperienceProject[];
  development: ExperienceDevelopmentProject[];
}

const DEFAULT_SEED = "#7667D9";

export function resolveCodexExperienceLibraryPath(homeDirectory = os.homedir()): string {
  return path.join(homeDirectory, "Library", "Application Support", "CodexExperienceKit");
}

function projectSource(sourcePath: string): ExperienceProjectImportSource {
  return { kind: path.extname(sourcePath).toLowerCase() === ".zip" ? "zip" : "directory", path: sourcePath };
}

function tokenModes(options: CodexExperienceAppearanceOptions, fallback?: AppearanceTokenModes): AppearanceTokenModes {
  if (options.tokens) return structuredClone(options.tokens);
  if (!options.seed && !options.darkSeed && !options.contrast && fallback) return structuredClone(fallback);
  return generateAppearanceTokens({
    seed: options.seed ?? DEFAULT_SEED,
    contrast: options.contrast ?? "standard",
    ...(options.darkSeed ? { darkSeed: options.darkSeed } : {}),
  }).modes;
}

export class CodexExperienceRuntime {
  readonly engine: ExperienceEngine;
  readonly #allowUnrestrictedRemoteContent: boolean;
  readonly #libraryPath: string;
  private initialized = false;

  constructor(options: CodexExperienceRuntimeOptions = {}) {
    this.#libraryPath = options.libraryPath ?? resolveCodexExperienceLibraryPath();
    this.#allowUnrestrictedRemoteContent = options.security?.allowUnrestrictedRemoteContent ?? false;
    this.engine = options.engine ?? new ExperienceEngine({
      libraryPath: this.#libraryPath,
      ...(options.statePath ? { statePath: options.statePath } : {}),
      ...(options.targetDiscoveryTimeoutMs ? { targetDiscoveryTimeoutMs: options.targetDiscoveryTimeoutMs } : {}),
      ...(options.sessionProvider ? { sessionProvider: options.sessionProvider } : {}),
      ...(options.targetFactory ? { targetFactory: options.targetFactory } : {}),
      ...(options.contextSource ? { contextSource: options.contextSource } : {}),
    });
  }

  async initialize(): Promise<ExperienceRuntimeStatus> {
    const status = await this.engine.initialize();
    this.initialized = true;
    return status;
  }

  async getStatus(): Promise<ExperienceRuntimeStatus> {
    await this.ensureInitialized();
    return this.engine.reconcile();
  }

  async listCodexInstances(): Promise<CodexSessionInstance[]> {
    await this.ensureInitialized();
    await this.engine.reconcile();
    return this.engine.listCodexInstances();
  }

  async inspectSecondaryCodexInstance(): Promise<IsolatedCodexInstanceStatus> {
    return (await this.isolatedCodexWorkflow()).inspect();
  }

  async getSecondaryCodexTransferCatalog(): Promise<CodexTransferCatalog> {
    return (await this.isolatedCodexWorkflow()).catalog();
  }

  async openSecondaryCodexInstance(): Promise<OpenManagedIsolatedCodexResult> {
    return (await this.isolatedCodexWorkflow()).open();
  }

  async openConfiguredSecondaryCodexInstance(options: OpenConfiguredIsolatedCodexOptions): Promise<OpenConfiguredIsolatedCodexResult> {
    return (await this.isolatedCodexWorkflow()).openConfigured(options);
  }

  async list(): Promise<CodexExperienceCatalog> {
    await this.ensureInitialized();
    const [installed, development] = await Promise.all([
      this.engine.listProjects(),
      this.engine.listDevelopmentProjects(),
    ]);
    return { installed, development };
  }

  async install(sourcePath: string, options: ImportExperienceProjectOptions = {}): Promise<InstalledExperienceProject> {
    await this.ensureInitialized();
    const absolute = await fs.realpath(sourcePath);
    const source = projectSource(absolute);
    if (options.conflict === "replace") {
      const [candidate, status] = await Promise.all([readExperienceProjectPackage(source), this.getStatus()]);
      if (status.phase === "active" && status.projectKind === "installed" && status.projectId === candidate.manifest.id) {
        throw new ExperienceKitError("direct/active-replace", "Cancel the active installed Experience before replacing its immutable copy");
      }
    }
    return this.engine.importProject(source, options);
  }

  async apply(reference = process.cwd(), options: CodexExperienceDirectApplyOptions = {}): Promise<CodexExperienceDirectApplyResult> {
    await this.ensureInitialized();
    await this.engine.reconcile();
    // Clicking Apply is an explicit replacement request. If the persisted CDP
    // session vanished after Codex or macOS restarted, no injected renderer can
    // still be reached; discard only that stale runtime receipt and continue to
    // the normal restart-consent plan. Project snapshots and user data remain.
    if (this.engine.requiresRecovery()) await this.engine.discardStaleRecovery();
    const resolved = path.resolve(reference);
    const stat = await fs.lstat(resolved).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (!stat) return this.applyId(reference, options);
    if (stat.isSymbolicLink()) throw new ExperienceKitError("direct/source", "Experience source cannot be a symbolic link");
    if (stat.isDirectory()) {
      const isAuthoringProject = await fs.lstat(path.join(resolved, "experience.config.json"))
        .then((entry) => entry.isFile() && !entry.isSymbolicLink(), (error) => (error as NodeJS.ErrnoException).code === "ENOENT" ? false : Promise.reject(error));
      if (isAuthoringProject) {
        const built = await buildExperienceProject(resolved);
        return this.applyDevelopmentDirectory(built.directory, options, built.tokens);
      }
      return this.applyDevelopmentDirectory(resolved, options);
    }
    if (stat.isFile() && path.extname(resolved).toLowerCase() === ".zip") {
      const installed = await this.install(resolved, { conflict: options.replaceInstalled ? "replace" : "reject" });
      return this.applyInstalled(installed.id, installed.name, options);
    }
    throw new ExperienceKitError("direct/source", "Apply expects an authoring project, built dist directory, ZIP, or installed Experience ID");
  }

  async patchAppearance(options: CodexExperienceAppearanceOptions): Promise<ExperienceRuntimeStatus> {
    await this.ensureInitialized();
    await this.engine.reconcile();
    const hasTokenInput = Boolean(options.tokens || options.seed || options.darkSeed || options.contrast);
    if (!hasTokenInput && !options.appearance) {
      throw new ExperienceKitError("direct/appearance", "Appearance update requires tokens, a seed, or light/dark appearance");
    }
    return this.engine.patchAppearance({
      ...(hasTokenInput ? { tokens: tokenModes(options) } : {}),
      ...(options.appearance ? { appearance: options.appearance } : {}),
    });
  }

  async cancel(): Promise<ExperienceRuntimeStatus> {
    await this.ensureInitialized();
    await this.engine.reconcile();
    return this.engine.cancelProject();
  }

  async shutdown(): Promise<void> {
    await this.engine.shutdown({ mode: "preserve" });
  }

  private async applyId(id: string, options: CodexExperienceDirectApplyOptions): Promise<CodexExperienceDirectApplyResult> {
    const catalog = await this.list();
    const development = catalog.development.find((item) => item.id === id);
    if (development) return this.applyDevelopmentId(development.id, development.name, options);
    const installed = catalog.installed.find((item) => item.id === id);
    if (installed) return this.applyInstalled(installed.id, installed.name, options);
    throw new ExperienceKitError("direct/project", `Experience not found: ${id}`);
  }

  private async applyDevelopmentDirectory(
    directory: string,
    options: CodexExperienceDirectApplyOptions,
    fallbackTokens?: AppearanceTokenModes,
  ): Promise<CodexExperienceDirectApplyResult> {
    const linked = await this.engine.linkDevelopmentProject(await fs.realpath(directory));
    const refreshed = await this.engine.refreshDevelopmentProject(linked.id, {
      allowUnrestrictedRemoteContent: options.allowUnrestrictedRemoteContent ?? this.#allowUnrestrictedRemoteContent,
      // An explicit Apply must reinstall package-owned host code even when
      // author assets have the same digest (for example after a Kit upgrade).
      forceReapply: !options.targetId || options.targetId === this.engine.getStatus().codexInstanceId,
    });
    const status = this.engine.getStatus();
    const targetMatches = !options.targetId || options.targetId === status.codexInstanceId;
    if (targetMatches && (refreshed.reapplied || (status.phase === "active" && status.projectKind === "development" && status.projectId === linked.id))) {
      const hasTokenInput = Boolean(options.tokens || options.seed || options.darkSeed || options.contrast || fallbackTokens);
      const patchedStatus = hasTokenInput || options.appearance
        ? await this.engine.patchAppearance({
            ...(hasTokenInput ? { tokens: tokenModes(options, fallbackTokens) } : {}),
            ...(options.appearance ? { appearance: options.appearance } : {}),
          })
        : refreshed.status;
      return {
        projectId: linked.id,
        projectKind: "development",
        projectName: refreshed.project.name,
        hotUpdated: refreshed.reapplied,
        plan: null,
        status: patchedStatus,
      };
    }
    return this.applyDevelopmentId(linked.id, refreshed.project.name, options, fallbackTokens);
  }

  private async applyDevelopmentId(
    id: string,
    name: string,
    options: CodexExperienceDirectApplyOptions,
    fallbackTokens?: AppearanceTokenModes,
  ): Promise<CodexExperienceDirectApplyResult> {
    const plan = await this.engine.planApplyDevelopment(id, options.targetId);
    this.assertRestartConsent(plan, options.allowRestart);
    const status = await this.engine.applyDevelopmentProject(id, {
      tokens: tokenModes(options, fallbackTokens),
      appearance: options.appearance ?? "light",
      ...(options.targetId ? { targetId: options.targetId } : {}),
      allowRestart: options.allowRestart ?? false,
      allowUnrestrictedRemoteContent: options.allowUnrestrictedRemoteContent ?? this.#allowUnrestrictedRemoteContent,
    });
    return { projectId: id, projectKind: "development", projectName: name, hotUpdated: plan.hotSwitch, plan, status };
  }

  private async applyInstalled(
    id: string,
    name: string,
    options: CodexExperienceDirectApplyOptions,
  ): Promise<CodexExperienceDirectApplyResult> {
    const plan = await this.engine.planApply(id, options.targetId);
    this.assertRestartConsent(plan, options.allowRestart);
    const status = await this.engine.applyProject(id, {
      tokens: tokenModes(options),
      appearance: options.appearance ?? "light",
      ...(options.targetId ? { targetId: options.targetId } : {}),
      allowRestart: options.allowRestart ?? false,
      allowUnrestrictedRemoteContent: options.allowUnrestrictedRemoteContent ?? this.#allowUnrestrictedRemoteContent,
    });
    return { projectId: id, projectKind: "installed", projectName: name, hotUpdated: plan.hotSwitch, plan, status };
  }

  private assertRestartConsent(plan: ExperienceProjectApplyPlan, allowRestart = false): void {
    if (plan.requiresTargetSelection) {
      throw new ExperienceKitError(
        "direct/target-selection-required",
        "Multiple Codex instances are running. Select one with --target or the preview instance selector.",
      );
    }
    if (plan.requiresRestart && !allowRestart) {
      throw new ExperienceKitError(
        "direct/restart-confirmation-required",
        "Codex must restart once to enable the Experience connection. Re-run with --allow-restart after confirming your work is saved.",
      );
    }
  }

  private async isolatedCodexWorkflow(): Promise<IsolatedCodexWorkflow> {
    const identity = await new MacOSCodexSessionProvider({ libraryPath: this.#libraryPath }).getIdentity();
    return new IsolatedCodexWorkflow({ libraryPath: this.#libraryPath, executablePath: identity.executablePath });
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) await this.initialize();
  }
}
