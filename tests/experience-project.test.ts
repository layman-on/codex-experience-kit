import { describe, expect, it } from "vitest";
import {
  discoverExperienceSurfaces,
  experienceWebviewRiskMetadata,
  parseExperienceProjectManifest,
} from "../src/core/public.js";

describe("Experience project contract", () => {
  it("validates a minimal manifest and derives explicit surfaces from HTML", () => {
    expect(parseExperienceProjectManifest({ apiVersion: 1, id: "author.portal", name: "Portal", version: "1.0.0", entry: "index.html", permissions: ["appearance.tokens"] })).toMatchObject({ id: "author.portal" });
    expect(discoverExperienceSurfaces('<codex-experience-surface target="app-shell" plane="overlay"></codex-experience-surface><codex-experience-surface target="navigation" plane="overlay" interaction="interactive"></codex-experience-surface>')).toEqual([
      { target: "app-shell", plane: "overlay", interaction: "passthrough" },
      { target: "navigation", plane: "overlay", interaction: "interactive" },
    ]);
    expect(discoverExperienceSurfaces('<codex-experience-surface target="app-shell" plane="overlay" interaction="scoped"></codex-experience-surface>')).toEqual([
      { target: "app-shell", plane: "overlay", interaction: "scoped" },
    ]);
    expect(discoverExperienceSurfaces('<codex-experience-surface target="floating-window" plane="overlay" interaction="scoped"></codex-experience-surface>')).toEqual([
      { target: "floating-window", plane: "overlay", interaction: "scoped" },
    ]);
    expect(() => discoverExperienceSurfaces('<codex-experience-surface target="floating-window" plane="overlay"></codex-experience-surface>')).toThrow("interactive or scoped overlay");
  });

  it("accepts explicit sanitized Codex context and lifecycle permissions", () => {
    expect(parseExperienceProjectManifest({
      apiVersion: 1,
      id: "author.contextual",
      name: "Contextual Portal",
      version: "1.0.0",
      entry: "index.html",
      permissions: ["codex.context.active", "codex.events.lifecycle"],
    }).permissions).toEqual(["codex.context.active", "codex.events.lifecycle"]);
  });

  it("requires base context access before exposing task display metadata", () => {
    const manifest = { apiVersion: 1, id: "author.portal", name: "Portal", version: "1.0.0", entry: "index.html" };
    expect(() => parseExperienceProjectManifest({ ...manifest, permissions: ["codex.context.metadata"] })).toThrow("requires codex.context.active");
    expect(parseExperienceProjectManifest({
      ...manifest,
      permissions: ["codex.context.active", "codex.context.metadata"],
    }).permissions).toEqual(["codex.context.active", "codex.context.metadata"]);
  });

  it("requires explicit host actions for isolated-instance configuration and conversation sync", () => {
    const manifest = { apiVersion: 1, id: "author.portal", name: "Portal", version: "1.0.0", entry: "index.html" };
    expect(() => parseExperienceProjectManifest({ ...manifest, permissions: ["codex.instance.configure"] })).toThrow("requires host.actions");
    expect(() => parseExperienceProjectManifest({ ...manifest, permissions: ["codex.conversations.sync"] })).toThrow("requires host.actions");
    expect(parseExperienceProjectManifest({
      ...manifest,
      permissions: ["host.actions", "codex.instance.configure", "codex.conversations.sync"],
    }).permissions).toEqual(["host.actions", "codex.instance.configure", "codex.conversations.sync"]);
  });

  it("allows matching underlay and overlay planes while keeping underlay non-interactive", () => {
    expect(discoverExperienceSurfaces('<codex-experience-surface target="home" plane="underlay"></codex-experience-surface><codex-experience-surface target="home" plane="overlay" interaction="interactive"></codex-experience-surface>')).toEqual([
      { target: "home", plane: "underlay", interaction: "passthrough" },
      { target: "home", plane: "overlay", interaction: "interactive" },
    ]);
    expect(() => discoverExperienceSurfaces('<codex-experience-surface target="app-shell" plane="underlay" interaction="interactive"></codex-experience-surface>')).toThrow("must use passthrough");
    expect(() => discoverExperienceSurfaces('<codex-experience-surface target="app-shell" plane="underlay" interaction="scoped"></codex-experience-surface>')).toThrow("must use passthrough");
    expect(() => discoverExperienceSurfaces('<codex-experience-surface target="app-shell" plane="middle"></codex-experience-surface>')).toThrow("invalid plane");
  });

  it("rejects unknown permissions, targets, implicit placement, and nested surfaces", () => {
    expect(() => parseExperienceProjectManifest({ apiVersion: 1, id: "author.portal", name: "Portal", version: "1.0.0", entry: "index.html", permissions: ["network"] })).toThrow("unsupported permission");
    expect(() => discoverExperienceSurfaces('<codex-experience-surface target="unknown" plane="overlay"></codex-experience-surface>')).toThrow("Unsupported experience target");
    expect(() => discoverExperienceSurfaces('<codex-experience-surface target="app-shell"></codex-experience-surface>')).toThrow("invalid plane");
    expect(() => discoverExperienceSurfaces('<codex-experience-surface target="app-shell" plane="overlay"><codex-experience-surface target="workspace" plane="overlay"></codex-experience-surface></codex-experience-surface>')).toThrow("must not be nested");
  });

  it("requires an exact HTTPS origin allowlist for remote WebViews", () => {
    expect(parseExperienceProjectManifest({
      apiVersion: 1,
      id: "author.portal",
      name: "Portal",
      version: "1.0.0",
      entry: "index.html",
      permissions: ["remote.webview"],
      webviews: { allowedOrigins: ["https://www.baidu.com", "https://example.com:8443"] },
    })).toMatchObject({
      permissions: ["remote.webview"],
      webviews: { securityMode: "strict", allowedOrigins: ["https://www.baidu.com", "https://example.com:8443"] },
    });

    const base = { apiVersion: 1, id: "author.portal", name: "Portal", version: "1.0.0", entry: "index.html" };
    expect(() => parseExperienceProjectManifest({ ...base, permissions: ["remote.webview"] })).toThrow("requires a webviews policy");
    expect(() => parseExperienceProjectManifest({ ...base, permissions: [], webviews: { allowedOrigins: ["https://example.com"] } })).toThrow("requires the remote.webview permission");
    expect(() => parseExperienceProjectManifest({ ...base, permissions: ["remote.webview"], webviews: { allowedOrigins: ["http://example.com"] } })).toThrow("exact HTTPS origin");
    expect(() => parseExperienceProjectManifest({ ...base, permissions: ["remote.webview"], webviews: { allowedOrigins: ["https://example.com/path"] } })).toThrow("exact HTTPS origin");
    expect(() => parseExperienceProjectManifest({ ...base, permissions: ["remote.webview"], webviews: { allowedOrigins: ["https://example.com", "https://example.com"] } })).toThrow("must be unique");
  });

  it("normalizes permissive and unrestricted remote policies and exposes their risks", () => {
    const base = { apiVersion: 1, id: "author.portal", name: "Portal", version: "1.0.0", entry: "index.html", permissions: ["remote.webview"] };
    const permissive = parseExperienceProjectManifest({ ...base, webviews: { securityMode: "permissive" } });
    const unrestricted = parseExperienceProjectManifest({ ...base, webviews: { securityMode: "unrestricted" } });
    expect(permissive.webviews).toEqual({ securityMode: "permissive" });
    expect(unrestricted.webviews).toEqual({ securityMode: "unrestricted" });
    expect(experienceWebviewRiskMetadata(permissive.webviews)).toMatchObject({ riskLevel: "medium", requiresHostGrant: false });
    expect(experienceWebviewRiskMetadata(unrestricted.webviews)).toMatchObject({
      riskLevel: "critical",
      requiresHostGrant: true,
      risks: expect.arrayContaining(["cookies", "downloads", "device-permissions", "host-dom-compromise"]),
    });
    expect(() => parseExperienceProjectManifest({
      ...base,
      webviews: { securityMode: "permissive", allowedOrigins: ["https://example.com"] },
    })).toThrow("available only in strict mode");
  });
});
