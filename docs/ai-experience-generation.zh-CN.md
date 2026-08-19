# Codex Experience v1：AI 生成规则

Experience 不只是主题图片，而是由 React 或 Vue 组件编译成受限浏览器沙箱的交互体验。它可以在 Codex 语义区域的原生内容下方或上方显示视觉、动画和已授权交互，但不能读取或修改 Codex DOM。

## 生成前必须询问

如果用户没有明确交给 AI 决定，先集中询问以下内容，再开始生成：

1. Experience 名称、稳定的小写 ID、版本、风格关键词。
2. 六位 HEX 主题色、柔和/标准/高对比、Light 与 Dark 的设计意图。没有单独 Dark 设计时使用工具生成的暗色 token。
3. 需要定制哪些区域：`app-shell`、`navigation`、`titlebar`、`workspace`、`home`、`conversation`、`composer`、`modal`、`floating-window`。
4. 每个区域的内容属于原生内容下方 `underlay`，还是上方 `overlay`。允许只提供一个区域或一个平面。
5. 中央阅读区、输入区和原生按钮是否必须保持透明、清晰且可点击。
6. 哪些 overlay 需要真实交互、交互只改变自身状态还是要向宿主发送 action；action 的名称与 payload。
7. 图片、字体、音频、视频等原始资源、预期位置和使用权。缺少资源时不得根据截图伪造素材。
8. 动画、减少动态效果、目标屏幕比例与安全区。
9. 是否需要根据当前任务切换展示，或在其他任务完成时显示提醒；前者对应 `codex.context.active`，后者对应 `codex.events.lifecycle`。

## Node 项目结构

使用 `codex-experience init` 生成项目。默认 React，可通过 `--framework vue` 选择 Vue。不要让用户手写运行时 HTML：

```text
experience-project/
├── experience.manifest.json
├── experience.config.json
├── package.json
├── README.md
├── AGENTS.md
├── EXPERIENCE-BRIEF.md
├── docs/AI-GENERATION.zh-CN.md
├── src/
│   ├── main.tsx                    # Vue 项目为 main.ts
│   └── surfaces/
│       ├── background/
│       │   ├── index.tsx           # Vue 项目为 index.vue
│       │   └── styles.css
│       └── overlay/
│           ├── index.tsx           # Vue 项目为 index.vue
│           └── styles.css
├── assets/
└── dist/                         # npm run build 生成
    ├── experience.manifest.json
    ├── index.html
    └── assets/
```

依赖包本身可以通过 `npm run apply` 构建并应用当前项目，不需要外部宿主。它只把生成的 `dist/` 交给真实运行时；后续再次执行会显式构建并热刷新。可选宿主只读取构建后的 `dist/` 或 `npm run pack` 生成的 ZIP，不运行第三方项目脚本。

React/Vue 组件由项目本地 Vite 打成单文件 JavaScript/CSS，再由工具包生成固定的 runtime HTML。预览器可以分别隐藏 underlay 或 overlay 以检查每一层，但该开关不改变最终构建内容。旧版原生 v1 项目仍可构建，新项目和 AI 生成不得回退为手写 surface HTML。

## Surface 规则

在 `experience.config.json` 的 `authoring.surfaces` 中声明区域：

```json
{
  "target": "app-shell",
  "plane": "underlay",
  "interaction": "passthrough"
}
```

在 `src/main.tsx` 或 `src/main.ts` 中使用相同的 `plane:target` key 注册普通框架组件。每个 surface 必须拥有独立目录与 `styles.css`；背景样式不得写入 overlay，overlay 样式也不得写入背景。配置与组件映射必须一一对应；编译器负责生成、校验且只生成一个不可嵌套的 runtime surface。

- `underlay` 位于对应区域的 Codex 原生内容下方，只能是 `passthrough`。
- `overlay` 位于原生内容上方。纯装饰用 `passthrough`；零散按钮、悬浮入口和临时面板用 `scoped`；整块区域都属于 Experience 或承载远程 WebView 时才用 `interactive`。
- `scoped` overlay 必须通过 `window.codexExperience.interaction.register(element, { padding, shape })` 注册每个真实交互元素，并在卸载时 `destroy()`。圆形悬浮控件使用 `shape: "circle"`；带圆角的面板和摘要栏使用 `shape: "rounded"`，由 Runtime 读取真实 CSS 圆角；其他控件默认使用 `rect`。未注册区域点击原生 Codex。拖动或点外关闭仅允许临时注册全屏命中层，结束后立即撤销。
- 浮动按钮触发的菜单或控制窗口如果需要独立层级，必须拆到 `floating-window` surface，通过 signals 通信；不要把弹窗继续写在按钮所在 surface 内，也不要只堆叠 `z-index`。
- 层级固定为 floating-window → 普通 overlay → Codex 原生内容 → underlay → Codex 自身背景。
- 不要为了保证显示而把局部内容复制到全局 `app-shell`。路由或弹层不存在时，对应 surface 会等待目标出现。
- overlay 的透明像素也可能位于原生内容之上；交互面应尽量局部，中央阅读区和输入区默认透明。

## 统一外观 token

外部通过 `generateAppearanceTokens({ seed, contrast, darkSeed? })` 生成完整 Light/Dark 对象，再传给预览器或运行时。Experience 不应为每个按钮、文字和选中态自行发明无关颜色。

组件 CSS 使用 `--cek-background`、`--cek-surface`、`--cek-surface-selected`、`--cek-primary`、`--cek-on-surface`、`--cek-on-primary`、`--cek-outline`、`--cek-focus-ring`、`--cek-control-background-selected` 等变量。主题色、色阶、反色文字、选中背景、控件和暗色默认值来自同一配方。

## JavaScript 能力边界

普通按钮、动画、折叠和 surface 内部状态可使用浏览器 JavaScript。宿主只提供 `window.codexExperience`：

- `environment`：当前 mode、target、plane、appearance 与 reducedMotion。
- `tokens`：在声明 `appearance.tokens` 后读取和订阅完整 token。
- `signals`：隔离 surface 之间同步 Experience 自身状态。
- `context`：声明 `codex.context.active` 后读取、订阅脱敏的当前任务和状态快照；只有另行声明 `codex.context.metadata` 才能读取可选的 `displayName`。
- `events`：声明 `codex.events.lifecycle` 后订阅任务选择、状态、turn 开始/完成事件。
- `actions`：在声明 `host.actions` 后向宿主发出语义 action。
- 第二账号配置：仅当用户明确要求时申请 `codex.instance.configure`，先用 `codex.instance.transfer-catalog` 获取宿主生成的条目，能力配置默认勾选、会话与未知路径默认不选；不得由页面传入来源、目标或可执行文件路径。选择会话还要申请 `codex.conversations.sync` 并接受系统确认。
- `webviews`：声明 `remote.webview` 和 strict/permissive/unrestricted 安全模式，且位于 interactive overlay 时，通过 `mount()` 创建受控远程内容。strict 需要精确 HTTPS origin 白名单；permissive/unrestricted 必须先解释风险，unrestricted 只能在用户明确要求时生成。若目标站点禁止 iframe，必须同时提供原生 `url` 与可嵌入的 `iframeFallbackUrl`，并说明用 `npm run dev:native -- --allow-unrestricted-remote-content` 预览。
- `lifecycle`：ready 和生命周期通知。

禁止访问 Codex DOM、父页面、Node、Electron、CDP、文件系统、任意网络 API 和任意宿主方法。普通资源必须在项目内使用相对路径。不要使用绝对路径、CSS `@import` 或未打包的多文件相对 ESM import。远程页面是唯一例外：不得直接写 `<webview>`/远程 `<iframe>`，必须使用 `remote.webview` API。iframe provider 不能绕过站点的 X-Frame-Options/`frame-ancestors`；原生 `WebContentsView` 不是 iframe，但也不能绕过网络、页面 CSP、导航、权限、下载、混合内容与系统策略。任何后端都不得开放 `file:`、`javascript:` 或本机代码执行能力。

`context`/`events` 中的 `threadId` 和 `sessionId` 只用于同一 Experience 内关联状态。会话名称必须显式申请 `codex.context.metadata`，并只读取可选的 `displayName`；不得假设存在提示词、回复正文、cwd、仓库路径或发送/取消任务的方法，也不得用 DOM 抓取补齐这些数据。`waiting-input` 和 `waiting-approval` 必须使用不同视觉状态。预览时必须用合成控制验证当前任务切换与后台完成效果。

## 交付前检查

1. `npm run build` 与 `npm run check` 通过。
2. `npm run dev` 中检查 Home/Conversation、Light/Dark、宽窄窗口和滚动。
3. 检查减少动态效果；避免持续大面积滤镜和高频粒子。
4. 所有 underlay 和纯装饰 overlay 不拦截原生点击；`scoped` overlay 的注册区域外必须命中原生 Codex。
5. 中央阅读和输入区域符合用户要求。
6. 向用户报告 target + plane 清单、权限、action、资源来源与使用权、主题色和已知限制。
7. 自动化检查不得执行 `npm run apply`。它会连接真实 Codex；只有用户明确要求时才运行，首次使用 `--allow-restart` 前还要确认用户已保存当前工作。
