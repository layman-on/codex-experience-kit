import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it } from "vitest";
import { buildExperienceViewHtml } from "../src/core/experience-runtime.js";
import {
  buildExperienceProject,
  checkExperienceProject,
  initializeExperienceProject,
  packExperienceProject,
  startExperienceDevServer,
} from "../src/node/experience-project-tools.js";

function managedDocument(frame: HTMLIFrameElement | null): string {
  if (!frame) return "";
  const prefix = "data:text/html;charset=utf-8,";
  expect(frame.src.startsWith(prefix)).toBe(true);
  return decodeURIComponent(frame.src.slice(prefix.length));
}

describe("Experience project toolchain", () => {
  const roots: string[] = [];
  afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });

  const delay = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

  async function previewVersion(url: string): Promise<string> {
    return fetch(new URL("/__experience/version", url)).then((response) => response.text());
  }

  async function expectUnderlayComponentMounts(
    root: string,
    tokens: Awaited<ReturnType<typeof buildExperienceProject>>["tokens"],
  ): Promise<void> {
    const bundle = await checkExperienceProject(root);
    const dom = new JSDOM(buildExperienceViewHtml(bundle, {
      mode: "preview",
      target: "app-shell",
      plane: "underlay",
      appearance: "light",
      tokens,
      channel: "framework-mount-test",
    }), { runScripts: "dangerously", pretendToBeVisual: true });
    try {
      await delay(25);
      expect(dom.window.document.querySelector('.experience-background')).not.toBeNull();
    } finally {
      dom.window.close();
    }
  }

  async function project(framework: "react" | "vue" = "react"): Promise<string> {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), "cek-tools-"));
    roots.push(base);
    const root = path.join(base, "experience");
    await initializeExperienceProject(root, { id: "private.tool-test", name: "Tool Test", framework });
    await fs.symlink(path.join(process.cwd(), "node_modules"), path.join(root, "node_modules"), "junction");
    return root;
  }

  it("initializes, builds, validates, and packs the fixed dist contract", async () => {
    const root = await project();
    const built = await buildExperienceProject(root);
    expect(built.surfaces.map((surface) => `${surface.plane}:${surface.target}`)).toEqual(["underlay:app-shell", "overlay:app-shell"]);
    await expect(checkExperienceProject(root)).resolves.toMatchObject({ manifest: { id: "private.tool-test" } });
    const packed = await packExperienceProject(root);
    expect(packed.path).toMatch(/private\.tool-test-0\.1\.0\.zip$/u);
    expect(packed.bytes).toBeGreaterThan(100);
    await expect(fs.readFile(path.join(root, "dist", "index.html"), "utf8")).resolves.toContain("codex-experience-surface");
    await expect(fs.readFile(path.join(root, "dist", "index.html"), "utf8")).resolves.toContain("data-codex-experience-mount");
    await expectUnderlayComponentMounts(root, built.tokens);
  });

  it("builds the Vue authoring template into the same runtime contract", async () => {
    const root = await project("vue");
    const built = await buildExperienceProject(root);
    expect(built.surfaces.map((surface) => `${surface.plane}:${surface.target}`)).toEqual(["underlay:app-shell", "overlay:app-shell"]);
    await expect(checkExperienceProject(root)).resolves.toMatchObject({ manifest: { id: "private.tool-test" } });
    await expect(fs.readFile(path.join(root, "dist/index.html"), "utf8")).resolves.toContain("data-codex-experience-mount");
    await expectUnderlayComponentMounts(root, built.tokens);
  });

  it("serves an independent synthetic preview without a Codex connection", async () => {
    const root = await project();
    let runtimeCreated = false;
    const server = await startExperienceDevServer(root, {
      port: 0,
      runtimeFactory: () => {
        runtimeCreated = true;
        throw new Error("The synthetic preview must not initialize a runtime");
      },
    });
    try {
      const html = await fetch(server.url).then((response) => response.text());
      expect(html).toContain("Synthetic only");
      expect(html).toContain("codex-experience-browser-v1");
      expect(html).toContain("underlay");
      expect(html).toContain("Apply to Codex");
      expect(html).toContain('data-control="apply"');
      expect(html).toContain('data-restart-confirmation');
      expect(html).toContain('data-restart-apply');
      expect(html).not.toContain("if(confirm(");
      expect(html).toContain("if(controlBusy)return");
      expect(html).toContain("result.previewVersion");
      expect(html).toContain('data-plane-toggle="underlay"');
      expect(html).toContain('data-plane-toggle="overlay"');
      expect(html).toContain("Underlay: shown");
      expect(html).toContain("Overlay: shown");
      expect(runtimeCreated).toBe(false);
    } finally {
      await server.close();
    }
  });

  it("escapes manifest text before rendering the privileged preview shell", async () => {
    const root = await project();
    const manifestPath = path.join(root, "experience.manifest.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    manifest.name = '<img src=x onerror="globalThis.previewCompromised=true">';
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const server = await startExperienceDevServer(root, { port: 0 });
    try {
      const html = await fetch(server.url).then((response) => response.text());
      expect(html).toContain("&lt;img src=x onerror=&quot;globalThis.previewCompromised=true&quot;&gt;");
      expect(html).not.toContain('<strong><img src=x');
    } finally {
      await server.close();
    }
  });

  it("toggles underlay and overlay visibility only inside the synthetic preview", async () => {
    const root = await project();
    const server = await startExperienceDevServer(root, { port: 0 });
    try {
      const html = await fetch(server.url).then((response) => response.text());
      const dom = new JSDOM(html, {
        runScripts: "dangerously",
        pretendToBeVisual: true,
        url: server.url,
      });
      try {
        const underlay = dom.window.document.querySelector<HTMLIFrameElement>('iframe[data-plane="underlay"]');
        const overlay = dom.window.document.querySelector<HTMLIFrameElement>('iframe[data-plane="overlay"]');
        const underlayButton = dom.window.document.querySelector<HTMLButtonElement>('[data-plane-toggle="underlay"]');
        const overlayButton = dom.window.document.querySelector<HTMLButtonElement>('[data-plane-toggle="overlay"]');
        expect(underlay?.hidden).toBe(false);
        expect(overlay?.hidden).toBe(false);

        underlayButton?.click();
        expect(underlay?.hidden).toBe(true);
        expect(overlay?.hidden).toBe(false);
        expect(underlayButton?.getAttribute("aria-pressed")).toBe("false");

        overlayButton?.click();
        expect(underlay?.hidden).toBe(true);
        expect(overlay?.hidden).toBe(true);
        expect(overlayButton?.getAttribute("aria-pressed")).toBe("false");
      } finally {
        dom.window.close();
      }
    } finally {
      await server.close();
    }
  });

  it("mounts a host-managed remote WebView from an interactive overlay message", async () => {
    const root = await project();
    const manifestPath = path.join(root, "experience.manifest.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    manifest.permissions = ["appearance.tokens", "remote.webview"];
    manifest.webviews = { allowedOrigins: ["https://example.com"] };
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const configPath = path.join(root, "experience.config.json");
    const config = JSON.parse(await fs.readFile(configPath, "utf8"));
    const overlay = config.authoring.surfaces.find((surface: { plane: string }) => surface.plane === "overlay");
    overlay.interaction = "interactive";
    await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

    const server = await startExperienceDevServer(root, { port: 0 });
    try {
      const html = await fetch(server.url).then((response) => response.text());
      const dom = new JSDOM(html, {
        runScripts: "dangerously",
        pretendToBeVisual: true,
        url: server.url,
        beforeParse(window) {
          Object.defineProperty(window.HTMLIFrameElement.prototype, "credentialless", {
            configurable: true,
            writable: true,
            value: false,
          });
        },
      });
      try {
        const surface = dom.window.document.querySelector<HTMLIFrameElement>('iframe[data-plane="overlay"]')!;
        const channel = /"channel":"([^"]+)"/u.exec(surface.srcdoc)?.[1];
        expect(channel).toBeTruthy();
        dom.window.dispatchEvent(new dom.window.MessageEvent("message", {
          source: surface.contentWindow,
          data: {
            source: "codex-experience-browser-v1",
            channel,
            type: "webview",
            payload: {
              op: "mount",
              id: "webview-1",
              url: "https://example.com/search",
              title: "Observable remote page",
              rect: { x: 20, y: 30, width: 400, height: 240, visible: true },
            },
          },
        }));

        const managed = dom.window.document.querySelector<HTMLIFrameElement>('iframe[data-codex-experience-webview-host="webview-1"]');
        expect(managed).not.toBeNull();
        expect(managed?.parentElement).toBe(dom.window.document.querySelector(".window"));
        expect(managed?.style.left).toBe("20px");
        const document = managedDocument(managed);
        expect(document).toContain('src="https://example.com/search"');
        expect(document).toContain("credentialless");
      } finally {
        dom.window.close();
      }
    } finally {
      await server.close();
    }
  });

  it("requires explicit dev-host consent and renders a critical warning for unrestricted content", async () => {
    const root = await project();
    const manifestPath = path.join(root, "experience.manifest.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    manifest.permissions = ["appearance.tokens", "remote.webview"];
    manifest.webviews = { securityMode: "unrestricted" };
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const configPath = path.join(root, "experience.config.json");
    const config = JSON.parse(await fs.readFile(configPath, "utf8"));
    config.authoring.surfaces.find((surface: { plane: string }) => surface.plane === "overlay").interaction = "interactive";
    await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

    await expect(startExperienceDevServer(root, { port: 0 })).rejects.toMatchObject({
      code: "tool/unrestricted-remote-content",
    });
    const server = await startExperienceDevServer(root, { port: 0, allowUnrestrictedRemoteContent: true });
    try {
      const html = await fetch(server.url).then((response) => response.text());
      expect(html).toContain("⚠ Unrestricted remote content");
      expect(html).toContain('"riskLevel":"critical"');
      expect(html).toContain('"allowUnrestrictedRemoteContent":true');
      expect(html).toContain("frame-src '+escapeHtml(webviewFrameSource)");
      const nativeHtml = await fetch(new URL("?__codexExperienceNative=1", server.url)).then((response) => response.text());
      expect(nativeHtml).toContain('"remoteContentBackend":"electron-webcontents-view"');
      expect(nativeHtml).toContain("window.codexExperienceNativeWebviews");
      expect(nativeHtml).toContain("Native preview");
    } finally {
      await server.close();
    }
  });

  it("reloads once for source changes and ignores its own build output", async () => {
    const root = await project();
    const server = await startExperienceDevServer(root, { port: 0 });
    try {
      const initial = await previewVersion(server.url);
      await fs.appendFile(path.join(root, "src/surfaces/background/styles.css"), "\n/* one source update */\n");

      let updated = initial;
      for (let attempt = 0; attempt < 40 && updated === initial; attempt += 1) {
        await delay(25);
        updated = await previewVersion(server.url);
      }
      expect(updated).not.toBe(initial);

      await delay(400);
      expect(await previewVersion(server.url)).toBe(updated);
    } finally {
      await server.close();
    }
  });

  it("routes protected preview controls through an injected runtime", async () => {
    const root = await project();
    const calls: Array<{ kind: string; reference?: string; options?: unknown }> = [];
    let shutdowns = 0;
    const server = await startExperienceDevServer(root, {
      port: 0,
      runtimeFactory: () => ({
        async apply(reference, options) {
          calls.push({ kind: "apply", reference, options });
          if (!options.allowRestart) throw Object.assign(new Error("Restart confirmation is required"), { code: "direct/restart-confirmation-required" });
          return { hotUpdated: true, status: { phase: "active" } };
        },
        async cancel() {
          calls.push({ kind: "cancel" });
          return { phase: "idle" };
        },
        async shutdown() { shutdowns += 1; },
      }),
    });
    try {
      const html = await fetch(server.url).then((response) => response.text());
      const token = /"controlToken":"([^"]+)"/u.exec(html)?.[1];
      expect(token).toBeTruthy();

      const preflight = await fetch(new URL("/__experience/control/apply", server.url), {
        method: "OPTIONS",
        headers: {
          Origin: "http://localhost:5173",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "content-type,x-codex-experience-control",
        },
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
      expect(preflight.headers.get("access-control-allow-methods")).toContain("POST");
      expect(preflight.headers.get("access-control-allow-headers")).toContain("X-Codex-Experience-Control");

      const untrustedPreflight = await fetch(new URL("/__experience/control/apply", server.url), {
        method: "OPTIONS",
        headers: { Origin: "https://untrusted.example", "Access-Control-Request-Method": "POST" },
      });
      expect(untrustedPreflight.status).toBe(403);
      expect(untrustedPreflight.headers.get("access-control-allow-origin")).toBeNull();

      const denied = await fetch(new URL("/__experience/control/apply", server.url), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appearance: "dark" }),
      });
      expect(denied.status).toBe(403);
      expect(calls).toHaveLength(0);

      const confirmation = await fetch(new URL("/__experience/control/apply", server.url), {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Codex-Experience-Control": token! },
        body: JSON.stringify({ appearance: "dark" }),
      });
      expect(confirmation.status).toBe(409);
      expect(await confirmation.json()).toMatchObject({ code: "direct/restart-confirmation-required", previewVersion: expect.any(Number) });

      const applied = await fetch(new URL("/__experience/control/apply", server.url), {
        method: "POST",
        headers: { Origin: "http://127.0.0.1:5173", "Content-Type": "application/json", "X-Codex-Experience-Control": token! },
        body: JSON.stringify({ appearance: "dark", allowRestart: true }),
      });
      expect(applied.status).toBe(200);
      expect(applied.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:5173");
      expect(await applied.json()).toMatchObject({ hotUpdated: true, previewVersion: expect.any(Number) });
      expect(calls[1]).toMatchObject({
        kind: "apply",
        reference: path.join(await fs.realpath(root), "dist"),
        options: { appearance: "dark", allowRestart: true },
      });
      expect((calls[1]?.options as { tokens: { light: unknown; dark: unknown } }).tokens).toHaveProperty("light");
      expect((calls[1]?.options as { tokens: { light: unknown; dark: unknown } }).tokens).toHaveProperty("dark");

      const cancelled = await fetch(new URL("/__experience/control/cancel", server.url), {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Codex-Experience-Control": token! },
        body: "{}",
      });
      expect(cancelled.status).toBe(200);
      expect(calls.at(-1)).toEqual({ kind: "cancel" });
      expect(shutdowns).toBe(3);
    } finally {
      await server.close();
    }
  });

  it("builds legacy shared-source paths but rejects ambiguous duplicates", async () => {
    const root = await project();
    const configPath = path.join(root, "experience.config.json");
    const config = JSON.parse(await fs.readFile(configPath, "utf8"));
    delete config.authoring;
    await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await fs.mkdir(path.join(root, "src/shared"), { recursive: true });
    await fs.writeFile(path.join(root, "src/shared/styles.css"), "/* shared */\n");
    await fs.writeFile(path.join(root, "src/shared/main.js"), "window.codexExperience?.lifecycle.ready();\n");
    await fs.mkdir(path.join(root, "src/surfaces/app-shell"), { recursive: true });
    await fs.writeFile(path.join(root, "src/surfaces/app-shell/underlay.html"), '<codex-experience-surface target="app-shell" plane="underlay" interaction="passthrough"></codex-experience-surface>\n');
    await fs.writeFile(path.join(root, "src/surfaces/app-shell/overlay.html"), '<codex-experience-surface target="app-shell" plane="overlay" interaction="passthrough"></codex-experience-surface>\n');
    await fs.rename(path.join(root, "src/shared/styles.css"), path.join(root, "src/styles.css"));
    await fs.rename(path.join(root, "src/shared/main.js"), path.join(root, "src/main.js"));
    await expect(buildExperienceProject(root)).resolves.toMatchObject({ manifest: { id: "private.tool-test" } });

    await fs.mkdir(path.join(root, "src/shared"), { recursive: true });
    await fs.writeFile(path.join(root, "src/shared/styles.css"), "/* canonical */\n");
    await expect(buildExperienceProject(root)).rejects.toMatchObject({
      code: "validation/tool/shared-source",
    });
  });
});
