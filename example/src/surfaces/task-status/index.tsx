import { useEffect, useMemo, useRef, useState } from "react";
import type {
  CodexContextEvent,
  CodexContextSnapshot,
  CodexContextThread,
  CodexContextThreadStatus,
} from "codex-experience-kit/core";
import "./styles.css";

const EMPTY_CONTEXT: CodexContextSnapshot = {
  connection: { state: "disconnected", provider: "unavailable", updatedAt: 0 },
  activeThreadId: null,
  threads: [],
};

function taskName(thread: CodexContextThread | null): string {
  if (!thread) return "No active task";
  if (thread.displayName?.trim()) return thread.displayName.trim();
  return `Task ${thread.threadId.slice(-8)}`;
}

function statusText(status: CodexContextThreadStatus | undefined): string {
  switch (status) {
    case "working": return "Working";
    case "waiting-input": return "Waiting for input";
    case "waiting-approval": return "Waiting for approval";
    case "waiting": return "Waiting";
    case "idle": return "Viewing";
    case "completed": return "Completed";
    case "failed": return "Failed";
    case "interrupted": return "Interrupted";
    default: return "Unknown";
  }
}

function eventText(event: CodexContextEvent): string {
  switch (event.type) {
    case "activeThreadChanged": return event.thread ? `Viewing ${taskName(event.thread)}` : "Returned home";
    case "threadStatusChanged": return `${taskName(event.thread)} · ${statusText(event.thread.status)}`;
    case "turnStarted": return `Task ${event.threadId.slice(-8)} started`;
    case "turnCompleted": return `Task ${event.threadId.slice(-8)} ${event.outcome}`;
    case "connectionChanged": return `Connection ${event.connection.state}`;
  }
}

export default function TaskStatus() {
  const [context, setContext] = useState<CodexContextSnapshot>(EMPTY_CONTEXT);
  const [open, setOpen] = useState(false);
  const [lastEvent, setLastEvent] = useState("Switch tasks in the preview toolbar.");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const runtime = window.codexExperience;
    if (!runtime) return;
    let active = true;
    void runtime.context.getSnapshot().then((snapshot) => {
      if (active) setContext(snapshot);
    });
    const stopContext = runtime.context.subscribe(setContext);
    const stopEvents = runtime.events.subscribe((event) => setLastEvent(eventText(event)));
    return () => {
      active = false;
      stopContext();
      stopEvents();
    };
  }, []);

  useEffect(() => {
    const interaction = window.codexExperience?.interaction;
    if (!interaction || !triggerRef.current) return;
    const handles = [interaction.register(triggerRef.current, { padding: 6, shape: "rounded" })];
    if (panelRef.current) handles.push(interaction.register(panelRef.current, { padding: 6, shape: "rounded" }));
    return () => handles.forEach((handle) => handle.destroy());
  }, [open]);

  const activeTask = context.threads.find((thread) => thread.threadId === context.activeThreadId) ?? null;
  const ongoing = useMemo(
    () => context.threads.filter((thread) => ["working", "waiting", "waiting-input", "waiting-approval"].includes(thread.status)),
    [context],
  );

  return (
    <div className="task-status-layer">
      <button
        ref={triggerRef}
        className="task-status-trigger"
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className={`status-dot status-${activeTask?.status ?? "unknown"}`} aria-hidden="true" />
        <span className="trigger-copy">
          <strong>{taskName(activeTask)}</strong>
          <small>{statusText(activeTask?.status)}</small>
        </span>
        <span className="trigger-chevron" aria-hidden="true">{open ? "↑" : "↓"}</span>
      </button>

      {open && (
        <section ref={panelRef} className="task-status-panel" aria-label="Task status details">
          <header>
            <div>
              <p>Codex context</p>
              <h2>Active sessions</h2>
            </div>
            <span className={`connection connection-${context.connection.state}`}>{context.connection.state}</span>
          </header>

          {ongoing.length === 0 ? (
            <p className="empty-state">No task is currently running or waiting.</p>
          ) : (
            <ul>
              {ongoing.slice(0, 4).map((thread) => (
                <li key={thread.threadId}>
                  <span className={`status-dot status-${thread.status}`} aria-hidden="true" />
                  <span><strong>{taskName(thread)}</strong><small>{statusText(thread.status)}</small></span>
                  {thread.active && <em>Current</em>}
                </li>
              ))}
            </ul>
          )}

          <footer><span aria-hidden="true">●</span>{lastEvent}</footer>
        </section>
      )}
    </div>
  );
}
