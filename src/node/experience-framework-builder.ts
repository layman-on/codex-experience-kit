import { createRequire } from "node:module";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ExperienceValidationError } from "../core/errors.js";

export type ExperienceAuthoringFramework = "react" | "vue";

export interface ExperienceFrameworkBuildOptions {
  root: string;
  sourceRoot: string;
  entry: string;
  framework: ExperienceAuthoringFramework;
  outDir: string;
}

export interface ExperienceFrameworkBuildResult {
  css: string;
  javascript: string;
}

interface ViteModule {
  build(config: Record<string, unknown>): Promise<unknown>;
}

function projectModule(root: string, specifier: string): string {
  const projectRequire = createRequire(path.join(root, "package.json"));
  try {
    return projectRequire.resolve(specifier);
  } catch (error) {
    try {
      return createRequire(import.meta.url).resolve(specifier);
    } catch {
      throw new ExperienceValidationError(
        "tool/framework-dependency",
        `Unable to resolve ${specifier}; run npm install in the Experience project`,
        { cause: error },
      );
    }
  }
}

async function importedDefault(root: string, specifier: string): Promise<(...args: never[]) => unknown> {
  const loaded = await import(pathToFileURL(projectModule(root, specifier)).href) as { default?: unknown };
  if (typeof loaded.default !== "function") {
    throw new ExperienceValidationError("tool/framework-dependency", `${specifier} does not provide a default Vite plugin`);
  }
  return loaded.default as (...args: never[]) => unknown;
}

export async function buildExperienceFrameworkSources(
  options: ExperienceFrameworkBuildOptions,
): Promise<ExperienceFrameworkBuildResult> {
  const vite = await import(pathToFileURL(projectModule(options.root, "vite")).href) as ViteModule;
  if (typeof vite.build !== "function") {
    throw new ExperienceValidationError("tool/framework-dependency", "The installed Vite package does not provide build()");
  }
  const plugins = options.framework === "vue"
    ? [(await importedDefault(options.root, "@vitejs/plugin-vue"))()]
    : [];
  const entry = path.join(options.sourceRoot, options.entry);
  const entryStat = await fs.lstat(entry).catch((error) => {
    throw new ExperienceValidationError("tool/framework-entry", `Unable to read framework entry ${options.entry}`, { cause: error });
  });
  if (!entryStat.isFile() || entryStat.isSymbolicLink()) {
    throw new ExperienceValidationError("tool/framework-entry", `Framework entry ${options.entry} must be a real file`);
  }

  await vite.build({
    root: options.root,
    mode: "production",
    configFile: false,
    publicDir: false,
    logLevel: "error",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    esbuild: { jsxDev: false },
    plugins,
    build: {
      outDir: options.outDir,
      emptyOutDir: true,
      copyPublicDir: false,
      cssCodeSplit: false,
      assetsInlineLimit: 100_000_000,
      minify: "esbuild",
      sourcemap: false,
      lib: {
        entry,
        name: "CodexExperienceApp",
        formats: ["iife"],
        fileName: () => "experience.js",
      },
      rollupOptions: {
        output: {
          inlineDynamicImports: true,
          assetFileNames: "experience[extname]",
        },
      },
    },
  });

  const names = await fs.readdir(options.outDir);
  const javascriptFiles = names.filter((name) => /\.js$/u.test(name));
  const cssFiles = names.filter((name) => /\.css$/u.test(name));
  const unexpected = names.filter((name) => !/\.(?:js|css)$/u.test(name));
  if (javascriptFiles.length !== 1 || unexpected.length > 0) {
    throw new ExperienceValidationError(
      "tool/framework-output",
      `Framework build must emit one JavaScript file and optional CSS only; received: ${names.join(", ")}`,
    );
  }
  const [javascript, cssParts] = await Promise.all([
    fs.readFile(path.join(options.outDir, javascriptFiles[0]!), "utf8"),
    Promise.all(cssFiles.sort().map((name) => fs.readFile(path.join(options.outDir, name), "utf8"))),
  ]);
  return { javascript, css: cssParts.join("\n") };
}
