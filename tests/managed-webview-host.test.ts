import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { ManagedWebviewHost, type ManagedWebviewSurface } from "../src/preview/managed-webview-host.js";

function managedDocument(frame: HTMLIFrameElement): string {
  const prefix = "data:text/html;charset=utf-8,";
  expect(frame.src.startsWith(prefix)).toBe(true);
  return decodeURIComponent(frame.src.slice(prefix.length));
}

describe("ManagedWebviewHost", () => {
  it("mounts remote content as a host-owned sibling with an isolated wrapper", () => {
    const dom = new JSDOM('<!doctype html><div id="owner"></div>');
    try {
      Object.defineProperty(dom.window.HTMLIFrameElement.prototype, "credentialless", {
        configurable: true,
        value: false,
        writable: true,
      });
      const owner = dom.window.document.querySelector<HTMLElement>("#owner")!;
      const surfaceFrame = dom.window.document.createElement("iframe");
      Object.assign(surfaceFrame.style, { position: "absolute", zIndex: "20" });
      owner.appendChild(surfaceFrame);
      const surface: ManagedWebviewSurface = {
        frame: surfaceFrame,
        owner,
        channel: "surface-channel",
        target: "app-shell",
        plane: "overlay",
        interaction: "interactive",
      };
      const host = new ManagedWebviewHost({ securityMode: "strict", allowedOrigins: ["https://example.com"] });
      host.handle(surface, {
        op: "mount",
        id: "webview-1",
        url: "https://example.com/start",
        title: 'Remote <App>',
        rect: { x: 12, y: 18, width: 320, height: 180, visible: true },
      });
      const wrapper = owner.querySelector<HTMLIFrameElement>('iframe[data-codex-experience-webview-host="webview-1"]')!;
      expect(wrapper).not.toBeNull();
      expect(wrapper.previousElementSibling).toBe(surfaceFrame);
      expect(wrapper.style.left).toBe("12px");
      expect(wrapper.style.top).toBe("18px");
      expect(wrapper.style.width).toBe("320px");
      expect(wrapper.style.height).toBe("180px");
      expect(wrapper.style.zIndex).toBe("21");
      expect(wrapper.getAttribute("sandbox")).toBe("allow-scripts allow-forms allow-same-origin");
      const document = managedDocument(wrapper);
      expect(wrapper.srcdoc).toBe("");
      expect(document).toContain("frame-src https://example.com");
      expect(document).toContain("sandbox=\"allow-scripts allow-forms allow-same-origin\"");
      expect(document).toContain("credentialless");
      expect(document).toContain("referrerpolicy=\"no-referrer\"");
      expect(document).toContain("Remote &lt;App&gt;");
      expect(() => host.handle(surface, {
        op: "navigate",
        id: "webview-1",
        url: "https://evil.example/path",
      })).toThrow("project security policy");
      host.handle(surface, {
        op: "layout",
        id: "webview-1",
        rect: { x: 20, y: 30, width: 200, height: 100, visible: false },
      });
      expect(wrapper.hidden).toBe(true);
      host.handle(surface, { op: "destroy", id: "webview-1" });
      expect(wrapper.isConnected).toBe(false);
    } finally {
      dom.window.close();
    }
  });

  it("keeps permissive content credentialless while allowing arbitrary HTTP(S) origins", () => {
    const dom = new JSDOM('<!doctype html><div id="owner"></div>');
    try {
      Object.defineProperty(dom.window.HTMLIFrameElement.prototype, "credentialless", { configurable: true, value: false });
      const owner = dom.window.document.querySelector<HTMLElement>("#owner")!;
      const surfaceFrame = dom.window.document.createElement("iframe");
      owner.appendChild(surfaceFrame);
      const surface: ManagedWebviewSurface = {
        frame: surfaceFrame, owner, channel: "permissive", target: "app-shell", plane: "overlay", interaction: "interactive",
      };
      const host = new ManagedWebviewHost({ securityMode: "permissive" });
      host.handle(surface, {
        op: "mount", id: "webview-1", url: "http://different.example/path", rect: { x: 0, y: 0, width: 100, height: 100, visible: true },
      });
      const wrapper = owner.querySelector<HTMLIFrameElement>('[data-codex-experience-webview-host]')!;
      expect(wrapper.getAttribute("sandbox")).toContain("allow-same-origin");
      const document = managedDocument(wrapper);
      expect(document).toContain("frame-src https: http:");
      expect(document).toContain("credentialless");
      expect(() => host.handle(surface, { op: "navigate", id: "webview-1", url: "file:///etc/passwd" })).toThrow("project security policy");
    } finally {
      dom.window.close();
    }
  });

  it("requires a host grant before removing package WebView restrictions", () => {
    const dom = new JSDOM('<!doctype html><div id="owner"></div>');
    try {
      const owner = dom.window.document.querySelector<HTMLElement>("#owner")!;
      const surfaceFrame = dom.window.document.createElement("iframe");
      owner.appendChild(surfaceFrame);
      const surface: ManagedWebviewSurface = {
        frame: surfaceFrame, owner, channel: "unsafe", target: "app-shell", plane: "overlay", interaction: "interactive",
      };
      const request = {
        op: "mount", id: "webview-1", url: "http://untrusted.example/path", rect: { x: 0, y: 0, width: 100, height: 100, visible: true },
      };
      const denied = new ManagedWebviewHost({ securityMode: "unrestricted" });
      expect(() => denied.handle(surface, request)).toThrow("explicit host grant");
      expect(owner.querySelector('[data-codex-experience-webview-host]')).toBeNull();

      const granted = new ManagedWebviewHost(
        { securityMode: "unrestricted" },
        { allowUnrestrictedRemoteContent: true },
      );
      granted.handle(surface, request);
      const wrapper = owner.querySelector<HTMLIFrameElement>('[data-codex-experience-webview-host]')!;
      expect(wrapper.hasAttribute("sandbox")).toBe(false);
      expect(wrapper.hasAttribute("referrerpolicy")).toBe(false);
      expect(wrapper.getAttribute("allow")).toContain("camera *");
      expect(wrapper.src).toBe("http://untrusted.example/path");
      granted.handle(surface, { op: "navigate", id: "webview-1", url: "https://another.example/next" });
      expect(wrapper.src).toBe("https://another.example/next");
    } finally {
      dom.window.close();
    }
  });

  it("rejects unsupported credentialless frames without appending a wrapper", () => {
    const dom = new JSDOM('<!doctype html><div id="owner"></div>');
    try {
      const owner = dom.window.document.querySelector<HTMLElement>("#owner")!;
      const surfaceFrame = dom.window.document.createElement("iframe");
      owner.appendChild(surfaceFrame);
      const surface: ManagedWebviewSurface = {
        frame: surfaceFrame,
        owner,
        channel: "surface-channel",
        target: "app-shell",
        plane: "overlay",
        interaction: "interactive",
      };
      const host = new ManagedWebviewHost({ securityMode: "strict", allowedOrigins: ["https://example.com"] });
      expect(() => host.handle(surface, {
        op: "mount",
        id: "webview-1",
        url: "https://example.com",
        title: "Remote",
        rect: { x: 0, y: 0, width: 100, height: 100, visible: true },
      })).toThrow("Credentialless WebView frames are not supported");
      expect(owner.querySelector("[data-codex-experience-webview-host]")).toBeNull();
    } finally {
      dom.window.close();
    }
  });
});
