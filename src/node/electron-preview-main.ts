import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import type { ExperienceNativeWebviewCommand } from "../core/native-webview.js";
import { checkExperienceProject } from "./experience-project-tools.js";
import { ElectronWebContentsViewHost } from "./electron-webcontents-view-host.js";

const NATIVE_WEBVIEW_IPC = "codex-experience:native-webview-v1";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function loopbackUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "http:" || (url.hostname !== "127.0.0.1" && url.hostname !== "localhost" && url.hostname !== "::1")) {
    throw new Error("Native Experience preview accepts only a loopback HTTP preview URL");
  }
  url.searchParams.set("__codexExperienceNative", "1");
  return url;
}

async function main(): Promise<void> {
  const projectPath = argument("--project");
  const previewInput = argument("--url");
  if (!projectPath || !previewInput) throw new Error("Native preview requires --project and --url");
  const project = await checkExperienceProject(path.resolve(projectPath));
  const previewUrl = loopbackUrl(previewInput);
  const electronModule = "electron";
  const electron = await import(electronModule) as any;
  await electron.app.whenReady();
  const window = new electron.BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 900,
    minHeight: 640,
    show: false,
    title: `${project.manifest.name} · Native Preview`,
    backgroundColor: "#e9ebf2",
    webPreferences: {
      preload: fileURLToPath(new URL("./electron-preview-preload.cjs", import.meta.url)),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  let nativeHost: ElectronWebContentsViewHost | null = null;
  const ensureNativeHost = (): ElectronWebContentsViewHost => {
    if (nativeHost) return nativeHost;
    if (project.manifest.webviews?.securityMode !== "unrestricted") {
      throw new Error("This project does not declare unrestricted native remote content");
    }
    if (!process.argv.includes("--allow-unrestricted-remote-content")) {
      throw new Error("Native remote content requires --allow-unrestricted-remote-content");
    }
    nativeHost = new ElectronWebContentsViewHost({
      WebContentsView: electron.WebContentsView,
      contentView: window.contentView,
      policy: project.manifest.webviews,
      allowUnrestrictedRemoteContent: true,
      partition: `preview-${project.manifest.id}`,
      onWindowOpen: () => "same-view",
      openExternal: (url) => electron.shell.openExternal(url),
      onStatus(status) {
        if (!window.isDestroyed()) window.webContents.send("codex-experience:native-webview-status-v1", status);
      },
    });
    return nativeHost;
  };

  electron.ipcMain.handle(NATIVE_WEBVIEW_IPC, async (event: { sender: unknown }, command: ExperienceNativeWebviewCommand) => {
    if (event.sender !== window.webContents) throw new Error("Native WebView command came from an untrusted renderer");
    await ensureNativeHost().dispatch(command);
  });
  window.webContents.on("did-start-navigation", (_event: unknown, _url: string, _sameDocument: boolean, isMainFrame: boolean) => {
    if (!isMainFrame || !nativeHost) return;
    const previous = nativeHost;
    nativeHost = null;
    void previous.destroy();
  });
  window.once("ready-to-show", () => window.show());
  window.once("closed", () => {
    electron.ipcMain.removeHandler(NATIVE_WEBVIEW_IPC);
    void nativeHost?.destroy();
    nativeHost = null;
  });
  await window.loadURL(previewUrl.href);
  electron.app.on("window-all-closed", () => electron.app.quit());
}

void main().catch(async (error) => {
  console.error(`[tool/native-preview] ${error instanceof Error ? error.message : String(error)}`);
  const electronModule = "electron";
  try { (await import(electronModule) as any).app.quit(); } catch { process.exitCode = 1; }
});
