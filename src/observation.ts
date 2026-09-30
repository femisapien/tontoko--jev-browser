import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { ElementHandle, JSHandle, Page, Frame, Locator } from 'playwright-core';
import type { Snapshot, ElementInfo, SemanticEvidence, SemanticLocatorProperty } from './types.js';
import { BrowserError, browserError, type BrowserErrorCode } from './errors.js';
import type * as DOM from './dom.js';

let bundle: string | undefined;
const source = () => bundle ??= readFileSync(new URL('./dom.bundle.cjs', import.meta.url), 'utf8');
export function publicURL(value: string): string {
  try { const url = new URL(value); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; return url.href; }
  catch { return '[unavailable URL]'; }
}
export interface ElementRef { frame: Frame; handle: ElementHandle<Element>; signature: string; info: ElementInfo }
export interface Captured {
  data: Snapshot;
  refs: Map<string, ElementRef>;
  textRefs?: Map<string, { frame: Frame; handle: ElementHandle<Element>; kind: DOM.SemanticTextKind }>;
  rawURL: string;
  changeKeys: Record<number, string>;
  dispose(): Promise<void>;
}
/** A resolved caller ref used as an observation root. The handle is owned by the caller and stays valid for the operation. */
export interface ScopeRoot { frame: Frame; handle: ElementHandle<Element> }
/** A CSS selector evaluated in every frame, or one current element in its own frame. */
export type Scope = string | ScopeRoot;
/** Fresh handles for the scope roots in one frame; the caller disposes them. */
export async function scopeHandles(frame: Frame, scope: Scope): Promise<ElementHandle<Element>[]> {
  if (typeof scope === 'string') return await frame.locator(`css=${scope}`).elementHandles() as ElementHandle<Element>[];
  if (scope.frame !== frame) return [];
  return [await scope.handle.evaluateHandle(element => element) as ElementHandle<Element>];
}
interface CaptureOptions { signal?: AbortSignal; deadline?: number; semanticRefs?: boolean; scope?: Scope; requireScope?: boolean; recordsScope?: string; exclude?: string[]; maxElements: number; maxTexts: number; selection?: {frame:Frame;roots:ElementHandle<Element>[]} }
// Playwright reports these when a frame is removed, or its document replaced, during an evaluation.
const detachedFrame = /Frame (?:was|has been) detached/;
const replacedDocument = (error: unknown) => error instanceof BrowserError ? error.code === 'STALE_SNAPSHOT' : error instanceof Error && /Execution context was destroyed/.test(error.message);
/** Observation is read-only, so a capture interrupted by navigation is retaken a bounded number of times. */
export async function capture(page: Page, options: CaptureOptions): Promise<Captured> {
  for (let attempt = 1; ; attempt++) {
    try { return await captureOnce(page, options); }
    catch (error) {
      // Selected roots belong to the replaced document, so only a whole-page capture can be retaken.
      if (options.selection || !replacedDocument(error)) throw error;
      // Retries spend the caller's operation budget; they never extend it.
      options.signal?.throwIfAborted();
      const wait = Math.min(2_000, Math.floor((options.deadline ?? Infinity) - performance.now()));
      if (attempt >= 3 || wait <= 0) throw new BrowserError('STALE_SNAPSHOT', 'Page kept navigating while it was being observed. Observe again.', { retryable: true });
      await page.waitForLoadState('domcontentloaded', { timeout: wait, ...(options.signal ? { signal: options.signal } : {}) }).catch(() => undefined);
      options.signal?.throwIfAborted();
    }
  }
}
async function captureOnce(page: Page, options: CaptureOptions): Promise<Captured> {
  const refs = new Map<string, ElementRef>();
  const textRefs = new Map<string, { frame: Frame; handle: ElementHandle<Element>; kind: DOM.SemanticTextKind }>();
  const changeKeys: Record<number,string> = {};
  const owned: JSHandle[] = [];
  const dispose = async () => { await Promise.allSettled(owned.splice(0).map(handle => handle.dispose())); refs.clear(); textRefs.clear(); };
  const rawURL = page.url();
  const data: Snapshot = {
    id: randomUUID(), url: publicURL(rawURL), title: await page.title(), elements: [], texts: [], records: [],
    truncated: false, truncatedElements: false, truncatedTexts: false, recordInventoryComplete:true,
    scroll: await page.evaluate(() => ({ y: window.scrollY, maxY: Math.max(0, document.documentElement.scrollHeight - window.innerHeight), height: window.innerHeight })),
  };
  let scopeFound = false;
  try {
    // Read a frame completely before recording it, so a frame removed mid-read leaves no partial evidence.
    const observeFrame = async (frameIndex: number, frame: Frame) => {
      const frameOptions = { maxElements: Math.max(0, options.maxElements - data.elements.length), maxTexts: Math.max(0, options.maxTexts - data.texts.length) };
      // Use Playwright's native CSS resolver, including open shadow roots.
      const roots = options.selection?.roots ?? (options.scope ? await scopeHandles(frame, options.scope) : undefined);
      if (roots && !options.selection) owned.push(...roots);
      const recordRoots = options.recordsScope ? (await frame.locator(`css=${options.recordsScope}`).elementHandles()) as ElementHandle<Element>[] : undefined;
      if (recordRoots) owned.push(...recordRoots);
      const excluded = options.exclude?.length ? (await Promise.all(options.exclude.map(selector => frame.locator(`css=${selector}`).elementHandles()))).flat() as ElementHandle<Element>[] : undefined;
      if (excluded) owned.push(...excluded);
      const observe = new Function('args', `${source()}; return JevDOM.observe(${JSON.stringify(frameOptions)}, args.roots, args.recordRoots, args.excluded);`) as (args: { roots?: Element[]; recordRoots?: Element[]; excluded?: Element[] }) => ReturnType<typeof DOM.observe>;
      const result = await frame.evaluateHandle(observe, { roots, recordRoots, excluded });
      owned.push(result);
      const observed = await result.evaluate(r => ({ elements: r.elements, texts: r.texts, textKinds:r.textKinds, records: r.records, recordInventoryComplete:r.recordInventoryComplete, busy: r.busy, changeKey: r.changeKey, truncatedElements: r.truncatedElements, truncatedTexts: r.truncatedTexts }));
      const nodes = await result.getProperty('nodes'); owned.push(nodes);
      const properties = await nodes.getProperties();
      const textNodes = options.semanticRefs ? await result.getProperty('textNodes') : undefined;
      if (textNodes) owned.push(textNodes);
      const textProperties = textNodes ? await textNodes.getProperties() : new Map<string, JSHandle>();
      scopeFound ||= !!roots?.length;
      changeKeys[frameIndex] = observed.changeKey;
      data.busy ||= observed.busy;
      for (const [index, handle] of properties) {
        owned.push(handle);
        const description = observed.elements[Number(index)];
        const element = handle.asElement();
        if (!element || !description) continue;
        const id = `r${data.id.replaceAll('-', '').slice(0, 12)}_e${frameIndex}_${index}`;
        const info = { ...description.info, ...(description.info.formId ? { formId: `${frameIndex}:${description.info.formId}` } : {}), id, frame: frameIndex };
        data.elements.push(info);
        refs.set(id, { frame, handle: element as ElementHandle<Element>, signature: description.signature, info });
      }
      for (const [index, handle] of textProperties) {
        owned.push(handle);
        const element = handle.asElement();
        if (element && observed.texts[Number(index)]) textRefs.set(`t${frameIndex}_${index}`, {frame,handle:element as ElementHandle<Element>,kind:observed.textKinds[Number(index)]!});
      }
      data.texts.push(...observed.texts.map((text, i) => ({ ...text, id: `t${frameIndex}_${i}`, frame: frameIndex })));
      data.records!.push(...observed.records.map(r => ({ id: `record${frameIndex}_${r.index}`, frame: frameIndex, context: r.context, readOnly: r.readOnly, textIds: r.texts.map(i => `t${frameIndex}_${i}`), ...(r.parent !== undefined ? { parentId: `record${frameIndex}_${r.parent}` } : {}) })));
      data.recordInventoryComplete &&= observed.recordInventoryComplete;
      data.truncatedElements ||= observed.truncatedElements;
      data.truncatedTexts ||= observed.truncatedTexts;
    };
    for (const [frameIndex, frame] of page.frames().entries()) {
      // Page evaluation has no Playwright timeout; stop between frames once the operation ended.
      options.signal?.throwIfAborted();
      if(options.selection && options.selection.frame !== frame)continue;
      await observeFrame(frameIndex, frame).catch((error: unknown) => {
        // A child frame removed during capture is no longer part of the page; observe the rest.
        if (!options.selection && frame !== page.mainFrame() && (frame.isDetached() || error instanceof Error && detachedFrame.test(error.message))) return;
        throw error;
      });
    }
    data.truncated = data.truncatedElements || data.truncatedTexts;
    options.signal?.throwIfAborted();
    if (page.url() !== rawURL) throw new BrowserError('STALE_SNAPSHOT', 'Page navigated while it was being observed. Observe again.', { retryable: true });
    if (options.requireScope && options.scope && !scopeFound) throw new BrowserError('SCOPE_NOT_FOUND', 'The observation scope matched no element. Check the selector, or wait for that region to appear.');
    return { data, refs, textRefs, rawURL, changeKeys, dispose };
  } catch (error) { await dispose(); throw error; }
}
/** An explicit caller scope that matches nothing in any frame is an error, never an empty observation. */
export async function assertScope(page: Page, scope: Scope | undefined): Promise<void> {
  // A ref scope was verified as current when it was resolved.
  if (!scope || typeof scope !== 'string') return;
  for (const frame of page.frames()) if (await frame.locator(`css=${scope}`).count()) return;
  throw new BrowserError('SCOPE_NOT_FOUND', 'The observation scope matched no element. Check the selector, or wait for that region to appear.');
}
/** Invalid scope syntax fails as INVALID_SELECTOR up front. Other failures (such as a navigation) are left to the observation that follows. */
export async function validateScopeSyntax(page: Page, scope: string | undefined): Promise<void> {
  if (!scope) return;
  try { await page.mainFrame().locator(`css=${scope}`).count(); }
  catch (error) { const mapped = browserError(error); if (mapped.code === 'INVALID_SELECTOR') throw mapped; }
}
/** Execute the shipped shared observation predicate, never caller/model-generated code. */
export async function waitForFrameProgress(frame: Frame, baseline: string, timeoutMs: number, signal: AbortSignal): Promise<void> {
  const changed = new Function('previous', `${source()}; return JevDOM.progressChanged(previous);`) as (previous: string) => boolean;
  const handle = await frame.waitForFunction(changed,baseline,{polling:Math.min(100,Math.max(1,Math.floor(timeoutMs/4))),timeout:timeoutMs,signal});
  await handle.dispose();
}

export async function verifyTarget(ref: ElementRef, signal?: AbortSignal): Promise<void> {
  let current: ReturnType<typeof DOM.describe>;
  try {
    const describe = new Function('element', `${source()}; return JevDOM.describe(element);`) as (element: Element) => ReturnType<typeof DOM.describe>;
    current = await ref.handle.evaluate(describe);
  } catch (error) {
    signal?.throwIfAborted();
    throw new BrowserError('STALE_TARGET', 'The observed element is no longer available. Observe again.', { cause: error });
  }
  if (!current.connected || !current.visible || current.signature !== ref.signature)
    throw new BrowserError('STALE_TARGET', 'The observed target or its row identity changed. Observe again.');
}

/** Wait locally for an owned exact option, then capture that actual node and its control. */
export async function captureComboboxChoice(page: Page, ref: ElementRef, value: string,
  limits: {maxElements:number;maxTexts:number}, operation: {signal:AbortSignal;timeoutMs:number}): Promise<Captured> {
  const ready = new Function('args', `${source()}; return !args.element.isConnected || JevDOM.matchingComboboxOptions(args.element,args.value).length > 0;`) as (args:{element:Element;value:string})=>boolean;
  try {
    const wait=await ref.frame.waitForFunction(ready,{element:ref.handle,value},{timeout:operation.timeoutMs,signal:operation.signal,polling:50});
    await wait.dispose();
  } catch {
    operation.signal.throwIfAborted();
    throw new BrowserError('NO_MATCH','No enabled exact option appeared in the bound control\'s declared popup.');
  }
  if(!await ref.handle.evaluate(el=>el.isConnected))throw new BrowserError('STALE_TARGET','The combobox was replaced while its options loaded.');
  const matching=new Function('element',`${source()}; return JevDOM.matchingComboboxOptions(element,${JSON.stringify(value)});`) as (element:Element)=>Element[];
  const result=await ref.handle.evaluateHandle(matching);
  const properties=await result.getProperties();
  const handles=[...properties.values()];
  try {
    const options=handles.map(handle=>handle.asElement()).filter((handle):handle is ElementHandle<Element>=>!!handle);
    if(options.length>1)throw new BrowserError('AMBIGUOUS_SELECTION','Multiple enabled options with the same label belong to this combobox.');
    if(!options.length)throw new BrowserError('NO_MATCH','The matching option disappeared before observation.');
    return await capture(page,{...limits,selection:{frame:ref.frame,roots:[ref.handle,options[0]!]}});
  } finally {await Promise.allSettled([result,...handles].map(handle=>handle.dispose()));}
}

export interface RegionIndex {
  data:{id:string;role:string;name:string;context:string;frame:number}[];
  refs:Map<string,ElementRef>;
  dispose():Promise<void>;
}
export async function captureRegions(page:Page):Promise<RegionIndex>{
  const owned:JSHandle[]=[],refs=new Map<string,ElementRef>(),data:RegionIndex['data']=[];
  const dispose=async()=>{await Promise.allSettled(owned.splice(0).map(handle=>handle.dispose()));refs.clear();};
  try{
    for(const [frameIndex,frame]of page.frames().entries()){
      const find=new Function(`${source()}; return JevDOM.regionNodes();`) as ()=>Element[];
      const result=await frame.evaluateHandle(find);owned.push(result);
      const props=await result.getProperties();owned.push(...props.values());
      for(const handle of props.values()){
        const element=handle.asElement() as ElementHandle<Element>|null;if(!element)continue;
        if(data.length>=64)throw new BrowserError('OBSERVATION_LIMIT','More than 64 semantic regions are present. A caller scope is required.');
        const describe=new Function('element',`${source()}; return JevDOM.regionDescription(element);`) as (element:Element)=>ReturnType<typeof DOM.describe>;
        const described=await element.evaluate(describe),id=`region_${frameIndex}_${data.length}`;
        const info={...described.info,id,frame:frameIndex};refs.set(id,{frame,handle:element,info,signature:described.signature});
        data.push({id,role:info.role,name:info.name,context:info.context,frame:frameIndex});
      }
    }
    return {data,refs,dispose};
  }catch(error){await dispose();throw error;}
}
export async function verifyOwnedOption(control:ElementRef,option:ElementRef):Promise<void>{
  await verifyTarget(control);
  if(control.frame!==option.frame)throw new BrowserError('STALE_TARGET','Option and its owner belong to different frames.');
  const check=new Function('element','option',`${source()}; const matches=JevDOM.matchingComboboxOptions(element,${JSON.stringify(option.info.name)}); return matches.length===1&&matches[0]===option;`) as (element:Element,option:Element)=>boolean;
  if(!await control.handle.evaluate(check,option.handle))throw new BrowserError('STALE_TARGET','The option no longer uniquely belongs to the observed combobox.');
}

/** Re-read the same observed source rather than a same-position replacement. */
export async function currentSemanticEvidence(page: Page, captured: Captured, evidence: SemanticEvidence, scope?:Scope): Promise<SemanticEvidence | undefined> {
  if (page.url() !== captured.rawURL) return;
  const element = captured.refs.get(evidence.sourceId);
  const text = captured.textRefs?.get(evidence.sourceId);
  const ref = element ?? text;
  if (!ref || page.frames()[evidence.frame] !== ref.frame) return;
  try {
    if(!await semanticWithinScope(ref,scope))return;
    if (element) {
      await verifyTarget(element);
      return {...evidence};
    }
    if(!text)return;
    const read = new Function('element','kind', `${source()}; return JevDOM.readSemanticText(element,kind);`) as (element:Element,kind:DOM.SemanticTextKind)=>ReturnType<typeof DOM.readSemanticText>;
    const value = await ref.handle.evaluate(read,text.kind);
    return value ? {sourceId:evidence.sourceId,frame:evidence.frame,...value} : undefined;
  } catch { return; }
}

export interface LocatorEvidence { evidence: SemanticEvidence; frame: Frame; frameURL: string; rawURL: string }
export async function readLocatorEvidence(page:Page,locator:Locator,property:SemanticLocatorProperty,attribute:string|undefined,sourceId:string,
  options:{scope?:Scope;signal:AbortSignal;timeoutMs:number;current?:boolean}):Promise<LocatorEvidence> {
  options.signal.throwIfAborted();
  if(!locator || typeof locator.page!=='function' || typeof locator.elementHandle!=='function' || locator.page()!==page)
    throw new BrowserError('INVALID_ARGUMENT','The semantic Locator must belong to this Page.');
  if(!['text','value','checked','attribute'].includes(property)||property==='attribute'&&(!attribute||!attribute.trim()))
    throw new BrowserError('INVALID_ARGUMENT','Choose text, value, checked, or an explicitly named attribute.');
  const rawURL=page.url();
  if(!options.current && await locator.count()===0)await locator.waitFor({state:'attached',timeout:options.timeoutMs,signal:options.signal});
  const count=await locator.count();
  if(count!==1)throw new BrowserError(count?'SEMANTIC_AMBIGUOUS':'SEMANTIC_NO_MATCH','A semantic Locator must resolve to exactly one observed element.');
  const handle=await locator.elementHandle({timeout:options.timeoutMs});
  const roots:ElementHandle<Element>[]=[];
  try{
    if(!handle)throw new BrowserError('SEMANTIC_NO_MATCH','The semantic Locator target is absent.');
    const frame=await handle.ownerFrame();
    if(!frame||page.url()!==rawURL)throw new BrowserError('STALE_TARGET','The semantic Locator page changed during observation.');
    const frameURL=frame.url();
    if(options.scope)roots.push(...await scopeHandles(frame,options.scope));
    const read=new Function('element','args',`${source()}; return JevDOM.readLocatorValue(element,args);`) as (element:Element,args:{property:string;attribute?:string;roots?:Element[]})=>ReturnType<typeof DOM.readLocatorValue>;
    const value=await handle.evaluate(read,{property,attribute,...(options.scope?{roots}:{})});
    options.signal.throwIfAborted();
    if(value.error)throw new BrowserError(value.error as BrowserErrorCode,value.error==='INVALID_ARGUMENT'?'The Locator does not support the requested property.':'No visible semantic evidence is available within the caller scope.');
    const {error:_error,...evidence}=value;
    if(page.url()!==rawURL||frame.url()!==frameURL)throw new BrowserError('STALE_TARGET','The semantic Locator document changed during observation.');
    return {evidence:{sourceId,frame:page.frames().indexOf(frame),...evidence} as SemanticEvidence,frame,frameURL,rawURL};
  }finally{await Promise.allSettled([...(handle?[handle]:[]),...roots].map(node=>node.dispose()));}
}

export async function semanticWithinScope(ref:{frame:Frame;handle:ElementHandle<Element>},scope?:Scope):Promise<boolean> {
  if(!scope)return true;
  const roots=await scopeHandles(ref.frame,scope);
  try{
    const check=new Function('element','roots',`${source()}; return element.isConnected && JevDOM.withinSemanticRoots(element,roots);`) as (element:Element,roots:Element[])=>boolean;
    return await ref.handle.evaluate(check,roots);
  }finally{await Promise.allSettled(roots.map(root=>root.dispose()));}
}
