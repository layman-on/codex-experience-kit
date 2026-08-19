import type {
  ExperienceNativeWebviewBounds,
  ExperienceNativeWebviewCommand,
  ExperienceNativeWebviewTransport,
} from "../core/native-webview.js";
import type { ExperienceWebviewPolicy } from "../core/experience-project.js";
import type { ManagedWebviewSurface } from "./managed-webview-host.js";

interface NativeWebviewRect extends ExperienceNativeWebviewBounds {
  visible: boolean;
}

interface NativeWebviewEntry {
  surface: ManagedWebviewSurface;
  rect: NativeWebviewRect;
}

function requestObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function requestRect(value: unknown): NativeWebviewRect | null {
  const source = requestObject(value);
  if (!source) return null;
  const values = [source.x, source.y, source.width, source.height];
  if (!values.every(item => typeof item === "number" && Number.isFinite(item) && Math.abs(item) <= 100_000)) return null;
  const width = source.width as number;
  const height = source.height as number;
  if (width < 0 || height < 0 || typeof source.visible !== "boolean") return null;
  return { x: source.x as number, y: source.y as number, width, height, visible: source.visible };
}

function commandBase(surface: ManagedWebviewSurface, id: string) {
  return { channel: surface.channel, id, target: surface.target, plane: surface.plane } as const;
}

export interface NativeWebviewBridgeOptions {
  allowUnrestrictedRemoteContent?: boolean;
  onError?: (error: unknown, command: ExperienceNativeWebviewCommand) => void;
}

/** Converts sandboxed author-frame geometry into Electron content-view bounds. */
export class NativeWebviewBridge {
  readonly #transport: ExperienceNativeWebviewTransport;
  readonly #entries = new Map<string, NativeWebviewEntry>();
  readonly #surfaceVisibility = new WeakMap<ManagedWebviewSurface, boolean>();
  readonly #onError: ((error: unknown, command: ExperienceNativeWebviewCommand) => void) | undefined;

  constructor(
    transport: ExperienceNativeWebviewTransport,
    policy?: ExperienceWebviewPolicy,
    options: NativeWebviewBridgeOptions = {},
  ) {
    if ((policy?.securityMode ?? "strict") !== "unrestricted") {
      throw new Error("Native WebContentsView remote content requires webviews.securityMode=unrestricted");
    }
    if (!options.allowUnrestrictedRemoteContent) {
      throw new Error("Native WebContentsView remote content requires an explicit host grant");
    }
    this.#transport = transport;
    this.#onError = options.onError;
  }

  #key(surface: ManagedWebviewSurface, id: string): string {
    return `${surface.channel}:${id}`;
  }

  #dispatch(command: ExperienceNativeWebviewCommand): void {
    let result: void | Promise<void>;
    try {
      result = this.#transport.dispatch(command);
    } catch (error) {
      this.#onError?.(error, command);
      throw error;
    }
    if (result && typeof result.then === "function") {
      void result.catch(error => this.#onError?.(error, command));
    }
  }

  #layout(surface: ManagedWebviewSurface, rect: NativeWebviewRect): Pick<ExperienceNativeWebviewCommand & { op: "layout" }, "bounds" | "visible"> {
    const frameRect = surface.frame.getBoundingClientRect();
    const logicalWidth = surface.frame.clientWidth || frameRect.width || 1;
    const logicalHeight = surface.frame.clientHeight || frameRect.height || 1;
    const scaleX = frameRect.width > 0 ? frameRect.width / logicalWidth : 1;
    const scaleY = frameRect.height > 0 ? frameRect.height / logicalHeight : 1;
    const rawLeft = frameRect.left + rect.x * scaleX;
    const rawTop = frameRect.top + rect.y * scaleY;
    const rawRight = rawLeft + rect.width * scaleX;
    const rawBottom = rawTop + rect.height * scaleY;
    const left = Math.max(frameRect.left, rawLeft);
    const top = Math.max(frameRect.top, rawTop);
    const right = Math.min(frameRect.right, rawRight);
    const bottom = Math.min(frameRect.bottom, rawBottom);
    const width = Math.max(0, right - left);
    const height = Math.max(0, bottom - top);
    const view = surface.frame.ownerDocument.defaultView;
    const style = view?.getComputedStyle(surface.frame);
    const surfaceVisible = this.#surfaceVisibility.get(surface) ?? true;
    const visible = surfaceVisible
      && surface.frame.isConnected
      && !surface.frame.hidden
      && style?.display !== "none"
      && style?.visibility !== "hidden"
      && rect.visible
      && width > 0
      && height > 0;
    return {
      bounds: {
        x: Math.round(left),
        y: Math.round(top),
        width: Math.round(width),
        height: Math.round(height),
      },
      visible,
    };
  }

  handle(surface: ManagedWebviewSurface, payload: unknown): void {
    if (surface.plane !== "overlay" || surface.interaction !== "interactive") return;
    const source = requestObject(payload);
    if (!source || typeof source.id !== "string" || !/^webview-[1-9][0-9]*$/u.test(source.id)) return;
    const key = this.#key(surface, source.id);
    if (source.op === "mount") {
      const rect = requestRect(source.rect);
      if (!rect || this.#entries.has(key) || typeof source.url !== "string") return;
      const title = typeof source.title === "string" && source.title.trim() ? source.title.trim().slice(0, 100) : "Remote content";
      const layout = this.#layout(surface, rect);
      this.#entries.set(key, { surface, rect });
      this.#dispatch({ ...commandBase(surface, source.id), op: "mount", url: source.url, title, ...layout });
      return;
    }
    const entry = this.#entries.get(key);
    if (!entry || entry.surface !== surface) return;
    if (source.op === "layout") {
      const rect = requestRect(source.rect);
      if (!rect) return;
      entry.rect = rect;
      this.#dispatch({ ...commandBase(surface, source.id), op: "layout", ...this.#layout(surface, rect) });
      return;
    }
    if (source.op === "navigate" && typeof source.url === "string") {
      this.#dispatch({ ...commandBase(surface, source.id), op: "navigate", url: source.url });
      return;
    }
    if (source.op === "reload") {
      this.#dispatch({ ...commandBase(surface, source.id), op: "reload" });
      return;
    }
    if (source.op === "destroy") {
      this.#dispatch({ ...commandBase(surface, source.id), op: "destroy" });
      this.#entries.delete(key);
    }
  }

  refreshLayout(): void {
    for (const [key, entry] of this.#entries) {
      const separator = key.lastIndexOf(":");
      const id = key.slice(separator + 1);
      this.#dispatch({ ...commandBase(entry.surface, id), op: "layout", ...this.#layout(entry.surface, entry.rect) });
    }
  }

  setSurfaceVisible(surface: ManagedWebviewSurface, visible: boolean): void {
    this.#surfaceVisibility.set(surface, visible);
    for (const [key, entry] of this.#entries) {
      if (entry.surface !== surface) continue;
      const id = key.slice(key.lastIndexOf(":") + 1);
      this.#dispatch({ ...commandBase(surface, id), op: "layout", ...this.#layout(surface, entry.rect) });
    }
  }

  destroySurface(surface: ManagedWebviewSurface): void {
    for (const [key, entry] of this.#entries) {
      if (entry.surface !== surface) continue;
      const id = key.slice(key.lastIndexOf(":") + 1);
      this.#dispatch({ ...commandBase(surface, id), op: "destroy" });
      this.#entries.delete(key);
    }
  }

  destroy(): void {
    for (const [key, entry] of this.#entries) {
      const id = key.slice(key.lastIndexOf(":") + 1);
      this.#dispatch({ ...commandBase(entry.surface, id), op: "destroy" });
    }
    this.#entries.clear();
  }
}
