import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs, { constants as fsConstants } from "node:fs/promises";
import type { Dirent } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { ExperienceKitError } from "../core/errors.js";

const execFileAsync = promisify(execFile);
const SQLITE = "/usr/bin/sqlite3";
const STATE_DATABASE = "state_5.sqlite";
const CONVERSATION_DIRECTORIES = [
  "sessions",
  "archived_sessions",
  "attachments",
  "shell_snapshots",
  "generated_images",
] as const;
const THREAD_TABLES = ["thread_sections", "threads", "thread_dynamic_tools", "thread_spawn_edges"] as const;

export interface CodexConversationSyncOptions {
  sourceCodexHome: string;
  destinationCodexHome: string;
  threadIds?: string[];
}

export interface CodexConversationCatalogThread {
  threadId: string;
  title: string;
  updatedAt: number;
  archived: boolean;
  sizeBytes: number;
}

export interface CodexConversationCatalogGroup {
  groupId: string;
  label: string;
  sizeBytes: number;
  threads: CodexConversationCatalogThread[];
}

export interface CodexConversationSyncResult {
  sourceThreadCount: number;
  destinationThreadCountBefore: number;
  destinationThreadCountAfter: number;
  importedThreadCount: number;
  copiedFileCount: number;
  skippedFileCount: number;
  trimmedLiveJsonlCount: number;
  destinationBackupPath: string;
}

interface CopyStats {
  copiedFileCount: number;
  skippedFileCount: number;
  trimmedLiveJsonlCount: number;
}

function assertHome(value: string, label: string): void {
  if (!path.isAbsolute(value)) throw new ExperienceKitError("conversation-sync/path", `${label} must be absolute`);
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function sqlIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value)) throw new ExperienceKitError("conversation-sync/schema", `Unsafe SQLite identifier: ${value}`);
  return `"${value}"`;
}

async function sqlite(databasePath: string, statement: string): Promise<string> {
  const { stdout } = await execFileAsync(SQLITE, [databasePath, statement], { maxBuffer: 8 * 1024 * 1024 });
  return stdout.trim();
}

async function sqliteBackup(databasePath: string, backupPath: string): Promise<void> {
  await execFileAsync(SQLITE, [databasePath, ".timeout 5000", `.backup ${sqlString(backupPath)}`], { maxBuffer: 1024 * 1024 });
}

async function threadCount(databasePath: string, threadIds?: string[]): Promise<number> {
  const filter = threadIds ? ` WHERE id IN (${threadIds.map(sqlString).join(",")})` : "";
  const result = Number(await sqlite(databasePath, `SELECT COUNT(*) FROM threads${filter};`));
  if (!Number.isSafeInteger(result) || result < 0) throw new ExperienceKitError("conversation-sync/database", "Codex thread count is invalid");
  return result;
}

async function sqliteJson<T>(databasePath: string, statement: string): Promise<T[]> {
  const { stdout } = await execFileAsync(SQLITE, ["-json", databasePath, statement], { maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim() ? JSON.parse(stdout) as T[] : [];
}

function normalizedThreadIds(value: string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > 10_000 || value.some((id) => typeof id !== "string" || !/^[A-Za-z0-9._:-]{1,200}$/u.test(id))) {
    throw new ExperienceKitError("conversation-sync/selection", "Conversation thread selection is invalid");
  }
  return [...new Set(value)];
}

async function tableColumns(databasePath: string, table: string): Promise<string[]> {
  const rows = await sqlite(databasePath, `SELECT name FROM pragma_table_info(${sqlString(table)}) ORDER BY cid;`);
  return rows ? rows.split("\n").filter(Boolean) : [];
}

async function lastNewlineOffset(filePath: string, size: number): Promise<number> {
  const handle = await fs.open(filePath, "r");
  try {
    const chunkSize = 64 * 1024;
    let cursor = size;
    while (cursor > 0) {
      const length = Math.min(chunkSize, cursor);
      cursor -= length;
      const buffer = Buffer.allocUnsafe(length);
      await handle.read(buffer, 0, length, cursor);
      const offset = buffer.lastIndexOf(0x0a);
      if (offset >= 0) return cursor + offset + 1;
    }
    return 0;
  } finally {
    await handle.close();
  }
}

async function trimIncompleteJsonlTail(filePath: string): Promise<boolean> {
  const stat = await fs.stat(filePath);
  if (stat.size === 0) return false;
  const handle = await fs.open(filePath, "r");
  let finalByte = 0;
  try {
    const buffer = Buffer.allocUnsafe(1);
    await handle.read(buffer, 0, 1, stat.size - 1);
    finalByte = buffer[0] ?? 0;
  } finally {
    await handle.close();
  }
  if (finalByte === 0x0a) return false;
  const completeSize = await lastNewlineOffset(filePath, stat.size);
  if (completeSize === 0) throw new ExperienceKitError("conversation-sync/live-jsonl", `Conversation snapshot has no complete JSONL record: ${filePath}`);
  await fs.truncate(filePath, completeSize);
  return true;
}

async function copyFileSnapshot(sourcePath: string, destinationPath: string, trimJsonl: boolean): Promise<"copied" | "skipped" | "trimmed"> {
  await fs.mkdir(path.dirname(destinationPath), { recursive: true, mode: 0o700 });
  try {
    await fs.copyFile(sourcePath, destinationPath, fsConstants.COPYFILE_EXCL | fsConstants.COPYFILE_FICLONE);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return "skipped";
    if (code !== "ENOTSUP" && code !== "EINVAL") throw error;
    try {
      await fs.copyFile(sourcePath, destinationPath, fsConstants.COPYFILE_EXCL);
    } catch (fallbackError) {
      if ((fallbackError as NodeJS.ErrnoException).code === "EEXIST") return "skipped";
      throw fallbackError;
    }
  }
  await fs.chmod(destinationPath, 0o600).catch(() => undefined);
  if (trimJsonl && await trimIncompleteJsonlTail(destinationPath)) return "trimmed";
  return "copied";
}

async function copyTree(sourceRoot: string, destinationRoot: string, trimJsonl: boolean, stats: CopyStats): Promise<void> {
  let entries: Dirent<string>[];
  try {
    entries = await fs.readdir(sourceRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    const sourcePath = path.join(sourceRoot, entry.name);
    const destinationPath = path.join(destinationRoot, entry.name);
    if (entry.isDirectory()) {
      await copyTree(sourcePath, destinationPath, trimJsonl, stats);
      continue;
    }
    if (!entry.isFile()) continue;
    const result = await copyFileSnapshot(sourcePath, destinationPath, trimJsonl && entry.name.endsWith(".jsonl"));
    if (result === "skipped") stats.skippedFileCount += 1;
    else stats.copiedFileCount += 1;
    if (result === "trimmed") stats.trimmedLiveJsonlCount += 1;
  }
}

async function treeSize(target: string): Promise<number> {
  const stat = await fs.lstat(target).catch(() => null);
  if (!stat) return 0;
  if (!stat.isDirectory()) return stat.size;
  const entries = await fs.readdir(target, { withFileTypes: true });
  let size = 0;
  for (const entry of entries) size += await treeSize(path.join(target, entry.name));
  return size;
}

interface ConversationCatalogRow {
  id: string;
  rollout_path: string;
  title: string;
  name?: string | null;
  updated_at: number;
  updated_at_ms?: number | null;
  archived: number;
  cwd?: string | null;
  thread_section_id?: string | null;
  section_name?: string | null;
}

interface ProjectAssignment { projectId?: unknown }
interface LocalProject { name?: unknown; rootPaths?: unknown }

export async function discoverCodexConversationGroups(sourceCodexHome: string): Promise<CodexConversationCatalogGroup[]> {
  assertHome(sourceCodexHome, "Source CODEX_HOME");
  const sourceHome = await fs.realpath(sourceCodexHome);
  const database = path.join(sourceHome, STATE_DATABASE);
  const rows = await sqliteJson<ConversationCatalogRow>(database, `
    SELECT t.id,t.rollout_path,t.title,t.name,t.updated_at,t.updated_at_ms,t.archived,t.cwd,t.thread_section_id,s.name AS section_name
    FROM threads t LEFT JOIN thread_sections s ON s.id=t.thread_section_id
    ORDER BY COALESCE(NULLIF(t.updated_at_ms,0),t.updated_at*1000) DESC;
  `);
  const globalState: Record<string, unknown> = await fs.readFile(path.join(sourceHome, ".codex-global-state.json"), "utf8")
    .then((value) => JSON.parse(value) as Record<string, unknown>, () => ({} as Record<string, unknown>));
  const assignments = globalState["thread-project-assignments"] as Record<string, ProjectAssignment> | undefined;
  const projects = globalState["local-projects"] as Record<string, LocalProject> | undefined;
  const threadIds = new Set(rows.map((row) => row.id));
  const shellSizes = new Map<string, number>();
  const shellDirectory = path.join(sourceHome, "shell_snapshots");
  for (const entry of await fs.readdir(shellDirectory, { withFileTypes: true }).catch(() => [] as Dirent<string>[])) {
    if (!entry.isFile()) continue;
    const threadId = entry.name.split(".", 1)[0];
    if (!threadId || !threadIds.has(threadId)) continue;
    const size = await fs.stat(path.join(shellDirectory, entry.name)).then((value) => value.size, () => 0);
    shellSizes.set(threadId, (shellSizes.get(threadId) ?? 0) + size);
  }
  const groups = new Map<string, CodexConversationCatalogGroup>();
  for (const row of rows) {
    let rolloutPath: string;
    try {
      rolloutPath = rebasedConversationPath(row.rollout_path, [path.resolve(sourceCodexHome), sourceHome], sourceHome, sourceHome).source;
      await fs.access(rolloutPath);
    } catch {
      continue;
    }
    const assignment = assignments?.[row.id];
    let projectId = typeof assignment?.projectId === "string" ? assignment.projectId : null;
    if (!projectId && row.cwd && projects) {
      let longestRoot = -1;
      for (const [candidateId, project] of Object.entries(projects)) {
        if (!Array.isArray(project.rootPaths)) continue;
        for (const root of project.rootPaths) {
          if (typeof root !== "string" || (row.cwd !== root && !row.cwd.startsWith(`${root}${path.sep}`)) || root.length <= longestRoot) continue;
          projectId = candidateId;
          longestRoot = root.length;
        }
      }
    }
    const projectName = projectId && typeof projects?.[projectId]?.name === "string" ? projects[projectId]!.name as string : null;
    const workspace = !projectId && row.cwd?.trim() ? row.cwd.trim() : null;
    const groupId = projectId ? `project:${projectId}` : workspace ? `workspace:${Buffer.from(workspace).toString("base64url")}` : row.thread_section_id ? `section:${row.thread_section_id}` : "ungrouped";
    const label = projectName || (workspace ? `工作区 · ${path.basename(workspace) || workspace}` : null) || row.section_name?.trim() || "未分组会话";
    let group = groups.get(groupId);
    if (!group) {
      group = { groupId, label, sizeBytes: 0, threads: [] };
      groups.set(groupId, group);
    }
    const rolloutSize = await fs.stat(rolloutPath).then((value) => value.size, () => 0);
    const imageSize = await treeSize(path.join(sourceHome, "generated_images", row.id));
    const sizeBytes = rolloutSize + imageSize + (shellSizes.get(row.id) ?? 0);
    const updatedAt = row.updated_at_ms && row.updated_at_ms > 0 ? row.updated_at_ms : row.updated_at * 1000;
    group.threads.push({
      threadId: row.id,
      title: row.name?.trim() || row.title?.trim() || `会话 ${row.id.slice(-8)}`,
      updatedAt,
      archived: row.archived === 1,
      sizeBytes,
    });
    group.sizeBytes += sizeBytes;
  }
  return [...groups.values()].sort((left, right) => {
    const leftUpdated = left.threads[0]?.updatedAt ?? 0;
    const rightUpdated = right.threads[0]?.updatedAt ?? 0;
    return rightUpdated - leftUpdated || left.label.localeCompare(right.label);
  });
}

async function buildMergeSql(sourceSnapshot: string, sourceHomes: string[], destinationHome: string, destinationDatabase: string, threadIds?: string[]): Promise<string> {
  const statements = [`ATTACH DATABASE ${sqlString(sourceSnapshot)} AS source_snapshot;`, "BEGIN IMMEDIATE;"];
  const selected = threadIds ? `(${threadIds.map(sqlString).join(",")})` : null;
  for (const table of THREAD_TABLES) {
    const [sourceColumns, destinationColumns] = await Promise.all([
      tableColumns(sourceSnapshot, table),
      tableColumns(destinationDatabase, table),
    ]);
    const destinationSet = new Set(destinationColumns);
    const common = sourceColumns.filter((column) => destinationSet.has(column));
    if (common.length === 0) continue;
    const columns = common.map(sqlIdentifier).join(",");
    const values = common.map((column) => {
      const sourceColumn = `source_snapshot.${sqlIdentifier(table)}.${sqlIdentifier(column)}`;
      if (column !== "rollout_path") return sourceColumn;
      const branches = [...new Set(sourceHomes)].map((sourceHome) =>
        `WHEN substr(${sourceColumn},1,${sourceHome.length})=${sqlString(sourceHome)} AND substr(${sourceColumn},${sourceHome.length + 1},1)=${sqlString(path.sep)} THEN ${sqlString(destinationHome)} || substr(${sourceColumn},${sourceHome.length + 1})`).join(" ");
      return `CASE ${branches} ELSE ${sourceColumn} END`;
    }).join(",");
    let filter = "";
    if (table === "thread_sections" && selected) filter = ` WHERE EXISTS (SELECT 1 FROM source_snapshot.threads WHERE source_snapshot.threads.thread_section_id=source_snapshot.thread_sections.id AND source_snapshot.threads.id IN ${selected})`;
    if (table === "threads" && selected) filter = ` WHERE source_snapshot.threads.id IN ${selected}`;
    if (table === "thread_dynamic_tools") filter = ` WHERE ${selected ? `source_snapshot.thread_dynamic_tools.thread_id IN ${selected} AND ` : ""}EXISTS (SELECT 1 FROM main.threads WHERE main.threads.id=source_snapshot.thread_dynamic_tools.thread_id)`;
    if (table === "thread_spawn_edges") filter = ` WHERE ${selected ? `source_snapshot.thread_spawn_edges.parent_thread_id IN ${selected} AND source_snapshot.thread_spawn_edges.child_thread_id IN ${selected} AND ` : ""}EXISTS (SELECT 1 FROM main.threads WHERE main.threads.id=source_snapshot.thread_spawn_edges.parent_thread_id) AND EXISTS (SELECT 1 FROM main.threads WHERE main.threads.id=source_snapshot.thread_spawn_edges.child_thread_id)`;
    statements.push(`INSERT OR IGNORE INTO main.${sqlIdentifier(table)} (${columns}) SELECT ${values} FROM source_snapshot.${sqlIdentifier(table)}${filter};`);
  }
  statements.push("COMMIT;", "DETACH DATABASE source_snapshot;");
  return statements.join("\n");
}

function rebasedConversationPath(sourcePath: string, sourceHomes: string[], sourceHome: string, destinationHome: string): { source: string; destination: string } {
  for (const alias of [...new Set(sourceHomes)]) {
    if (sourcePath === alias || !sourcePath.startsWith(`${alias}${path.sep}`)) continue;
    const relative = path.relative(alias, sourcePath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) break;
    return { source: path.join(sourceHome, relative), destination: path.join(destinationHome, relative) };
  }
  throw new ExperienceKitError("conversation-sync/path", `Conversation rollout path escaped CODEX_HOME: ${sourcePath}`);
}

async function copySelectedConversationFiles(
  sourceSnapshot: string,
  sourceHomes: string[],
  sourceHome: string,
  destinationHome: string,
  threadIds: string[],
  stats: CopyStats,
): Promise<void> {
  const selected = `(${threadIds.map(sqlString).join(",")})`;
  const rows = await sqliteJson<{ id: string; rollout_path: string }>(sourceSnapshot, `SELECT id,rollout_path FROM threads WHERE id IN ${selected};`);
  if (rows.length !== threadIds.length) throw new ExperienceKitError("conversation-sync/selection", "One or more selected conversations no longer exist");
  for (const row of rows) {
    const rollout = rebasedConversationPath(row.rollout_path, sourceHomes, sourceHome, destinationHome);
    const result = await copyFileSnapshot(rollout.source, rollout.destination, true);
    if (result === "skipped") stats.skippedFileCount += 1;
    else stats.copiedFileCount += 1;
    if (result === "trimmed") stats.trimmedLiveJsonlCount += 1;
    await copyTree(path.join(sourceHome, "generated_images", row.id), path.join(destinationHome, "generated_images", row.id), false, stats);
  }
  const selectedSet = new Set(threadIds);
  const shellSource = path.join(sourceHome, "shell_snapshots");
  for (const entry of await fs.readdir(shellSource, { withFileTypes: true }).catch(() => [] as Dirent<string>[])) {
    if (!entry.isFile()) continue;
    const threadId = entry.name.split(".", 1)[0];
    if (!threadId || !selectedSet.has(threadId)) continue;
    const result = await copyFileSnapshot(path.join(shellSource, entry.name), path.join(destinationHome, "shell_snapshots", entry.name), false);
    if (result === "skipped") stats.skippedFileCount += 1; else stats.copiedFileCount += 1;
  }
  // Pasted-text attachments are small and globally indexed rather than keyed
  // by thread. Copying this directory keeps selected transcripts resolvable
  // without bringing over unrelated multi-gigabyte session rollouts.
  await copyTree(path.join(sourceHome, "attachments"), path.join(destinationHome, "attachments"), false, stats);
}

export async function syncCodexConversations(options: CodexConversationSyncOptions): Promise<CodexConversationSyncResult> {
  assertHome(options.sourceCodexHome, "Source CODEX_HOME");
  assertHome(options.destinationCodexHome, "Destination CODEX_HOME");
  const sourceHomeInput = path.resolve(options.sourceCodexHome);
  const sourceHome = await fs.realpath(sourceHomeInput);
  const destinationHome = await fs.realpath(options.destinationCodexHome);
  const threadIds = normalizedThreadIds(options.threadIds);
  if (sourceHome === destinationHome) throw new ExperienceKitError("conversation-sync/same-home", "Source and destination CODEX_HOME must be different");
  const sourceDatabase = path.join(sourceHome, STATE_DATABASE);
  const destinationDatabase = path.join(destinationHome, STATE_DATABASE);
  await Promise.all([fs.access(sourceDatabase), fs.access(destinationDatabase), fs.access(SQLITE)]);

  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-conversation-sync-"));
  const sourceSnapshot = path.join(temporaryDirectory, "source.sqlite");
  const backupDirectory = path.join(destinationHome, "conversation-sync-backups");
  await fs.mkdir(backupDirectory, { recursive: true, mode: 0o700 });
  const destinationBackupPath = path.join(backupDirectory, `state_5-${Date.now()}-${randomUUID()}.sqlite`);
  try {
    await Promise.all([
      sqliteBackup(sourceDatabase, sourceSnapshot),
      sqliteBackup(destinationDatabase, destinationBackupPath),
    ]);
    const [sourceThreadCount, destinationThreadCountBefore] = await Promise.all([
      threadCount(sourceSnapshot, threadIds),
      threadCount(destinationDatabase),
    ]);
    const stats: CopyStats = { copiedFileCount: 0, skippedFileCount: 0, trimmedLiveJsonlCount: 0 };
    if (threadIds) {
      await copySelectedConversationFiles(sourceSnapshot, [sourceHomeInput, sourceHome], sourceHome, destinationHome, threadIds, stats);
    } else {
      for (const directory of CONVERSATION_DIRECTORIES) {
        await copyTree(path.join(sourceHome, directory), path.join(destinationHome, directory), directory === "sessions" || directory === "archived_sessions", stats);
      }
    }
    const mergeSql = await buildMergeSql(sourceSnapshot, [sourceHomeInput, sourceHome], destinationHome, destinationDatabase, threadIds);
    await sqlite(destinationDatabase, mergeSql);
    const destinationThreadCountAfter = await threadCount(destinationDatabase);
    return {
      sourceThreadCount,
      destinationThreadCountBefore,
      destinationThreadCountAfter,
      importedThreadCount: Math.max(0, destinationThreadCountAfter - destinationThreadCountBefore),
      ...stats,
      destinationBackupPath,
    };
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}
