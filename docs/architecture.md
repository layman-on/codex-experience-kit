# Architecture

Codex Experience Kit separates authoring, direct control, optional host integration, browser capability, and real-Codex placement.

```text
Node authoring project
  experience.config.json ─ target / plane / interaction
  src/main.tsx + surfaces/*/index.tsx + styles.css  (React default)
  src/main.ts + surfaces/*/index.vue + styles.css   (Vue option)
        │ project-local Vite bundle
        │ build / check / pack
        ▼
  dist runtime contract
        │
        ├─ Synthetic preview provider
        │    ├─ browser iframe backend
        │    ├─ optional Electron WebContentsView backend
        │    └─ explicit Apply / Restore toolbar ─ package runtime
        └─ Control entry
             ├─ Package CLI / CodexExperienceRuntime
             │    └─ direct build, apply, refresh, patch, status, cancel
             └─ Optional host application
                          │ immutable import or explicit dev refresh
                          ▼
                    Experience Engine
             │ transactional apply / patch / cancel
             ▼
        explicit loopback CDP
             ▼
        official Codex semantic owners
             ├─ package-owned main-world host (placement only)
             └─ sandboxed opaque-origin iframe targets
                    ├─ inert HTML/CSS document
                    └─ child-target application runtime
                         └─ window.codexExperience
                              ├─ sanitized context snapshot
                              ├─ sanitized lifecycle events
                              └─ allowlisted semantic host actions
```

## Public boundaries

- `core`: manifest, target/plane contract, digest, appearance token types, sanitized Codex context/event types, sandbox view bootstrap, and native-WebView command/transport types without Node or Electron imports.
- `utils`: deterministic appearance token generation and contrast utilities.
- `preview`: synthetic Codex DOM and Experience mounting. It never reads real tasks.
- `node`: default standalone runtime, package import, immutable library, development snapshot registry, project toolchain, CDP renderer-context provider, explicit-endpoint App Server provider, engine, native preview launcher, and Electron `WebContentsView` main-process adapter.
- `service`: provider-neutral `CodexContextService`, synthetic provider, and composite provider. It contains no Node or Electron dependency.
- package CLI: the complete direct user surface. It does not call an external host and requires `--allow-restart` before the one operation that may restart Codex.
- preview shell: trusted localhost UI owned by the package. Optional `preview.tools` controls live here, outside every sandbox surface, and are stripped from the compiled Experience boundary.

The built `dist/` directory is the runtime boundary. Direct application of an authoring project invokes the package-owned compiler and then links only its generated `dist/`. Optional hosts do not call `npm install`, `npm run build`, or arbitrary project scripts.

The standalone preview is safe by default: rendering and appearance switching remain synthetic. Its explicit Apply/Restore controls call the same Node runtime through a loopback-only, per-process random-token endpoint. The endpoint handles browser preflight for HTTP(S) loopback origins across local ports while rejecting non-loopback, `null`, wildcard, and credentialed origins. Apply always rebuilds and validates `dist/`; the endpoint is not exposed on a non-loopback host and permits only one mutation at a time.

## Placement

`target` identifies a semantic Codex owner. `plane` is `underlay` or `overlay`. Each pair has at most one surface. Underlays force passthrough. Overlay interaction is `passthrough`, `scoped`, or `interactive`. `floating-window` is app-window-scoped: the host mounts it in a separate sandbox iframe above ordinary overlays, and it must be scoped or interactive. Cross-surface coordination still uses sanitized runtime signals rather than DOM access.

For `scoped`, the child runtime observes registered elements and publishes sanitized rectangles. The preview and Codex hosts validate at most 16 regions and build a disjoint CSS `clip-path` on the full-size iframe. Pointer events are enabled only while at least one region exists. This keeps buttons, floating controls, and temporary panels interactive without turning their transparent full-screen iframe into a click blocker. `interactive` deliberately gives the full semantic owner to the iframe and should remain limited to full-surface UI or a managed remote WebView.

Preview and real providers share the same sandbox API, tokens, surface filtering, signals, actions, controlled remote-WebView protocol, and lifecycle contract, but their boot path is intentionally different. Browser preview can load the complete generated view document directly. Official Codex inherits a restrictive parent CSP into `srcdoc`, so its CDP provider splits the build into three parts: a small package-owned host expression for semantic placement, a script-free HTML/CSS document staged as a protocol argument, and one author-runtime source per declared surface. The host creates an opaque-origin iframe; Chromium exposes it as an out-of-process iframe target; the provider matches it by a deterministic build-and-surface name, evaluates the author runtime in that child session, resumes it, and waits for explicit `lifecycle.ready()`. Author HTML or JavaScript is never evaluated in the Codex main realm.

An Experience author frame always keeps `frame-src 'none'` and stays opaque. With `remote.webview`, author code only sends lifecycle and geometry requests; the provider validates them again and creates a package-controlled sibling host.

Context data follows the same opaque-frame bridge. The real renderer provider observes only semantic task identity/status signals and emits a sanitized snapshot. An optional explicit App Server provider supplies thread-scoped lifecycle events and distinguishes `waitingOnUserInput` from `waitingOnApproval`. The injection runtime merges App Server state with renderer-selected state, applies manifest permission filtering, and posts only `codex-context` / `codex-event` messages to the project's own randomized channels. `codex.context.metadata` gates the optional display name independently from the base context permission. Raw CDP, App Server RPC, conversation text, paths, credentials, and control requests never enter author frames.

Host actions cross the same bridge as semantic names, never as arbitrary IPC. The reserved `codex.window.open` action is accepted only with `host.actions` and translated in the package-owned main-world host to Codex's native `open-in-new-window` message. An absent payload selects the fixed home route; a validated local-thread UUID selects the fixed `/local/<id>` route. Author-provided paths and opaque/non-UUID ids are never forwarded. The new view shares Codex's account, task store, and lifecycle state; it is not a second profile. No Electron bridge object is exposed to author code.

Separate-account actions cross a narrower native broker. While an Experience is active, the Node runtime owns a randomized CDP binding and a detached broker connected only to the verified Codex renderer. The broker accepts a fixed action vocabulary and one fixed `secondary` slot, then launches the already-verified Codex executable with an early `--user-data-dir` switch plus matching `CODEX_ELECTRON_USER_DATA_PATH`, and with `CODEX_HOME` pointing at a separate Kit-owned directory. The first pair isolates Chromium single-instance state, cookies, and web storage; `CODEX_HOME` separately isolates Codex authentication and data. Project payloads never reach `spawn`, and cannot provide paths, arguments, environment variables, commands, or source/destination directories.

The transfer catalog is discovered in the broker from the fixed primary and secondary CODEX_HOME values. Known capability bundles default on, conversations default off, and unknown top-level data defaults off while exposing its real path to the local user. Credentials, browser state, OAuth locks, IPC, writer/process locks, logs, and worktrees are hard exclusions rather than checkboxes. Selected configuration is merged into the stopped secondary instance, overwritten secondary paths receive a local clone-backed recovery snapshot, and primary-CODEX_HOME path references are rebased. Local conversations are grouped from project/section metadata and measured per thread. Group selection is resolved to explicit thread ids before crossing the broker; a SQLite source snapshot validates those ids, inserts only matching thread/section/tool/edge rows, and copies only their rollout JSONL, keyed shell snapshots, keyed generated images, and the small shared pasted-text attachment index. Conversation migration requires an additional permission and native confirmation. The secondary Chromium profile and `auth.json` are never copied, so the other Codex/OpenAI account stays independent. Request results return only to the randomized channel that initiated the action.

The remote-content host applies one of three policies. Strict mode uses exact HTTPS origins and a credentialless/no-referrer iframe sandbox. Permissive mode allows arbitrary HTTP/HTTPS origins but retains that sandbox. Unrestricted mode requires a separate host grant and returns critical risk metadata. Browser and CDP providers use a direct sibling iframe. An Electron host may instead translate the same lifecycle and geometry protocol into main-process `WebContentsView` commands; privileged code revalidates every command, isolates the session, disables Node integration, defaults permissions/downloads to deny, and explicitly closes every WebContents.

Iframe providers remain subject to site embedding policy. `WebContentsView` is not an iframe and can load sites that reject framing, but it exists only inside the Electron process that created it. It cannot be attached across processes to official Codex, so direct CDP application uses the iframe backend. No backend gives author code Electron APIs or access to the host/remote DOM; `file:` and `javascript:` remain blocked.

## State and recovery

Installed and development projects use separate Experience namespaces. Import, replace, development refresh, application, rollback, and cancellation are transactional. The engine persists only validated metadata, the active receipt, complete tokens, appearance, and the reconnectable Codex session record.

`CodexExperienceRuntime` chooses the package-owned macOS storage path, coordinates authoring-project builds, development snapshots, restart planning, and appearance-only patching, then delegates every real mutation to `ExperienceEngine`. The CLI opens this runtime only for the duration of one command and releases its ownership lock while preserving the active injection transaction.

The secondary-account workflow is one Node service shared by the preview shell and the persistent native-action broker. It owns official executable resolution, the fixed isolated profile/CODEX_HOME, launcher installation, transfer-catalog discovery, conversation confirmation, target shutdown, transactional copy, and relaunch. Preview UI can enable that service declaratively, but author surface code cannot obtain its paths or invoke its filesystem/process primitives.

The macOS provider enumerates every verified official main process instead of treating Codex as a singleton. A stable instance id is derived from its isolated user-data profile (`primary` for the normal profile); PID and process start time identify the current generation. The active runtime session marks exactly one instance as connected. One running instance is selected automatically, while multiple instances require an explicit id. The first connection stops and relaunches only the selected restartable instance; primary uses a fresh LaunchServices instance and the Kit-managed secondary reuses its fixed isolated user-data directory and `CODEX_HOME`. Unknown custom profiles are adopted only when they already expose a verified loopback CDP endpoint and are never restarted from guessed arguments. Caller-owned Node and Electron process controls are removed from the launch environment. The runtime selects the chosen process's primary `app://-/index.html` renderer and excludes auxiliary pages such as `avatar-overlay`. Injection begins only after the selected process and endpoint remain stable. The session record is committed before renderer mutation so a retry does not require another restart. A failed debug launch is not reported as recovered until that same instance's normal relaunch also passes a stability window.

Every runtime startup and public status/apply/appearance/cancel operation reconciles durable state with the current process generation. The generation identity combines the verified executable, PID, process start time, loopback port ownership, main-page target, and an injected project/digest probe. A service-only restart reconnects the same renderer. A replaced or exited Codex generation invalidates the old receipt because its renderer cannot still contain that injection; a newly discovered verified CDP generation can be adopted immediately. If the same process remains alive but CDP is temporarily unreachable, the runtime keeps the receipt in recovery rather than guessing that the injection disappeared. `ExperienceRuntimeStatus.codexProcessGeneration` exposes `same`, `replaced`, `exited`, or `unknown` to hosts that poll `getStatus()`.

The old Theme package namespaces are neither listed nor converted. This avoids a compatibility layer and keeps rollback possible by leaving old files untouched.
