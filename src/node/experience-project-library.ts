import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { ExperienceKitError, ExperienceValidationError } from "../core/errors.js";
import {
  assertExperienceProjectBundle,
  cloneExperienceWebviewPolicy,
  experienceWebviewRiskMetadata,
  createExperienceProjectDigest,
  type ImportExperienceProjectOptions,
  type InstalledExperienceProject,
  type ExperienceProjectBundle,
  type ExperienceProjectImportSource,
  type ExperienceProjectManifest,
  type ExperienceSurfaceDeclaration,
} from "../core/experience-project.js";
import { readExperienceProjectPackage } from "./experience-project-package.js";

interface StoredProjectMetadata {
  storageVersion: 1;
  installedAt: string;
  manifest: ExperienceProjectManifest;
  digest: string;
  surfaces: ExperienceSurfaceDeclaration[];
}

const EXPERIENCE_ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u;

function dto(metadata: StoredProjectMetadata, directory: string): InstalledExperienceProject {
  return {
    id: metadata.manifest.id,
    name: metadata.manifest.name,
    version: metadata.manifest.version,
    digest: metadata.digest,
    installedAt: metadata.installedAt,
    directory,
    permissions: [...metadata.manifest.permissions],
    ...(metadata.manifest.webviews ? { webviews: cloneExperienceWebviewPolicy(metadata.manifest.webviews) } : {}),
    remoteContentRisk: experienceWebviewRiskMetadata(metadata.manifest.webviews),
    surfaces: metadata.surfaces.map((surface) => ({ ...surface })),
  };
}

export class ExperienceProjectLibrary {
  readonly projectsPath: string;
  readonly stagingPath: string;

  constructor(public readonly rootPath: string) {
    this.projectsPath = path.join(rootPath, "experience-projects-v1");
    this.stagingPath = path.join(rootPath, ".experience-project-staging");
  }

  async initialize(): Promise<void> {
    await Promise.all([
      fs.mkdir(this.projectsPath, { recursive: true, mode: 0o700 }),
      fs.mkdir(this.stagingPath, { recursive: true, mode: 0o700 }),
    ]);
  }

  async importProject(source: ExperienceProjectImportSource, options: ImportExperienceProjectOptions = {}): Promise<InstalledExperienceProject> {
    await this.initialize();
    const bundle = await readExperienceProjectPackage(source);
    const id = bundle.manifest.id;
    const destination = path.join(this.projectsPath, id);
    const stage = path.join(this.stagingPath, `${id}-${randomUUID()}`);
    const metadata: StoredProjectMetadata = {
      storageVersion: 1,
      installedAt: new Date().toISOString(),
      manifest: bundle.manifest,
      digest: bundle.digest,
      surfaces: bundle.surfaces,
    };
    await fs.mkdir(stage, { mode: 0o700 });
    try {
      await Promise.all([
        fs.writeFile(path.join(stage, "experience.manifest.json"), `${JSON.stringify(bundle.manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 }),
        fs.writeFile(path.join(stage, "index.html"), bundle.html, { flag: "wx", mode: 0o600 }),
        fs.writeFile(path.join(stage, "metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`, { flag: "wx", mode: 0o600 }),
      ]);
      const existing = await this.tryMetadata(destination);
      if (existing?.digest === bundle.digest) return dto(existing, destination);
      if (existing && options.conflict !== "replace") {
        throw new ExperienceKitError("import/conflict", `Experience project ${id} is already installed with different content`);
      }
      if (!existing) await fs.rename(stage, destination);
      else {
        const backup = path.join(this.stagingPath, `${id}-backup-${randomUUID()}`);
        await fs.rename(destination, backup);
        try {
          await fs.rename(stage, destination);
          await fs.rm(backup, { recursive: true, force: false });
        } catch (error) {
          await fs.rename(backup, destination).catch(() => undefined);
          throw error;
        }
      }
      return dto(metadata, destination);
    } finally {
      await fs.rm(stage, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async listProjects(): Promise<InstalledExperienceProject[]> {
    await this.initialize();
    const output: InstalledExperienceProject[] = [];
    for (const entry of await fs.readdir(this.projectsPath, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !EXPERIENCE_ID.test(entry.name)) continue;
      const directory = path.join(this.projectsPath, entry.name);
      const metadata = await this.tryMetadata(directory);
      if (metadata?.manifest.id === entry.name) output.push(dto(metadata, directory));
    }
    return output.sort((left, right) => left.name.localeCompare(right.name));
  }

  async loadProject(id: string): Promise<ExperienceProjectBundle> {
    await this.initialize();
    if (!EXPERIENCE_ID.test(id)) throw new ExperienceValidationError("project-id", "Experience project id is invalid");
    const directory = path.join(this.projectsPath, id);
    const metadata = await this.readMetadata(directory);
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const expected = new Set(["experience.manifest.json", "index.html", "metadata.json"]);
    if (entries.length !== expected.size || entries.some((entry) => !entry.isFile() || entry.isSymbolicLink() || !expected.has(entry.name))) {
      throw new ExperienceValidationError("project-storage", "Stored experience project contains unsupported entries");
    }
    const html = await fs.readFile(path.join(directory, "index.html"), "utf8");
    const bundle = assertExperienceProjectBundle({ manifest: metadata.manifest, html, digest: metadata.digest, surfaces: metadata.surfaces });
    if (createExperienceProjectDigest(bundle.manifest, bundle.html) !== metadata.digest) {
      throw new ExperienceValidationError("project-storage", "Stored experience project content has changed since import");
    }
    if (JSON.stringify(bundle.surfaces) !== JSON.stringify(metadata.surfaces)) {
      throw new ExperienceValidationError("project-storage", "Stored experience surfaces do not match metadata");
    }
    return bundle;
  }

  async removeProject(id: string): Promise<void> {
    const directory = path.join(this.projectsPath, id);
    const metadata = await this.readMetadata(directory);
    if (metadata.manifest.id !== id) throw new ExperienceValidationError("project-storage", "Stored project identity does not match its directory");
    await fs.rm(directory, { recursive: true, force: false });
  }

  private async tryMetadata(directory: string): Promise<StoredProjectMetadata | null> {
    try { return await this.readMetadata(directory); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private async readMetadata(directory: string): Promise<StoredProjectMetadata> {
    const root = await fs.lstat(directory);
    if (!root.isDirectory() || root.isSymbolicLink()) throw new ExperienceValidationError("project-storage", "Stored project directory is unsafe");
    const value = JSON.parse(await fs.readFile(path.join(directory, "metadata.json"), "utf8")) as StoredProjectMetadata;
    if (value.storageVersion !== 1 || !value.manifest || typeof value.installedAt !== "string" || !/^[0-9a-f]{64}$/u.test(value.digest)) {
      throw new ExperienceValidationError("project-storage", "Stored project metadata is invalid");
    }
    const bundle = assertExperienceProjectBundle({
      manifest: value.manifest,
      html: await fs.readFile(path.join(directory, "index.html"), "utf8"),
      digest: value.digest,
      surfaces: value.surfaces,
    });
    if (createExperienceProjectDigest(bundle.manifest, bundle.html) !== value.digest) {
      throw new ExperienceValidationError("project-storage", "Stored experience project content has changed since import");
    }
    return { ...value, manifest: bundle.manifest, surfaces: bundle.surfaces };
  }
}
