export const CODEX_CONTEXT_EVENT_TYPES = [
  "connectionChanged",
  "activeThreadChanged",
  "threadStatusChanged",
  "turnStarted",
  "turnCompleted",
] as const;

export type CodexContextEventType = (typeof CODEX_CONTEXT_EVENT_TYPES)[number];
export type CodexContextConnectionState = "disconnected" | "connecting" | "connected" | "degraded";
export type CodexContextThreadStatus =
  | "unknown"
  | "idle"
  | "working"
  | "waiting"
  | "waiting-input"
  | "waiting-approval"
  | "completed"
  | "failed"
  | "interrupted";
export type CodexContextTurnOutcome = "completed" | "failed" | "interrupted";

/**
 * `displayName` is populated only when the Experience has the separate
 * `codex.context.metadata` permission. Prompt text, response text, cwd, and
 * repository paths are never included.
 * Providers may use a real Codex thread id or a stable opaque id in `threadId`.
 */
export interface CodexContextThread {
  threadId: string;
  sessionId: string | null;
  displayName?: string | null;
  status: CodexContextThreadStatus;
  active: boolean;
  unread: boolean;
  updatedAt: number;
}

export interface CodexContextSnapshot {
  connection: {
    state: CodexContextConnectionState;
    provider: string;
    updatedAt: number;
  };
  activeThreadId: string | null;
  threads: CodexContextThread[];
}

interface CodexContextEventBase {
  type: CodexContextEventType;
  observedAt: number;
}

export type CodexContextEvent =
  | (CodexContextEventBase & {
      type: "connectionChanged";
      connection: CodexContextSnapshot["connection"];
    })
  | (CodexContextEventBase & {
      type: "activeThreadChanged";
      previousThreadId: string | null;
      thread: CodexContextThread | null;
    })
  | (CodexContextEventBase & {
      type: "threadStatusChanged";
      thread: CodexContextThread;
      previousStatus: CodexContextThreadStatus;
    })
  | (CodexContextEventBase & {
      type: "turnStarted";
      threadId: string;
      sessionId: string | null;
      turnId: string;
      startedAt: number;
    })
  | (CodexContextEventBase & {
      type: "turnCompleted";
      threadId: string;
      sessionId: string | null;
      turnId: string;
      outcome: CodexContextTurnOutcome;
      completedAt: number;
    });

export interface CodexContextSource {
  getSnapshot(): CodexContextSnapshot;
  subscribe(listener: (event: CodexContextEvent, snapshot: CodexContextSnapshot) => void): () => void;
}

export function disconnectedCodexContext(provider = "none", now = Date.now()): CodexContextSnapshot {
  return {
    connection: { state: "disconnected", provider, updatedAt: now },
    activeThreadId: null,
    threads: [],
  };
}

export function cloneCodexContextSnapshot(snapshot: CodexContextSnapshot): CodexContextSnapshot {
  return {
    connection: { ...snapshot.connection },
    activeThreadId: snapshot.activeThreadId,
    threads: snapshot.threads.map((thread) => ({ ...thread })),
  };
}

export function cloneCodexContextEvent(event: CodexContextEvent): CodexContextEvent {
  if (event.type === "connectionChanged") return { ...event, connection: { ...event.connection } };
  if (event.type === "activeThreadChanged") return { ...event, thread: event.thread ? { ...event.thread } : null };
  if (event.type === "threadStatusChanged") return { ...event, thread: { ...event.thread } };
  return { ...event };
}

function upsertThread(threads: CodexContextThread[], next: CodexContextThread): CodexContextThread[] {
  const index = threads.findIndex((thread) => thread.threadId === next.threadId);
  if (index < 0) return [...threads, { ...next }];
  return threads.map((thread, current) => current === index ? { ...next } : { ...thread });
}

export function reduceCodexContextEvent(snapshot: CodexContextSnapshot, event: CodexContextEvent): CodexContextSnapshot {
  const next = cloneCodexContextSnapshot(snapshot);
  if (event.type === "connectionChanged") {
    next.connection = { ...event.connection };
    return next;
  }
  if (event.type === "activeThreadChanged") {
    next.activeThreadId = event.thread?.threadId ?? null;
    next.threads = next.threads.map((thread) => ({ ...thread, active: thread.threadId === next.activeThreadId }));
    if (event.thread) next.threads = upsertThread(next.threads, { ...event.thread, active: true });
    return next;
  }
  if (event.type === "threadStatusChanged") {
    next.threads = upsertThread(next.threads, event.thread);
    return next;
  }
  const index = next.threads.findIndex((thread) => thread.threadId === event.threadId);
  const status: CodexContextThreadStatus = event.type === "turnStarted" ? "working" : event.outcome;
  const updatedAt = event.type === "turnStarted" ? event.startedAt : event.completedAt;
  const current = index >= 0 ? next.threads[index]! : {
    threadId: event.threadId,
    sessionId: event.sessionId,
    status: "unknown" as const,
    active: next.activeThreadId === event.threadId,
    unread: false,
    updatedAt,
  };
  next.threads = upsertThread(next.threads, {
    ...current,
    sessionId: event.sessionId,
    status,
    unread: event.type === "turnCompleted" && next.activeThreadId !== event.threadId,
    updatedAt,
  });
  return next;
}
