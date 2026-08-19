# 不依赖外部宿主直接使用

`codex-experience-kit` 自己拥有 Codex 的导入、应用、热刷新、局部外观更新、状态和取消能力。外部宿主只是可选 UI，不参与这些命令。

新项目默认使用 React：

```bash
npx codex-experience-kit init ./example-experience
```

选择 Vue：

```bash
npx codex-experience-kit init ./example-experience --framework vue
```

## 在 Experience 项目中

```bash
npm install
npm run dev
npm run apply
```

`npm run dev` 打开由依赖包自己提供的仿真预览。仅打开页面、切换 Home/Conversation、Light/Dark，或独立显示/隐藏 Underlay 与 Overlay 都不会连接 Codex。平面显示按钮只影响预览，不修改构建结果。预览顶部同时提供“应用到 Codex”和“恢复官方界面”：点击应用后会重新构建最新 `dist/`，并把预览当前选择的 Light/Dark 状态及同一套 token 交给包内运行时；点击恢复会取消活动 Experience。

如果 manifest 申请 `codex.context.active` 或 `codex.events.lifecycle`，预览顶部还会显示 Task A、Task B 和 Complete other。它们只生成合成任务切换/后台完成事件，用来验证 Overlay 的动态表现，不读取任何真实 Codex 任务。

预览中的应用按钮和 `npm run apply` 是同一种真实操作。工具栏会发现全部运行中的 Codex 实例，标明已经连接的实例；只有一个实例时自动选中，存在多个实例时必须由用户明确选择。第一次为所选实例建立连接需要重启时，页面会先弹出确认，不会静默重启；取消确认则保持当前 Codex 不变。其他 Codex 实例不会被关闭。自动化预览测试不得点击应用或恢复按钮。

第一次建立连接可能需要重启 Codex。默认命令会停止并提示，不会自行重启；保存当前工作后显式执行：

```bash
npm run apply -- --allow-restart
```

建立连接后，再次执行 `npm run apply` 会使用同一会话事务性热刷新。候选版本校验或应用失败时保留上一个有效版本。

多实例时可先查看目标，再明确应用：

```bash
npm run targets
npm run apply -- --target profile-a1b2c3d4e5f6
```

`targets` 返回稳定的 `id`、主实例/第二账号/自定义配置角色、PID、CDP 就绪状态，以及 `connected` 标记。自定义 user-data-dir 实例若没有现成 CDP 连接，Kit 不会猜测其启动参数或擅自重启。

## 受控远程页面

需要在交互式 Overlay 中展示远程网页时，在 `experience.manifest.json` 同时声明权限和安全模式。默认使用 strict：

```json
{
  "permissions": ["remote.webview"],
  "webviews": {
    "securityMode": "strict",
    "allowedOrigins": ["https://www.baidu.com"]
  }
}
```

组件必须调用 `window.codexExperience.webviews.mount(container, { url, iframeFallbackUrl })`。`url` 是原生后端主地址，可选的 `iframeFallbackUrl` 供普通浏览器/CDP 使用。不要直接写 `<webview>` 或远程 `<iframe>`；生成项目的 `npm run typecheck` 会提前发现这类错误。能力只对 `interaction: "interactive"` 的 Overlay 开放。

普通按钮、悬浮入口和临时面板不要因此把整个 Overlay 设为 `interactive`。改用 `interaction: "scoped"`，挂载后调用 `window.codexExperience.interaction.register(element, { padding })`，卸载时调用 handle 的 `destroy()`。宿主只在这些矩形内接收点击，其余区域仍操作原生 Codex。

- `strict`：仅允许 1–8 个精确 HTTPS origin；无凭证、无 referrer，禁止弹窗、下载、设备权限和顶层跳转。
- `permissive`：允许任意 HTTP/HTTPS origin 和跨域站内跳转，但仍保留 credentialless sandbox。
- `unrestricted`：浏览器/CDP 使用宿主管理的直接 sibling iframe；Electron 原生宿主可使用隔离的 `WebContentsView`，风险等级为 critical。

unrestricted 必须由项目申请、宿主再次授权。CLI 使用：

```bash
npm run dev -- --allow-unrestricted-remote-content
npm install --save-dev electron
npm run dev:native -- --allow-unrestricted-remote-content
npm run apply -- --allow-unrestricted-remote-content
```

Node 宿主可在 Runtime 构造器的 `security.allowUnrestrictedRemoteContent` 或单次 `apply()` 中授权。导入、列表和预览状态会返回 `remoteContentRisk`，宿主应在用户授权前展示其中的 `warning` 和 `risks`。

即使启用 unrestricted，仍然不会向 Experience 开放 Node、Electron、CDP、`file:` 或 `javascript:`。普通 iframe 预览仍不能嵌入拒绝 framing 的 Google 等页面；`dev:native` 的 `WebContentsView` 不受 iframe-only 规则影响，但仍受网络、页面 CSP、导航、权限、下载、混合内容和系统确认约束。原生 View 无法跨 Electron 进程附着到官方 Codex，所以直接 apply 仍走 iframe provider。

## 局部更新与恢复

```bash
npm run appearance -- --seed '#008577' --appearance dark
npm run status
npm run cancel
```

- `appearance` 只更新完整 appearance token 和 Light/Dark 状态，不替换 HTML。
- 只切换模式可执行 `npm run appearance -- --appearance light`，会复用当前 token。
- `status` 读取包自己持久化的活动项目和连接状态。
- `cancel` 移除当前页面及未来页面的 Experience 注入，恢复官方界面。

Runtime 不把持久化的 `active=true` 当作事实。每次启动以及 `status`、`apply`、`appearance`、`cancel` 前都会按“官方可执行文件 + PID + 进程启动时间 + CDP 端口归属 + 主页面 target + 项目/digest 探针”自动对账：只重启服务会重连原 renderer；Codex 已退出或换代会自动作废不可能仍存在的旧 receipt；同一 Codex 进程只是暂时连不上时则保守进入恢复态，避免重复注入。宿主可读取 `codexProcessGeneration`（`same`、`replaced`、`exited`、`unknown`）展示状态，也可以按需轮询 `getStatus()`。

## 使用已构建包

```bash
codex-experience install ./example.experience-0.1.0.zip
codex-experience list
codex-experience targets
codex-experience apply example.experience --target primary --seed '#6750A4' --appearance light
codex-experience cancel
```

正式 `install` 会复制不可变版本。直接对项目目录或 `dist/` 执行 `apply` 使用开发快照，适合持续修改和热刷新。

## Node API

```ts
import { CodexExperienceRuntime } from "codex-experience-kit/node";

const runtime = new CodexExperienceRuntime({
  security: { allowUnrestrictedRemoteContent: true }
});
try {
  const instances = await runtime.listCodexInstances();
  const target = instances.find((instance) => instance.connected) ?? instances[0];
  await runtime.apply("./example-experience", {
    targetId: target?.id ?? "primary",
    allowRestart: true,
  });
  await runtime.patchAppearance({ seed: "#008577", appearance: "dark" });
} finally {
  await runtime.shutdown();
}
```

默认数据目录是 `~/Library/Application Support/CodexExperienceKit`。CLI 可用 `--library` 隔离目录，Node API 可传 `libraryPath`。

同一数据目录只有一个控制者能持有运行锁。若外部宿主或另一条 CLI 命令正在执行 Experience 操作，当前命令会拒绝并提示，而不是并发修改 Codex。

自动化测试必须注入仿真 `CodexSessionProvider`，不得发现、连接、重启或修改用户正在运行的 Codex。

## 任务上下文服务

需要让 Overlay 跟随当前任务时，在 manifest 申请：

```json
{
  "permissions": ["codex.context.active", "codex.events.lifecycle"]
}
```

`context` 返回脱敏快照，`events` 推送 `activeThreadChanged`、`threadStatusChanged`、`turnStarted`、`turnCompleted`。第一版不开放任务标题、输入、回复正文、cwd、仓库路径或任何任务控制接口。

直接应用时，renderer provider 负责当前选中任务和页面可见状态。宿主若拥有自己明确启动并信任的 Codex App Server，可以通过 `CodexAppServerContextProvider({ webSocketUrl })` 补充后台事件，再把 `CodexContextService` 作为 `CodexExperienceRuntime({ contextSource })` 传入。Kit 不扫描 App Server 端口、不附着未知 socket；非 loopback 地址还必须由宿主显式允许并配置 WSS/认证。
