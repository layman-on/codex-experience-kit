import { appearanceTokenCssVariables, type AppearanceTokenSet } from "../core/appearance-tokens.js";

export type PreviewView = "home" | "task";

export interface SyntheticCodexOptions {
  view?: PreviewView;
  appearance?: "light" | "dark";
  sidebarVisible?: boolean;
}

export interface SyntheticCodexHandle {
  readonly root: HTMLElement;
  setView(view: PreviewView): void;
  setAppearance(appearance: "light" | "dark"): void;
  setTokens(tokens: AppearanceTokenSet): void;
  setSidebarVisible(visible: boolean): void;
  destroy(): void;
}

const CSS = `
:host{display:block;min-width:0;contain:content}*{box-sizing:border-box}button,textarea{font:inherit}
.window{position:relative;isolation:isolate;display:grid;grid-template-columns:188px minmax(0,1fr);width:100%;height:100%;min-height:430px;overflow:hidden;border:1px solid var(--cek-outline);border-radius:14px;color:var(--cek-on-surface);background:var(--cek-background);font:13px/1.4 system-ui,sans-serif;box-shadow:0 18px 50px rgba(0,0,0,.18)}
.window[data-sidebar=false]{grid-template-columns:minmax(0,1fr)}.sidebar{position:relative;padding:16px 12px;border-right:1px solid var(--cek-outline);background:var(--cek-surface)}.sidebar[hidden]{display:none}.brand{display:flex;align-items:center;gap:8px;margin-bottom:20px;font-weight:650}.dot{width:18px;height:18px;border-radius:6px;background:var(--cek-primary)}nav{display:grid;gap:5px}nav span{padding:7px 9px;border-radius:7px;color:var(--cek-on-surface-muted)}nav span:first-child{color:var(--cek-on-surface);background:var(--cek-surface-selected)}
.main{position:relative;min-width:0;display:grid;grid-template-rows:48px 1fr auto;background:var(--cek-background)}header{display:flex;align-items:center;justify-content:space-between;padding:0 18px;border-bottom:1px solid var(--cek-outline);background:var(--cek-surface)}.header-actions{display:flex;gap:7px}.circle{width:24px;height:24px;border:1px solid var(--cek-outline);border-radius:50%;background:var(--cek-control-background)}.content{position:relative;min-height:0;overflow:hidden}.route{position:absolute;inset:0;overflow:hidden;padding:32px}.home,.thread{max-width:620px;margin:24px auto 0}.home h2{margin:10px 0 8px;font-size:28px}.home p{color:var(--cek-on-surface-muted)}.cards{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:24px}.card,.message{padding:13px;border:1px solid var(--cek-outline);border-radius:10px;background:var(--cek-surface-raised)}.card small{display:block;margin-top:5px;color:var(--cek-on-surface-muted)}.thread{display:grid;gap:13px}.message{max-width:82%}.message.user{justify-self:end;background:var(--cek-primary-container);color:var(--cek-on-primary-container)}.route[hidden]{display:none}.composer{position:relative;margin:0 auto 18px;width:min(620px,calc(100% - 42px));padding:10px;border:1px solid var(--cek-outline);border-radius:12px;background:var(--cek-surface-raised)}textarea{display:block;width:100%;height:36px;resize:none;border:0;outline:0;color:var(--cek-on-surface);background:transparent}.toolbar{display:flex;justify-content:space-between;color:var(--cek-on-surface-muted)}
`;

function element(document: Document, tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function part(node: HTMLElement, target: string): HTMLElement { node.dataset.experienceTarget = target; return node; }

export function mountSyntheticCodex(host: HTMLElement, tokens: AppearanceTokenSet, options: SyntheticCodexOptions = {}): SyntheticCodexHandle {
  const document = host.ownerDocument;
  const shadow = host.shadowRoot ?? host.attachShadow({ mode: "open" });
  shadow.replaceChildren();
  const style = document.createElement("style");
  style.textContent = CSS;
  const root = part(element(document, "section", "window"), "app-shell");
  const sidebar = part(element(document, "aside", "sidebar"), "navigation");
  const brand = element(document, "div", "brand");
  brand.append(element(document, "span", "dot"), document.createTextNode("Codex"));
  const nav = element(document, "nav", "");
  for (const label of ["New task", "Projects", "Automations", "Settings"]) nav.append(element(document, "span", "", label));
  sidebar.append(brand, nav);
  const main = part(element(document, "main", "main"), "workspace");
  const header = part(element(document, "header", ""), "titlebar");
  header.append(element(document, "strong", "", "Experience preview"));
  const actions = element(document, "div", "header-actions");
  actions.append(element(document, "span", "circle"), element(document, "span", "circle"));
  header.append(actions);
  const content = element(document, "div", "content");
  const homeRoute = part(element(document, "section", "route"), "home");
  const home = element(document, "div", "home");
  home.append(element(document, "h2", "", "What will you build today?"), element(document, "p", "", "Synthetic data only. No Codex task or account is read."));
  const cards = element(document, "div", "cards");
  for (const name of ["Aurora", "Ember"]) { const card = element(document, "div", "card", name); card.append(element(document, "small", "", "Local project")); cards.append(card); }
  home.append(cards);
  homeRoute.append(home);
  const threadRoute = part(element(document, "section", "route"), "conversation");
  const thread = element(document, "div", "thread");
  thread.append(part(element(document, "div", "message user", "Please preview this HTML experience."), "message"), part(element(document, "div", "message", "The preview uses the same Experience Runtime runtime as application."), "message"));
  threadRoute.append(thread);
  content.append(homeRoute, threadRoute);
  const composer = part(element(document, "div", "composer"), "composer");
  const textarea = document.createElement("textarea"); textarea.disabled = true; textarea.placeholder = "Ask Codex";
  composer.append(textarea, element(document, "div", "toolbar", "Local · synthetic preview"));
  main.append(header, content, composer);
  root.append(sidebar, main);
  shadow.append(style, root);
  host.dataset.experiencePreview = "experience-project";

  const setTokens = (next: AppearanceTokenSet) => {
    for (const [name, value] of Object.entries(appearanceTokenCssVariables(next))) root.style.setProperty(name, value);
  };
  const setView = (view: PreviewView) => { root.dataset.view = view; homeRoute.hidden = view !== "home"; threadRoute.hidden = view !== "task"; };
  const setAppearance = (appearance: "light" | "dark") => { root.dataset.appearance = appearance; root.style.colorScheme = appearance; };
  const setSidebarVisible = (visible: boolean) => { root.dataset.sidebar = String(visible); sidebar.hidden = !visible; };
  setTokens(tokens); setView(options.view ?? "home"); setAppearance(options.appearance ?? "light"); setSidebarVisible(options.sidebarVisible ?? true);
  return { root, setView, setAppearance, setTokens, setSidebarVisible, destroy() { shadow.replaceChildren(); delete host.dataset.experiencePreview; } };
}
