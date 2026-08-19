import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");

describe("open-source release compliance", () => {
  it("retains upstream attribution and excludes local theme output", async () => {
    const [license, notice, readme, ignore, selectorSource, packageSource] = await Promise.all([
      fs.readFile(path.join(root, "LICENSE"), "utf8"),
      fs.readFile(path.join(root, "NOTICE.md"), "utf8"),
      fs.readFile(path.join(root, "README.md"), "utf8"),
      fs.readFile(path.join(root, ".gitignore"), "utf8"),
      fs.readFile(path.join(root, "src/node/codex-runtime.ts"), "utf8"),
      fs.readFile(path.join(root, "package.json"), "utf8"),
    ]);
    const manifest = JSON.parse(packageSource) as { files?: string[]; scripts?: Record<string, string> };

    expect(license).toContain("Copyright (c) 2026 Codex Experience Kit contributors");
    expect(notice).toContain("Copyright (c) 2026 Codex Dream Skin Studio contributors");
    expect(notice).toContain("Permission is hereby granted, free of charge");
    expect(readme).toContain("## Acknowledgements");
    expect(selectorSource).toContain("Fei-Away/Codex-Dream-Skin/blob/6f789be4570b1d5c9e7e60545f22173195968720/tools/selectors.json");
    expect(ignore.split(/\r?\n/u)).toContain("theme-output/");
    expect(manifest.files).toEqual(expect.arrayContaining(["LICENSE", "NOTICE.md", "SECURITY.md", "docs"]));
    expect(manifest.files).not.toContain("theme-output");
    expect(manifest.scripts?.check).toContain("npm run compliance:check");
  });
});
