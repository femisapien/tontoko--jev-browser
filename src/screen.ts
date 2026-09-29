import { randomUUID } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import type { Frame, Page, Request } from 'playwright';
import { z } from 'zod';
import { BrowserError } from './errors.js';
import { FileAccess } from './paths.js';
import type { OperationContext } from './types.js';

const required = (message: string) => ({ error: (issue: { input?: unknown }) => issue.input === undefined ? message : undefined });
const capture = z.object({ frames: z.number().int().min(1).max(10), intervalMs: z.number().int().min(20).max(1000) }).strict().optional();
const observationId = z.string(required('Required for this action. Use the observationId from the latest screen result.')).min(1);
const observed = { observationId, capture };
const coordinate = () => z.number(required('Required for this action, in viewport image pixels.')).finite();
const point = { x: coordinate(), y: coordinate() };
const navigationKeys = ['Enter','Tab','Escape','Backspace','Delete','ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown','Space'] as const;
const editKeys = [
  ...navigationKeys, 'Shift+Tab',
  ...['Shift','Control','Meta','ControlOrMeta','Control+Shift','Meta+Shift','ControlOrMeta+Shift'].flatMap(modifier =>
    ['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].map(key => modifier+'+'+key)),
  ...['Control','Meta','ControlOrMeta'].flatMap(modifier => ['a','A','z','Z','y','Y','Shift+z','Shift+Z'].map(key => modifier+'+'+key)),
];
const key = z.enum(editKeys, { error: 'Required for press: one editing or navigation key from the published enum.' });
/** Pixels and physical inputs only; no selectors, DOM descriptions, arbitrary URL or JavaScript. */
export const screenSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('look'), capture }).strict(),
  z.object({ action: z.literal('click'), ...observed, ...point }).strict(),
  z.object({ action: z.literal('move'), ...observed, ...point }).strict(),
  z.object({ action: z.literal('drag'), ...observed, ...point, toX: coordinate(), toY: coordinate() }).strict(),
  // An omitted wheel delta is 0; execution requires at least one of them.
  z.object({ action: z.literal('scroll'), ...observed, deltaX: z.number().finite().optional(), deltaY: z.number().finite().optional(), x: z.number().finite().optional(), y: z.number().finite().optional() }).strict(),
  z.object({ action: z.literal('type'), ...observed, text: z.string(required('Required for type: the literal text for the focused element.')).max(20000) }).strict(),
  z.object({ action: z.literal('press'), ...observed, key }).strict(),
  // History actions may omit observationId only while no current observation exists; execution enforces that.
  z.object({ action: z.literal('back'), ...observed, observationId: observationId.optional() }).strict(),
  z.object({ action: z.literal('forward'), ...observed, observationId: observationId.optional() }).strict(),
  z.object({ action: z.literal('reload'), ...observed, observationId: observationId.optional() }).strict(),
  // wait sends no input, so it observes without requiring an observationId.
  z.object({ action: z.literal('wait'), ...observed, observationId: observationId.optional(), milliseconds: z.number(required('Required for wait: 0 to 10000.')).int().min(0).max(10000) }).strict(),
], { error: (issue): string | undefined => issue.code === 'invalid_union' ? 'Expected one of '+[...actions].join(', ')+'.' : undefined });
export type ScreenRequest = z.infer<typeof screenSchema>;
export interface ScreenFrame { data: string; mimeType: 'image/png'; capturedAt: string; elapsedMs: number; path?: string }
export interface ScreenResult {
  observationId: string;
  viewport: { width: number; height: number };
  /** The main frame navigated during this operation; frames show the page after that navigation. */
  navigated: boolean;
  frames: ScreenFrame[];
  action: { id: string; kind: ScreenRequest['action']; startedAt: string; durationMs: number; outcome: 'observed' | 'executed' | 'denied' | 'failed' | 'unknown' };
}
/** Sanitized SCREEN_FAILED/SCREEN_INTERRUPTED `details.reason`; never page content. */
export type ScreenFailureReason = 'timeout' | 'cancelled' | 'navigation' | 'page-closed' | 'dialog' | 'unknown';
type ViewportGeometry = { width: number; height: number; scale: number; offsetX: number; offsetY: number; scrollX: number; scrollY: number };
type Observation = { id: string; page: Page; generation: number; viewport: ScreenResult['viewport']; configured: ReturnType<Page['viewportSize']>; geometry: ViewportGeometry };
type Tracking = { page: Page; generation: number; navigations: Set<Request>; waiters: Set<() => void>; interrupt?: AbortController; popup?: Page; fileChooser?: boolean; detach: () => void };
type Capture = { frames: ScreenFrame[]; viewport: ScreenResult['viewport']; geometry: ViewportGeometry };
type EvidenceAction = Omit<ScreenResult['action'],'kind'> & { kind: string };
const actions = new Set(screenSchema.options.map(option => option.shape.action.value));
const settleMs = 5_000;
const dimensionsEqual = (a: ReturnType<Page['viewportSize']>, b: ReturnType<Page['viewportSize']>) =>
  a === null || b === null ? a === b : a.width === b.width && a.height === b.height;
const imageSize = (png: Buffer) => ({ width: png.readUInt32BE(16), height: png.readUInt32BE(20) });
const sameGeometry = (a: ViewportGeometry, b: ViewportGeometry) =>
  (Object.keys(a) as (keyof ViewportGeometry)[]).every(key => a[key] === b[key]);
function unsupported(tracking: Tracking): void {
  if (tracking.popup && !tracking.popup.isClosed()) throw new BrowserError('SCREEN_POPUP_UNSUPPORTED','A new browser tab opened. This viewport session cannot inspect or switch that tab; this is a tool capability limit, not a product failure.');
  // Playwright intercepts the chooser and the Page stays usable, so it is reported once instead of blocking later observations.
  if (tracking.fileChooser) { tracking.fileChooser = false; throw new BrowserError('SCREEN_FILE_CHOOSER_UNSUPPORTED','A native file chooser opened. This viewport tool cannot inspect or operate it; this is a tool capability limit, not a product failure.'); }
}
async function viewportGeometry(page: Page, op: OperationContext): Promise<ViewportGeometry> {
  // The first predicate evaluation returns only viewport numbers. A primitive handle avoids a
  // second unbounded page evaluation during jsonValue; the native wait honors cancellation.
  const value = await page.waitForFunction(() => {
    const viewport = window.visualViewport;
    return JSON.stringify({ width: viewport?.width ?? innerWidth, height: viewport?.height ?? innerHeight,
      scale: viewport?.scale ?? 1, offsetX: viewport?.offsetLeft ?? 0, offsetY: viewport?.offsetTop ?? 0,
      scrollX: window.scrollX, scrollY: window.scrollY });
  }, undefined, { timeout: op.timeoutMs, signal: op.signal });
  try {
    const geometry = JSON.parse(await value.jsonValue()) as ViewportGeometry;
    if (!geometry || !(['width','height','scale','offsetX','offsetY','scrollX','scrollY'] as const).every(key => Number.isFinite(geometry[key])) ||
      geometry.width <= 0 || geometry.height <= 0 || geometry.scale <= 0)
      throw new BrowserError('SCREEN_VIEWPORT_UNSUPPORTED', 'The browser viewport geometry could not be established.');
    return geometry;
  } finally { await value.dispose(); }
}

/** Field-level feedback naming the action and field paths; never echoes supplied values. */
export function invalidScreenRequest(input: unknown, issues: readonly { path: readonly PropertyKey[]; message: string }[], observationId?: string): BrowserError {
  const kind = input && typeof input === 'object' && 'action' in input && typeof input.action === 'string' && (actions as Set<string>).has(input.action) ? input.action : undefined;
  const fields = issues.map(issue => ({ path: issue.path.map(String).join('.') || 'request', message: issue.message }));
  const error = new BrowserError('INVALID_ARGUMENT', `Invalid screen ${kind ? kind+' request' : 'request'}: ${fields.map(field => field.path+': '+field.message.replace(/\.$/, '')).join('; ')}.`);
  error.details = { ...(kind ? { action: kind } : {}), issues: fields, ...(observationId ? { observationId } : {}) };
  return error;
}

/** Owned by one JevBrowser and called under its existing operation/Page lease. */
export class ScreenController {
  private observation?: Observation;
  private tracking?: Tracking;
  private readonly files?: FileAccess;
  private journal?: Promise<string>;
  constructor(private readonly page: () => Page, outputDir?: string, private readonly dialogPending?: () => boolean) {
    if (outputDir) this.files = new FileAccess([], outputDir);
  }
  private track(page: Page): Tracking {
    if (this.tracking?.page === page) return this.tracking;
    this.tracking?.detach();
    const tracking: Tracking = { page, generation: 0, navigations: new Set(), waiters: new Set(), detach: () => {
      page.off('framenavigated', onNavigation); page.off('request', onRequest); page.off('requestfinished', onRequestDone); page.off('requestfailed', onRequestDone);
      page.off('popup', onPopup); page.off('filechooser', onFileChooser);
    } };
    const wake = () => { for (const waiter of tracking.waiters) waiter(); };
    // Subframe content can change like any other page content; only a main-frame navigation replaces the observed document.
    const onNavigation = (frame: Frame) => { if (frame !== page.mainFrame()) return; tracking.generation++; tracking.navigations.clear(); tracking.interrupt?.abort(); wake(); };
    const onRequest = (request: Request) => {
      try { if (request.isNavigationRequest() && request.frame() === page.mainFrame()) tracking.navigations.add(request); } catch { /* A subframe navigation request can precede its Frame. */ }
    };
    const onRequestDone = (request: Request) => { if (tracking.navigations.delete(request)) wake(); };
    const onPopup = (popup: Page) => { tracking.popup = popup; };
    const onFileChooser = () => { tracking.fileChooser = true; };
    page.on('framenavigated', onNavigation); page.on('request', onRequest); page.on('requestfinished', onRequestDone); page.on('requestfailed', onRequestDone);
    page.on('popup', onPopup); page.on('filechooser', onFileChooser);
    return this.tracking = tracking;
  }
  /** The latest observation, when cheap page, navigation and viewport checks still hold. */
  private current(): Observation | undefined {
    const observation = this.observation, page = this.page();
    return observation && observation.page === page && this.tracking?.page === page && observation.generation === this.tracking.generation &&
      dimensionsEqual(observation.configured, page.viewportSize()) ? observation : undefined;
  }
  /** Waits for a started main-frame navigation to commit or end, then for DOMContentLoaded, within settleMs of the budget. Its own timeout only ends the wait. */
  private async settle(page: Page, tracking: Tracking, op: OperationContext): Promise<void> {
    const signal = AbortSignal.any([op.signal, AbortSignal.timeout(Math.min(op.timeoutMs, settleMs))]);
    try {
      await new Promise<void>((resolve, reject) => {
        const finish = () => { tracking.waiters.delete(done); signal.removeEventListener('abort', abort); };
        const done = () => { if (!tracking.navigations.size) { finish(); resolve(); } };
        const abort = () => { finish(); reject(signal.reason); };
        tracking.waiters.add(done); signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort(); else done();
      });
      await page.waitForLoadState('domcontentloaded', { timeout: 0, signal });
    } catch (error) { if (op.signal.aborted || page.isClosed()) throw error; }
  }
  private async capture(page: Page, tracking: Tracking, generation: number, request: ScreenRequest, operation: () => OperationContext, started: number, id: string, attempt: number): Promise<Capture | undefined> {
    // A main-frame navigation interrupts the capture instead of leaving it waiting on a replaced document.
    const interrupt = tracking.interrupt = new AbortController();
    try {
      const count = request.capture?.frames ?? 1, interval = request.capture?.intervalMs ?? 20, frames: ScreenFrame[] = [], images: Buffer[] = [];
      let viewport: ScreenResult['viewport'] | undefined, geometry: ViewportGeometry | undefined;
      const changed = () => this.page() !== page || generation !== tracking.generation;
      for (let i=0;i<count;i++) {
        const op=operation(), signal=AbortSignal.any([op.signal,interrupt.signal]);
        if (i) await delay(interval,undefined,{signal});
        signal.throwIfAborted();unsupported(tracking);
        const png=await page.screenshot({type:'png',scale:'css',animations:'allow',caret:'initial',timeout:op.timeoutMs,signal});
        const capturedAt=new Date().toISOString(), elapsedMs=performance.now()-started;
        // Frames intentionally span animation and scrolling. Bind freshness to the last frame,
        // before optional file writes, without requiring constant scroll across the sequence.
        if (i === count-1) geometry=await viewportGeometry(page,{signal,timeoutMs:operation().timeoutMs});
        unsupported(tracking);
        const size=imageSize(png);
        if (changed() || viewport && !dimensionsEqual(viewport,size))
          throw new BrowserError('STALE_SCREEN','The Page or viewport changed during capture. Look again before any input.');
        viewport=size;images.push(png);
        frames.push({data:png.toString('base64'),mimeType:'image/png',capturedAt,elapsedMs});
      }
      // A navigation that started during the first capture would replace these images; settle and retake instead.
      if (!attempt && tracking.navigations.size) return undefined;
      if (this.files) for (const [i,png] of images.entries()) frames[i]!.path=await this.files.write(png,'screen-'+id+(attempt?'-retake':'')+'-'+i+'.png','png');
      if (changed()) throw new BrowserError('STALE_SCREEN','The Page changed during capture. Look again before any input.');
      return {frames,viewport:viewport!,geometry:geometry!};
    } finally { if (tracking.interrupt === interrupt) tracking.interrupt = undefined; }
  }
  private failure(error: unknown, generation: number | undefined, signal: AbortSignal | undefined): ScreenFailureReason {
    const tracking = this.tracking;
    if (tracking?.page.isClosed()) return 'page-closed';
    if (this.dialogPending?.()) return 'dialog';
    if (tracking && generation !== undefined && tracking.generation !== generation) return 'navigation';
    if (signal?.aborted) return (signal.reason as Error | undefined)?.name === 'TimeoutError' ? 'timeout' : 'cancelled';
    return error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'unknown';
  }
  private async record(action: EvidenceAction, input: object, frames: ScreenFrame[], observationId?: string): Promise<void> {
    if (!this.files) return;
    this.journal ??= this.files.write('', 'screen-'+randomUUID()+'.jsonl', 'jsonl');
    await appendFile(await this.journal, JSON.stringify({
      action, input, ...(observationId ? { observationId } : {}),
      frames: frames.map(({ data, ...frame }) => frame),
    })+'\n', { encoding: 'utf8', mode: 0o600 });
  }
  async deny(command: string): Promise<void> {
    const startedAt = new Date().toISOString();
    await this.record({ id: randomUUID(), kind: 'denied-command', startedAt, durationMs: 0, outcome: 'denied' }, { command }, []);
  }
  async execute(raw: ScreenRequest, operation: () => OperationContext, authorize?: (request: ScreenRequest, operation: OperationContext) => Promise<boolean>, perform: (action: () => Promise<void>) => Promise<void> = action => action()): Promise<ScreenResult> {
    const started = performance.now(), startedAt = new Date().toISOString();
    const kind = raw && typeof raw === 'object' && 'action' in raw && actions.has(raw.action) ? raw.action : 'unsupported';
    const action: EvidenceAction = { id: randomUUID(), kind, startedAt, durationMs: 0, outcome: 'failed' };
    const previous = this.observation;
    let request: ScreenRequest | undefined, input: Record<string,unknown> = {}, effectStarted = false, authorized = false, signal: AbortSignal | undefined, generation: number | undefined;
    try {
      signal = operation().signal;
      const parsed = screenSchema.safeParse(raw);
      if (!parsed.success) throw invalidScreenRequest(raw, parsed.error.issues, this.current()?.id);
      request = parsed.data;
      const invalid = (field: string, message: string) => invalidScreenRequest(raw, [{ path: [field], message }], this.current()?.id);
      if (request.action === 'scroll') {
        if ((request.x === undefined) !== (request.y === undefined)) throw invalid(request.x === undefined ? 'x' : 'y', 'A scroll position requires both x and y.');
        if (request.deltaX === undefined && request.deltaY === undefined) throw invalid('deltaY', 'Provide deltaX, deltaY or both; an omitted delta is 0.');
        request = { ...request, deltaX: request.deltaX ?? 0, deltaY: request.deltaY ?? 0 };
      }
      // Without a current observation, for example after failed captures, history actions can recover without one.
      if ((request.action === 'back' || request.action === 'forward' || request.action === 'reload') && request.observationId === undefined && this.current())
        throw invalid('observationId', 'Required while a current observation exists. Use the observationId from the latest screen result.');
      input = Object.fromEntries(Object.entries(request).filter(([name]) => !['text','capture','observationId','action'].includes(name)));
      if (request.action === 'type') input.textLength = request.text.length;
      if (authorize && await authorize(request, operation()) !== true)
        throw new BrowserError('ACTION_DENIED', 'The caller policy denied this screen operation.');
      authorized = true;
      signal.throwIfAborted();
      const supplied = request.action === 'look' ? undefined : request.observationId;
      if (supplied !== undefined) {
        if (!previous || previous.id !== supplied) throw new BrowserError('STALE_SCREEN', 'The screen observation is no longer current. Look again before any input.'+
          (this.current() ? '' : ' While no current observation exists, back, forward and reload may omit observationId to recover.'));
        const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < previous.viewport.width && y < previous.viewport.height;
        if ('x' in request && request.x !== undefined && request.y !== undefined && !inside(request.x,request.y) ||
          request.action === 'drag' && !inside(request.toX,request.toY))
          throw new BrowserError('SCREEN_COORDINATES', 'Input coordinates must be inside the observed viewport image.');
        if (['click','move','drag','scroll'].includes(request.action) && (previous.geometry.offsetX !== 0 || previous.geometry.offsetY !== 0 ||
          previous.geometry.scale !== 1 && previous.page.context().browser()?.browserType().name() !== 'chromium'))
          throw new BrowserError('SCREEN_VIEWPORT_UNSUPPORTED', 'Pointer input for this viewport transform is not supported. This is a tool capability limit; no input was sent.');
      }
      // Rejections above send nothing and keep the latest observation usable. From here, each capture or input attempt consumes it.
      this.observation = undefined;
      const page = this.page(), tracking = this.track(page);
      generation = tracking.generation;
      unsupported(tracking);
      if (previous && supplied !== undefined) {
        if (previous.page !== page || previous.generation !== tracking.generation || !dimensionsEqual(previous.configured, page.viewportSize()))
          throw new BrowserError('STALE_SCREEN', 'The screen observation is no longer current. Look again before any input.');
        if (!page.viewportSize()) {
          const op=operation();
          const current = imageSize(await page.screenshot({ type:'png', scale:'css', animations:'allow', caret:'initial', timeout:op.timeoutMs, signal:op.signal }));
          if (!dimensionsEqual(current, previous.viewport) || previous.generation !== tracking.generation)
            throw new BrowserError('STALE_SCREEN', 'The screen viewport changed. Look again before any input.');
        }
        if (!sameGeometry(previous.geometry, await viewportGeometry(page, operation())) || previous.generation !== tracking.generation)
          throw new BrowserError('STALE_SCREEN', 'The visible viewport changed. Look again before any input.');
      }
      const point = (x: number, y: number) => ({ x: x / previous!.geometry.scale, y: y / previous!.geometry.scale });
      signal.throwIfAborted();
      const baseline = generation;
      effectStarted = !['look','wait'].includes(request.action);
      await perform(async () => { const op=operation(); switch (request!.action) {
        case 'look': break;
        case 'click': { const p=point(request.x,request.y); await page.mouse.click(p.x,p.y); break; }
        case 'move': { const p=point(request.x,request.y); await page.mouse.move(p.x,p.y); break; }
        case 'drag':
          { const from=point(request.x,request.y), to=point(request.toX,request.toY);
          await page.mouse.move(from.x,from.y);
          await page.mouse.down();
          try { operation().signal.throwIfAborted(); await page.mouse.move(to.x,to.y,{steps:5}); }
          finally { await page.mouse.up(); }
          break; }
        case 'scroll':
          if (request.x !== undefined && request.y !== undefined) { const p=point(request.x,request.y); await page.mouse.move(p.x,p.y); }
          await page.mouse.wheel(request.deltaX ?? 0,request.deltaY ?? 0); break;
        case 'type':
          for (const character of request.text) { operation().signal.throwIfAborted(); await page.keyboard.type(character); }
          break;
        case 'press': await page.keyboard.press(request.key); break;
        case 'back': await page.goBack({ waitUntil:'commit',timeout:op.timeoutMs,signal:op.signal }); break;
        case 'forward': await page.goForward({ waitUntil:'commit',timeout:op.timeoutMs,signal:op.signal }); break;
        case 'reload': await page.reload({ waitUntil:'commit',timeout:op.timeoutMs,signal:op.signal }); break;
        case 'wait': await delay(request.milliseconds,undefined,{signal:operation().signal}); break;
      } });
      unsupported(tracking);
      let captured: Capture | undefined;
      for (let attempt=0; !captured; attempt++) {
        if (attempt || tracking.navigations.size || tracking.generation !== generation) await this.settle(page,tracking,operation());
        generation = tracking.generation;
        try { captured = await this.capture(page,tracking,generation,request,operation,started,action.id,attempt); }
        catch (error) {
          // Only the capture is retaken, once; input is never replayed.
          if (attempt || signal.aborted || page.isClosed() || this.page() !== page || error instanceof BrowserError && error.code !== 'STALE_SCREEN') throw error;
        }
      }
      signal.throwIfAborted();
      const observationId=randomUUID();
      this.observation={id:observationId,page,generation,viewport:captured.viewport,configured:page.viewportSize(),geometry:captured.geometry};
      action.outcome=effectStarted?'executed':'observed';action.durationMs=performance.now()-started;
      await this.record(action,input,captured.frames,observationId);
      return {observationId,viewport:captured.viewport,navigated:generation!==baseline,frames:captured.frames,action:action as ScreenResult['action']};
    } catch (error) {
      action.outcome=effectStarted?'unknown':error instanceof BrowserError && ['INVALID_ARGUMENT','ACTION_DENIED','STALE_SCREEN','SCREEN_COORDINATES'].includes(error.code)?'denied':'failed';
      action.durationMs=performance.now()-started;
      try { await this.record(action,input,[]); } catch { /* Preserve the primary failure; no action is replayed to repair recording. */ }
      if (error instanceof BrowserError) throw error;
      if (!authorized) throw new BrowserError('SCREEN_FAILED','Screen authorization did not complete. No input was retried.');
      const reason=this.failure(error,generation,signal);
      const failure=new BrowserError(effectStarted?'SCREEN_INTERRUPTED':'SCREEN_FAILED',effectStarted
        ?`The screen operation did not finish (${reason}); input may have reached the page. Look before deciding what to do next. No input was retried.`
        :`The screen could not be captured (${reason}). No input was retried.`+(reason === 'page-closed' || reason === 'dialog' ? '' : ' Look again; while no current observation exists, back, forward and reload may omit observationId to recover.'));
      failure.details={reason};failure.cause=error;
      throw failure;
    }
  }
  close(): void { this.tracking?.detach();this.tracking=undefined;this.observation=undefined; }
}
