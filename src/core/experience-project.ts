import { parse } from "parse5";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { ExperienceValidationError } from "./errors.js";
import type { AppearanceTokenModes } from "./appearance-tokens.js";

export const EXPERIENCE_API_VERSION = 1 as const;

export const EXPERIENCE_TARGETS = [
  "app-shell", "navigation", "titlebar", "workspace", "home", "conversation", "composer", "modal", "floating-window",
] as const;
export type ExperienceTarget = (typeof EXPERIENCE_TARGETS)[number];
export const EXPERIENCE_PLANES = ["underlay", "overlay"] as const;
export type ExperiencePlane = (typeof EXPERIENCE_PLANES)[number];
export const EXPERIENCE_SURFACE_INTERACTIONS = ["passthrough", "scoped", "interactive"] as const;
export type ExperienceSurfaceInteraction = (typeof EXPERIENCE_SURFACE_INTERACTIONS)[number];

export const EXPERIENCE_PERMISSIONS = [
  "appearance.tokens",
  "host.actions",
  "remote.webview",
  "codex.context.active",
  "codex.context.metadata",
  "codex.events.lifecycle",
  "codex.instance.configure",
  "codex.conversations.sync",
] as const;
export type ExperiencePermission = (typeof EXPERIENCE_PERMISSIONS)[number];

export const EXPERIENCE_WEBVIEW_SECURITY_MODES = ["strict", "permissive", "unrestricted"] as const;
export type ExperienceWebviewSecurityMode = (typeof EXPERIENCE_WEBVIEW_SECURITY_MODES)[number];

export interface ExperienceWebviewPolicy {
  securityMode?: ExperienceWebviewSecurityMode;
  allowedOrigins?: string[];
}

export interface ExperienceWebviewRiskMetadata {
  riskLevel: "none" | "medium" | "critical";
  securityMode: ExperienceWebviewSecurityMode | null;
  requiresHostGrant: boolean;
  warning: string | null;
  risks: string[];
}

export interface ExperienceProjectManifest {
  apiVersion: typeof EXPERIENCE_API_VERSION;
  id: string;
  name: string;
  version: string;
  entry: "index.html";
  permissions: ExperiencePermission[];
  webviews?: ExperienceWebviewPolicy;
}

export interface ExperienceSurfaceDeclaration {
  target: ExperienceTarget;
  plane: ExperiencePlane;
  interaction: ExperienceSurfaceInteraction;
}

export function experienceSurfaceKey(surface: Pick<ExperienceSurfaceDeclaration, "target" | "plane">): string {
  return `${surface.plane}:${surface.target}`;
}

export interface ExperienceProjectBundle {
  manifest: ExperienceProjectManifest;
  html: string;
  digest: string;
  surfaces: ExperienceSurfaceDeclaration[];
}

export interface InstalledExperienceProject {
  id: string;
  name: string;
  version: string;
  digest: string;
  installedAt: string;
  directory: string;
  permissions: ExperiencePermission[];
  webviews?: ExperienceWebviewPolicy;
  remoteContentRisk: ExperienceWebviewRiskMetadata;
  surfaces: ExperienceSurfaceDeclaration[];
}

export interface ExperienceDevelopmentProject {
  id: string;
  projectId: string;
  name: string;
  version: string;
  digest: string;
  linkedAt: string;
  refreshedAt: string;
  sourceName: string;
  permissions: ExperiencePermission[];
  webviews?: ExperienceWebviewPolicy;
  remoteContentRisk: ExperienceWebviewRiskMetadata;
  surfaces: ExperienceSurfaceDeclaration[];
}

export type ExperienceProjectSourceKind = "installed" | "development";

export type ExperienceProjectImportSource =
  | { kind: "directory"; path: string }
  | { kind: "zip"; path: string };

export interface ImportExperienceProjectOptions {
  conflict?: "reject" | "replace";
}

export interface ExperienceProjectPayload extends ExperienceProjectBundle {
  appearance: "light" | "dark";
  tokens: AppearanceTokenModes;
  allowUnrestrictedRemoteContent?: boolean;
}

export interface ExperienceProjectApplyReceipt {
  targetId: string;
  documentScriptId?: string;
}

const EXPERIENCE_ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u;
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/u;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ExperienceValidationError("project-manifest", `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function parseWebviewPolicy(value: unknown, enabled: boolean): ExperienceWebviewPolicy | undefined {
  if (value === undefined) {
    if (enabled) throw new ExperienceValidationError("project-webview", "remote.webview permission requires a webviews policy");
    return undefined;
  }
  if (!enabled) throw new ExperienceValidationError("project-webview", "webviews policy requires the remote.webview permission");
  const source = record(value, "webviews");
  const allowedKeys = new Set(["securityMode", "allowedOrigins"]);
  for (const key of Object.keys(source)) {
    if (!allowedKeys.has(key)) throw new ExperienceValidationError("project-webview", `Unknown webviews field: ${key}`);
  }
  const securityMode = source.securityMode ?? "strict";
  if (!EXPERIENCE_WEBVIEW_SECURITY_MODES.includes(securityMode as ExperienceWebviewSecurityMode)) {
    throw new ExperienceValidationError("project-webview", "webviews.securityMode must be strict, permissive, or unrestricted");
  }
  if (securityMode !== "strict") {
    if (source.allowedOrigins !== undefined) {
      throw new ExperienceValidationError("project-webview", `webviews.allowedOrigins is available only in strict mode`);
    }
    return { securityMode: securityMode as ExperienceWebviewSecurityMode };
  }
  if (!Array.isArray(source.allowedOrigins) || source.allowedOrigins.length < 1 || source.allowedOrigins.length > 8) {
    throw new ExperienceValidationError("project-webview", "webviews.allowedOrigins must contain 1 to 8 HTTPS origins");
  }
  const origins = source.allowedOrigins.map((item) => {
    if (typeof item !== "string" || item.length > 200) {
      throw new ExperienceValidationError("project-webview", "Every allowed WebView origin must be HTTPS origin text");
    }
    let url: URL;
    try { url = new URL(item); } catch (error) {
      throw new ExperienceValidationError("project-webview", `Invalid WebView origin: ${item}`, { cause: error });
    }
    if (url.protocol !== "https:" || url.username || url.password || item !== url.origin) {
      throw new ExperienceValidationError("project-webview", `WebView origin must be an exact HTTPS origin without credentials or path: ${item}`);
    }
    return url.origin;
  });
  if (new Set(origins).size !== origins.length) {
    throw new ExperienceValidationError("project-webview", "webviews.allowedOrigins must be unique");
  }
  return { securityMode: "strict", allowedOrigins: origins };
}

export function cloneExperienceWebviewPolicy(policy: ExperienceWebviewPolicy): ExperienceWebviewPolicy {
  return {
    securityMode: policy.securityMode ?? "strict",
    ...(policy.allowedOrigins ? { allowedOrigins: [...policy.allowedOrigins] } : {}),
  };
}

export function experienceWebviewRiskMetadata(policy?: ExperienceWebviewPolicy): ExperienceWebviewRiskMetadata {
  if (!policy) return { riskLevel: "none", securityMode: null, requiresHostGrant: false, warning: null, risks: [] };
  const securityMode = policy.securityMode ?? "strict";
  if (securityMode === "strict") {
    return {
      riskLevel: "medium",
      securityMode: "strict",
      requiresHostGrant: false,
      warning: "Remote pages execute untrusted scripts inside a credentialless, origin-restricted sandbox.",
      risks: ["untrusted-scripts", "remote-content"],
    };
  }
  if (securityMode === "permissive") {
    return {
      riskLevel: "medium",
      securityMode: "permissive",
      requiresHostGrant: false,
      warning: "Remote pages may navigate to any HTTP or HTTPS origin while the credentialless sandbox remains enabled.",
      risks: ["untrusted-scripts", "arbitrary-navigation", "insecure-http"],
    };
  }
  return {
    riskLevel: "critical",
    securityMode: "unrestricted",
    requiresHostGrant: true,
    warning: "Unrestricted remote content may use cookies and storage, navigate to untrusted sites, open windows, trigger downloads, request device permissions, execute arbitrary remote scripts, or reach host DOM after a same-origin navigation.",
    risks: [
      "cookies", "storage", "referrer", "arbitrary-navigation", "insecure-http", "popups", "downloads",
      "device-permissions", "top-navigation", "untrusted-scripts", "host-dom-compromise",
    ],
  };
}

export function parseExperienceProjectManifest(input: unknown): ExperienceProjectManifest {
  const source = record(input, "experience.manifest.json");
  const allowed = new Set(["apiVersion", "id", "name", "version", "entry", "permissions", "webviews"]);
  for (const key of Object.keys(source)) {
    if (!allowed.has(key)) throw new ExperienceValidationError("project-manifest", `Unknown manifest field: ${key}`);
  }
  if (source.apiVersion !== EXPERIENCE_API_VERSION) {
    throw new ExperienceValidationError("project-api-version", "Experience apiVersion must be 1");
  }
  if (typeof source.id !== "string" || !EXPERIENCE_ID.test(source.id)) {
    throw new ExperienceValidationError("project-id", "Experience id has an invalid format");
  }
  if (typeof source.name !== "string" || source.name.trim().length < 1 || source.name.length > 100) {
    throw new ExperienceValidationError("project-name", "Experience name must contain 1 to 100 characters");
  }
  if (typeof source.version !== "string" || !VERSION.test(source.version)) {
    throw new ExperienceValidationError("project-version", "Experience version must be semantic version text");
  }
  if (source.entry !== "index.html") {
    throw new ExperienceValidationError("project-entry", "Experience v1 entry must be index.html");
  }
  if (!Array.isArray(source.permissions) || source.permissions.some((item) => typeof item !== "string")) {
    throw new ExperienceValidationError("project-permission", "Experience permissions must be an array");
  }
  const supported = new Set<string>(EXPERIENCE_PERMISSIONS);
  if (source.permissions.some((item) => !supported.has(item as string))) {
    throw new ExperienceValidationError("project-permission", "Experience requests an unsupported permission");
  }
  if (new Set(source.permissions).size !== source.permissions.length) {
    throw new ExperienceValidationError("project-permission", "Experience permissions must be unique");
  }
  const permissions = [...source.permissions] as ExperiencePermission[];
  if (permissions.includes("codex.context.metadata") && !permissions.includes("codex.context.active")) {
    throw new ExperienceValidationError("project-permission", "codex.context.metadata requires codex.context.active");
  }
  for (const permission of ["codex.instance.configure", "codex.conversations.sync"] as const) {
    if (permissions.includes(permission) && !permissions.includes("host.actions")) {
      throw new ExperienceValidationError("project-permission", `${permission} requires host.actions`);
    }
  }
  const webviews = parseWebviewPolicy(source.webviews, permissions.includes("remote.webview"));
  return {
    apiVersion: 1,
    id: source.id,
    name: source.name.trim(),
    version: source.version,
    entry: "index.html",
    permissions,
    ...(webviews ? { webviews } : {}),
  };
}

interface HtmlNode {
  tagName?: string;
  attrs?: Array<{ name: string; value: string }>;
  childNodes?: HtmlNode[];
  content?: HtmlNode;
}

function children(node: HtmlNode): HtmlNode[] {
  return [...(node.childNodes ?? []), ...(node.content?.childNodes ?? [])];
}

export function discoverExperienceSurfaces(html: string): ExperienceSurfaceDeclaration[] {
  if (!html || html.length > 2 * 1024 * 1024) {
    throw new ExperienceValidationError("project-html", "index.html is empty or exceeds 2 MiB");
  }
  const tree = parse(html) as unknown as HtmlNode;
  const declarations: ExperienceSurfaceDeclaration[] = [];
  const seen = new Set<string>();
  const walk = (node: HtmlNode, insideSurface = false): void => {
    const isSurface = node.tagName === "codex-experience-surface";
    if (isSurface) {
      if (insideSurface) throw new ExperienceValidationError("project-surface", "Experience surfaces must not be nested");
      const attributes = new Map(node.attrs?.map((item) => [item.name, item.value]));
      const target = attributes.get("target");
      if (!EXPERIENCE_TARGETS.includes(target as ExperienceTarget)) {
        throw new ExperienceValidationError("project-surface", `Unsupported experience target: ${target ?? "(missing)"}`);
      }
      const plane = attributes.get("plane");
      if (!EXPERIENCE_PLANES.includes(plane as ExperiencePlane)) {
        throw new ExperienceValidationError("project-surface", `Experience surface ${target} has an invalid plane`);
      }
      const interaction = attributes.get("interaction") ?? "passthrough";
      if (!EXPERIENCE_SURFACE_INTERACTIONS.includes(interaction as ExperienceSurfaceInteraction)) {
        throw new ExperienceValidationError("project-surface", `Experience surface ${target} has an invalid interaction mode`);
      }
      if (plane === "underlay" && interaction !== "passthrough") {
        throw new ExperienceValidationError("project-surface", `Experience surface underlay:${target} must use passthrough interaction`);
      }
      if (target === "floating-window" && (plane !== "overlay" || interaction === "passthrough")) {
        throw new ExperienceValidationError("project-surface", "Experience surface floating-window must be an interactive or scoped overlay");
      }
      const key = `${plane}:${target}`;
      if (seen.has(key)) throw new ExperienceValidationError("project-surface", `Experience surface ${key} is declared more than once`);
      seen.add(key);
      declarations.push({ target: target as ExperienceTarget, plane: plane as ExperiencePlane, interaction: interaction as ExperienceSurfaceInteraction });
    }
    for (const child of children(node)) walk(child, insideSurface || isSurface);
  };
  walk(tree);
  if (declarations.length === 0) {
    throw new ExperienceValidationError("project-surface", "index.html must declare at least one codex-experience-surface");
  }
  return declarations;
}

export function assertExperienceProjectBundle(input: ExperienceProjectBundle): ExperienceProjectBundle {
  const manifest = parseExperienceProjectManifest(input.manifest);
  const surfaces = discoverExperienceSurfaces(input.html);
  if (manifest.permissions.includes("remote.webview")
    && !surfaces.some((surface) => surface.plane === "overlay" && surface.interaction === "interactive")) {
    throw new ExperienceValidationError("project-webview", "remote.webview requires at least one interactive overlay surface");
  }
  if (!/^[0-9a-f]{64}$/u.test(input.digest)) {
    throw new ExperienceValidationError("project-digest", "Experience digest is invalid");
  }
  return { manifest, html: input.html, digest: input.digest, surfaces };
}

export function createExperienceProjectDigest(manifest: ExperienceProjectManifest, html: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(`${JSON.stringify(manifest)}\0${html}`)));
}
