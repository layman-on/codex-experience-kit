import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { generateAppearanceTokens } from "../src/core/appearance-tokens.js";
import { mountExperienceProjectPreview } from "../src/preview/index.js";

describe("Experience Runtime synthetic preview", () => {
  it("maps one project onto synthetic semantic surfaces and patches complete token modes", () => {
    const dom = new JSDOM('<!doctype html><div id="host"></div>', { pretendToBeVisual: true });
    const host = dom.window.document.querySelector<HTMLElement>("#host")!;
    const first = generateAppearanceTokens({ seed: "#6750A4" }).modes;
    const handle = mountExperienceProjectPreview(host, {
      manifest: { apiVersion: 1, id: "preview.portal", name: "Preview Portal", version: "1.0.0", entry: "index.html", permissions: ["appearance.tokens"] },
      html: '<!doctype html><html><body><codex-experience-surface target="app-shell" plane="underlay"></codex-experience-surface><codex-experience-surface target="app-shell" plane="overlay"></codex-experience-surface><codex-experience-surface target="workspace" plane="overlay" interaction="interactive"></codex-experience-surface><codex-experience-surface target="floating-window" plane="overlay" interaction="scoped"></codex-experience-surface></body></html>',
      digest: "a".repeat(64),
      surfaces: [
        { target: "app-shell", plane: "underlay", interaction: "passthrough" },
        { target: "app-shell", plane: "overlay", interaction: "passthrough" },
        { target: "workspace", plane: "overlay", interaction: "interactive" },
        { target: "floating-window", plane: "overlay", interaction: "scoped" },
      ],
    }, { tokens: first, appearance: "light", view: "task" });
    expect(handle.root.querySelectorAll("iframe")).toHaveLength(4);
    expect(handle.root.querySelector<HTMLIFrameElement>('[data-codex-experience-target="app-shell"][data-codex-experience-plane="underlay"]')?.style.zIndex).toBe("0");
    expect(handle.root.querySelector<HTMLIFrameElement>('[data-codex-experience-target="app-shell"][data-codex-experience-plane="overlay"]')?.style.pointerEvents).toBe("none");
    expect(handle.root.querySelector<HTMLIFrameElement>('[data-codex-experience-target="workspace"]')?.style.pointerEvents).toBe("auto");
    expect(handle.root.querySelector<HTMLIFrameElement>('[data-codex-experience-target="floating-window"]')?.style.zIndex).toBe("40");
    expect(handle.root.querySelector<HTMLIFrameElement>('[data-codex-experience-target="floating-window"]')?.parentElement).toBe(handle.root);
    expect(handle.root.querySelector<HTMLIFrameElement>('[data-codex-experience-target="workspace"]')?.getAttribute("sandbox")).toBe("allow-scripts");
    expect(handle.root.querySelector<HTMLIFrameElement>('[data-codex-experience-target="workspace"]')?.srcdoc).toContain('"plane":"overlay"');
    const second = generateAppearanceTokens({ seed: "#008577" }).modes;
    handle.setTokens(second);
    handle.setAppearance("dark");
    expect(handle.getState()).toMatchObject({ appearance: "dark", tokens: second });
    handle.destroy();
    expect(host.shadowRoot?.childNodes).toHaveLength(0);
    dom.window.close();
  });

  it("widens only the outer sandbox needed by an approved remote WebView", () => {
    const dom = new JSDOM('<!doctype html><div id="host"></div>', { pretendToBeVisual: true });
    const host = dom.window.document.querySelector<HTMLElement>("#host")!;
    const handle = mountExperienceProjectPreview(host, {
      manifest: {
        apiVersion: 1,
        id: "preview.remote",
        name: "Remote Preview",
        version: "1.0.0",
        entry: "index.html",
        permissions: ["remote.webview"],
        webviews: { allowedOrigins: ["https://example.com"] },
      },
      html: '<!doctype html><html><body><codex-experience-surface target="app-shell" plane="overlay" interaction="interactive"></codex-experience-surface></body></html>',
      digest: "b".repeat(64),
      surfaces: [{ target: "app-shell", plane: "overlay", interaction: "interactive" }],
    }, { tokens: generateAppearanceTokens({ seed: "#6750A4" }).modes });
    const frame = handle.root.querySelector<HTMLIFrameElement>('iframe[data-codex-experience-plane="overlay"]')!;
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts allow-forms");
    expect(frame.srcdoc).toContain("frame-src 'none'");
    expect(frame.srcdoc).toContain('post("webview"');
    handle.destroy();
    dom.window.close();
  });

  it("opens pointer hit-testing only for author-registered scoped regions", () => {
    const dom = new JSDOM('<!doctype html><div id="host"></div>', { pretendToBeVisual: true });
    const host = dom.window.document.querySelector<HTMLElement>("#host")!;
    const handle = mountExperienceProjectPreview(host, {
      manifest: { apiVersion: 1, id: "preview.scoped", name: "Scoped Preview", version: "1.0.0", entry: "index.html", permissions: [] },
      html: '<!doctype html><html><body><codex-experience-surface target="app-shell" plane="overlay" interaction="scoped"><button>Control</button></codex-experience-surface></body></html>',
      digest: "7".repeat(64),
      surfaces: [{ target: "app-shell", plane: "overlay", interaction: "scoped" }],
    }, { tokens: generateAppearanceTokens({ seed: "#6750A4" }).modes });
    const frame = handle.root.querySelector<HTMLIFrameElement>('iframe[data-codex-experience-plane="overlay"]')!;
    expect(frame.style.pointerEvents).toBe("none");
    expect(frame.style.clipPath).toContain("inset");
    const channel = /"channel":"([^"]+)"/u.exec(frame.srcdoc)?.[1];
    expect(channel).toBeTruthy();
    dom.window.dispatchEvent(new dom.window.MessageEvent("message", {
      source: frame.contentWindow,
      data: {
        source: "codex-experience-browser-v1",
        channel,
        type: "interaction",
        payload: { op: "regions", regions: [{ x: 20, y: 30, width: 48, height: 48, shape: "circle" }, { x: 100, y: 10, width: 240, height: 32 }, { x: 360, y: 50, width: 100, height: 60, shape: "rounded", radius: 16 }] },
      },
    }));
    expect(frame.style.pointerEvents).toBe("auto");
    expect(frame.style.clipPath).toContain("M 44 30 A 24 24 0 1 1 44 78 A 24 24 0 1 1 44 30 Z");
    expect(frame.style.clipPath).toContain("M 100 10 H 340 V 42 H 100 Z");
    expect(frame.style.clipPath).toContain("M 376 50 H 444 Q 460 50 460 66");
    handle.destroy();
    dom.window.close();
  });

  it("requires an explicit preview-host grant for unrestricted remote content", () => {
    const dom = new JSDOM('<!doctype html><div id="host"></div>', { pretendToBeVisual: true });
    const host = dom.window.document.querySelector<HTMLElement>("#host")!;
    const project = {
      manifest: {
        apiVersion: 1 as const,
        id: "preview.unrestricted",
        name: "Unrestricted Preview",
        version: "1.0.0",
        entry: "index.html" as const,
        permissions: ["remote.webview" as const],
        webviews: { securityMode: "unrestricted" as const },
      },
      html: '<!doctype html><html><body><codex-experience-surface target="app-shell" plane="overlay" interaction="interactive"></codex-experience-surface></body></html>',
      digest: "c".repeat(64),
      surfaces: [{ target: "app-shell" as const, plane: "overlay" as const, interaction: "interactive" as const }],
    };
    const tokens = generateAppearanceTokens({ seed: "#6750A4" }).modes;
    expect(() => mountExperienceProjectPreview(host, project, { tokens })).toThrow("allowUnrestrictedRemoteContent");
    const handle = mountExperienceProjectPreview(host, project, { tokens, allowUnrestrictedRemoteContent: true });
    expect(handle.getState().remoteContentRisk).toMatchObject({ riskLevel: "critical", requiresHostGrant: true });
    handle.destroy();
    dom.window.close();
  });

  it("simulates sanitized active-thread and background completion state", () => {
    const dom = new JSDOM('<!doctype html><div id="host"></div>', { pretendToBeVisual: true });
    const host = dom.window.document.querySelector<HTMLElement>("#host")!;
    const now = 1_000;
    const handle = mountExperienceProjectPreview(host, {
      manifest: {
        apiVersion: 1,
        id: "preview.context",
        name: "Context Preview",
        version: "1.0.0",
        entry: "index.html",
        permissions: ["codex.context.active", "codex.events.lifecycle"],
      },
      html: '<!doctype html><html><body><codex-experience-surface target="app-shell" plane="overlay"></codex-experience-surface></body></html>',
      digest: "d".repeat(64),
      surfaces: [{ target: "app-shell", plane: "overlay", interaction: "passthrough" }],
    }, {
      tokens: generateAppearanceTokens({ seed: "#6750A4" }).modes,
      codexContext: {
        connection: { state: "connected", provider: "test", updatedAt: now },
        activeThreadId: "thread-a",
        threads: [
          { threadId: "thread-a", sessionId: "session-a", displayName: "Must be redacted", status: "idle", active: true, unread: false, updatedAt: now },
          { threadId: "thread-b", sessionId: "session-b", status: "working", active: false, unread: false, updatedAt: now },
        ],
      },
    });
    handle.emitCodexEvent({
      type: "turnCompleted",
      observedAt: now + 1,
      threadId: "thread-b",
      sessionId: "session-b",
      turnId: "turn-b",
      outcome: "completed",
      completedAt: now + 1,
    });
    expect(handle.getState().codexContext.threads.find((thread) => thread.threadId === "thread-b")).toMatchObject({
      status: "completed",
      unread: true,
    });
    expect(handle.getState().codexContext.threads.find((thread) => thread.threadId === "thread-a")?.displayName).toBeUndefined();
    const srcdoc = handle.root.querySelector<HTMLIFrameElement>("iframe")?.srcdoc ?? "";
    expect(srcdoc).toContain("codex.context.active");
    expect(srcdoc).toContain("codex.events.lifecycle");
    expect(srcdoc).not.toContain("No real Codex data is loaded");
    handle.destroy();
    dom.window.close();
  });
});
