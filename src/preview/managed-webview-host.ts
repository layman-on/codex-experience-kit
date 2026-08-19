import type {
  ExperiencePlane,
  ExperienceSurfaceInteraction,
  ExperienceTarget,
  ExperienceWebviewPolicy,
} from "../core/experience-project.js";

export interface ManagedWebviewSurface {
  frame: HTMLIFrameElement;
  owner: HTMLElement;
  channel: string;
  target: ExperienceTarget;
  plane: ExperiencePlane;
  interaction: ExperienceSurfaceInteraction;
}

interface ManagedWebviewRect {
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean;
}

interface ManagedWebviewEntry {
  frame: HTMLIFrameElement;
  surface: ManagedWebviewSurface;
  url: string;
  title: string;
}

function html(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function requestObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function requestRect(value: unknown): ManagedWebviewRect | null {
  const source = requestObject(value);
  if (!source) return null;
  const values = [source.x, source.y, source.width, source.height];
  if (!values.every(item => typeof item === "number" && Number.isFinite(item) && Math.abs(item) <= 100_000)) return null;
  const x = source.x as number;
  const y = source.y as number;
  const width = source.width as number;
  const height = source.height as number;
  if (width < 0 || height < 0 || typeof source.visible !== "boolean") return null;
  return { x, y, width, height, visible: source.visible };
}

export class ManagedWebviewHost {
  readonly #policy: ExperienceWebviewPolicy;
  readonly #allowedOrigins: Set<string>;
  readonly #entries = new Map<string, ManagedWebviewEntry>();
  readonly #allowUnrestrictedRemoteContent: boolean;

  constructor(policy?: ExperienceWebviewPolicy, options: { allowUnrestrictedRemoteContent?: boolean } = {}) {
    this.#policy = { ...(policy ?? { allowedOrigins: [] }), securityMode: policy?.securityMode ?? "strict" };
    this.#allowedOrigins = new Set(this.#policy.allowedOrigins ?? []);
    this.#allowUnrestrictedRemoteContent = options.allowUnrestrictedRemoteContent ?? false;
  }

  #key(surface: ManagedWebviewSurface, id: string): string {
    return `${surface.channel}:${id}`;
  }

  #url(value: unknown): string {
    if (typeof value !== "string" || value.length < 1 || value.length > 2_048) throw new Error("Managed WebView URL is invalid");
    const url = new URL(value);
    const supported = url.protocol === "https:" || (this.#policy.securityMode !== "strict" && url.protocol === "http:");
    if (!supported || url.username || url.password || (this.#policy.securityMode === "strict" && !this.#allowedOrigins.has(url.origin))) {
      throw new Error("Managed WebView URL is not allowed by the project security policy");
    }
    return url.href;
  }

  #document(url: string, title: string): string {
    const frameSource = this.#policy.securityMode === "strict"
      ? [...this.#allowedOrigins].join(" ") || "'none'"
      : "https: http:";
    const attributes = this.#policy.securityMode === "unrestricted"
      ? 'loading="eager" allow="camera *; microphone *; geolocation *; clipboard-read *; clipboard-write *; fullscreen *"'
      : 'sandbox="allow-scripts allow-forms allow-same-origin" referrerpolicy="no-referrer" loading="eager" allow="" credentialless';
    return `<!doctype html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; object-src 'none'; frame-src ${html(frameSource)}; style-src 'unsafe-inline'"><style>html,body,iframe{box-sizing:border-box;width:100%;height:100%;margin:0;border:0;overflow:hidden;background:transparent}</style></head><body><iframe title="${html(title)}" src="${html(url)}" ${attributes}></iframe></body></html>`;
  }

  #documentUrl(url: string, title: string): string {
    return `data:text/html;charset=utf-8,${encodeURIComponent(this.#document(url, title))}`;
  }

  #frameSource(url: string, title: string): string {
    return this.#policy.securityMode === "unrestricted" ? url : this.#documentUrl(url, title);
  }

  #layout(entry: ManagedWebviewEntry, rect: ManagedWebviewRect): void {
    Object.assign(entry.frame.style, {
      left: `${rect.x}px`,
      top: `${rect.y}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    });
    entry.frame.hidden = !rect.visible || rect.width === 0 || rect.height === 0 || entry.surface.frame.hidden;
  }

  handle(surface: ManagedWebviewSurface, payload: unknown): void {
    if (surface.plane !== "overlay" || surface.interaction !== "interactive") return;
    const source = requestObject(payload);
    if (!source || typeof source.id !== "string" || !/^webview-[1-9][0-9]*$/u.test(source.id)) return;
    const key = this.#key(surface, source.id);
    const operation = source.op;
    if (operation === "mount") {
      const rect = requestRect(source.rect);
      if (!rect || this.#entries.has(key)) return;
      const url = this.#url(source.url);
      const title = typeof source.title === "string" && source.title.trim() ? source.title.trim().slice(0, 100) : "Remote content";
      if (this.#policy.securityMode === "unrestricted" && !this.#allowUnrestrictedRemoteContent) {
        throw new Error("Unrestricted remote content requires an explicit host grant");
      }
      const supportProbe = surface.owner.ownerDocument.createElement("iframe");
      if (this.#policy.securityMode !== "unrestricted" && !("credentialless" in supportProbe)) {
        throw new Error("Credentialless WebView frames are not supported by this browser");
      }
      const frame = surface.owner.ownerDocument.createElement("iframe");
      frame.dataset.codexExperienceWebviewHost = source.id;
      frame.dataset.codexExperienceTarget = surface.target;
      frame.dataset.codexExperiencePlane = surface.plane;
      frame.title = title;
      if (this.#policy.securityMode !== "unrestricted") {
        frame.setAttribute("sandbox", "allow-scripts allow-forms allow-same-origin");
        frame.setAttribute("referrerpolicy", "no-referrer");
      } else {
        frame.setAttribute("allow", "camera *; microphone *; geolocation *; clipboard-read *; clipboard-write *; fullscreen *");
      }
      Object.assign(frame.style, {
        position: surface.frame.style.position,
        border: "0",
        background: "transparent",
        overflow: "hidden",
        pointerEvents: "auto",
        zIndex: String((Number.parseInt(surface.frame.style.zIndex, 10) || 0) + 1),
      });
      const entry = { frame, surface, url, title };
      frame.src = this.#frameSource(url, title);
      surface.owner.appendChild(frame);
      this.#entries.set(key, entry);
      this.#layout(entry, rect);
      return;
    }
    const entry = this.#entries.get(key);
    if (!entry || entry.surface !== surface) return;
    if (operation === "layout") {
      const rect = requestRect(source.rect);
      if (rect) this.#layout(entry, rect);
      return;
    }
    if (operation === "navigate") {
      entry.url = this.#url(source.url);
      entry.frame.src = this.#frameSource(entry.url, entry.title);
      return;
    }
    if (operation === "reload") {
      entry.frame.src = this.#frameSource(entry.url, entry.title);
      return;
    }
    if (operation === "destroy") {
      entry.frame.remove();
      this.#entries.delete(key);
    }
  }

  setSurfaceVisible(surface: ManagedWebviewSurface, visible: boolean): void {
    for (const entry of this.#entries.values()) {
      if (entry.surface === surface) entry.frame.hidden = !visible;
    }
  }

  destroySurface(surface: ManagedWebviewSurface): void {
    for (const [key, entry] of this.#entries) {
      if (entry.surface !== surface) continue;
      entry.frame.remove();
      this.#entries.delete(key);
    }
  }

  destroy(): void {
    for (const entry of this.#entries.values()) entry.frame.remove();
    this.#entries.clear();
  }
}
