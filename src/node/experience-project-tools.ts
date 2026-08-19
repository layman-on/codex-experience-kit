import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import http, { type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { strToU8, zipSync } from "fflate";
import { ExperienceKitError, ExperienceValidationError } from "../core/errors.js";
import { buildExperienceViewHtml } from "../core/experience-runtime.js";
import {
  EXPERIENCE_PLANES,
  EXPERIENCE_TARGETS,
  discoverExperienceSurfaces,
  experienceSurfaceKey,
  experienceWebviewRiskMetadata,
  parseExperienceProjectManifest,
  type ExperiencePlane,
  type ExperienceProjectBundle,
  type ExperienceProjectManifest,
  type ExperienceSurfaceDeclaration,
  type ExperienceTarget,
  type ExperienceWebviewRiskMetadata,
} from "../core/experience-project.js";
import { generateAppearanceTokens, type AppearanceContrast, type AppearanceTokenModes } from "../core/appearance-tokens.js";
import { createExperienceProjectStarterFiles, type ExperienceProjectStarterOptions } from "../template/index.js";
import type { CodexSessionInstance } from "./codex-app-session.js";
import type { CodexTransferCatalog } from "./codex-instance-transfer.js";
import type { IsolatedCodexInstanceStatus } from "./isolated-codex-instance.js";
import type {
  OpenConfiguredIsolatedCodexOptions,
  OpenConfiguredIsolatedCodexResult,
  OpenManagedIsolatedCodexResult,
} from "./isolated-codex-workflow.js";
import {
  buildExperienceFrameworkSources,
  type ExperienceAuthoringFramework,
} from "./experience-framework-builder.js";
import { readExperienceProjectPackage } from "./experience-project-package.js";

interface ExperienceProjectConfig {
  sourceDir: string;
  outDir: string;
  assetsDir: string;
  appearance: { seed: string; contrast: AppearanceContrast; darkSeed?: string };
  authoring?: { framework: ExperienceAuthoringFramework; entry: string; surfaces: ExperienceSurfaceDeclaration[] };
  preview?: { tools: ExperiencePreviewTool[] };
}

type ExperiencePreviewTool = "codex-secondary-instance";

export interface BuildExperienceProjectResult {
  directory: string;
  manifest: ExperienceProjectManifest;
  surfaces: ExperienceSurfaceDeclaration[];
  tokens: ReturnType<typeof generateAppearanceTokens>["modes"];
}

export interface PackExperienceProjectResult {
  path: string;
  bytes: number;
}

export interface ExperienceDevServer {
  readonly url: string;
  readonly remoteContentRisk: ExperienceWebviewRiskMetadata;
  close(): Promise<void>;
}

export interface ExperienceDevControlRuntime {
  listCodexInstances?(): Promise<CodexSessionInstance[]>;
  inspectSecondaryCodexInstance?(): Promise<IsolatedCodexInstanceStatus>;
  getSecondaryCodexTransferCatalog?(): Promise<CodexTransferCatalog>;
  openSecondaryCodexInstance?(): Promise<OpenManagedIsolatedCodexResult>;
  openConfiguredSecondaryCodexInstance?(options: OpenConfiguredIsolatedCodexOptions): Promise<OpenConfiguredIsolatedCodexResult>;
  apply(reference: string, options: {
    tokens: AppearanceTokenModes;
    appearance: "light" | "dark";
    allowRestart: boolean;
    allowUnrestrictedRemoteContent: boolean;
    targetId?: string;
  }): Promise<unknown>;
  cancel(): Promise<unknown>;
  shutdown(): Promise<void>;
}

export interface ExperienceDevServerOptions {
  host?: string;
  port?: number;
  runtimeFactory?: () => ExperienceDevControlRuntime | Promise<ExperienceDevControlRuntime>;
  allowUnrestrictedRemoteContent?: boolean;
}

const CONFIG_NAME = "experience.config.json";
const MANIFEST_NAME = "experience.manifest.json";

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ExperienceValidationError("tool/config", `${label} must be an object`);
  return value as Record<string, unknown>;
}

function escapeHtmlText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function relativeDirectory(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || path.isAbsolute(value)) throw new ExperienceValidationError("tool/config", `${label} must be a relative directory`);
  const normalized = path.normalize(value);
  if (normalized === "." || normalized.startsWith(`..${path.sep}`) || normalized === "..") throw new ExperienceValidationError("tool/config", `${label} must stay inside the project`);
  return normalized;
}

function frameworkEntry(value: unknown): string {
  if (typeof value !== "string" || !value || path.isAbsolute(value)) {
    throw new ExperienceValidationError("tool/config", "authoring.entry must be a relative source file");
  }
  const normalized = path.normalize(value);
  if (normalized === "." || normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
    throw new ExperienceValidationError("tool/config", "authoring.entry must stay inside sourceDir");
  }
  return normalized;
}

function configuredSurfaces(value: unknown): ExperienceSurfaceDeclaration[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ExperienceValidationError("tool/config", "authoring.surfaces must contain at least one surface");
  }
  const surfaces = value.map((item, index) => {
    const source = object(item, `authoring.surfaces[${index}]`);
    const allowed = new Set(["target", "plane", "interaction"]);
    for (const key of Object.keys(source)) {
      if (!allowed.has(key)) throw new ExperienceValidationError("tool/config", `Unknown authoring surface field: ${key}`);
    }
    const target = source.target;
    const plane = source.plane;
    const interaction = source.interaction ?? "passthrough";
    if (!EXPERIENCE_TARGETS.includes(target as ExperienceTarget)) {
      throw new ExperienceValidationError("tool/config", `Unsupported authoring surface target: ${String(target)}`);
    }
    if (!EXPERIENCE_PLANES.includes(plane as ExperiencePlane)) {
      throw new ExperienceValidationError("tool/config", `Unsupported authoring surface plane: ${String(plane)}`);
    }
    if (interaction !== "passthrough" && interaction !== "scoped" && interaction !== "interactive") {
      throw new ExperienceValidationError("tool/config", "Authoring surface interaction must be passthrough, scoped, or interactive");
    }
    if (plane === "underlay" && interaction !== "passthrough") {
      throw new ExperienceValidationError("tool/config", `underlay:${String(target)} must use passthrough interaction`);
    }
    if (target === "floating-window" && (plane !== "overlay" || interaction === "passthrough")) {
      throw new ExperienceValidationError("tool/config", "floating-window must be an interactive or scoped overlay");
    }
    return {
      target: target as ExperienceTarget,
      plane: plane as ExperiencePlane,
      interaction: interaction as "passthrough" | "scoped" | "interactive",
    };
  });
  const keys = surfaces.map(experienceSurfaceKey);
  if (new Set(keys).size !== keys.length) {
    throw new ExperienceValidationError("tool/config", "authoring.surfaces must not repeat a target/plane pair");
  }
  return surfaces;
}

async function readConfig(root: string): Promise<ExperienceProjectConfig> {
  const raw = object(JSON.parse(await fs.readFile(path.join(root, CONFIG_NAME), "utf8")), CONFIG_NAME);
  const appearance = object(raw.appearance, "appearance");
  const contrast = appearance.contrast ?? "standard";
  if (contrast !== "soft" && contrast !== "standard" && contrast !== "high") throw new ExperienceValidationError("tool/config", "appearance.contrast is invalid");
  if (typeof appearance.seed !== "string") throw new ExperienceValidationError("tool/config", "appearance.seed is required");
  if (appearance.darkSeed !== undefined && typeof appearance.darkSeed !== "string") throw new ExperienceValidationError("tool/config", "appearance.darkSeed must be a color");
  let authoring: ExperienceProjectConfig["authoring"];
  if (raw.authoring !== undefined) {
    const authoringSource = object(raw.authoring, "authoring");
    const framework = authoringSource.framework;
    if (framework !== "react" && framework !== "vue") {
      throw new ExperienceValidationError("tool/config", "authoring.framework must be react or vue");
    }
    authoring = {
      framework,
      entry: frameworkEntry(authoringSource.entry),
      surfaces: configuredSurfaces(authoringSource.surfaces),
    };
  }
  let preview: ExperienceProjectConfig["preview"];
  if (raw.preview !== undefined) {
    const previewSource = object(raw.preview, "preview");
    for (const key of Object.keys(previewSource)) {
      if (key !== "tools") throw new ExperienceValidationError("tool/config", `Unknown preview field: ${key}`);
    }
    if (!Array.isArray(previewSource.tools) || previewSource.tools.some((tool) => tool !== "codex-secondary-instance")) {
      throw new ExperienceValidationError("tool/config", "preview.tools contains an unsupported preview-only tool");
    }
    preview = { tools: [...new Set(previewSource.tools)] as ExperiencePreviewTool[] };
  }
  return {
    sourceDir: relativeDirectory(raw.sourceDir ?? "src", "sourceDir"),
    outDir: relativeDirectory(raw.outDir ?? "dist", "outDir"),
    assetsDir: relativeDirectory(raw.assetsDir ?? "assets", "assetsDir"),
    appearance: { seed: appearance.seed, contrast, ...(typeof appearance.darkSeed === "string" ? { darkSeed: appearance.darkSeed } : {}) },
    ...(authoring ? { authoring } : {}),
    ...(preview ? { preview } : {}),
  };
}

async function optionalText(filePath: string): Promise<string | null> {
  try { return await fs.readFile(filePath, "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function sharedSourceText(sourceRoot: string, name: "styles.css" | "main.js"): Promise<string> {
  const canonicalPath = path.join(sourceRoot, "shared", name);
  const legacyPath = path.join(sourceRoot, name);
  const [canonical, legacy] = await Promise.all([optionalText(canonicalPath), optionalText(legacyPath)]);
  if (canonical !== null && legacy !== null) {
    throw new ExperienceValidationError(
      "tool/shared-source",
      `Use src/shared/${name}; remove the legacy src/${name} duplicate`,
    );
  }
  return canonical ?? legacy ?? "";
}

function surfaceSource(target: ExperienceTarget, plane: ExperiencePlane, html: string): ExperienceSurfaceDeclaration {
  const surfaces = discoverExperienceSurfaces(html);
  if (surfaces.length !== 1 || surfaces[0]?.target !== target || surfaces[0].plane !== plane) {
    throw new ExperienceValidationError("tool/surface", `src/surfaces/${target}/${plane}.html must declare exactly ${plane}:${target}`);
  }
  return surfaces[0];
}

function safeInline(value: string, tag: "style" | "script"): string {
  if (new RegExp(`</${tag}`, "iu").test(value)) throw new ExperienceValidationError("tool/source", `src contains an unsafe closing ${tag} tag`);
  return value;
}

async function copyAssets(source: string, destination: string): Promise<void> {
  try {
    const stat = await fs.lstat(source);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ExperienceValidationError("tool/assets", "assetsDir must be a real directory");
    await fs.cp(source, destination, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: false });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function initializeExperienceProject(directory: string, input: ExperienceProjectStarterOptions = {}): Promise<string> {
  const root = path.resolve(directory);
  const existing = await fs.readdir(root).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (existing && existing.length > 0) throw new ExperienceValidationError("tool/init", `Refusing to initialize a non-empty directory: ${root}`);
  await fs.mkdir(root, { recursive: true });
  const files = createExperienceProjectStarterFiles(input);
  for (const [name, value] of Object.entries(files)) {
    const destination = path.join(root, name);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, value, { flag: "wx" });
  }
  return root;
}

export async function buildExperienceProject(rootPath = process.cwd()): Promise<BuildExperienceProjectResult> {
  const root = await fs.realpath(rootPath);
  const config = await readConfig(root);
  const sourceRoot = path.join(root, config.sourceDir);
  const manifest = parseExperienceProjectManifest(JSON.parse(await fs.readFile(path.join(root, MANIFEST_NAME), "utf8")));
  let fragments: string[] = [];
  let surfaces: ExperienceSurfaceDeclaration[] = [];
  let cssSource: string;
  let javascriptSource: string;
  let frameworkStage: string | null = null;
  if (config.authoring) {
    surfaces = config.authoring.surfaces;
    fragments = surfaces.map((surface) => {
      const key = experienceSurfaceKey(surface);
      return `<codex-experience-surface target="${surface.target}" plane="${surface.plane}" interaction="${surface.interaction}"><div data-codex-experience-mount="${key}"></div></codex-experience-surface>`;
    });
    frameworkStage = path.join(root, `.experience-framework-${randomUUID()}`);
    const framework = await buildExperienceFrameworkSources({
      root,
      sourceRoot,
      entry: config.authoring.entry,
      framework: config.authoring.framework,
      outDir: frameworkStage,
    }).catch(async (error) => {
      await fs.rm(frameworkStage!, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    });
    cssSource = framework.css;
    javascriptSource = framework.javascript;
  } else {
    for (const target of EXPERIENCE_TARGETS) {
      for (const plane of EXPERIENCE_PLANES) {
        const value = await optionalText(path.join(sourceRoot, "surfaces", target, `${plane}.html`));
        if (value === null || !value.trim()) continue;
        surfaces.push(surfaceSource(target, plane, value));
        fragments.push(value.trim());
      }
    }
    [cssSource, javascriptSource] = await Promise.all([
      sharedSourceText(sourceRoot, "styles.css"),
      sharedSourceText(sourceRoot, "main.js"),
    ]);
  }
  if (surfaces.length === 0) throw new ExperienceValidationError("tool/surface", "The project must provide at least one source surface");
  const css = safeInline(cssSource, "style");
  const javascript = safeInline(javascriptSource, "script");
  const html = `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="UTF-8">\n<meta name="viewport" content="width=device-width,initial-scale=1">\n<title>${manifest.name.replaceAll("&", "&amp;").replaceAll("<", "&lt;")}</title>\n<style>${css}</style>\n</head>\n<body>\n${fragments.join("\n")}\n<script>${javascript}</script>\n</body>\n</html>\n`;
  const stage = path.join(root, `.${config.outDir.replaceAll(path.sep, "-")}-${randomUUID()}`);
  const destination = path.join(root, config.outDir);
  await fs.mkdir(stage, { recursive: true });
  try {
    await Promise.all([
      fs.writeFile(path.join(stage, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`),
      fs.writeFile(path.join(stage, "index.html"), html),
      copyAssets(path.join(root, config.assetsDir), path.join(stage, "assets")),
    ]);
    await readExperienceProjectPackage({ kind: "directory", path: stage });
    const backup = `${destination}.backup-${randomUUID()}`;
    const hasDestination = await fs.lstat(destination).then(() => true, (error) => (error as NodeJS.ErrnoException).code === "ENOENT" ? false : Promise.reject(error));
    if (hasDestination) await fs.rename(destination, backup);
    try {
      await fs.rename(stage, destination);
    } catch (error) {
      if (hasDestination) await fs.rename(backup, destination).catch(() => undefined);
      throw error;
    }
    if (hasDestination) await fs.rm(backup, { recursive: true, force: false }).catch(() => undefined);
  } finally {
    await fs.rm(stage, { recursive: true, force: true }).catch(() => undefined);
    if (frameworkStage) await fs.rm(frameworkStage, { recursive: true, force: true }).catch(() => undefined);
  }
  return { directory: destination, manifest, surfaces, tokens: generateAppearanceTokens(config.appearance).modes };
}

export async function checkExperienceProject(rootPath = process.cwd()): Promise<ExperienceProjectBundle> {
  const root = await fs.realpath(rootPath);
  const config = await readConfig(root);
  return readExperienceProjectPackage({ kind: "directory", path: path.join(root, config.outDir) });
}

async function filesForZip(directory: string, prefix = ""): Promise<Record<string, Uint8Array>> {
  const output: Record<string, Uint8Array> = {};
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new ExperienceValidationError("tool/pack", `Symbolic link is not allowed: ${entry.name}`);
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) Object.assign(output, await filesForZip(absolute, name));
    else if (entry.isFile()) output[name] = new Uint8Array(await fs.readFile(absolute));
  }
  return output;
}

export async function packExperienceProject(rootPath = process.cwd()): Promise<PackExperienceProjectResult> {
  const root = await fs.realpath(rootPath);
  const config = await readConfig(root);
  const bundle = await checkExperienceProject(root);
  const archive = zipSync(await filesForZip(path.join(root, config.outDir)), { level: 6 });
  const releases = path.join(root, "releases");
  await fs.mkdir(releases, { recursive: true });
  const destination = path.join(releases, `${bundle.manifest.id}-${bundle.manifest.version}.zip`);
  await fs.writeFile(destination, archive);
  return { path: destination, bytes: archive.byteLength };
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function isLoopbackOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:")
      && (isLoopbackHost(url.hostname) || url.hostname === "[::1]")
      && !url.username
      && !url.password
      && url.pathname === "/"
      && !url.search
      && !url.hash;
  } catch {
    return false;
  }
}

function allowLoopbackCors(request: IncomingMessage, response: ServerResponse): boolean {
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  if (Array.isArray(origin) || !isLoopbackOrigin(origin)) return false;
  response.setHeader("Access-Control-Allow-Origin", origin);
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Codex-Experience-Control");
  response.setHeader("Access-Control-Max-Age", "600");
  response.setHeader("Vary", "Origin");
  return true;
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(value ?? null));
}

function controlErrorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") return error.code;
  return "tool/dev-control";
}

function controlErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readControlBody(request: IncomingMessage, maxBytes = 4_096): Promise<Record<string, unknown>> {
  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") throw new ExperienceValidationError("tool/dev-control-content-type", "Experience control requires application/json");
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += value.byteLength;
    if (bytes > maxBytes) throw new ExperienceValidationError("tool/dev-control-body", "Experience control request is too large");
    chunks.push(value);
  }
  if (chunks.length === 0) return {};
  try {
    return object(JSON.parse(Buffer.concat(chunks).toString("utf8")), "Experience control body");
  } catch (error) {
    if (error instanceof ExperienceValidationError) throw error;
    throw new ExperienceValidationError("tool/dev-control-body", "Experience control body must be valid JSON");
  }
}

function previewHtml(
  bundle: ExperienceProjectBundle,
  config: ExperienceProjectConfig,
  version: number,
  controlToken: string,
  allowUnrestrictedRemoteContent: boolean,
  nativePreview: boolean,
): string {
  const tokens = generateAppearanceTokens(config.appearance).modes;
  const remoteContentRisk = experienceWebviewRiskMetadata(bundle.manifest.webviews);
  const displayName = escapeHtmlText(bundle.manifest.name);
  const remoteContentBackend = nativePreview && bundle.manifest.webviews?.securityMode === "unrestricted"
    ? "electron-webcontents-view"
    : "iframe";
  const contextNow = Date.now();
  const contextMetadata = bundle.manifest.permissions.includes("codex.context.metadata");
  const codexContext = {
    connection: { state: "connected" as const, provider: "synthetic-preview", updatedAt: contextNow },
    activeThreadId: "synthetic-thread-a",
    threads: [
      { threadId: "synthetic-thread-a", sessionId: "synthetic-thread-a", ...(contextMetadata ? { displayName: "当前设计会话" } : {}), status: "working" as const, active: true, unread: false, updatedAt: contextNow },
      { threadId: "synthetic-thread-b", sessionId: "synthetic-thread-b", ...(contextMetadata ? { displayName: "等待你的补充" } : {}), status: "waiting-input" as const, active: false, unread: false, updatedAt: contextNow - 1 },
      { threadId: "synthetic-thread-c", sessionId: "synthetic-thread-c", ...(contextMetadata ? { displayName: "等待工具授权" } : {}), status: "waiting-approval" as const, active: false, unread: false, updatedAt: contextNow - 2 },
    ],
  };
  const views = bundle.surfaces.map((surface, index) => {
    const channel = `dev-${version}-${index}`;
    return {
      ...surface,
      key: experienceSurfaceKey(surface),
      channel,
      sandbox: bundle.manifest.permissions.includes("remote.webview") ? "allow-scripts allow-forms" : "allow-scripts",
      html: buildExperienceViewHtml(bundle, {
        mode: "preview", target: surface.target, plane: surface.plane, interaction: surface.interaction, appearance: "light", tokens, channel,
        remoteContentBackend,
        codexContext,
      }),
    };
  });
  const data = JSON.stringify({
    views,
    tokens,
    version,
    controlToken,
    webviewOrigins: bundle.manifest.webviews?.allowedOrigins ?? [],
    webviewSecurityMode: bundle.manifest.webviews?.securityMode ?? "strict",
    allowUnrestrictedRemoteContent,
    remoteContentBackend,
    remoteContentRisk,
    codexContext,
    contextEnabled: bundle.manifest.permissions.includes("codex.context.active"),
    lifecycleEventsEnabled: bundle.manifest.permissions.includes("codex.events.lifecycle"),
  }).replaceAll("<", "\\u003c");
  const riskBadge = remoteContentRisk.riskLevel === "critical"
    ? `<span class="risk-warning" title="${escapeHtmlText(remoteContentRisk.warning ?? "")}">⚠ Unrestricted remote content</span>`
    : "";
  const contextControls = bundle.manifest.permissions.includes("codex.context.active") || bundle.manifest.permissions.includes("codex.events.lifecycle")
    ? `<span class="context-status" data-context-status>Task A · working</span><button data-context-thread="synthetic-thread-a">Task A</button><button data-context-thread="synthetic-thread-b">Task B</button><button data-context-complete>Complete other</button>`
    : "";
  const secondaryInstanceTool = config.preview?.tools.includes("codex-secondary-instance") === true;
  const settingsButton = secondaryInstanceTool
    ? `<button class="preview-settings-button" data-preview-settings type="button" aria-label="Settings" aria-haspopup="dialog" aria-controls="preview-settings-dialog" title="Preview settings · never applied to Codex"><span aria-hidden="true">⚙</span></button>`
    : "";
  const settingsDialog = secondaryInstanceTool ? `<div class="preview-settings-dialog" id="preview-settings-dialog" data-preview-settings-dialog hidden role="dialog" aria-modal="true" aria-labelledby="preview-settings-title">
  <section class="preview-settings-panel">
    <header><div><p>Preview only</p><h2 id="preview-settings-title">Codex 双开</h2></div><button data-preview-settings-close type="button" aria-label="关闭设置">×</button></header>
    <div class="settings-menu" data-settings-menu>
      <div class="secondary-status-card"><span data-secondary-status-dot></span><div><strong data-secondary-status-title>正在检查第二账号…</strong><small data-secondary-status-detail>此设置只属于预览工具，不会写入 Experience。</small></div></div>
      <button class="settings-primary-action" data-secondary-open type="button">打开已有第二账号 Codex</button>
      <button data-secondary-configure type="button">选择配置与会话后打开</button>
      <p class="settings-safety-note">第二账号使用固定的独立 Chromium profile 和 CODEX_HOME，需要单独登录。默认复制能力配置，不复制账号凭据；会话默认不选择。</p>
      <p class="settings-message" data-secondary-message hidden></p>
    </div>
    <div class="settings-configure" data-settings-configure hidden>
      <button class="settings-back" data-settings-back type="button">← 返回</button>
      <div class="transfer-locations" data-transfer-locations></div>
      <div class="transfer-content" data-transfer-content><p class="settings-loading">正在扫描配置与会话体积…</p></div>
      <footer><span data-transfer-summary>尚未加载</span><button class="settings-primary-action" data-secondary-open-configured type="button" disabled>创建并打开</button></footer>
    </div>
  </section>
</div>` : "";
  return `<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${displayName} · Preview</title><style>
*{box-sizing:border-box}
html,body{margin:0;height:100%;font:13px system-ui,sans-serif;background:#e9ebf2;color:#20222a}
.tools{height:48px;display:flex;align-items:center;gap:8px;padding:0 14px;overflow-x:auto;white-space:nowrap;background:#fff;border-bottom:1px solid #d7d9e0}
.tools strong{margin-right:auto}.tools button,.tools select{flex:none;border:1px solid #c8cad2;border-radius:7px;background:#fff;padding:6px 10px}.tools select{max-width:230px;color:#30333b}.tools button[data-plane-toggle][aria-pressed="true"]{border-color:#6750a4;background:#6750a4;color:#fff}.tools button[data-plane-toggle][aria-pressed="false"]{background:transparent;color:#686b74}.tools button[data-control="apply"]{border-color:#5546b6;background:#6750a4;color:#fff}.tools button:disabled,.tools select:disabled{opacity:.55}.tools .preview-settings-button,.tools .appearance-toggle{display:grid;place-items:center;width:32px;height:32px;padding:0}.tools .preview-settings-button{border-color:#dedee8;background:#f7f6fb;color:#4c3d98;font-size:15px}.tools .appearance-toggle{font-size:16px}.tools .appearance-toggle[aria-pressed="true"]{border-color:#30313a;background:#30313a;color:#fff}.runtime-status,.context-status{flex:none;max-width:210px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#666}.runtime-status[data-tone="error"]{color:#b42318}.runtime-status[data-tone="active"]{color:#18794e}.context-status{border-left:1px solid #d7d9e0;padding-left:8px;color:#5546b6}
@media(max-width:1400px){.tools{gap:6px;padding-inline:8px}.tools button{padding-inline:8px}.tools select{max-width:190px}.tools .runtime-status,.tools .context-status{display:none}}
.risk-warning{flex:none;border:1px solid #f04438;border-radius:7px;background:#fff0ee;color:#b42318;padding:5px 8px;font-weight:650}
.restart-confirmation{position:fixed;inset:0;z-index:1000;display:grid;place-items:center;padding:24px;background:#11182766;backdrop-filter:blur(4px)}.restart-confirmation[hidden]{display:none}.restart-panel{width:min(430px,100%);border:1px solid #d7d9e0;border-radius:14px;padding:20px;background:#fff;color:#20222a;box-shadow:0 24px 80px #0004}.restart-panel h2{margin:0 0 8px;font-size:18px}.restart-panel p{margin:0;color:#555b66;line-height:1.5}.restart-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:18px}.restart-actions button{border:1px solid #c8cad2;border-radius:7px;padding:8px 12px;background:#fff}.restart-actions [data-restart-apply]{border-color:#5546b6;background:#6750a4;color:#fff;font-weight:650}
.preview-settings-dialog{position:fixed;inset:0;z-index:1100;display:grid;place-items:start;padding:58px 18px 18px;background:#1118274d;backdrop-filter:blur(3px)}.preview-settings-dialog[hidden]{display:none}.preview-settings-panel{justify-self:start;width:min(560px,calc(100vw - 36px));max-height:calc(100vh - 76px);overflow:hidden;border:1px solid #d8d9e2;border-radius:18px;background:#fff;color:#20222a;box-shadow:0 24px 80px #0005}.preview-settings-panel>header{display:flex;align-items:center;justify-content:space-between;padding:17px 18px;border-bottom:1px solid #e3e4ea}.preview-settings-panel h2,.preview-settings-panel p{margin:0}.preview-settings-panel>header p{color:#6750a4;font-size:10px;font-weight:750;letter-spacing:.13em;text-transform:uppercase}.preview-settings-panel>header h2{font-size:19px}.preview-settings-panel>header button{width:32px;height:32px;border:0;border-radius:50%;background:#f0f0f5;font-size:20px}.settings-menu{display:grid;gap:10px;padding:18px}.settings-menu>button,.settings-configure button{border:1px solid #d2d3dc;border-radius:10px;background:#fff;padding:11px 13px;color:#282a33;text-align:left}.settings-menu>button:hover,.settings-configure button:hover{background:#f7f6fb}.settings-menu .settings-primary-action,.settings-configure .settings-primary-action{border-color:#6750a4;background:#6750a4;color:#fff;font-weight:700;text-align:center}.secondary-status-card{display:grid;grid-template-columns:auto 1fr;align-items:center;gap:12px;margin-bottom:4px;padding:13px;border-radius:12px;background:#f5f3ff}.secondary-status-card>span{width:10px;height:10px;border-radius:50%;background:#8d8f99;box-shadow:0 0 0 5px #ded9ff}.secondary-status-card>span[data-state="running"]{background:#248a5b}.secondary-status-card div{display:grid;gap:3px}.secondary-status-card small,.settings-safety-note{color:#696c77;line-height:1.45}.settings-safety-note{padding:4px 2px;font-size:12px}.settings-message{border-radius:9px;padding:10px;background:#edf8f2;color:#18794e}.settings-message[data-tone="error"]{background:#fff0ee;color:#b42318}.settings-configure{display:grid;grid-template-rows:auto auto minmax(0,1fr) auto;max-height:calc(100vh - 145px)}.settings-back{justify-self:start;margin:12px 16px 4px;border:0!important;padding:6px!important;color:#5546b6!important}.transfer-locations{padding:0 18px 10px;color:#6a6d78;font-size:11px;line-height:1.45}.transfer-locations code{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.transfer-content{overflow:auto;padding:0 16px 16px}.settings-loading{padding:24px;text-align:center;color:#6a6d78}.transfer-group{margin-top:10px;border:1px solid #e1e2e8;border-radius:12px;overflow:hidden}.transfer-group>header{padding:11px 12px;background:#f7f7fa}.transfer-group>header strong{display:block}.transfer-group>header small{display:block;margin-top:2px;color:#737680}.transfer-row{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:start;gap:10px;padding:10px 12px;border-top:1px solid #ececf1}.transfer-row input{margin-top:3px}.transfer-row span{display:grid;min-width:0}.transfer-row small{color:#747680;line-height:1.35}.transfer-row em{color:#656875;font-size:11px;font-style:normal}.conversation-group details{border-top:1px solid #ececf1}.conversation-group summary{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:9px;padding:10px 12px;cursor:pointer;list-style:none}.conversation-group summary::-webkit-details-marker{display:none}.conversation-group summary input{margin:0}.conversation-threads{padding-left:22px;background:#fafafd}.settings-configure>footer{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 16px;border-top:1px solid #e1e2e8;background:#fff}.settings-configure>footer button{padding:9px 13px}.settings-configure>footer span{color:#666a75;font-size:12px}
.stage{height:calc(100% - 48px);padding:18px}.window{position:relative;isolation:isolate;display:grid;grid-template-columns:190px minmax(0,1fr);height:100%;overflow:hidden;border:1px solid var(--cek-outline);border-radius:14px;background:var(--cek-background);color:var(--cek-on-surface);box-shadow:0 16px 50px #0003}.navigation{position:relative;padding:16px 12px;border-right:1px solid var(--cek-outline);background:var(--cek-surface)}.navigation h3{margin:0 0 20px}.navigation p{padding:7px;border-radius:7px}.navigation p:nth-of-type(2){background:var(--cek-surface-selected)}.workspace{position:relative;display:grid;grid-template-rows:48px 1fr auto;min-width:0}.titlebar{position:relative;display:flex;align-items:center;justify-content:space-between;padding:0 18px;border-bottom:1px solid var(--cek-outline);background:var(--cek-surface)}.routes{position:relative;overflow:hidden}.route{position:absolute;inset:0;padding:34px;overflow:auto}.home,.conversation{max-width:660px;margin:28px auto}.cards{display:grid;grid-template-columns:1fr 1fr;gap:10px}.card,.message{padding:14px;border:1px solid var(--cek-outline);border-radius:10px;background:var(--cek-surface-raised)}.message{margin:10px}.composer{position:relative;margin:0 auto 18px;width:min(650px,calc(100% - 42px));height:78px;border:1px solid var(--cek-outline);border-radius:13px;background:var(--cek-surface-raised)}[hidden]{display:none!important}iframe{border:0;background:transparent}
</style></head><body><div class="tools">${settingsButton}<strong>${displayName}</strong>${riskBadge}<span class="runtime-status" data-runtime-status>${remoteContentBackend === "electron-webcontents-view" ? "Native preview" : "Browser preview"}</span><select data-codex-target aria-label="Target Codex instance"><option value="">Loading Codex instances…</option></select>${contextControls}<button data-view="home">Home</button><button data-view="task">Conversation</button><button data-plane-toggle="underlay" aria-label="Underlay shown" aria-pressed="true" title="Hide Underlay in preview">Underlay</button><button data-plane-toggle="overlay" aria-label="Overlay shown" aria-pressed="true" title="Hide Overlay in preview">Overlay</button><button class="appearance-toggle" data-appearance-toggle type="button" aria-label="Light appearance · switch to Dark" aria-pressed="false" title="Switch preview to Dark"><span aria-hidden="true">☀</span></button><button data-control="cancel">Restore</button><button data-control="apply">Apply to Codex</button></div><div class="stage"><section class="window" data-target="app-shell"><aside class="navigation" data-target="navigation"><h3>Codex</h3><p>New task</p><p>Projects</p><p>Settings</p></aside><main class="workspace" data-target="workspace"><header class="titlebar" data-target="titlebar"><strong>Experience preview</strong><span>Synthetic only</span></header><div class="routes"><section class="route" data-target="home"><div class="home"><h1>What will you build?</h1><p>Local synthetic Codex preview.</p><div class="cards"><div class="card">Project Aurora</div><div class="card">Project Ember</div></div></div></section><section class="route" data-target="conversation" hidden><div class="conversation"><div class="message">Preview this experience.</div><div class="message">No real Codex data is loaded.</div></div></section></div><div class="composer" data-target="composer"></div></main></section></div>${settingsDialog}<div class="restart-confirmation" data-restart-confirmation hidden role="dialog" aria-modal="true" aria-labelledby="restart-title"><section class="restart-panel"><h2 id="restart-title">Restart selected Codex to apply?</h2><p><strong data-restart-target>Selected Codex</strong> needs one restart to enable the Experience connection. Save its current work before continuing. Other Codex instances will stay open.</p><div class="restart-actions"><button data-restart-cancel>Not now</button><button data-restart-apply>Restart selected Codex and apply</button></div></section></div><script>
const state=${data};
const root=document.querySelector('.window');
const runtimeStatus=document.querySelector('[data-runtime-status]');
const controlButtons=[...document.querySelectorAll('[data-control]')];
const applyButton=document.querySelector('[data-control="apply"]');
const targetSelect=document.querySelector('[data-codex-target]');
const restartConfirmation=document.querySelector('[data-restart-confirmation]');
let appearance='light';
let build=state.version;
let controlBusy=false;
let targetSelectionRequired=true;
const planeVisibility={underlay:true,overlay:true};
const variable=(key)=>'--cek-'+key.replace(/[A-Z]/g,x=>'-'+x.toLowerCase());
function applyTokens(){for(const [key,value]of Object.entries(state.tokens[appearance]))root.style.setProperty(variable(key),value);root.style.colorScheme=appearance}
function owner(target){return target==='app-shell'||target==='floating-window'?root:root.querySelector('[data-target="'+target+'"]')}
function showRuntime(message,tone=''){runtimeStatus.textContent=message;runtimeStatus.dataset.tone=tone}
function refreshControlAvailability(){for(const button of controlButtons)button.disabled=controlBusy;targetSelect.disabled=controlBusy;applyButton.disabled=controlBusy||(targetSelectionRequired&&!targetSelect.value)}
function setControlBusy(busy){controlBusy=busy;refreshControlAvailability()}
targetSelect.addEventListener('change',refreshControlAvailability);
function showRestartConfirmation(){document.querySelector('[data-restart-target]').textContent=targetSelect.selectedOptions[0]?.textContent||'Selected Codex';restartConfirmation.hidden=false;document.querySelector('[data-restart-apply]').focus()}
function hideRestartConfirmation(){restartConfirmation.hidden=true}
async function control(action,payload={}){
  const response=await fetch('/__experience/control/'+action,{method:'POST',headers:{'Content-Type':'application/json','X-Codex-Experience-Control':state.controlToken},body:JSON.stringify(payload)});
  const result=await response.json().catch(()=>({error:'Invalid local control response'}));
  if(Number.isFinite(result.previewVersion))build=result.previewVersion;
  if(!response.ok){const error=new Error(result.error||'Experience control failed');error.code=result.code;throw error}
  return result;
}
const settingsTrigger=document.querySelector('[data-preview-settings]');
const settingsDialog=document.querySelector('[data-preview-settings-dialog]');
const settingsMenu=document.querySelector('[data-settings-menu]');
const settingsConfigure=document.querySelector('[data-settings-configure]');
const secondaryMessage=document.querySelector('[data-secondary-message]');
const transferContent=document.querySelector('[data-transfer-content]');
const transferLocations=document.querySelector('[data-transfer-locations]');
const transferSummary=document.querySelector('[data-transfer-summary]');
const openConfiguredButton=document.querySelector('[data-secondary-open-configured]');
let secondaryBusy=false;
let secondaryCatalog=null;
let selectedTransferItems=new Set();
let selectedConversationThreads=new Set();
const previewNode=(tag,className='',text='')=>{const value=document.createElement(tag);if(className)value.className=className;if(text)value.textContent=text;return value};
const sizeLabel=bytes=>{if(!Number.isFinite(bytes)||bytes<0)return'未知';if(bytes<1024)return bytes+' B';const units=['KB','MB','GB','TB'];let value=bytes/1024,index=0;while(value>=1024&&index<units.length-1){value/=1024;index+=1}return(value>=10?value.toFixed(1):value.toFixed(2))+' '+units[index]};
function secondaryStatusMessage(message,tone=''){if(!secondaryMessage)return;secondaryMessage.hidden=!message;secondaryMessage.textContent=message;secondaryMessage.dataset.tone=tone}
function setSecondaryBusy(value){secondaryBusy=value;settingsDialog?.querySelectorAll('button').forEach(button=>{if(!button.matches('[data-preview-settings-close]'))button.disabled=value});if(openConfiguredButton&&!value)openConfiguredButton.disabled=!secondaryCatalog}
function showSettingsMenu(){if(settingsMenu)settingsMenu.hidden=false;if(settingsConfigure)settingsConfigure.hidden=true}
function closePreviewSettings(){if(settingsDialog)settingsDialog.hidden=true;showSettingsMenu()}
async function loadSecondaryStatus(){
  const title=document.querySelector('[data-secondary-status-title]'),detail=document.querySelector('[data-secondary-status-detail]'),dot=document.querySelector('[data-secondary-status-dot]');
  try{const result=await control('secondary-status'),instance=result.instance||{};if(title)title.textContent=instance.running?'第二账号 Codex 正在运行':instance.initialized?'第二账号已创建':'尚未创建第二账号';if(detail)detail.textContent=instance.authenticated?'已存在独立登录，可直接打开。':instance.initialized?'尚未登录第二账号。':'可以复制所选能力配置后首次打开。';if(dot)dot.dataset.state=instance.running?'running':'idle'}
  catch(error){if(title)title.textContent='无法检查第二账号';if(detail)detail.textContent=error.message||String(error);if(dot)dot.dataset.state='error'}
}
function openPreviewSettings(){if(!settingsDialog)return;settingsDialog.hidden=false;showSettingsMenu();secondaryStatusMessage('');void loadSecondaryStatus();document.querySelector('[data-preview-settings-close]')?.focus()}
function updateTransferSummary(){
  if(!secondaryCatalog||!transferSummary||!openConfiguredButton)return;
  const selectedItems=secondaryCatalog.items.filter(item=>selectedTransferItems.has(item.id)&&item.id!=='conversations');
  const allThreads=secondaryCatalog.conversationGroups.flatMap(group=>group.threads);
  const selectedBytes=selectedItems.reduce((sum,item)=>sum+item.sizeBytes,0)+allThreads.filter(thread=>selectedConversationThreads.has(thread.threadId)).reduce((sum,thread)=>sum+thread.sizeBytes,0);
  transferSummary.textContent='已选 '+selectedItems.length+' 项配置'+(selectedConversationThreads.size?' · '+selectedConversationThreads.size+' 个会话':'')+' · '+sizeLabel(selectedBytes);
  openConfiguredButton.disabled=secondaryBusy;
}
function transferRow(item){
  const label=previewNode('label','transfer-row'),checkbox=previewNode('input'),copy=previewNode('span'),name=previewNode('strong','',item.label),description=previewNode('small','',item.description),size=previewNode('em','',sizeLabel(item.sizeBytes));
  checkbox.type='checkbox';checkbox.checked=selectedTransferItems.has(item.id);checkbox.onchange=()=>{if(checkbox.checked)selectedTransferItems.add(item.id);else selectedTransferItems.delete(item.id);updateTransferSummary()};
  copy.append(name,description);label.append(checkbox,copy,size);return label;
}
function appendTransferGroup(title,note,items){
  if(!items.length)return;const section=previewNode('section','transfer-group'),header=previewNode('header'),heading=previewNode('strong','',title),description=previewNode('small','',note);header.append(heading,description);section.append(header);for(const item of items)section.append(transferRow(item));transferContent.append(section);
}
function conversationGroup(group){
  const wrapper=previewNode('div','conversation-group'),details=previewNode('details'),summary=previewNode('summary'),groupBox=previewNode('input'),copy=previewNode('span'),title=previewNode('strong','',group.label),count=previewNode('small'),size=previewNode('em','',sizeLabel(group.sizeBytes)),threads=previewNode('div','conversation-threads');
  groupBox.type='checkbox';const refreshGroup=()=>{const selected=group.threads.filter(thread=>selectedConversationThreads.has(thread.threadId)).length;groupBox.checked=selected===group.threads.length&&group.threads.length>0;groupBox.indeterminate=selected>0&&selected<group.threads.length;count.textContent=selected+'/'+group.threads.length+' 个会话'};groupBox.onclick=event=>event.stopPropagation();groupBox.onchange=()=>{for(const thread of group.threads){if(groupBox.checked)selectedConversationThreads.add(thread.threadId);else selectedConversationThreads.delete(thread.threadId)}for(const input of threads.querySelectorAll('input'))input.checked=selectedConversationThreads.has(input.dataset.thread);refreshGroup();updateTransferSummary()};
  copy.append(title,count);summary.append(groupBox,copy,size);details.append(summary);
  for(const thread of group.threads){const row=previewNode('label','transfer-row'),box=previewNode('input'),threadCopy=previewNode('span'),threadTitle=previewNode('strong','',thread.title),updated=previewNode('small','',new Date(thread.updatedAt).toLocaleString('zh-CN')+(thread.archived?' · 已归档':'')),threadSize=previewNode('em','',sizeLabel(thread.sizeBytes));box.type='checkbox';box.dataset.thread=thread.threadId;box.checked=selectedConversationThreads.has(thread.threadId);box.onchange=()=>{if(box.checked)selectedConversationThreads.add(thread.threadId);else selectedConversationThreads.delete(thread.threadId);refreshGroup();updateTransferSummary()};threadCopy.append(threadTitle,updated);row.append(box,threadCopy,threadSize);threads.append(row)}
  refreshGroup();details.append(threads);wrapper.append(details);return wrapper;
}
function renderTransferCatalog(catalog){
  secondaryCatalog=catalog;selectedTransferItems=new Set(catalog.items.filter(item=>item.defaultSelected&&item.id!=='conversations').map(item=>item.id));selectedConversationThreads=new Set();transferContent.textContent='';transferLocations.textContent='';
  const source=previewNode('code','',catalog.sourceCodexHome),destination=previewNode('code','',catalog.destinationCodexHome);transferLocations.append('来源：',source,'目标：',destination);
  appendTransferGroup('能力与配置','默认选择，可逐项取消；账号凭据永远不会复制。',catalog.items.filter(item=>item.category==='configuration'));
  if(catalog.conversationGroups.length){const section=previewNode('section','transfer-group'),header=previewNode('header'),heading=previewNode('strong','','会话记录'),description=previewNode('small','','默认不选。可以按项目分组选择，也可以展开后选择具体会话。');header.append(heading,description);section.append(header);for(const group of catalog.conversationGroups)section.append(conversationGroup(group));transferContent.append(section)}
  appendTransferGroup('其他数据','Kit 尚未识别的路径，默认不选。',catalog.items.filter(item=>item.category==='other'));
  updateTransferSummary();
}
async function beginSecondaryConfigure(){
  if(!settingsMenu||!settingsConfigure)return;settingsMenu.hidden=true;settingsConfigure.hidden=false;secondaryCatalog=null;transferContent.innerHTML='<p class="settings-loading">正在扫描配置与会话体积…</p>';transferLocations.textContent='';transferSummary.textContent='正在扫描…';setSecondaryBusy(true);
  try{const result=await control('secondary-catalog');renderTransferCatalog(result.catalog)}catch(error){transferContent.textContent='扫描失败：'+(error.message||String(error))}finally{setSecondaryBusy(false);updateTransferSummary()}
}
async function openSecondary(){setSecondaryBusy(true);secondaryStatusMessage('正在打开第二账号 Codex…');try{const result=await control('secondary-open');secondaryStatusMessage(result.instance?.reused?'第二账号 Codex 已经在运行。':'第二账号 Codex 已打开。');await Promise.all([loadSecondaryStatus(),loadCodexInstances()])}catch(error){secondaryStatusMessage(error.message||String(error),'error')}finally{setSecondaryBusy(false)}}
async function openConfiguredSecondary(){
  if(!secondaryCatalog||secondaryBusy)return;const selectedItemIds=[...selectedTransferItems];if(selectedConversationThreads.size)selectedItemIds.push('conversations');setSecondaryBusy(true);transferSummary.textContent=selectedConversationThreads.size?'等待系统确认后迁移并打开…':'正在迁移配置并打开…';
  try{const result=await control('secondary-open-configured',{selectedItemIds,selectedConversationThreadIds:[...selectedConversationThreads]});if(result.status==='cancelled'){transferSummary.textContent='已取消，没有复制会话。';return}showSettingsMenu();secondaryStatusMessage('第二账号已打开：复制 '+result.transfer.selectedItemIds.length+' 项，'+sizeLabel(result.transfer.copiedBytes)+(result.transfer.conversations?'，包含会话。':'，未复制会话。'));await Promise.all([loadSecondaryStatus(),loadCodexInstances()])}catch(error){transferSummary.textContent='操作失败：'+(error.message||String(error))}finally{setSecondaryBusy(false)}
}
settingsTrigger?.addEventListener('click',openPreviewSettings);
document.querySelector('[data-preview-settings-close]')?.addEventListener('click',closePreviewSettings);
document.querySelector('[data-settings-back]')?.addEventListener('click',showSettingsMenu);
document.querySelector('[data-secondary-open]')?.addEventListener('click',()=>void openSecondary());
document.querySelector('[data-secondary-configure]')?.addEventListener('click',()=>void beginSecondaryConfigure());
openConfiguredButton?.addEventListener('click',()=>void openConfiguredSecondary());
settingsDialog?.addEventListener('pointerdown',event=>{if(event.target===settingsDialog)closePreviewSettings()});
addEventListener('keydown',event=>{if(event.key==='Escape'&&settingsDialog&&!settingsDialog.hidden)closePreviewSettings()});
async function loadCodexInstances(){
  try{
    const result=await control('instances');if(!targetSelect?.isConnected)return;const instances=Array.isArray(result.instances)?result.instances:[];const previous=targetSelect.value;targetSelect.textContent='';const addOption=(label,value,title='')=>{const option=document.createElement('option');option.textContent=label;option.value=value;if(title)option.title=title;targetSelect.append(option);return option};
    if(instances.length===0){addOption('Primary Codex · not running','primary');targetSelectionRequired=false}
    else{
      const connected=instances.find(instance=>instance.connected);targetSelectionRequired=instances.length>1&&!connected;
      if(targetSelectionRequired)addOption('Select a Codex instance…','');
      for(const instance of instances){const suffix=instance.connected?'connected':instance.state==='connectable'?'CDP ready':instance.state==='restart-required'?'restart required':'unavailable';addOption(instance.label+' · '+suffix,instance.id,instance.profilePath||('PID '+instance.pid))}
      const preferred=instances.some(instance=>instance.id===previous)?previous:(connected?.id||(instances.length===1?instances[0].id:''));targetSelect.value=preferred;
    }
    refreshControlAvailability();
  }catch(error){if(!targetSelect?.isConnected)return;targetSelect.textContent='';const option=document.createElement('option');option.textContent='Unable to inspect Codex';targetSelect.append(option);targetSelectionRequired=true;refreshControlAvailability();showRuntime(error.message||String(error),'error')}
}
async function applyToCodex(allowRestart=false){
  if(targetSelectionRequired&&!targetSelect.value){showRuntime('Select a Codex instance','error');return}
  setControlBusy(true);showRuntime(allowRestart?'Restarting Codex…':'Applying…');
  try{
    const result=await control('apply',{allowRestart,appearance,targetId:targetSelect.value||undefined});
    showRuntime(result.hotUpdated?'Hot refreshed':'Applied','active');
    await loadCodexInstances();
  }catch(error){
    if(error.code==='direct/restart-confirmation-required'&&!allowRestart){
      setControlBusy(false);
      showRuntime('Restart approval required','error');showRestartConfirmation();return
    }
    showRuntime(error.message||String(error),'error');
  }finally{setControlBusy(false)}
}
async function restoreCodex(){setControlBusy(true);showRuntime('Restoring…');try{await control('cancel');showRuntime('Official view restored')}catch(error){showRuntime(error.message||String(error),'error')}finally{setControlBusy(false)}}
const surfaces=[];
const webviews=new Map();
const nativeTransport=window.codexExperienceNativeWebviews;
const useNativeWebviews=state.remoteContentBackend==='electron-webcontents-view'&&nativeTransport?.backend==='electron-webcontents-view';
const allowedWebviewOrigins=new Set(state.webviewOrigins);
const webviewFrameSource=state.webviewSecurityMode==='strict'?(state.webviewOrigins.join(' ')||'&apos;none&apos;'):'https: http:';
const escapeHtml=value=>String(value).replace(/[&<>"']/g,character=>({38:'&amp;',60:'&lt;',62:'&gt;',34:'&quot;',39:'&#39;'})[character.charCodeAt(0)]);
const webviewUrl=value=>{if(typeof value!=='string'||value.length<1||value.length>2048)throw new Error('Managed WebView URL is invalid');const url=new URL(value);const supported=url.protocol==='https:'||(state.webviewSecurityMode!=='strict'&&url.protocol==='http:');if(!supported||url.username||url.password||(state.webviewSecurityMode==='strict'&&!allowedWebviewOrigins.has(url.origin)))throw new Error('Managed WebView URL is not allowed by the project security policy');return url.href};
const webviewRect=value=>{if(!value||typeof value!=='object')return null;const numbers=[value.x,value.y,value.width,value.height];if(!numbers.every(item=>typeof item==='number'&&Number.isFinite(item)&&Math.abs(item)<=100000)||value.width<0||value.height<0||typeof value.visible!=='boolean')return null;return{x:value.x,y:value.y,width:value.width,height:value.height,visible:value.visible}};
const interactionRegions=payload=>{if(!payload||typeof payload!=='object'||payload.op!=='regions'||!Array.isArray(payload.regions)||payload.regions.length>16)return null;const regions=[];for(const value of payload.regions){if(!value||typeof value!=='object')return null;const numbers=[value.x,value.y,value.width,value.height];if(!numbers.every(item=>typeof item==='number'&&Number.isFinite(item)&&Math.abs(item)<=100000)||value.width<=0||value.height<=0)return null;const shape=value.shape===undefined?'rect':value.shape;if(shape!=='rect'&&shape!=='rounded'&&shape!=='circle')return null;const radius=value.radius===undefined?0:value.radius;if(typeof radius!=='number'||!Number.isFinite(radius)||radius<0||radius>100000)return null;regions.push({x:value.x,y:value.y,width:value.width,height:value.height,shape,radius})}return regions};
const applyInteractionRegions=(surface,payload)=>{if(surface.view.plane!=='overlay'||surface.view.interaction!=='scoped')return;const regions=interactionRegions(payload);if(!regions)return;if(regions.length===0){surface.frame.style.pointerEvents='none';surface.frame.style.clipPath='inset(0 100% 100% 0)';return}const path=regions.map(({x,y,width,height,shape,radius:requestedRadius})=>{const left=Math.round(x*100)/100,top=Math.round(y*100)/100,right=Math.round((x+width)*100)/100,bottom=Math.round((y+height)*100)/100;if(shape==='circle'){const radius=Math.round(Math.min(width,height)*50)/100,centerX=Math.round((x+width/2)*100)/100,centerY=Math.round((y+height/2)*100)/100;return'M '+centerX+' '+(centerY-radius)+' A '+radius+' '+radius+' 0 1 1 '+centerX+' '+(centerY+radius)+' A '+radius+' '+radius+' 0 1 1 '+centerX+' '+(centerY-radius)+' Z'}if(shape==='rounded'){const radius=Math.round(Math.min(requestedRadius,width/2,height/2)*100)/100;return'M '+(left+radius)+' '+top+' H '+(right-radius)+' Q '+right+' '+top+' '+right+' '+(top+radius)+' V '+(bottom-radius)+' Q '+right+' '+bottom+' '+(right-radius)+' '+bottom+' H '+(left+radius)+' Q '+left+' '+bottom+' '+left+' '+(bottom-radius)+' V '+(top+radius)+' Q '+left+' '+top+' '+(left+radius)+' '+top+' Z'}return'M '+left+' '+top+' H '+right+' V '+bottom+' H '+left+' Z'}).join(' ');surface.frame.style.clipPath='path("'+path+'")';surface.frame.style.pointerEvents='auto'};
const webviewAttributes=state.webviewSecurityMode==='unrestricted'?'loading="eager" allow="camera *; microphone *; geolocation *; clipboard-read *; clipboard-write *; fullscreen *"':'sandbox="allow-scripts allow-forms allow-same-origin" referrerpolicy="no-referrer" loading="eager" allow="" credentialless';
const webviewDocument=(url,title)=>'<!doctype html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src &apos;none&apos;; base-uri &apos;none&apos;; object-src &apos;none&apos;; frame-src '+escapeHtml(webviewFrameSource)+'; style-src &apos;unsafe-inline&apos;"><style>html,body,iframe{box-sizing:border-box;width:100%;height:100%;margin:0;border:0;overflow:hidden;background:transparent}</style></head><body><iframe title="'+escapeHtml(title)+'" src="'+escapeHtml(url)+'" '+webviewAttributes+'></iframe></body></html>';
const webviewDocumentUrl=(url,title)=>'data:text/html;charset=utf-8,'+encodeURIComponent(webviewDocument(url,title));
const webviewSource=(url,title)=>state.webviewSecurityMode==='unrestricted'?url:webviewDocumentUrl(url,title);
const layoutWebview=(entry,rect)=>{Object.assign(entry.frame.style,{left:rect.x+'px',top:rect.y+'px',width:rect.width+'px',height:rect.height+'px'});entry.frame.hidden=!rect.visible||rect.width===0||rect.height===0||entry.surface.frame.hidden};
const nativeLayout=(surface,rect)=>{const frameRect=surface.frame.getBoundingClientRect();const scaleX=frameRect.width>0?frameRect.width/(surface.frame.clientWidth||frameRect.width):1;const scaleY=frameRect.height>0?frameRect.height/(surface.frame.clientHeight||frameRect.height):1;const rawLeft=frameRect.left+rect.x*scaleX;const rawTop=frameRect.top+rect.y*scaleY;const left=Math.max(frameRect.left,rawLeft);const top=Math.max(frameRect.top,rawTop);const right=Math.min(frameRect.right,rawLeft+rect.width*scaleX);const bottom=Math.min(frameRect.bottom,rawTop+rect.height*scaleY);const width=Math.max(0,right-left);const height=Math.max(0,bottom-top);return{bounds:{x:Math.round(left),y:Math.round(top),width:Math.round(width),height:Math.round(height)},visible:planeVisibility[surface.view.plane]&&!surface.frame.hidden&&rect.visible&&width>0&&height>0}};
const nativeBase=(surface,id)=>({channel:surface.view.channel,id,target:surface.view.target,plane:surface.view.plane});
const dispatchNative=command=>void nativeTransport.dispatch(command).catch(error=>{console.error('Codex Experience native WebView:',error);showRuntime(error.message||String(error),'error')});
const refreshNativeWebviews=()=>{if(!useNativeWebviews)return;for(const [key,entry]of webviews){const id=key.slice(key.lastIndexOf(':')+1);dispatchNative({...nativeBase(entry.surface,id),op:'layout',...nativeLayout(entry.surface,entry.rect)})}};
const handleWebview=(surface,payload)=>{
  if(surface.view.plane!=='overlay'||surface.view.interaction!=='interactive'||!payload||typeof payload!=='object'||typeof payload.id!=='string'||!/^webview-[1-9][0-9]*$/.test(payload.id))return;
  const key=surface.view.channel+':'+payload.id;
  if(payload.op==='mount'){
    const rect=webviewRect(payload.rect);if(!rect||webviews.has(key))return;
    const url=webviewUrl(payload.url);const title=typeof payload.title==='string'&&payload.title.trim()?payload.title.trim().slice(0,100):'Remote content';
    if(state.webviewSecurityMode==='unrestricted'&&!state.allowUnrestrictedRemoteContent)throw new Error('Unrestricted remote content requires an explicit host grant');
    if(useNativeWebviews){const entry={surface,url,title,rect};webviews.set(key,entry);dispatchNative({...nativeBase(surface,payload.id),op:'mount',url,title,...nativeLayout(surface,rect)});return}
    if(state.remoteContentBackend==='electron-webcontents-view')throw new Error('Electron native WebView transport is unavailable');
    if(state.webviewSecurityMode!=='unrestricted'&&!('credentialless' in document.createElement('iframe')))throw new Error('Credentialless WebView frames are not supported by this browser');
    const frame=document.createElement('iframe');frame.dataset.codexExperienceWebviewHost=payload.id;frame.dataset.target=surface.view.target;frame.dataset.plane=surface.view.plane;frame.title=title;
    if(state.webviewSecurityMode!=='unrestricted'){frame.setAttribute('sandbox','allow-scripts allow-forms allow-same-origin');frame.setAttribute('referrerpolicy','no-referrer')}else{frame.setAttribute('allow','camera *; microphone *; geolocation *; clipboard-read *; clipboard-write *; fullscreen *')}
    Object.assign(frame.style,{position:surface.frame.style.position,border:'0',background:'transparent',overflow:'hidden',pointerEvents:'auto',zIndex:String((Number.parseInt(surface.frame.style.zIndex,10)||0)+1)});
    const entry={frame,surface,url,title,rect};frame.src=webviewSource(url,title);surface.target.append(frame);webviews.set(key,entry);layoutWebview(entry,rect);return;
  }
  const entry=webviews.get(key);if(!entry||entry.surface!==surface)return;
  if(payload.op==='layout'){const rect=webviewRect(payload.rect);if(!rect)return;entry.rect=rect;if(useNativeWebviews)dispatchNative({...nativeBase(surface,payload.id),op:'layout',...nativeLayout(surface,rect)});else layoutWebview(entry,rect);return}
  if(payload.op==='navigate'){entry.url=webviewUrl(payload.url);if(useNativeWebviews)dispatchNative({...nativeBase(surface,payload.id),op:'navigate',url:entry.url});else entry.frame.src=webviewSource(entry.url,entry.title);return}
  if(payload.op==='reload'){if(useNativeWebviews)dispatchNative({...nativeBase(surface,payload.id),op:'reload'});else entry.frame.src=webviewSource(entry.url,entry.title);return}
  if(payload.op==='destroy'){if(useNativeWebviews)dispatchNative({...nativeBase(surface,payload.id),op:'destroy'});else entry.frame.remove();webviews.delete(key)}
};
for(const view of state.views){const target=owner(view.target);if(!target)continue;target.style.position='relative';if(view.plane==='underlay'){target.style.isolation='isolate';for(const child of target.children){child.style.position=child.style.position||'relative';child.style.zIndex='1'}}const frame=document.createElement('iframe');frame.dataset.target=view.target;frame.dataset.plane=view.plane;Object.assign(frame.style,{position:'absolute',inset:'0',width:'100%',height:'100%',zIndex:view.plane==='underlay'?'0':view.target==='floating-window'?'40':'20',pointerEvents:view.plane==='overlay'&&view.interaction==='interactive'?'auto':'none',clipPath:view.interaction==='scoped'?'inset(0 100% 100% 0)':'none'});if(view.plane==='overlay')frame.style.setProperty('-webkit-app-region','no-drag');frame.setAttribute('sandbox',view.sandbox);frame.srcdoc=view.html;target.append(frame);surfaces.push({view,target,frame})}
const postToSurfaces=(type,payload)=>{for(const surface of surfaces)surface.frame.contentWindow?.postMessage({source:'codex-experience-browser-v1',channel:surface.view.channel,type,payload},'*')};
const contextStatus=document.querySelector('[data-context-status]');
const updateContextStatus=()=>{if(!contextStatus)return;const thread=state.codexContext.threads.find(item=>item.threadId===state.codexContext.activeThreadId);contextStatus.textContent=(thread?.threadId==='synthetic-thread-b'?'Task B':'Task A')+' · '+(thread?.status||'none')};
const setActiveThread=(threadId)=>{const previousThreadId=state.codexContext.activeThreadId;if(previousThreadId===threadId)return;const now=Date.now();state.codexContext.activeThreadId=threadId;for(const thread of state.codexContext.threads){thread.active=thread.threadId===threadId;if(thread.active)thread.unread=false}const thread=state.codexContext.threads.find(item=>item.threadId===threadId)||null;postToSurfaces('codex-context',structuredClone(state.codexContext));if(state.lifecycleEventsEnabled)postToSurfaces('codex-event',{type:'activeThreadChanged',observedAt:now,previousThreadId,thread:thread?structuredClone(thread):null});updateContextStatus()};
let syntheticTurn=0;
const completeOtherThread=()=>{const thread=state.codexContext.threads.find(item=>item.threadId!==state.codexContext.activeThreadId);if(!thread)return;const startedAt=Date.now();const turnId='synthetic-preview-turn-'+(++syntheticTurn);const previousStatus=thread.status;thread.status='working';thread.updatedAt=startedAt;postToSurfaces('codex-context',structuredClone(state.codexContext));if(state.lifecycleEventsEnabled){postToSurfaces('codex-event',{type:'threadStatusChanged',observedAt:startedAt,previousStatus,thread:structuredClone(thread)});postToSurfaces('codex-event',{type:'turnStarted',observedAt:startedAt,threadId:thread.threadId,sessionId:thread.sessionId,turnId,startedAt})}setTimeout(()=>{const completedAt=Date.now();thread.status='completed';thread.unread=true;thread.updatedAt=completedAt;postToSurfaces('codex-context',structuredClone(state.codexContext));if(state.lifecycleEventsEnabled){postToSurfaces('codex-event',{type:'threadStatusChanged',observedAt:completedAt,previousStatus:'working',thread:structuredClone(thread)});postToSurfaces('codex-event',{type:'turnCompleted',observedAt:completedAt,threadId:thread.threadId,sessionId:thread.sessionId,turnId,outcome:'completed',completedAt})}updateContextStatus()},350)};
addEventListener('message',event=>{const data=event.data;if(!data||data.source!=='codex-experience-browser-v1')return;const surface=surfaces.find(candidate=>event.source===candidate.frame.contentWindow&&data.channel===candidate.view.channel);if(!surface)return;if(data.type==='interaction')applyInteractionRegions(surface,data.payload);if(data.type==='action')showRuntime('Action '+(data.payload?.name||'unknown')+' emitted · preview only');if(data.type==='webview')try{handleWebview(surface,data.payload)}catch(error){console.error('Codex Experience WebView:',error);showRuntime(error.message||String(error),'error')}});
function updatePlaneVisibility(plane){const frames=[...document.querySelectorAll('iframe[data-plane="'+plane+'"]')];const button=document.querySelector('[data-plane-toggle="'+plane+'"]');if(!button)return;const label=plane==='underlay'?'Underlay':'Overlay';button.textContent=label;if(!frames.length){button.disabled=true;button.setAttribute('aria-label',label+' unavailable');button.title=label+' is not included in this Experience';button.setAttribute('aria-pressed','false');return}const shown=planeVisibility[plane];for(const frame of frames)frame.hidden=!shown;button.disabled=false;button.setAttribute('aria-label',label+' '+(shown?'shown':'hidden'));button.title=(shown?'Hide ':'Show ')+label+' in preview';button.setAttribute('aria-pressed',String(shown));refreshNativeWebviews()}
document.querySelectorAll('[data-plane-toggle]').forEach(button=>{const plane=button.dataset.planeToggle;button.onclick=()=>{planeVisibility[plane]=!planeVisibility[plane];updatePlaneVisibility(plane)}});
updatePlaneVisibility('underlay');updatePlaneVisibility('overlay');
document.querySelectorAll('[data-view]').forEach(button=>button.onclick=()=>{const home=button.dataset.view==='home';document.querySelector('[data-target="home"]').hidden=!home;document.querySelector('[data-target="conversation"]').hidden=home;requestAnimationFrame(refreshNativeWebviews)});
document.querySelectorAll('[data-context-thread]').forEach(button=>button.onclick=()=>setActiveThread(button.dataset.contextThread));
document.querySelector('[data-context-complete]')?.addEventListener('click',completeOtherThread);
const appearanceToggle=document.querySelector('[data-appearance-toggle]');
function updateAppearanceToggle(){if(!appearanceToggle)return;const dark=appearance==='dark';appearanceToggle.textContent=dark?'☾':'☀';appearanceToggle.setAttribute('aria-label',(dark?'Dark':'Light')+' appearance · switch to '+(dark?'Light':'Dark'));appearanceToggle.setAttribute('aria-pressed',String(dark));appearanceToggle.title=dark?'Switch preview to Light':'Switch preview to Dark'}
appearanceToggle?.addEventListener('click',()=>{appearance=appearance==='light'?'dark':'light';applyTokens();updateAppearanceToggle();postToSurfaces('appearance',appearance)});
document.querySelector('[data-control="apply"]').onclick=()=>void applyToCodex(false);
document.querySelector('[data-control="cancel"]').onclick=()=>void restoreCodex();
document.querySelector('[data-restart-cancel]').onclick=()=>{hideRestartConfirmation();showRuntime('Apply cancelled')};
document.querySelector('[data-restart-apply]').onclick=()=>{hideRestartConfirmation();void applyToCodex(true)};
addEventListener('resize',refreshNativeWebviews);addEventListener('scroll',refreshNativeWebviews,true);
applyTokens();updateAppearanceToggle();updateContextStatus();setInterval(async()=>{if(controlBusy)return;const response=await fetch('/__experience/version',{cache:'no-store'}).catch(()=>null);if(!response)return;const next=Number(await response.text());if(next!==build)location.reload()},800);
void loadCodexInstances();
</script></body></html>`;
}

export async function startExperienceDevServer(rootPath = process.cwd(), options: ExperienceDevServerOptions = {}): Promise<ExperienceDevServer> {
  const root = await fs.realpath(rootPath);
  let config = await readConfig(root);
  let version = Date.now();
  let lastError: string | null = null;
  await buildExperienceProject(root);
  let bundle = await checkExperienceProject(root);
  const assertRemoteGrant = (candidate: ExperienceProjectBundle): void => {
    if (candidate.manifest.webviews?.securityMode === "unrestricted" && !options.allowUnrestrictedRemoteContent) {
      throw new ExperienceKitError(
        "tool/unrestricted-remote-content",
        "This project requests unrestricted remote content. Re-run dev with --allow-unrestricted-remote-content only if you trust every remote page it loads.",
      );
    }
  };
  assertRemoteGrant(bundle);
  const controlToken = randomUUID();
  const host = options.host ?? "127.0.0.1";
  const runtimeFactory = options.runtimeFactory ?? (async (): Promise<ExperienceDevControlRuntime> => {
    const { CodexExperienceRuntime } = await import("./codex-experience-runtime.js");
    return new CodexExperienceRuntime();
  });

  let buildOperation: Promise<void> = Promise.resolve();
  const rebuildNow = (): Promise<void> => {
    const operation = buildOperation.then(async () => {
      const nextConfig = await readConfig(root);
      await buildExperienceProject(root);
      const nextBundle = await checkExperienceProject(root);
      assertRemoteGrant(nextBundle);
      config = nextConfig;
      bundle = nextBundle;
      lastError = null;
      version = Date.now();
    });
    buildOperation = operation.catch(() => undefined);
    return operation;
  };

  let rebuilding: ReturnType<typeof setTimeout> | null = null;
  const rebuild = () => {
    if (rebuilding) clearTimeout(rebuilding);
    rebuilding = setTimeout(() => {
      rebuilding = null;
      void rebuildNow().catch((error) => { lastError = controlErrorMessage(error); version = Date.now(); });
    }, 120);
  };
  const watchAbort = new AbortController();
  const watcher = fs.watch(root, { recursive: true, signal: watchAbort.signal });
  const isBuildInput = (filename: string): boolean => {
    if (!filename) return false;
    const name = path.normalize(filename);
    return name === CONFIG_NAME
      || name === MANIFEST_NAME
      || name === config.sourceDir
      || name.startsWith(`${config.sourceDir}${path.sep}`)
      || name === config.assetsDir
      || name.startsWith(`${config.assetsDir}${path.sep}`);
  };
  let watching = true;
  void (async () => {
    for await (const event of watcher) {
      if (!watching) break;
      const name = event.filename?.toString() ?? "";
      if (!isBuildInput(name)) continue;
      rebuild();
    }
  })().catch((error) => { if (!watchAbort.signal.aborted) lastError = controlErrorMessage(error); });

  let activeControl: Promise<unknown> | null = null;
  const handleControl = async (request: IncomingMessage, response: ServerResponse, action: string): Promise<void> => {
    if (!isLoopbackHost(host)) { sendJson(response, 403, { code: "tool/dev-control-host", error: "Experience control is available only on a loopback host" }); return; }
    if (request.method !== "POST") { sendJson(response, 405, { code: "tool/dev-control-method", error: "Experience control requires POST" }); return; }
    if (request.headers["x-codex-experience-control"] !== controlToken) { sendJson(response, 403, { code: "tool/dev-control-token", error: "Invalid Experience control token" }); return; }
    const secondaryToolEnabled = config.preview?.tools.includes("codex-secondary-instance") === true;
    const secondaryActions = new Set(["secondary-status", "secondary-catalog", "secondary-open", "secondary-open-configured"]);
    if (!["apply", "cancel", "instances"].includes(action) && !secondaryActions.has(action)) {
      sendJson(response, 404, { code: "tool/dev-control-route", error: "Unknown Experience control action" }); return;
    }
    if (secondaryActions.has(action) && !secondaryToolEnabled) {
      sendJson(response, 404, { code: "tool/dev-control-route", error: "This preview does not enable the secondary Codex tool" }); return;
    }
    if (activeControl) { sendJson(response, 409, { code: "tool/dev-control-busy", error: "Another Experience control operation is running" }); return; }

    let body: Record<string, unknown>;
    try {
      body = await readControlBody(request, action === "secondary-open-configured" ? 2 * 1024 * 1024 : 4_096);
    } catch (error) {
      sendJson(response, 400, { code: controlErrorCode(error), error: controlErrorMessage(error) });
      return;
    }
    if (body.targetId !== undefined && (
      typeof body.targetId !== "string"
      || body.targetId.length < 1
      || body.targetId.length > 128
      || !/^[a-z0-9][a-z0-9._:-]*$/iu.test(body.targetId)
    )) {
      sendJson(response, 400, { code: "tool/dev-control-target", error: "targetId is invalid" });
      return;
    }
    if (action === "secondary-open-configured") {
      const selectedItemIds = body.selectedItemIds;
      const selectedConversationThreadIds = body.selectedConversationThreadIds ?? [];
      const validIds = (value: unknown, maximum: number): value is string[] => Array.isArray(value)
        && value.length <= maximum
        && new Set(value).size === value.length
        && value.every((id) => typeof id === "string" && /^[A-Za-z0-9._:-]{1,240}$/u.test(id));
      if (!validIds(selectedItemIds, 128) || !validIds(selectedConversationThreadIds, 10_000)) {
        sendJson(response, 400, { code: "tool/dev-control-selection", error: "Secondary Codex transfer selection is invalid" });
        return;
      }
    }
    if (activeControl) { sendJson(response, 409, { code: "tool/dev-control-busy", error: "Another Experience control operation is running" }); return; }
    const operation = (async (): Promise<unknown> => {
      if (action === "apply") await rebuildNow();
      const runtime = await runtimeFactory();
      try {
        if (action === "instances") return { instances: await runtime.listCodexInstances?.() ?? [] };
        if (action === "secondary-status") {
          if (!runtime.inspectSecondaryCodexInstance) throw new ExperienceKitError("tool/dev-control-unavailable", "Secondary Codex status is unavailable");
          return { instance: await runtime.inspectSecondaryCodexInstance() };
        }
        if (action === "secondary-catalog") {
          if (!runtime.getSecondaryCodexTransferCatalog) throw new ExperienceKitError("tool/dev-control-unavailable", "Secondary Codex transfer catalog is unavailable");
          return { catalog: await runtime.getSecondaryCodexTransferCatalog() };
        }
        if (action === "secondary-open") {
          if (!runtime.openSecondaryCodexInstance) throw new ExperienceKitError("tool/dev-control-unavailable", "Secondary Codex launch is unavailable");
          return { instance: await runtime.openSecondaryCodexInstance() };
        }
        if (action === "secondary-open-configured") {
          if (!runtime.openConfiguredSecondaryCodexInstance) throw new ExperienceKitError("tool/dev-control-unavailable", "Configured secondary Codex launch is unavailable");
          return await runtime.openConfiguredSecondaryCodexInstance({
            selectedItemIds: body.selectedItemIds as string[],
            ...((body.selectedConversationThreadIds as string[]).length > 0
              ? { selectedConversationThreadIds: body.selectedConversationThreadIds as string[] }
              : {}),
          });
        }
        if (action === "cancel") return await runtime.cancel();
        return await runtime.apply(path.join(root, config.outDir), {
          tokens: generateAppearanceTokens(config.appearance).modes,
          appearance: body.appearance === "dark" ? "dark" : "light",
          allowRestart: body.allowRestart === true,
          allowUnrestrictedRemoteContent: options.allowUnrestrictedRemoteContent === true,
          ...(typeof body.targetId === "string" ? { targetId: body.targetId } : {}),
        });
      } finally {
        await runtime.shutdown();
      }
    })();
    activeControl = operation;
    try {
      const value = await operation;
      sendJson(response, 200, value && typeof value === "object" && !Array.isArray(value)
        ? { ...value, previewVersion: version }
        : { value, previewVersion: version });
    } catch (error) {
      const code = controlErrorCode(error);
      const status = code === "direct/restart-confirmation-required"
        || code === "direct/target-selection-required"
        || code === "runtime/busy" ? 409 : 500;
      sendJson(response, status, { code, error: controlErrorMessage(error), previewVersion: version });
    } finally {
      if (activeControl === operation) activeControl = null;
    }
  };

  const server = http.createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store");
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const localApi = url.pathname === "/__experience/version" || url.pathname.startsWith("/__experience/control/");
    if (localApi && !allowLoopbackCors(request, response)) {
      sendJson(response, 403, { code: "tool/dev-control-origin", error: "Experience preview API accepts only loopback browser origins" });
      return;
    }
    if (localApi && request.method === "OPTIONS") {
      response.statusCode = 204;
      response.end();
      return;
    }
    if (url.pathname === "/__experience/version") { response.setHeader("Content-Type", "text/plain"); response.end(String(version)); return; }
    if (url.pathname.startsWith("/__experience/control/")) {
      const action = url.pathname.slice("/__experience/control/".length);
      void handleControl(request, response, action).catch((error) => {
        if (!response.headersSent) sendJson(response, 500, { code: controlErrorCode(error), error: controlErrorMessage(error) });
        else response.destroy(error instanceof Error ? error : undefined);
      });
      return;
    }
    if (lastError) { response.statusCode = 500; response.setHeader("Content-Type", "text/plain; charset=utf-8"); response.end(`Experience build failed\n\n${lastError}`); return; }
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(previewHtml(
      bundle,
      config,
      version,
      controlToken,
      options.allowUnrestrictedRemoteContent === true,
      url.searchParams.get("__codexExperienceNative") === "1",
    ));
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(options.port ?? 4173, host, resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new ExperienceKitError("tool/dev", "Unable to determine the preview address");
  const addressHost = host.includes(":") ? `[${host}]` : host;
  return {
    url: `http://${addressHost}:${address.port}/`,
    get remoteContentRisk() { return experienceWebviewRiskMetadata(bundle.manifest.webviews); },
    async close() {
      watching = false;
      watchAbort.abort();
      if (rebuilding) clearTimeout(rebuilding);
      await activeControl?.catch(() => undefined);
      await buildOperation.catch(() => undefined);
      await new Promise<void>((resolve, reject) => (server as Server).close((error) => error ? reject(error) : resolve()));
    },
  };
}
