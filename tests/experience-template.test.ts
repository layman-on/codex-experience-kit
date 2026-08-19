import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { createExperienceProjectStarterFiles, createExperienceProjectStarterZip } from "../src/template/index.js";

describe("Experience project starter", () => {
  it("defaults to a complete React project without authored runtime HTML", () => {
    const files = createExperienceProjectStarterFiles();
    expect(JSON.parse(files["experience.manifest.json"]!)).toMatchObject({ id: "private.my-experience", permissions: ["appearance.tokens"] });
    expect(JSON.parse(files["experience.config.json"]!)).toMatchObject({ authoring: { framework: "react", entry: "main.tsx" } });
    expect(Object.keys(files)).toContain("src/main.tsx");
    expect(Object.keys(files)).toContain("src/surfaces/background/index.tsx");
    expect(Object.keys(files)).toContain("src/surfaces/background/styles.css");
    expect(Object.keys(files)).toContain("src/surfaces/overlay/index.tsx");
    expect(Object.keys(files)).toContain("src/surfaces/overlay/styles.css");
    expect(Object.keys(files).some((name) => name.endsWith(".html"))).toBe(false);
    expect(files["src/surfaces/background/index.tsx"]).toContain('import "./styles.css"');
    expect(files["src/surfaces/overlay/index.tsx"]).toContain('import "./styles.css"');
    expect(files["src/surfaces/background/styles.css"]).toContain(".experience-background");
    expect(files["src/surfaces/overlay/styles.css"]).toContain(".experience-overlay");
    expect(Object.keys(files)).not.toContain("src/styles.css");
    expect(files["docs/AI-GENERATION.zh-CN.md"]).toContain("开始生成前必须询问");
    const zip = unzipSync(createExperienceProjectStarterZip());
    expect(Object.keys(zip)).toContain("experience.config.json");
    expect(Object.keys(zip)).toContain("EXPERIENCE-BRIEF.md");
    const packageJson = JSON.parse(strFromU8(zip["package.json"]!));
    expect(packageJson.scripts).toMatchObject({
      dev: "codex-experience dev",
      "dev:native": "codex-experience dev --native",
      typecheck: "tsc --noEmit",
      check: "npm run typecheck && npm run build && codex-experience check",
      pack: "npm run check && codex-experience pack",
      apply: "codex-experience apply .",
      appearance: "codex-experience appearance",
      cancel: "codex-experience cancel",
    });
    expect(packageJson.dependencies).toHaveProperty("react");
    expect(packageJson.devDependencies).toHaveProperty("vite");
    expect(packageJson.devDependencies).toHaveProperty("codex-experience-kit", "^0.6.11");
    expect(packageJson.devDependencies).not.toHaveProperty("@vitejs/plugin-vue");
    expect(strFromU8(zip["AGENTS.md"]!)).toContain("Experience project instructions");
    expect(strFromU8(zip["src/codex-experience.d.ts"]!)).toContain("remoteContentBackend");
    expect(strFromU8(zip["src/codex-experience.d.ts"]!)).toContain("iframeFallbackUrl");
    expect(strFromU8(zip["src/codex-experience.d.ts"]!)).toContain("interaction:");
    expect(strFromU8(zip["src/codex-experience.d.ts"]!)).toContain("register(element: HTMLElement");
    expect(strFromU8(zip["src/codex-experience.d.ts"]!)).toContain("export interface CodexContextSnapshot");
    expect(strFromU8(zip["src/codex-experience.d.ts"]!)).toContain("export type CodexContextEvent");
  });

  it("generates a Vue project when requested", () => {
    const files = createExperienceProjectStarterFiles({ framework: "vue" });
    expect(JSON.parse(files["experience.config.json"]!)).toMatchObject({ authoring: { framework: "vue", entry: "main.ts" } });
    expect(Object.keys(files)).toContain("src/main.ts");
    expect(Object.keys(files)).toContain("src/surfaces/background/index.vue");
    expect(Object.keys(files)).toContain("src/surfaces/background/styles.css");
    expect(Object.keys(files)).toContain("src/surfaces/overlay/index.vue");
    expect(Object.keys(files)).toContain("src/surfaces/overlay/styles.css");
    expect(Object.keys(files).some((name) => name.endsWith(".tsx") || name.endsWith(".html"))).toBe(false);
    expect(files["src/surfaces/background/index.vue"]).toContain('<style src="./styles.css">');
    expect(files["src/surfaces/overlay/index.vue"]).toContain('<style src="./styles.css">');
    const packageJson = JSON.parse(files["package.json"]!);
    expect(packageJson.dependencies).toHaveProperty("vue");
    expect(packageJson.devDependencies).toHaveProperty("@vitejs/plugin-vue");
    expect(files["docs/AI-GENERATION.zh-CN.md"]).toContain("Vue 3 + TypeScript");
  });

  it("rejects unsupported framework names", () => {
    expect(() => createExperienceProjectStarterFiles({ framework: "svelte" as never })).toThrow("framework must be react or vue");
  });
});
