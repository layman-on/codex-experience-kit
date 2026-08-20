import { describe, expect, it } from "vitest";

// Release tooling is intentionally plain ESM so GitHub Actions can execute it without a build step.
// @ts-expect-error The repository-local release script is not part of the published TypeScript API.
const { resolveReleaseMetadata } = await import("../scripts/release-metadata.mjs") as {
  resolveReleaseMetadata(input: {
    packageJson: { name: string; version: string };
    changelog: string;
    tag: string;
  }): { packageName: string; version: string; tag: string; distTag: string; prerelease: boolean };
};

describe("release metadata", () => {
  it.each([
    ["1.2.3", "latest", false],
    ["1.2.3-beta.1", "beta", true],
    ["1.2.3-next.7", "next", true],
  ])("maps %s to the protected npm channel", (version, distTag, prerelease) => {
    expect(resolveReleaseMetadata({
      packageJson: { name: "codex-experience-kit", version },
      changelog: `# Changelog\n\n## ${version} - 2026-08-20\n`,
      tag: `v${version}`,
    })).toEqual({
      packageName: "codex-experience-kit",
      version,
      tag: `v${version}`,
      distTag,
      prerelease,
    });
  });

  it("rejects a tag that does not identify the package version", () => {
    expect(() => resolveReleaseMetadata({
      packageJson: { name: "codex-experience-kit", version: "1.2.3" },
      changelog: "## 1.2.3 - 2026-08-20\n",
      tag: "v1.2.4",
    })).toThrow("must exactly match");
  });

  it("rejects unsupported prerelease channels and missing changelog entries", () => {
    expect(() => resolveReleaseMetadata({
      packageJson: { name: "codex-experience-kit", version: "1.2.3-alpha.1" },
      changelog: "## 1.2.3-alpha.1 - 2026-08-20\n",
      tag: "v1.2.3-alpha.1",
    })).toThrow("stable, -beta.N, or -next.N");
    expect(() => resolveReleaseMetadata({
      packageJson: { name: "codex-experience-kit", version: "1.2.3" },
      changelog: "# Changelog\n",
      tag: "v1.2.3",
    })).toThrow("must contain a dated section");
  });
});
