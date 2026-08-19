import { describe, expect, it } from "vitest";
import { CodexContextService, SyntheticCodexContextProvider } from "../src/service/index.js";

describe("Codex Context Service", () => {
  it("tracks active threads and background completion without exposing conversation content", async () => {
    let now = 1_000;
    const provider = new SyntheticCodexContextProvider({ now: () => ++now });
    const service = new CodexContextService(provider);
    const events: string[] = [];
    service.subscribe((event) => events.push(event.type));
    await service.start();

    provider.switchThread("synthetic-thread-b");
    const turnId = provider.startTurn("synthetic-thread-a");
    provider.completeTurn("synthetic-thread-a", "completed", turnId);

    const snapshot = service.getSnapshot();
    expect(snapshot.activeThreadId).toBe("synthetic-thread-b");
    expect(snapshot.threads.find((thread) => thread.threadId === "synthetic-thread-a")).toMatchObject({
      status: "completed",
      active: false,
      unread: true,
    });
    expect(events).toEqual(["activeThreadChanged", "turnStarted", "turnCompleted"]);
    expect(JSON.stringify(snapshot)).not.toMatch(/prompt|response|cwd|repository/iu);
    await service.stop();
    expect(service.getSnapshot()).toMatchObject({ activeThreadId: null, threads: [] });
  });

  it("rejects invalid provider snapshots at the host boundary", async () => {
    const service = new CodexContextService({
      id: "invalid-provider",
      start: () => ({
        connection: { state: "connected", provider: "invalid-provider", updatedAt: 1 },
        activeThreadId: "missing",
        threads: [],
      }),
      stop() {},
    });
    await expect(service.start()).rejects.toThrow("activeThreadId must refer to a listed thread");
  });

  it("preserves bounded display metadata and the two actionable waiting states", async () => {
    const service = new CodexContextService({
      id: "metadata-provider",
      start: () => ({
        connection: { state: "connected", provider: "metadata-provider", updatedAt: 1 },
        activeThreadId: "thread-a",
        threads: [{
          threadId: "thread-a", sessionId: "session-a", displayName: "Panel task", status: "waiting-approval",
          active: true, unread: false, updatedAt: 1,
        }],
      }),
      stop() {},
    });
    await service.start();
    expect(service.getSnapshot().threads[0]).toMatchObject({ displayName: "Panel task", status: "waiting-approval" });
    service.publish({
      type: "threadStatusChanged", observedAt: 2, previousStatus: "waiting-approval",
      thread: { ...service.getSnapshot().threads[0]!, status: "waiting-input", updatedAt: 2 },
    });
    expect(service.getSnapshot().threads[0]).toMatchObject({ displayName: "Panel task", status: "waiting-input" });
  });
});
