# Optional host integration

A graphical host is optional, not a runtime prerequisite. `codex-experience-kit` can apply and cancel directly through its CLI or `CodexExperienceRuntime`; when another application embeds it, the package still owns validation, immutable storage, development snapshots, synthetic preview primitives, semantic placement, sandboxing, official Codex discovery, CDP lifecycle, patching, rollback, and cancellation.

The direct equivalent is:

```bash
codex-experience targets
codex-experience apply ./example-experience --target primary --allow-restart
codex-experience appearance --seed '#008577' --appearance dark
codex-experience cancel
```

## Dependency

```bash
npm install --save-exact codex-experience-kit@0.6.12
```

The Electron main process dynamically imports `codex-experience-kit/node`. The settings renderer bundles `codex-experience-kit/preview` and `codex-experience-kit/utils`.

For native remote pages, the main process also owns `ElectronWebContentsViewHost`; expose only its typed `dispatch(command)` operation through a narrow preload IPC bridge. The renderer passes that transport to `mountExperienceProjectPreview`. Never expose `ipcRenderer`, `WebContentsView`, paths, or arbitrary channel names to Experience code.

## Main-process service

Create one long-lived engine in an Experience-only storage namespace:

```ts
import { ExperienceEngine } from "codex-experience-kit/node";

const engine = new ExperienceEngine({
  libraryPath: join(app.getPath("appData"), "CodexExperienceKit"),
});
await engine.initialize();
```

Before applying, call `engine.listCodexInstances()`. It returns every verified running main instance with a stable id, role, process generation, CDP readiness, and a `connected` flag. Pass the selected id as `targetId` to `applyProject()` or `CodexExperienceRuntime.apply()`. A host may auto-select only when exactly one instance exists; with multiple instances it must ask the user. Restart consent applies only to the selected restartable instance, and a custom-profile instance without a reusable CDP endpoint is reported as unavailable rather than restarted with guessed arguments.

Keep file dialogs and raw paths in the main process. Renderer IPC accepts only validated Experience IDs, complete token modes, Light/Dark appearance, and bounded commands.

## Import modes

Formal import accepts a built ZIP or a built `dist/` directory. It validates and copies an immutable snapshot into `experience-projects-v1`; later changes to the source do not affect the installed item.

Development mode links only an already-built `dist/`, not the Node project root. The host stores the source path only inside the Node registry. When the user clicks refresh, the SDK rereads and validates `dist/`, updates the last-good snapshot, refreshes preview, and hot-applies when active. A failed refresh preserves the previous snapshot.

The host must never execute third-party `package.json` scripts, install dependencies, or compile a project.

## Preview and appearance

```ts
import { mountExperienceProjectPreview } from "codex-experience-kit/preview";
import { generateAppearanceTokens } from "codex-experience-kit/utils";

const modes = generateAppearanceTokens({ seed: "#6750A4" }).modes;
const preview = mountExperienceProjectPreview(host, project, {
  tokens: modes,
  appearance: "light",
  view: "task",
});
```

An Electron renderer can opt into the native backend through a preload-owned transport:

```ts
const preview = mountExperienceProjectPreview(host, project, {
  tokens: modes,
  appearance: "light",
  allowUnrestrictedRemoteContent: true,
  remoteContentBackend: "native",
  nativeWebviews: window.hostExperienceNativeWebviews,
});
```

In the main process, `window.hostExperienceNativeWebviews.dispatch()` must invoke an `ElectronWebContentsViewHost` created with the host's `BrowserWindow.contentView` and Electron's `WebContentsView` constructor. The Kit revalidates protocol, URL, surface, bounds, navigation, permissions, downloads, and cleanup in the main process. The host supplies only consent/UI and IPC transport; it does not reimplement the remote-content engine.

The color picker calls the public utility and replaces the complete token modes in preview. Apply sends the same object to the engine. Partial appearance updates use `patchTokens`; individual controls do not invent unrelated colors.

For task-aware projects, the host still does not implement Codex event logic. It passes a Kit-owned `CodexContextSource` into preview/runtime, or uses the preview handle's `setCodexContext()` / `emitCodexEvent()` with Kit-defined types. The default standalone preview already simulates two tasks and a background completion. If the host owns a trusted App Server endpoint, create `CodexAppServerContextProvider` in the main process, wrap it with `CodexContextService`, and pass the service to `ExperienceEngine({ contextSource })`. The provider maps the current App Server flags to `waiting-input` and `waiting-approval`; `codex.context.metadata` separately controls whether `displayName` reaches the Experience. Never expose the WebSocket URL, bearer token, raw RPC, or CDP to the renderer or Experience frame.

Reserved actions such as `codex.window.open` and `codex.instance.open-isolated` are implemented by the Kit's real-Codex host. An optional host may display them in synthetic preview as emitted events, but must not reproduce Electron, process launching, or Codex IPC in its renderer. The isolated-instance action always targets the Kit-managed secondary profile; host and Experience code cannot supply a process path or arguments.

## Remote-content consent

Imported projects and preview state expose `remoteContentRisk`. A host should render its `level`, `warning`, and `risks` before preview or apply. The modes are:

- `strict`: exact HTTPS origin allowlist and credentialless/no-referrer sandbox.
- `permissive`: arbitrary HTTP/HTTPS navigation, with the sandbox retained.
- `unrestricted`: a browser preview uses a direct sibling iframe; an Electron host may select native `WebContentsView`; risk level is `critical`.

An unrestricted manifest is only a request. The host must require a separate user acknowledgement and then pass the grant explicitly:

```ts
const preview = mountExperienceProjectPreview(host, project, {
  tokens: modes,
  appearance: "light",
  view: "task",
  allowUnrestrictedRemoteContent: true,
});

await engine.applyProject(project.id, {
  tokens: modes,
  appearance: "light",
  allowUnrestrictedRemoteContent: true,
});
```

Never infer the grant from the manifest, remember it globally, or grant it to an untrusted project. The warning must state that the remote page may use credentials and storage, navigate or open windows, download files, request device permissions, and execute arbitrary remote scripts. Browser siblings also carry same-origin host-DOM risk. Native `WebContentsView` is isolated from renderer DOM and can load pages that reject iframe embedding, but it still cannot expose Node/Electron/CDP or load `file:`/`javascript:` URLs, and it remains subject to network, page CSP, navigation, permission, download, mixed-content, and OS enforcement.

## Apply lifecycle

1. Call `planApply` or `planApplyDevelopment`.
2. If `requiresRestart`, ask for explicit user confirmation.
3. Call `applyProject` or `applyDevelopmentProject` with complete tokens and appearance.
4. Show success only after the engine verifies every declared surface as mounted or pending.
5. Use `cancelProject` to remove current and future-document injection transactionally.

Route-specific and transient targets may be pending. `home`, `conversation`, `composer`, and `modal` do not need to coexist. `floating-window` is app-window-scoped, always available, and mounted in a separate top-level sandbox iframe.

## Authoring entry

The host does not need to download a static template. Its page can tell authors to run:

```bash
npx codex-experience-kit init ./example-experience
cd example-experience
npm install
npm run dev
```

The host may export `readExperienceAiGuide()` and open `EXPERIENCE_GALLERY_URL`. The initialized project already contains README, AGENTS, EXPERIENCE-BRIEF, and AI rules.

## Release gate

1. Experience Kit: `npm run check && npm run test:simulation && npm run pack:check`.
2. Host application: run its type checks, tests, and production build.
3. Verify the packaged application contains exactly `codex-experience-kit@0.6.12` and its production dependencies.
4. Use only synthetic preview/CDP during automated verification; never attach to a user's running Codex.
