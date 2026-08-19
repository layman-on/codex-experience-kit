import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateAppearanceTokens } from "../dist/core/appearance-tokens.js";
import { readExperienceProjectPackage } from "../dist/node/experience-project-package.js";
import { ExperienceProjectCdpTarget } from "../dist/node/experience-project-cdp-target.js";

const directory = path.dirname(fileURLToPath(import.meta.url));
const electronInput = process.env.CODEX_EXPERIENCE_ELECTRON;
const projectInput = process.env.CODEX_EXPERIENCE_PROJECT;

if (!electronInput || !projectInput) {
  throw new Error(
    "Set CODEX_EXPERIENCE_ELECTRON to an Electron executable and "
      + "CODEX_EXPERIENCE_PROJECT to a built Experience dist directory",
  );
}

const electron = path.resolve(electronInput);
const projectPath = path.resolve(projectInput);

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Unable to reserve a loopback port");
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function waitForTarget(port, process, output) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (process.exitCode !== null) throw new Error(`Electron fixture exited early: ${output.stderr}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      const target = targets.find((item) => item.type === "page" && item.url.includes("codex-csp-parent.html"));
      if (target?.webSocketDebuggerUrl && output.stdout.includes("EXPERIENCE_CDP_HOST_READY")) return target.webSocketDebuggerUrl;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out discovering the independent Electron target: ${output.stderr}`);
}

const port = await freePort();
const profile = await fs.mkdtemp(path.join(os.tmpdir(), "cek-electron-profile-"));
const output = { stdout: "", stderr: "" };
const child = spawn(electron, [
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`,
  path.join(directory, "electron-cdp-host.cjs"),
], { stdio: ["ignore", "pipe", "pipe"] });
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => { output.stdout += chunk; });
child.stderr.on("data", (chunk) => { output.stderr += chunk; });

let target;
try {
  const webSocketUrl = await waitForTarget(port, child, output);
  target = new ExperienceProjectCdpTarget(webSocketUrl, { requestTimeoutMs: 10_000 });
  const bundle = await readExperienceProjectPackage({ kind: "directory", path: projectPath });
  const payload = {
    ...bundle,
    appearance: "light",
    tokens: generateAppearanceTokens({ seed: "#7056c7" }).modes,
  };
  const receipt = await target.apply(payload, new AbortController().signal);
  const active = await target.probe();
  await target.cancel(receipt);
  const cancelled = await target.probe();
  process.stdout.write(`${JSON.stringify({
    active,
    cancelled,
    electronCspViolations: output.stderr.split("\n").filter((line) => line.includes("fixture-csp")),
    htmlBytes: Buffer.byteLength(bundle.html),
    projectId: bundle.manifest.id,
    receipt,
    surfaces: bundle.surfaces,
  }, null, 2)}\n`);
} finally {
  await target?.close().catch(() => undefined);
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
  await fs.rm(profile, { recursive: true, force: true });
}
