import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { discoverCodexConversationGroups, syncCodexConversations } from "../src/node/codex-conversation-sync.js";

const execFileAsync = promisify(execFile);
const SQLITE = "/usr/bin/sqlite3";
const describeSqlite = existsSync(SQLITE) ? describe : describe.skip;
const cleanup: string[] = [];

async function database(home: string, threadId: string, rolloutPath: string, title: string): Promise<void> {
  await fs.mkdir(home, { recursive: true });
  const statement = `
    CREATE TABLE thread_sections (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, created_at INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL DEFAULT 1, title TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0, cwd TEXT, thread_section_id TEXT, name TEXT, updated_at_ms INTEGER);
    CREATE TABLE thread_dynamic_tools (thread_id TEXT NOT NULL, position INTEGER NOT NULL, name TEXT NOT NULL, PRIMARY KEY(thread_id, position));
    CREATE TABLE thread_spawn_edges (parent_thread_id TEXT NOT NULL, child_thread_id TEXT NOT NULL, status TEXT NOT NULL, PRIMARY KEY(parent_thread_id, child_thread_id));
    INSERT INTO thread_sections VALUES ('section-1', 'Imported');
    INSERT INTO threads (id,rollout_path,title,archived,thread_section_id) VALUES ('${threadId}', '${rolloutPath.replaceAll("'", "''")}', '${title}', 0, 'section-1');
  `;
  await execFileAsync(SQLITE, [path.join(home, "state_5.sqlite"), statement]);
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describeSqlite("Codex conversation snapshot sync", () => {
  it("imports local transcripts without copying credentials or overwriting destination threads", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "conversation-sync-test-"));
    cleanup.push(root);
    const source = path.join(root, "primary");
    const destination = path.join(root, "secondary");
    const sourceRollout = path.join(source, "sessions", "2026", "08", "13", "rollout-source-thread.jsonl");
    const destinationRollout = path.join(destination, "sessions", "2026", "08", "13", "rollout-destination-thread.jsonl");
    await Promise.all([
      database(source, "source-thread", sourceRollout, "Source conversation"),
      database(destination, "destination-thread", destinationRollout, "Destination conversation"),
    ]);
    await Promise.all([
      fs.mkdir(path.dirname(sourceRollout), { recursive: true }),
      fs.mkdir(path.dirname(destinationRollout), { recursive: true }),
      fs.writeFile(path.join(source, "auth.json"), "primary credential"),
      fs.writeFile(path.join(destination, "auth.json"), "secondary credential"),
    ]);
    await Promise.all([
      fs.writeFile(sourceRollout, '{"type":"event","payload":{"text":"complete"}}\n{"type":"event","payload":'),
      fs.writeFile(destinationRollout, '{"type":"event","payload":{"text":"secondary"}}\n'),
    ]);

    const result = await syncCodexConversations({ sourceCodexHome: source, destinationCodexHome: destination });
    expect(result).toMatchObject({
      sourceThreadCount: 1,
      destinationThreadCountBefore: 1,
      destinationThreadCountAfter: 2,
      importedThreadCount: 1,
      copiedFileCount: 1,
      trimmedLiveJsonlCount: 1,
    });
    expect(await fs.readFile(path.join(destination, "auth.json"), "utf8")).toBe("secondary credential");
    expect(await fs.readFile(path.join(destination, "sessions", "2026", "08", "13", "rollout-source-thread.jsonl"), "utf8"))
      .toBe('{"type":"event","payload":{"text":"complete"}}\n');
    const { stdout } = await execFileAsync(SQLITE, [path.join(destination, "state_5.sqlite"), "SELECT id || '|' || rollout_path FROM threads ORDER BY id;"]);
    expect(stdout).toContain(`destination-thread|${destinationRollout}`);
    const realDestination = await fs.realpath(destination);
    expect(stdout).toContain(`source-thread|${path.join(realDestination, "sessions", "2026", "08", "13", "rollout-source-thread.jsonl")}`);
    await expect(fs.access(result.destinationBackupPath)).resolves.toBeUndefined();

    const second = await syncCodexConversations({ sourceCodexHome: source, destinationCodexHome: destination });
    expect(second.importedThreadCount).toBe(0);
    expect(second.skippedFileCount).toBe(1);
  });

  it("discovers project groups and copies only explicitly selected conversations", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "conversation-selection-test-"));
    cleanup.push(root);
    const source = path.join(root, "primary");
    const destination = path.join(root, "secondary");
    const selectedRollout = path.join(source, "sessions", "selected.jsonl");
    const omittedRollout = path.join(source, "sessions", "omitted.jsonl");
    await Promise.all([
      database(source, "selected-thread", selectedRollout, "Selected conversation"),
      database(destination, "destination-thread", path.join(destination, "sessions", "destination.jsonl"), "Destination conversation"),
    ]);
    await execFileAsync(SQLITE, [path.join(source, "state_5.sqlite"), `INSERT INTO threads (id,rollout_path,created_at,updated_at,title,archived,thread_section_id) VALUES ('omitted-thread','${omittedRollout.replaceAll("'", "''")}',1,2,'Omitted conversation',0,'section-1');`]);
    await Promise.all([
      fs.mkdir(path.dirname(selectedRollout), { recursive: true }),
      fs.mkdir(path.join(source, "shell_snapshots"), { recursive: true }),
      fs.mkdir(path.join(source, "generated_images", "selected-thread"), { recursive: true }),
      fs.mkdir(path.join(source, "generated_images", "omitted-thread"), { recursive: true }),
      fs.mkdir(path.join(source, "attachments", "attachment-1"), { recursive: true }),
    ]);
    await Promise.all([
      fs.writeFile(selectedRollout, '{"selected":true}\n'),
      fs.writeFile(omittedRollout, '{"omitted":true}\n'),
      fs.writeFile(path.join(source, "shell_snapshots", "selected-thread.1.sh"), "selected shell\n"),
      fs.writeFile(path.join(source, "shell_snapshots", "omitted-thread.1.sh"), "omitted shell\n"),
      fs.writeFile(path.join(source, "generated_images", "selected-thread", "selected.png"), "selected image"),
      fs.writeFile(path.join(source, "generated_images", "omitted-thread", "omitted.png"), "omitted image"),
      fs.writeFile(path.join(source, "attachments", "attachment-1", "pasted-text.txt"), "small shared attachment"),
      fs.writeFile(path.join(source, ".codex-global-state.json"), JSON.stringify({
        "local-projects": { "project-a": { name: "Project A" }, "project-b": { name: "Project B" } },
        "thread-project-assignments": {
          "selected-thread": { projectId: "project-a" },
          "omitted-thread": { projectId: "project-b" },
        },
      })),
    ]);

    const groups = await discoverCodexConversationGroups(source);
    expect(groups.map((group) => ({ label: group.label, ids: group.threads.map((thread) => thread.threadId) }))).toEqual(expect.arrayContaining([
      { label: "Project A", ids: ["selected-thread"] },
      { label: "Project B", ids: ["omitted-thread"] },
    ]));

    const result = await syncCodexConversations({ sourceCodexHome: source, destinationCodexHome: destination, threadIds: ["selected-thread"] });
    expect(result.sourceThreadCount).toBe(1);
    const ids = (await execFileAsync(SQLITE, [path.join(destination, "state_5.sqlite"), "SELECT id FROM threads ORDER BY id;"])).stdout.trim().split("\n");
    expect(ids).toEqual(["destination-thread", "selected-thread"]);
    expect(await fs.readFile(path.join(destination, "sessions", "selected.jsonl"), "utf8")).toContain("selected");
    await expect(fs.access(path.join(destination, "sessions", "omitted.jsonl"))).rejects.toThrow();
    expect(await fs.readFile(path.join(destination, "shell_snapshots", "selected-thread.1.sh"), "utf8")).toContain("selected");
    await expect(fs.access(path.join(destination, "shell_snapshots", "omitted-thread.1.sh"))).rejects.toThrow();
    expect(await fs.readFile(path.join(destination, "generated_images", "selected-thread", "selected.png"), "utf8")).toContain("selected");
    await expect(fs.access(path.join(destination, "generated_images", "omitted-thread", "omitted.png"))).rejects.toThrow();
    expect(await fs.readFile(path.join(destination, "attachments", "attachment-1", "pasted-text.txt"), "utf8")).toContain("attachment");
  });
});
