import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { IsolatedCodexWorkflow } from "../src/node/isolated-codex-workflow.js";

describe("IsolatedCodexWorkflow", () => {
  const roots: string[] = [];
  afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });

  it("discovers default configuration without exposing account credentials and cancels conversation transfer before mutation", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cek-isolated-workflow-"));
    roots.push(root);
    const libraryPath = path.join(root, "library");
    const sourceCodexHome = path.join(root, "primary");
    await fs.mkdir(sourceCodexHome, { recursive: true });
    await fs.writeFile(path.join(sourceCodexHome, "config.toml"), "[features]\n");
    await fs.writeFile(path.join(sourceCodexHome, "auth.json"), "secret");
    let confirmations = 0;
    const workflow = new IsolatedCodexWorkflow({
      libraryPath,
      executablePath: "/bin/echo",
      sourceCodexHome,
      confirmConversationTransfer: async (count) => { confirmations += count; return false; },
    });

    const catalog = await workflow.catalog();
    expect(catalog.items).toEqual(expect.arrayContaining([expect.objectContaining({ id: "config", defaultSelected: true })]));
    expect(catalog.items.flatMap((item) => item.paths)).not.toContain(path.join(sourceCodexHome, "auth.json"));
    expect(catalog.excludedPaths).toContainEqual(expect.objectContaining({ path: path.join(catalog.sourceCodexHome, "auth.json") }));

    await expect(workflow.openConfigured({
      selectedItemIds: ["conversations"],
      selectedConversationThreadIds: ["thread-1"],
    })).resolves.toEqual({ status: "cancelled" });
    expect(confirmations).toBe(1);
  });
});
