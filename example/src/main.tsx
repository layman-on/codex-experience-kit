import { createElement, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import Background from "./surfaces/background";
import TaskStatus from "./surfaces/task-status";

const components: Record<string, ComponentType> = {
  "underlay:app-shell": Background,
  "overlay:app-shell": TaskStatus,
};

const environment = window.codexExperience?.environment;
const key = environment ? `${environment.plane}:${environment.target}` : "";
const mount = document.querySelector<HTMLElement>(`[data-codex-experience-mount="${key}"]`);
const Component = components[key];

if (mount && Component) createRoot(mount).render(createElement(Component));
void window.codexExperience?.lifecycle.ready();
