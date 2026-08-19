import { strToU8, zipSync } from "fflate";
import type { ExperienceProjectManifest } from "../core/experience-project.js";

export type ExperienceProjectFramework = "react" | "vue";

export interface ExperienceProjectStarterOptions {
  id?: string;
  name?: string;
  packageName?: string;
  framework?: ExperienceProjectFramework;
}

export type ExperienceProjectStarterFiles = Record<string, string>;

function framework(input: ExperienceProjectStarterOptions): ExperienceProjectFramework {
  const value = input.framework ?? "react";
  if (value !== "react" && value !== "vue") throw new TypeError("framework must be react or vue");
  return value;
}

function manifest(input: ExperienceProjectStarterOptions): ExperienceProjectManifest {
  return {
    apiVersion: 1,
    id: input.id ?? "private.my-experience",
    name: input.name ?? "My Codex Experience",
    version: "0.1.0",
    entry: "index.html",
    permissions: ["appearance.tokens"],
  };
}

function agents(selected: ExperienceProjectFramework): string {
  return `# Experience project instructions

Before changing this project, read README.md, EXPERIENCE-BRIEF.md, and docs/AI-GENERATION.zh-CN.md completely.

- This is a ${selected === "react" ? "React" : "Vue"} Experience project. Build surfaces as framework components; do not create or edit runtime HTML by hand.
- Surface placement belongs in experience.config.json. Each surface owns one directory under src/surfaces/, including its component and styles. Generated files belong in dist/ and must not be edited.
- Build with \`npm run build\`; validate with \`npm run check\`; preview with \`npm run dev\`.
- For native remote-page preview, install project-local Electron once and run \`npm run dev:native -- --allow-unrestricted-remote-content\`.
- Opening \`npm run dev\` is synthetic, but its Apply/Restore toolbar controls the user's real Codex. Automated preview checks must never click those controls.
- \`npm run apply\` connects to the user's real Codex. Run it only when the user explicitly asks; pass \`--allow-restart\` only after they confirm current work is saved. Automated checks must remain synthetic.
- Every configured surface has an explicit target and plane. Underlays are always passthrough. Use scoped overlays for small controls and register only their actual DOM elements.
- Keep the center reading area transparent when EXPERIENCE-BRIEF.md asks for native Codex content.
- Use \`--cek-*\` appearance tokens. Verify both light and dark modes.
- Never read Codex DOM, Electron, Node.js, CDP, or the filesystem. Network access is denied except through an explicitly declared \`remote.webview\` policy.
- Never create raw \`webview\` or remote \`iframe\` elements. Remote content requires the \`remote.webview\` permission, a declared security mode, an interactive overlay, and \`window.codexExperience.webviews.mount()\`.
- Keep WebViews in strict mode unless the user explicitly requests permissive or unrestricted behavior. Unrestricted mode is critical risk and requires the host/CLI grant \`--allow-unrestricted-remote-content\`; always repeat its security warning in delivery notes.
- Local assets only. Import them through the framework build; request missing or unlicensed source material from the user.
- Request \`host.actions\` only when an interaction actually emits an action.
- Request \`codex.instance.configure\` only when the user explicitly asks for a second-account configuration picker. Use only catalog item ids returned by \`codex.instance.transfer-catalog\`; never invent or accept filesystem paths. Request \`codex.conversations.sync\` only when the user also chooses conversation migration, which must default off.
- Request \`codex.context.active\` only when the experience changes with the selected task. Add \`codex.context.metadata\` only when the task display name is needed. Request \`codex.events.lifecycle\` only when it reacts to task/turn lifecycle events. These capabilities never expose prompts, responses, cwd, or repository paths.
- If EXPERIENCE-BRIEF.md contains unresolved questions, ask the user before generating the final experience.
`;
}

function readme(name: string, selected: ExperienceProjectFramework): string {
  return `# ${name}

This is a ${selected === "react" ? "React" : "Vue"} Codex Experience project. Source components compile to the fixed sandboxed HTML runtime contract; an external host is not required.

## Commands

\`npm install\` installs the project-local authoring toolchain.

\`npm run dev\` builds, watches real source/config/asset inputs, and opens a standalone simulated Codex preview. It remains stable while idle and reloads once after an input change. The toolbar can independently show or hide underlay and overlay, explicitly apply the latest build to Codex, or restore the official view.

\`npm run dev:native\` opens the same synthetic preview in a separate Electron window. Unrestricted \`remote.webview\` content uses a native \`WebContentsView\`, so pages that block iframe embedding can render and receive clicks. Install Electron once with \`npm install --save-dev electron\`. This preview never connects to Codex unless you explicitly click Apply.

\`npm run build\` bundles framework components and compiles them into \`dist/\`.

\`npm run check\` validates output, permissions, surfaces, assets, and sandbox rules.

\`npm run pack\` creates an importable ZIP in \`releases/\`.

\`npm run apply\` builds and applies this project directly to Codex. The first connection may require \`npm run apply -- --allow-restart\`; later runs hot-refresh without another restart.

Projects that explicitly request unrestricted remote content require \`npm run dev -- --allow-unrestricted-remote-content\` (browser fallback), \`npm run dev:native -- --allow-unrestricted-remote-content\` (native Electron preview), and \`npm run apply -- --allow-unrestricted-remote-content\`. This removes package WebView protections and must never be enabled for an untrusted project.

## Structure

- \`experience.config.json\`: framework, source/output paths, appearance seed, and semantic surface placement.
- \`src/main.${selected === "react" ? "tsx" : "ts"}\`: framework mount registry. Add one component mapping for every configured surface.
- \`src/surfaces/background/\`: background component and its private \`styles.css\`.
- \`src/surfaces/overlay/\`: overlay component and its private \`styles.css\`.
- Add future surfaces as self-contained directories. Do not put one surface's CSS in another surface or in the mount registry.
- \`assets/\`: source notes and optional local assets. Prefer importing real assets from \`src\` so Vite can inline them.
- \`experience.manifest.json\`: identity and requested host permissions.
- \`dist/\`: the only runtime/import boundary.

Supported targets: app-shell, navigation, titlebar, workspace, home, conversation, composer, modal, floating-window.

Use floating-window for menus or control windows that need an independent top-level sandbox iframe. It must be a scoped or interactive overlay. Keep the trigger in its semantic surface and coordinate the window through window.codexExperience.signals.

Supported planes: underlay (below native content, passthrough only) and overlay (above native content). Overlay interaction modes are passthrough, scoped, and interactive. Prefer scoped for buttons, floating controls, and panels; interactive reserves the whole surface for the Experience.
`;
}

function brief(): string {
  return `# Experience Brief

AI must ask about every unresolved item. It may decide an item only when the user explicitly delegates it.

- Experience name: unresolved
- Stable lowercase id: unresolved
- Style keywords: unresolved
- Six-digit HEX seed color: unresolved
- Contrast: soft / standard / high
- Light appearance: unresolved
- Dark appearance: use generated dark tokens unless explicitly designed
- Targets to customize: unresolved
- Underlay content for each target: unresolved
- Overlay content for each target: unresolved
- Keep native center reading area transparent: yes
- Interactive controls and emitted host actions: none by default
- React to the active Codex task: no by default
- React to background task start/completion events: no by default
- Remote WebView content, security mode, and strict-mode HTTPS origins: none by default
- Source assets and usage rights: unresolved
- Motion and reduced-motion behavior: unresolved
- Target aspect ratios and safe areas: unresolved
`;
}

function aiGuide(selected: ExperienceProjectFramework): string {
  return `# Codex Experience v1 AI 生成规则

本项目使用 ${selected === "react" ? "React + TypeScript" : "Vue 3 + TypeScript"}。AI 应生成普通框架组件和配置，不要让用户手写运行时 HTML、iframe 或 \`codex-experience-surface\` 标签。

## 开始生成前必须询问

1. Experience 名称、稳定 id、风格关键词、六位 HEX 主色、对比度，以及 Light/Dark 设计意图。
2. 需要定制哪些语义区域；每个区域的内容应位于原生 Codex 下方（underlay）还是上方（overlay）。
3. 原生阅读区、对话内容和输入区是否必须保持完全可读、可点和不受遮挡。
4. 用户能提供哪些原始本地资源、各资源放在哪个区域，以及是否拥有使用权。
5. 是否需要根据当前任务切换展示，或者接收其他任务开始/完成事件；若需要，分别申请 \`codex.context.active\` / \`codex.events.lifecycle\`。需要显示会话名称时另行申请 \`codex.context.metadata\`。再询问是否需要交互或远程 WebView、控件、action 名称和载荷、安全模式。最后询问动画、减少动态效果、目标窗口比例和安全边距。

凡是 \`EXPERIENCE-BRIEF.md\` 中仍标记为 unresolved 的项目，都必须先询问用户；只有用户明确说“由你决定”时才能代填。

## 组件与放置合约

在 \`experience.config.json\` 的 \`authoring.surfaces\` 中声明 target、plane 和 interaction。在 \`src/main.${selected === "react" ? "tsx" : "ts"}\` 中用同一个 \`plane:target\` key 注册组件。每个组件使用独立目录，例如 \`src/surfaces/background/\` 和 \`src/surfaces/overlay/\`，组件只导入本目录的 \`styles.css\`，不要跨 surface 共用或覆盖样式。

- \`underlay\`：位于原生内容下方，始终穿透鼠标。
- \`overlay\`：位于原生内容上方。装饰用 \`passthrough\`；少量按钮、悬浮入口和弹出面板用 \`scoped\`；只有整块区域都属于 Experience 或承载远程 WebView 时才用 \`interactive\`。
- \`scoped\` overlay 中，每个真实交互元素挂载后调用 \`window.codexExperience.interaction.register(element)\`，卸载时调用返回值的 \`destroy()\`。未注册区域继续点击原生 Codex，禁止用透明全屏元素常驻拦截。
- 需要独立层级的菜单或控制窗口放在 \`floating-window\`，并配置为 scoped 或 interactive overlay。触发按钮留在原语义 surface，通过 \`window.codexExperience.signals\` 与独立窗口通信，不要只在同一个 surface 内增加 z-index。
- 只有用户明确要求第二账号配置迁移时才申请 \`codex.instance.configure\`；只能使用 \`codex.instance.transfer-catalog\` 返回的条目 id，不能接受或构造文件路径。会话迁移还要申请 \`codex.conversations.sync\`，并且在界面中必须默认不勾选。
- 不要伪造 Codex 对话或输入框；预览器会提供仿真的原生内容。
- 只影响侧栏、标题栏、对话、输入框或弹层时，不要申请全窗口 overlay。
- 中间阅读区要求保持默认时，让组件透明，不要用大块图片或面板覆盖它。

可用 target：\`app-shell\`、\`navigation\`、\`titlebar\`、\`workspace\`、\`home\`、\`conversation\`、\`composer\`、\`modal\`、\`floating-window\`。

## 外观与能力边界

使用生成的 \`--cek-*\` 变量，不要为每个按钮和文字各自发明无关颜色。Light 与 Dark 必须分别检查对比度；用户未提供 Dark 方案时使用工具生成的暗色 token。

浏览器代码只能使用 \`window.codexExperience\`。不能读取或修改 Codex DOM，不能访问 Node、Electron、CDP、文件系统、顶层导航或任意宿主调用。需要按钮时把交互放在最小范围的 overlay 内；只在确实向宿主发 action 时申请 \`host.actions\`。

需要跟随当前任务时，通过 \`window.codexExperience.context.getSnapshot()\` 和 \`context.subscribe()\` 获取经过脱敏的任务 id、状态、选中状态和未读状态。需要响应后台任务时，通过 \`window.codexExperience.events.subscribe()\` 接收 \`activeThreadChanged\`、\`threadStatusChanged\`、\`turnStarted\`、\`turnCompleted\`。基础权限不包含名称；仅在申请 \`codex.context.metadata\` 后使用可选的 \`displayName\`。任何权限都不会提供提示词、回复正文、工作目录或仓库路径。

远程页面只能通过 \`remote.webview\`，surface 必须是 interactive overlay，组件通过 \`window.codexExperience.webviews.mount(container, { url, title, iframeFallbackUrl })\` 挂载。\`url\` 是原生后端主地址，\`iframeFallbackUrl\` 可选，仅用于普通浏览器预览。禁止直接创建 \`webview\` 或远程 \`iframe\`。

- \`strict\`（默认）：1–8 个精确 HTTPS origin；无凭证、无 referrer、禁止弹窗、下载、设备权限和顶层导航。
- \`permissive\`：任意 HTTP/HTTPS origin，但仍保留 credentialless sandbox；必须警告任意导航和不安全 HTTP 风险。
- \`unrestricted\`：普通浏览器预览使用宿主管理的直接 sibling iframe；\`npm run dev:native\` 使用隔离的 Electron \`WebContentsView\`，可加载禁止 iframe 嵌入的网站。两者都必须由用户明确要求，并通过 \`--allow-unrestricted-remote-content\` 授权；交付时必须标记为 critical risk。作者代码仍无法访问 Node、Electron、CDP、文件系统、\`file:\` 或 \`javascript:\`。直接注入官方 Codex 属于另一个 Electron 进程，不能挂载本预览进程的原生 View，因此仍使用 iframe 后端。

## 交付检查

- 运行 \`npm run build\`、\`npm run check\` 和 \`npm run dev\`。
- \`npm run dev\` 空闲时不得刷新；修改源码后应只更新一次。
- 自动化检查不得点击预览顶部的 Apply/Restore，也不得运行连接真实 Codex 的 \`npm run apply\`。
- 检查 Light、Dark、减少动态效果、窄/宽窗口、滚动和每一个交互 overlay。
- 在交付说明中列出 surfaces、permissions、actions、资源来源和已知限制。
`;
}

function runtimeTypes(): string {
  return `export {};

export type CodexThreadStatus = "unknown" | "idle" | "working" | "waiting" | "waiting-input" | "waiting-approval" | "completed" | "failed" | "interrupted";
export interface CodexContextThread { threadId: string; sessionId: string | null; displayName?: string | null; status: CodexThreadStatus; active: boolean; unread: boolean; updatedAt: number }
export interface CodexContextSnapshot { connection: { state: "disconnected" | "connecting" | "connected" | "degraded"; provider: string; updatedAt: number }; activeThreadId: string | null; threads: CodexContextThread[] }
export type CodexContextEvent =
  | { type: "connectionChanged"; observedAt: number; connection: CodexContextSnapshot["connection"] }
  | { type: "activeThreadChanged"; observedAt: number; previousThreadId: string | null; thread: CodexContextThread | null }
  | { type: "threadStatusChanged"; observedAt: number; previousStatus: CodexThreadStatus; thread: CodexContextThread }
  | { type: "turnStarted"; observedAt: number; threadId: string; sessionId: string | null; turnId: string; startedAt: number }
  | { type: "turnCompleted"; observedAt: number; threadId: string; sessionId: string | null; turnId: string; outcome: "completed" | "failed" | "interrupted"; completedAt: number };

declare global {
  interface Window {
    codexExperience?: {
      environment: {
        mode: "preview" | "codex";
        target: "app-shell" | "navigation" | "titlebar" | "workspace" | "home" | "conversation" | "composer" | "modal" | "floating-window";
        plane: "underlay" | "overlay";
        appearance: "light" | "dark";
        reducedMotion: boolean;
        remoteContentBackend: "iframe" | "electron-webcontents-view";
      };
      lifecycle: { ready(): Promise<void> };
      signals: {
        emit(name: string, payload?: unknown): void;
        subscribe(listener: (signal: {
          name: string;
          payload?: unknown;
          source?: {
            target: "app-shell" | "navigation" | "titlebar" | "workspace" | "home" | "conversation" | "composer" | "modal" | "floating-window";
            plane: "underlay" | "overlay";
            bounds: { x: number; y: number; width: number; height: number };
          };
        }) => void): () => void;
      };
      context: { getSnapshot(): Promise<CodexContextSnapshot>; subscribe(listener: (snapshot: CodexContextSnapshot) => void): () => void };
      events: { subscribe(listener: (event: CodexContextEvent) => void): () => void };
      actions: { emit(name: string, payload?: unknown): Promise<void> };
      interaction: {
        register(element: HTMLElement, options?: { padding?: number; shape?: "rect" | "rounded" | "circle" }): { refresh(): void; destroy(): void };
      };
      webviews: {
        mount(container: HTMLElement, options: { url: string; title?: string; iframeFallbackUrl?: string }): {
          navigate(url: string): void;
          reload(): void;
          destroy(): void;
        };
      };
    };
  }
}
`;
}

function backgroundStyles(): string {
  return `.experience-background {
  position: absolute;
  inset: 0;
  pointer-events: none;
  background: radial-gradient(circle at 90% 42%, color-mix(in srgb, var(--cek-primary) 20%, transparent), transparent 36%);
}
`;
}

function overlayStyles(): string {
  return `.experience-overlay {
  position: absolute;
  inset: 0;
  pointer-events: none;
}
`;
}

function basePackage(packageName: string, selected: ExperienceProjectFramework): string {
  const dependencies = selected === "react"
    ? { react: "^19.1.1", "react-dom": "^19.1.1" }
    : { vue: "^3.5.18" };
  const frameworkDevDependencies = selected === "react"
    ? { "@types/react": "^19.1.9", "@types/react-dom": "^19.1.7" }
    : { "@vitejs/plugin-vue": "^5.2.1" };
  return `${JSON.stringify({
    name: packageName,
    version: "0.1.0",
    private: true,
    type: "module",
    scripts: {
      dev: "codex-experience dev",
      "dev:native": "codex-experience dev --native",
      typecheck: "tsc --noEmit",
      build: "codex-experience build",
      check: "npm run typecheck && npm run build && codex-experience check",
      pack: "npm run check && codex-experience pack",
      apply: "codex-experience apply .",
      appearance: "codex-experience appearance",
      status: "codex-experience status",
      cancel: "codex-experience cancel",
    },
    dependencies,
    devDependencies: {
      "codex-experience-kit": "^0.6.12",
      typescript: "^5.9.2",
      vite: "^6.1.0",
      ...frameworkDevDependencies,
    },
  }, null, 2)}\n`;
}

function reactFiles(): ExperienceProjectStarterFiles {
  return {
    "tsconfig.json": `${JSON.stringify({
      compilerOptions: {
        target: "ES2022", useDefineForClassFields: true, lib: ["ES2022", "DOM", "DOM.Iterable"],
        allowJs: false, skipLibCheck: true, esModuleInterop: true, allowSyntheticDefaultImports: true,
        strict: true, forceConsistentCasingInFileNames: true, module: "ESNext", moduleResolution: "Bundler",
        resolveJsonModule: true, isolatedModules: true, noEmit: true, jsx: "react-jsx", types: ["vite/client"],
      },
      include: ["src"],
    }, null, 2)}\n`,
    "src/codex-experience.d.ts": runtimeTypes(),
    "src/surfaces/background/styles.css": backgroundStyles(),
    "src/surfaces/background/index.tsx": `import "./styles.css";\n\nexport default function Background() {\n  return <div className="experience-background" aria-hidden="true" />;\n}\n`,
    "src/surfaces/overlay/styles.css": overlayStyles(),
    "src/surfaces/overlay/index.tsx": `import "./styles.css";\n\nexport default function Overlay() {\n  // Add optional foreground decoration here. Keep passthrough overlays non-interactive.\n  return <div className="experience-overlay" aria-hidden="true" />;\n}\n`,
    "src/main.tsx": `import { createElement, type ComponentType } from "react";\nimport { createRoot } from "react-dom/client";\nimport Background from "./surfaces/background";\nimport Overlay from "./surfaces/overlay";\n\nconst components: Record<string, ComponentType> = {\n  "underlay:app-shell": Background,\n  "overlay:app-shell": Overlay,\n};\nconst environment = window.codexExperience?.environment;\nconst key = environment ? \`${"${environment.plane}:${environment.target}"}\` : "";\nconst mount = document.querySelector<HTMLElement>(\`[data-codex-experience-mount="${"${key}"}"]\`);\nconst Component = components[key];\nif (mount && Component) createRoot(mount).render(createElement(Component));\nvoid window.codexExperience?.lifecycle.ready();\n`,
  };
}

function vueFiles(): ExperienceProjectStarterFiles {
  return {
    "tsconfig.json": `${JSON.stringify({
      compilerOptions: {
        target: "ES2022", useDefineForClassFields: true, module: "ESNext", moduleResolution: "Bundler",
        strict: true, jsx: "preserve", resolveJsonModule: true, isolatedModules: true, esModuleInterop: true,
        lib: ["ES2022", "DOM", "DOM.Iterable"], skipLibCheck: true, noEmit: true, types: ["vite/client"],
      },
      include: ["src/**/*.ts", "src/**/*.d.ts", "src/**/*.vue"],
    }, null, 2)}\n`,
    "src/codex-experience.d.ts": `${runtimeTypes()}\ndeclare module "*.vue" {\n  import type { DefineComponent } from "vue";\n  const component: DefineComponent<Record<string, never>, Record<string, never>, unknown>;\n  export default component;\n}\n`,
    "src/surfaces/background/styles.css": backgroundStyles(),
    "src/surfaces/background/index.vue": `<template>\n  <div class="experience-background" aria-hidden="true" />\n</template>\n\n<style src="./styles.css"></style>\n`,
    "src/surfaces/overlay/styles.css": overlayStyles(),
    "src/surfaces/overlay/index.vue": `<template>\n  <!-- Add optional foreground decoration here. Keep passthrough overlays non-interactive. -->\n  <div class="experience-overlay" aria-hidden="true" />\n</template>\n\n<style src="./styles.css"></style>\n`,
    "src/main.ts": `import { createApp, type Component } from "vue";\nimport Background from "./surfaces/background/index.vue";\nimport Overlay from "./surfaces/overlay/index.vue";\n\nconst components: Record<string, Component> = {\n  "underlay:app-shell": Background,\n  "overlay:app-shell": Overlay,\n};\nconst environment = window.codexExperience?.environment;\nconst key = environment ? \`${"${environment.plane}:${environment.target}"}\` : "";\nconst mount = document.querySelector<HTMLElement>(\`[data-codex-experience-mount="${"${key}"}"]\`);\nconst component = components[key];\nif (mount && component) createApp(component).mount(mount);\nvoid window.codexExperience?.lifecycle.ready();\n`,
  };
}

export function createExperienceProjectStarterFiles(input: ExperienceProjectStarterOptions = {}): ExperienceProjectStarterFiles {
  const selected = framework(input);
  const projectManifest = manifest(input);
  const packageName = input.packageName ?? projectManifest.id.replaceAll(".", "-");
  const entry = selected === "react" ? "main.tsx" : "main.ts";
  return {
    ".gitignore": "node_modules/\ndist/\nreleases/\n.experience-framework-*\n",
    "package.json": basePackage(packageName, selected),
    "experience.manifest.json": `${JSON.stringify(projectManifest, null, 2)}\n`,
    "experience.config.json": `${JSON.stringify({
      sourceDir: "src",
      outDir: "dist",
      assetsDir: "assets",
      appearance: { seed: "#7667D9", contrast: "standard" },
      authoring: {
        framework: selected,
        entry,
        surfaces: [
          { target: "app-shell", plane: "underlay", interaction: "passthrough" },
          { target: "app-shell", plane: "overlay", interaction: "passthrough" },
        ],
      },
    }, null, 2)}\n`,
    "AGENTS.md": agents(selected),
    "README.md": readme(projectManifest.name, selected),
    "EXPERIENCE-BRIEF.md": brief(),
    "docs/AI-GENERATION.zh-CN.md": aiGuide(selected),
    ...(selected === "react" ? reactFiles() : vueFiles()),
  };
}

export function createExperienceProjectStarterZip(input: ExperienceProjectStarterOptions = {}): Uint8Array {
  const files = createExperienceProjectStarterFiles(input);
  return zipSync(Object.fromEntries(Object.entries(files).map(([name, value]) => [name, strToU8(value)])), { level: 6 });
}
