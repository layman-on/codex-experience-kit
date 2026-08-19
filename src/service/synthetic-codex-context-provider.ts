import {
  cloneCodexContextSnapshot,
  reduceCodexContextEvent,
  type CodexContextEvent,
  type CodexContextSnapshot,
  type CodexContextTurnOutcome,
} from "../core/codex-context.js";
import type { CodexContextProvider } from "./codex-context-service.js";

export interface SyntheticCodexContextProviderOptions {
  now?: () => number;
  threadIds?: [string, string];
}

export class SyntheticCodexContextProvider implements CodexContextProvider {
  readonly id = "synthetic-preview";
  readonly #now: () => number;
  #publish: ((event: CodexContextEvent) => void) | null = null;
  #turnSequence = 0;
  #snapshot: CodexContextSnapshot;

  constructor(options: SyntheticCodexContextProviderOptions = {}) {
    this.#now = options.now ?? Date.now;
    const now = this.#now();
    const [first, second] = options.threadIds ?? ["synthetic-thread-a", "synthetic-thread-b"];
    this.#snapshot = {
      connection: { state: "connected", provider: this.id, updatedAt: now },
      activeThreadId: first,
      threads: [
        { threadId: first, sessionId: first, status: "idle", active: true, unread: false, updatedAt: now },
        { threadId: second, sessionId: second, status: "idle", active: false, unread: false, updatedAt: now },
      ],
    };
  }

  start(publish: (event: CodexContextEvent) => void): CodexContextSnapshot {
    this.#publish = publish;
    return this.getSnapshot();
  }

  stop(): void { this.#publish = null; }
  getSnapshot(): CodexContextSnapshot { return cloneCodexContextSnapshot(this.#snapshot); }

  switchThread(threadId: string | null): void {
    const previousThreadId = this.#snapshot.activeThreadId;
    if (previousThreadId === threadId) return;
    const now = this.#now();
    const existing = threadId ? this.#snapshot.threads.find((thread) => thread.threadId === threadId) : null;
    if (threadId && !existing) throw new TypeError(`Unknown synthetic thread: ${threadId}`);
    const event: CodexContextEvent = {
      type: "activeThreadChanged",
      observedAt: now,
      previousThreadId,
      thread: existing ? { ...existing, active: true, unread: false, updatedAt: now } : null,
    };
    this.#emit(event);
  }

  startTurn(threadId: string): string {
    const thread = this.#thread(threadId);
    const now = this.#now();
    const turnId = `synthetic-turn-${++this.#turnSequence}`;
    this.#emit({ type: "turnStarted", observedAt: now, threadId, sessionId: thread.sessionId, turnId, startedAt: now });
    return turnId;
  }

  completeTurn(threadId: string, outcome: CodexContextTurnOutcome = "completed", turnId?: string): string {
    const thread = this.#thread(threadId);
    const now = this.#now();
    const resolvedTurnId = turnId ?? `synthetic-turn-${++this.#turnSequence}`;
    this.#emit({ type: "turnCompleted", observedAt: now, threadId, sessionId: thread.sessionId, turnId: resolvedTurnId, outcome, completedAt: now });
    return resolvedTurnId;
  }

  setConnection(state: CodexContextSnapshot["connection"]["state"]): void {
    const now = this.#now();
    this.#emit({ type: "connectionChanged", observedAt: now, connection: { state, provider: this.id, updatedAt: now } });
  }

  #thread(threadId: string) {
    const thread = this.#snapshot.threads.find((candidate) => candidate.threadId === threadId);
    if (!thread) throw new TypeError(`Unknown synthetic thread: ${threadId}`);
    return thread;
  }

  #emit(event: CodexContextEvent): void {
    this.#snapshot = reduceCodexContextEvent(this.#snapshot, event);
    this.#publish?.(event);
  }
}
