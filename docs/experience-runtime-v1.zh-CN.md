# Experience Runtime v1

Experience Runtime 把一个构建后的网页项目安全地放到 Codex 的语义区域。包自己的定位宿主运行在 Codex 主页面；作者 HTML、CSS 和 JavaScript 只运行在隔离子页面，不进入 Codex 主页面的 JavaScript 上下文。

## 层级

```text
overlay:floating-window（独立顶层弹窗）
overlay:app-shell
└─ Codex 原生 app-shell
   ├─ overlay:navigation → 原生 navigation → underlay:navigation
   └─ overlay:workspace  → 原生 workspace  → underlay:workspace
      ├─ overlay:titlebar → 原生 titlebar → underlay:titlebar
      ├─ home / conversation / composer
      └─ modal
└─ underlay:app-shell
```

`underlay` 适合背景、纹理和环境光，始终穿透；`overlay` 适合边框、角落装饰和必要按钮。Overlay 有三种交互模式：`passthrough` 完全穿透，`scoped` 仅让显式注册的控件接收点击，`interactive` 让整个语义区域接收点击。按钮、悬浮球和临时面板默认使用 `scoped`；需要保持阅读区时，不应给全局 overlay 放不透明中心内容或常驻全屏命中层。

`scoped` 组件通过 `window.codexExperience.interaction.register(element, { padding })` 注册真实 DOM 元素。Runtime 监听其尺寸、样式、滚动和窗口变化，宿主校验矩形后在 iframe 上生成不相连的命中路径；元素卸载时必须调用返回 handle 的 `destroy()`。未注册区域继续命中 Codex 原生内容。

## 多实例

每个 target + plane 在独立的 sandbox iframe 中运行同一个构建后入口。Runtime 只显示与 `window.codexExperience.environment.target/plane` 匹配的 surface。不同实例通过构建和 surface 隔离的 channel 使用 `postMessage` 通信，不能互相访问 DOM。

跨 surface 信号由宿主补充只读的 `source` 元数据，包括来源 `target`、`plane` 和应用坐标系内的区域 `bounds`。因此 `workspace`、`navigation` 等语义区域中的按钮可以准确锚定独立 `floating-window`，无需读取 Codex DOM 或猜测侧栏宽度。

`floating-window` 始终挂载到应用窗口范围，并位于普通 overlay 之上。它必须配置为 `overlay + scoped/interactive`，用于控制窗口、菜单、检查器等不能与触发按钮共享裁剪和层叠上下文的内容。触发按钮保留在原语义 surface 中，双方通过 `window.codexExperience.signals` 传递打开状态和锚点。

真实 Codex 的注入不是把 `dist/index.html` 直接交给 `Runtime.evaluate`。实际链路为：

1. 在 Codex 主 CDP target 顺序开启 `Runtime`、`Page` 和扁平化 iframe 自动附着。
2. 通过 `Runtime.callFunctionOn` 参数暂存已经移除可执行脚本的 HTML/CSS 文档；它带 `script-src 'none'`，只作为数据使用。
3. 在 Codex 主页面执行较小的包内 host source，仅负责寻找语义 owner、创建 underlay/overlay iframe、布局、消息桥和取消。
4. sandbox iframe 成为独立 opaque-origin OOPIF target 后，Kit 根据 frame name 找到对应的 CDP child session，在该子页面执行 Runtime bootstrap 和构建后的 classic-IIFE 作者代码。
5. React/Vue 挂载完必须调用 `window.codexExperience.lifecycle.ready()`；根 surface 未完成握手则 Apply 失败，不会把“iframe 已创建”误报为成功。

因此 Codex 主 target 接受的是 JavaScript CDP expression 和结构化参数，不接受“可执行 HTML”。HTML 进入 iframe 文档，作者 JavaScript 进入 iframe 子 target，二者不能混为一次主页面求值。

## 能力

普通 JavaScript 可控制自身 DOM。跨 surface 的 Experience 内部状态使用 `signals`；需要宿主行为时才申请 `host.actions`。主题色只是 `appearance.tokens` 能力，由公共 utils 生成完整 Light/Dark token 后传入，底层 Runtime 不私自生成颜色。包级 `CodexExperienceRuntime` 和 CLI 会调用同一 utils，因此不需要外部宿主来生成或更新 token。

需要根据 Codex 当前任务改变展示时，项目申请 `codex.context.active`，通过 `context.getSnapshot()` 或 `context.subscribe()` 获取脱敏快照。仅当界面必须展示会话名称时，再申请依赖于它的 `codex.context.metadata`；该权限只增加 `displayName`，不会开放提示词、回复正文、cwd 或仓库路径。需要响应当前或后台任务开始、等待、完成、失败与中断时，再申请 `codex.events.lifecycle`，通过 `events.subscribe()` 接收事件。等待状态细分为 `waiting-input`（等待用户输入）和 `waiting-approval`（等待授权），未知的可操作等待状态回退为 `waiting`。

`host.actions` 仍是语义动作边界。Kit 保留 `codex.window.open`，把它映射为 Codex 原生新窗口消息：无 payload 时打开首页；传 `{ threadId: "本地 Codex 会话 UUID" }` 时在新窗口打开指定会话。Kit 只生成固定的 `/local/<id>` 路由，不转发任意路径。新窗口与原窗口共享 Codex 账户、会话库和任务生命周期，它只是独立视图，不是隔离 profile。Experience HTML 不能直接访问 Electron，也不能自行启动应用进程。

另一个保留动作 `codex.instance.open-isolated` 用于 macOS 第二账号。它通过 Kit 自己维护的随机 CDP binding 和本机 broker，启动已验证的 Codex 可执行文件，并固定使用 Kit 管理的 `secondary` Chromium 用户目录和 `CODEX_HOME`。前者隔离进程锁、Cookie 与 Web Storage，后者隔离 Codex 认证、配置及会话库；因此第二实例不是共享账号的新窗口。第一次打开需要重新登录。Experience 不能指定命令、可执行文件、参数、环境变量或目录，取消 Experience 也不会删除已登录的第二账号数据。每次成功启动还会安装或刷新 `~/Applications/Codex Secondary.app`；电脑重启后可从 Finder、Spotlight 或 Dock 直接重开同一个实例，也可执行 `codex-experience instance open`，不要求主题已应用或 CDP/broker 正在运行。

需要在打开前选择迁移内容时，项目同时申请 `codex.instance.configure` 与 `host.actions`：先发出带 `requestId` 的 `codex.instance.transfer-catalog`，再使用返回的条目 id 发出 `codex.instance.open-configured`，结果通过 `codex.instance.result` signal 回到原 surface。Codex/MCP 配置、工作区/项目列表、Skills、Plugins、规则、Hooks、自动化、Memories 和 Pets 默认勾选。会话记录默认全部不勾选；`conversationGroups` 按 Codex 项目/分区提供分组及具体会话、更新时间和逻辑大小，界面可以按组全选/半选，也可以展开逐条选择，再把明确的 thread id 放入 `selectedConversationThreadIds`。Kit 新发现的顶层数据路径显示绝对路径且默认不选。账号凭据、浏览器身份、OAuth 锁、IPC、进程/写入锁、日志和 worktree 永远不可选。选择会话还必须申请 `codex.conversations.sync` 并通过系统确认；宿主仅合并选中会话的数据库行、JSONL 和直接关联资源。复制配置不会覆盖第二账号的 `auth.json`，因此能力可以复用而两个 Codex/OpenAI 登录身份仍然独立。

真实 Codex 默认由 renderer provider 感知当前选中任务和页面可见的状态变化。可选宿主可以显式传入 `CodexContextSource`；Kit 会把它与 renderer 上下文合并。`CodexAppServerContextProvider` 只连接调用方提供的 WebSocket 地址，默认只允许 loopback，不探测正在运行的 Codex，不读取未知 socket。App Server 的 WebSocket transport 仍属实验能力，因此断开时 Runtime 保留 renderer provider 并将连接状态安全降级。

远程内容使用独立的 `remote.webview` 权限，且只允许在 interactive overlay 中调用 `window.codexExperience.webviews.mount()`。Experience 只发送挂载、布局、导航、刷新和销毁请求，宿主再次校验并创建同级远程容器。

WebView 安全模式分为 strict、permissive 和 unrestricted。strict 使用精确 HTTPS 白名单及 credentialless/no-referrer sandbox；permissive 允许任意 HTTP/HTTPS origin 但保留 sandbox；unrestricted 必须同时获得宿主授权并展示 critical 风险警告。普通浏览器与 CDP provider 使用 sibling iframe；Electron 原生预览可将同一组 mount/layout/navigate/reload/destroy 请求交给主进程 `WebContentsView`。作者 iframe 始终 opaque，不会因此获得 Codex、Node、Electron 或 CDP 权限，`file:` 与 `javascript:` 永久拒绝。

iframe provider 仍受站点 `X-Frame-Options`/`frame-ancestors` 限制；原生 `WebContentsView` 不属于 iframe，可加载禁止嵌入的页面，但仍受网络、页面 CSP、导航、权限、下载、混合内容和系统策略约束。原生 View 只能属于创建它的 Electron 进程，不能跨进程挂到官方 Codex，因此直接应用 Codex 仍使用 iframe。组件可给 `mount()` 同时传 `url` 和 `iframeFallbackUrl`，分别服务原生与 iframe 后端，并通过 `environment.remoteContentBackend` 查看当前后端。

## 预览与应用

独立 `npm run dev`、`npm run dev:native`、可选宿主预览和真实 Codex 使用相同的 view bootstrap。两种独立预览和测试只包含合成内容，并提供 Task A/Task B 切换及后台完成事件模拟；只有用户点击 Apply 或执行 apply 命令才连接真实 Codex。原生预览需要项目本地安装 Electron，并且 unrestricted 内容仍需 `--allow-unrestricted-remote-content`。

`npm run apply` 由包本身完成构建、关联 `dist`、应用和后续热刷新。第一次需要建立 CDP 连接时，只有显式传入 `--allow-restart` 才允许重启 Codex。`npm run appearance` 只更新 token/Light-Dark 状态，`npm run cancel` 事务性移除当前和未来页面的注入。外部宿主不参与这些流程。
