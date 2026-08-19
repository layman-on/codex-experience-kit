import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { parse, serialize } from "parse5";
import yauzl, { type Entry, type ZipFile } from "yauzl";
import { ExperienceKitError, ExperienceValidationError } from "../core/errors.js";
import {
  assertExperienceProjectBundle,
  discoverExperienceSurfaces,
  createExperienceProjectDigest,
  parseExperienceProjectManifest,
  type ExperienceProjectBundle,
  type ExperienceProjectImportSource,
} from "../core/experience-project.js";

const MAX_ZIP_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_FILES = 128;
const OPEN_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
const UTF8 = new TextDecoder("utf-8", { fatal: true });

interface HtmlNode {
  nodeName: string;
  tagName?: string;
  attrs?: Array<{ name: string; value: string }>;
  childNodes?: HtmlNode[];
  parentNode?: HtmlNode;
  content?: HtmlNode;
  value?: string;
}

function normalizeFileName(value: string): string {
  if (!value || value.includes("\\") || value.startsWith("/") || value.includes("\0")) {
    throw new ExperienceValidationError("project-path", `Unsafe package path: ${value}`);
  }
  const normalized = path.posix.normalize(value);
  const parts = normalized.split("/");
  if (normalized === "." || normalized.startsWith("../") || parts.some((part) => part === ".." || part.startsWith("."))) {
    throw new ExperienceValidationError("project-path", `Unsafe package path: ${value}`);
  }
  if (parts.length > 8) throw new ExperienceValidationError("project-path", `Package path is too deep: ${value}`);
  return normalized;
}

function fileLimit(name: string): number {
  if (name === "index.html") return 2 * 1024 * 1024;
  if (name === "experience.manifest.json") return 64 * 1024;
  if (/\.(?:css|js|mjs|json|svg|txt)$/iu.test(name)) return 2 * 1024 * 1024;
  return MAX_FILE_BYTES;
}

async function readStableFile(filePath: string, limit: number): Promise<Uint8Array> {
  const handle = await fs.open(filePath, OPEN_FLAGS).catch((error) => {
    throw new ExperienceValidationError("project-file", `Unable to open ${path.basename(filePath)} safely`, { cause: error });
  });
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size < 1 || before.size > limit) {
      throw new ExperienceValidationError("project-size", `${path.basename(filePath)} is empty or too large`);
    }
    const value = await handle.readFile();
    const after = await handle.stat();
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw new ExperienceValidationError("project-file", `${path.basename(filePath)} changed while being read`);
    }
    return new Uint8Array(value);
  } finally {
    await handle.close();
  }
}

async function readDirectory(sourcePath: string): Promise<Map<string, Uint8Array>> {
  const root = await fs.realpath(sourcePath);
  const rootStat = await fs.lstat(sourcePath);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new ExperienceValidationError("project-directory", "Experience project must be a real directory");
  }
  const files = new Map<string, Uint8Array>();
  let total = 0;
  const visit = async (directory: string, prefix: string): Promise<void> => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const name = normalizeFileName(prefix ? `${prefix}/${entry.name}` : entry.name);
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new ExperienceValidationError("project-link", `Symbolic links are not allowed: ${name}`);
      if (entry.isDirectory()) {
        await visit(absolute, name);
        continue;
      }
      if (!entry.isFile()) throw new ExperienceValidationError("project-file", `Unsupported package entry: ${name}`);
      if (++total > MAX_FILES) throw new ExperienceValidationError("project-files", `Experience project supports at most ${MAX_FILES} files`);
      const bytes = await readStableFile(absolute, fileLimit(name));
      files.set(name, bytes);
    }
  };
  await visit(root, "");
  const bytes = [...files.values()].reduce((sum, item) => sum + item.byteLength, 0);
  if (bytes > MAX_TOTAL_BYTES) throw new ExperienceValidationError("project-size", "Experience project exceeds 64 MiB");
  return files;
}

function openZip(buffer: Buffer): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true, decodeStrings: true, strictFileNames: true, validateEntrySizes: true }, (error, zip) => {
      if (error || !zip) reject(error ?? new Error("Unable to open ZIP"));
      else resolve(zip);
    });
  });
}

function zipEntry(zip: ZipFile, entry: Entry, limit: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error || !stream) return reject(error ?? new Error("Unable to read ZIP entry"));
      const chunks: Buffer[] = [];
      let total = 0;
      stream.on("data", (chunk: Buffer) => {
        total += chunk.length;
        if (total > limit) stream.destroy(new ExperienceValidationError("project-size", `${entry.fileName} is too large`));
        else chunks.push(chunk);
      });
      stream.once("error", reject);
      stream.once("end", () => resolve(new Uint8Array(Buffer.concat(chunks, total))));
    });
  });
}

async function readZip(sourcePath: string): Promise<Map<string, Uint8Array>> {
  const stat = await fs.lstat(sourcePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > MAX_ZIP_BYTES) {
    throw new ExperienceValidationError("project-zip", "Experience ZIP must be a real file no larger than 32 MiB");
  }
  const zip = await openZip(await fs.readFile(sourcePath));
  const raw = new Map<string, Uint8Array>();
  let declared = 0;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      zip.close();
      error ? reject(error) : resolve();
    };
    zip.once("error", finish);
    zip.once("end", () => finish());
    zip.on("entry", (entry: Entry) => {
      void (async () => {
        if (entry.fileName.endsWith("/")) return zip.readEntry();
        const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
        if ((mode & 0xf000) === 0xa000) throw new ExperienceValidationError("project-link", `ZIP link is not allowed: ${entry.fileName}`);
        const name = normalizeFileName(entry.fileName);
        if (raw.size >= MAX_FILES) throw new ExperienceValidationError("project-files", `Experience project supports at most ${MAX_FILES} files`);
        if (raw.has(name)) throw new ExperienceValidationError("project-files", `ZIP repeats ${name}`);
        declared += entry.uncompressedSize;
        if (declared > MAX_TOTAL_BYTES || entry.uncompressedSize > fileLimit(name)) {
          throw new ExperienceValidationError("project-size", `${name} exceeds its size limit`);
        }
        raw.set(name, await zipEntry(zip, entry, fileLimit(name)));
        zip.readEntry();
      })().catch(finish);
    });
    zip.readEntry();
  });
  const names = [...raw.keys()];
  const hasRootFiles = names.includes("index.html") || names.includes("experience.manifest.json");
  if (hasRootFiles) return raw;
  const roots = new Set(names.map((name) => name.split("/")[0]));
  if (roots.size !== 1) throw new ExperienceValidationError("project-root", "ZIP must contain one experience project root");
  const root = [...roots][0]!;
  return new Map(names.map((name) => [normalizeFileName(name.slice(root.length + 1)), raw.get(name)!]));
}

function decode(files: ReadonlyMap<string, Uint8Array>, name: string): string {
  const bytes = files.get(name);
  if (!bytes) throw new ExperienceValidationError("project-files", `Experience project is missing ${name}`);
  try { return UTF8.decode(bytes); } catch (error) {
    throw new ExperienceValidationError("project-encoding", `${name} must be UTF-8`, { cause: error });
  }
}

function mime(name: string): string {
  const extension = path.posix.extname(name).toLowerCase();
  return ({
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
    ".gif": "image/gif", ".svg": "image/svg+xml", ".woff": "font/woff", ".woff2": "font/woff2",
    ".mp3": "audio/mpeg", ".wav": "audio/wav", ".mp4": "video/mp4", ".json": "application/json",
  } as Record<string, string>)[extension] ?? "application/octet-stream";
}

function resolveLocal(reference: string, from: string, files: ReadonlyMap<string, Uint8Array>): string {
  const clean = reference.trim();
  if (!clean || clean.startsWith("#") || clean.startsWith("data:")) return clean;
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|\/)/iu.test(clean)) {
    throw new ExperienceValidationError("project-network", `External URL is not allowed: ${clean}`);
  }
  const [pathname, suffix = ""] = clean.split(/(?=[?#])/u, 2);
  const name = normalizeFileName(path.posix.join(path.posix.dirname(from), pathname!));
  const bytes = files.get(name);
  if (!bytes) throw new ExperienceValidationError("project-asset", `Missing package asset: ${name}`);
  return `data:${mime(name)};base64,${Buffer.from(bytes).toString("base64")}${suffix}`;
}

function compileCss(css: string, from: string, files: ReadonlyMap<string, Uint8Array>): string {
  if (/@import\s/iu.test(css)) throw new ExperienceValidationError("project-css", "CSS @import is not supported; use one bundled stylesheet");
  return css.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/giu, (_match, _quote, value: string) => `url("${resolveLocal(value, from, files)}")`);
}

function attribute(node: HtmlNode, name: string): { name: string; value: string } | undefined {
  return node.attrs?.find((item) => item.name === name);
}

function replaceNode(node: HtmlNode, next: HtmlNode): void {
  const parent = node.parentNode;
  const index = parent?.childNodes?.indexOf(node) ?? -1;
  if (!parent?.childNodes || index < 0) throw new ExperienceValidationError("project-html", "Unable to compile an HTML resource");
  next.parentNode = parent;
  parent.childNodes[index] = next;
}

function compileHtml(source: string, files: ReadonlyMap<string, Uint8Array>): string {
  const tree = parse(source) as unknown as HtmlNode;
  const walk = (node: HtmlNode): void => {
    if (node.tagName === "meta" && attribute(node, "http-equiv")?.value.toLowerCase() === "content-security-policy") {
      const parent = node.parentNode;
      if (parent?.childNodes) parent.childNodes = parent.childNodes.filter((item) => item !== node);
      return;
    }
    if (node.tagName === "link" && attribute(node, "rel")?.value.toLowerCase() === "stylesheet") {
      const href = attribute(node, "href")?.value;
      if (!href) throw new ExperienceValidationError("project-html", "Stylesheet link is missing href");
      const cssName = normalizeFileName(href);
      const css = compileCss(decode(files, cssName), cssName, files);
      replaceNode(node, { nodeName: "style", tagName: "style", attrs: [], childNodes: [{ nodeName: "#text", value: css }] });
      return;
    }
    if (node.tagName === "script") {
      const src = attribute(node, "src");
      if (src) {
        const scriptName = normalizeFileName(src.value);
        const script = decode(files, scriptName);
        if (/<\/script/iu.test(script)) throw new ExperienceValidationError("project-script", `${scriptName} contains a closing script tag`);
        if (attribute(node, "type")?.value === "module" && /\b(?:import|export)\s+(?:[^"']+\s+from\s+)?["']\./u.test(script)) {
          throw new ExperienceValidationError("project-module", "Relative multi-file ESM imports are not supported; bundle JavaScript first");
        }
        node.attrs = (node.attrs ?? []).filter((item) => item !== src);
        node.childNodes = [{ nodeName: "#text", value: script, parentNode: node }];
      }
    }
    if (node.tagName === "style") {
      const text = node.childNodes?.find((item) => item.nodeName === "#text");
      if (text?.value) text.value = compileCss(text.value, "index.html", files);
    }
    for (const name of ["src", "poster"]) {
      const item = attribute(node, name);
      if (item && node.tagName !== "script") item.value = resolveLocal(item.value, "index.html", files);
    }
    const style = attribute(node, "style");
    if (style) style.value = compileCss(style.value, "index.html", files);
    const href = attribute(node, "href");
    if (href && node.tagName !== "link" && !href.value.startsWith("#")) {
      throw new ExperienceValidationError("project-link", "Experience links must use host actions instead of direct navigation");
    }
    for (const child of [...(node.childNodes ?? []), ...(node.content?.childNodes ?? [])]) walk(child);
  };
  walk(tree);
  const html = serialize(tree as never);
  discoverExperienceSurfaces(html);
  return html;
}

export async function readExperienceProjectPackage(source: ExperienceProjectImportSource): Promise<ExperienceProjectBundle> {
  try {
    const files = source.kind === "directory" ? await readDirectory(source.path) : await readZip(source.path);
    if (!files.has("experience.manifest.json") && (files.has("theme.manifest.json") || files.has("theme.json"))) {
      throw new ExperienceValidationError("project-legacy", "旧主题格式不再支持；请使用 experience.manifest.json + index.html");
    }
    const manifest = parseExperienceProjectManifest(JSON.parse(decode(files, "experience.manifest.json")));
    const html = compileHtml(decode(files, manifest.entry), files);
    const digest = createExperienceProjectDigest(manifest, html);
    return assertExperienceProjectBundle({ manifest, html, digest, surfaces: discoverExperienceSurfaces(html) });
  } catch (error) {
    if (error instanceof ExperienceKitError) throw error;
    throw new ExperienceKitError("project-import", `Unable to import experience project: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}
