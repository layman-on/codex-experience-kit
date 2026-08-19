import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { buildExperienceProject, checkExperienceProject, startExperienceDevServer } from "../src/node/experience-project-tools.js";

const exampleRoot = fileURLToPath(new URL("../example", import.meta.url));

afterAll(async () => {
  await fs.rm(path.join(exampleRoot, "dist"), { recursive: true, force: true });
});

describe("tracked task-aware React example", () => {
  it("builds into a valid two-surface Experience", async () => {
    const result = await buildExperienceProject(exampleRoot);
    expect(result.manifest).toMatchObject({
      id: "example.task-aware-react",
      permissions: [
        "appearance.tokens",
        "codex.context.active",
        "codex.context.metadata",
        "codex.events.lifecycle",
      ],
    });
    expect(result.surfaces).toEqual([
      { target: "app-shell", plane: "underlay", interaction: "passthrough" },
      { target: "app-shell", plane: "overlay", interaction: "scoped" },
    ]);

    const built = await checkExperienceProject(exampleRoot);
    expect(built.html).toContain("example");
    expect(built.html).toContain("task-status-trigger");
    expect(built.html).toContain("edge-glow-left");
    expect(built.html).not.toContain("Codex 双开");
    expect(built.html).not.toContain("data-preview-settings");

    const config = JSON.parse(await fs.readFile(path.join(exampleRoot, "experience.config.json"), "utf8"));
    expect(config.preview).toEqual({ tools: ["codex-secondary-instance"] });
    let runtimeCreated = false;
    const server = await startExperienceDevServer(exampleRoot, {
      port: 0,
      runtimeFactory: () => {
        runtimeCreated = true;
        throw new Error("Rendering the preview shell must remain synthetic");
      },
    });
    try {
      const html = await fetch(server.url).then((response) => response.text());
      expect(html).toContain("Codex 双开");
      expect(html).toContain('data-preview-settings');
      expect(runtimeCreated).toBe(false);
    } finally {
      await server.close();
    }
  });
});
