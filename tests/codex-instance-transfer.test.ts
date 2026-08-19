import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverCodexTransferCatalog, transferCodexInstanceData } from "../src/node/codex-instance-transfer.js";

const temporaryDirectories: string[] = [];

async function temporaryHome(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-instance-transfer-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("Codex instance transfer", () => {
  it("defaults capabilities on, leaves conversations and new paths off, and never copies credentials", async () => {
    const source = await temporaryHome();
    const destination = await temporaryHome();
    await Promise.all([
      fs.mkdir(path.join(source, "skills", "sample"), { recursive: true }),
      fs.mkdir(path.join(source, "mcp"), { recursive: true }),
      fs.mkdir(path.join(source, "sessions", "2026"), { recursive: true }),
      fs.mkdir(path.join(source, "future-store"), { recursive: true }),
      fs.mkdir(path.join(source, "browser"), { recursive: true }),
    ]);
    await Promise.all([
      fs.writeFile(path.join(source, "config.toml"), `command = "${source}/mcp/server.mjs"\n`),
      fs.writeFile(path.join(source, ".codex-global-state.json"), JSON.stringify({
        "electron-saved-workspace-roots": ["/workspace/primary"],
        "local-projects": { primary: { path: "/workspace/primary" } },
        "electron-local-remote-control-installation-id": "primary-installation",
        "electron-persisted-atom-state": { "flat-project-sidebar-preferences-v1": { compact: true }, "composer-prompt-drafts-v1": { secret: true } },
      })),
      fs.writeFile(path.join(source, "skills", "sample", "SKILL.md"), "# Sample\n"),
      fs.writeFile(path.join(source, "mcp", "server.mjs"), "export default {};\n"),
      fs.writeFile(path.join(source, "sessions", "2026", "thread.jsonl"), "{}\n"),
      fs.writeFile(path.join(source, "future-store", "data.json"), "{\"future\":true}\n"),
      fs.writeFile(path.join(source, "auth.json"), "primary-secret\n"),
      fs.writeFile(path.join(source, "browser", "Cookies"), "primary-browser-secret\n"),
      fs.writeFile(path.join(destination, "auth.json"), "secondary-secret\n"),
      fs.writeFile(path.join(destination, "config.toml"), `secondary = "${destination}/keep"\n`),
      fs.writeFile(path.join(destination, ".codex-global-state.json"), JSON.stringify({
        "electron-saved-workspace-roots": ["/workspace/secondary"],
        "electron-local-remote-control-installation-id": "secondary-installation",
        "electron-persisted-atom-state": { "composer-prompt-drafts-v1": { preserved: true } },
      })),
    ]);

    const catalog = await discoverCodexTransferCatalog(source, destination);
    const sourceReal = await fs.realpath(source);
    const destinationReal = await fs.realpath(destination);
    expect(catalog.items.find((item) => item.id === "config")?.defaultSelected).toBe(true);
    expect(catalog.items.find((item) => item.id === "skills")?.defaultSelected).toBe(true);
    expect(catalog.items.find((item) => item.id === "conversations")).toMatchObject({ defaultSelected: false, sizeBytes: 3 });
    const future = catalog.items.find((item) => item.label === "future-store");
    expect(future).toMatchObject({ category: "other", defaultSelected: false, paths: [path.join(sourceReal, "future-store")] });
    expect(catalog.excludedPaths).toEqual(expect.arrayContaining([
      { path: path.join(sourceReal, "auth.json"), reason: expect.stringContaining("账号凭据") },
      { path: path.join(sourceReal, "browser"), reason: expect.stringContaining("账号凭据") },
    ]));

    const result = await transferCodexInstanceData({
      sourceCodexHome: source,
      destinationCodexHome: destination,
      selectedItemIds: ["config", "workspaces", "skills", "mcp-files", future!.id],
    });
    expect(await fs.readFile(path.join(destination, "auth.json"), "utf8")).toBe("secondary-secret\n");
    expect(await fs.readFile(path.join(destination, "config.toml"), "utf8")).toBe(`command = "${destinationReal}/mcp/server.mjs"\n`);
    expect(await fs.readFile(path.join(destination, "skills", "sample", "SKILL.md"), "utf8")).toBe("# Sample\n");
    expect(await fs.readFile(path.join(destination, "future-store", "data.json"), "utf8")).toContain("future");
    expect(await fs.access(path.join(destination, "browser", "Cookies")).then(() => true, () => false)).toBe(false);
    expect(result.backupDirectory).toBeTruthy();
    expect(await fs.readFile(path.join(result.backupDirectory!, "config.toml"), "utf8")).toBe(`secondary = "${destination}/keep"\n`);
    const workspaceState = JSON.parse(await fs.readFile(path.join(destination, ".codex-global-state.json"), "utf8")) as Record<string, any>;
    expect(workspaceState["electron-saved-workspace-roots"]).toEqual(["/workspace/primary"]);
    expect(workspaceState["local-projects"]).toEqual({ primary: { path: "/workspace/primary" } });
    expect(workspaceState["electron-local-remote-control-installation-id"]).toBe("secondary-installation");
    expect(workspaceState["electron-persisted-atom-state"]).toEqual({
      "composer-prompt-drafts-v1": { preserved: true },
      "flat-project-sidebar-preferences-v1": { compact: true },
    });
  });
});
