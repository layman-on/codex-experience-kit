/**
 * Stable semantic anchors used only by the real Codex surface provider.
 *
 * The renderer selector research is derived from the Codex Dream Skin selector
 * contract, Copyright (c) 2026 Codex Dream Skin Studio contributors, MIT License:
 * https://github.com/Fei-Away/Codex-Dream-Skin/blob/6f789be4570b1d5c9e7e60545f22173195968720/tools/selectors.json
 * The complete upstream notice and license are retained in NOTICE.md.
 */
export const CODEX_SELECTORS = Object.freeze({
  shellMain: 'main:is(.main-surface, [data-app-shell-main-surface], [class*="_MainContentSurface_"])',
  leftPanel: "aside.app-shell-left-panel",
  header: 'header:is(.app-header-tint, [data-app-shell-header-edge-scroll], [class*="_Header_"])',
  home: '[data-testid="home-icon"]',
  thread: '.thread-scroll-container, [role="log"]',
  composer: '.composer-surface-chrome, [data-testid*="composer" i]',
  dialog: '[role="dialog"]',
  menu: '[role="menu"]',
  popper: '[data-radix-popper-content-wrapper]',
});
