import { parse, serialize } from "parse5";
import { buildExperienceViewRuntimeScript, EXPERIENCE_RUNTIME_MESSAGE } from "../core/experience-runtime.js";
import { experienceSurfaceKey, type ExperienceProjectPayload } from "../core/experience-project.js";
import type { AppearanceTokenModes } from "../core/appearance-tokens.js";
import type { CodexContextEvent, CodexContextSnapshot } from "../core/codex-context.js";
import { CODEX_SELECTORS } from "./codex-runtime.js";

const RUNTIME_KEY = "__codexExperienceRuntimeV2";
const LEGACY_RUNTIME_KEY = "__codexExperienceRuntimeV1";
const STAGE_KEY = "__codexExperienceStageV2";

interface HtmlNode {
  nodeName?: string;
  tagName?: string;
  value?: string;
  attrs?: Array<{ name: string; value: string }>;
  childNodes?: HtmlNode[];
  content?: HtmlNode;
  parentNode?: HtmlNode;
}

interface CdpViewDefinition {
  target: string;
  plane: string;
  channel: string;
  frameName: string;
  interaction: string;
}

export interface ExperienceProjectCdpPlan {
  hostSource: string;
  documentHtml: string;
  childSources: ReadonlyMap<string, string>;
}

export interface ExperienceProjectCdpPlanOptions {
  nativeActionBinding?: string;
}

function splitExecutableScripts(html: string): { documentHtml: string; scripts: string[] } {
  const tree = parse(html) as unknown as HtmlNode;
  const scripts: string[] = [];
  const walk = (node: HtmlNode): void => {
    if (node.tagName === "script") {
      const attributes = new Map(node.attrs?.map((attribute) => [attribute.name, attribute.value]) ?? []);
      const type = (attributes.get("type") ?? "").trim().toLowerCase();
      const executable = type === "" || type === "text/javascript" || type === "application/javascript" || type === "module";
      if (executable) {
        if (attributes.has("src")) throw new Error("Compiled Experience scripts must be inline before CDP installation");
        if (type === "module") throw new Error("Module scripts must be bundled as a classic IIFE before CDP installation");
        scripts.push((node.childNodes ?? []).filter((child) => child.nodeName === "#text").map((child) => child.value ?? "").join(""));
        const parent = node.parentNode;
        if (!parent?.childNodes) throw new Error("Unable to detach an Experience script from index.html");
        parent.childNodes = parent.childNodes.filter((child) => child !== node);
        return;
      }
    }
    for (const child of [...(node.childNodes ?? []), ...(node.content?.childNodes ?? [])]) walk(child);
  };
  walk(tree);
  const csp = "default-src 'none'; base-uri 'none'; object-src 'none'; frame-src 'none'; img-src data: blob:; media-src data: blob:; font-src data:; style-src 'unsafe-inline' data:; script-src 'none'";
  const source = serialize(tree as never);
  const head = /<head(?:\s[^>]*)?>/iu.exec(source);
  const meta = `<meta http-equiv="Content-Security-Policy" content="${csp}">`;
  const documentHtml = head?.index === undefined
    ? `<!doctype html><html><head>${meta}</head><body>${source}</body></html>`
    : `${source.slice(0, head.index + head[0].length)}${meta}${source.slice(head.index + head[0].length)}`;
  return { documentHtml, scripts };
}

export function buildExperienceProjectCancelScript(): string {
  return `(()=>{for(const key of[${JSON.stringify(RUNTIME_KEY)},${JSON.stringify(LEGACY_RUNTIME_KEY)}]){const runtime=globalThis[key];if(runtime&&typeof runtime.cancel==="function")runtime.cancel()}delete globalThis[${JSON.stringify(STAGE_KEY)}];return{ok:true,activeProjectId:null}})()`;
}

export function buildExperienceProjectProbeScript(): string {
  return `(()=>{const runtime=globalThis[${JSON.stringify(RUNTIME_KEY)}];if(!runtime||typeof runtime.projectId!=="string")return null;return typeof runtime.probe==="function"?runtime.probe():{projectId:runtime.projectId,digest:runtime.digest}})()`;
}

export function buildExperienceProjectTokenPatchScript(tokens: AppearanceTokenModes, appearance?: "light" | "dark"): string {
  return `(()=>{const runtime=globalThis[${JSON.stringify(RUNTIME_KEY)}];if(!runtime||typeof runtime.setTokens!=="function")return{ok:false};runtime.setTokens(${JSON.stringify(tokens)}${appearance ? `,${JSON.stringify(appearance)}` : ""});return{ok:true,projectId:runtime.projectId}})()`;
}

export function buildExperienceProjectContextProbeScript(): string {
  return `(()=>{const runtime=globalThis[${JSON.stringify(RUNTIME_KEY)}];if(!runtime||typeof runtime.getCodexContext!=="function")return null;return runtime.getCodexContext()})()`;
}

export function buildExperienceProjectContextPatchScript(snapshot: CodexContextSnapshot): string {
  return `(()=>{const runtime=globalThis[${JSON.stringify(RUNTIME_KEY)}];if(!runtime||typeof runtime.setCodexContext!=="function")return{ok:false};runtime.setCodexContext(${JSON.stringify(snapshot)});return{ok:true,projectId:runtime.projectId}})()`;
}

export function buildExperienceProjectContextEventScript(event: CodexContextEvent, snapshot: CodexContextSnapshot): string {
  return `(()=>{const runtime=globalThis[${JSON.stringify(RUNTIME_KEY)}];if(!runtime||typeof runtime.emitCodexEvent!=="function")return{ok:false};runtime.emitCodexEvent(${JSON.stringify(event)},${JSON.stringify(snapshot)});return{ok:true,projectId:runtime.projectId}})()`;
}

export function buildExperienceProjectStageScript(): string {
  return `(()=>{const stage={};globalThis[${JSON.stringify(STAGE_KEY)}]=stage;return stage})()`;
}

export function buildExperienceProjectCdpPlan(
  payload: ExperienceProjectPayload,
  options: ExperienceProjectCdpPlanOptions = {},
): ExperienceProjectCdpPlan {
  if (payload.manifest.webviews?.securityMode === "unrestricted" && !payload.allowUnrestrictedRemoteContent) {
    throw new Error("Unrestricted remote content requires an explicit host grant");
  }
  const compiled = splitExecutableScripts(payload.html);
  const childSources = new Map<string, string>();
  const views = Object.fromEntries(payload.surfaces.map((surface, index) => {
    const key = experienceSurfaceKey(surface);
    const channel = `${payload.digest.slice(0, 16)}-${surface.plane}-${surface.target}-${index}`;
    const frameName = `codex-experience:${payload.digest.slice(0, 16)}:${index}`;
    const runtime = buildExperienceViewRuntimeScript(payload, {
        mode: "codex",
        target: surface.target,
        plane: surface.plane,
        interaction: surface.interaction,
        appearance: payload.appearance,
        tokens: payload.tokens,
        channel,
      });
    const install = `(()=>{"use strict";const install=()=>{${runtime};\n${compiled.scripts.join("\n;\n")}};document.readyState==="loading"?addEventListener("DOMContentLoaded",install,{once:true}):install()})()\n//# sourceURL=codex-experience://${payload.manifest.id}/${key}.js`;
    childSources.set(frameName, install);
    return [key, {
      target: surface.target,
      plane: surface.plane,
      channel,
      frameName,
      interaction: surface.interaction,
    } satisfies CdpViewDefinition];
  }));
  const hostSource = `(()=>{
    "use strict";
    const staged=globalThis[${JSON.stringify(STAGE_KEY)}];
    if(!staged||typeof staged.documentHtml!=="string")throw new Error("Experience document payload was not staged");
    const documentHtml=staged.documentHtml;
    delete globalThis[${JSON.stringify(STAGE_KEY)}];
    const project=${JSON.stringify({
    id: payload.manifest.id,
    digest: payload.digest,
    views,
    sandbox: payload.manifest.permissions.includes("remote.webview") ? "allow-scripts allow-forms" : "allow-scripts",
    webviewOrigins: payload.manifest.webviews?.allowedOrigins ?? [],
    webviewSecurityMode: payload.manifest.webviews?.securityMode ?? "strict",
    allowUnrestrictedRemoteContent: payload.allowUnrestrictedRemoteContent === true,
    permissions: payload.manifest.permissions,
    nativeActionBinding: options.nativeActionBinding ?? null,
    tokens: payload.tokens,
    appearance: payload.appearance,
  })};
    const runtimeKey=${JSON.stringify(RUNTIME_KEY)};
    globalThis[${JSON.stringify(LEGACY_RUNTIME_KEY)}]?.cancel?.();
    const message=${JSON.stringify(EXPERIENCE_RUNTIME_MESSAGE)};
    const selectors=${JSON.stringify(CODEX_SELECTORS)};
    globalThis[runtimeKey]?.cancel?.();

    const mounted=new Map();
    const webviews=new Map();
    const allowedWebviewOrigins=new Set(project.webviewOrigins);
    const webviewFrameSource=project.webviewSecurityMode==="strict"?(project.webviewOrigins.join(" ")||"&apos;none&apos;"):"https: http:";
    const originalPositions=new Map();
    const underlayOwners=new Map();
    let cancelled=false;
    let tokens=project.tokens;
    let appearance=project.appearance;
    const contextEnabled=project.permissions.includes("codex.context.active");
    const metadataEnabled=project.permissions.includes("codex.context.metadata");
    const eventsEnabled=project.permissions.includes("codex.events.lifecycle");
    let contextSequence=0;
    const activeTurns=new Map();
    let rendererContext={connection:{state:"connected",provider:"codex-renderer-cdp",updatedAt:Date.now()},activeThreadId:null,threads:[]};
    let hostContext=null;
    let codexContext=rendererContext;
    const all=(selector)=>{try{return[...document.querySelectorAll(selector)]}catch{return[]}};
    const first=(selector)=>all(selector)[0]||null;
    const main=()=>first(selectors.shellMain)||all("main,[role=main]").find(node=>!node.closest?.("[role=dialog]"))||null;
    const home=()=>{const marker=first(selectors.home);return marker?.closest?.("[data-app-shell-main-content-layout],main,[role=main]")||null};
    const target=(name)=>{
      if(name==="app-shell")return document.body||document.documentElement;
      if(name==="navigation")return first(selectors.leftPanel)||first("aside");
      if(name==="titlebar")return first(selectors.header)||main()?.querySelector?.("header")||null;
      if(name==="workspace")return main();
      if(name==="home")return home();
      if(name==="conversation")return first(selectors.thread)||first("[role=log]");
      if(name==="composer")return first(selectors.composer)||first("textarea")?.closest?.("form,div")||null;
      if(name==="modal")return first(selectors.dialog)||first(selectors.menu)||first(selectors.popper);
      if(name==="floating-window")return document.body||document.documentElement;
      return null;
    };
    const threadIdFromText=(value)=>{
      if(typeof value!=="string"||!value)return null;
      let decoded=value;try{decoded=decodeURIComponent(value)}catch{}
      const route=decoded.match(/\\/(?:thread|threads|task|tasks|conversation|conversations)\\/([A-Za-z0-9._:-]{1,200})(?:[/?#]|$)/iu);
      if(route?.[1])return route[1];
      const uuid=decoded.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/iu);
      return uuid?.[0]||null;
    };
    const threadIdFromElement=(element)=>{
      if(!(element instanceof Element))return null;
      for(const value of[element.getAttribute("data-app-action-sidebar-thread-id"),element.getAttribute("data-thread-id"),element.getAttribute("data-session-id"),element.getAttribute("href")]){const id=threadIdFromText(value);if(id)return id}
      return null;
    };
    const threadNameFromElement=(element)=>{
      if(!metadataEnabled||!(element instanceof Element))return null;
      for(const value of[element.getAttribute("data-app-action-sidebar-thread-title"),element.querySelector?.("[data-thread-title]")?.textContent,element.getAttribute("aria-label")]){if(typeof value!=="string")continue;const name=value.trim();if(name&&name.length<=256)return name}
      return null;
    };
    const threadStatus=(element)=>{
      if(!(element instanceof Element))return"unknown";
      if(element.getAttribute("aria-busy")==="true"||element.querySelector?.('[aria-busy="true"]'))return"working";
      if(element.querySelector?.('.animate-spin,[role="progressbar"],[data-loading="true"],[data-is-loading="true"]'))return"working";
      const descendants=[...element.querySelectorAll?.("[data-status],[aria-busy],[aria-label]")||[]];
      const value=[element,...descendants].flatMap(node=>[node.getAttribute?.("data-status"),node.getAttribute?.("aria-label")]).filter(Boolean).join(" ").toLowerCase();
      if(/working|running|in.?progress|generating|streaming/u.test(value))return"working";
      if(/waiting.?on.?approval|approval|permission|授权|批准|权限/u.test(value))return"waiting-approval";
      if(/waiting.?on.?user.?input|user.?input|input.?required|等待.*(?:输入|回复)|需要.*(?:输入|回复)/u.test(value))return"waiting-input";
      if(/waiting|等待/u.test(value))return"waiting";
      if(/failed|error/u.test(value))return"failed";
      if(/interrupt|cancel/u.test(value))return"interrupted";
      if(/complete|completed|done|idle/u.test(value))return"completed";
      return"unknown";
    };
    const selectedThreadId=()=>{
      const selected=first('[data-app-action-sidebar-thread-selected="true"][data-app-action-sidebar-thread-id],[data-app-action-sidebar-thread-id][aria-current="page"],a[aria-current="page"][href],a[aria-selected="true"][href],[data-thread-id][aria-selected="true"],[data-session-id][aria-selected="true"],a[data-state="active"][href]');
      return threadIdFromElement(selected)||threadIdFromText(location.href);
    };
    const sanitizedThread=(thread)=>{const next={...thread};if(!metadataEnabled)delete next.displayName;return next};
    const sanitizedEvent=(event)=>{
      if(metadataEnabled||!event||typeof event!=="object")return event;
      if(event.type==="activeThreadChanged")return{...event,thread:event.thread?sanitizedThread(event.thread):null};
      if(event.type==="threadStatusChanged")return{...event,thread:sanitizedThread(event.thread)};
      return event;
    };
    const mergeContext=()=>{
      if(!hostContext)return{connection:{...rendererContext.connection},activeThreadId:rendererContext.activeThreadId,threads:rendererContext.threads.map(sanitizedThread)};
      const activeThreadId=rendererContext.activeThreadId??hostContext.activeThreadId??null;
      const threads=new Map(rendererContext.threads.map(thread=>[thread.threadId,{...sanitizedThread(thread),active:false}]));
      for(const rawThread of hostContext.threads){const thread=sanitizedThread(rawThread);const current=threads.get(thread.threadId);threads.set(thread.threadId,{...(current||thread),...thread,active:false,unread:Boolean(thread.unread||current?.unread),updatedAt:Math.max(thread.updatedAt||0,current?.updatedAt||0)})}
      if(activeThreadId&&!threads.has(activeThreadId)){const active=rendererContext.threads.find(thread=>thread.threadId===activeThreadId)||hostContext.threads.find(thread=>thread.threadId===activeThreadId);if(active)threads.set(activeThreadId,{...active})}
      for(const thread of threads.values()){thread.active=thread.threadId===activeThreadId;if(thread.active)thread.unread=false}
      const states=[rendererContext.connection.state,hostContext.connection.state];const state=states.includes("connected")?"connected":states.includes("degraded")?"degraded":states.includes("connecting")?"connecting":"disconnected";
      return{connection:{state,provider:"codex-renderer+"+hostContext.connection.provider,updatedAt:Math.max(rendererContext.connection.updatedAt,hostContext.connection.updatedAt)},activeThreadId,threads:[...threads.values()]};
    };
    const cloneContext=()=>({connection:{...codexContext.connection},activeThreadId:codexContext.activeThreadId,threads:codexContext.threads.map(sanitizedThread)});
    // The sandboxed srcdoc is an opaque-origin OOPIF. Its author runtime is
    // installed through that child CDP target, and no cross-frame message is
    // sent until the child has explicitly completed lifecycle.ready().
    const broadcastContext=()=>{if(contextEnabled)for(const entry of mounted.values())if(entry.ready)post(entry,"codex-context",cloneContext())};
    const broadcastEvent=(event)=>{if(eventsEnabled)for(const entry of mounted.values())if(entry.ready)post(entry,"codex-event",sanitizedEvent(event))};
    const refreshCodexContext=()=>{
      if(!contextEnabled&&!eventsEnabled)return;
      const now=Date.now();
      const previous=codexContext;
      const previousRenderer=rendererContext;
      const activeThreadId=selectedThreadId();
      const byId=new Map(previousRenderer.threads.map(thread=>[thread.threadId,{...thread,active:false}]));
      const candidates=all('[data-app-action-sidebar-thread-id],[data-thread-id],[data-session-id],a[href*="/thread/"],a[href*="/threads/"],a[href*="/task/"],a[href*="/tasks/"]');
      for(const element of candidates){const threadId=threadIdFromElement(element);if(!threadId)continue;const prior=byId.get(threadId);const detectedStatus=threadStatus(element);const displayName=threadNameFromElement(element)??prior?.displayName??null;byId.set(threadId,{threadId,sessionId:prior?.sessionId??threadId,...(metadataEnabled?{displayName}:{}),status:detectedStatus==="unknown"?(prior?.status??"unknown"):detectedStatus,active:threadId===activeThreadId,unread:prior?.unread??false,updatedAt:prior?.updatedAt??now})}
      if(activeThreadId&&!byId.has(activeThreadId))byId.set(activeThreadId,{threadId:activeThreadId,sessionId:activeThreadId,...(metadataEnabled?{displayName:null}:{}),status:"idle",active:true,unread:false,updatedAt:now});
      for(const thread of byId.values()){thread.active=thread.threadId===activeThreadId;if(thread.active)thread.unread=false}
      rendererContext={connection:{state:"connected",provider:"codex-renderer-cdp",updatedAt:now},activeThreadId,threads:[...byId.values()]};
      codexContext=mergeContext();
      const previousById=new Map(previousRenderer.threads.map(thread=>[thread.threadId,thread]));
      const events=[];
      if(previous.activeThreadId!==activeThreadId){events.push({type:"activeThreadChanged",observedAt:now,previousThreadId:previous.activeThreadId,thread:activeThreadId?{...byId.get(activeThreadId)}:null})}
      for(const thread of codexContext.threads){const prior=previousById.get(thread.threadId);if(!prior||prior.status===thread.status)continue;thread.updatedAt=now;events.push({type:"threadStatusChanged",observedAt:now,previousStatus:prior.status,thread:{...thread}});if(prior.status!=="working"&&thread.status==="working"){const turnId="renderer-turn-"+(++contextSequence);activeTurns.set(thread.threadId,turnId);events.push({type:"turnStarted",observedAt:now,threadId:thread.threadId,sessionId:thread.sessionId,turnId,startedAt:now})}else if(prior.status==="working"&&thread.status!=="working"&&thread.status!=="waiting"){const turnId=activeTurns.get(thread.threadId)||"renderer-turn-"+(++contextSequence);activeTurns.delete(thread.threadId);const outcome=thread.status==="failed"?"failed":thread.status==="interrupted"?"interrupted":"completed";if(thread.threadId!==activeThreadId)thread.unread=true;events.push({type:"turnCompleted",observedAt:now,threadId:thread.threadId,sessionId:thread.sessionId,turnId,outcome,completedAt:now})}}
      broadcastContext();for(const event of events)broadcastEvent(event);
    };
    const ensurePosition=(owner,name)=>{
      if(name==="app-shell"||getComputedStyle(owner).position!=="static")return;
      if(!originalPositions.has(owner))originalPositions.set(owner,owner.style.position);
      owner.style.position="relative";
    };
    const prepareUnderlay=(owner)=>{
      let state=underlayOwners.get(owner);
      if(!state){state={isolation:owner.style.isolation,children:new Map()};underlayOwners.set(owner,state)}
      owner.style.isolation="isolate";
      for(const child of owner.children){
        if(!(child instanceof HTMLElement)||child.dataset.codexExperienceTarget)continue;
        if(!state.children.has(child))state.children.set(child,{position:child.style.position,zIndex:child.style.zIndex});
        const computed=getComputedStyle(child);
        if(computed.position==="static")child.style.position="relative";
        const z=Number.parseInt(computed.zIndex,10);
        if(computed.zIndex==="auto"||Number.isNaN(z)||z<=0)child.style.zIndex="1";
      }
    };
    const restoreUnderlay=(owner)=>{
      if([...mounted.values()].some(entry=>entry.plane==="underlay"&&entry.owner===owner))return;
      const state=underlayOwners.get(owner);
      if(!state)return;
      owner.style.isolation=state.isolation;
      for(const[child,styles]of state.children){child.style.position=styles.position;child.style.zIndex=styles.zIndex}
      state.children.clear();
      underlayOwners.delete(owner);
    };
    const post=(entry,type,payload)=>entry.frame.contentWindow?.postMessage({source:message,channel:entry.channel,type,payload},"*");
    const signalWithSource=(entry,payload)=>{
      if(!payload||typeof payload!=="object")return payload;
      const appOwner=target("app-shell");
      const appRect=appOwner?.getBoundingClientRect?.()||{x:0,y:0};
      const sourceRect=entry.frame.getBoundingClientRect();
      return{...payload,source:{target:entry.target,plane:entry.plane,bounds:{x:sourceRect.x-appRect.x,y:sourceRect.y-appRect.y,width:sourceRect.width,height:sourceRect.height}}};
    };
    const nativeResultEvent=project.nativeActionBinding?project.nativeActionBinding+"Result":null;
    const nativeResultListener=(event)=>{
      const detail=event?.detail;
      if(!detail||typeof detail!=="object"||typeof detail.channel!=="string"||typeof detail.requestId!=="string"||typeof detail.action!=="string")return;
      for(const entry of mounted.values())if(entry.ready&&entry.channel===detail.channel)post(entry,"signal",{name:"codex.instance.result",payload:detail});
    };
    if(nativeResultEvent)addEventListener(nativeResultEvent,nativeResultListener);
    const escapeHtml=(value)=>String(value).replace(/[&<>"']/g,character=>({38:"&amp;",60:"&lt;",62:"&gt;",34:"&quot;",39:"&#39;"})[character.charCodeAt(0)]);
    const webviewUrl=(value)=>{if(typeof value!=="string"||value.length<1||value.length>2048)throw new Error("Managed WebView URL is invalid");const url=new URL(value);const supported=url.protocol==="https:"||(project.webviewSecurityMode!=="strict"&&url.protocol==="http:");if(!supported||url.username||url.password||(project.webviewSecurityMode==="strict"&&!allowedWebviewOrigins.has(url.origin)))throw new Error("Managed WebView URL is not allowed by the project security policy");return url.href};
    const webviewRect=(value)=>{if(!value||typeof value!=="object")return null;const numbers=[value.x,value.y,value.width,value.height];if(!numbers.every(item=>typeof item==="number"&&Number.isFinite(item)&&Math.abs(item)<=100000)||value.width<0||value.height<0||typeof value.visible!=="boolean")return null;return{x:value.x,y:value.y,width:value.width,height:value.height,visible:value.visible}};
    const webviewAttributes=project.webviewSecurityMode==="unrestricted"?'loading="eager" allow="camera *; microphone *; geolocation *; clipboard-read *; clipboard-write *; fullscreen *"':'sandbox="allow-scripts allow-forms allow-same-origin" referrerpolicy="no-referrer" loading="eager" allow="" credentialless';
    const webviewDocument=(url,title)=>'<!doctype html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src &apos;none&apos;; base-uri &apos;none&apos;; object-src &apos;none&apos;; frame-src '+escapeHtml(webviewFrameSource)+'; style-src &apos;unsafe-inline&apos;"><style>html,body,iframe{box-sizing:border-box;width:100%;height:100%;margin:0;border:0;overflow:hidden;background:transparent}</style></head><body><iframe title="'+escapeHtml(title)+'" src="'+escapeHtml(url)+'" '+webviewAttributes+'></iframe></body></html>';
    const webviewDocumentUrl=(url,title)=>"data:text/html;charset=utf-8,"+encodeURIComponent(webviewDocument(url,title));
    const webviewSource=(url,title)=>project.webviewSecurityMode==="unrestricted"?url:webviewDocumentUrl(url,title);
    const layoutWebview=(entry,rect)=>{Object.assign(entry.frame.style,{left:rect.x+"px",top:rect.y+"px",width:rect.width+"px",height:rect.height+"px"});entry.frame.hidden=!rect.visible||rect.width===0||rect.height===0||entry.surface.frame.hidden};
    const removeWebviews=(surface)=>{for(const[key,entry]of webviews){if(entry.surface!==surface)continue;entry.frame.remove();webviews.delete(key)}};
    const handleWebview=(surface,payload)=>{
      if(surface.plane!=="overlay"||surface.interaction!=="interactive"||!payload||typeof payload!=="object"||typeof payload.id!=="string"||!/^webview-[1-9][0-9]*$/.test(payload.id))return;
      const key=surface.channel+":"+payload.id;
      if(payload.op==="mount"){
        const rect=webviewRect(payload.rect);if(!rect||webviews.has(key))return;
        const url=webviewUrl(payload.url);const title=typeof payload.title==="string"&&payload.title.trim()?payload.title.trim().slice(0,100):"Remote content";
        if(project.webviewSecurityMode==="unrestricted"&&!project.allowUnrestrictedRemoteContent)throw new Error("Unrestricted remote content requires an explicit host grant");
        if(project.webviewSecurityMode!=="unrestricted"&&!("credentialless" in document.createElement("iframe")))throw new Error("Credentialless WebView frames are not supported by this browser");
        const frame=document.createElement("iframe");frame.dataset.codexExperienceWebviewHost=payload.id;frame.dataset.codexExperienceTarget=surface.target;frame.dataset.codexExperiencePlane=surface.plane;frame.title=title;if(project.webviewSecurityMode!=="unrestricted"){frame.setAttribute("sandbox","allow-scripts allow-forms allow-same-origin");frame.setAttribute("referrerpolicy","no-referrer")}else{frame.setAttribute("allow","camera *; microphone *; geolocation *; clipboard-read *; clipboard-write *; fullscreen *")}Object.assign(frame.style,{position:surface.frame.style.position,border:"0",background:"transparent",overflow:"hidden",pointerEvents:"auto",zIndex:String((Number.parseInt(surface.frame.style.zIndex,10)||0)+1)});
        const entry={frame,surface,url,title};frame.src=webviewSource(url,title);surface.owner.appendChild(frame);webviews.set(key,entry);layoutWebview(entry,rect);return;
      }
      const entry=webviews.get(key);if(!entry||entry.surface!==surface)return;
      if(payload.op==="layout"){const rect=webviewRect(payload.rect);if(rect)layoutWebview(entry,rect);return}
      if(payload.op==="navigate"){entry.url=webviewUrl(payload.url);entry.frame.src=webviewSource(entry.url,entry.title);return}
      if(payload.op==="reload"){entry.frame.src=webviewSource(entry.url,entry.title);return}
      if(payload.op==="destroy"){entry.frame.remove();webviews.delete(key)}
    };
    const remove=(viewKey)=>{
      const entry=mounted.get(viewKey);
      if(!entry)return;
      removeWebviews(entry);
      entry.frame.remove();
      mounted.delete(viewKey);
      if(entry.plane==="underlay")restoreUnderlay(entry.owner);
    };
    const interactionRegions=(payload)=>{
      if(!payload||typeof payload!=="object"||payload.op!=="regions"||!Array.isArray(payload.regions)||payload.regions.length>16)return null;
      const regions=[];
      for(const value of payload.regions){if(!value||typeof value!=="object")return null;const numbers=[value.x,value.y,value.width,value.height];if(!numbers.every(item=>typeof item==="number"&&Number.isFinite(item)&&Math.abs(item)<=100000)||value.width<=0||value.height<=0)return null;const shape=value.shape===undefined?"rect":value.shape;if(shape!=="rect"&&shape!=="rounded"&&shape!=="circle")return null;const radius=value.radius===undefined?0:value.radius;if(typeof radius!=="number"||!Number.isFinite(radius)||radius<0||radius>100000)return null;regions.push({x:value.x,y:value.y,width:value.width,height:value.height,shape,radius})}
      return regions;
    };
    const applyInteractionRegions=(entry,payload)=>{
      if(entry.plane!=="overlay"||entry.interaction!=="scoped")return;
      const regions=interactionRegions(payload);if(!regions)return;
      if(regions.length===0){entry.frame.style.pointerEvents="none";entry.frame.style.clipPath="inset(0 100% 100% 0)";return}
      const path=regions.map(({x,y,width,height,shape,radius:requestedRadius})=>{const left=Math.round(x*100)/100,top=Math.round(y*100)/100,right=Math.round((x+width)*100)/100,bottom=Math.round((y+height)*100)/100;if(shape==="circle"){const radius=Math.round(Math.min(width,height)*50)/100,centerX=Math.round((x+width/2)*100)/100,centerY=Math.round((y+height/2)*100)/100;return"M "+centerX+" "+(centerY-radius)+" A "+radius+" "+radius+" 0 1 1 "+centerX+" "+(centerY+radius)+" A "+radius+" "+radius+" 0 1 1 "+centerX+" "+(centerY-radius)+" Z"}if(shape==="rounded"){const radius=Math.round(Math.min(requestedRadius,width/2,height/2)*100)/100;return"M "+(left+radius)+" "+top+" H "+(right-radius)+" Q "+right+" "+top+" "+right+" "+(top+radius)+" V "+(bottom-radius)+" Q "+right+" "+bottom+" "+(right-radius)+" "+bottom+" H "+(left+radius)+" Q "+left+" "+bottom+" "+left+" "+(bottom-radius)+" V "+(top+radius)+" Q "+left+" "+top+" "+(left+radius)+" "+top+" Z"}return"M "+left+" "+top+" H "+right+" V "+bottom+" H "+left+" Z"}).join(" ");
      entry.frame.style.clipPath='path("'+path+'")';entry.frame.style.pointerEvents="auto";
    };
    const localThreadRoute=(value)=>typeof value==="string"&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value)?"/local/"+value:null;
    const handleAction=(entry,payload)=>{
      if(!project.permissions.includes("host.actions")||!payload||typeof payload!=="object"||typeof payload.name!=="string")return;
      if(payload.name==="codex.window.open"){
        const send=globalThis.electronBridge?.sendMessageFromView;
        const requestedThread=payload.payload&&typeof payload.payload==="object"?payload.payload.threadId:null;
        const path=requestedThread===undefined||requestedThread===null?"/":localThreadRoute(requestedThread);
        if(path&&typeof send==="function")Promise.resolve(send.call(globalThis.electronBridge,{type:"open-in-new-window",path})).catch(error=>console.error("Codex Experience action:",error));
        else if(!path)console.error("Codex Experience action: codex.window.open requires a Codex local thread UUID");
      }
      if(payload.name==="codex.instance.open-isolated"){
        const launch=project.nativeActionBinding?globalThis[project.nativeActionBinding]:null;
        const request=payload.payload&&typeof payload.payload==="object"?payload.payload:null;
        const requestId=request&&typeof request.requestId==="string"&&/^[A-Za-z0-9._:-]{1,160}$/.test(request.requestId)?request.requestId:null;
        if(typeof launch==="function")launch(JSON.stringify({action:"codex.instance.open-isolated",slot:"secondary",...(requestId?{requestId,channel:entry.channel}:{})}));
        else console.error("Codex Experience action: isolated instance broker is unavailable");
      }
      if(payload.name==="codex.instance.sync-conversations"){
        if(!project.permissions.includes("codex.conversations.sync")){console.error("Codex Experience action: codex.conversations.sync permission is required");return}
        const launch=project.nativeActionBinding?globalThis[project.nativeActionBinding]:null;
        if(typeof launch==="function")launch(JSON.stringify({action:"codex.instance.sync-conversations",slot:"secondary"}));
        else console.error("Codex Experience action: conversation sync broker is unavailable");
      }
      if(payload.name==="codex.instance.transfer-catalog"||payload.name==="codex.instance.open-configured"){
        if(!project.permissions.includes("codex.instance.configure")){console.error("Codex Experience action: codex.instance.configure permission is required");return}
        const request=payload.payload&&typeof payload.payload==="object"?payload.payload:null;
        const requestId=request&&typeof request.requestId==="string"&&/^[A-Za-z0-9._:-]{1,160}$/.test(request.requestId)?request.requestId:null;
        if(!requestId){console.error("Codex Experience action: a valid requestId is required");return}
        const selectedItemIds=payload.name==="codex.instance.open-configured"&&Array.isArray(request.selectedItemIds)&&request.selectedItemIds.length<=128&&request.selectedItemIds.every(value=>typeof value==="string"&&value.length<=240)?request.selectedItemIds:null;
        if(payload.name==="codex.instance.open-configured"&&!selectedItemIds){console.error("Codex Experience action: selectedItemIds is invalid");return}
        const selectedConversationThreadIds=payload.name==="codex.instance.open-configured"&&Array.isArray(request.selectedConversationThreadIds)&&request.selectedConversationThreadIds.length<=10000&&request.selectedConversationThreadIds.every(value=>typeof value==="string"&&/^[A-Za-z0-9._:-]{1,200}$/.test(value))?request.selectedConversationThreadIds:null;
        if(selectedItemIds?.includes("conversations")&&(!selectedConversationThreadIds||selectedConversationThreadIds.length===0)){console.error("Codex Experience action: at least one conversation must be selected");return}
        if(selectedItemIds?.includes("conversations")&&!project.permissions.includes("codex.conversations.sync")){console.error("Codex Experience action: codex.conversations.sync permission is required");return}
        const launch=project.nativeActionBinding?globalThis[project.nativeActionBinding]:null;
        if(typeof launch==="function")launch(JSON.stringify({action:payload.name,slot:"secondary",requestId,channel:entry.channel,...(selectedItemIds?{selectedItemIds}:{}),...(selectedConversationThreadIds?{selectedConversationThreadIds}:{})}));
        else console.error("Codex Experience action: isolated instance broker is unavailable");
      }
      globalThis.dispatchEvent(new CustomEvent("codex-experience-action",{detail:{projectId:project.id,target:entry.target,plane:entry.plane,payload}}));
    };
    const mount=(viewKey,view)=>{
      const owner=target(view.target);
      const current=mounted.get(viewKey);
      if(current?.owner===owner&&current.frame.isConnected){if(view.plane==="underlay")prepareUnderlay(owner);return current}
      if(current)remove(viewKey);
      if(!owner)return null;
      ensurePosition(owner,view.target);
      if(view.plane==="underlay")prepareUnderlay(owner);
      const frame=document.createElement("iframe");
      frame.dataset.codexExperienceTarget=view.target;
      frame.dataset.codexExperiencePlane=view.plane;
      frame.dataset.codexExperienceChannel=view.channel;
      frame.name=view.frameName;
      frame.title=project.id+" · "+view.plane+":"+view.target;
      frame.setAttribute("sandbox",project.sandbox);
      frame.setAttribute("aria-hidden",view.interaction==="passthrough"?"true":"false");
      Object.assign(frame.style,{
        position:view.target==="app-shell"||view.target==="floating-window"?"fixed":"absolute",inset:"0",width:"100%",height:"100%",border:"0",background:"transparent",
        zIndex:view.plane==="underlay"?"0":view.target==="floating-window"?"2147482000":view.target==="app-shell"?"2147480000":"2147480010",
        pointerEvents:view.plane==="underlay"||view.interaction!=="interactive"?"none":"auto",
        clipPath:view.interaction==="scoped"?"inset(0 100% 100% 0)":"none"
      });
      if(view.plane==="overlay")frame.style.setProperty("-webkit-app-region","no-drag");
      const entry={frame,owner,channel:view.channel,target:view.target,plane:view.plane,interaction:view.interaction,ready:false};
      frame.srcdoc=documentHtml;
      mounted.set(viewKey,entry);
      owner.appendChild(frame);
      return entry;
    };
    const ensure=()=>{if(cancelled)return;for(const[viewKey,view]of Object.entries(project.views))mount(viewKey,view);refreshCodexContext()};
    const observer=new MutationObserver(()=>queueMicrotask(ensure));
    const listener=(event)=>{
      const data=event.data;
      if(!data||data.source!==message)return;
      for(const entry of mounted.values()){
        if(event.source!==entry.frame.contentWindow||data.channel!==entry.channel)continue;
        if(data.type==="signal"){const payload=signalWithSource(entry,data.payload);for(const targetEntry of mounted.values())if(targetEntry.ready)post(targetEntry,"signal",payload)}
        if(data.type==="ready"){entry.ready=true;if(contextEnabled)post(entry,"codex-context",cloneContext())}
        if(data.type==="interaction")applyInteractionRegions(entry,data.payload);
        if(data.type==="webview")try{handleWebview(entry,data.payload)}catch(error){console.error("Codex Experience WebView:",error);post(entry,"webview-error",{message:error instanceof Error?error.message:String(error)})}
        if(data.type==="action")handleAction(entry,data.payload);
        break;
      }
    };
    addEventListener("message",listener);
    ensure();
    observer.observe(document,{childList:true,subtree:true,attributes:true,attributeFilter:["aria-current","aria-selected","aria-busy","aria-label","data-state","data-status","data-thread-id","data-session-id","data-app-action-sidebar-thread-id","data-app-action-sidebar-thread-selected","data-app-action-sidebar-thread-title","href"]});
    const timer=setInterval(ensure,1500);
    const runtime={
      projectId:project.id,
      digest:project.digest,
      probe(){const declared=Object.keys(project.views);const mountedKeys=[...mounted.keys()];const ready=mountedKeys.filter(viewKey=>mounted.get(viewKey)?.ready===true);const pending=declared.filter(viewKey=>!mounted.has(viewKey));return{projectId:project.id,digest:project.digest,surfacesMounted:mountedKeys,surfacesReady:ready,surfacesPending:pending,declaredSurfaceCount:declared.length}},
      getCodexContext(){return cloneContext()},
      setCodexContext(next){if(!next||typeof next!=="object"||!next.connection||!Array.isArray(next.threads))throw new TypeError("Codex context snapshot is invalid");hostContext={connection:{...next.connection},activeThreadId:next.activeThreadId??null,threads:next.threads.map(thread=>({...thread}))};codexContext=mergeContext();broadcastContext()},
      emitCodexEvent(event,next){this.setCodexContext(next);broadcastEvent(event)},
      setTokens(next,nextAppearance){tokens=next;if(nextAppearance)appearance=nextAppearance;for(const entry of mounted.values())if(entry.ready){post(entry,"tokens",tokens);post(entry,"appearance",appearance)}},
      cancel(){
        if(cancelled)return;
        cancelled=true;
        observer.disconnect();
        clearInterval(timer);
        removeEventListener("message",listener);
        if(nativeResultEvent)removeEventListener(nativeResultEvent,nativeResultListener);
        for(const viewKey of[...mounted.keys()])remove(viewKey);
        for(const[element,position]of originalPositions)element.style.position=position;
        originalPositions.clear();
        for(const owner of[...underlayOwners.keys()])restoreUnderlay(owner);
        if(globalThis[runtimeKey]===runtime)delete globalThis[runtimeKey];
      }
    };
    globalThis[runtimeKey]=runtime;
    // Do not await requestAnimationFrame here. Electron may suspend renderer
    // frames while the Codex window is visible but not focused, which leaves
    // an awaitPromise CDP evaluation pending indefinitely. Host placement is
    // synchronous; each child surface crosses its independent load/ready gate
    // before any cross-frame messages are delivered.
    ensure();
    const declared=Object.keys(project.views);
    const mountedKeys=[...mounted.keys()];
    const ready=mountedKeys.filter(viewKey=>mounted.get(viewKey)?.ready===true);
    const pending=declared.filter(viewKey=>!mounted.has(viewKey));
    return{ok:true,activeProjectId:project.id,digest:project.digest,surfacesMounted:mountedKeys,surfacesReady:ready,surfacesPending:pending,surfaceCount:mountedKeys.length,declaredSurfaceCount:declared.length};
  })()`;
  return { hostSource, documentHtml: compiled.documentHtml, childSources };
}

export function buildExperienceProjectInjectionScript(payload: ExperienceProjectPayload): string {
  return buildExperienceProjectCdpPlan(payload).hostSource;
}
