# Security model

Codex Experience Kit imports untrusted projects and controls a local debugging endpoint, so hosts must keep both boundaries narrow.

- Accept built Experience paths only from a trusted main-process file picker.
- Never accept a filesystem path, CDP URL, debugging port, or launch argument from an Electron renderer.
- Never run third-party authoring scripts from a host. Import and development mode consume only built `dist/` output.
- Keep CDP bound to loopback and do not run untrusted local software while a debugging session is active.
- Require visible confirmation before restarting Codex.
- Keep cancellation and recovery available whenever application is available.
- Keep standalone preview controls on loopback, require the per-process random token and JSON custom header, and serialize all mutations.
- Do not weaken ZIP limits, path checks, sandbox policy, ID validation, stored-content revalidation, target/plane checks, or permissions to make a project import.

Remote WebViews have three explicit modes. `strict` uses exact HTTPS origins and the full credentialless/no-referrer sandbox. `permissive` permits arbitrary HTTP/HTTPS navigation but retains the sandbox. `unrestricted` uses a direct host-owned sibling iframe in browser/CDP providers or an isolated native `WebContentsView` in an Electron host. It is intentionally critical risk: the project must request it and the host must separately pass `allowUnrestrictedRemoteContent: true` (or the CLI flag `--allow-unrestricted-remote-content`). Hosts must display the returned `remoteContentRisk` warning before granting it and must never derive consent from the manifest itself.

No remote mode gives Experience code access to Codex DOM, Node.js, Electron, CDP, the filesystem, `file:`, or `javascript:`. Iframe providers remain subject to `X-Frame-Options`/`frame-ancestors`; a native `WebContentsView` is top-level content and is therefore outside iframe-only embedding rules. It remains subject to network, page CSP, navigation validation, mixed-content policy, download/permission handlers, and operating-system prompts. Native commands are revalidated in the main process, use an in-memory partition, disable Node integration and `<webview>`, default downloads/device permissions to deny, and explicitly close WebContents on destroy.

`codex.context.active` and `codex.events.lifecycle` expose only sanitized identifiers, state flags, and timestamps. They never expose titles, prompt/response content, cwd, repository paths, credentials, raw CDP/App Server messages, or task-control methods. The App Server provider requires an explicit WebSocket URL, rejects non-loopback endpoints by default, never scans for a running server, and supports bearer authentication without placing the token in generated Experience content.

Version 0.1 accepts only Experience v1 packages. Import fails closed on manifest shape, permissions, paths, links, sizes, local resources, and surface declarations. Built HTML runs in a sandbox iframe without same-origin, host DOM, Node, Electron, CDP, filesystem, or network access. The CSP permits only compiled data/blob resources and package-local inline code.

Development mode accepts a real built directory selected by the trusted Node host. Its absolute path remains in the Node registry and is absent from renderer DTOs. Refresh performs full importer validation and never exposes a partial candidate; unlink removes the private binding without modifying the project.

Opening the standalone preview never initializes the Codex runtime. Its Apply/Restore endpoint is disabled when the preview binds to a non-loopback host, rejects requests without the token embedded in that preview process, limits request size, rebuilds before application, and accepts no filesystem path or CDP address from the browser.

The project never modifies the official Codex application bundle, `app.asar`, code signature, system ACLs, Gatekeeper, or protected installation paths.

The macOS engine verifies bundle ID `com.openai.codex`, OpenAI Team ID `2DC432GLL2`, exact executable, PID, process start time, and loopback-port owner before reuse. It never scans common ports or trusts a persisted WebSocket URL. Engine state and its ownership lock live under the Experience library so two hosts cannot silently control one session.
