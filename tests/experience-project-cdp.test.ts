import { afterEach, describe, expect, it, vi } from "vitest";
import { generateAppearanceTokens } from "../src/core/appearance-tokens.js";
import { ExperienceProjectCdpTarget } from "../src/node/experience-project-cdp-target.js";
import { buildExperienceProjectCdpPlan } from "../src/node/experience-project-injection.js";
import { SimulatedCdpServer } from "./helpers/simulated-cdp.js";

function managedDocument(frame: HTMLIFrameElement | null): string {
  if (!frame) return "";
  const prefix = "data:text/html;charset=utf-8,";
  expect(frame.src.startsWith(prefix)).toBe(true);
  return decodeURIComponent(frame.src.slice(prefix.length));
}

describe("ExperienceProjectCdpTarget simulation", () => {
  const close: Array<() => Promise<void>> = [];
  afterEach(async () => { while (close.length) await close.pop()?.(); });

  it("keeps author HTML and JavaScript out of the Codex main-world host expression", () => {
    const marker = "AUTHOR_RUNTIME_MUST_ONLY_RUN_IN_THE_CHILD_TARGET";
    const payload = {
      manifest: { apiVersion: 1 as const, id: "cdp.boundary", name: "CDP Boundary", version: "1.0.0", entry: "index.html" as const, permissions: [] },
      html: `<!doctype html><html><head><style>.portal{color:rebeccapurple}</style></head><body><codex-experience-surface target="app-shell" plane="overlay"><div class="portal">Portal</div></codex-experience-surface><script>globalThis.${marker}=true;window.codexExperience?.lifecycle.ready()</script></body></html>`,
      digest: "7".repeat(64),
      surfaces: [{ target: "app-shell" as const, plane: "overlay" as const, interaction: "passthrough" as const }],
      appearance: "light" as const,
      tokens: generateAppearanceTokens({ seed: "#6750A4" }).modes,
    };

    const plan = buildExperienceProjectCdpPlan(payload);
    expect(plan.hostSource).toContain('setProperty("-webkit-app-region","no-drag")');
    expect(plan.hostSource).not.toContain(marker);
    expect(plan.hostSource).not.toContain("<div class=\"portal\">");
    expect(plan.documentHtml).toContain("<div class=\"portal\">");
    expect(plan.documentHtml).toContain("script-src 'none'");
    expect(plan.documentHtml).not.toMatch(/<script(?:\s|>)/iu);
    expect([...plan.childSources.values()]).toHaveLength(1);
    expect([...plan.childSources.values()][0]).toContain(marker);
  });

  it("applies, token-patches, relays signals, and fully cancels sandboxed surfaces", async () => {
    // The synthetic target deliberately crashes if Page.enable arrives before
    // Runtime.enable has completed. This reproduces the real renderer failure
    // without connecting to the user's Codex process.
    const server = new SimulatedCdpServer({ requireSequentialDomainEnable: true });
    const url = await server.start(); close.push(() => server.close());
    const target = new ExperienceProjectCdpTarget(url); close.push(() => target.close());
    const tokens = generateAppearanceTokens({ seed: "#6750A4" }).modes;
    const payload = {
      manifest: { apiVersion: 1 as const, id: "cdp.portal", name: "CDP Portal", version: "1.0.0", entry: "index.html" as const, permissions: ["appearance.tokens" as const] },
      html: '<!doctype html><html><body><codex-experience-surface target="app-shell" plane="underlay"></codex-experience-surface><codex-experience-surface target="app-shell" plane="overlay"></codex-experience-surface><codex-experience-surface target="workspace" plane="overlay"></codex-experience-surface></body></html>',
      digest: "b".repeat(64),
      surfaces: [
        { target: "app-shell" as const, plane: "underlay" as const, interaction: "passthrough" as const },
        { target: "app-shell" as const, plane: "overlay" as const, interaction: "passthrough" as const },
        { target: "workspace" as const, plane: "overlay" as const, interaction: "passthrough" as const },
      ],
      appearance: "light" as const,
      tokens,
    };
    const receipt = await target.apply(payload, new AbortController().signal);
    expect(receipt.targetId).toContain("cdp:");
    expect(server.dom.window.document.querySelectorAll('iframe[data-codex-experience-target]')).toHaveLength(3);
    expect(server.dom.window.document.querySelector<HTMLIFrameElement>('iframe[data-codex-experience-plane="underlay"]')?.style.zIndex).toBe("0");
    expect(server.dom.window.document.querySelector("aside")?.style.zIndex).toBe("1");
    const underlayFrame = server.dom.window.document.querySelector<HTMLIFrameElement>('iframe[data-codex-experience-target="app-shell"][data-codex-experience-plane="underlay"]')!;
    const overlayFrame = server.dom.window.document.querySelector<HTMLIFrameElement>('iframe[data-codex-experience-target="app-shell"][data-codex-experience-plane="overlay"]')!;
    const channel = underlayFrame.dataset.codexExperienceChannel;
    expect(channel).toBeTruthy();
    const relayed = new Promise<unknown>((resolve) => overlayFrame.contentWindow?.addEventListener("message", (event) => resolve(event.data), { once: true }));
    server.dom.window.dispatchEvent(new server.dom.window.MessageEvent("message", {
      source: underlayFrame.contentWindow,
      data: { source: "codex-experience-browser-v1", channel, type: "signal", payload: { name: "scene", payload: { visible: false } } },
    }));
    await expect(relayed).resolves.toMatchObject({
      type: "signal",
      payload: {
        name: "scene",
        payload: { visible: false },
        source: {
          target: "app-shell",
          plane: "underlay",
          bounds: { x: expect.any(Number), y: expect.any(Number), width: expect.any(Number), height: expect.any(Number) },
        },
      },
    });
    await expect(target.probe()).resolves.toEqual({ projectId: "cdp.portal", digest: payload.digest });
    await target.patchTokens(generateAppearanceTokens({ seed: "#008577" }).modes, "dark");
    await target.cancel(receipt);
    expect(server.scripts.size).toBe(0);
    expect(server.dom.window.document.querySelectorAll('iframe[data-codex-experience-target]')).toHaveLength(0);
    expect(server.dom.window.document.querySelector("aside")?.style.zIndex).toBe("");
    expect(server.dom.window.document.body.style.isolation).toBe("");
    await expect(target.probe()).resolves.toBeNull();
  });

  it("does not message a srcdoc surface before its renderer context is ready", async () => {
    const server = new SimulatedCdpServer({ rejectPrematureFrameMessaging: true });
    const premature = server.dom.window.document.createElement("iframe");
    premature.srcdoc = "<!doctype html><p>initializing</p>";
    server.dom.window.document.body.append(premature);
    expect(() => premature.contentWindow).toThrow("Premature iframe contentWindow access");
    premature.remove();
    const url = await server.start(); close.push(() => server.close());
    const target = new ExperienceProjectCdpTarget(url); close.push(() => target.close());
    const payload = {
      manifest: {
        apiVersion: 1 as const,
        id: "cdp.frame-readiness",
        name: "CDP Frame Readiness",
        version: "1.0.0",
        entry: "index.html" as const,
        permissions: ["appearance.tokens" as const, "codex.context.active" as const, "codex.events.lifecycle" as const],
      },
      html: '<!doctype html><html><body><codex-experience-surface target="app-shell" plane="underlay"><div>Deferred context</div></codex-experience-surface></body></html>',
      digest: "9".repeat(64),
      surfaces: [{ target: "app-shell" as const, plane: "underlay" as const, interaction: "passthrough" as const }],
      appearance: "light" as const,
      tokens: generateAppearanceTokens({ seed: "#6750A4" }).modes,
    };

    const receipt = await target.apply(payload, new AbortController().signal);
    await target.cancel(receipt);
  });

  it("applies while animation frames are suspended by the Electron host", async () => {
    const server = new SimulatedCdpServer({ suspendAnimationFrames: true });
    const url = await server.start(); close.push(() => server.close());
    const target = new ExperienceProjectCdpTarget(url, { requestTimeoutMs: 100 }); close.push(() => target.close());
    const payload = {
      manifest: {
        apiVersion: 1 as const,
        id: "cdp.suspended-frames",
        name: "CDP Suspended Frames",
        version: "1.0.0",
        entry: "index.html" as const,
        permissions: ["appearance.tokens" as const, "codex.context.active" as const],
      },
      html: '<!doctype html><html><body><codex-experience-surface target="app-shell" plane="overlay"><div>Frame-independent apply</div></codex-experience-surface></body></html>',
      digest: "8".repeat(64),
      surfaces: [{ target: "app-shell" as const, plane: "overlay" as const, interaction: "passthrough" as const }],
      appearance: "light" as const,
      tokens: generateAppearanceTokens({ seed: "#6750A4" }).modes,
    };

    const receipt = await target.apply(payload, new AbortController().signal);
    await target.cancel(receipt);
  });

  it("keeps route-specific and transient surfaces pending until semantic targets exist", async () => {
    const server = new SimulatedCdpServer();
    const url = await server.start(); close.push(() => server.close());
    const target = new ExperienceProjectCdpTarget(url); close.push(() => target.close());
    const tokens = generateAppearanceTokens({ seed: "#6750A4" }).modes;
    const surfaces = [
      { target: "app-shell" as const, plane: "overlay" as const, interaction: "passthrough" as const },
      { target: "floating-window" as const, plane: "overlay" as const, interaction: "scoped" as const },
      { target: "home" as const, plane: "underlay" as const, interaction: "passthrough" as const },
      { target: "home" as const, plane: "overlay" as const, interaction: "interactive" as const },
      { target: "conversation" as const, plane: "overlay" as const, interaction: "passthrough" as const },
      { target: "composer" as const, plane: "overlay" as const, interaction: "passthrough" as const },
      { target: "modal" as const, plane: "overlay" as const, interaction: "passthrough" as const },
    ];
    const payload = {
      manifest: { apiVersion: 1 as const, id: "cdp.routes", name: "CDP Routes", version: "1.0.0", entry: "index.html" as const, permissions: ["appearance.tokens" as const] },
      html: `<!doctype html><html><body>${surfaces.map((surface) => `<codex-experience-surface target="${surface.target}" plane="${surface.plane}" interaction="${surface.interaction}">${surface.plane === "overlay" && surface.target === "home" ? '<button type="button">Experience action</button>' : ""}</codex-experience-surface>`).join("")}</body></html>`,
      digest: "c".repeat(64), surfaces, appearance: "light" as const, tokens,
    };
    const mountedKeys = () => [...server.dom.window.document.querySelectorAll<HTMLIFrameElement>('iframe[data-codex-experience-target]')]
      .map((frame) => `${frame.dataset.codexExperiencePlane}:${frame.dataset.codexExperienceTarget}`).sort();
    const settle = () => new Promise<void>((resolve) => server.dom.window.setTimeout(resolve, 10));

    const receipt = await target.apply(payload, new AbortController().signal);
    expect(mountedKeys()).toEqual(["overlay:app-shell", "overlay:composer", "overlay:conversation", "overlay:floating-window"]);
    expect(server.dom.window.document.querySelector<HTMLIFrameElement>('iframe[data-codex-experience-target="floating-window"]')?.style.zIndex).toBe("2147482000");
    const home = server.dom.window.document.createElement("section");
    const homeIcon = server.dom.window.document.createElement("span"); homeIcon.dataset.testid = "home-icon"; home.appendChild(homeIcon);
    const dialog = server.dom.window.document.createElement("div"); dialog.setAttribute("role", "dialog");
    server.dom.window.document.querySelector("[data-app-shell-main-content-layout]")!.append(home);
    server.dom.window.document.body.append(dialog);
    await settle();
    expect(mountedKeys()).toEqual(["overlay:app-shell", "overlay:composer", "overlay:conversation", "overlay:floating-window", "overlay:home", "overlay:modal", "underlay:home"]);
    const homeFrame = server.dom.window.document.querySelector<HTMLIFrameElement>('iframe[data-codex-experience-target="home"][data-codex-experience-plane="overlay"]');
    expect(homeFrame?.parentElement).toBe(server.dom.window.document.querySelector("[data-app-shell-main-content-layout]"));
    expect(homeFrame?.style.pointerEvents).toBe("auto");
    expect(homeFrame?.srcdoc).toContain('<button type="button">Experience action</button>');
    home.remove(); dialog.remove(); await settle();
    expect(mountedKeys()).toEqual(["overlay:app-shell", "overlay:composer", "overlay:conversation", "overlay:floating-window"]);
    await target.cancel(receipt);
    expect(mountedKeys()).toEqual([]);
  });

  it("limits a scoped overlay to its registered interaction regions", async () => {
    const server = new SimulatedCdpServer();
    const url = await server.start(); close.push(() => server.close());
    const target = new ExperienceProjectCdpTarget(url); close.push(() => target.close());
    const payload = {
      manifest: { apiVersion: 1 as const, id: "cdp.scoped", name: "CDP Scoped", version: "1.0.0", entry: "index.html" as const, permissions: [] },
      html: '<!doctype html><html><body><codex-experience-surface target="app-shell" plane="overlay" interaction="scoped"><button>Open</button></codex-experience-surface></body></html>',
      digest: "6".repeat(64),
      surfaces: [{ target: "app-shell" as const, plane: "overlay" as const, interaction: "scoped" as const }],
      appearance: "light" as const,
      tokens: generateAppearanceTokens({ seed: "#6750A4" }).modes,
    };
    const receipt = await target.apply(payload, new AbortController().signal);
    const frame = server.dom.window.document.querySelector<HTMLIFrameElement>('iframe[data-codex-experience-plane="overlay"]')!;
    const channel = frame.dataset.codexExperienceChannel;
    expect(frame.style.pointerEvents).toBe("none");
    expect(frame.style.clipPath).toBe("inset(0 100% 100% 0)");

    server.dom.window.dispatchEvent(new server.dom.window.MessageEvent("message", {
      source: frame.contentWindow,
      data: {
        source: "codex-experience-browser-v1",
        channel,
        type: "interaction",
        payload: { op: "regions", regions: [{ x: 10, y: 20, width: 80, height: 40 }, { x: 210, y: 120, width: 48, height: 48, shape: "circle" }, { x: 300, y: 60, width: 100, height: 50, shape: "rounded", radius: 14 }] },
      },
    }));
    expect(frame.style.pointerEvents).toBe("auto");
    expect(frame.style.clipPath).toContain("M 10 20 H 90 V 60 H 10 Z");
    expect(frame.style.clipPath).toContain("M 234 120 A 24 24 0 1 1 234 168 A 24 24 0 1 1 234 120 Z");
    expect(frame.style.clipPath).toContain("M 314 60 H 386 Q 400 60 400 74");

    server.dom.window.dispatchEvent(new server.dom.window.MessageEvent("message", {
      source: frame.contentWindow,
      data: { source: "codex-experience-browser-v1", channel, type: "interaction", payload: { op: "regions", regions: [] } },
    }));
    expect(frame.style.pointerEvents).toBe("none");
    await target.cancel(receipt);
  });

  it("mounts and removes a host-managed remote WebView through the CDP injection bridge", async () => {
    const server = new SimulatedCdpServer();
    Object.defineProperty(server.dom.window.HTMLIFrameElement.prototype, "credentialless", {
      configurable: true,
      writable: true,
      value: false,
    });
    const url = await server.start(); close.push(() => server.close());
    const target = new ExperienceProjectCdpTarget(url); close.push(() => target.close());
    const tokens = generateAppearanceTokens({ seed: "#6750A4" }).modes;
    const surface = { target: "app-shell" as const, plane: "overlay" as const, interaction: "interactive" as const };
    const payload = {
      manifest: {
        apiVersion: 1 as const,
        id: "cdp.webview",
        name: "CDP WebView",
        version: "1.0.0",
        entry: "index.html" as const,
        permissions: ["remote.webview" as const],
        webviews: { allowedOrigins: ["https://example.com"] },
      },
      html: '<!doctype html><html><body><codex-experience-surface target="app-shell" plane="overlay" interaction="interactive"></codex-experience-surface></body></html>',
      digest: "d".repeat(64),
      surfaces: [surface],
      appearance: "light" as const,
      tokens,
    };

    const receipt = await target.apply(payload, new AbortController().signal);
    const experienceFrame = server.dom.window.document.querySelector<HTMLIFrameElement>('iframe[data-codex-experience-target="app-shell"]')!;
    const channel = experienceFrame.dataset.codexExperienceChannel;
    expect(channel).toBeTruthy();
    server.dom.window.dispatchEvent(new server.dom.window.MessageEvent("message", {
      source: experienceFrame.contentWindow,
      data: {
        source: "codex-experience-browser-v1",
        channel,
        type: "webview",
        payload: {
          op: "mount",
          id: "webview-1",
          url: "https://example.com/interactive",
          title: "Interactive remote page",
          rect: { x: 12, y: 18, width: 480, height: 320, visible: true },
        },
      },
    }));

    const managed = server.dom.window.document.querySelector<HTMLIFrameElement>('iframe[data-codex-experience-webview-host="webview-1"]');
    expect(managed).not.toBeNull();
    expect(managed?.parentElement).toBe(server.dom.window.document.body);
    expect(managed?.style.left).toBe("12px");
    expect(managedDocument(managed)).toContain('src="https://example.com/interactive"');
    await target.cancel(receipt);
    expect(server.dom.window.document.querySelector('[data-codex-experience-webview-host]')).toBeNull();
  });

  it("enforces the unrestricted host grant and removes package frame restrictions only after consent", async () => {
    const server = new SimulatedCdpServer();
    const url = await server.start(); close.push(() => server.close());
    const target = new ExperienceProjectCdpTarget(url); close.push(() => target.close());
    const tokens = generateAppearanceTokens({ seed: "#6750A4" }).modes;
    const surface = { target: "app-shell" as const, plane: "overlay" as const, interaction: "interactive" as const };
    const payload = {
      manifest: {
        apiVersion: 1 as const,
        id: "cdp.unrestricted",
        name: "CDP Unrestricted",
        version: "1.0.0",
        entry: "index.html" as const,
        permissions: ["remote.webview" as const],
        webviews: { securityMode: "unrestricted" as const },
      },
      html: '<!doctype html><html><body><codex-experience-surface target="app-shell" plane="overlay" interaction="interactive"></codex-experience-surface></body></html>',
      digest: "e".repeat(64),
      surfaces: [surface],
      appearance: "light" as const,
      tokens,
    };
    await expect(target.apply(payload, new AbortController().signal)).rejects.toThrow("explicit host grant");
    const receipt = await target.apply({ ...payload, allowUnrestrictedRemoteContent: true }, new AbortController().signal);
    const experienceFrame = server.dom.window.document.querySelector<HTMLIFrameElement>('[data-codex-experience-target="app-shell"]')!;
    const channel = experienceFrame.dataset.codexExperienceChannel;
    server.dom.window.dispatchEvent(new server.dom.window.MessageEvent("message", {
      source: experienceFrame.contentWindow,
      data: {
        source: "codex-experience-browser-v1",
        channel,
        type: "webview",
        payload: {
          op: "mount",
          id: "webview-1",
          url: "http://untrusted.example/path",
          title: "Unrestricted page",
          rect: { x: 0, y: 0, width: 400, height: 300, visible: true },
        },
      },
    }));
    const wrapper = server.dom.window.document.querySelector<HTMLIFrameElement>('[data-codex-experience-webview-host="webview-1"]')!;
    expect(wrapper).not.toBeNull();
    expect(wrapper.hasAttribute("sandbox")).toBe(false);
    expect(wrapper.src).toBe("http://untrusted.example/path");
    expect(wrapper.getAttribute("allow")).toContain("camera *; microphone *");
    await target.cancel(receipt);
  });

  it("publishes selected-thread changes and background completion through the sanitized runtime bridge", async () => {
    const server = new SimulatedCdpServer();
    const navigation = server.dom.window.document.querySelector("aside")!;
    const first = server.dom.window.document.createElement("a");
    first.href = "/thread/thread-a";
    first.setAttribute("aria-current", "page");
    first.dataset.status = "idle";
    const second = server.dom.window.document.createElement("a");
    second.href = "/thread/thread-b";
    second.dataset.status = "working";
    navigation.append(first, second);
    const url = await server.start(); close.push(() => server.close());
    const target = new ExperienceProjectCdpTarget(url); close.push(() => target.close());
    const payload = {
      manifest: {
        apiVersion: 1 as const,
        id: "cdp.context",
        name: "CDP Context",
        version: "1.0.0",
        entry: "index.html" as const,
        permissions: ["codex.context.active" as const, "codex.context.metadata" as const, "codex.events.lifecycle" as const],
      },
      html: '<!doctype html><html><body><codex-experience-surface target="app-shell" plane="overlay"></codex-experience-surface></body></html>',
      digest: "f".repeat(64),
      surfaces: [{ target: "app-shell" as const, plane: "overlay" as const, interaction: "passthrough" as const }],
      appearance: "light" as const,
      tokens: generateAppearanceTokens({ seed: "#6750A4" }).modes,
    };
    const receipt = await target.apply(payload, new AbortController().signal);
    await expect(target.getCodexContext()).resolves.toMatchObject({
      connection: { state: "connected", provider: "codex-renderer-cdp" },
      activeThreadId: "thread-a",
      threads: expect.arrayContaining([
        expect.objectContaining({ threadId: "thread-a", active: true }),
        expect.objectContaining({ threadId: "thread-b", status: "working", active: false }),
      ]),
    });

    const frame = server.dom.window.document.querySelector<HTMLIFrameElement>('iframe[data-codex-experience-target="app-shell"]')!;
    const completed = new Promise<unknown>((resolve) => frame.contentWindow?.addEventListener("message", (event) => {
      const data = event.data as { type?: string; payload?: { type?: string } };
      if (data.type === "codex-event" && data.payload?.type === "turnCompleted") resolve(data.payload);
    }));
    second.dataset.status = "completed";
    await expect(completed).resolves.toMatchObject({ type: "turnCompleted", threadId: "thread-b", outcome: "completed" });

    first.removeAttribute("aria-current");
    second.setAttribute("aria-current", "page");
    await new Promise<void>((resolve) => server.dom.window.setTimeout(resolve, 20));
    await expect(target.getCodexContext()).resolves.toMatchObject({ activeThreadId: "thread-b" });
    const currentCodexRow = server.dom.window.document.createElement("div");
    currentCodexRow.setAttribute("role", "button");
    currentCodexRow.setAttribute("aria-current", "page");
    currentCodexRow.dataset.appActionSidebarThreadId = "local:019fd5c5-4526-7513-b0f4-557019f16fbf";
    currentCodexRow.dataset.appActionSidebarThreadSelected = "true";
    currentCodexRow.dataset.appActionSidebarThreadTitle = "换皮肤";
    const workingIndicator = server.dom.window.document.createElement("span");
    workingIndicator.className = "animate-spin";
    currentCodexRow.append(workingIndicator);
    second.removeAttribute("aria-current");
    navigation.prepend(currentCodexRow);
    await new Promise<void>((resolve) => server.dom.window.setTimeout(resolve, 20));
    await expect(target.getCodexContext()).resolves.toMatchObject({
      activeThreadId: "019fd5c5-4526-7513-b0f4-557019f16fbf",
      threads: expect.arrayContaining([expect.objectContaining({ threadId: "019fd5c5-4526-7513-b0f4-557019f16fbf", displayName: "换皮肤", status: "working" })]),
    });
    await target.patchCodexContext({
      connection: { state: "connected", provider: "simulated-app-server", updatedAt: 10 },
      activeThreadId: null,
      threads: [
        { threadId: "thread-a", sessionId: "session-a", status: "completed", active: false, unread: true, updatedAt: 10 },
        { threadId: "thread-b", sessionId: "session-b", status: "idle", active: false, unread: false, updatedAt: 10 },
      ],
    });
    await expect(target.getCodexContext()).resolves.toMatchObject({
      connection: { provider: "codex-renderer+simulated-app-server" },
      activeThreadId: "019fd5c5-4526-7513-b0f4-557019f16fbf",
      threads: expect.arrayContaining([expect.objectContaining({ threadId: "thread-a", unread: true })]),
    });
    await target.cancel(receipt);
  });

  it("maps home and local-thread new-window actions to fixed Codex native routes without exposing Electron", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const server = new SimulatedCdpServer();
    const messages: unknown[] = [];
    Object.defineProperty(server.dom.window, "electronBridge", {
      configurable: true,
      value: { sendMessageFromView: async (message: unknown) => { messages.push(message); } },
    });
    const url = await server.start(); close.push(() => server.close());
    const target = new ExperienceProjectCdpTarget(url); close.push(() => target.close());
    const payload = {
      manifest: { apiVersion: 1 as const, id: "cdp.action", name: "CDP Action", version: "1.0.0", entry: "index.html" as const, permissions: ["host.actions" as const] },
      html: '<!doctype html><html><body><codex-experience-surface target="app-shell" plane="overlay" interaction="scoped"><button>New window</button></codex-experience-surface></body></html>',
      digest: "3".repeat(64),
      surfaces: [{ target: "app-shell" as const, plane: "overlay" as const, interaction: "scoped" as const }],
      appearance: "light" as const,
      tokens: generateAppearanceTokens({ seed: "#6750A4" }).modes,
    };
    const receipt = await target.apply(payload, new AbortController().signal);
    const frame = server.dom.window.document.querySelector<HTMLIFrameElement>('iframe[data-codex-experience-plane="overlay"]')!;
    server.dom.window.dispatchEvent(new server.dom.window.MessageEvent("message", {
      source: frame.contentWindow,
      data: {
        source: "codex-experience-browser-v1",
        channel: frame.dataset.codexExperienceChannel,
        type: "action",
        payload: { name: "codex.window.open" },
      },
    }));
    server.dom.window.dispatchEvent(new server.dom.window.MessageEvent("message", {
      source: frame.contentWindow,
      data: {
        source: "codex-experience-browser-v1",
        channel: frame.dataset.codexExperienceChannel,
        type: "action",
        payload: { name: "codex.window.open", payload: { threadId: "019fd5c5-4526-7513-b0f4-557019f16fbf" } },
      },
    }));
    server.dom.window.dispatchEvent(new server.dom.window.MessageEvent("message", {
      source: frame.contentWindow,
      data: {
        source: "codex-experience-browser-v1",
        channel: frame.dataset.codexExperienceChannel,
        type: "action",
        payload: { name: "codex.window.open", payload: { threadId: "../../settings" } },
      },
    }));
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(messages).toEqual([
      { type: "open-in-new-window", path: "/" },
      { type: "open-in-new-window", path: "/local/019fd5c5-4526-7513-b0f4-557019f16fbf" },
    ]);
    expect(error).toHaveBeenCalledWith("Codex Experience action: codex.window.open requires a Codex local thread UUID");
    await target.cancel(receipt);
  });

  it("maps the isolated-instance action only to the randomized package-owned binding", async () => {
    const server = new SimulatedCdpServer();
    const calls: string[] = [];
    Object.defineProperty(server.dom.window, "isolatedCodexBinding", {
      configurable: true,
      value: (payload: string) => { calls.push(payload); },
    });
    const url = await server.start(); close.push(() => server.close());
    const target = new ExperienceProjectCdpTarget(url); close.push(() => target.close());
    const payload = {
      manifest: { apiVersion: 1 as const, id: "cdp.isolated", name: "CDP Isolated", version: "1.0.0", entry: "index.html" as const, permissions: ["host.actions" as const, "codex.instance.configure" as const, "codex.conversations.sync" as const] },
      html: '<!doctype html><html><body><codex-experience-surface target="app-shell" plane="overlay" interaction="scoped"><button>Isolated instance</button></codex-experience-surface></body></html>',
      digest: "4".repeat(64),
      surfaces: [{ target: "app-shell" as const, plane: "overlay" as const, interaction: "scoped" as const }],
      appearance: "light" as const,
      tokens: generateAppearanceTokens({ seed: "#6750A4" }).modes,
    };
    const plan = buildExperienceProjectCdpPlan(payload, { nativeActionBinding: "isolatedCodexBinding" });
    server.dom.window.eval(`globalThis.__codexExperienceStageV2={documentHtml:${JSON.stringify(plan.documentHtml)}}`);
    server.dom.window.eval(plan.hostSource);
    const frame = server.dom.window.document.querySelector<HTMLIFrameElement>('iframe[data-codex-experience-plane="overlay"]')!;
    server.dom.window.dispatchEvent(new server.dom.window.MessageEvent("message", {
      source: frame.contentWindow,
      data: {
        source: "codex-experience-browser-v1",
        channel: frame.dataset.codexExperienceChannel,
        type: "action",
        payload: { name: "codex.instance.open-isolated", payload: { executable: "/bin/sh", args: ["-c", "id"] } },
      },
    }));
    server.dom.window.dispatchEvent(new server.dom.window.MessageEvent("message", {
      source: frame.contentWindow,
      data: {
        source: "codex-experience-browser-v1",
        channel: frame.dataset.codexExperienceChannel,
        type: "action",
        payload: { name: "codex.instance.sync-conversations", payload: { source: "/tmp/attacker", destination: "/tmp/attacker-2" } },
      },
    }));
    server.dom.window.dispatchEvent(new server.dom.window.MessageEvent("message", {
      source: frame.contentWindow,
      data: {
        source: "codex-experience-browser-v1",
        channel: frame.dataset.codexExperienceChannel,
        type: "action",
        payload: { name: "codex.instance.transfer-catalog", payload: { requestId: "catalog-1", source: "/tmp/attacker" } },
      },
    }));
    server.dom.window.dispatchEvent(new server.dom.window.MessageEvent("message", {
      source: frame.contentWindow,
      data: {
        source: "codex-experience-browser-v1",
        channel: frame.dataset.codexExperienceChannel,
        type: "action",
        payload: { name: "codex.instance.open-configured", payload: { requestId: "open-1", selectedItemIds: ["config", "conversations"], selectedConversationThreadIds: ["thread-1"], destination: "/tmp/attacker" } },
      },
    }));
    const channel = frame.dataset.codexExperienceChannel;
    expect(calls.map((value) => JSON.parse(value))).toEqual([
      { action: "codex.instance.open-isolated", slot: "secondary" },
      { action: "codex.instance.sync-conversations", slot: "secondary" },
      { action: "codex.instance.transfer-catalog", slot: "secondary", requestId: "catalog-1", channel },
      { action: "codex.instance.open-configured", slot: "secondary", requestId: "open-1", channel, selectedItemIds: ["config", "conversations"], selectedConversationThreadIds: ["thread-1"] },
    ]);
    const postMessage = vi.spyOn(frame.contentWindow!, "postMessage");
    server.dom.window.dispatchEvent(new server.dom.window.MessageEvent("message", {
      source: frame.contentWindow,
      data: { source: "codex-experience-browser-v1", channel, type: "ready" },
    }));
    server.dom.window.dispatchEvent(new server.dom.window.CustomEvent("isolatedCodexBindingResult", {
      detail: { requestId: "catalog-1", channel, action: "codex.instance.transfer-catalog", status: "ok", result: { items: [] } },
    }));
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: "signal",
      payload: expect.objectContaining({ name: "codex.instance.result", payload: expect.objectContaining({ requestId: "catalog-1" }) }),
    }), "*");
    server.dom.window.eval("globalThis.__codexExperienceRuntimeV2.cancel()");
  });
});
