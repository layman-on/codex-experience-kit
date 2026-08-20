import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");

describe("release workflow security boundary", () => {
  it("uses pinned actions, OIDC publishing, and no long-lived npm token", async () => {
    const workflow = await fs.readFile(path.join(root, ".github/workflows/publish.yml"), "utf8");
    const actionReferences = [...workflow.matchAll(/uses:\s+([^\s#]+)/gu)].map((match) => match[1]);

    expect(actionReferences.length).toBeGreaterThan(0);
    expect(actionReferences.every((reference) => /@[a-f0-9]{40}$/u.test(reference ?? ""))).toBe(true);
    expect(workflow).toContain("id-token: write");
    expect(workflow).toContain("environment: npm");
    expect(workflow).toContain("npm publish --access public --tag");
    expect(workflow).toContain("npm ci --ignore-scripts");
    expect(workflow).not.toContain("NPM_TOKEN");
    expect(workflow).not.toContain("NODE_AUTH_TOKEN");
  });

  it("separates verification, npm identity, and GitHub release mutation", async () => {
    const workflow = await fs.readFile(path.join(root, ".github/workflows/publish.yml"), "utf8");

    expect(workflow).toContain("verify:");
    expect(workflow).toContain("prepare-release:");
    expect(workflow).toContain("publish-npm:");
    expect(workflow).toContain("finalize-release:");
    expect(workflow).toContain("Release tags must be annotated tags.");
    expect(workflow).toContain("must already be merged into main");
  });
});
