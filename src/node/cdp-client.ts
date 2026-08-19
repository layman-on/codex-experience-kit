import WebSocket from "ws";
import { ExperienceKitError } from "../core/errors.js";

interface CdpResponse {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  sessionId?: string;
  result?: unknown;
  error?: { code?: number; message?: string };
}

export interface CdpEvent {
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}

export type CdpEventListener = (event: CdpEvent) => void;

interface PendingCall {
  method: string;
  resolve(value: unknown): void;
  reject(error: unknown): void;
  timeout: ReturnType<typeof setTimeout>;
  cleanupAbort(): void;
}

export interface CdpClientOptions {
  requestTimeoutMs?: number;
  allowRemote?: boolean;
}

function assertEndpoint(webSocketUrl: string, allowRemote: boolean): void {
  let url: URL;
  try {
    url = new URL(webSocketUrl);
  } catch (error) {
    throw new ExperienceKitError("cdp/url", "CDP WebSocket URL is invalid", { cause: error });
  }
  if (!new Set(["ws:", "wss:"]).has(url.protocol)) throw new ExperienceKitError("cdp/url", "CDP endpoint must use ws:// or wss://");
  const host = url.hostname.replace(/^\[|\]$/gu, "");
  if (!allowRemote && !new Set(["127.0.0.1", "::1", "localhost"]).has(host)) {
    throw new ExperienceKitError("cdp/remote", "CDP endpoint must be loopback unless allowRemote is explicitly enabled");
  }
}

export class CdpClient {
  private socket: WebSocket | null = null;
  private connectPromise: Promise<void> | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingCall>();
  private readonly listeners = new Map<string, Set<CdpEventListener>>();
  private readonly requestTimeoutMs: number;

  constructor(
    public readonly webSocketUrl: string,
    options: CdpClientOptions = {},
  ) {
    assertEndpoint(webSocketUrl, options.allowRemote ?? false);
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
  }

  async connect(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) return;
    if (this.connectPromise) return await this.connectPromise;

    const operation = this.openSocket();
    this.connectPromise = operation;
    try {
      await operation;
    } finally {
      if (this.connectPromise === operation) this.connectPromise = null;
    }
  }

  private async openSocket(): Promise<void> {
    const socket = new WebSocket(this.webSocketUrl, { perMessageDeflate: false });
    await new Promise<void>((resolve, reject) => {
      const onOpen = (): void => {
        cleanup();
        resolve();
      };
      const onError = (error: Error): void => {
        cleanup();
        reject(new ExperienceKitError("cdp/connect", `Unable to connect to CDP: ${error.message}`, { cause: error }));
      };
      const onClose = (): void => {
        cleanup();
        reject(new ExperienceKitError("cdp/connect", "CDP connection closed before it was ready"));
      };
      const cleanup = (): void => {
        socket.off("open", onOpen);
        socket.off("error", onError);
        socket.off("close", onClose);
      };
      socket.once("open", onOpen);
      socket.once("error", onError);
      socket.once("close", onClose);
    });
    this.socket = socket;
    socket.on("message", (data) => this.handleMessage(data.toString()));
    socket.on("close", () => {
      if (this.socket === socket) this.socket = null;
      this.rejectPending(new ExperienceKitError("cdp/closed", "CDP connection closed"));
    });
    socket.on("error", (error) => this.rejectPending(new ExperienceKitError("cdp/socket", error.message, { cause: error })));
  }

  async call<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    signal?: AbortSignal,
    sessionId?: string,
  ): Promise<T> {
    await this.connect();
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) throw new ExperienceKitError("cdp/not-open", "CDP connection is not open");
    if (signal?.aborted) throw signal.reason ?? new DOMException("Operation aborted", "AbortError");
    const id = this.nextId;
    this.nextId += 1;

    const result = new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new ExperienceKitError("cdp/timeout", `CDP ${method} timed out`));
      }, this.requestTimeoutMs);
      const onAbort = (): void => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timeout);
        reject(signal?.reason ?? new DOMException("Operation aborted", "AbortError"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, {
        method,
        resolve: (value) => resolve(value as T),
        reject,
        timeout,
        cleanupAbort: () => signal?.removeEventListener("abort", onAbort),
      });
    });
    this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return await result;
  }

  on(method: string, listener: CdpEventListener): () => void {
    const listeners = this.listeners.get(method) ?? new Set<CdpEventListener>();
    listeners.add(listener);
    this.listeners.set(method, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(method);
    };
  }

  async close(): Promise<void> {
    await this.connectPromise?.catch(() => undefined);
    const socket = this.socket;
    this.socket = null;
    if (!socket || socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      socket.once("close", () => resolve());
      socket.close();
    });
  }

  private handleMessage(source: string): void {
    let message: CdpResponse;
    try {
      message = JSON.parse(source) as CdpResponse;
    } catch {
      return;
    }
    if (typeof message.id !== "number") {
      if (typeof message.method !== "string") return;
      const event: CdpEvent = {
        method: message.method,
        params: message.params ?? {},
        ...(message.sessionId ? { sessionId: message.sessionId } : {}),
      };
      for (const listener of this.listeners.get(message.method) ?? []) {
        try { listener(event); } catch { /* A protocol event must not break the transport. */ }
      }
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timeout);
    pending.cleanupAbort();
    if (message.error) {
      const code = typeof message.error.code === "number" ? ` (${message.error.code})` : "";
      pending.reject(new ExperienceKitError(
        "cdp/protocol",
        `CDP ${pending.method} failed: ${message.error.message ?? "command failed"}${code}`,
      ));
    }
    else pending.resolve(message.result);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.cleanupAbort();
      pending.reject(error);
    }
    this.pending.clear();
  }
}
