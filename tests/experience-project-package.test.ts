import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readExperienceProjectPackage } from "../src/node/experience-project-package.js";
import { writeProject } from "./helpers/experience-project-fixture.js";

describe("HTML Experience project importer", () => {
  const roots: string[] = [];
  afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
  const root = async () => { const value = await fs.mkdtemp(path.join(os.tmpdir(), "ctk-project-")); roots.push(value); return value; };

  it("compiles package-local CSS, JavaScript, and images into self-contained HTML", async () => {
    const directory = await root();
    await writeProject(directory);
    const project = await readExperienceProjectPackage({ kind: "directory", path: directory });
    expect(project.manifest.id).toBe("fixture.portal");
    expect(project.surfaces).toHaveLength(2);
    expect(project.html).toContain("data:image/png;base64,");
    expect(project.html).toContain("window.codexExperience?.lifecycle.ready()");
    expect(project.html).not.toContain('src="assets/');
    expect(project.digest).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("rejects network URLs and the removed image theme package", async () => {
    const external = await root();
    await writeProject(external, { extraHtml: '<img src="https://example.com/tracker.png">' });
    await expect(readExperienceProjectPackage({ kind: "directory", path: external })).rejects.toThrow("External URL is not allowed");
    const legacy = await root();
    await fs.writeFile(path.join(legacy, "theme.json"), "{}");
    await fs.writeFile(path.join(legacy, "theme.css"), "body{}");
    await expect(readExperienceProjectPackage({ kind: "directory", path: legacy })).rejects.toThrow("旧主题格式不再支持");
  });

  it("requires an interactive overlay before importing remote.webview", async () => {
    const directory = await root();
    await fs.writeFile(path.join(directory, "experience.manifest.json"), JSON.stringify({
      apiVersion: 1,
      id: "fixture.remote",
      name: "Remote Fixture",
      version: "1.0.0",
      entry: "index.html",
      permissions: ["remote.webview"],
      webviews: { allowedOrigins: ["https://example.com"] },
    }));
    await fs.writeFile(path.join(directory, "index.html"), '<codex-experience-surface target="app-shell" plane="overlay" interaction="passthrough"></codex-experience-surface>');
    await expect(readExperienceProjectPackage({ kind: "directory", path: directory })).rejects.toThrow("requires at least one interactive overlay");
  });
});
