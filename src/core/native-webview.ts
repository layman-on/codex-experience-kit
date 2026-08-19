import type { ExperiencePlane, ExperienceTarget } from "./experience-project.js";

export const EXPERIENCE_NATIVE_WEBVIEW_BACKENDS = ["iframe", "electron-webcontents-view"] as const;
export type ExperienceNativeWebviewBackend = (typeof EXPERIENCE_NATIVE_WEBVIEW_BACKENDS)[number];

export interface ExperienceNativeWebviewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ExperienceNativeWebviewSurface {
  channel: string;
  target: ExperienceTarget;
  plane: ExperiencePlane;
}

interface ExperienceNativeWebviewCommandBase extends ExperienceNativeWebviewSurface {
  id: string;
}

export type ExperienceNativeWebviewCommand =
  | (ExperienceNativeWebviewCommandBase & {
      op: "mount";
      url: string;
      title: string;
      bounds: ExperienceNativeWebviewBounds;
      visible: boolean;
    })
  | (ExperienceNativeWebviewCommandBase & {
      op: "layout";
      bounds: ExperienceNativeWebviewBounds;
      visible: boolean;
    })
  | (ExperienceNativeWebviewCommandBase & { op: "navigate"; url: string })
  | (ExperienceNativeWebviewCommandBase & { op: "reload" })
  | (ExperienceNativeWebviewCommandBase & { op: "destroy" });

/**
 * Renderer-to-host boundary for remote content. Implementations must validate
 * every command again in their privileged process.
 */
export interface ExperienceNativeWebviewTransport {
  readonly backend: "electron-webcontents-view";
  dispatch(command: ExperienceNativeWebviewCommand): void | Promise<void>;
}
