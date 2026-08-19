import type {
  CodexContextEvent,
  CodexContextSnapshot,
  ExperiencePlane,
  ExperienceTarget,
} from "codex-experience-kit/core";

export {};

declare global {
  interface Window {
    codexExperience?: {
      environment: {
        mode: "preview" | "codex";
        target: ExperienceTarget;
        plane: ExperiencePlane;
        appearance: "light" | "dark";
        reducedMotion: boolean;
      };
      lifecycle: { ready(): Promise<void> };
      context: {
        getSnapshot(): Promise<CodexContextSnapshot>;
        subscribe(listener: (snapshot: CodexContextSnapshot) => void): () => void;
      };
      events: {
        subscribe(listener: (event: CodexContextEvent) => void): () => void;
      };
      interaction: {
        register(
          element: HTMLElement,
          options?: { padding?: number; shape?: "rect" | "rounded" | "circle" },
        ): { refresh(): void; destroy(): void };
      };
    };
  }
}
