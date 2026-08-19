# Migrating from `codex-theme-kit`

`codex-theme-kit` is deprecated and replaced by `codex-experience-kit`.
The replacement keeps the same sandbox-first design, but it is not a drop-in
package rename: the project format, semantic placement vocabulary, browser API,
and public TypeScript names changed as the runtime expanded beyond themes.

## 1. Install the replacement

```bash
npm remove codex-theme-kit
npm install --save-exact codex-experience-kit@0.6.12
```

For a new authoring project, initialize a React project by default or select Vue:

```bash
npx codex-experience-kit init ./example-experience
# or: npx codex-experience-kit init ./example-experience --framework vue
cd example-experience
npm install
npm run dev
```

Do not copy an old `theme.manifest.json` and `index.html` directly into the new
runtime. Create an Experience project, move the visual code into its surface
components and CSS, then declare placement in `experience.config.json`.

## 2. Rename project concepts

| Theme Kit | Experience Kit |
| --- | --- |
| `theme.manifest.json` | `experience.manifest.json` |
| `<codex-theme-surface>` | component registered by `plane:target` |
| `name` | `target` |
| `layer: down` | `plane: underlay` |
| `layer: up` | `plane: overlay` |
| `window.codexTheme` | `window.codexExperience` |
| `theme.tokens` | `appearance.tokens` |
| `theme.actions` | `host.actions` |

Surface targets map as follows:

| Theme surface | Experience target |
| --- | --- |
| `root` | `app-shell` |
| `sidebar` | `navigation` |
| `header` | `titlebar` |
| `main` | `workspace` |
| `home` | `home` |
| `thread` | `conversation` |
| `composer` | `composer` |
| `dialog` | `modal` |

An old `interactive` upper surface can remain `interactive`, but prefer the new
`scoped` mode when only specific controls should receive pointer events. Register
those controls through `window.codexExperience.interaction.register(...)` so the
rest of the overlay remains click-through.

## 3. Move author code

An old surface such as:

```html
<codex-theme-surface name="root" layer="down" interaction="passthrough">
  <div class="experience-background"></div>
</codex-theme-surface>
```

becomes an authoring declaration:

```json
{
  "authoring": {
    "framework": "react",
    "entry": "main.tsx",
    "surfaces": [
      {
        "target": "app-shell",
        "plane": "underlay",
        "interaction": "passthrough"
      }
    ]
  }
}
```

Register the matching component under the same key in `src/main.tsx`:

```tsx
const components: Record<string, ComponentType> = {
  "underlay:app-shell": AppBackground,
};
```

Keep each surface in its own directory with its own CSS. Run `npm run build` to
compile the framework project into the fixed `dist/` runtime contract; import or
link that built output rather than the Node project root.

## 4. Rename public APIs

| `codex-theme-kit` | `codex-experience-kit` |
| --- | --- |
| `ThemeBrowserEngine` | `ExperienceEngine` |
| `ThemeProjectLibrary` | `ExperienceProjectLibrary` |
| `ThemeDevelopmentRegistry` | `ExperienceDevelopmentRegistry` |
| `ThemeProjectCdpTarget` | `ExperienceProjectCdpTarget` |
| `mountThemeProjectPreview` | `mountExperienceProjectPreview` |
| `toThemeProjectPayload` | `toExperienceProjectPayload` |
| `generateThemeTokens` | `generateAppearanceTokens` |
| `themeTokenCssVariables` | `appearanceTokenCssVariables` |
| `ThemeTokenModes` | `AppearanceTokenModes` |
| `readCodexThemeAiGuide` | `readExperienceAiGuide` |
| `DREAM_SKIN_GALLERY_URL` | `EXPERIENCE_GALLERY_URL` |

The core engine workflow remains recognizable:

```ts
import { ExperienceEngine } from "codex-experience-kit/node";
import { generateAppearanceTokens } from "codex-experience-kit/utils";

const engine = new ExperienceEngine({ libraryPath });
await engine.initialize();

const installed = await engine.importProject({ kind: "zip", path: zipPath });
const plan = await engine.planApply(installed.id);

await engine.applyProject(installed.id, {
  tokens: generateAppearanceTokens({ seed: "#6750A4" }).modes,
  appearance: "light",
  allowRestart: plan.requiresRestart,
});

await engine.cancelProject();
await engine.shutdown({ mode: "preserve" });
```

`planApply`, `applyProject`, `refreshDevelopmentProject`, `patchTokens`,
`cancelProject`, and immutable import keep equivalent roles. Experience Kit also
adds `patchAppearance`, direct project build/apply commands, task context and
lifecycle events, managed remote content, floating windows, and isolated Codex
instance actions.

## 5. Migrate preview code

```ts
import { mountExperienceProjectPreview } from "codex-experience-kit/preview";
import { generateAppearanceTokens } from "codex-experience-kit/utils";

const preview = mountExperienceProjectPreview(host, project, {
  tokens: generateAppearanceTokens({ seed: "#6750A4" }).modes,
  appearance: "light",
  view: "task",
});

preview.setAppearance("dark");
preview.destroy();
```

Synthetic preview remains isolated from the user's Codex. Real application
still requires an explicit Apply operation and explicit restart consent when the
first CDP connection needs it.

## 6. Storage and rollout

Theme Kit and Experience Kit use separate storage namespaces. Existing installed
themes and development links are not migrated automatically. Build the new
Experience, import or link its `dist/`, preview it, and only then cancel the old
theme and apply the replacement.

Recommended rollout checklist:

1. Create the new Experience project.
2. Map every old surface and permission using the tables above.
3. Verify Light and Dark appearance in synthetic preview.
4. Verify click-through and scoped interaction.
5. Build and validate with `npm run check`.
6. Apply explicitly, then confirm `npm run status` and `npm run cancel`.

See the [main README](../README.md), [project format](experience-format.md), and
[runtime contract](experience-runtime-v1.zh-CN.md) for the complete replacement
API.
