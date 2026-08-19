globalThis.__codexCspProbe = {
  frameLoaded: false,
  inlineScriptRan: false,
  messages: [],
};

addEventListener("message", (event) => {
  globalThis.__codexCspProbe.messages.push(event.data);
  if (event.data === "experience-inline-script-ran") {
    globalThis.__codexCspProbe.inlineScriptRan = true;
  }
});

globalThis.__createCodexCspProbeFrame = () => {
  const frame = document.createElement("iframe");
  frame.setAttribute("name", "codex-experience-csp-probe");
  frame.setAttribute("sandbox", "allow-scripts");
  frame.addEventListener("load", () => {
    globalThis.__codexCspProbe.frameLoaded = true;
  }, { once: true });
  frame.srcdoc = `<!doctype html>
  <html>
    <head>
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'">
    </head>
    <body>
      <script>parent.postMessage("experience-inline-script-ran", "*")<\/script>
    </body>
  </html>`;
  document.body.append(frame);
};
