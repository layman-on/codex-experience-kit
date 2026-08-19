import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ExperienceDevelopmentRegistry } from "../src/node/experience-development-registry.js";
import { writeProject } from "./helpers/experience-project-fixture.js";

describe("ExperienceDevelopmentRegistry", () => {
  const roots: string[] = [];
  afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });

  it("links a directory while keeping an immutable snapshot until explicit refresh", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ctk-development-"));
    roots.push(root);
    const source = path.join(root, "editable-experience");
    await writeProject(source, { id: "development.portal" });
    const registry = new ExperienceDevelopmentRegistry(path.join(root, "library"));
    const linked = await registry.linkProject(source);
    expect(linked).toMatchObject({ projectId: "development.portal", sourceName: "editable-experience" });
    expect(linked).not.toHaveProperty("sourcePath");
    const original = await registry.loadProject(linked.id);

    await fs.writeFile(path.join(source, "index.html"), `<!doctype html><html><body>
      <codex-experience-surface target="app-shell" plane="underlay" interaction="passthrough"><div>Fresh source</div></codex-experience-surface>
      <codex-experience-surface target="app-shell" plane="overlay" interaction="passthrough"><div>Fresh frame</div></codex-experience-surface>
    </body></html>`);
    await expect(registry.loadProject(linked.id)).resolves.toEqual(original);
    const candidate = await registry.readSourceProject(linked.id);
    expect(candidate.html).toContain("Fresh source");
    const refreshed = await registry.replaceSnapshot(linked.id, candidate);
    expect(refreshed.digest).not.toBe(original.digest);
    await expect(registry.loadProject(linked.id)).resolves.toMatchObject({ digest: refreshed.digest });

    await fs.writeFile(path.join(source, "index.html"), '<!doctype html><img src="https://example.invalid/tracker.png"><codex-experience-surface target="app-shell" plane="overlay"></codex-experience-surface>');
    await expect(registry.readSourceProject(linked.id)).rejects.toThrow("External URL is not allowed");
    await expect(registry.loadProject(linked.id)).resolves.toMatchObject({ digest: refreshed.digest });
  });
});
