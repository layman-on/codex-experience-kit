import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { resolveCdpPageWebSocketUrl, type CdpPageTargetInfo } from "../src/node/cdp-discovery.js";

describe("CDP target discovery", () => {
  const close: Array<() => Promise<void>> = [];
  afterEach(async () => { while (close.length) await close.pop()?.(); });

  it("uses rank instead of JSON list order when several pages are acceptable", async () => {
    const targets: CdpPageTargetInfo[] = [
      { id: "secondary", type: "page", title: "Secondary", url: "app://-/secondary.html", webSocketDebuggerUrl: "ws://127.0.0.1:9341/devtools/page/secondary" },
      { id: "main", type: "page", title: "Main", url: "app://-/index.html", webSocketDebuggerUrl: "ws://127.0.0.1:9341/devtools/page/main" },
    ];
    const server = createServer((_request, response) => {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify(targets));
    });
    await new Promise<void>((resolve, reject) => {
      server.listen({ host: "127.0.0.1", port: 0 }, resolve);
      server.once("error", reject);
    });
    close.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing HTTP test address");

    await expect(resolveCdpPageWebSocketUrl(`http://127.0.0.1:${address.port}`, {
      rank: target => target.url.endsWith("/index.html") ? 100 : 0,
    })).resolves.toBe("ws://127.0.0.1:9341/devtools/page/main");
  });
});
