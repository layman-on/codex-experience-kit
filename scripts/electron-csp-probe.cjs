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
  const violations = [];
  const debuggerEvents = [];
  window.webContents.on("console-message", (_event, _level, message) => {
    if (message.includes("Content Security Policy")) violations.push(message);
  });
  try {
    await window.loadFile(path.join(__dirname, "fixtures", "codex-csp-parent.html"));
    window.webContents.debugger.attach("1.3");
    let resolveChildInstalled;
    let rejectChildInstalled;
    const childInstalled = new Promise((resolve, reject) => {
      resolveChildInstalled = resolve;
      rejectChildInstalled = reject;
    });
    window.webContents.debugger.on("message", (_event, method, params) => {
      if (method === "Runtime.executionContextCreated") {
        debuggerEvents.push({ method, context: params.context });
      }
      if (method === "Runtime.consoleAPICalled") {
        debuggerEvents.push({ method, args: params.args?.map((argument) => argument.value) });
      }
      if (method === "Target.attachedToTarget") {
        debuggerEvents.push({ method, sessionId: params.sessionId, targetInfo: params.targetInfo });
        void (async () => {
          try {
            const sessionId = params.sessionId;
            await window.webContents.debugger.sendCommand("Runtime.enable", {}, sessionId);
            const name = await window.webContents.debugger.sendCommand("Runtime.evaluate", {
              expression: "window.name",
              returnByValue: true,
            }, sessionId);
            if (name.result?.value === "codex-experience-csp-probe") {
              await window.webContents.debugger.sendCommand("Runtime.evaluate", {
                expression: `(() => {
                  const run = () => parent.postMessage("experience-auto-attached-script-ran", "*");
                  document.readyState === "loading"
                    ? addEventListener("DOMContentLoaded", run, { once: true })
                    : run();
                })()`,
                returnByValue: true,
              }, sessionId);
              resolveChildInstalled({ name, sessionId, targetInfo: params.targetInfo });
            }
            await window.webContents.debugger.sendCommand("Runtime.runIfWaitingForDebugger", {}, sessionId);
          } catch (error) {
            rejectChildInstalled(error);
          }
        })();
      }
    });
    await window.webContents.debugger.sendCommand("Runtime.enable");
    await window.webContents.debugger.sendCommand("Page.enable");
    const isolated = await window.webContents.debugger.sendCommand(
      "Page.addScriptToEvaluateOnNewDocument",
      {
        worldName: "codex-experience-csp-probe",
        source: `(() => {
          console.log("isolated-probe", window.name, location.href);
          if (window.name !== "codex-experience-csp-probe") return;
          const run = () => parent.postMessage("experience-isolated-script-ran", "*");
          document.readyState === "loading"
            ? addEventListener("DOMContentLoaded", run, { once: true })
            : run();
        })()`,
      },
    );
    await window.webContents.debugger.sendCommand("Target.setAutoAttach", {
      autoAttach: true,
      flatten: true,
      waitForDebuggerOnStart: true,
    });
    await window.webContents.executeJavaScript("globalThis.__createCodexCspProbeFrame()");
    const autoAttached = await Promise.race([
      childInstalled,
      new Promise((_, reject) => setTimeout(() => reject(new Error("Timed out auto-attaching the Experience iframe target")), 3000)),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 400));
    const probe = await window.webContents.executeJavaScript("globalThis.__codexCspProbe");
    process.stdout.write(`${JSON.stringify({ autoAttached, debuggerEvents, isolated, probe, violations }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
