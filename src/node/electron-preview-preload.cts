const { contextBridge, ipcRenderer } = require("electron") as {
  contextBridge: { exposeInMainWorld(name: string, value: unknown): void };
  ipcRenderer: { invoke(channel: string, command: unknown): Promise<void> };
};

const NATIVE_WEBVIEW_IPC = "codex-experience:native-webview-v1";

contextBridge.exposeInMainWorld("codexExperienceNativeWebviews", Object.freeze({
  backend: "electron-webcontents-view",
  dispatch(command: unknown): Promise<void> {
    return ipcRenderer.invoke(NATIVE_WEBVIEW_IPC, command);
  },
}));
