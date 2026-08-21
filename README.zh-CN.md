# Codex Experience Kit

[English](README.md) | 简体中文

Codex Experience Kit 是一个独立 CLI 和可嵌入 SDK，用于在 Codex 桌面应用中运行沙箱化的 HTML Experience。外观只是它的一项能力；一个 Experience 还可以包含动画、本地状态、跨 Surface 信号、任务感知视觉效果、生命周期响应，以及经过明确授权的宿主操作。

它不要求外部宿主。npm 包本身就能构建、预览、应用、热刷新、局部更新、检查和取消 Experience。它没有守护进程、独立登录、独立 Profile 或 Dock 图标。应用也可以选择嵌入同一套公开 API，提供自己的界面。

从已废弃的 `codex-theme-kit` 升级时，需要迁移项目格式和 API，而不只是修改依赖名称。请参阅[从 `codex-theme-kit` 迁移](docs/migrating-from-codex-theme-kit.md)。

## 创建项目

```bash
npx codex-experience-kit init ./example-experience \
  --id example.experience \
  --name "Example Experience"
cd example-experience
npm install
npm run dev
```

默认使用 React。可以通过 `--framework vue` 明确选择 Vue；自动化场景也可以显式传入 `--framework react`。`init` 创建的是一个完整的框架项目，而不是零散的 HTML 文件：

```text
example-experience/
├── experience.manifest.json
├── experience.config.json
├── package.json
├── README.md
├── AGENTS.md
├── EXPERIENCE-BRIEF.md
├── docs/AI-GENERATION.zh-CN.md
├── src/
│   ├── main.tsx
│   ├── codex-experience.d.ts
│   └── surfaces/
│       ├── background/
│       │   ├── index.tsx
│       │   └── styles.css
│       └── overlay/
│           ├── index.tsx
│           └── styles.css
├── assets/
└── dist/                    # 由 npm run build 生成
```

命令：

- `npm run dev`：打包 React/Vue 组件，只监听真实的源码、配置和资源输入，并提供稳定的 Codex 仿真预览。工具栏可以分别显示或隐藏 Underlay 和 Overlay、模拟当前任务和后台任务事件、将当前构建明确应用到 Codex，或恢复官方界面。
- `npm run dev:native`：在独立 Electron 窗口中打开同一套仿真预览。执行 `npm install --save-dev electron` 后，不受限的远程页面将使用 `WebContentsView`，而不是嵌入 iframe。
- `npm run build`：使用项目本地的 Vite 打包框架源码，并编译为 `dist/` 中固定的运行时契约。
- `npm run check`：校验构建产物、Surface、资源、权限和沙箱规则。
- `npm run pack`：在 `releases/` 中生成可导入的 ZIP。
- `npm run targets`：列出所有正在运行的 Codex 实例、连接就绪状态，以及当前已经连接的实例。
- `npm run apply`：构建当前项目并直接应用到 Codex。
- `npm run appearance -- --seed '#008577' --appearance dark`：只更新正在运行的外观。
- `npm run status`：检查由 npm 包管理的运行时状态。
- `npm run cancel`：恢复 Codex 官方界面。

第二账号的数据会持久保存。`codex-experience instance status` 用于检查固定的第二实例槽位，`codex-experience instance open` 可以在不应用 Experience 的情况下重新打开它，`codex-experience instance install-launcher` 会创建 `~/Applications/Codex Secondary.app`，方便重启电脑后从 Finder、Spotlight 或 Dock 打开。

生成的文档会告诉 AI：必须向用户询问哪些信息、各区域如何放置、还缺少哪些资源，以及如何验证 Light/Dark、交互、动效和阅读安全性。

打开预览只会启动仿真环境，不会连接 Codex。`Underlay` 和 `Overlay` 的可见性控制只影响预览，不会修改构建出的 Experience。工具栏会发现所有正在运行的 Codex 实例，标记已经连接的实例，并在存在多个实例时要求用户明确选择目标。点击 `Apply to Codex` 才是真实操作：预览器会重新构建项目，将同一套生成的 Light/Dark Token 交给 npm 包自带的运行时；如果选中的实例需要重启，还会先请求确认。`Restore` 会以事务方式取消当前 Experience。

项目可以选择启用 npm 包提供的预览工具，而不把这些工具打进 Experience：

```json
{
  "preview": {
    "tools": ["codex-secondary-instance"]
  }
}
```

这会在左侧增加一个 Settings 入口，用于固定的隔离第二账号流程。配置选择器默认勾选能力、MCP、Skills、Plugins 及其他可识别配置；对话默认不勾选，用户可以按分组或具体任务选择。预览 Header、弹窗、本地控制接口以及文件系统/进程权限都属于可信的 Kit 开发服务器。它们不会被写入 `dist`，不会变成 Surface，也不会给 Experience Manifest 增加权限。

## 可运行示例

[`example`](example) 是一个完整的 React Experience，展示仅占边缘区域的 Underlay、限定交互范围的 Overlay、生成的外观 Token、当前任务上下文和生命周期事件。预览使用仿真任务数据；除非明确点击 `Apply to Codex`，否则不会连接 Codex。

```bash
npm install
npm run build
cd example
npm install
npm run dev
```

示例通过 `file:..` 依赖当前仓库，因此可以在发布前直接测试 Kit 的本地修改。在仓库根目录运行 `npm run example:check`，可以在不连接 Codex 的情况下完成类型检查、构建和校验。

## 发布与 Provenance

新的 npm 版本由 GitHub Actions 根据匹配的 Git Tag 发布，并使用 npm Trusted Publishing。稳定版本使用 `latest`，预发布版本使用明确的 `beta` 或 `next` dist-tag。工作流会创建对应的 GitHub Release；对于公开包，npm 会自动记录 Provenance。一次性 Publisher 配置、版本规则和故障恢复流程请参阅[发布指南](docs/releasing.md)。

## 直接应用到 Codex

在已经初始化的 Experience 项目中执行：

```bash
npm run targets
npm run apply
```

当存在多个 Codex 实例时，需要明确选择其中一个：

```bash
npm run apply -- --target profile-a1b2c3d4e5f6
```

首次连接可能需要经过确认后重启一次 Codex。命令不会自动重启；保存当前工作后，需要显式允许该操作：

```bash
npm run apply -- --allow-restart
```

后续执行 `npm run apply` 会重新构建项目，并以事务方式热刷新所链接的 `dist/`。它会继续使用原 Codex Profile、登录状态、任务和对话，不需要外部宿主，也不需要再次重启。

npm 包 CLI 也可以在创作项目之外使用：

```bash
codex-experience install ./releases/example.experience-0.1.0.zip
codex-experience list
codex-experience targets
codex-experience apply example.experience --target primary --seed '#6750A4' --appearance light
codex-experience appearance --seed '#008577' --appearance dark
codex-experience status
codex-experience cancel
```

运行时状态以及不可变/开发快照默认保存在 `~/Library/Application Support/CodexExperienceKit`。需要隔离时，可以通过 `--library <directory>` 改写路径。

## 布局契约

作者编写普通的 React 或 Vue 组件。布局在 `experience.config.json` 中声明，编译器负责生成运行时 HTML：

```json
{
  "authoring": {
    "framework": "react",
    "entry": "main.tsx",
    "surfaces": [
      { "target": "app-shell", "plane": "underlay", "interaction": "passthrough" },
      { "target": "titlebar", "plane": "overlay", "interaction": "scoped" }
    ]
  }
}
```

入口文件通过相同的 `plane:target` Key 注册组件。每个 Surface 都拥有独立目录，其中包含组件和 CSS，因此 Background 和 Overlay 可以独立演进。用户不需要手动创建 `codex-experience-surface`、iframe 或运行时 HTML。原有语义明确的 v1 原生源码项目仍然可以构建。

可用 Target 包括 `app-shell`、`navigation`、`titlebar`、`workspace`、`home`、`conversation`、`composer`、`modal` 和 `floating-window`。

`floating-window` 是由宿主管理的顶层 Overlay，运行在自己的沙箱 iframe 中。它必须使用 `interaction: "scoped"` 或 `"interactive"`。触发入口应保留在原语义 Surface 中，再通过 `window.codexExperience.signals` 协调这个独立窗口；不要在同一个 Surface 中通过更大的 `z-index` 模拟这条边界。

Plane 包括：

- `underlay`：位于 Codex 原生内容下方，并且始终让指针事件穿透。
- `overlay`：位于原生内容上方。纯装饰使用 `passthrough`，独立按钮/面板使用 `scoped`；只有当整个语义区域都属于 Experience 时才使用 `interactive`。

在 `scoped` Overlay 中，只应通过 `window.codexExperience.interaction.register(element, { padding, shape })` 注册真实的点击目标。`shape` 默认为 `rect`；`rounded` 会采用元素左上角计算后的圆角半径；圆形浮动控件使用 `circle`。宿主会根据这些元素生成互不相交的命中区域，其他位置仍然可以点击原生 Codex。组件卸载时应销毁返回的 Handle。

层级顺序为 `floating-window → 普通 overlay → Codex 原生内容 → underlay → 原生区域背景`。项目可以只提供一个 Surface。当前路由或 Modal 不存在的 Target 会保持 Pending，并在对应语义区域出现后挂载；`floating-window` 始终可以在应用窗口范围内使用。

## 浏览器能力 API

Experience JavaScript 运行在沙箱 iframe 中，没有同源访问权限。它只能通过 `window.codexExperience` 获得以下能力：

- 环境信息：模式、Target、Plane、外观、减弱动态效果状态和选中的 `remoteContentBackend`；
- 获得 `appearance.tokens` 权限后，可读取完整的外观 Token 模式；
- Experience 内部的跨 Surface 信号；
- 获得 `host.actions` 权限后，可调用已声明的语义化宿主操作；
- 获得 `remote.webview` 权限、声明安全模式并处于可交互 Overlay 后，可使用宿主管理的远程页面；
- 获得 `codex.context.active` 权限后，可读取经过脱敏的当前任务快照；只有额外获得 `codex.context.metadata` 权限后，快照才可以包含显示名称；
- 获得 `codex.events.lifecycle` 权限后，可接收经过脱敏的任务/Turn 生命周期事件；
- 生命周期通知。

它不能访问 Codex DOM、父文档、Node.js、Electron、CDP、文件系统、任意网络 API 或任意宿主方法。包资源会被编译为自包含 HTML。`remote.webview` 不会启用 Electron 的 `<webview>` 标签：作者代码只会向由 npm 包控制的同级宿主发送经过校验的挂载、布局、导航、刷新和销毁请求。Experience Frame 保持不透明，无法访问宿主或远程 DOM。

跨 Surface 转发的信号包含由宿主写入的 `source` 元数据，其中有语义 Target、Plane，以及源 Surface 在应用坐标中的边界。这样，`workspace` 或 `navigation` 中的控件就能定位独立的 `floating-window`，而无需读取 Codex DOM 或猜测区域宽度。

远程内容支持三种策略：

- `strict` 为默认策略：只允许精确声明的 HTTPS Origin，使用无凭证、无 Referrer 的沙箱，并禁止弹窗、下载、设备权限和顶层导航。
- `permissive` 允许任意 HTTP/HTTPS 导航，但仍保留无凭证、无 Referrer 的沙箱及其他限制。
- `unrestricted` 在浏览器/CDP Provider 中使用由宿主管理的直接同级 iframe，在 Electron 宿主中使用隔离的原生 `WebContentsView`。它属于**严重风险**，只有项目提出请求，并且宿主另外传入 `allowUnrestrictedRemoteContent: true`，或 CLI 收到 `--allow-unrestricted-remote-content` 时才会启用。

即使在 unrestricted 模式下，Experience 代码仍然不能访问 Node.js、Electron、CDP、`file:` 或 `javascript:`。浏览器/CDP Provider 仍无法绕过站点的 iframe `X-Frame-Options` 或 `frame-ancestors` 策略。原生 `WebContentsView` 是顶层 Web Content，因此不受只针对 iframe 的嵌入规则约束；但它仍会遵守正常的网络限制、页面 CSP、导航、权限、下载、混合内容和操作系统控制。不要向不可信项目授予 unrestricted 模式。

对于拒绝 iframe 嵌入的页面：

```bash
npm install --save-dev electron
npm run dev:native -- --allow-unrestricted-remote-content
```

作者代码继续使用同一套 API，并可以提供只在浏览器环境使用的 Fallback：

```ts
window.codexExperience?.webviews.mount(container, {
  url: "https://www.baidu.com/",
  iframeFallbackUrl: "https://m.baidu.com/",
  title: "Baidu",
});
```

npm 包在 Electron 原生预览中选择 `url`，在普通浏览器/CDP 预览中选择 `iframeFallbackUrl`。原生 View 属于创建它的 Electron 进程，不能跨进程附加到官方 Codex 窗口。因此，直接应用到官方 Codex 时仍会使用 iframe Provider；主页面拒绝嵌入时应使用 Fallback。

## Codex 上下文与生命周期事件

任务感知 Experience 需要明确选择权限：

```json
{
  "permissions": ["codex.context.active", "codex.events.lifecycle"]
}
```

API 只暴露标识符、选中状态、`idle|working|waiting|completed|failed|interrupted`、未读状态和时间戳。它不会暴露 Prompt、回复、cwd、凭证或控制 Codex 的通用方法；任务显示名称需要单独的 Metadata 权限。获得 `host.actions` 后，`codex.window.open` 可以在独立原生窗口中打开共享的 Codex 首页或经过校验的本地 Thread。在 macOS 上，保留的隔离实例操作会使用由 Kit 固定管理的 Chromium 目录和 `CODEX_HOME` 目录启动另一个进程，以登录第二账号；项目代码不能提供可执行文件路径、参数、环境变量或 Profile 路径。

`codex.instance.configure` 会启用由 npm 包管理的迁移目录和配置后的启动请求。已识别能力——配置/MCP 注册、Workspace/项目列表、Skills、Plugins、规则、Hooks、自动化、Memories 和 Pets——默认勾选。对话默认关闭，并以按项目分组的树形结构展示：用户可以选择整个分组，也可以展开并选择具体对话；分组和对话都会显示逻辑大小。无法识别的顶层 CODEX_HOME 数据会作为未勾选项目出现，并显示其绝对源路径。账号认证、Chromium/浏览器身份、OAuth Lock、IPC、活动 Writer/进程状态、日志和 Worktree 永远不可选择。选择对话还需要 `codex.conversations.sync` 权限和原生确认。选择性迁移只会合并选中的 Thread 记录及其本地 Rollout/资源。复制的 `config.toml` 以及指向主 CODEX_HOME 内部的 Hook 路径会重写到第二实例目录；第二实例已有凭证会被保留。

```ts
const snapshot = await window.codexExperience?.context.getSnapshot();

const stopContext = window.codexExperience?.context.subscribe((next) => {
  document.documentElement.dataset.thread = next.activeThreadId ?? "home";
});

const stopEvents = window.codexExperience?.events.subscribe((event) => {
  if (event.type === "turnCompleted" && event.threadId !== snapshot?.activeThreadId) {
    // 为已完成的后台任务显示本地角标或动画。
  }
});
```

普通预览会提供两个仿真任务，以及切换当前任务、完成另一个任务的控制项。可复用的预览宿主可以传入 `codexContext`，调用 `setCodexContext()` / `emitCodexEvent()`，或提供 `CodexContextSource`。

预览控制接口和版本接口支持来自 `localhost`、`127.0.0.1` 和 `[::1]` 等 Loopback Origin 的浏览器预检，包括不同的本地端口。控制请求仍然必须携带嵌入预览文档的进程级随机 Token。非 Loopback Origin、`null` Origin、通配符 CORS 和携带凭证的 Origin 都会被拒绝。

直接应用到 Codex 时，始终会带有 Renderer Provider，用于提供当前选中的任务和 Renderer 可见的任务状态变化。拥有明确 Codex App Server WebSocket 的宿主可以额外提供权威生命周期事件：

```ts
import { CodexAppServerContextProvider, CodexExperienceRuntime } from "codex-experience-kit/node";
import { CodexContextService } from "codex-experience-kit/service";

const context = new CodexContextService(new CodexAppServerContextProvider({
  webSocketUrl: "ws://127.0.0.1:4500",
}));
await context.start();

const runtime = new CodexExperienceRuntime({ contextSource: context });
try {
  await runtime.apply("./example-experience");
} finally {
  await runtime.shutdown();
  await context.stop();
}
```

端点永远不会被自动发现。默认要求 Loopback；远程端点需要明确的宿主选项，并应使用 `wss:` 和身份认证。App Server WebSocket 传输仍是实验性能力，因此 Renderer Provider 继续作为官方 Codex 桌面应用的安全 Fallback。

## 可选宿主集成

```bash
npm install --save-exact codex-experience-kit@0.6.12
```

```ts
import { ExperienceEngine } from "codex-experience-kit/node";
import { generateAppearanceTokens } from "codex-experience-kit/utils";

const engine = new ExperienceEngine({ libraryPath });
await engine.initialize();

const tokens = generateAppearanceTokens({ seed: "#6750A4" }).modes;
await engine.applyProject("example.experience", {
  tokens,
  appearance: "light",
  allowRestart: true,
});

await engine.patchTokens(
  generateAppearanceTokens({ seed: "#008577" }).modes,
  "dark",
);
await engine.cancelProject();
```

下面是使用默认路径、与独立 CLI 对应的高级 Node API：

```ts
import { CodexExperienceRuntime } from "codex-experience-kit/node";

const runtime = new CodexExperienceRuntime();
const instances = await runtime.listCodexInstances();
const target = instances.find((instance) => instance.connected) ?? instances[0];
await runtime.apply("./example-experience", {
  targetId: target?.id ?? "primary",
  allowRestart: true,
});
await runtime.patchAppearance({ seed: "#008577", appearance: "dark" });
await runtime.cancel();
await runtime.shutdown();
```

如果可信项目明确请求不受限远程内容，嵌入宿主必须另外确认这一严重风险：

```ts
const runtime = new CodexExperienceRuntime({
  security: { allowUnrestrictedRemoteContent: true },
});
```

不要根据 Manifest 本身推导宿主授权。在要求用户启用该能力之前，应先显示项目、目录或预览结果中的 `remoteContentRisk`。

仿真 Renderer 预览：

```ts
import { mountExperienceProjectPreview } from "codex-experience-kit/preview";

const preview = mountExperienceProjectPreview(host, project, {
  tokens,
  appearance: "light",
  view: "task",
});
```

普通导入会复制经过校验的不可变快照。直接应用项目时，会使用 npm 包自带的编译器构建，链接生成的 `dist/`，缓存最后一个有效快照，并且只在显式 `apply` 时改变。可选宿主绝不能执行第三方创作项目中的脚本。

## Codex 连接

应用 Experience 时，会通过明确的 Loopback CDP 连接到由官方签名的 Codex 进程。运行时会枚举所有经过验证的主进程，根据隔离 Profile 分配稳定的实例 ID，区分主实例、Kit 管理的第二实例和自定义 Profile，并标记当前已连接的准确 PID/进程世代。只有一个实例时会自动选择；存在多个实例时，预览、CLI 或 Node API 都必须明确指定目标。建立连接可能需要经过确认后，只重启被选择且可重启的实例一次；其他实例保持打开。运行时会选择该实例的主 Codex Renderer，而不是头像 Overlay 等辅助窗口；只有验证了进程和端点所有权后，才会接管已有的 Loopback CDP 端点。连接建立后，Experience 切换、Token 更新、当前任务上下文、Renderer 可见的生命周期更新和取消都会热执行，并继续使用该实例自身的 Profile、登录、任务和对话。可选的 App Server Provider 只接受明确传入的端点，在测试中永远不会自动发现或连接。

所有真实 Codex 修改都以事务方式执行。普通测试套件使用仿真 DOM 和 CDP Server。独立的外部 CDP Fixture 会通过具备 Codex 等效 CSP 的隔离 Electron Renderer 测试完整 Demo 产物。这两条路径都不会连接用户正在运行的 Codex，也不会被描述为成功应用到了官方 Codex。

## 致谢

Renderer Selector 研究以及显式 Loopback-CDP 生命周期设计参考了 [Codex Dream Skin](https://github.com/Fei-Away/Codex-Dream-Skin)，Copyright (c) 2026 Codex Dream Skin Studio contributors，采用 MIT License。Codex Experience Kit 是独立编写的 SDK，不包含 Dream Skin 的美术资源、预设、主题 CSS、注入器源码或应用二进制文件。完整署名和上游许可证保留在 [NOTICE.md](NOTICE.md) 中。

Codex Experience Kit 是一个独立的非官方项目，与 OpenAI 没有关联，也未获得 OpenAI 背书。Codex 及相关标识属于各自权利人。

更多文档：[从 `codex-theme-kit` 迁移](docs/migrating-from-codex-theme-kit.md)、[直接使用](docs/direct-usage.zh-CN.md)、[架构](docs/architecture.md)、[项目格式](docs/experience-format.md)、[运行时契约](docs/experience-runtime-v1.zh-CN.md)、[可选宿主集成](docs/host-integration.md)、[AI 生成规则](docs/ai-experience-generation.zh-CN.md)、[开源合规](docs/open-source-compliance.md)和[安全策略](SECURITY.md)。
