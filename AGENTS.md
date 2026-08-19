# Codex Experience Kit maintenance rules

- Keep `src/core` free of Node and Electron APIs.
- Keep filesystem, ZIP, CLI control, official-Codex verification, and CDP code under `src/node` or `src/cli.ts`.
- The npm package and CLI must apply, patch, refresh, inspect, and cancel an Experience without an external host. A graphical host is optional only.
- Preview code must render synthetic data and must never connect to Codex.
- Production CDP targets require an explicit WebSocket URL. Never discover or connect to a user's running Codex process in automated tests.
- Validate imported paths, file sizes, manifests, local assets, HTML, permissions, and surface placement at the Node boundary.
- Real-Codex apply, refresh, appearance patching, and cancellation are transactional. Preserve or restore the last valid runtime on failure.
- Never restart Codex from a direct command unless the user passed `--allow-restart` for that operation.
- Run `npm run check`, `npm run test:simulation`, and `npm run pack:check` before completing a change.
- Keep `README.md`, `docs/architecture.md`, and optional-host integration documents aligned with public exports and CLI commands.
