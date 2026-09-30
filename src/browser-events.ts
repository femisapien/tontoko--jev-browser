import type { BrowserContext, ConsoleMessage, Dialog, Download, ElementHandle, FileChooser, Frame, Locator, Page, Request, Route } from 'playwright-core';
import { BrowserError } from './errors.js';
import { FileAccess } from './paths.js';
import { publicURL } from './observation.js';
import type { BrowserOptions, BrowserDialog } from './types.js';

type Target = Locator | ElementHandle<Element>;
export interface NativeHost {
  page(): Page;
  select(page: Page): Promise<void>;
  resolve(target: string, frame?: number): Promise<Target>;
  validateURL(url: string): Promise<string>;
}
type ActionOutcome = { status: 'executed' } | { status: 'dialog'; dialog: BrowserDialog };
interface TrackedPage { id: number; chooser?: FileChooser; holdDialogs(hold: boolean): void; detach(): void }
const push = <T>(entries: T[], entry: T, limit: number) => { entries.push(entry); if (entries.length > limit) entries.shift(); };
/** Mechanical browser operations. The shared core supplies locking, authorization and reference identity. */
export class BrowserEvents {
  protected readonly files: FileAccess;
  protected readonly context: BrowserContext;
  private readonly tracked = new Map<Page, TrackedPage>();
  private pageCount = 0;
  private downloadCount = 0;
  protected readonly messages: { type: string; text: string; url: string; pageId: number }[] = [];
  protected readonly requests: { method: string; url: string; resourceType: string; pageId: number }[] = [];
  protected readonly downloads: { id: number; pageId: number; download: Download }[] = [];
  protected readonly routes = new Map<string, (route: Route) => Promise<void>>();
  protected dialog?: Dialog;
  private dialogId = 0;
  private dialogPage?: Page;
  private dialogPageId?: number;
  protected dialogNotice?: () => void;
  protected pendingAction?: Promise<void>;
  protected traceStarted = false;
  private operating = false;
  protected readonly onPage = (page: Page) => this.attach(page);

  constructor(protected readonly host: NativeHost, protected readonly options: BrowserOptions) {
    this.context = host.page().context();
    this.files = new FileAccess(options.fileRoots ?? [process.cwd()], options.outputDir ?? '.jev-browser/artifacts');
    for (const page of this.context.pages()) this.attach(page);
    this.context.on('page', this.onPage);
  }
  private attach(page: Page): void {
    if (this.tracked.has(page)) return;
    let holding = false;
    const tracked: TrackedPage = {
      id: ++this.pageCount,
      // A dialog listener disables Playwright's default dismissal, so it exists only while Jev owns dialogs.
      holdDialogs: hold => { if (hold === holding) return; holding = hold; if (hold) page.on('dialog', onDialog); else page.off('dialog', onDialog); },
      detach: () => { tracked.holdDialogs(false); page.off('console', onConsole); page.off('pageerror', onError); page.off('request', onRequest); page.off('download', onDownload); page.off('filechooser', onChooser); page.off('framenavigated', onNavigation); page.off('close', onClose); },
    };
    const onConsole = (m: ConsoleMessage) => push(this.messages, { type: m.type(), text: m.text(), url: publicURL(page.url()), pageId: tracked.id }, 500);
    const onError = (e: Error) => push(this.messages, { type: 'error', text: e.message, url: publicURL(page.url()), pageId: tracked.id }, 500);
    const onRequest = (r: Request) => push(this.requests, { method: r.method(), url: publicURL(r.url()), resourceType: r.resourceType(), pageId: tracked.id }, 1000);
    const onDownload = (d: Download) => push(this.downloads, { id: ++this.downloadCount, pageId: tracked.id, download: d }, 100);
    const onDialog = (d: Dialog) => { this.dialog = d; this.dialogId++; this.dialogPage = page; this.dialogPageId = tracked.id; this.dialogNotice?.(); };
    const onChooser = (c: FileChooser) => { tracked.chooser = c; };
    // A chooser belongs to the document that opened it.
    const onNavigation = (frame: Frame) => { if (frame === page.mainFrame()) tracked.chooser = undefined; };
    const onClose = () => { tracked.detach(); this.tracked.delete(page); };
    page.on('console', onConsole); page.on('pageerror', onError); page.on('request', onRequest); page.on('download', onDownload); page.on('filechooser', onChooser); page.on('framenavigated', onNavigation); page.on('close', onClose);
    tracked.holdDialogs(this.holdsDialogs());
    this.tracked.set(page, tracked);
  }
  private holdsDialogs(): boolean { return this.options.captureDialogs === true || this.operating; }
  /** Borrowed Pages keep Playwright's default dialog dismissal outside Jev operations unless captureDialogs is set. */
  operate(active: boolean): void {
    this.operating = active;
    for (const tracked of this.tracked.values()) tracked.holdDialogs(this.holdsDialogs());
  }
  protected pageId(page: Page = this.host.page()): number | undefined { return this.tracked.get(page)?.id; }
  /** Telemetry for the selected tab, or for every tab; clearing removes only what was selected. */
  protected scoped<T extends { pageId: number }>(entries: T[], allTabs?: boolean, clear?: boolean): T[] {
    const pageId = this.pageId(), selected = entries.filter(entry => allTabs || entry.pageId === pageId);
    if (clear) entries.splice(0, entries.length, ...entries.filter(entry => !allTabs && entry.pageId !== pageId));
    return selected;
  }
  protected takeChooser(): FileChooser {
    const tracked = this.tracked.get(this.host.page()), chooser = tracked?.chooser;
    if (!tracked || !chooser) throw new BrowserError('NO_FILE_CHOOSER', 'Provide a file input target or open a file chooser on the selected tab first.');
    tracked.chooser = undefined; return chooser;
  }
  guard(command?: string): void {
    if ((this.dialog || this.pendingAction) && command !== 'handle_dialog') throw new BrowserError('DIALOG_PENDING', 'Answer the pending browser dialog with handle_dialog before another operation.');
  }
  isCurrentDialog(dialog: BrowserDialog): boolean {
    return !!this.dialog && dialog.id === this.dialogId && this.dialogPage === this.host.page();
  }
  private dialogResult(): ActionOutcome {
    const d = this.dialog!;
    return { status: 'dialog', dialog: { id: this.dialogId, type: d.type(), message: d.message(), defaultValue: d.defaultValue(), pageId: this.dialogPageId! } };
  }
  async action(fn: () => Promise<unknown>): Promise<ActionOutcome> {
    this.guard();
    const notice = new Promise<'dialog'>(resolve => { this.dialogNotice = () => resolve('dialog'); });
    const task = Promise.resolve().then(fn).then(() => undefined);
    // Register a rejection observer even when the dialog wins the race.
    void task.catch(() => undefined);
    try {
      const result = await Promise.race([task.then(() => 'finished' as const), notice]);
      if (result === 'dialog') { this.pendingAction = task; return this.dialogResult(); }
      return { status: 'executed' };
    } finally { this.dialogNotice = undefined; }
  }
  protected async handleDialog(accept: boolean, promptText?: string): Promise<ActionOutcome> {
    if (!this.dialog) throw new BrowserError('NO_DIALOG', 'There is no pending browser dialog.');
    const dialog = this.dialog; this.dialog = undefined;
    const notice = new Promise<'dialog'>(resolve => { this.dialogNotice = () => resolve('dialog'); });
    await (accept ? dialog.accept(promptText) : dialog.dismiss());
    const pending = this.pendingAction;
    try {
      const result = await Promise.race([(pending ?? Promise.resolve()).then(() => 'finished' as const), notice]);
      if (result === 'dialog') return this.dialogResult();
      this.pendingAction = undefined;
      return { status: 'executed' };
    } finally { this.dialogNotice = undefined; if (!this.dialog) this.pendingAction = undefined; }
  }
  protected async target(args: { target?: string; ref?: string; frame?: number }): Promise<Target> {
    const target = args.target ?? args.ref;
    if (!target) throw new BrowserError('INVALID_ARGUMENT', 'An element reference or selector is required.');
    return this.host.resolve(target, args.frame);
  }
  async dispose(): Promise<void> {
    this.context.off('page', this.onPage);
    if (this.dialog) { await this.dialog.dismiss().catch(() => undefined); this.dialog = undefined; }
    await this.pendingAction?.catch(() => undefined); this.pendingAction = undefined;
    for (const tracked of this.tracked.values()) tracked.detach(); this.tracked.clear();
    for (const [pattern, handler] of this.routes) await this.context.unroute(pattern, handler).catch(() => undefined);
    this.routes.clear();
    if (this.traceStarted) await this.context.tracing.stop().catch(() => undefined);
    this.traceStarted = false;
  }
}
