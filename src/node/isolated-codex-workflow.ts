import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { ExperienceKitError } from "../core/errors.js";
import {
  discoverCodexTransferCatalog,
  transferCodexInstanceData,
  type CodexTransferCatalog,
  type TransferCodexInstanceDataResult,
} from "./codex-instance-transfer.js";
import {
  inspectIsolatedCodexInstance,
  installIsolatedCodexLauncher,
  openIsolatedCodexInstance,
  resolveIsolatedCodexHomePath,
  resolveIsolatedCodexProfilePath,
  stopIsolatedCodexInstance,
  type IsolatedCodexInstanceStatus,
  type OpenIsolatedCodexInstanceResult,
} from "./isolated-codex-instance.js";

const execFileAsync = promisify(execFile);

export interface IsolatedCodexWorkflowOptions {
  libraryPath: string;
  executablePath: string;
  sourceCodexHome?: string;
  confirmConversationTransfer?: (selectedCount: number) => Promise<boolean>;
}

export interface OpenManagedIsolatedCodexResult extends OpenIsolatedCodexInstanceResult {
  launcherPath: string;
}

export interface OpenConfiguredIsolatedCodexOptions {
  selectedItemIds: string[];
  selectedConversationThreadIds?: string[];
}

export type OpenConfiguredIsolatedCodexResult =
  | { status: "cancelled" }
  | {
      status: "ok";
      transfer: TransferCodexInstanceDataResult;
      instance: OpenManagedIsolatedCodexResult;
    };

function assertWorkflowOptions(options: IsolatedCodexWorkflowOptions): void {
  if (!path.isAbsolute(options.libraryPath)) throw new ExperienceKitError("isolated-workflow/library", "Experience library path must be absolute");
  if (!path.isAbsolute(options.executablePath)) throw new ExperienceKitError("isolated-workflow/executable", "Codex executable path must be absolute");
}

function sourceCodexHome(options: IsolatedCodexWorkflowOptions): string {
  const value = options.sourceCodexHome?.trim() || process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
  const destination = resolveIsolatedCodexHomePath(options.libraryPath);
  if (!path.isAbsolute(value) || path.resolve(value) === path.resolve(destination)) {
    throw new ExperienceKitError("isolated-workflow/codex-home", "Primary CODEX_HOME is invalid or aliases the secondary account");
  }
  return value;
}

async function defaultConversationConfirmation(selectedCount: number): Promise<boolean> {
  const message = `将主账号中已选择的 ${selectedCount} 个对话快照复制到第二账号。不会复制登录凭据；主账号任务继续运行，但第二账号 Codex 会短暂重启。`;
  const escaped = message.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  const script = `display dialog "${escaped}" with title "Codex Experience Kit" buttons {"取消", "同步"} default button "同步" cancel button "取消" with icon caution`;
  try {
    await execFileAsync("/usr/bin/osascript", ["-e", script], { timeout: 120_000, maxBuffer: 1024 * 1024 });
    return true;
  } catch {
    return false;
  }
}

async function waitForStateDatabase(codexHomePath: string, timeoutMs = 20_000): Promise<void> {
  const statePath = path.join(codexHomePath, "state_5.sqlite");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fs.access(statePath).then(() => true, () => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new ExperienceKitError("isolated-workflow/initialize", "Secondary Codex did not initialize its local state database in time");
}

export class IsolatedCodexWorkflow {
  readonly #options: IsolatedCodexWorkflowOptions;

  constructor(options: IsolatedCodexWorkflowOptions) {
    assertWorkflowOptions(options);
    this.#options = options;
  }

  async inspect(): Promise<IsolatedCodexInstanceStatus> {
    return inspectIsolatedCodexInstance(this.#options.libraryPath, this.#options.executablePath);
  }

  async catalog(): Promise<CodexTransferCatalog> {
    return discoverCodexTransferCatalog(
      sourceCodexHome(this.#options),
      resolveIsolatedCodexHomePath(this.#options.libraryPath),
    );
  }

  async open(): Promise<OpenManagedIsolatedCodexResult> {
    const profilePath = resolveIsolatedCodexProfilePath(this.#options.libraryPath);
    const codexHomePath = resolveIsolatedCodexHomePath(this.#options.libraryPath);
    const launcherPath = await installIsolatedCodexLauncher({
      executablePath: this.#options.executablePath,
      profilePath,
      codexHomePath,
    });
    return {
      ...await openIsolatedCodexInstance({
        executablePath: this.#options.executablePath,
        profilePath,
        codexHomePath,
      }),
      launcherPath,
    };
  }

  async openConfigured(options: OpenConfiguredIsolatedCodexOptions): Promise<OpenConfiguredIsolatedCodexResult> {
    if (!Array.isArray(options.selectedItemIds) || options.selectedItemIds.length > 128 || new Set(options.selectedItemIds).size !== options.selectedItemIds.length) {
      throw new ExperienceKitError("isolated-workflow/selection", "Configured instance selection is invalid");
    }
    const conversationIds = options.selectedConversationThreadIds ?? [];
    if (!Array.isArray(conversationIds) || conversationIds.length > 10_000 || new Set(conversationIds).size !== conversationIds.length) {
      throw new ExperienceKitError("isolated-workflow/conversations", "Conversation selection is invalid");
    }
    const conversations = options.selectedItemIds.includes("conversations");
    if (conversations && conversationIds.length === 0) {
      throw new ExperienceKitError("isolated-workflow/conversations", "At least one conversation must be selected");
    }
    if (!conversations && conversationIds.length > 0) {
      throw new ExperienceKitError("isolated-workflow/conversations", "Conversation ids were provided without selecting conversations");
    }
    if (conversations && !await (this.#options.confirmConversationTransfer ?? defaultConversationConfirmation)(conversationIds.length)) {
      return { status: "cancelled" };
    }

    const profilePath = resolveIsolatedCodexProfilePath(this.#options.libraryPath);
    const codexHomePath = resolveIsolatedCodexHomePath(this.#options.libraryPath);
    await stopIsolatedCodexInstance(this.#options.executablePath, profilePath);
    let relaunched = false;
    try {
      if (conversations && !await fs.access(path.join(codexHomePath, "state_5.sqlite")).then(() => true, () => false)) {
        await this.open();
        try { await waitForStateDatabase(codexHomePath); }
        finally { await stopIsolatedCodexInstance(this.#options.executablePath, profilePath); }
      }
      const transfer = await transferCodexInstanceData({
        sourceCodexHome: sourceCodexHome(this.#options),
        destinationCodexHome: codexHomePath,
        selectedItemIds: options.selectedItemIds,
        ...(conversationIds.length > 0 ? { selectedConversationThreadIds: conversationIds } : {}),
      });
      const instance = await this.open();
      relaunched = true;
      return { status: "ok", transfer, instance };
    } finally {
      if (!relaunched) await this.open().catch(() => undefined);
    }
  }
}
