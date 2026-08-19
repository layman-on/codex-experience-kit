# Task-aware React example

This is a complete, deliberately small Codex Experience. It demonstrates:

- an `underlay:app-shell` surface that decorates only the window edges;
- an `overlay:app-shell` surface whose registered controls receive clicks while the rest remains pointer-passthrough;
- Light and Dark styling derived from the Kit's `--cek-*` appearance tokens;
- sanitized selected-task context and lifecycle events;
- React components compiled into the fixed sandboxed Experience runtime.

It does not use remote content, host actions, account migration, Codex DOM access, or personal data.

## Run the synthetic preview

First build the Kit from the repository root:

```bash
npm install
npm run build
```

Then run the example:

```bash
cd example
npm install
npm run dev
```

Use the preview toolbar to switch synthetic tasks, complete a background task, toggle Light/Dark with one appearance button, and show or hide each plane. The leftmost settings gear opens the preview-only secondary-account manager: it can reopen the fixed isolated Codex account or scan transferable capabilities, configuration, and optionally selected conversations before opening it. Configuration items default on; conversations default off and remain selectable by project group or individual task.

The complete top header—including `Settings`, target selection, synthetic controls, Apply, and Restore—is owned by the Kit preview shell. It is not a surface and is never compiled into or applied with this example. Only the background and task-status surfaces declared under `authoring.surfaces` enter `dist/`.

The preview does not connect to Codex unless you explicitly use a real control. If several Codex instances are running, the target selector lists all of them and labels the instance already connected to the Kit.

## Validate without applying

From the repository root:

```bash
npm run example:check
```

This typechecks, builds, and validates the example. It does not discover, restart, or modify Codex.

## Apply explicitly

Only when you intend to modify your running Codex:

```bash
npm run targets
npm run apply
```

With multiple instances, run `npm run apply -- --target <instance-id>`. The first CDP connection for that selected instance may require a user-confirmed restart by adding `--allow-restart`; other Codex instances remain open. Use `npm run cancel` to restore the connected instance's official view.
