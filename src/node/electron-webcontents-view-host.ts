import { randomUUID } from "node:crypto";
import {
  EXPERIENCE_PLANES,
  EXPERIENCE_TARGETS,
  type ExperienceWebviewPolicy,
} from "../core/experience-project.js";
import type {
  ExperienceNativeWebviewBounds,
  ExperienceNativeWebviewCommand,
  ExperienceNativeWebviewTransport,
} from "../core/native-webview.js";

interface ElectronEventLike {
  preventDefault(): void;
}

interface ElectronSessionLike {
  setPermissionRequestHandler?(handler: (
    webContents: ElectronWebContentsLike,
    permission: string,
    callback: (allowed: boolean) => void,
    details: unknown,
  ) => void): void;
  setPermissionCheckHandler?(handler: (
    webContents: ElectronWebContentsLike | null,
    permission: string,
    requestingOrigin: string,
    details: unknown,
  ) => boolean): void;
  on?(event: "will-download", listener: (event: ElectronEventLike, item: unknown, webContents: ElectronWebContentsLike) => void): void;
}

interface ElectronWebContentsLike {
  readonly session?: ElectronSessionLike;
  loadURL(url: string): Promise<unknown>;
  reload(): void;
  close?(): void;
  destroy?(): void;
  on?(event: string, listener: (...args: any[]) => void): void;
  setWindowOpenHandler?(handler: (details: { url: string }) => { action: "allow" | "deny" }): void;
}

export interface ElectronWebContentsViewLike {
  readonly webContents: ElectronWebContentsLike;
  setBounds(bounds: ExperienceNativeWebviewBounds): void;
}

export interface ElectronContentViewLike {
  addChildView(view: ElectronWebContentsViewLike): void;
  removeChildView(view: ElectronWebContentsViewLike): void;
}

export interface ElectronWebContentsViewConstructor {
  new(options: { webPreferences: Record<string, unknown> }): ElectronWebContentsViewLike;
}

export type ElectronNativeWindowOpenDecision = "same-view" | "external" | "deny";

export interface ElectronWebContentsViewHostStatus {
  type: "mounted" | "navigated" | "load-failed" | "destroyed";
  key: string;
  url?: string;
  errorCode?: number;
  errorDescription?: string;
}

export interface ElectronWebContentsViewHostOptions {
  WebContentsView: ElectronWebContentsViewConstructor;
  contentView: ElectronContentViewLike;
  policy?: ExperienceWebviewPolicy;
  allowUnrestrictedRemoteContent?: boolean;
  partition?: string;
  onWindowOpen?: (url: string) => ElectronNativeWindowOpenDecision;
  openExternal?: (url: string) => void | Promise<void>;
  allowPermission?: (permission: string, details: unknown) => boolean;
  allowDownload?: (item: unknown) => boolean;
  onStatus?: (status: ElectronWebContentsViewHostStatus) => void;
}

interface NativeEntry {
  view: ElectronWebContentsViewLike;
  url: string;
  attached: boolean;
}

const COMMAND_ID = /^webview-[1-9][0-9]*$/u;
const COMMAND_CHANNEL = /^[A-Za-z0-9._:-]{1,160}$/u;

function commandObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Native WebView command must be an object");
  return value as Record<string, unknown>;
}

function commandIdentity(command: Record<string, unknown>): { key: string; id: string } {
  if (typeof command.channel !== "string" || !COMMAND_CHANNEL.test(command.channel)) throw new Error("Native WebView channel is invalid");
  if (typeof command.id !== "string" || !COMMAND_ID.test(command.id)) throw new Error("Native WebView id is invalid");
  if (!EXPERIENCE_TARGETS.includes(command.target as never) || !EXPERIENCE_PLANES.includes(command.plane as never)) {
    throw new Error("Native WebView surface is invalid");
  }
  if (command.plane !== "overlay") throw new Error("Native WebViews are available only on overlay surfaces");
  return { key: `${command.channel}:${command.id}`, id: command.id };
}

function bounds(value: unknown): ExperienceNativeWebviewBounds {
  const source = commandObject(value);
  const values = [source.x, source.y, source.width, source.height];
  if (!values.every(item => typeof item === "number" && Number.isInteger(item) && Math.abs(item) <= 100_000)) {
    throw new Error("Native WebView bounds are invalid");
  }
  if ((source.width as number) < 0 || (source.height as number) < 0) throw new Error("Native WebView bounds cannot be negative");
  return { x: source.x as number, y: source.y as number, width: source.width as number, height: source.height as number };
}

function title(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 100) : "Remote content";
}

/**
 * Electron-main implementation of the native remote-content transport.
 * The host deliberately accepts only the explicitly granted unrestricted mode:
 * strict/permissive iframe modes promise credentialless isolation that a native
 * top-level WebContents cannot reproduce exactly.
 */
export class ElectronWebContentsViewHost implements ExperienceNativeWebviewTransport {
  readonly backend = "electron-webcontents-view" as const;
  readonly #View: ElectronWebContentsViewConstructor;
  readonly #contentView: ElectronContentViewLike;
  readonly #options: ElectronWebContentsViewHostOptions;
  readonly #entries = new Map<string, NativeEntry>();
  readonly #configuredSessions = new WeakSet<object>();
  readonly #partition: string;
  #queue: Promise<void> = Promise.resolve();
  #destroyed = false;

  constructor(options: ElectronWebContentsViewHostOptions) {
    if ((options.policy?.securityMode ?? "strict") !== "unrestricted") {
      throw new Error("Electron WebContentsView requires webviews.securityMode=unrestricted");
    }
    if (!options.allowUnrestrictedRemoteContent) {
      throw new Error("Electron WebContentsView requires an explicit unrestricted remote-content grant");
    }
    if (options.partition !== undefined && (!/^[A-Za-z0-9._:-]{1,160}$/u.test(options.partition) || options.partition.startsWith("persist:"))) {
      throw new Error("Native WebView partition must be a non-persistent partition name");
    }
    this.#View = options.WebContentsView;
    this.#contentView = options.contentView;
    this.#options = options;
    this.#partition = options.partition ?? `codex-experience-${randomUUID()}`;
  }

  #url(value: unknown): string {
    if (typeof value !== "string" || value.length < 1 || value.length > 2_048) throw new Error("Native WebView URL is invalid");
    let url: URL;
    try { url = new URL(value); } catch (error) { throw new Error("Native WebView URL must be absolute", { cause: error }); }
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) {
      throw new Error("Native WebView URL is not allowed by the project security policy");
    }
    return url.href;
  }

  #setVisible(entry: NativeEntry, nextBounds: ExperienceNativeWebviewBounds, visible: boolean): void {
    const shouldAttach = visible && nextBounds.width > 0 && nextBounds.height > 0;
    if (shouldAttach && !entry.attached) {
      this.#contentView.addChildView(entry.view);
      entry.attached = true;
    }
    if (shouldAttach) entry.view.setBounds(nextBounds);
    if (!shouldAttach && entry.attached) {
      this.#contentView.removeChildView(entry.view);
      entry.attached = false;
    }
  }

  #configureSession(session: ElectronSessionLike | undefined): void {
    if (!session || this.#configuredSessions.has(session as object)) return;
    this.#configuredSessions.add(session as object);
    session.setPermissionRequestHandler?.((_webContents, permission, callback, details) => {
      let allowed = false;
      try { allowed = this.#options.allowPermission?.(permission, details) === true; } catch { allowed = false; }
      callback(allowed);
    });
    session.setPermissionCheckHandler?.((_webContents, permission, _origin, details) => {
      try { return this.#options.allowPermission?.(permission, details) === true; } catch { return false; }
    });
    session.on?.("will-download", (event, item) => {
      let allowed = false;
      try { allowed = this.#options.allowDownload?.(item) === true; } catch { allowed = false; }
      if (!allowed) event.preventDefault();
    });
  }

  #wire(key: string, entry: NativeEntry): void {
    const contents = entry.view.webContents;
    this.#configureSession(contents.session);
    const validateNavigation = (event: ElectronEventLike, input: unknown): void => {
      try {
        const destination = typeof input === "string" ? input : commandObject(input).url;
        this.#url(destination);
      } catch { event.preventDefault(); }
    };
    contents.on?.("will-navigate", validateNavigation);
    contents.on?.("will-frame-navigate", validateNavigation);
    contents.on?.("did-fail-load", (_event: unknown, errorCode: number, errorDescription: string, validatedURL: string, isMainFrame = true) => {
      if (!isMainFrame) return;
      this.#options.onStatus?.({ type: "load-failed", key, url: validatedURL, errorCode, errorDescription });
    });
    contents.setWindowOpenHandler?.(({ url }) => {
      let validated: string;
      try { validated = this.#url(url); } catch { return { action: "deny" }; }
      const decision = this.#options.onWindowOpen?.(validated) ?? "same-view";
      if (decision === "same-view") {
        queueMicrotask(() => { void contents.loadURL(validated).catch(() => undefined); });
      } else if (decision === "external") {
        queueMicrotask(() => { void Promise.resolve(this.#options.openExternal?.(validated)).catch(() => undefined); });
      }
      return { action: "deny" };
    });
  }

  async #execute(rawCommand: ExperienceNativeWebviewCommand): Promise<void> {
    if (this.#destroyed) throw new Error("Electron WebContentsView host has been destroyed");
    const command = commandObject(rawCommand);
    const { key } = commandIdentity(command);
    if (command.op !== "mount" && command.op !== "layout" && command.op !== "navigate" && command.op !== "reload" && command.op !== "destroy") {
      throw new Error("Native WebView operation is invalid");
    }
    if (command.op === "mount") {
      if (this.#entries.has(key)) throw new Error("Native WebView is already mounted");
      const url = this.#url(command.url);
      title(command.title);
      if (typeof command.visible !== "boolean") throw new Error("Native WebView visibility is invalid");
      const view = new this.#View({
        webPreferences: {
          partition: this.#partition,
          nodeIntegration: false,
          nodeIntegrationInWorker: false,
          nodeIntegrationInSubFrames: false,
          contextIsolation: true,
          sandbox: true,
          webSecurity: true,
          allowRunningInsecureContent: false,
          webviewTag: false,
          spellcheck: false,
        },
      });
      const entry: NativeEntry = { view, url, attached: false };
      this.#entries.set(key, entry);
      this.#wire(key, entry);
      this.#setVisible(entry, bounds(command.bounds), command.visible === true);
      try {
        await view.webContents.loadURL(url);
        this.#options.onStatus?.({ type: "mounted", key, url });
      } catch (error) {
        this.#destroyEntry(key, entry);
        throw error;
      }
      return;
    }
    const entry = this.#entries.get(key);
    if (!entry) return;
    if (command.op === "layout") {
      if (typeof command.visible !== "boolean") throw new Error("Native WebView visibility is invalid");
      this.#setVisible(entry, bounds(command.bounds), command.visible === true);
      return;
    }
    if (command.op === "navigate") {
      entry.url = this.#url(command.url);
      await entry.view.webContents.loadURL(entry.url);
      this.#options.onStatus?.({ type: "navigated", key, url: entry.url });
      return;
    }
    if (command.op === "reload") {
      entry.view.webContents.reload();
      return;
    }
    if (command.op === "destroy") this.#destroyEntry(key, entry);
  }

  #destroyEntry(key: string, entry: NativeEntry): void {
    if (entry.attached) {
      this.#contentView.removeChildView(entry.view);
      entry.attached = false;
    }
    entry.view.webContents.close?.();
    if (!entry.view.webContents.close) entry.view.webContents.destroy?.();
    this.#entries.delete(key);
    this.#options.onStatus?.({ type: "destroyed", key });
  }

  dispatch(command: ExperienceNativeWebviewCommand): Promise<void> {
    const operation = this.#queue.then(() => this.#execute(command));
    this.#queue = operation.catch(() => undefined);
    return operation;
  }

  async destroy(): Promise<void> {
    if (this.#destroyed) return;
    await this.#queue.catch(() => undefined);
    this.#destroyed = true;
    for (const [key, entry] of this.#entries) this.#destroyEntry(key, entry);
  }
}
