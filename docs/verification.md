# Verification

Run:

```bash
npm run check
npm run test:simulation
npm run pack:check
```

The suite covers manifest and surface validation, explicit target/plane placement, enforced underlay passthrough, scoped overlay region registration and disjoint host hit testing, appearance generation, asset compilation, legacy rejection, immutable import, explicit development refresh, project init/build/check/pack, standalone browser/native preview, protected preview Apply/Restore controls, preview-only secondary-account settings and transfer selection, proof that preview controls do not enter `dist`, multi-instance discovery/selection/connected marking, synthetic task switching/background completion, sanitized context-service validation, explicit-endpoint App Server lifecycle mapping, strict/permissive/unrestricted WebView policy and dual consent, native coordinate/visibility translation, fake-Electron `WebContentsView` lifecycle and security defaults, primary-renderer CDP ranking, safe loopback-session adoption, pre-injection session persistence, target-specific sanitized macOS relaunch arguments, direct package apply/restart consent/hot refresh/appearance/cancel, embedded synthetic preview, CDP apply/probe/patch/context/cancel, pending route targets, rollback, and engine lifecycle.

The regular suite uses a synthetic DOM, WebSocket CDP server, or simulated App Server endpoint. It verifies the staged host/document/child boundary, flattened child sessions, root-surface ready handshakes, cancellation, and recovery without discovering or modifying the user's running Codex.

For the renderer boundary, the repository also includes `node scripts/electron-cdp-experience-probe.mjs` after `npm run build`. It launches a separate Electron process with an isolated profile and Codex-equivalent parent CSP, loads a caller-supplied compiled Experience artifact, drives the real CDP WebSocket protocol, verifies apply/probe/cancel, and reports CSP violations. Set `CODEX_EXPERIENCE_ELECTRON=/absolute/path/to/electron` and `CODEX_EXPERIENCE_PROJECT=/absolute/path/to/dist` to choose the isolated Electron executable and built Experience directory, without starting Codex. This is stronger than the simulation but is still not evidence that a particular official Codex build has been mutated; that final acceptance check must be explicitly authorized and reported separately.

Preview-control tests inject a fake runtime. Fetching the preview must not create a runtime; control requests require the per-process token and assert only against the fake implementation.
