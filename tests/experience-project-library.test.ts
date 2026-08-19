import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ExperienceProjectLibrary } from "../src/node/experience-project-library.js";
import { writeProject } from "./helpers/experience-project-fixture.js";

describe("ExperienceProjectLibrary", () => {
  const roots: string[] = [];
  afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
  it("installs transactionally in the new namespace and never reads legacy themes", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ctk-library-")); roots.push(root);
    const source = path.join(root, "source"); await writeProject(source);
    const library = new ExperienceProjectLibrary(path.join(root, "library"));
    const installed = await library.importProject({ kind: "directory", path: source });
    expect(installed.directory).toContain("experience-projects-v1");
    await expect(library.listProjects()).resolves.toHaveLength(1);
    await expect(library.loadProject(installed.id)).resolves.toMatchObject({ manifest: { id: installed.id } });
    await library.removeProject(installed.id);
    await expect(library.listProjects()).resolves.toEqual([]);
  });
});
