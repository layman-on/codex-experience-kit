import {
  buildExperienceViewHtml,
  EXPERIENCE_RUNTIME_MESSAGE,
} from "../core/experience-runtime.js";
import {
  experienceSurfaceKey,
  experienceWebviewRiskMetadata,
  type ExperienceProjectBundle,
  type ExperienceProjectPayload,
  type ExperienceSurfaceDeclaration,
  type ExperienceTarget,
  type ExperienceWebviewRiskMetadata,
} from "../core/experience-project.js";
import type { AppearanceTokenModes } from "../core/appearance-tokens.js";
import {
  cloneCodexContextEvent,
  cloneCodexContextSnapshot,
  disconnectedCodexContext,
  reduceCodexContextEvent,
  type CodexContextEvent,
  type CodexContextSnapshot,
  type CodexContextSource,
} from "../core/codex-context.js";
import type { ExperienceNativeWebviewBackend, ExperienceNativeWebviewTransport } from "../core/native-webview.js";
import { mountSyntheticCodex, type PreviewView } from "./preview.js";
import { ManagedWebviewHost, type ManagedWebviewSurface } from "./managed-webview-host.js";
import { NativeWebviewBridge } from "./native-webview-bridge.js";

export interface ExperienceProjectPreviewOptions {
  tokens: AppearanceTokenModes;
  appearance?: "light" | "dark";
  view?: PreviewView;
  sidebarVisible?: boolean;
  allowUnrestrictedRemoteContent?: boolean;
  remoteContentBackend?: "auto" | "iframe" | "native";
  nativeWebviews?: ExperienceNativeWebviewTransport;
  codexContext?: CodexContextSnapshot;
  contextSource?: CodexContextSource;
}

export interface ExperienceProjectPreviewState {
  projectId: string;
  digest: string;
  appearance: "light" | "dark";
  tokens: AppearanceTokenModes;
  readySurfaces: ExperienceSurfaceDeclaration[];
  remoteContentRisk: ExperienceWebviewRiskMetadata;
  remoteContentBackend: ExperienceNativeWebviewBackend;
  codexContext: CodexContextSnapshot;
}

export interface ExperienceProjectPreviewHandle {
  readonly root: HTMLElement;
  getState(): ExperienceProjectPreviewState;
  setTokens(tokens: AppearanceTokenModes): void;
  setAppearance(appearance: "light" | "dark"): void;
  setView(view: PreviewView): void;
  setSidebarVisible(visible: boolean): void;
  setCodexContext(snapshot: CodexContextSnapshot): void;
  emitCodexEvent(event: CodexContextEvent): void;
  destroy(): void;
}

function channel(): string {
  return globalThis.crypto?.randomUUID?.() ?? `cek-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function semanticTarget(root: HTMLElement, target: ExperienceTarget): HTMLElement | null {
  if (target === "app-shell" || target === "floating-window") return root;
  return root.querySelector<HTMLElement>(`[data-experience-target="${target}"]`);
}

function prepareUnderlayTarget(target: HTMLElement): void {
  target.style.isolation = "isolate";
  for (const child of Array.from(target.children)) {
    if (!(child instanceof target.ownerDocument.defaultView!.HTMLElement) || (child as HTMLElement).dataset.codexExperienceTarget) continue;
    const element = child as HTMLElement;
    const computed = target.ownerDocument.defaultView!.getComputedStyle(element);
    if (computed.position === "static") element.style.position = "relative";
    const z = Number.parseInt(computed.zIndex, 10);
    if (computed.zIndex === "auto" || Number.isNaN(z) || z <= 0) element.style.zIndex = "1";
  }
}

interface InteractionRegion { x: number; y: number; width: number; height: number; shape: "rect" | "rounded" | "circle"; radius: number }

function interactionRegions(payload: unknown): InteractionRegion[] | null {
  if (!payload || typeof payload !== "object" || (payload as { op?: unknown }).op !== "regions") return null;
  const source = (payload as { regions?: unknown }).regions;
  if (!Array.isArray(source) || source.length > 16) return null;
  const regions: InteractionRegion[] = [];
  for (const value of source) {
    if (!value || typeof value !== "object") return null;
    const region = value as Record<string, unknown>;
    const numbers = [region.x, region.y, region.width, region.height];
    if (!numbers.every((item) => typeof item === "number" && Number.isFinite(item) && Math.abs(item) <= 100_000)
      || (region.width as number) <= 0 || (region.height as number) <= 0) return null;
    const shape = region.shape === undefined ? "rect" : region.shape;
    if (shape !== "rect" && shape !== "rounded" && shape !== "circle") return null;
    const radius = region.radius === undefined ? 0 : region.radius;
    if (typeof radius !== "number" || !Number.isFinite(radius) || radius < 0 || radius > 100_000) return null;
    regions.push({ x: region.x as number, y: region.y as number, width: region.width as number, height: region.height as number, shape, radius });
  }
  return regions;
}

function applyInteractionRegions(frame: HTMLIFrameElement, regions: InteractionRegion[]): void {
  if (regions.length === 0) {
    frame.style.pointerEvents = "none";
    frame.style.clipPath = "inset(0 100% 100% 0)";
    return;
  }
  const path = regions.map(({ x, y, width, height, shape, radius: requestedRadius }) => {
    const left = Math.round(x * 100) / 100;
    const top = Math.round(y * 100) / 100;
    const right = Math.round((x + width) * 100) / 100;
    const bottom = Math.round((y + height) * 100) / 100;
    if (shape === "circle") {
      const radius = Math.round(Math.min(width, height) * 50) / 100;
      const centerX = Math.round((x + width / 2) * 100) / 100;
      const centerY = Math.round((y + height / 2) * 100) / 100;
      return `M ${centerX} ${centerY - radius} A ${radius} ${radius} 0 1 1 ${centerX} ${centerY + radius} A ${radius} ${radius} 0 1 1 ${centerX} ${centerY - radius} Z`;
    }
    if (shape === "rounded") {
      const radius = Math.round(Math.min(requestedRadius, width / 2, height / 2) * 100) / 100;
      return `M ${left + radius} ${top} H ${right - radius} Q ${right} ${top} ${right} ${top + radius} V ${bottom - radius} Q ${right} ${bottom} ${right - radius} ${bottom} H ${left + radius} Q ${left} ${bottom} ${left} ${bottom - radius} V ${top + radius} Q ${left} ${top} ${left + radius} ${top} Z`;
    }
    return `M ${left} ${top} H ${right} V ${bottom} H ${left} Z`;
  }).join(" ");
  frame.style.clipPath = `path("${path}")`;
  frame.style.pointerEvents = "auto";
}

function authorizedSnapshot(project: ExperienceProjectBundle, snapshot: CodexContextSnapshot): CodexContextSnapshot {
  const result = cloneCodexContextSnapshot(snapshot);
  if (project.manifest.permissions.includes("codex.context.metadata")) return result;
  for (const thread of result.threads) delete thread.displayName;
  return result;
}

function authorizedEvent(project: ExperienceProjectBundle, event: CodexContextEvent): CodexContextEvent {
  const result = cloneCodexContextEvent(event);
  if (project.manifest.permissions.includes("codex.context.metadata")) return result;
  if (result.type === "activeThreadChanged" && result.thread) delete result.thread.displayName;
  if (result.type === "threadStatusChanged") delete result.thread.displayName;
  return result;
}

export function mountExperienceProjectPreview(
  host: HTMLElement,
  project: ExperienceProjectBundle,
  options: ExperienceProjectPreviewOptions,
): ExperienceProjectPreviewHandle {
  let tokens = structuredClone(options.tokens);
  let appearance = options.appearance ?? "light";
  let codexContext = authorizedSnapshot(project, options.contextSource?.getSnapshot()
    ?? options.codexContext ?? disconnectedCodexContext("synthetic-preview"));
  const remoteContentRisk = experienceWebviewRiskMetadata(project.manifest.webviews);
  if (remoteContentRisk.requiresHostGrant && !options.allowUnrestrictedRemoteContent) {
    throw new Error("Unrestricted remote content requires allowUnrestrictedRemoteContent from the preview host");
  }
  const requestedBackend = options.remoteContentBackend ?? "auto";
  if (requestedBackend === "native" && !options.nativeWebviews) {
    throw new Error("Native remote content requires a nativeWebviews transport from an Electron host");
  }
  const useNative = Boolean(
    requestedBackend !== "iframe"
    && options.nativeWebviews
    && project.manifest.webviews?.securityMode === "unrestricted",
  );
  if (requestedBackend === "native" && project.manifest.webviews?.securityMode !== "unrestricted") {
    throw new Error("Native remote content requires webviews.securityMode=unrestricted");
  }
  const base = mountSyntheticCodex(host, tokens[appearance], options);
  const frames = new Map<string, ManagedWebviewSurface & { declaration: ExperienceSurfaceDeclaration }>();
  const nativeBridge = useNative ? new NativeWebviewBridge(options.nativeWebviews!, project.manifest.webviews, {
    allowUnrestrictedRemoteContent: options.allowUnrestrictedRemoteContent === true,
    onError(error, command) {
      host.dispatchEvent(new host.ownerDocument.defaultView!.CustomEvent("codex-experience-native-webview-error", {
        bubbles: true,
        composed: true,
        detail: { projectId: project.manifest.id, command, error },
      }));
    },
  }) : null;
  const webviews = nativeBridge ?? new ManagedWebviewHost(project.manifest.webviews, {
    allowUnrestrictedRemoteContent: options.allowUnrestrictedRemoteContent === true,
  });
  const remoteContentBackend: ExperienceNativeWebviewBackend = nativeBridge ? "electron-webcontents-view" : "iframe";
  const ready = new Set<string>();

  for (const declaration of project.surfaces) {
    const target = semanticTarget(base.root, declaration.target);
    if (!target) continue;
    if (target.ownerDocument.defaultView?.getComputedStyle(target).position === "static") target.style.position = "relative";
    const frame = target.ownerDocument.createElement("iframe");
    const id = channel();
    const key = experienceSurfaceKey(declaration);
    if (declaration.plane === "underlay") prepareUnderlayTarget(target);
    frame.dataset.codexExperienceTarget = declaration.target;
    frame.dataset.codexExperiencePlane = declaration.plane;
    frame.title = `${project.manifest.name} · ${key}`;
    frame.setAttribute("sandbox", project.manifest.permissions.includes("remote.webview") ? "allow-scripts allow-forms" : "allow-scripts");
    frame.setAttribute("aria-hidden", declaration.interaction === "passthrough" ? "true" : "false");
    Object.assign(frame.style, {
      position: "absolute", inset: "0", width: "100%", height: "100%", border: "0",
      background: "transparent", zIndex: declaration.plane === "underlay" ? "0" : declaration.target === "floating-window" ? "40" : declaration.target === "app-shell" ? "2" : "20",
      pointerEvents: declaration.plane === "overlay" && declaration.interaction === "interactive" ? "auto" : "none",
      clipPath: declaration.interaction === "scoped" ? "inset(0 100% 100% 0)" : "none",
    });
    if (declaration.plane === "overlay") frame.style.setProperty("-webkit-app-region", "no-drag");
    frame.srcdoc = buildExperienceViewHtml(project, {
      mode: "preview", target: declaration.target, plane: declaration.plane, interaction: declaration.interaction, appearance, tokens, channel: id,
      remoteContentBackend,
      codexContext,
      reducedMotion: target.ownerDocument.defaultView?.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false,
    });
    target.appendChild(frame);
    frames.set(key, {
      frame,
      owner: target,
      channel: id,
      target: declaration.target,
      plane: declaration.plane,
      interaction: declaration.interaction,
      declaration,
    });
  }

  const receive = (event: MessageEvent): void => {
    for (const [key, mounted] of frames) {
      if (event.source !== mounted.frame.contentWindow) continue;
      const data = event.data as { source?: unknown; channel?: unknown; type?: unknown; payload?: unknown };
      if (data?.source !== EXPERIENCE_RUNTIME_MESSAGE || data.channel !== mounted.channel) return;
      if (data.type === "ready") ready.add(key);
      if (data.type === "signal") {
        const rootRect = base.root.getBoundingClientRect();
        const sourceRect = mounted.frame.getBoundingClientRect();
        const payload = data.payload && typeof data.payload === "object"
          ? {
              ...data.payload,
              source: {
                target: mounted.target,
                plane: mounted.plane,
                bounds: {
                  x: sourceRect.x - rootRect.x,
                  y: sourceRect.y - rootRect.y,
                  width: sourceRect.width,
                  height: sourceRect.height,
                },
              },
            }
          : data.payload;
        broadcast("signal", payload);
      }
      if (data.type === "interaction" && mounted.interaction === "scoped") {
        const regions = interactionRegions(data.payload);
        if (regions) applyInteractionRegions(mounted.frame, regions);
      }
      if (data.type === "webview") webviews.handle(mounted, data.payload);
      if (data.type === "action") {
        host.dispatchEvent(new host.ownerDocument.defaultView!.CustomEvent("codex-experience-action", {
          bubbles: true,
          composed: true,
          detail: { projectId: project.manifest.id, target: mounted.declaration.target, plane: mounted.declaration.plane, action: data.payload },
        }));
      }
      return;
    }
  };
  host.ownerDocument.defaultView?.addEventListener("message", receive);
  const refreshNativeLayout = (): void => nativeBridge?.refreshLayout();
  host.ownerDocument.defaultView?.addEventListener("resize", refreshNativeLayout);
  host.ownerDocument.defaultView?.addEventListener("scroll", refreshNativeLayout, true);

  const broadcast = (type: "tokens" | "appearance" | "signal" | "lifecycle", payload: unknown): void => {
    for (const mounted of frames.values()) {
      mounted.frame.contentWindow?.postMessage({ source: EXPERIENCE_RUNTIME_MESSAGE, channel: mounted.channel, type, payload }, "*");
    }
  };

  const broadcastCodexContext = (): void => {
    if (!project.manifest.permissions.includes("codex.context.active")) return;
    for (const mounted of frames.values()) {
      mounted.frame.contentWindow?.postMessage({
        source: EXPERIENCE_RUNTIME_MESSAGE,
        channel: mounted.channel,
        type: "codex-context",
        payload: authorizedSnapshot(project, codexContext),
      }, "*");
    }
  };
  const emitCodexEvent = (event: CodexContextEvent): void => {
    codexContext = reduceCodexContextEvent(codexContext, event);
    broadcastCodexContext();
    if (!project.manifest.permissions.includes("codex.events.lifecycle")) return;
    for (const mounted of frames.values()) {
      mounted.frame.contentWindow?.postMessage({
        source: EXPERIENCE_RUNTIME_MESSAGE,
        channel: mounted.channel,
        type: "codex-event",
        payload: authorizedEvent(project, event),
      }, "*");
    }
  };
  const unsubscribeContext = options.contextSource?.subscribe((event, snapshot) => {
    codexContext = authorizedSnapshot(project, snapshot);
    broadcastCodexContext();
    if (!project.manifest.permissions.includes("codex.events.lifecycle")) return;
    for (const mounted of frames.values()) {
      mounted.frame.contentWindow?.postMessage({
        source: EXPERIENCE_RUNTIME_MESSAGE,
        channel: mounted.channel,
        type: "codex-event",
        payload: authorizedEvent(project, event),
      }, "*");
    }
  });

  return {
    root: base.root,
    getState() {
      return {
        projectId: project.manifest.id,
        digest: project.digest,
        appearance,
        tokens: structuredClone(tokens),
        readySurfaces: project.surfaces.filter(surface => ready.has(experienceSurfaceKey(surface))).map(surface => ({ ...surface })),
        remoteContentRisk: structuredClone(remoteContentRisk),
        remoteContentBackend,
        codexContext: cloneCodexContextSnapshot(codexContext),
      };
    },
    setTokens(next) {
      tokens = structuredClone(next);
      base.setTokens(tokens[appearance]);
      broadcast("tokens", tokens);
    },
    setAppearance(next) {
      appearance = next;
      base.setAppearance(next);
      base.setTokens(tokens[next]);
      broadcast("appearance", next);
    },
    setView(view) { base.setView(view); queueMicrotask(refreshNativeLayout); },
    setSidebarVisible(visible) { base.setSidebarVisible(visible); queueMicrotask(refreshNativeLayout); },
    setCodexContext(next) {
      codexContext = authorizedSnapshot(project, next);
      broadcastCodexContext();
    },
    emitCodexEvent,
    destroy() {
      broadcast("lifecycle", { type: "destroy" });
      host.ownerDocument.defaultView?.removeEventListener("message", receive);
      host.ownerDocument.defaultView?.removeEventListener("resize", refreshNativeLayout);
      host.ownerDocument.defaultView?.removeEventListener("scroll", refreshNativeLayout, true);
      unsubscribeContext?.();
      webviews.destroy();
      for (const mounted of frames.values()) mounted.frame.remove();
      frames.clear();
      base.destroy();
    },
  };
}

export function toExperienceProjectPayload(
  project: ExperienceProjectBundle,
  tokens: AppearanceTokenModes,
  appearance: "light" | "dark",
): ExperienceProjectPayload {
  return { ...project, tokens: structuredClone(tokens), appearance };
}
