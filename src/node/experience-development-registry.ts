import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { ExperienceKitError, ExperienceValidationError } from "../core/errors.js";
import {
  assertExperienceProjectBundle,
  cloneExperienceWebviewPolicy,
  experienceWebviewRiskMetadata,
  createExperienceProjectDigest,
  type ExperienceDevelopmentProject,
  type ExperienceProjectBundle,
  type ExperienceProjectManifest,
  type ExperienceSurfaceDeclaration,
} from "../core/experience-project.js";
import { readExperienceProjectPackage } from "./experience-project-package.js";

interface StoredDevelopmentMetadata {
  storageVersion: 1;
  id: string;
  sourcePath: string;
  sourceName: string;
  linkedAt: string;
  refreshedAt: string;
  manifest: ExperienceProjectManifest;
  digest: string;
  surfaces: ExperienceSurfaceDeclaration[];
}

export interface ReplaceDevelopmentSnapshotOptions {
  refreshedAt?: string;
}

const DEVELOPMENT_ID = /^dev\.[0-9a-f]{24}$/u;
const SNAPSHOT_FILES = new Set(["experience.manifest.json", "index.html", "metadata.json"]);

function developmentId(sourcePath: string): string {
  return `dev.${createHash("sha256").update(sourcePath).digest("hex").slice(0, 24)}`;
}

function dto(metadata: StoredDevelopmentMetadata): ExperienceDevelopmentProject {
  return {
    id: metadata.id,
    projectId: metadata.manifest.id,
    name: metadata.manifest.name,
    version: metadata.manifest.version,
    digest: metadata.digest,
    linkedAt: metadata.linkedAt,
    refreshedAt: metadata.refreshedAt,
    sourceName: metadata.sourceName,
    permissions: [...metadata.manifest.permissions],
    ...(metadata.manifest.webviews ? { webviews: cloneExperienceWebviewPolicy(metadata.manifest.webviews) } : {}),
    remoteContentRisk: experienceWebviewRiskMetadata(metadata.manifest.webviews),
    surfaces: metadata.surfaces.map((surface) => ({ ...surface })),
  };
}

export class ExperienceDevelopmentRegistry {
  readonly projectsPath: string;
  readonly stagingPath: string;

  constructor(public readonly rootPath: string) {
    this.projectsPath = path.join(rootPath, "experience-development-v1");
    this.stagingPath = path.join(rootPath, ".experience-development-staging");
  }

  async initialize(): Promise<void> {
    await Promise.all([
      fs.mkdir(this.projectsPath, { recursive: true, mode: 0o700 }),
      fs.mkdir(this.stagingPath, { recursive: true, mode: 0o700 }),
    ]);
  }

  async linkProject(sourcePath: string): Promise<ExperienceDevelopmentProject> {
    await this.initialize();
    const source = await this.resolveSource(sourcePath);
    const id = developmentId(source);
    const directory = path.join(this.projectsPath, id);
    const existing = await this.tryMetadata(directory);
    if (existing && existing.sourcePath !== source) {
      throw new ExperienceKitError("development/collision", "Development experience source identity collided");
    }
    if (existing) return dto(existing);
    const bundle = await readExperienceProjectPackage({ kind: "directory", path: source });
    const now = new Date().toISOString();
    const metadata: StoredDevelopmentMetadata = {
      storageVersion: 1,
      id,
      sourcePath: source,
      sourceName: path.basename(source),
      linkedAt: now,
      refreshedAt: now,
      manifest: bundle.manifest,
      digest: bundle.digest,
      surfaces: bundle.surfaces,
    };
    await this.writeSnapshot(metadata, bundle);
    return dto(metadata);
  }

  async listProjects(): Promise<ExperienceDevelopmentProject[]> {
    await this.initialize();
    const output: ExperienceDevelopmentProject[] = [];
    for (const entry of await fs.readdir(this.projectsPath, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !DEVELOPMENT_ID.test(entry.name)) continue;
      const metadata = await this.tryMetadata(path.join(this.projectsPath, entry.name));
      if (metadata?.id === entry.name) output.push(dto(metadata));
    }
    return output.sort((left, right) => left.name.localeCompare(right.name));
  }

  async getProject(id: string): Promise<ExperienceDevelopmentProject> {
    return dto(await this.readMetadata(this.directory(id)));
  }

  async loadProject(id: string): Promise<ExperienceProjectBundle> {
    const directory = this.directory(id);
    const metadata = await this.readMetadata(directory);
    const entries = await fs.readdir(directory, { withFileTypes: true });
    if (entries.length !== SNAPSHOT_FILES.size || entries.some((entry) => !entry.isFile() || entry.isSymbolicLink() || !SNAPSHOT_FILES.has(entry.name))) {
      throw new ExperienceValidationError("development/storage", "Stored development snapshot contains unsupported entries");
    }
    return this.bundleFromMetadata(directory, metadata);
  }

  async readSourceProject(id: string): Promise<ExperienceProjectBundle> {
    const metadata = await this.readMetadata(this.directory(id));
    const bundle = await readExperienceProjectPackage({ kind: "directory", path: metadata.sourcePath });
    if (bundle.manifest.id !== metadata.manifest.id) {
      throw new ExperienceValidationError("development/project-id", "A linked development directory cannot change its experience project id");
    }
    return bundle;
  }

  async replaceSnapshot(
    id: string,
    bundle: ExperienceProjectBundle,
    options: ReplaceDevelopmentSnapshotOptions = {},
  ): Promise<ExperienceDevelopmentProject> {
    const current = await this.readMetadata(this.directory(id));
    const validated = assertExperienceProjectBundle(bundle);
    if (validated.manifest.id !== current.manifest.id) {
      throw new ExperienceValidationError("development/project-id", "A linked development directory cannot change its experience project id");
    }
    const metadata: StoredDevelopmentMetadata = {
      ...current,
      refreshedAt: options.refreshedAt ?? new Date().toISOString(),
      manifest: validated.manifest,
      digest: validated.digest,
      surfaces: validated.surfaces,
    };
    await this.writeSnapshot(metadata, validated);
    return dto(metadata);
  }

  async removeProject(id: string): Promise<void> {
    const directory = this.directory(id);
    await this.readMetadata(directory);
    await fs.rm(directory, { recursive: true, force: false });
  }

  private directory(id: string): string {
    if (!DEVELOPMENT_ID.test(id)) throw new ExperienceValidationError("development/id", "Development experience id is invalid");
    return path.join(this.projectsPath, id);
  }

  private async resolveSource(sourcePath: string): Promise<string> {
    if (!path.isAbsolute(sourcePath)) throw new ExperienceValidationError("development/source", "Development experience source must be an absolute directory path");
    const stat = await fs.lstat(sourcePath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new ExperienceValidationError("development/source", "Development experience source must be a real directory");
    }
    return fs.realpath(sourcePath);
  }

  private async writeSnapshot(metadata: StoredDevelopmentMetadata, bundle: ExperienceProjectBundle): Promise<void> {
    const destination = this.directory(metadata.id);
    const stage = path.join(this.stagingPath, `${metadata.id}-${randomUUID()}`);
    await fs.mkdir(stage, { recursive: false, mode: 0o700 });
    try {
      await Promise.all([
        fs.writeFile(path.join(stage, "experience.manifest.json"), `${JSON.stringify(bundle.manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 }),
        fs.writeFile(path.join(stage, "index.html"), bundle.html, { flag: "wx", mode: 0o600 }),
        fs.writeFile(path.join(stage, "metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`, { flag: "wx", mode: 0o600 }),
      ]);
      const existing = await this.tryMetadata(destination);
      if (!existing) await fs.rename(stage, destination);
      else {
        const backup = path.join(this.stagingPath, `${metadata.id}-backup-${randomUUID()}`);
        await fs.rename(destination, backup);
        try {
          await fs.rename(stage, destination);
        } catch (error) {
          await fs.rename(backup, destination).catch(() => undefined);
          throw error;
        }
        // The new snapshot is already committed. A stale backup is harmless and
        // may be cleaned later; treating backup cleanup as a failed commit could
        // no longer restore it over the live destination atomically.
        await fs.rm(backup, { recursive: true, force: false }).catch(() => undefined);
      }
    } finally {
      await fs.rm(stage, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async tryMetadata(directory: string): Promise<StoredDevelopmentMetadata | null> {
    try { return await this.readMetadata(directory); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private async readMetadata(directory: string): Promise<StoredDevelopmentMetadata> {
    const root = await fs.lstat(directory);
    if (!root.isDirectory() || root.isSymbolicLink()) throw new ExperienceValidationError("development/storage", "Stored development directory is unsafe");
    const value = JSON.parse(await fs.readFile(path.join(directory, "metadata.json"), "utf8")) as StoredDevelopmentMetadata;
    if (value.storageVersion !== 1 || !DEVELOPMENT_ID.test(value.id) || path.basename(directory) !== value.id
      || !path.isAbsolute(value.sourcePath) || typeof value.sourceName !== "string" || !value.sourceName
      || typeof value.linkedAt !== "string" || typeof value.refreshedAt !== "string"
      || !value.manifest || !/^[0-9a-f]{64}$/u.test(value.digest)) {
      throw new ExperienceValidationError("development/storage", "Stored development metadata is invalid");
    }
    const bundle = await this.bundleFromMetadata(directory, value);
    return { ...value, manifest: bundle.manifest, surfaces: bundle.surfaces };
  }

  private async bundleFromMetadata(directory: string, metadata: StoredDevelopmentMetadata): Promise<ExperienceProjectBundle> {
    const html = await fs.readFile(path.join(directory, "index.html"), "utf8");
    const bundle = assertExperienceProjectBundle({ manifest: metadata.manifest, html, digest: metadata.digest, surfaces: metadata.surfaces });
    if (createExperienceProjectDigest(bundle.manifest, bundle.html) !== metadata.digest) {
      throw new ExperienceValidationError("development/storage", "Stored development snapshot changed outside Experience Kit");
    }
    if (JSON.stringify(bundle.surfaces) !== JSON.stringify(metadata.surfaces)) {
      throw new ExperienceValidationError("development/storage", "Stored development surfaces do not match metadata");
    }
    return bundle;
  }
}
