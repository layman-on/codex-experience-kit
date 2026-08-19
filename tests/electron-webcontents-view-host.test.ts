import { describe, expect, it } from "vitest";
import {
  ElectronWebContentsViewHost,
  type ElectronContentViewLike,
  type ElectronWebContentsViewLike,
} from "../src/node/electron-webcontents-view-host.js";

class FakeSession {
  permissionRequest?: (...args: any[]) => void;
  permissionCheck?: (...args: any[]) => boolean;
  download?: (...args: any[]) => void;
  setPermissionRequestHandler(handler: (...args: any[]) => void) { this.permissionRequest = handler; }
  setPermissionCheckHandler(handler: (...args: any[]) => boolean) { this.permissionCheck = handler; }
  on(_event: string, handler: (...args: any[]) => void) { this.download = handler; }
}

class FakeWebContents {
  readonly session = new FakeSession();
  readonly urls: string[] = [];
  readonly listeners = new Map<string, (...args: any[]) => void>();
  windowHandler?: (details: { url: string }) => { action: "allow" | "deny" };
  reloads = 0;
  closed = false;
  async loadURL(url: string) { this.urls.push(url); }
  reload() { this.reloads += 1; }
  close() { this.closed = true; }
  on(event: string, listener: (...args: any[]) => void) { this.listeners.set(event, listener); }
  setWindowOpenHandler(handler: (details: { url: string }) => { action: "allow" | "deny" }) { this.windowHandler = handler; }
}

class FakeView implements ElectronWebContentsViewLike {
  static instances: FakeView[] = [];
  readonly webContents = new FakeWebContents();
  readonly bounds: Array<{ x: number; y: number; width: number; height: number }> = [];
  readonly preferences: Record<string, unknown>;
  constructor(options: { webPreferences: Record<string, unknown> }) {
    this.preferences = options.webPreferences;
    FakeView.instances.push(this);
  }
  setBounds(value: { x: number; y: number; width: number; height: number }) { this.bounds.push(value); }
}

class FakeContentView implements ElectronContentViewLike {
  readonly attached = new Set<ElectronWebContentsViewLike>();
  addChildView(view: ElectronWebContentsViewLike) { this.attached.add(view); }
  removeChildView(view: ElectronWebContentsViewLike) { this.attached.delete(view); }
}

const mount = {
  op: "mount" as const,
  channel: "native-test",
  id: "webview-1",
  target: "app-shell" as const,
  plane: "overlay" as const,
  url: "https://www.baidu.com/",
  title: "Baidu",
  bounds: { x: 20, y: 50, width: 800, height: 600 },
  visible: true,
};

describe("ElectronWebContentsViewHost", () => {
  it("owns WebContentsView lifecycle, navigation and secure Electron preferences", async () => {
    FakeView.instances = [];
    const contentView = new FakeContentView();
    const host = new ElectronWebContentsViewHost({
      WebContentsView: FakeView,
      contentView,
      policy: { securityMode: "unrestricted" },
      allowUnrestrictedRemoteContent: true,
      partition: "example-experience-test",
      allowPermission: permission => permission === "clipboard-sanitized-write",
    });
    await host.dispatch(mount);
    const view = FakeView.instances[0]!;
    expect(contentView.attached.has(view)).toBe(true);
    expect(view.bounds).toEqual([{ x: 20, y: 50, width: 800, height: 600 }]);
    expect(view.webContents.urls).toEqual(["https://www.baidu.com/"]);
    expect(view.preferences).toMatchObject({
      partition: "example-experience-test",
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
    });

    await host.dispatch({ ...mount, op: "layout", bounds: mount.bounds, visible: false });
    expect(contentView.attached.has(view)).toBe(false);
    await host.dispatch({ ...mount, op: "layout", bounds: { x: 30, y: 60, width: 700, height: 500 }, visible: true });
    expect(contentView.attached.has(view)).toBe(true);
    expect(view.bounds.at(-1)).toEqual({ x: 30, y: 60, width: 700, height: 500 });

    expect(view.webContents.windowHandler?.({ url: "https://example.com/next" })).toEqual({ action: "deny" });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(view.webContents.urls.at(-1)).toBe("https://example.com/next");
    expect(view.webContents.windowHandler?.({ url: "file:///etc/passwd" })).toEqual({ action: "deny" });

    let permission = false;
    view.webContents.session.permissionRequest?.(view.webContents, "camera", (allowed: boolean) => { permission = allowed; }, {});
    expect(permission).toBe(false);
    view.webContents.session.permissionRequest?.(view.webContents, "clipboard-sanitized-write", (allowed: boolean) => { permission = allowed; }, {});
    expect(permission).toBe(true);
    const downloadEvent = { prevented: false, preventDefault() { this.prevented = true; } };
    view.webContents.session.download?.(downloadEvent, {}, view.webContents);
    expect(downloadEvent.prevented).toBe(true);

    await expect(host.dispatch({ ...mount, op: "navigate", url: "javascript:alert(1)" })).rejects.toThrow("security policy");
    await host.dispatch({ ...mount, op: "reload" });
    expect(view.webContents.reloads).toBe(1);
    await host.dispatch({ ...mount, op: "destroy" });
    expect(view.webContents.closed).toBe(true);
    expect(contentView.attached.size).toBe(0);
    await host.destroy();
  });

  it("rejects native mode without both unrestricted policy and host grant", () => {
    const contentView = new FakeContentView();
    expect(() => new ElectronWebContentsViewHost({
      WebContentsView: FakeView,
      contentView,
      policy: { securityMode: "strict", allowedOrigins: ["https://example.com"] },
      allowUnrestrictedRemoteContent: true,
    })).toThrow("securityMode=unrestricted");
    expect(() => new ElectronWebContentsViewHost({
      WebContentsView: FakeView,
      contentView,
      policy: { securityMode: "unrestricted" },
    })).toThrow("explicit unrestricted");
  });
});
