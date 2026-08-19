import type {
  ExperiencePlane,
  ExperienceProjectBundle,
  ExperienceSurfaceInteraction,
  ExperienceTarget,
} from "./experience-project.js";
import type { AppearanceTokenModes } from "./appearance-tokens.js";
import type { ExperienceNativeWebviewBackend } from "./native-webview.js";
import { disconnectedCodexContext, type CodexContextSnapshot } from "./codex-context.js";

export const EXPERIENCE_RUNTIME_MESSAGE = "codex-experience-browser-v1" as const;

export interface ExperienceViewConfiguration {
  mode: "preview" | "codex";
  target: ExperienceTarget;
  plane: ExperiencePlane;
  interaction?: ExperienceSurfaceInteraction;
  appearance: "light" | "dark";
  tokens: AppearanceTokenModes;
  channel: string;
  reducedMotion?: boolean;
  remoteContentBackend?: ExperienceNativeWebviewBackend;
  codexContext?: CodexContextSnapshot;
}

function safeJson(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

export function buildExperienceViewRuntimeScript(
  project: ExperienceProjectBundle,
  configuration: ExperienceViewConfiguration,
): string {
  const webviewOrigins = project.manifest.webviews?.allowedOrigins ?? [];
  const webviewSecurityMode = project.manifest.webviews?.securityMode ?? "strict";
  const value = safeJson({
    ...configuration,
    interaction: configuration.interaction ?? "passthrough",
    apiVersion: project.manifest.apiVersion,
    permissions: project.manifest.permissions,
    projectId: project.manifest.id,
    message: EXPERIENCE_RUNTIME_MESSAGE,
    webviewOrigins,
    webviewSecurityMode,
    remoteContentBackend: configuration.remoteContentBackend ?? "iframe",
    codexContext: configuration.codexContext ?? disconnectedCodexContext(configuration.mode === "preview" ? "synthetic-preview" : "codex-renderer"),
  });
  return `(()=>{
"use strict";
const c=${value};
const listeners={tokens:new Set(),signals:new Set(),lifecycle:new Set(),context:new Set(),events:new Set()};
const allowedWebviewOrigins=new Set(c.webviewOrigins);
let appearance=c.appearance;
let modes=c.tokens;
let codexContext=c.codexContext;
let interactionSequence=0;
const interactionEntries=new Map();
const has=(permission)=>c.permissions.includes(permission);
const variables=(tokens)=>{for(const[key,value]of Object.entries(tokens)){const css=key.replace(/[A-Z]/g,(letter)=>"-"+letter.toLowerCase());document.documentElement.style.setProperty("--cek-"+css,value)}};
const apply=()=>{document.documentElement.dataset.codexExperienceProject=c.projectId;document.documentElement.dataset.codexExperienceTarget=c.target;document.documentElement.dataset.codexExperiencePlane=c.plane;document.documentElement.dataset.codexExperienceAppearance=appearance;document.documentElement.style.colorScheme=appearance;variables(modes[appearance])};
const post=(type,payload)=>parent.postMessage({source:c.message,channel:c.channel,type,payload},"*");
const interactionRect=(entry)=>{const value=entry.element.getBoundingClientRect();const style=getComputedStyle(entry.element);const padding=entry.padding;const width=value.width+padding*2,height=value.height+padding*2;const radius=entry.shape==="rounded"?Math.max(0,Math.min((Number.parseFloat(style.borderTopLeftRadius)||0)+padding,width/2,height/2)):0;return{x:value.x-padding,y:value.y-padding,width,height,shape:entry.shape,radius,visible:entry.element.isConnected&&value.width>0&&value.height>0&&style.display!=="none"&&style.visibility!=="hidden"&&style.pointerEvents!=="none"}};
const publishInteractionRegions=()=>{if(c.interaction!=="scoped")return;post("interaction",{op:"regions",regions:[...interactionEntries.values()].map(interactionRect).filter(region=>region.visible).map(({visible,...region})=>region)})};
const registerInteraction=(element,options={})=>{
  if(c.plane!=="overlay"||c.interaction!=="scoped")throw new Error("interaction.register is available only in a scoped overlay");
  if(!(element instanceof HTMLElement)||!document.contains(element))throw new TypeError("Interaction element must be a mounted HTMLElement");
  const padding=options.padding===undefined?0:Number(options.padding);
  if(!Number.isFinite(padding)||padding<0||padding>64)throw new TypeError("Interaction padding must be between 0 and 64");
  const shape=options.shape===undefined?"rect":options.shape;
  if(shape!=="rect"&&shape!=="rounded"&&shape!=="circle")throw new TypeError("Interaction shape must be rect, rounded, or circle");
  const id=++interactionSequence;let destroyed=false;
  const refresh=()=>{if(!destroyed)publishInteractionRegions()};
  const resize=typeof ResizeObserver==="function"?new ResizeObserver(refresh):null;
  const mutation=typeof MutationObserver==="function"?new MutationObserver(refresh):null;
  interactionEntries.set(id,{element,padding,shape});resize?.observe(element);mutation?.observe(element,{attributes:true,attributeFilter:["class","hidden","style"]});
  addEventListener("resize",refresh);addEventListener("scroll",refresh,true);queueMicrotask(refresh);
  return Object.freeze({
    refresh,
    destroy(){if(destroyed)return;destroyed=true;resize?.disconnect();mutation?.disconnect();removeEventListener("resize",refresh);removeEventListener("scroll",refresh,true);interactionEntries.delete(id);publishInteractionRegions()}
  });
};
const webviewUrl=(input)=>{
  if(!has("remote.webview"))throw new Error("remote.webview permission is required");
  if(typeof input!=="string"||input.length<1||input.length>2048)throw new TypeError("WebView URL must contain 1 to 2048 characters");
  let url;try{url=new URL(input)}catch{throw new TypeError("WebView URL must be absolute HTTP or HTTPS URL text")}
  const supported=url.protocol==="https:"||(c.webviewSecurityMode!=="strict"&&url.protocol==="http:");
  if(!supported||url.username||url.password||(c.webviewSecurityMode==="strict"&&!allowedWebviewOrigins.has(url.origin)))throw new Error("WebView URL is not allowed by the project security policy");
  return url.href;
};
let webviewSequence=0;
const mountWebview=(container,options)=>{
  if(!has("remote.webview"))throw new Error("remote.webview permission is required");
  if(c.plane!=="overlay"||c.interaction!=="interactive")throw new Error("remote.webview is available only in an interactive overlay");
  if(!(container instanceof HTMLElement)||!document.contains(container))throw new TypeError("WebView container must be a mounted HTMLElement");
  if(!options||typeof options!=="object")throw new TypeError("WebView options are required");
  const primaryUrl=webviewUrl(options.url);
  const iframeFallbackUrl=options.iframeFallbackUrl===undefined?null:webviewUrl(options.iframeFallbackUrl);
  let url=c.remoteContentBackend==="iframe"&&iframeFallbackUrl?iframeFallbackUrl:primaryUrl;
  const title=typeof options.title==="string"&&options.title.trim()?options.title.trim().slice(0,100):"Remote content";
  const id="webview-"+(++webviewSequence);
  let destroyed=false;
  const active=()=>{if(destroyed||!container.isConnected)throw new Error("WebView has been destroyed")};
  const rect=()=>{const value=container.getBoundingClientRect();const style=getComputedStyle(container);return{x:value.x,y:value.y,width:value.width,height:value.height,visible:container.isConnected&&value.width>0&&value.height>0&&style.display!=="none"&&style.visibility!=="hidden"}};
  const send=(op,payload={})=>post("webview",{op,id,...payload});
  const layout=()=>{if(!destroyed)send("layout",{rect:rect()})};
  const resize=typeof ResizeObserver==="function"?new ResizeObserver(layout):null;
  resize?.observe(container);
  addEventListener("resize",layout);
  addEventListener("scroll",layout,true);
  send("mount",{url,title,rect:rect()});
  queueMicrotask(layout);
  return Object.freeze({
    navigate(next){active();url=webviewUrl(next);send("navigate",{url})},
    reload(){active();send("reload",{url})},
    destroy(){if(destroyed)return;destroyed=true;resize?.disconnect();removeEventListener("resize",layout);removeEventListener("scroll",layout,true);send("destroy")}
  });
};
const api=Object.freeze({
  apiVersion:1,
  environment:Object.freeze({mode:c.mode,target:c.target,plane:c.plane,remoteContentBackend:c.remoteContentBackend,get appearance(){return appearance},reducedMotion:Boolean(c.reducedMotion)}),
  tokens:Object.freeze({
    get:async()=>{if(!has("appearance.tokens"))throw new Error("appearance.tokens permission is required");return structuredClone(modes)},
    subscribe(listener){if(!has("appearance.tokens"))throw new Error("appearance.tokens permission is required");listeners.tokens.add(listener);return()=>listeners.tokens.delete(listener)}
  }),
  signals:Object.freeze({
    emit(name,payload){if(typeof name!=="string"||!name)throw new TypeError("Signal name is required");post("signal",{name,payload})},
    subscribe(listener){listeners.signals.add(listener);return()=>listeners.signals.delete(listener)}
  }),
  context:Object.freeze({
    getSnapshot:async()=>{if(!has("codex.context.active"))throw new Error("codex.context.active permission is required");return structuredClone(codexContext)},
    subscribe(listener){if(!has("codex.context.active"))throw new Error("codex.context.active permission is required");if(typeof listener!=="function")throw new TypeError("Context listener must be a function");listeners.context.add(listener);return()=>listeners.context.delete(listener)}
  }),
  events:Object.freeze({
    subscribe(listener){if(!has("codex.events.lifecycle"))throw new Error("codex.events.lifecycle permission is required");if(typeof listener!=="function")throw new TypeError("Event listener must be a function");listeners.events.add(listener);return()=>listeners.events.delete(listener)}
  }),
  assets:Object.freeze({url:async()=>{throw new Error("Package assets are compiled into the experience")}}),
  storage:Object.freeze({
    get:async()=>{throw new Error("Persistent experience storage is not available in Experience Runtime v1")},
    set:async()=>{throw new Error("Persistent experience storage is not available in Experience Runtime v1")},
    remove:async()=>{throw new Error("Persistent experience storage is not available in Experience Runtime v1")}
  }),
  webviews:Object.freeze({mount:mountWebview}),
  interaction:Object.freeze({register:registerInteraction}),
  actions:Object.freeze({emit:async(name,payload)=>{if(!has("host.actions"))throw new Error("host.actions permission is required");if(typeof name!=="string"||!name)throw new TypeError("Action name is required");post("action",{name,payload})}}),
  lifecycle:Object.freeze({
    ready:async()=>post("ready",{target:c.target,plane:c.plane}),
    subscribe(listener){listeners.lifecycle.add(listener);return()=>listeners.lifecycle.delete(listener)}
  })
});
Object.defineProperty(window,"codexExperience",{value:api,writable:false,configurable:false});
addEventListener("message",event=>{const data=event.data;if(!data||data.source!==c.message||data.channel!==c.channel)return;if(data.type==="tokens"){modes=data.payload;apply();for(const listener of listeners.tokens)listener({appearance,tokens:modes[appearance],modes:structuredClone(modes)})}else if(data.type==="appearance"){appearance=data.payload;apply();for(const listener of listeners.tokens)listener({appearance,tokens:modes[appearance],modes:structuredClone(modes)})}else if(data.type==="signal"){for(const listener of listeners.signals)listener(data.payload)}else if(data.type==="codex-context"){codexContext=data.payload;for(const listener of listeners.context)listener(structuredClone(codexContext))}else if(data.type==="codex-event"){for(const listener of listeners.events)listener(structuredClone(data.payload))}else if(data.type==="lifecycle"){for(const listener of listeners.lifecycle)listener(data.payload)}});
const mount=()=>{apply();document.documentElement.style.cssText+=";width:100%;height:100%;margin:0;background:transparent;overflow:hidden";document.body.style.cssText+=";width:100%;height:100%;margin:0;background:transparent;overflow:hidden";for(const node of document.querySelectorAll("codex-experience-surface")){const active=node.getAttribute("target")===c.target&&node.getAttribute("plane")===c.plane;node.style.display=active?"block":"none";if(active){node.style.position="absolute";node.style.inset="0";node.style.overflow="hidden"}}};
document.readyState==="loading"?addEventListener("DOMContentLoaded",mount,{once:true}):queueMicrotask(mount);
})()`;
}

function bootstrap(project: ExperienceProjectBundle, configuration: ExperienceViewConfiguration): string {
  const csp = "default-src 'none'; base-uri 'none'; object-src 'none'; frame-src 'none'; img-src data: blob:; media-src data: blob:; font-src data:; style-src 'unsafe-inline' data:; script-src 'unsafe-inline' data: blob:";
  return `<meta http-equiv="Content-Security-Policy" content="${csp}">
<script>${buildExperienceViewRuntimeScript(project, configuration)}</script>`;
}

export function buildExperienceViewHtml(project: ExperienceProjectBundle, configuration: ExperienceViewConfiguration): string {
  const injected = bootstrap(project, configuration);
  const head = /<head(?:\s[^>]*)?>/iu.exec(project.html);
  if (head?.index !== undefined) {
    const offset = head.index + head[0].length;
    return `${project.html.slice(0, offset)}${injected}${project.html.slice(offset)}`;
  }
  return `<!doctype html><html><head>${injected}</head><body>${project.html}</body></html>`;
}
