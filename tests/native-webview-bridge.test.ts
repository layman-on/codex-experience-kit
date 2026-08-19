import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import type { ExperienceNativeWebviewCommand, ExperienceNativeWebviewTransport } from "../src/core/native-webview.js";
import type { ManagedWebviewSurface } from "../src/preview/managed-webview-host.js";
import { NativeWebviewBridge } from "../src/preview/native-webview-bridge.js";

describe("NativeWebviewBridge", () => {
  it("translates author-frame coordinates into clipped Electron content bounds", () => {
    const dom = new JSDOM('<!doctype html><div id="owner"></div>');
    try {
      const owner = dom.window.document.querySelector<HTMLElement>("#owner")!;
      const frame = dom.window.document.createElement("iframe");
      owner.appendChild(frame);
      Object.defineProperty(frame, "clientWidth", { configurable: true, value: 200 });
      Object.defineProperty(frame, "clientHeight", { configurable: true, value: 150 });
      frame.getBoundingClientRect = () => ({
        x: 20, y: 40, left: 20, top: 40, right: 420, bottom: 340, width: 400, height: 300,
        toJSON: () => undefined,
      });
      const surface: ManagedWebviewSurface = {
        frame, owner, channel: "surface-channel", target: "app-shell", plane: "overlay", interaction: "interactive",
      };
      const commands: ExperienceNativeWebviewCommand[] = [];
      const transport: ExperienceNativeWebviewTransport = {
        backend: "electron-webcontents-view",
        dispatch(command) { commands.push(command); },
      };
      const bridge = new NativeWebviewBridge(transport, { securityMode: "unrestricted" }, {
        allowUnrestrictedRemoteContent: true,
      });
      bridge.handle(surface, {
        op: "mount",
        id: "webview-1",
        url: "https://www.baidu.com/",
        title: "Baidu",
        rect: { x: 10, y: 5, width: 100, height: 50, visible: true },
      });
      expect(commands[0]).toEqual({
        op: "mount",
        channel: "surface-channel",
        id: "webview-1",
        target: "app-shell",
        plane: "overlay",
        url: "https://www.baidu.com/",
        title: "Baidu",
        bounds: { x: 40, y: 50, width: 200, height: 100 },
        visible: true,
      });
      bridge.handle(surface, {
        op: "layout",
        id: "webview-1",
        rect: { x: -10, y: -10, width: 50, height: 50, visible: true },
      });
      expect(commands[1]).toMatchObject({ op: "layout", bounds: { x: 20, y: 40, width: 80, height: 80 }, visible: true });
      bridge.setSurfaceVisible(surface, false);
      expect(commands[2]).toMatchObject({ op: "layout", visible: false });
      bridge.destroy();
      expect(commands.at(-1)).toMatchObject({ op: "destroy", id: "webview-1" });
    } finally {
      dom.window.close();
    }
  });

  it("requires unrestricted policy plus an independent host grant", () => {
    const transport: ExperienceNativeWebviewTransport = { backend: "electron-webcontents-view", dispatch() {} };
    expect(() => new NativeWebviewBridge(transport, { securityMode: "strict", allowedOrigins: ["https://example.com"] }, {
      allowUnrestrictedRemoteContent: true,
    })).toThrow("securityMode=unrestricted");
    expect(() => new NativeWebviewBridge(transport, { securityMode: "unrestricted" })).toThrow("explicit host grant");
  });
});
