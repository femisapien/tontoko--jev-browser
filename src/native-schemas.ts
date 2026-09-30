import { z } from 'zod';
import { BrowserError } from './errors.js';

// Descriptions carry the rules JSON Schema cannot express; refinements still enforce them.
// Indexes share the 32-bit bound used for CLI and MCP integers instead of Number.MAX_SAFE_INTEGER.
const index = z.number().int().nonnegative().max(2_147_483_647);
const targetFields = {
  target: z.string().min(1).optional().describe('Playwright selector or snapshot ref. A selector matching several elements fails with AMBIGUOUS_TARGET.'),
  ref: z.string().min(1).optional().describe('Snapshot ref. Element commands need ref or target.'),
  element: z.string().optional().describe('Label for humans; not a selector.'),
  frame: index.optional().describe('browser_frames index for a selector.'),
};
const targetRequired = (v: { target?: string; ref?: string }) => !!(v.target || v.ref);
const targetMessage = { message: 'Provide a snapshot ref or a Playwright selector in target.' };
const button = z.enum(['left', 'middle', 'right']).optional().describe('Mouse button (default left).');
const dimension = z.number().int().min(1).max(16384);
const filename = z.string().min(1).optional().describe('New relative path inside the artifact directory.');
const clear = z.boolean().optional().describe('Empty the buffer after reading.');
const allTabs = z.boolean().optional().describe('Include every tab instead of only the selected tab.');
const target = z.object(targetFields).strict().refine(targetRequired, targetMessage);
export const nativeSchemas = {
  navigate: z.object({ url: z.string().min(1).describe('Absolute HTTP(S) URL.') }).strict(),
  navigate_back: z.object({}).strict(), navigate_forward: z.object({}).strict(), reload: z.object({}).strict(),
  click: z.object({ ...targetFields, button, doubleClick: z.boolean().optional().describe('Double-click instead of a single click.'), modifiers: z.array(z.enum(['Alt', 'Control', 'ControlOrMeta', 'Meta', 'Shift'])).optional().describe('Modifier keys held during the click.') }).strict().refine(targetRequired, targetMessage),
  type: z.object({ ...targetFields, text: z.string().describe('Literal text that replaces the current value.'), slowly: z.boolean().optional().describe('Type key by key instead of filling at once.'), submit: z.boolean().optional().describe('Press Enter afterwards.') }).strict().refine(targetRequired, targetMessage),
  hover: target,
  drag: z.object({
    startTarget: z.string().optional().describe('Drag source selector or ref. Provide it or startRef.'), startRef: z.string().optional().describe('Drag source ref from browser_snapshot.'), startElement: z.string().optional().describe('Label for humans; not a selector.'),
    endTarget: z.string().optional().describe('Drop target selector or ref. Provide it or endRef.'), endRef: z.string().optional().describe('Drop target ref from browser_snapshot.'), endElement: z.string().optional().describe('Label for humans; not a selector.'), frame: targetFields.frame,
  }).strict().refine(v => !!(v.startTarget || v.startRef) && !!(v.endTarget || v.endRef), { message: 'Both drag endpoints are required.' }),
  press_key: z.object({ key: z.string().min(1).describe('Playwright key or chord, e.g. Enter or Control+A. Pressed on the target, else on the focused element.'), ...targetFields }).strict(),
  select_option: z.object({ ...targetFields, values: z.array(z.string()).optional().describe('Strings matched against option value or label (first match); by label matches labels only. They replace the selection. Provide exactly one of values or indices.'), indices: z.array(index).optional().describe('Zero-based option indices. Provide exactly one of values or indices.'), by: z.enum(['value', 'label']).optional().describe('value (default) matches option value or label; label matches labels only.') }).strict().refine(targetRequired, targetMessage).refine(v => Number(v.values !== undefined) + Number(v.indices !== undefined) === 1, { message: 'Provide values or exact observed option indices.' }),
  check: z.object({ ...targetFields, checked: z.boolean().default(true).describe('Desired checked state.') }).strict().refine(targetRequired, targetMessage),
  fill_form: z.object({ fields: z.array(z.object({ ...targetFields, name: z.string().optional().describe('Label for humans; not a selector.'), type: z.enum(['textbox', 'checkbox', 'radio', 'combobox', 'slider']).describe('Control kind; decides how value is applied.'), value: z.union([z.string(), z.boolean(), z.array(z.string())]).describe('Boolean for checkbox and radio, string or string list for combobox, otherwise string.') }).strict().refine(targetRequired, targetMessage).refine(v => v.type === 'checkbox' || v.type === 'radio' ? typeof v.value === 'boolean' : v.type === 'combobox' ? typeof v.value === 'string' || Array.isArray(v.value) : typeof v.value === 'string', { message: 'Field value must match its control type.' })).min(1).describe('Controls to fill in order. Every target is resolved before any is filled.') }).strict(),
  wait_for: z.object({ text: z.string().optional().describe('Wait until this text is visible. Provide at least one of text, textGone, target or time.'), textGone: z.string().optional().describe('Wait until this text is hidden.'), target: z.string().optional().describe('Playwright selector to wait for.'), state: z.enum(['attached', 'detached', 'visible', 'hidden']).optional().describe('State awaited for target (default visible).'), time: z.number().min(0).max(300).optional().describe('Seconds to sleep before the other conditions.') }).strict().refine(v => v.text !== undefined || v.textGone !== undefined || v.target !== undefined || v.time !== undefined, { message: 'A wait condition is required.' }),
  tabs: z.object({ action: z.enum(['list', 'new', 'select', 'close']).describe('new opens url if given; select needs index; close closes index or the selected tab.'), index: index.optional().describe('Tab index from the tabs list.'), url: z.string().optional().describe('Absolute HTTP(S) URL for new.') }).strict().refine(v => v.action !== 'select' || v.index !== undefined, { message: 'select requires a tab index.' }),
  frames: z.object({}).strict(),
  handle_dialog: z.object({ accept: z.boolean().describe('Accept (true) or dismiss (false) the pending dialog.'), promptText: z.string().optional().describe('Text entered into a prompt dialog.') }).strict(),
  file_upload: z.object({ ...targetFields, paths: z.array(z.string()).describe('Local files within the configured file roots. Without ref or target, fills a chooser opened on the selected tab.') }).strict(),
  downloads: z.object({ action: z.enum(['list', 'save', 'cancel']).describe('list, save to filename, or cancel.'), index: index.optional().describe("Index in the selected tab's download list. save and cancel need exactly one of index or id."), id: z.number().int().positive().max(2_147_483_647).optional().describe('Stable download id from list. save and cancel need exactly one of index or id.'), allTabs: allTabs.describe('list only: include downloads from every tab.'), filename }).strict().refine(v => v.action === 'list' || Number(v.index !== undefined) + Number(v.id !== undefined) === 1, { message: 'Provide exactly one download id or index.' }).refine(v => v.action === 'list' || v.allTabs === undefined, { message: 'allTabs applies only to list.' }),
  take_screenshot: z.object({ ...targetFields, filename, fullPage: z.boolean().optional().describe('Capture the whole scrollable page instead of the viewport. Page screenshots only.'), type: z.enum(['png', 'jpeg']).default('png').describe('Image format.') }).strict(),
  pdf: z.object({ filename, format: z.enum(['A4', 'Letter', 'Legal', 'A3', 'A5']).default('A4').describe('Paper size.'), printBackground: z.boolean().optional().describe('Include background graphics.') }).strict(),
  resize: z.object({ width: dimension.describe('Viewport width in CSS pixels.'), height: dimension.describe('Viewport height in CSS pixels.') }).strict(),
  console_messages: z.object({ level: z.enum(['error', 'warning', 'info', 'debug']).optional().describe('error returns errors, warning adds warnings; info, debug or none return all.'), clear, allTabs }).strict(),
  network_requests: z.object({ clear, allTabs }).strict(),
  evaluate: z.object({ function: z.string().min(1).describe('Trusted JavaScript function source run in the page, e.g. () => document.title. Select elements inside it; target and ref are rejected.'), arg: z.unknown().optional().describe('JSON value passed as the only argument.'), ...targetFields }).strict(),
  init_script: z.object({ script: z.string().min(1).describe('JavaScript source run in every new document before page scripts.') }).strict(),
  storage: z.object({ area: z.enum(['local', 'session']).describe('localStorage or sessionStorage of the selected page.'), action: z.enum(['get', 'set', 'delete', 'clear', 'list']).describe('Operation; list returns every key and value.'), name: z.string().optional().describe('Key; required except for clear and list.'), value: z.string().optional().describe('Value; required for set.') }).strict().refine(v => ['clear', 'list'].includes(v.action) || v.name !== undefined, { message: 'A storage name is required.' }).refine(v => v.action !== 'set' || v.value !== undefined, { message: 'set requires a value.' }),
  cookies: z.object({ action: z.enum(['list', 'add', 'clear']).describe('Operation on the browser context cookies.'), urls: z.array(z.string()).optional().describe('Limit list to cookies for these URLs.'), cookies: z.array(z.object({ name: z.string(), value: z.string(), url: z.string().optional(), domain: z.string().optional(), path: z.string().optional(), expires: z.number().optional(), httpOnly: z.boolean().optional(), secure: z.boolean().optional(), sameSite: z.enum(['Strict', 'Lax', 'None']).optional() }).strict()).optional().describe('Cookies for add. Each needs url, or domain and path; expires is Unix time in seconds.') }).strict().refine(v => v.action !== 'add' || v.cookies !== undefined, { message: 'add requires cookies.' }),
  storage_state: z.object({ filename }).strict(),
  trace: z.object({ action: z.enum(['start', 'stop']).describe('start recording, or stop and save the trace zip.'), filename }).strict(),
  route: z.object({ action: z.enum(['fulfill', 'abort', 'remove']).describe('Fulfill or abort matching requests, or remove the route for pattern.'), pattern: z.string().min(1).describe('Playwright URL glob, e.g. **/api/*.'), status: z.number().int().min(100).max(599).optional().describe('Response status for fulfill (default 200).'), body: z.string().optional().describe('Response body for fulfill.'), contentType: z.string().optional().describe('Response Content-Type for fulfill.') }).strict(),
  mouse: z.object({ action: z.enum(['move', 'click', 'down', 'up', 'wheel']).describe('move and click need x and y; wheel scrolls by deltaX and deltaY.'), x: z.number().optional().describe('Viewport X in CSS pixels.'), y: z.number().optional().describe('Viewport Y in CSS pixels.'), button, deltaX: z.number().optional().describe('Horizontal wheel delta in pixels.'), deltaY: z.number().optional().describe('Vertical wheel delta in pixels.') }).strict().refine(v => !['move', 'click'].includes(v.action) || v.x !== undefined && v.y !== undefined, { message: 'Mouse position is required.' }),
  assert: z.object({ ...targetFields, property: z.enum(['visible', 'hidden', 'text', 'value', 'checked', 'count', 'url', 'title', 'enabled']).describe('url and title read the page; others need ref or target.'), expected: z.union([z.string(), z.boolean(), z.number()]).optional().describe('Exact value (text: textContent). Required unless property is visible, hidden or enabled (default true).') }).strict().refine(v => ['url', 'title'].includes(v.property) || targetRequired(v), targetMessage).refine(v => ['visible', 'hidden', 'enabled'].includes(v.property) || v.expected !== undefined, { message: 'An expected value is required.' }),
};
export type NativeName = keyof typeof nativeSchemas;
export type NativeCommand = { [K in NativeName]: { command: K } & z.input<(typeof nativeSchemas)[K]> }[NativeName];
export type ParsedNativeCommand = { [K in NativeName]: { command: K } & z.output<(typeof nativeSchemas)[K]> }[NativeName];
export function parseNative(input: NativeCommand): ParsedNativeCommand {
  const { command, ...args } = input;
  if (!Object.hasOwn(nativeSchemas, command)) throw new BrowserError('INVALID_ARGUMENT', 'Unknown native browser operation.');
  const result = nativeSchemas[command].safeParse(args);
  if (!result.success) throw new BrowserError('INVALID_ARGUMENT', `Invalid arguments for ${command}.`);
  return { command, ...result.data } as ParsedNativeCommand;
}
export const nativeReadOnly = new Set<NativeName>(['frames', 'console_messages', 'network_requests', 'assert', 'wait_for']);
