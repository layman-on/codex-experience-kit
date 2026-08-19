import { WebSocketServer, type WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { CodexAppServerContextProvider } from "../src/node/codex-app-server-context-provider.js";
import { CodexContextService } from "../src/service/codex-context-service.js";

describe("Codex App Server context provider", () => {
  const cleanup: Array<() => Promise<void>> = [];
  afterEach(async () => { while (cleanup.length) await cleanup.pop()?.(); });

  it("uses only an explicit endpoint and maps thread-scoped completion notifications", async () => {
    const methods: string[] = [];
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    const connected = new Promise<WebSocket>((resolve) => server.once("connection", resolve));
    cleanup.push(async () => {
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    });
    server.on("connection", (socket) => {
      socket.on("message", (source) => {
        const message = JSON.parse(source.toString()) as { id?: number; method: string };
        methods.push(message.method);
        if (message.id === undefined) return;
        if (message.method === "initialize") socket.send(JSON.stringify({ id: message.id, result: { userAgent: "simulation" } }));
        else if (message.method === "thread/list") socket.send(JSON.stringify({ id: message.id, result: { data: [{ id: "thread-a", sessionId: "session-a", name: "Build task panel", status: { type: "active", activeFlags: [] }, updatedAt: 2 }], nextCursor: null } }));
        else if (message.method === "thread/loaded/list") socket.send(JSON.stringify({ id: message.id, result: { data: ["thread-a"], nextCursor: null } }));
        else if (message.method === "thread/resume") socket.send(JSON.stringify({ id: message.id, result: { thread: { id: "thread-a" } } }));
      });
    });
    if (!server.address()) await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing simulated App Server address");
    const provider = new CodexAppServerContextProvider({ webSocketUrl: `ws://127.0.0.1:${address.port}` });
    const service = new CodexContextService(provider);
    cleanup.push(() => service.stop());
    const events: string[] = [];
    service.subscribe((event) => events.push(event.type));
    await service.start();
    const client = await connected;
    expect(methods).toEqual(["initialize", "initialized", "thread/list", "thread/loaded/list", "thread/resume"]);
    expect(service.getSnapshot()).toMatchObject({
      connection: { state: "connected", provider: "codex-app-server" },
      threads: [expect.objectContaining({ threadId: "thread-a", sessionId: "session-a", displayName: "Build task panel", status: "working" })],
    });
    client.send(JSON.stringify({
      method: "thread/status/changed",
      params: { threadId: "thread-a", status: { type: "active", activeFlags: ["waitingOnUserInput"] } },
    }));
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(service.getSnapshot().threads[0]).toMatchObject({ status: "waiting-input" });
    client.send(JSON.stringify({
      method: "thread/status/changed",
      params: { threadId: "thread-a", status: { type: "active", activeFlags: ["waitingOnApproval"] } },
    }));
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(service.getSnapshot().threads[0]).toMatchObject({ status: "waiting-approval" });
    client.send(JSON.stringify({
      method: "turn/completed",
      params: { threadId: "thread-a", turn: { id: "turn-a", status: "completed", completedAt: 3 } },
    }));
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(events).toContain("turnCompleted");
    expect(service.getSnapshot().threads[0]).toMatchObject({ status: "completed" });
  });

  it("rejects non-loopback endpoints unless the host explicitly allows them", () => {
    expect(() => new CodexAppServerContextProvider({ webSocketUrl: "wss://example.com/codex" })).toThrow("must be loopback");
    expect(() => new CodexAppServerContextProvider({ webSocketUrl: "wss://example.com/codex", allowRemote: true })).not.toThrow();
  });
});
