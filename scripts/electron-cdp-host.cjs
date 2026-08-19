const { app, BrowserWindow } = require("electron");
const path = require("node:path");

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: false,
    },
  });
  window.webContents.on("console-message", (_event, _level, message) => {
    if (message.includes("Content Security Policy")) {
      process.stderr.write(`[fixture-csp] ${message}\n`);
    }
  });
  await window.loadFile(path.join(__dirname, "fixtures", "codex-csp-parent.html"));
  process.stdout.write("EXPERIENCE_CDP_HOST_READY\n");
});

process.on("SIGTERM", () => app.quit());
