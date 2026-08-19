import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { promisify } from "node:util";
import { CdpClient, type CdpEvent } from "./cdp-client.js";
import { syncCodexConversations } from "./codex-conversation-sync.js";
import { stopIsolatedCodexInstance } from "./isolated-codex-instance.js";
import { IsolatedCodexWorkflow } from "./isolated-codex-workflow.js";

interface BrokerConfiguration {
  instanceId: string;
  libraryPath: string;
  bindingName: string;
  profilePath: string;
  codexHomePath: string;
  webSocketUrl: string;
  codexExecutablePath: string;
  sourceCodexHome: string;
  statePath: string;
  configPath: string;
}

interface BindingPayload {
  action?: unknown;
  slot?: unknown;
  requestId?: unknown;
  channel?: unknown;
  selectedItemIds?: unknown;
  selectedConversationThreadIds?: unknown;
}

const execFileAsync = promisify(execFile);

async function confirmConversationSync(selectedCount?: number): Promise<boolean> {
  const scope = selectedCount ? `已选择的 ${selectedCount} 个` : "尚未导入的本地";
  const message = `将主账号中${scope}对话快照复制到第二账号。不会复制登录凭据；主账号任务继续运行，但第二账号 Codex 会短暂重启。`;
  const escaped = message.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  const script = `display dialog "${escaped}" with title "Codex Experience Kit" buttons {"取消", "同步"} default button "同步" cancel button "取消" with icon caution`;
  try {
    await execFileAsync("/usr/bin/osascript", ["-e", script], { timeout: 120_000, maxBuffer: 1024 * 1024 });
    return true;
  } catch {
    return false;
  }
}

async function notifyConversationSync(message: string): Promise<void> {
  const escaped = message.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  await execFileAsync("/usr/bin/osascript", ["-e", `display notification "${escaped}" with title "Codex Experience Kit"`], { timeout: 10_000, maxBuffer: 1024 * 1024 }).catch(() => undefined);
}

async function notifyConfiguredLaunch(selectedCount: number, copiedBytes: number, conversations: boolean): Promise<void> {
  const megabytes = copiedBytes / (1024 * 1024);
  const size = megabytes >= 10 ? `${megabytes.toFixed(1)} MB` : `${megabytes.toFixed(2)} MB`;
  await notifyConversationSync(`第二账号已打开：迁移 ${selectedCount} 项配置（${size}）${conversations ? "，包含会话快照" : "，未迁移会话"}。`);
}

function validOpaqueId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,160}$/u.test(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function main(): Promise<void> {
  const configPath = process.argv[2];
  if (!configPath) throw new Error("Native action broker configuration is missing");
  const configuration = JSON.parse(await fs.readFile(configPath, "utf8")) as BrokerConfiguration;
  const client = new CdpClient(configuration.webSocketUrl, { requestTimeoutMs: 5_000 });
  const resultEventName = `${configuration.bindingName}Result`;
  const sendResult = async (payload: BindingPayload, status: "ok" | "cancelled" | "error", value?: unknown): Promise<void> => {
    if (!validOpaqueId(payload.requestId) || !validOpaqueId(payload.channel) || typeof payload.action !== "string") return;
    const detail = { requestId: payload.requestId, channel: payload.channel, action: payload.action, status, ...(status === "error" ? { error: errorMessage(value) } : { result: value ?? null }) };
    await client.call("Runtime.evaluate", {
      expression: `globalThis.dispatchEvent(new CustomEvent(${JSON.stringify(resultEventName)},{detail:${JSON.stringify(detail)}}))`,
      returnByValue: true,
    }).catch(() => undefined);
  };
  const workflow = new IsolatedCodexWorkflow({
    libraryPath: configuration.libraryPath,
    executablePath: configuration.codexExecutablePath,
    sourceCodexHome: configuration.sourceCodexHome,
    confirmConversationTransfer: confirmConversationSync,
  });
  const launchSecondary = () => workflow.open();
  let launchOperation = Promise.resolve();
  const handleBinding = (event: CdpEvent): void => {
    if (event.params.name !== configuration.bindingName || typeof event.params.payload !== "string") return;
    let payload: BindingPayload;
    try { payload = JSON.parse(event.params.payload) as BindingPayload; } catch { return; }
    const supported = new Set([
      "codex.instance.open-isolated",
      "codex.instance.sync-conversations",
      "codex.instance.transfer-catalog",
      "codex.instance.open-configured",
    ]);
    if (payload.slot !== "secondary" || typeof payload.action !== "string" || !supported.has(payload.action)) return;
    launchOperation = launchOperation
      .catch(() => undefined)
      .then(async () => {
        if (payload.action === "codex.instance.transfer-catalog") {
          try {
            const catalog = await workflow.catalog();
            await sendResult(payload, "ok", catalog);
          } catch (error) {
            await sendResult(payload, "error", error);
          }
          return;
        }
        if (payload.action === "codex.instance.open-configured") {
          try {
            if (!Array.isArray(payload.selectedItemIds) || !payload.selectedItemIds.every((value) => typeof value === "string")) {
              throw new Error("Configured instance selection is invalid");
            }
            const selectedItemIds = payload.selectedItemIds as string[];
            const selectedConversationThreadIds = payload.selectedConversationThreadIds;
            if (selectedItemIds.includes("conversations") && (!Array.isArray(selectedConversationThreadIds) || selectedConversationThreadIds.length === 0 || !selectedConversationThreadIds.every((value) => typeof value === "string"))) {
              throw new Error("At least one conversation must be selected");
            }
            const outcome = await workflow.openConfigured({
              selectedItemIds,
              ...(Array.isArray(selectedConversationThreadIds) ? { selectedConversationThreadIds: selectedConversationThreadIds as string[] } : {}),
            });
            if (outcome.status === "cancelled") {
              await sendResult(payload, "cancelled");
              return;
            }
            await notifyConfiguredLaunch(outcome.transfer.selectedItemIds.length, outcome.transfer.copiedBytes, outcome.transfer.conversations !== null);
            await sendResult(payload, "ok", outcome.transfer);
          } catch (error) {
            await sendResult(payload, "error", error);
          }
          return;
        }
        if (payload.action === "codex.instance.sync-conversations") {
          if (!await confirmConversationSync()) return;
          await stopIsolatedCodexInstance(configuration.codexExecutablePath, configuration.profilePath);
          try {
            const result = await syncCodexConversations({
              sourceCodexHome: configuration.sourceCodexHome,
              destinationCodexHome: configuration.codexHomePath,
            });
            await notifyConversationSync(`对话快照同步完成：新增 ${result.importedThreadCount} 个会话。`);
          } catch (error) {
            await notifyConversationSync("对话快照同步失败；主账号数据未修改，第二账号将重新打开。");
            throw error;
          } finally {
            await launchSecondary();
          }
          return;
        }
        const result = await launchSecondary();
        await sendResult(payload, "ok", { opened: true, reused: result.reused });
      })
      .then(() => undefined)
      .catch(() => undefined);
  };
  const stopBinding = client.on("Runtime.bindingCalled", handleBinding);
  await client.call("Runtime.enable");
  await client.call("Runtime.addBinding", { name: configuration.bindingName });
  await fs.writeFile(configuration.statePath, `${JSON.stringify({
    version: 1,
    instanceId: configuration.instanceId,
    bindingName: configuration.bindingName,
    pid: process.pid,
    profilePath: configuration.profilePath,
    codexHomePath: configuration.codexHomePath,
    configPath: configuration.configPath,
    ready: true,
    startedAt: new Date().toISOString(),
  }, null, 2)}\n`, { mode: 0o600 });

  const close = async (): Promise<void> => {
    stopBinding();
    await client.close().catch(() => undefined);
    const state = await fs.readFile(configuration.statePath, "utf8").then((value) => JSON.parse(value) as { instanceId?: string }, () => null);
    if (state?.instanceId === configuration.instanceId) await fs.unlink(configuration.statePath).catch(() => undefined);
    await fs.unlink(configuration.configPath).catch(() => undefined);
  };
  process.once("SIGTERM", () => { void close().finally(() => process.exit(0)); });
  process.once("SIGINT", () => { void close().finally(() => process.exit(0)); });
  await new Promise<void>((resolve) => process.once("beforeExit", resolve));
}

void main().catch(() => process.exit(1));
