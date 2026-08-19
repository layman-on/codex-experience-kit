import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { generateAppearanceTokens } from "../src/core/appearance-tokens.js";
import {
  createExperienceProjectDigest,
  type ExperienceProjectBundle,
  type ExperienceProjectManifest,
} from "../src/core/experience-project.js";
import { buildExperienceViewHtml } from "../src/core/experience-runtime.js";

interface WebviewHandle {
  navigate(url: string): void;
  reload(): void;
  destroy(): void;
}

interface WebviewApi {
  webviews: {
    mount(container: HTMLElement, options: { url: string; title?: string }): WebviewHandle;
  };
}

function project(remote = true): ExperienceProjectBundle {
  const manifest: ExperienceProjectManifest = {
    apiVersion: 1,
    id: "private.webview-test",
    name: "WebView Test",
    version: "1.0.0",
    entry: "index.html",
    permissions: remote ? ["remote.webview"] : [],
    ...(remote ? { webviews: { allowedOrigins: ["https://example.com"] } } : {}),
  };
  const html = '<!doctype html><html><head></head><body><codex-experience-surface target="app-shell" plane="overlay" interaction="interactive"><div id="webview-root"></div></codex-experience-surface></body></html>';
  return {
    manifest,
    html,
    digest: createExperienceProjectDigest(manifest, html),
    surfaces: [{ target: "app-shell", plane: "overlay", interaction: "interactive" }],
  };
}

function view(bundle: ExperienceProjectBundle): string {
  return buildExperienceViewHtml(bundle, {
    mode: "preview",
    target: "app-shell",
    plane: "overlay",
    interaction: "interactive",
    appearance: "light",
    tokens: generateAppearanceTokens({ seed: "#6750A4" }).modes,
    channel: "webview-test",
  });
}

describe("remote.webview browser capability", () => {
  it("requests a host-managed allowlisted HTTPS frame without nesting remote content", async () => {
    const html = view(project());
    expect(html).toContain("frame-src 'none'");
    expect(html).not.toContain("allow-popups");
    const dom = new JSDOM(html, { runScripts: "dangerously", pretendToBeVisual: true });
    try {
      const requests: Array<Record<string, unknown>> = [];
      dom.window.addEventListener("message", event => {
        const data = event.data as { type?: unknown; payload?: unknown };
        if (data?.type === "webview" && data.payload && typeof data.payload === "object") {
          requests.push(data.payload as Record<string, unknown>);
        }
      });
      const root = dom.window.document.querySelector<HTMLElement>("#webview-root")!;
      const api = (dom.window as unknown as { codexExperience: WebviewApi }).codexExperience;
      const handle = api.webviews.mount(root, { url: "https://example.com/start", title: "Allowed content" });
      await new Promise(resolve => dom.window.setTimeout(resolve, 0));
      expect(root.querySelector("iframe")).toBeNull();
      expect(requests[0]).toMatchObject({ op: "mount", id: "webview-1", url: "https://example.com/start", title: "Allowed content" });
      expect(() => handle.navigate("https://evil.example/path")).toThrow("project security policy");
      handle.navigate("https://example.com/next");
      handle.reload();
      handle.destroy();
      await new Promise(resolve => dom.window.setTimeout(resolve, 0));
      expect(requests.map(request => request.op)).toEqual(expect.arrayContaining(["mount", "layout", "navigate", "reload", "destroy"]));
      expect(requests.find(request => request.op === "navigate")).toMatchObject({ url: "https://example.com/next" });
      expect(() => handle.reload()).toThrow("destroyed");
    } finally {
      dom.window.close();
    }
  });

  it("lets permissive and unrestricted projects request arbitrary HTTP(S) navigation but never local protocols", () => {
    for (const securityMode of ["permissive", "unrestricted"] as const) {
      const bundle = project();
      bundle.manifest.webviews = { securityMode };
      const dom = new JSDOM(view(bundle), { runScripts: "dangerously", pretendToBeVisual: true });
      try {
        const root = dom.window.document.querySelector<HTMLElement>("#webview-root")!;
        const api = (dom.window as unknown as { codexExperience: WebviewApi }).codexExperience;
        const handle = api.webviews.mount(root, { url: "http://example.com/start" });
        expect(() => handle.navigate("https://different.example/path")).not.toThrow();
        expect(() => handle.navigate("file:///etc/passwd")).toThrow("project security policy");
        expect(() => handle.navigate("javascript:alert(1)")).toThrow("project security policy");
      } finally {
        dom.window.close();
      }
    }
  });

  it("keeps frame loading disabled when the permission is absent", () => {
    const html = view(project(false));
    expect(html).toContain("frame-src 'none'");
    const dom = new JSDOM(html, { runScripts: "dangerously", pretendToBeVisual: true });
    try {
      const root = dom.window.document.querySelector<HTMLElement>("#webview-root")!;
      const api = (dom.window as unknown as { codexExperience: WebviewApi }).codexExperience;
      expect(() => api.webviews.mount(root, { url: "https://example.com" })).toThrow("remote.webview permission is required");
      expect(root.querySelector("iframe")).toBeNull();
    } finally {
      dom.window.close();
    }
  });
});
