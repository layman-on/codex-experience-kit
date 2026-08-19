import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs, { constants as fsConstants } from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { ExperienceKitError } from "../core/errors.js";
import { discoverCodexConversationGroups, syncCodexConversations, type CodexConversationCatalogGroup, type CodexConversationSyncResult } from "./codex-conversation-sync.js";

const execFileAsync = promisify(execFile);
const SQLITE = "/usr/bin/sqlite3";

export type CodexTransferCategory = "configuration" | "conversations" | "other";

export interface CodexTransferCatalogItem {
  id: string;
  label: string;
  category: CodexTransferCategory;
  paths: string[];
  sizeBytes: number;
  defaultSelected: boolean;
  description: string;
}

export interface CodexTransferCatalog {
  sourceCodexHome: string;
  destinationCodexHome: string;
  items: CodexTransferCatalogItem[];
  conversationGroups: CodexConversationCatalogGroup[];
  excludedPaths: Array<{ path: string; reason: string }>;
}

export interface TransferCodexInstanceDataOptions {
  sourceCodexHome: string;
  destinationCodexHome: string;
  selectedItemIds: string[];
  selectedConversationThreadIds?: string[];
}

export interface TransferCodexInstanceDataResult {
  selectedItemIds: string[];
  copiedPathCount: number;
  copiedBytes: number;
  backupDirectory: string | null;
  conversations: CodexConversationSyncResult | null;
}

const CONFIGURATION_ITEMS: Array<Omit<CodexTransferCatalogItem, "paths" | "sizeBytes"> & { names: string[] }> = [
  { id: "config", label: "Codex 与 MCP 配置", category: "configuration", names: ["config.toml"], defaultSelected: true, description: "MCP 服务、插件注册、功能开关、项目与桌面设置。" },
  { id: "workspaces", label: "工作区与项目列表", category: "configuration", names: [".codex-global-state.json"], defaultSelected: true, description: "仅合并本机项目、工作区与侧栏偏好；账号、推送、对话草稿等状态不复制。" },
  { id: "skills", label: "Skills", category: "configuration", names: ["skills"], defaultSelected: true, description: "用户及团队安装的 Skills。" },
  { id: "plugins", label: "Plugins", category: "configuration", names: ["plugins", "vendor_imports"], defaultSelected: true, description: "插件清单、缓存包与插件提供的能力。" },
  { id: "rules", label: "规则与全局说明", category: "configuration", names: ["AGENTS.md", "rules"], defaultSelected: true, description: "全局 AGENTS.md 和命令规则。" },
  { id: "hooks", label: "Hooks", category: "configuration", names: ["hooks", "hooks.json"], defaultSelected: true, description: "Hook 脚本与 Hook 配置。" },
  { id: "mcp-files", label: "MCP 本地文件", category: "configuration", names: ["mcp"], defaultSelected: true, description: "MCP 使用的本地脚本；OAuth 与运行锁不复制。" },
  { id: "automations", label: "自动化", category: "configuration", names: ["automations"], defaultSelected: true, description: "自动化定义及其持久说明。" },
  { id: "memories", label: "Memories", category: "configuration", names: ["memories", "memories_1.sqlite"], defaultSelected: true, description: "跨会话保存的长期上下文。" },
  { id: "pets", label: "Pets", category: "configuration", names: ["pets"], defaultSelected: true, description: "已安装的 Pet 资源与配置。" },
];

const CONVERSATION_NAMES = ["sessions", "archived_sessions", "attachments", "shell_snapshots", "generated_images", "state_5.sqlite"];
const EXCLUDED = new Map<string, string>([
  ["auth.json", "Codex 账号凭据必须由第二账号独立登录"],
  ["installation_id", "安装身份不可克隆"],
  ["ipc", "正在运行的 IPC"],
  ["thread-writer-locks", "正在写入的会话锁"],
  ["process_manager", "正在运行的进程状态"],
  ["mcp-oauth-locks", "MCP OAuth 运行锁；第二实例按需重新授权"],
  ["browser", "浏览器会话可能包含账号凭据，必须由第二实例独立建立"],
  ["worktrees", "工作树属于当前运行实例，不能克隆"],
  ["goals_1.sqlite", "运行中的目标状态不能克隆"],
  ["logs_2.sqlite", "诊断日志"], ["logs_2.sqlite-shm", "诊断日志运行文件"], ["logs_2.sqlite-wal", "诊断日志运行文件"],
  ["state_5.sqlite-shm", "会话数据库运行文件"], ["state_5.sqlite-wal", "会话数据库运行文件"],
  ["goals_1.sqlite-shm", "运行中的目标数据库文件"], ["goals_1.sqlite-wal", "运行中的目标数据库文件"],
  ["memories_1.sqlite-shm", "运行中的 Memory 数据库文件"], ["memories_1.sqlite-wal", "运行中的 Memory 数据库文件"],
  ["tmp", "临时文件"], [".tmp", "临时文件"], ["cache", "可重建缓存"], ["models_cache.json", "可重建模型缓存"],
  ["computer-use", "第二实例会独立安装其运行组件"], ["node_repl", "正在运行的 REPL 数据"], ["sqlite", "内部数据库运行支持文件"],
  ["conversation-sync-backups", "Kit 自动生成的恢复快照"], ["instance-transfer-backups", "Kit 自动生成的配置恢复快照"],
]);

function assertAbsolute(value: string, label: string): void {
  if (!path.isAbsolute(value)) throw new ExperienceKitError("instance-transfer/path", `${label} must be absolute`);
}

async function existingPaths(home: string, names: string[]): Promise<string[]> {
  const results = await Promise.all(names.map(async (name) => {
    const target = path.join(home, name);
    return fs.lstat(target).then(() => target, () => null);
  }));
  return results.filter((value): value is string => value !== null);
}

async function pathSize(target: string): Promise<number> {
  const stat = await fs.lstat(target);
  if (!stat.isDirectory()) return stat.size;
  let total = 0;
  const entries = await fs.readdir(target, { withFileTypes: true }) as Dirent<string>[];
  for (const entry of entries) total += await pathSize(path.join(target, entry.name));
  return total;
}

async function pathsSize(paths: string[]): Promise<number> {
  const sizes = await Promise.all(paths.map(pathSize));
  return sizes.reduce((sum, size) => sum + size, 0);
}

function knownNames(): Set<string> {
  return new Set([...CONFIGURATION_ITEMS.flatMap((item) => item.names), ...CONVERSATION_NAMES, ...EXCLUDED.keys()]);
}

export async function discoverCodexTransferCatalog(sourceCodexHome: string, destinationCodexHome: string): Promise<CodexTransferCatalog> {
  assertAbsolute(sourceCodexHome, "Source CODEX_HOME");
  assertAbsolute(destinationCodexHome, "Destination CODEX_HOME");
  const [sourceHome, destinationHome] = await Promise.all([
    fs.realpath(sourceCodexHome),
    fs.realpath(destinationCodexHome).catch(async () => { await fs.mkdir(destinationCodexHome, { recursive: true, mode: 0o700 }); return fs.realpath(destinationCodexHome); }),
  ]);
  if (sourceHome === destinationHome) throw new ExperienceKitError("instance-transfer/same-home", "Source and destination CODEX_HOME must be different");
  const items: CodexTransferCatalogItem[] = [];
  for (const definition of CONFIGURATION_ITEMS) {
    const paths = await existingPaths(sourceHome, definition.names);
    if (paths.length === 0) continue;
    items.push({ ...definition, paths, sizeBytes: await pathsSize(paths) });
  }
  const conversationPaths = await existingPaths(sourceHome, CONVERSATION_NAMES);
  const conversationGroups = conversationPaths.some((value) => path.basename(value) === "state_5.sqlite")
    ? await discoverCodexConversationGroups(sourceHome)
    : [];
  if (conversationPaths.length > 0) items.push({
    id: "conversations", label: "会话记录与附件", category: "conversations", paths: conversationPaths,
    sizeBytes: await pathsSize(conversationPaths), defaultSelected: false,
    description: "复制到最后一个完整落盘事件；不迁移正在生成的回复、授权等待或终端进程。",
  });
  const entries = await fs.readdir(sourceHome, { withFileTypes: true }) as Dirent<string>[];
  const recognized = knownNames();
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (recognized.has(entry.name)) continue;
    const target = path.join(sourceHome, entry.name);
    items.push({
      id: `other:${Buffer.from(entry.name).toString("base64url")}`,
      label: entry.name,
      category: "other",
      paths: [target],
      sizeBytes: await pathSize(target),
      defaultSelected: false,
      description: "当前 Kit 尚未识别的新数据路径，请根据用途自行选择。",
    });
  }
  const excludedPaths = [...EXCLUDED].flatMap(([name, reason]) => {
    const target = path.join(sourceHome, name);
    return entries.some((entry) => entry.name === name) ? [{ path: target, reason }] : [];
  });
  return { sourceCodexHome: sourceHome, destinationCodexHome: destinationHome, items, conversationGroups, excludedPaths };
}

async function copyFileWithClone(source: string, destination: string): Promise<void> {
  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.codex-transfer-${process.pid}-${Date.now()}`;
  await fs.copyFile(source, temporary, fsConstants.COPYFILE_FICLONE).catch(async (error) => {
    if (!(["ENOTSUP", "EINVAL"] as Array<string | undefined>).includes((error as NodeJS.ErrnoException).code)) throw error;
    await fs.copyFile(source, temporary);
  });
  await fs.rename(temporary, destination);
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function copySqliteSnapshot(source: string, destination: string): Promise<void> {
  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.codex-transfer-${process.pid}-${Date.now()}-${randomUUID()}`;
  try {
    await execFileAsync(SQLITE, [source, ".timeout 5000", `.backup ${sqlString(temporary)}`], { maxBuffer: 1024 * 1024 });
    await fs.rename(temporary, destination);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

const WORKSPACE_STATE_KEYS = [
  "electron-saved-workspace-roots",
  "active-workspace-roots",
  "project-order",
  "local-projects",
  "selected-project",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

async function copyWorkspaceState(source: string, destination: string): Promise<void> {
  const sourceState = JSON.parse(await fs.readFile(source, "utf8")) as unknown;
  if (!isRecord(sourceState)) throw new ExperienceKitError("instance-transfer/workspaces", "Primary workspace state is invalid");
  const destinationState = await fs.readFile(destination, "utf8")
    .then((value) => JSON.parse(value) as unknown, () => ({}));
  const merged: Record<string, unknown> = isRecord(destinationState) ? { ...destinationState } : {};
  for (const key of WORKSPACE_STATE_KEYS) if (Object.hasOwn(sourceState, key)) merged[key] = structuredClone(sourceState[key]);
  const sourceAtoms = sourceState["electron-persisted-atom-state"];
  const destinationAtoms = merged["electron-persisted-atom-state"];
  if (isRecord(sourceAtoms)) {
    const atoms: Record<string, unknown> = isRecord(destinationAtoms) ? { ...destinationAtoms } : {};
    for (const [key, value] of Object.entries(sourceAtoms)) {
      if (key === "flat-project-sidebar-preferences-v1" || key === "sidebar-project-list-expanded-v1" || key.startsWith("sidebar-project-expanded-v1-")) {
        atoms[key] = structuredClone(value);
      }
    }
    merged["electron-persisted-atom-state"] = atoms;
  }
  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.codex-transfer-${process.pid}-${Date.now()}-${randomUUID()}`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(merged)}\n`, { mode: 0o600 });
    await fs.rename(temporary, destination);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

const THREAD_STATE_MAP_KEYS = [
  "thread-project-assignments",
  "thread-writable-roots",
  "thread-workspace-root-hints",
  "thread-projectless-output-directories",
] as const;

async function mergeSelectedThreadState(sourceHome: string, destinationHome: string, threadIds: string[]): Promise<void> {
  const sourcePath = path.join(sourceHome, ".codex-global-state.json");
  const destinationPath = path.join(destinationHome, ".codex-global-state.json");
  const sourceState = await fs.readFile(sourcePath, "utf8").then((value) => JSON.parse(value) as unknown, () => null);
  if (!isRecord(sourceState)) return;
  const destinationState = await fs.readFile(destinationPath, "utf8").then((value) => JSON.parse(value) as unknown, () => ({}));
  const merged: Record<string, unknown> = isRecord(destinationState) ? { ...destinationState } : {};
  const selected = new Set(threadIds);
  for (const key of THREAD_STATE_MAP_KEYS) {
    const sourceMap = sourceState[key];
    const destinationMap = merged[key];
    if (!isRecord(sourceMap)) continue;
    const next: Record<string, unknown> = isRecord(destinationMap) ? { ...destinationMap } : {};
    for (const threadId of selected) if (Object.hasOwn(sourceMap, threadId)) next[threadId] = structuredClone(sourceMap[threadId]);
    merged[key] = next;
  }
  for (const key of ["projectless-thread-ids", "pinned-thread-ids"] as const) {
    const sourceList = Array.isArray(sourceState[key]) ? sourceState[key].filter((value): value is string => typeof value === "string" && selected.has(value)) : [];
    const destinationList = Array.isArray(merged[key]) ? merged[key].filter((value): value is string => typeof value === "string") : [];
    merged[key] = [...new Set([...destinationList, ...sourceList])];
  }
  const sourceOrders = sourceState["sidebar-project-thread-orders"];
  const destinationOrders = merged["sidebar-project-thread-orders"];
  if (isRecord(sourceOrders)) {
    const orders: Record<string, unknown> = isRecord(destinationOrders) ? { ...destinationOrders } : {};
    for (const [projectId, value] of Object.entries(sourceOrders)) {
      if (!Array.isArray(value)) continue;
      const selectedOrder = value.filter((threadId): threadId is string => typeof threadId === "string" && selected.has(threadId));
      if (selectedOrder.length === 0) continue;
      const destinationOrder = Array.isArray(orders[projectId]) ? (orders[projectId] as unknown[]).filter((threadId): threadId is string => typeof threadId === "string") : [];
      orders[projectId] = [...new Set([...destinationOrder, ...selectedOrder])];
    }
    merged["sidebar-project-thread-orders"] = orders;
  }
  const temporary = `${destinationPath}.codex-transfer-${process.pid}-${Date.now()}-${randomUUID()}`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(merged)}\n`, { mode: 0o600 });
    await fs.rename(temporary, destinationPath);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function copySelectedPath(sourceHome: string, destinationHome: string, source: string, sourceAliases: string[] = [sourceHome], transform = true): Promise<{ paths: number; bytes: number }> {
  const relative = path.relative(sourceHome, source);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new ExperienceKitError("instance-transfer/path", "Transfer path escaped CODEX_HOME");
  const destination = path.join(destinationHome, relative);
  const stat = await fs.lstat(source);
  if (stat.isSymbolicLink()) {
    await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await fs.unlink(destination).catch(() => undefined);
    await fs.symlink(await fs.readlink(source), destination);
    return { paths: 1, bytes: stat.size };
  }
  if (stat.isDirectory()) {
    await fs.mkdir(destination, { recursive: true, mode: 0o700 });
    let paths = 0;
    let bytes = 0;
    const entries = await fs.readdir(source, { withFileTypes: true }) as Dirent<string>[];
    for (const entry of entries) {
      const result = await copySelectedPath(sourceHome, destinationHome, path.join(source, entry.name), sourceAliases, transform);
      paths += result.paths; bytes += result.bytes;
    }
    return { paths, bytes };
  }
  if (!stat.isFile()) return { paths: 0, bytes: 0 };
  if (transform && (relative === "config.toml" || relative === "hooks.json")) {
    const contents = await fs.readFile(source, "utf8");
    const rewritten = [...new Set(sourceAliases)].reduce((value, alias) => value.replaceAll(alias, destinationHome), contents);
    await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await fs.writeFile(destination, rewritten, { mode: 0o600 });
  } else if (transform && relative === ".codex-global-state.json") {
    await copyWorkspaceState(source, destination);
  } else if (relative.endsWith(".sqlite")) {
    await copySqliteSnapshot(source, destination);
  } else {
    await copyFileWithClone(source, destination);
  }
  return { paths: 1, bytes: stat.size };
}

async function backupSelectedDestinations(destinationHome: string, selected: CodexTransferCatalogItem[]): Promise<string | null> {
  const existing: string[] = [];
  for (const item of selected.filter((value) => value.id !== "conversations")) {
    for (const source of item.paths) {
      const name = path.basename(source);
      const destination = path.join(destinationHome, name);
      if (await fs.lstat(destination).then(() => true, () => false)) existing.push(destination);
    }
  }
  if (existing.length === 0) return null;
  const backupDirectory = path.join(destinationHome, "instance-transfer-backups", `${Date.now()}-${randomUUID()}`);
  await fs.mkdir(backupDirectory, { recursive: true, mode: 0o700 });
  for (const destination of existing) await copySelectedPath(destinationHome, backupDirectory, destination, [destinationHome], false);
  return backupDirectory;
}

export async function transferCodexInstanceData(options: TransferCodexInstanceDataOptions): Promise<TransferCodexInstanceDataResult> {
  const catalog = await discoverCodexTransferCatalog(options.sourceCodexHome, options.destinationCodexHome);
  if (!Array.isArray(options.selectedItemIds) || options.selectedItemIds.length > catalog.items.length || new Set(options.selectedItemIds).size !== options.selectedItemIds.length) {
    throw new ExperienceKitError("instance-transfer/selection", "Codex transfer selection is invalid");
  }
  const byId = new Map(catalog.items.map((item) => [item.id, item]));
  const selected = options.selectedItemIds.map((id) => {
    const item = byId.get(id);
    if (!item) throw new ExperienceKitError("instance-transfer/selection", `Unknown Codex transfer item: ${id}`);
    return item;
  });
  const conversationsSelected = selected.some((item) => item.id === "conversations");
  if (!conversationsSelected && options.selectedConversationThreadIds?.length) {
    throw new ExperienceKitError("instance-transfer/selection", "Conversation ids were provided without selecting conversations");
  }
  const configurationBackupDirectory = await backupSelectedDestinations(catalog.destinationCodexHome, selected);
  let copiedPathCount = 0;
  let copiedBytes = 0;
  const sourceAliases = [path.resolve(options.sourceCodexHome), catalog.sourceCodexHome];
  for (const item of selected.filter((value) => value.id !== "conversations")) {
    for (const source of item.paths) {
      const result = await copySelectedPath(catalog.sourceCodexHome, catalog.destinationCodexHome, source, sourceAliases);
      copiedPathCount += result.paths; copiedBytes += result.bytes;
    }
  }
  const conversations = conversationsSelected
    ? await syncCodexConversations({
        sourceCodexHome: catalog.sourceCodexHome,
        destinationCodexHome: catalog.destinationCodexHome,
        ...(options.selectedConversationThreadIds ? { threadIds: options.selectedConversationThreadIds } : {}),
      })
    : null;
  if (conversations && options.selectedConversationThreadIds) {
    await mergeSelectedThreadState(catalog.sourceCodexHome, catalog.destinationCodexHome, options.selectedConversationThreadIds);
  }
  return {
    selectedItemIds: selected.map((item) => item.id),
    copiedPathCount,
    copiedBytes,
    backupDirectory: conversations?.destinationBackupPath ? path.dirname(conversations.destinationBackupPath) : configurationBackupDirectory,
    conversations,
  };
}
