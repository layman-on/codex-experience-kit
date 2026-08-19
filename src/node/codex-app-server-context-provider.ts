import WebSocket from "ws";
import { ExperienceKitError } from "../core/errors.js";
import {
  cloneCodexContextSnapshot,
  disconnectedCodexContext,
  reduceCodexContextEvent,
  type CodexContextEvent,
  type CodexContextSnapshot,
  type CodexContextThread,
  type CodexContextThreadStatus,
} from "../core/codex-context.js";
import type { CodexContextProvider } from "../service/codex-context-service.js";

export interface CodexAppServerContextProviderOptions {
  webSocketUrl: string;
  bearerToken?: string;
  allowRemote?: boolean;
  requestTimeoutMs?: number;
  subscribeLoadedThreads?: boolean;
  maxThreads?: number;
}

interface RpcMessage {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string };
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: unknown): void;
  timeout: ReturnType<typeof setTimeout>;
}

interface AppServerThread {
  id?: unknown;
  sessionId?: unknown;
  name?: unknown;
  title?: unknown;
  status?: unknown;
  updatedAt?: unknown;
}

function assertEndpoint(value: string, allowRemote: boolean): URL {
  let url: URL;
  try { url = new URL(value); }
  catch (error) { throw new ExperienceKitError("context/app-server-url", "Codex App Server WebSocket URL is invalid", { cause: error }); }
  if (url.protocol !== "ws:" && url.protocol !== "wss:") throw new ExperienceKitError("context/app-server-url", "Codex App Server endpoint must use ws:// or wss://");
  const host = url.hostname.replace(/^\[|\]$/gu, "");
  if (!allowRemote && !new Set(["127.0.0.1", "::1", "localhost"]).has(host)) {
    throw new ExperienceKitError("context/app-server-remote", "Codex App Server endpoint must be loopback unless allowRemote is explicitly enabled");
  }
  return url;
}

function status(value: unknown): CodexContextThreadStatus {
  if (!value || typeof value !== "object") return "unknown";
  const source = value as { type?: unknown; activeFlags?: unknown };
  if (source.type === "idle") return "idle";
  if (source.type === "systemError") return "failed";
  if (source.type === "notLoaded") return "unknown";
  if (source.type === "active") {
    const flags = Array.isArray(source.activeFlags) ? source.activeFlags.filter((flag): flag is string => typeof flag === "string") : [];
    if (flags.includes("waitingOnApproval")) return "waiting-approval";
    if (flags.includes("waitingOnUserInput")) return "waiting-input";
    return flags.length ? "waiting" : "working";
  }
  return "unknown";
}

function thread(value: AppServerThread): CodexContextThread | null {
  if (typeof value.id !== "string" || value.id.length < 1 || value.id.length > 256) return null;
  const updated = typeof value.updatedAt === "number" && Number.isFinite(value.updatedAt) ? Math.max(0, value.updatedAt * 1_000) : Date.now();
  return {
    threadId: value.id,
    sessionId: typeof value.sessionId === "string" && value.sessionId.length <= 256 ? value.sessionId : value.id,
    displayName: typeof value.name === "string" && value.name.trim().length <= 256
      ? value.name.trim()
      : typeof value.title === "string" && value.title.trim().length <= 256
        ? value.title.trim()
        : null,
    status: status(value.status),
    active: false,
    unread: false,
    updatedAt: updated,
  };
}

export class CodexAppServerContextProvider implements CodexContextProvider {
  readonly id = "codex-app-server";
  readonly #url: string;
  readonly #bearerToken: string | undefined;
  readonly #requestTimeoutMs: number;
  readonly #subscribeLoadedThreads: boolean;
  readonly #maxThreads: number;
  readonly #pending = new Map<number, PendingRequest>();
  #socket: WebSocket | null = null;
  #nextId = 1;
  #publish: ((event: CodexContextEvent) => void) | null = null;
  #snapshot = disconnectedCodexContext(this.id);

  constructor(options: CodexAppServerContextProviderOptions) {
    this.#url = assertEndpoint(options.webSocketUrl, options.allowRemote ?? false).href;
    this.#bearerToken = options.bearerToken;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 5_000;
    this.#subscribeLoadedThreads = options.subscribeLoadedThreads ?? true;
    this.#maxThreads = Math.max(1, Math.min(options.maxThreads ?? 200, 500));
  }

  async start(publish: (event: CodexContextEvent) => void): Promise<CodexContextSnapshot> {
    if (this.#socket) return cloneCodexContextSnapshot(this.#snapshot);
    this.#publish = publish;
    const socket = new WebSocket(this.#url, {
      perMessageDeflate: false,
      ...(this.#bearerToken ? { headers: { Authorization: `Bearer ${this.#bearerToken}` } } : {}),
    });
    socket.on("message", (source) => this.#handleMessage(source.toString()));
    socket.on("close", () => this.#handleClose());
    socket.on("error", (error) => this.#rejectPending(new ExperienceKitError("context/app-server-socket", error.message, { cause: error })));
    await new Promise<void>((resolve, reject) => {
      const opened = (): void => { cleanup(); resolve(); };
      const failed = (error: Error): void => { cleanup(); reject(new ExperienceKitError("context/app-server-connect", error.message, { cause: error })); };
      const cleanup = (): void => { socket.off("open", opened); socket.off("error", failed); };
      socket.once("open", opened);
      socket.once("error", failed);
    });
    this.#socket = socket;
    try {
      await this.#request("initialize", {
        clientInfo: { name: "codex_experience_kit", title: "Codex Experience Kit", version: "0.6.4" },
        capabilities: {
          optOutNotificationMethods: ["item/agentMessage/delta", "item/reasoning/textDelta", "item/reasoning/summaryTextDelta", "command/exec/outputDelta"],
        },
      });
      this.#notify("initialized");
      const list = await this.#request("thread/list", { limit: this.#maxThreads, useStateDbOnly: true }) as { data?: AppServerThread[] };
      const now = Date.now();
      this.#snapshot = {
        connection: { state: "connected", provider: this.id, updatedAt: now },
        activeThreadId: null,
        threads: Array.isArray(list.data) ? list.data.map(thread).filter((item): item is CodexContextThread => Boolean(item)) : [],
      };
      if (this.#subscribeLoadedThreads) await this.#subscribeToLoadedThreads();
      return cloneCodexContextSnapshot(this.#snapshot);
    } catch (error) {
      await this.stop().catch(() => undefined);
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.#publish = null;
    const socket = this.#socket;
    this.#socket = null;
    this.#rejectPending(new ExperienceKitError("context/app-server-closed", "Codex App Server context provider stopped"));
    if (socket && socket.readyState !== WebSocket.CLOSED) {
      await new Promise<void>((resolve) => { socket.once("close", resolve); socket.close(); });
    }
    this.#snapshot = disconnectedCodexContext(this.id);
  }

  async #subscribeToLoadedThreads(): Promise<void> {
    const loaded = await this.#request("thread/loaded/list", { limit: this.#maxThreads }) as { data?: unknown[] };
    if (!Array.isArray(loaded.data)) return;
    for (const threadId of loaded.data.slice(0, this.#maxThreads)) {
      if (typeof threadId !== "string") continue;
      await this.#request("thread/resume", { threadId, excludeTurns: true }).catch(() => undefined);
    }
  }

  #request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const socket = this.#socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new ExperienceKitError("context/app-server-not-open", "Codex App Server context connection is not open");
    const id = this.#nextId++;
    const result = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => { this.#pending.delete(id); reject(new ExperienceKitError("context/app-server-timeout", `${method} timed out`)); }, this.#requestTimeoutMs);
      this.#pending.set(id, { resolve, reject, timeout });
    });
    socket.send(JSON.stringify({ id, method, params }));
    return result;
  }

  #notify(method: string, params: Record<string, unknown> = {}): void {
    if (!this.#socket || this.#socket.readyState !== WebSocket.OPEN) return;
    this.#socket.send(JSON.stringify({ method, params }));
  }

  #handleMessage(source: string): void {
    let message: RpcMessage;
    try { message = JSON.parse(source) as RpcMessage; } catch { return; }
    if (typeof message.id === "number") {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      clearTimeout(pending.timeout);
      if (message.error) pending.reject(new ExperienceKitError("context/app-server-protocol", message.error.message ?? "Codex App Server request failed"));
      else pending.resolve(message.result);
      return;
    }
    if (typeof message.method === "string") this.#handleNotification(message.method, message.params);
  }

  #handleNotification(method: string, params: unknown): void {
    if (!params || typeof params !== "object") return;
    const value = params as Record<string, unknown>;
    const now = Date.now();
    let event: CodexContextEvent | null = null;
    if (method === "thread/status/changed" && typeof value.threadId === "string") {
      const previous = this.#snapshot.threads.find((candidate) => candidate.threadId === value.threadId);
      const nextStatus = status(value.status);
      const next: CodexContextThread = previous
        ? { ...previous, status: nextStatus, updatedAt: now }
        : { threadId: value.threadId, sessionId: value.threadId, status: nextStatus, active: false, unread: false, updatedAt: now };
      event = { type: "threadStatusChanged", observedAt: now, previousStatus: previous?.status ?? "unknown", thread: next };
    } else if ((method === "turn/started" || method === "turn/completed") && typeof value.threadId === "string" && value.turn && typeof value.turn === "object") {
      const turn = value.turn as { id?: unknown; status?: unknown; startedAt?: unknown; completedAt?: unknown };
      if (typeof turn.id !== "string") return;
      const known = this.#snapshot.threads.find((candidate) => candidate.threadId === value.threadId);
      if (method === "turn/started") {
        event = { type: "turnStarted", observedAt: now, threadId: value.threadId, sessionId: known?.sessionId ?? value.threadId, turnId: turn.id, startedAt: typeof turn.startedAt === "number" ? turn.startedAt * 1_000 : now };
      } else {
        const outcome = turn.status === "failed" ? "failed" : turn.status === "interrupted" ? "interrupted" : "completed";
        event = { type: "turnCompleted", observedAt: now, threadId: value.threadId, sessionId: known?.sessionId ?? value.threadId, turnId: turn.id, outcome, completedAt: typeof turn.completedAt === "number" ? turn.completedAt * 1_000 : now };
      }
    }
    if (!event) return;
    this.#snapshot = reduceCodexContextEvent(this.#snapshot, event);
    this.#publish?.(event);
  }

  #handleClose(): void {
    this.#socket = null;
    this.#rejectPending(new ExperienceKitError("context/app-server-closed", "Codex App Server context connection closed"));
    const now = Date.now();
    const event: CodexContextEvent = { type: "connectionChanged", observedAt: now, connection: { state: "disconnected", provider: this.id, updatedAt: now } };
    this.#snapshot = reduceCodexContextEvent(this.#snapshot, event);
    this.#publish?.(event);
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) { clearTimeout(pending.timeout); pending.reject(error); }
    this.#pending.clear();
  }
}
