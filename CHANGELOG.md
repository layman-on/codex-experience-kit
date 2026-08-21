# Changelog

## Unreleased

- Add a complete Simplified Chinese README with matching sections, commands, security guidance, and a bidirectional language switch from the English README.
- Add pinned GitHub Actions CI and an OIDC Trusted Publishing release workflow with automatic npm provenance, strict tag/version/changelog validation, recoverable GitHub Release finalization, and protected `latest`, `beta`, and `next` channels.

## 0.6.12 - 2026-08-19

- Add declarative preview-only tools and enable a left-header second-account settings dialog in the tracked example. It reuses the package-owned isolated-instance workflow, defaults capability/config transfer on and conversations off, and is provably excluded from the built Experience and its permissions.
- Discover every running official Codex instance, expose stable target ids and connected/readiness states in the preview, CLI, and Node API, require explicit selection when several are running, and restrict confirmed restarts to the selected Kit-restartable instance.
- Add a complete `codex-theme-kit` migration guide covering project structure, semantic surfaces, permissions, browser globals, TypeScript APIs, preview, storage, and rollout.
- Point the README and published package metadata at the supported `codex-experience-kit` replacement workflow.

- Reconcile persisted Codex sessions by process generation (`PID + start time + executable + CDP ownership`). Service restarts now reconnect the same renderer, while Codex restarts automatically invalidate impossible stale injections instead of leaving development Apply stuck in recovery.

- Let an explicit Apply safely discard an unreachable persisted Experience receipt after Codex or macOS restarted, then continue to the normal restart-confirmation flow instead of failing with `development/recovery`. This does not cancel a live session or delete project/user data.
- Add `instance status`, `instance open`, and `instance install-launcher` commands for reopening the persistent secondary account without an active Experience or CDP session. Secondary launches now install `~/Applications/Codex Secondary.app`, so the same isolated login, tasks, and profile remain discoverable after a computer restart.
- Attach host-authored semantic target, plane, and app-coordinate bounds to relayed cross-surface signals so controls inside `workspace`, `navigation`, or other regions can accurately anchor an independent `floating-window` without DOM access or guessed layout widths.
- Add a package-owned second-account transfer catalog and configured launch flow. Capabilities and configuration default to selected, conversation history defaults to off with its measured size, and newly discovered CODEX_HOME data is shown with its absolute path for an explicit user choice.
- Preserve the secondary Codex/OpenAI identity by permanently excluding authentication, browser-session, IPC, writer-lock, process, log, and worktree data. Rebase CODEX_HOME-local paths in copied config, snapshot overwritten secondary configuration, and keep the existing destination account data recoverable.
- Add request/response delivery for reserved native instance actions without exposing CDP, filesystem paths supplied by author HTML, process arguments, or an arbitrary native bridge.
- Replace all-or-nothing conversation migration with a project-grouped catalog and per-conversation selection. Selective sync constrains SQLite rows to chosen thread ids and copies only their rollout JSONL, shell snapshots, generated-image directory, and the small shared pasted-text attachment index.

## 0.6.11 - 2026-08-13

- Add `scoped` overlays and `window.codexExperience.interaction.register()` with rectangular, computed-radius rounded, and circular regions, so isolated buttons, floating controls, and temporary panels can receive input without square compositor backgrounds while every unregistered pixel continues to click through to native Codex.
- Keep scoped hit regions synchronized across element resize, style changes, scrolling, preview, and real Codex injection, with a validated 16-region host boundary and empty-region fail-closed behavior.
- Update the generated React/Vue project contract and AI rules to prefer scoped interaction over full-surface interactive overlays.
- Replace the single giant main-world injection with a staged host/child CDP pipeline. Codex's main renderer receives only package-owned placement code and an inert, script-free document payload; author JavaScript executes only in the matching opaque-origin iframe target.
- Auto-attach and resume Electron iframe targets, including unmatched Codex-owned frames, and require every mounted root surface to complete its explicit `lifecycle.ready()` handshake.
- Respect inherited Codex CSP by stripping executable scripts from `srcdoc`, enforcing `script-src 'none'`, and installing the bundled classic-IIFE application through the child CDP session.
- Make host placement synchronous so suspended animation frames cannot leave Apply pending.
- Recognize current Codex sidebar rows through `data-app-action-sidebar-thread-*` semantics so task-aware overlays follow the selected task without reading its title or conversation.
- Reinstall package-owned host code on every explicit development Apply even when author assets have the same digest, so a Kit upgrade is hot-applied without a manual cancel or Codex restart.
- Add boundary regressions plus a full external-CDP run of a representative React artifact in an independent Electron renderer with Codex-equivalent CSP; no current user Codex process is discovered or modified.

## 0.6.10 - 2026-08-13

- Apply the surface-readiness boundary to cross-surface signal fan-out as well as context, lifecycle, and appearance messages.

## 0.6.9 - 2026-08-13

- Defer all context, lifecycle-event, and appearance messages until a `srcdoc` surface has crossed its load/ready boundary.
- Prevent premature `contentWindow.postMessage` access from entering Chromium's fatal SafeBuiltins initialization path on Electron 43 and current Codex builds.
- Install the host message listener before mounting surfaces so the runtime-ready handshake cannot be missed.
- Cover the renderer-readiness boundary with a synthetic regression and validate a complete representative React artifact against an isolated real Electron CDP target.

## 0.6.8 - 2026-08-13

- Initialize the CDP Runtime and Page domains sequentially so renderer setup cannot race and terminate the Codex page target.
- Rediscover a reconstructed Codex page after an apply failure while preserving the verified debugging session, avoiding another Codex restart.
- Align the default CDP command deadline with the stable 10-second flow and include the failing method and protocol code in diagnostics.
- Add a synthetic target-crash regression that fails when `Page.enable` arrives before `Runtime.enable` completes.

## 0.6.7 - 2026-08-13

- Serialize the initial CDP WebSocket connection so concurrent domain setup commands share one transport instead of racing separate sockets.
- Reset closed CDP transports cleanly and cover concurrent `Runtime.enable` / `Page.enable` startup with a loopback simulation test.

## 0.6.6 - 2026-08-13

- Select the primary `app://-/index.html` Codex page instead of injecting into the separately exposed avatar-overlay window.
- Adopt an already running, OpenAI-signed Codex process when it has an ownership-verified loopback CDP endpoint, even if an earlier state write was interrupted.
- Persist a verified CDP session before project injection so an injection error can be retried without another Codex restart.

## 0.6.5 - 2026-08-12

- Stabilize the first macOS Apply restart by waiting for the previous signed Codex process to fully settle before relaunch.
- Launch through the existing LaunchServices application identity instead of forcing a duplicate instance, and strip inherited Node/Electron process controls from the official app environment.
- Require both the CDP endpoint and the official main process to remain stable before injection; verify that a failed experience launch has returned to a stable normal Codex process before reporting recovery.

## 0.6.4 - 2026-08-12

- Prevent Apply-triggered rebuilds from racing the preview version poll and reloading away success, errors, or restart confirmation UI.
- Return the updated preview build version from protected control responses and synchronize it before resuming automatic source-change reloads.

## 0.6.3 - 2026-08-12

- Replace the browser-native restart confirmation with an in-page preview dialog so Apply works consistently in embedded browsers and WebViews.
- Keep the restart requirement and explicit user consent visible instead of relying on a potentially suppressed `confirm()` prompt.

## 0.6.2 - 2026-08-12

- Handle CORS preflight for preview control and version endpoints across HTTP(S) loopback origins and local ports.
- Keep Apply and Restore protected by the per-process random control token while rejecting non-loopback and opaque origins.

## 0.6.1 - 2026-08-11

- Export generated Codex context snapshot, thread, status, and event types so React and Vue author code can import them safely.

## 0.6.0 - 2026-08-11

- Add permission-gated, content-free Codex context and lifecycle events for task-aware overlays.
- Add an Overlay SDK for active-task snapshots and background-task status, start, and completion subscriptions.
- Add synthetic task switching and completion controls to preview without connecting to a running Codex.
- Add renderer-selected-task detection plus an explicit, opt-in App Server WebSocket provider for lifecycle events.
- Keep endpoints explicit, disable discovery, and exclude titles, prompts, responses, working directories, and repository paths from Experience code.

## 0.5.1 - 2026-08-11

- Escape manifest display text before placing it in the privileged standalone preview shell, preventing project metadata from becoming executable preview markup.

## 0.5.0 - 2026-08-11

- Add an Electron-main `WebContentsView` host and browser-safe native command transport without exposing Electron to Experience code.
- Add `codex-experience dev --native`, project-local Electron discovery, native lifecycle/geometry bridging, navigation handling, isolated sessions, permission/download defaults, and deterministic cleanup.
- Keep ordinary browser and official-Codex CDP providers on iframe backends, expose `environment.remoteContentBackend`, and support `iframeFallbackUrl` per mount.
- Add native adapter, coordinate bridge, standalone preview, security, template, and fake-Electron verification without connecting to a running Codex.

## 0.4.1 - 2026-08-11

- Mount unrestricted remote content directly in the host-owned sibling frame instead of through an intermediate data-document wrapper.
- Remove the extra unrestricted bootstrap delay and improve compatibility with browser and Codex parent-page CSP behavior.
- Keep strict and permissive remote content inside the isolated credentialless wrapper, and disclose the unrestricted same-origin host-DOM risk explicitly.

## 0.4.0 - 2026-08-11

- Add explicit `strict`, `permissive`, and `unrestricted` remote WebView policies across reusable preview, standalone preview, direct runtime, and CDP injection.
- Require dual consent for unrestricted remote content: the project requests it and the host or CLI grants it separately.
- Expose structured remote-content risk metadata and critical warnings for host UIs while preserving permanent Node/Electron/CDP, `file:`, and `javascript:` boundaries.
- Document browser-enforced limits such as `X-Frame-Options`, CSP, CORS, popup policy, mixed-content policy, and operating-system permission prompts.

## 0.3.2 - 2026-08-11

- Fix interactive remote pages by moving the credentialless remote frame into a package-controlled sibling host instead of nesting it under the opaque Experience sandbox.
- Keep author code isolated while allowing the remote page to retain its own HTTPS origin for same-origin scripts, page storage, forms, and buttons.
- Use the same host-managed WebView bridge in standalone preview, reusable preview, and CDP injection, with integration coverage for both preview and simulated Codex paths.

## 0.3.1 - 2026-08-10

- Preserve an allowlisted remote page's own HTTPS origin inside its credentialless sandbox so application buttons and same-origin scripts remain functional.
- Keep the Experience parent origin opaque and retain the existing popup, download, device, top-navigation, credential, and referrer restrictions.

## 0.3.0 - 2026-08-10

- Add the opt-in `remote.webview` browser capability with an exact HTTPS-origin allowlist.
- Mount remote content through `window.codexExperience.webviews` inside interactive overlays instead of exposing Electron `<webview>` or raw remote iframes.
- Enforce credentialless, no-referrer frames, restricted form/script sandboxing, generated CSP, and package-boundary validation.
- Add WebView runtime, preview, package, manifest, and project-template coverage; generated projects now type-check before building.

## 0.2.1 - 2026-08-10

- Generate background and overlay as separate self-contained directories for both React and Vue.
- Give every generated surface its own component entry and private `styles.css`; the mount registry no longer imports shared surface CSS.
- Keep the default overlay visually empty while preserving an explicit component and style boundary for later interaction.

## 0.2.0 - 2026-08-10

- Make React + TypeScript the default authoring format and add Vue 3 + TypeScript through interactive `init` selection or `--framework vue`.
- Add a project-local Vite compilation adapter that emits the same self-contained Experience v1 HTML contract without requiring authors to write surface HTML.
- Generate framework components, typed browser capability declarations, semantic surface configuration, AI rules, and framework-specific dependencies.
- Verify real React and Vue bundles by executing their compiled underlay components inside the production sandbox bootstrap.
- Keep unambiguous v1 vanilla source projects buildable while making framework authoring the default for newly initialized projects.

## 0.1.2 - 2026-08-10

- Restrict `dev` watching to manifest, config, source, and asset inputs so generated output cannot trigger a rebuild/reload loop.

## 0.1.1 - 2026-08-10

- Generate shared CSS and JavaScript under `src/shared/`, while continuing to build unambiguous projects created with the legacy root paths.
- Remove the starter overlay frame so a newly initialized Experience has no decorative border by default.
- Add preview-only controls that independently show or hide underlay and overlay surfaces.

## 0.1.0 - 2026-08-10

- Introduced the Experience v1 public protocol with explicit semantic `target`, `underlay|overlay` plane, interaction mode, and sandbox permissions.
- Added `window.codexExperience`, complete Light/Dark appearance token generation, cross-surface signals, lifecycle, and declared host actions.
- Added a Node authoring toolchain with `init`, `dev`, `build`, `check`, and `pack`; initialized projects contain README, AGENTS, EXPERIENCE-BRIEF, and AI generation rules.
- Added package-owned `apply`, `appearance`, `status`, `cancel`, `install`, and `list` commands plus `CodexExperienceRuntime`; an external host is no longer required to control Codex.
- Added standalone synthetic browser preview and reusable host preview with the same runtime bootstrap as real application; the standalone toolbar can explicitly Apply or Restore through a protected package-owned loopback control.
- Added immutable built-package import and explicit development `dist/` refresh with last-good rollback.
- Added transactional official-Codex apply, partial appearance update, cancellation, session recovery, and synthetic CDP verification.
- Removed the static-template workflow and all public Theme/down/up compatibility exports. Old storage is left untouched and is not read.
