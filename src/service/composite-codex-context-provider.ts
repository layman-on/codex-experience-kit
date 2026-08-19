import {
  cloneCodexContextSnapshot,
  reduceCodexContextEvent,
  type CodexContextEvent,
  type CodexContextSnapshot,
  type CodexContextThread,
} from "../core/codex-context.js";
import type { CodexContextProvider } from "./codex-context-service.js";

export class CompositeCodexContextProvider implements CodexContextProvider {
  readonly id: string;
  readonly #providers: CodexContextProvider[];
  readonly #snapshots = new Map<CodexContextProvider, CodexContextSnapshot>();
  #publish: ((event: CodexContextEvent) => void) | null = null;

  constructor(providers: CodexContextProvider[], id = "composite") {
    if (providers.length < 1) throw new TypeError("Composite Codex context requires at least one provider");
    this.#providers = [...providers];
    this.id = id;
  }

  async start(publish: (event: CodexContextEvent) => void): Promise<CodexContextSnapshot> {
    this.#publish = publish;
    for (const provider of this.#providers) {
      const snapshot = await provider.start((event) => {
        const current = this.#snapshots.get(provider);
        if (current) this.#snapshots.set(provider, reduceCodexContextEvent(current, event));
        this.#publish?.(event);
      });
      this.#snapshots.set(provider, cloneCodexContextSnapshot(snapshot));
    }
    return this.#merge();
  }

  async stop(): Promise<void> {
    this.#publish = null;
    const errors: unknown[] = [];
    for (const provider of [...this.#providers].reverse()) {
      try { await provider.stop(); } catch (error) { errors.push(error); }
    }
    this.#snapshots.clear();
    if (errors.length) throw new AggregateError(errors, "Unable to stop every Codex context provider");
  }

  #merge(): CodexContextSnapshot {
    const snapshots = this.#providers.map((provider) => this.#snapshots.get(provider)).filter((value): value is CodexContextSnapshot => Boolean(value));
    const now = Math.max(Date.now(), ...snapshots.map((snapshot) => snapshot.connection.updatedAt));
    const activeThreadId = snapshots.find((snapshot) => snapshot.activeThreadId !== null)?.activeThreadId ?? null;
    const threads = new Map<string, CodexContextThread>();
    for (const snapshot of [...snapshots].reverse()) {
      for (const thread of snapshot.threads) threads.set(thread.threadId, { ...thread, active: false });
    }
    for (const snapshot of snapshots) {
      for (const thread of snapshot.threads) {
        const current = threads.get(thread.threadId);
        threads.set(thread.threadId, {
          ...(current ?? thread),
          ...thread,
          status: thread.status === "unknown" && current ? current.status : thread.status,
          unread: thread.unread || current?.unread === true,
          active: thread.threadId === activeThreadId,
          updatedAt: Math.max(thread.updatedAt, current?.updatedAt ?? 0),
        });
      }
    }
    const states = snapshots.map((snapshot) => snapshot.connection.state);
    const state = states.includes("connected") ? "connected"
      : states.includes("degraded") ? "degraded"
      : states.includes("connecting") ? "connecting"
      : "disconnected";
    return {
      connection: { state, provider: this.id, updatedAt: now },
      activeThreadId,
      threads: [...threads.values()],
    };
  }
}
