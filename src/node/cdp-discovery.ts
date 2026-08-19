import { ExperienceKitError } from "../core/errors.js";

export interface CdpPageTargetInfo {
  id: string;
  type: "page";
  title: string;
  url: string;
  webSocketDebuggerUrl: string;
}

export interface ResolveCdpTargetOptions {
  timeoutMs?: number;
  allowRemote?: boolean;
  accept?: (target: CdpPageTargetInfo) => boolean;
  rank?: (target: CdpPageTargetInfo) => number;
}

function loopbackHost(hostname: string): boolean {
  return new Set(["127.0.0.1", "::1", "localhost"]).has(hostname.replace(/^\[|\]$/gu, ""));
}

function parsePageTarget(value: unknown): CdpPageTargetInfo | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  if (
    source.type !== "page" || typeof source.id !== "string" || typeof source.title !== "string"
    || typeof source.url !== "string" || typeof source.webSocketDebuggerUrl !== "string"
  ) return null;
  return source as unknown as CdpPageTargetInfo;
}

export async function resolveCdpPageWebSocketUrl(
  endpoint: string,
  options: ResolveCdpTargetOptions = {},
): Promise<string> {
  let base: URL;
  try {
    base = new URL(endpoint);
  } catch (error) {
    throw new ExperienceKitError("cdp/discovery-url", "CDP discovery endpoint is invalid", { cause: error });
  }
  if (!new Set(["http:", "https:"]).has(base.protocol)) {
    throw new ExperienceKitError("cdp/discovery-url", "CDP discovery must use http:// or https://");
  }
  if (!(options.allowRemote ?? false) && !loopbackHost(base.hostname)) {
    throw new ExperienceKitError("cdp/discovery-remote", "CDP discovery endpoint must be loopback");
  }
  const targetUrl = new URL("/json/list", base);
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(new DOMException("CDP discovery timed out", "TimeoutError")), options.timeoutMs ?? 3_000);
  try {
    const response = await fetch(targetUrl, { signal: abort.signal, redirect: "error", cache: "no-store" });
    if (!response.ok) throw new ExperienceKitError("cdp/discovery-http", `CDP discovery returned HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length < 2 || bytes.length > 1024 * 1024) throw new ExperienceKitError("cdp/discovery-size", "CDP target list has an invalid size");
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    if (!Array.isArray(value) || value.length > 64) throw new ExperienceKitError("cdp/discovery-shape", "CDP target list is invalid");
    const targets = value.map(parsePageTarget).filter((item): item is CdpPageTargetInfo => Boolean(item));
    const accepted = targets.filter(options.accept ?? (() => true));
    const target = options.rank
      ? accepted.reduce<CdpPageTargetInfo | null>((best, candidate) => {
        if (!best) return candidate;
        return options.rank!(candidate) > options.rank!(best) ? candidate : best;
      }, null)
      : accepted[0];
    if (!target) throw new ExperienceKitError("cdp/discovery-target", "No acceptable CDP page target was found");
    const socket = new URL(target.webSocketDebuggerUrl);
    if (!new Set(["ws:", "wss:"]).has(socket.protocol)) throw new ExperienceKitError("cdp/discovery-socket", "CDP target returned an invalid WebSocket URL");
    if (!(options.allowRemote ?? false) && !loopbackHost(socket.hostname)) {
      throw new ExperienceKitError("cdp/discovery-remote", "CDP target returned a non-loopback WebSocket URL");
    }
    return target.webSocketDebuggerUrl;
  } catch (error) {
    if (error instanceof ExperienceKitError) throw error;
    throw new ExperienceKitError("cdp/discovery", `Unable to discover CDP page target: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  } finally {
    clearTimeout(timer);
  }
}
