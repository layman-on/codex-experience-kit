import {
  cloneCodexContextEvent,
  cloneCodexContextSnapshot,
  disconnectedCodexContext,
  reduceCodexContextEvent,
  type CodexContextEvent,
  type CodexContextSnapshot,
  type CodexContextSource,
} from "../core/codex-context.js";

export interface CodexContextProvider {
  readonly id: string;
  start(publish: (event: CodexContextEvent) => void): Promise<CodexContextSnapshot> | CodexContextSnapshot;
  stop(): Promise<void> | void;
}

type CodexContextListener = (event: CodexContextEvent, snapshot: CodexContextSnapshot) => void;

export class CodexContextService implements CodexContextSource {
  readonly #provider: CodexContextProvider;
  readonly #listeners = new Set<CodexContextListener>();
  #snapshot: CodexContextSnapshot;
  #started = false;
  #startOperation: Promise<CodexContextSnapshot> | null = null;

  constructor(provider: CodexContextProvider) {
    this.#provider = provider;
    this.#snapshot = disconnectedCodexContext(provider.id);
  }

  async start(): Promise<CodexContextSnapshot> {
    if (this.#started) return this.getSnapshot();
    if (this.#startOperation) return await this.#startOperation;
    const operation = (async (): Promise<CodexContextSnapshot> => {
      const initial = await this.#provider.start((event) => this.publish(event));
      this.#snapshot = normalizeCodexContextSnapshot(initial);
      this.#started = true;
      return this.getSnapshot();
    })();
    this.#startOperation = operation;
    try { return await operation; }
    finally { if (this.#startOperation === operation) this.#startOperation = null; }
  }

  getSnapshot(): CodexContextSnapshot {
    return cloneCodexContextSnapshot(this.#snapshot);
  }

  subscribe(listener: CodexContextListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  publish(input: CodexContextEvent): void {
    const event = normalizeCodexContextEvent(input);
    this.#snapshot = normalizeCodexContextSnapshot(reduceCodexContextEvent(this.#snapshot, event));
    const snapshot = this.getSnapshot();
    for (const listener of this.#listeners) listener(cloneCodexContextEvent(event), cloneCodexContextSnapshot(snapshot));
  }

  async stop(): Promise<void> {
    await this.#startOperation?.catch(() => undefined);
    if (this.#started) await this.#provider.stop();
    this.#started = false;
    this.#snapshot = disconnectedCodexContext(this.#provider.id);
  }
}

const CONNECTION_STATES = new Set(["disconnected", "connecting", "connected", "degraded"]);
const THREAD_STATUSES = new Set([
  "unknown", "idle", "working", "waiting", "waiting-input", "waiting-approval", "completed", "failed", "interrupted",
]);
const TURN_OUTCOMES = new Set(["completed", "failed", "interrupted"]);

function text(value: unknown, label: string, nullable = false): string | null {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || value.length < 1 || value.length > 256) throw new TypeError(`${label} must contain 1 to 256 characters`);
  return value;
}

function timestamp(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new TypeError(`${label} must be a finite timestamp`);
  return value;
}

export function normalizeCodexContextSnapshot(input: CodexContextSnapshot): CodexContextSnapshot {
  if (!input || typeof input !== "object" || !input.connection || !Array.isArray(input.threads)) throw new TypeError("Codex context snapshot is invalid");
  if (!CONNECTION_STATES.has(input.connection.state)) throw new TypeError("Codex context connection state is invalid");
  const provider = text(input.connection.provider, "connection.provider")!;
  const activeThreadId = text(input.activeThreadId, "activeThreadId", true);
  const ids = new Set<string>();
  const threads = input.threads.map((thread, index) => {
    const threadId = text(thread.threadId, `threads[${index}].threadId`)!;
    if (ids.has(threadId)) throw new TypeError("Codex context thread ids must be unique");
    ids.add(threadId);
    if (!THREAD_STATUSES.has(thread.status)) throw new TypeError(`threads[${index}].status is invalid`);
    return {
      threadId,
      sessionId: text(thread.sessionId, `threads[${index}].sessionId`, true),
      ...(thread.displayName === undefined ? {} : { displayName: text(thread.displayName, `threads[${index}].displayName`, true) }),
      status: thread.status,
      active: threadId === activeThreadId,
      unread: Boolean(thread.unread),
      updatedAt: timestamp(thread.updatedAt, `threads[${index}].updatedAt`),
    };
  });
  if (activeThreadId !== null && !ids.has(activeThreadId)) throw new TypeError("activeThreadId must refer to a listed thread");
  return {
    connection: {
      state: input.connection.state,
      provider,
      updatedAt: timestamp(input.connection.updatedAt, "connection.updatedAt"),
    },
    activeThreadId,
    threads,
  };
}

export function normalizeCodexContextEvent(input: CodexContextEvent): CodexContextEvent {
  if (!input || typeof input !== "object") throw new TypeError("Codex context event is invalid");
  const observedAt = timestamp(input.observedAt, "event.observedAt");
  if (input.type === "connectionChanged") {
    const snapshot = normalizeCodexContextSnapshot({ connection: input.connection, activeThreadId: null, threads: [] });
    return { type: input.type, observedAt, connection: snapshot.connection };
  }
  if (input.type === "activeThreadChanged") {
    const previousThreadId = text(input.previousThreadId, "event.previousThreadId", true);
    if (!input.thread) return { type: input.type, observedAt, previousThreadId, thread: null };
    const normalized = normalizeCodexContextSnapshot({
      connection: { state: "connected", provider: "event", updatedAt: observedAt },
      activeThreadId: input.thread.threadId,
      threads: [input.thread],
    });
    return { type: input.type, observedAt, previousThreadId, thread: normalized.threads[0]! };
  }
  if (input.type === "threadStatusChanged") {
    const normalized = normalizeCodexContextSnapshot({
      connection: { state: "connected", provider: "event", updatedAt: observedAt },
      activeThreadId: input.thread.active ? input.thread.threadId : null,
      threads: [input.thread],
    });
    if (!THREAD_STATUSES.has(input.previousStatus)) throw new TypeError("event.previousStatus is invalid");
    return { type: input.type, observedAt, previousStatus: input.previousStatus, thread: normalized.threads[0]! };
  }
  const threadId = text(input.threadId, "event.threadId")!;
  const sessionId = text(input.sessionId, "event.sessionId", true);
  const turnId = text(input.turnId, "event.turnId")!;
  if (input.type === "turnStarted") {
    return { type: input.type, observedAt, threadId, sessionId, turnId, startedAt: timestamp(input.startedAt, "event.startedAt") };
  }
  if (input.type === "turnCompleted") {
    if (!TURN_OUTCOMES.has(input.outcome)) throw new TypeError("event.outcome is invalid");
    return { type: input.type, observedAt, threadId, sessionId, turnId, outcome: input.outcome, completedAt: timestamp(input.completedAt, "event.completedAt") };
  }
  throw new TypeError("Codex context event type is unsupported");
}
