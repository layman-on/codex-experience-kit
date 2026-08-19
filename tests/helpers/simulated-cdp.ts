import { JSDOM } from "jsdom";
import { WebSocketServer, type WebSocket } from "ws";

interface Command { id: number; method: string; params?: Record<string, unknown>; sessionId?: string }
interface SimulatedCdpServerOptions {
  requireSequentialDomainEnable?: boolean;
  rejectPrematureFrameMessaging?: boolean;
  suspendAnimationFrames?: boolean;
}

export class SimulatedCdpServer {
  readonly dom = new JSDOM(`<!doctype html><html class="electron-light"><head></head><body>
    <aside class="app-shell-left-panel">Projects</aside>
    <main class="main-surface" data-app-shell-main-surface>
      <header class="app-header-tint">Synthetic Codex</header>
      <div data-app-shell-main-content-layout="default">
        <section class="thread-scroll-container"><div>Safe synthetic content</div></section>
        <form class="composer-surface-chrome"><textarea></textarea></form>
      </div>
    </main>
  </body></html>`, { runScripts: "outside-only", pretendToBeVisual: true, url: "https://simulated-codex.invalid/" });
  readonly scripts = new Map<string, string>();
  private readonly server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  private nextId = 0;
  private runtimeEnabled = false;
  private autoAttachObserver: MutationObserver | null = null;
  private readonly sessionFrames = new Map<string, HTMLIFrameElement>();
  private readonly remoteObjects = new Map<string, object>();

  constructor(private readonly options: SimulatedCdpServerOptions = {}) {
    this.dom.window.requestAnimationFrame = options.suspendAnimationFrames
      ? () => 0
      : (callback) => this.dom.window.setTimeout(() => callback(Date.now()), 0);
    if (options.rejectPrematureFrameMessaging) {
      const prototype = this.dom.window.HTMLIFrameElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(prototype, "contentWindow");
      const ready = new WeakSet<HTMLIFrameElement>();
      if (!descriptor?.get) throw new Error("Simulated iframe contentWindow getter is unavailable");
      this.dom.window.document.addEventListener("load", (event) => {
        if (event.target instanceof this.dom.window.HTMLIFrameElement) queueMicrotask(() => ready.add(event.target as HTMLIFrameElement));
      }, true);
      Object.defineProperty(prototype, "contentWindow", {
        configurable: true,
        get(this: HTMLIFrameElement) {
          if (!ready.has(this)) throw new Error("Premature iframe contentWindow access");
          return descriptor.get!.call(this) as Window | null;
        },
      });
    }
  }

  async start(): Promise<string> {
    this.server.on("connection", socket => this.handle(socket));
    if (!this.server.address()) await new Promise<void>((resolve, reject) => { this.server.once("listening", resolve); this.server.once("error", reject); });
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("Missing simulated CDP address");
    return `ws://127.0.0.1:${address.port}/devtools/page/synthetic`;
  }

  async close(): Promise<void> {
    this.autoAttachObserver?.disconnect();
    this.autoAttachObserver = null;
    for (const client of this.server.clients) client.terminate();
    await new Promise<void>((resolve, reject) => this.server.close(error => error ? reject(error) : resolve()));
    this.dom.window.close();
  }

  private handle(socket: WebSocket): void {
    socket.on("message", source => {
      void (async () => {
        const command = JSON.parse(source.toString()) as Command;
        try { socket.send(JSON.stringify({ id: command.id, result: await this.execute(command, socket), ...(command.sessionId ? { sessionId: command.sessionId } : {}) })); }
        catch (error) { socket.send(JSON.stringify({ id: command.id, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } })); }
      })();
    });
  }

  private async execute(command: Command, socket: WebSocket): Promise<unknown> {
    if (command.method === "Runtime.enable") {
      if (this.options.requireSequentialDomainEnable) {
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
        this.runtimeEnabled = true;
      }
      return {};
    }
    if (command.method === "Page.enable") {
      if (this.options.requireSequentialDomainEnable && !this.runtimeEnabled) throw new Error("Target crashed");
      return {};
    }
    if (command.method === "Page.addScriptToEvaluateOnNewDocument") {
      const identifier = `script-${++this.nextId}`;
      this.scripts.set(identifier, String(command.params?.source ?? ""));
      return { identifier };
    }
    if (command.method === "Page.removeScriptToEvaluateOnNewDocument") {
      const identifier = String(command.params?.identifier ?? "");
      if (!this.scripts.delete(identifier)) throw new Error("No script with given id");
      return {};
    }
    if (command.method === "Target.setAutoAttach") {
      this.autoAttachObserver?.disconnect();
      this.autoAttachObserver = null;
      if (command.params?.autoAttach === true) {
        const attach = (frame: HTMLIFrameElement): void => {
          if ([...this.sessionFrames.values()].includes(frame)) return;
          const sessionId = `child-session-${++this.nextId}`;
          this.sessionFrames.set(sessionId, frame);
          socket.send(JSON.stringify({
            method: "Target.attachedToTarget",
            params: {
              sessionId,
              targetInfo: { attached: true, targetId: `child-target-${this.nextId}`, title: "about:srcdoc", type: "iframe", url: "about:srcdoc" },
            },
          }));
        };
        this.autoAttachObserver = new this.dom.window.MutationObserver((records) => {
          for (const record of records) for (const node of record.addedNodes) {
            if (node instanceof this.dom.window.HTMLIFrameElement) attach(node);
            if (node instanceof this.dom.window.Element) for (const frame of node.querySelectorAll("iframe")) attach(frame);
          }
        });
        this.autoAttachObserver.observe(this.dom.window.document, { childList: true, subtree: true });
      }
      return {};
    }
    if (command.method === "Runtime.runIfWaitingForDebugger") return {};
    if (command.method === "Runtime.releaseObject") {
      this.remoteObjects.delete(String(command.params?.objectId ?? ""));
      return {};
    }
    if (command.method === "Runtime.callFunctionOn") {
      const object = this.remoteObjects.get(String(command.params?.objectId ?? ""));
      if (!object) throw new Error("Unknown remote object");
      const args = command.params?.arguments as Array<{ value?: unknown }> | undefined;
      (object as { documentHtml?: unknown }).documentHtml = args?.[0]?.value;
      return { result: { type: "boolean", value: true } };
    }
    if (command.method === "Runtime.evaluate") {
      if (command.sessionId) {
        const frame = this.sessionFrames.get(command.sessionId);
        if (!frame) throw new Error("Unknown child session");
        const expression = String(command.params?.expression ?? "");
        if (expression === "window.name") return { result: { type: "string", value: frame.name } };
        if (expression.includes("codex-experience://")) {
          const channel = /"channel":"([^"]+)"/u.exec(expression)?.[1];
          if (channel) this.dom.window.setTimeout(() => {
            let source: Window | null = null;
            try { source = frame.contentWindow; } catch { return; }
            this.dom.window.dispatchEvent(new this.dom.window.MessageEvent("message", {
              source,
              data: { source: "codex-experience-browser-v1", channel, type: "ready", payload: {} },
            }));
          }, 0);
        }
        return { result: { type: "undefined" } };
      }
      const value = await this.dom.window.eval(String(command.params?.expression ?? ""));
      if (command.params?.returnByValue === false && value && typeof value === "object") {
        const objectId = `remote-object-${++this.nextId}`;
        this.remoteObjects.set(objectId, value as object);
        return { result: { type: "object", objectId } };
      }
      return { result: { type: typeof value, value } };
    }
    throw new Error(`Unsupported simulated CDP method: ${command.method}`);
  }
}
