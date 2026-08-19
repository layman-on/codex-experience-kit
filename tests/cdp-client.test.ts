import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { CdpClient } from "../src/node/cdp-client.js";

interface CdpCommand {
  id: number;
  method: string;
}

describe("CdpClient", () => {
  const servers: WebSocketServer[] = [];
  const clients: CdpClient[] = [];

  afterEach(async () => {
    await Promise.all(clients.splice(0).map(client => client.close()));
    await Promise.all(servers.splice(0).map(async server => {
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }));
  });

  it("shares one WebSocket while concurrent CDP calls connect", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    servers.push(server);
    let connectionCount = 0;
    server.on("connection", (socket: WebSocket) => {
      connectionCount += 1;
      socket.on("message", source => {
        const command = JSON.parse(source.toString()) as CdpCommand;
        socket.send(JSON.stringify({ id: command.id, result: { method: command.method } }));
      });
    });
    if (!server.address()) {
      await new Promise<void>((resolve, reject) => {
        server.once("listening", resolve);
        server.once("error", reject);
      });
    }
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing CDP test address");

    const client = new CdpClient(`ws://127.0.0.1:${address.port}/devtools/page/test`, { requestTimeoutMs: 1_000 });
    clients.push(client);
    const [runtime, page] = await Promise.all([
      client.call<{ method: string }>("Runtime.evaluate"),
      client.call<{ method: string }>("Page.getFrameTree"),
    ]);

    expect(runtime.method).toBe("Runtime.evaluate");
    expect(page.method).toBe("Page.getFrameTree");
    expect(connectionCount).toBe(1);
  });
});
