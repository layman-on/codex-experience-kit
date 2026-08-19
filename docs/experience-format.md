# Experience v1 package format

The host imports only a built directory or ZIP containing:

- `experience.manifest.json`
- `index.html`
- optional package-local assets

```json
{
  "apiVersion": 1,
  "id": "example.experience",
  "name": "Example Experience",
  "version": "0.1.0",
  "entry": "index.html",
  "permissions": ["appearance.tokens"]
}
```

Supported permissions are `appearance.tokens`, `host.actions`, `remote.webview`, `codex.context.active`, `codex.context.metadata`, `codex.events.lifecycle`, `codex.instance.configure`, and `codex.conversations.sync`. Unknown manifest fields and permissions are rejected.

- `codex.context.active` exposes a sanitized snapshot of selected task identity and known task states.
- `codex.context.metadata` adds the task display name and requires `codex.context.active`; prompts, responses, cwd, and repository paths remain unavailable.
- Active status distinguishes `working`, `waiting-input`, and `waiting-approval`; `waiting` remains the forward-compatible fallback for an unfamiliar actionable state.
- `host.actions` may emit the Kit-reserved `codex.window.open` action. With no payload it opens the native Codex home route. `{ "threadId": "<local Codex UUID>" }` opens that local conversation in a new window at Codex's fixed `/local/<id>` route. Arbitrary routes and non-UUID identifiers are rejected; author code never receives Electron access. New windows share the same Codex account, task store, and lifecycle state—the action creates a separate view, not an isolated profile.
- `host.actions` may emit `codex.instance.open-isolated` to start the Kit-managed secondary Codex instance on macOS. It launches the verified Codex executable as a separate process with a fixed private Chromium user-data directory and a separate `CODEX_HOME`, so cookies, authentication, configuration, and the task/session library are independent. Author payloads cannot select an executable, profile path, environment variable, or process argument. The secondary instance data persists for reuse and is not deleted by cancellation.
- `codex.instance.configure` plus `host.actions` may request `codex.instance.transfer-catalog` with a caller-generated `requestId`, then `codex.instance.open-configured` with that id and catalog item ids. Results arrive as the `codex.instance.result` signal. The host, not author HTML, determines every source/destination path. Known capability/config items default on, conversations and newly discovered paths default off, and hard-excluded identity/runtime paths cannot be selected.

Authoring `experience.config.json` may separately declare `preview.tools: ["codex-secondary-instance"]`. This is trusted development-shell metadata, not part of `experience.manifest.json`: it adds the Kit-owned second-account settings dialog to `npm run dev`, while the compiler omits the complete preview header and dialog from `dist`. It therefore does not grant `host.actions`, `codex.instance.configure`, or `codex.conversations.sync` to the built Experience.
- Selecting conversations additionally requires `codex.conversations.sync`. `conversationGroups` supplies project/section groups and individual local thread ids, titles, timestamps, archive state, and logical size. The author UI must default every conversation off, may implement group and child selection, and sends only selected ids through `selectedConversationThreadIds`. The host asks for native confirmation, merges only the chosen SQLite thread rows, and copies their complete rollout JSONL plus directly keyed local resources. It never copies active processes, pending in-memory output, authorization waits, or credentials.
- `codex.events.lifecycle` exposes sanitized connection, selection, thread-status, turn-start, and turn-completion events.

Neither permission includes titles, prompts, responses, cwd, repository paths, credentials, raw App Server/CDP access, or task-control methods. Projects that do not need task awareness must not request these permissions.

`remote.webview` additionally requires a security policy and at least one interactive overlay. Strict mode is the default and requires an exact HTTPS origin list:

```json
{
  "permissions": ["appearance.tokens", "remote.webview"],
  "webviews": {
    "securityMode": "strict",
    "allowedOrigins": ["https://www.baidu.com"]
  }
}
```

The three modes are:

- `strict`: 1–8 exact HTTPS origins, credentialless/no-referrer sandbox, no popups, downloads, device permissions, or top navigation.
- `permissive`: any HTTP/HTTPS origin, while retaining the credentialless/no-referrer sandbox and the remaining restrictions.
- `unrestricted`: browser/CDP providers mount a direct host-owned sibling iframe; an Electron preview host may instead use an isolated `WebContentsView`. It is critical risk and requires a separate host/CLI grant.

Strict origins cannot contain paths, credentials, wildcards, or HTTP. Runtime navigation may use paths under an allowed origin. Permissive and unrestricted policies must omit `allowedOrigins`. Every mode still rejects `file:`, `javascript:`, embedded Node/Electron/CDP access, and direct remote `iframe` or Electron `webview` elements. Framework code calls `window.codexExperience.webviews.mount()` and may provide `iframeFallbackUrl` for iframe providers.

An unrestricted manifest does not grant itself permission. A host must pass `allowUnrestrictedRemoteContent: true`; the CLI requires `--allow-unrestricted-remote-content`. Catalog and preview results expose critical risk metadata so a UI can show the warning before granting it. Iframe providers remain subject to `X-Frame-Options`/`frame-ancestors`; native `WebContentsView` is not an iframe but still obeys network, page CSP, navigation, permission, download, mixed-content, and OS controls.

`index.html` declares one or more non-nested `codex-experience-surface` elements. Every declaration explicitly provides `target`, `plane`, and optionally `interaction="passthrough|scoped|interactive"`. Underlay interaction is always passthrough.

Overlay interaction modes:

- `passthrough`: the surface never receives pointer input.
- `scoped`: the surface registers individual DOM hit targets with `window.codexExperience.interaction.register(element, { padding, shape })`. `shape` supports `rect`, `rounded` (derived from the element's computed border radius), and `circle`. The host enables pointer input only inside their current shapes and preserves native Codex interaction everywhere else.
- `interactive`: the full semantic surface receives pointer input. Reserve this for full-surface applications and managed remote WebViews.

`floating-window` is the dedicated top-level overlay target. It always mounts in an independent sandbox iframe above ordinary overlays and must use `scoped` or `interactive` interaction. A trigger stays in its original semantic surface and opens or closes this window through runtime signals.

Local CSS, JavaScript, images, fonts, audio, and video are allowed within size limits. The importer resolves local references into a self-contained HTML document. It rejects symlinks, unsafe paths, remote URLs, CSS imports, direct navigation, duplicate ZIP entries, and unbundled multi-file relative ESM.

Old `theme.manifest.json`, `theme.json`, image-theme, and implicit-layer inputs are rejected with a legacy-format error. There is no runtime compatibility mode.

Authoring projects should use the generated Node layout and let `npm run build` produce this contract.

The default authoring format is React, with Vue selected through `init --framework vue`. `experience.config.json` declares `authoring.framework`, an entry relative to `sourceDir`, and a unique list of `{ target, plane, interaction }` surfaces. The framework entry registers one component for each `plane:target` key. Generated projects keep every surface in its own directory with a component entry and private `styles.css`. The package-owned compiler invokes the project-local Vite installation and emits this same framework-neutral v1 package.

The built package never contains authoring configuration, TypeScript, JSX, Vue SFC files, Vite configuration, or `node_modules`.
