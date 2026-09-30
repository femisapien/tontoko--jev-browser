import { z } from 'zod';
import type { JevBrowser } from './browser.js';
import type { DecisionRequest } from './decision.js';
import { BrowserError } from './errors.js';
import { nativeSchemas, nativeReadOnly, type NativeCommand, type NativeName } from './native-schemas.js';
import { captureSchema, invalidScreenRequest, screenSchema } from './screen.js';

// Node timers overflow above 2147483647 ms; the CLI applies the same bound to its integer options.
const positiveInteger = z.number().int().positive().max(2_147_483_647);
const timeoutMs = positiveInteger.optional().describe('Operation budget in milliseconds; running out fails with TIMEOUT.');
const scope = z.string().min(1).optional().describe('CSS selector, or a current snapshot/semantic_locate ref, limiting observation. Fails with SCOPE_NOT_FOUND when a selector matches no element, STALE_TARGET when the ref expired.');
const cssScope = z.string().min(1).optional();
// Per-call observation settings: optional plain properties, so tool schemas keep a single object shape.
const observation = {
  maxElements: positiveInteger.optional().describe('Most controls observed in this call (default: session limit, 120). Values above 1000 are clamped.'),
  maxTexts: positiveInteger.optional().describe('Most displayed text sources observed in this call (default: session limit, 160; link URLs have a separate budget of the same size). Values above 2000 are clamped.'),
  maxCandidates: positiveInteger.optional().describe('Most action, extraction or semantic candidates in this call (default: session limit, 250). Values above 2000 are clamped.'),
  exclude: z.array(z.string().min(1)).max(64).optional().describe('CSS selectors whose subtrees, including open shadow content, are left out of this observation, such as ads or navigation.'),
};
export const observationKeys = ['maxElements', 'maxTexts', 'maxCandidates', 'exclude'] as const;
const instruction = z.string().trim().min(1);
const values = z.record(z.string().min(1), z.string()).optional().describe('Named literal inputs, referred to by name in instruction. Values are withheld from Jev.');
const runValues = z.record(z.string(),z.json()).optional();
const fieldType = z.enum(['string', 'number', 'boolean']);
const field = z.union([fieldType, z.object({ type: fieldType, description: z.string().optional().describe('Field meaning, sent to Jev.'), nullable: z.boolean().optional().describe('Allow null.') }).strict()]);
const confidence = z.number().min(0).max(1).optional();
const minConfidence = confidence.describe('Required decision confidence (default 0.8).');
const minSourceConfidence = confidence.describe('Required source-binding confidence (default minConfidence).');
const semanticActual = z.union([z.object({ description: instruction.describe('Page value in words, bound to one observed source.') }).strict(), z.object({ ref: z.string().min(1).describe('Current snapshot or semantic_locate ref.') }).strict()]).describe('Actual page value: {description} or {ref}.');
const expected = z.string().min(1).describe('Expected meaning in words. Sent to Jev unless an exact local match settles it.');
const semanticRequest = z.object({ actual: semanticActual, expected, minConfidence, minSourceConfidence }).strict();
const choiceQuestion = z.object({
  instructions: instruction.describe('The question, answered from the image description and state.'),
  criteria: z.record(z.string().min(1), z.string().min(1)).refine(value => Object.keys(value).length >= 2, { message: 'Provide at least two choices.' })
    .describe('Choice id to its meaning; the answer is one of these ids. Include an insufficient-evidence choice where possible.'),
}).strict();
const nonEmpty = (value: object) => Object.keys(value).length > 0;
const semanticBatch = z.object({ requests: z.array(semanticRequest).min(1).describe('Independent actual/expected pairs; item thresholds override the shared ones.'), minConfidence, minSourceConfidence, scope, timeoutMs, ...observation }).strict();
export const commandSchemas = {
  ...nativeSchemas,
  screen: screenSchema,
  screen_decide: z.object({
    questions: z.record(z.string().min(1), choiceQuestion).refine(nonEmpty, { message: 'Provide at least one question.' }).describe('Independent questions, by id, answered from one shared description of the capture.'),
    state: z.record(z.string(), z.json()).optional().describe('Caller context sent to the decision endpoint with the description. Never sent to the image endpoint.'),
    capture: captureSchema.optional().describe('Optional frames 1-10 and intervalMs 20-1000 for a short frame sequence, as for screen look.'),
    timeoutMs,
  }).strict(),
  goto: z.object({ url: z.url().describe('Absolute HTTP(S) URL.') }).strict(),
  snapshot: z.object({ scope, ...observation }).strict(),
  observe: z.object({ instruction: instruction.describe('One action to plan, e.g. click Save.'), values, scope, ...observation }).strict(),
  act: z.object({ instruction: instruction.optional().describe('One action to perform. Provide exactly one of instruction or planId.'), planId: z.string().min(1).optional().describe('Single-use plan id from browser_observe. Provide exactly one of instruction or planId.'), values, scope, ...observation }).strict()
    .refine(v => Number(v.instruction !== undefined) + Number(v.planId !== undefined) === 1, { message: 'Provide exactly one of instruction or planId.' }),
  extract: z.object({
    instruction: instruction.describe('What to copy from the page.'),
    fields: z.record(z.string().min(1), field).optional().describe('Output field name to scalar type, or {type, description, nullable}. Provide exactly one of fields or schema.'),
    schema: z.record(z.string(), z.unknown()).optional().describe('JSON Schema for nested objects and arrays of observed records. Provide exactly one of fields or schema.'),
    scope, recordsScope: z.string().min(1).optional().describe('CSS selector matching each repeated record, such as a table row or card.'), ...observation,
  }).strict()
    .refine(v => Number(v.fields !== undefined) + Number(v.schema !== undefined) === 1, { message: 'Provide exactly one of fields or schema (JSON Schema).' }),
  semantic_locate: z.object({ description: instruction.describe('The one element to find, in words. Sent to Jev.'), minConfidence, scope, ...observation }).strict(),
  semantic_locate_batch: z.object({ descriptions: z.array(instruction).min(1).describe('Independent element descriptions; one target is returned per item.'), minConfidence, scope, ...observation }).strict(),
  semantic_compare: z.object({ actual: semanticActual, expected, minConfidence, minSourceConfidence, scope, ...observation }).strict(),
  semantic_assert: z.object({ actual: semanticActual, expected, minConfidence, minSourceConfidence, scope, ...observation }).strict(),
  semantic_compare_batch: semanticBatch,
  semantic_assert_batch: semanticBatch,
  run: z.object({
    instruction: instruction.describe('Goal to complete, e.g. add a contact and save it.'),
    values: runValues.describe('Nested JSON inputs, reported by JSON Pointer path. Values are withheld from Jev unless listed in semanticInputs.'),
    semanticInputs: z.record(z.string().regex(/^\/(?:[^~]|~[01])*$/),z.number().min(0).max(1)).optional().describe('JSON Pointer of a supplied value to a 0-1 threshold. Discloses that value so Jev may match it to differently worded options.'),
    scope: cssScope.describe('CSS selector limiting observation; refs are not accepted. Unlike browser_act, a scope matching nothing does not fail with SCOPE_NOT_FOUND.'), maxSteps: positiveInteger.optional().describe('Browser action budget (default 100).'), maxDecisions: positiveInteger.optional().describe('Decision request budget (default 32).'),
    decisionRetries: z.number().int().min(0).max(2).optional().describe('Retries per read-only decision request (default 2).'), settleTimeoutMs: positiveInteger.optional().describe('Longest wait for the page to settle after an action (default 2000).'), timeoutMs,
    expect: z.union([nativeSchemas.assert,z.array(nativeSchemas.assert).min(1)]).optional().describe('browser_assert conditions that must pass for a verified completion.'), ...observation,
  }).strict(),
  resume: z.object({ continuationId: z.string().min(1).describe('continuation.id from a stopped browser_run or browser_resume result.'), values: runValues.describe('Additional nested inputs; supplied values cannot change.'), scope: cssScope.describe('Must equal the original run scope when given.'), timeoutMs }).strict(),
  screenshot: z.object({}).strict(),
  close: z.object({}).strict(),
};
export type CommandName = keyof typeof commandSchemas;
export type Command = { [K in CommandName]: { command: K } & z.output<(typeof commandSchemas)[K]> }[CommandName];
const descriptions: Partial<Record<CommandName, string>> = {
  screen: 'Observe viewport pixels or send one physical input. Start with action look. click, move, drag, scroll, type, press, back, forward and reload require the latest observationId; field descriptions state each action\'s arguments. Rejected requests keep that observationId usable; after failed captures, back, forward or reload can recover without one. Returns fresh images, real timestamps and whether the main frame navigated, never DOM, selectors, labels or URL metadata.',
  screen_decide: 'Opt-in, needs --vision-base-url and --vision-model. Capture the viewport once, have the configured image endpoint describe it, and answer the questions with Jev from that description only. Sends no input. Returns decision, the description with provenance, and evidence.observationId, which is the current screen observation. Descriptions can be wrong; never proof of a saved result.',
  goto: 'Navigate to an HTTP(S) URL. Alias for navigate.',
  navigate: 'Navigate the selected tab to an HTTP(S) URL.',
  snapshot: 'Read accessible controls and source text, with short-lived element references. Replaces earlier refs and any pending observe plan; the page is unchanged. No model call.',
  observe: 'Use Jev to choose one grounded action without executing it. Values are explicit named local inputs. Returns a single-use plan or null.',
  act: 'Use Jev to execute one instruction, or execute a previous planId. Literal input text belongs in named values. No automatic mutation retries.',
  extract: 'Copy source-grounded data. Use fields for scalar fields or JSON Schema for nested objects and arrays. recordsScope selects repeated DOM rows/cards. Returns data and source evidence.',
  semantic_locate: 'Use Jev to bind one caller description to a grounded current element. Returns a short-lived real ref, confidence and evidence; never a model-generated selector.',
  semantic_locate_batch: 'Locate independent targets in one shared observation and decision frontier. Refs remain usable in this same observation until invalidated.',
  semantic_compare: 'Compare grounded actual evidence with caller expected meaning. Exact local equality avoids Jev; semantic outcomes include confidence, threshold and evidence.',
  semantic_assert: 'Read-only semantic assertion. Passed requires equivalent at/above threshold; different or inconclusive results are errors. Deterministic assertions remain available separately.',
  semantic_compare_batch: 'Compare independent grounded actual/expected pairs in shared decision frontiers. Returns all results and aggregate usage counted once; snapshot comparison is not a live assertion.',
  semantic_assert_batch: 'Read-only live batch assertion. Re-read each bound source before return; changed or inconclusive evidence cannot pass. Errors retain the complete per-item results.',
  run: 'Complete a goal with supplied nested JSON inputs. Independent field judgments are batched; browser writes are serial. Saved results require readback or explicit expect assertions. Returns input coverage, effect state, usage and partial progress on errors.',
  resume: 'Resume an opaque continuation in the same browser session. New nested values may be added; existing values cannot change. Unknown commits reconcile read-only before any mutation.',
  assert: 'Deterministically assert a page/element fact with Playwright polling. Failure is an error, never a model opinion.',
  click: 'Click a snapshot ref or caller-authored Playwright selector. element is a human-readable description, not a selector. No model call.',
  type: 'Fill or type literal text into a snapshot ref or selector. submit presses Enter.',
  fill_form: 'Fill several explicit fields using refs or selectors, without a model call.',
  tabs: 'List, open, select or close tabs. The session always has a selected Page.',
  handle_dialog: 'Accept or dismiss a pending alert/confirm/prompt dialog. A prompt can receive promptText.',
  file_upload: 'Upload paths within configured file roots. Provide a file input target/ref or use a chooser previously opened on the selected tab.',
  downloads: 'List the selected tab\'s downloads (allTabs for every tab), then save one by id within the artifact directory, or cancel it.',
  console_messages: 'Read console messages from the selected tab, or every tab with allTabs. Entries carry the tab pageId. No model call.',
  network_requests: 'Read request metadata from the selected tab, or every tab with allTabs. Entries carry the tab pageId. No model call.',
  take_screenshot: 'Capture viewport/full-page/element PNG or JPEG. Optional filename is inside the artifact directory.',
  screenshot: 'Capture a PNG of the selected viewport.',
  pdf: 'Save a PDF within the artifact directory. Chromium only.',
  evaluate: 'Run a trusted caller-authored JavaScript function in the page. Needs --caps evaluate (or SDK allowEvaluate). Never invokes Jev.',
  init_script: 'Install a trusted page init script. Needs --caps evaluate (or SDK allowEvaluate).',
  storage_state: 'Save cookies and origin state into the artifact directory. Treat the result as a secret.',
  close: 'Close this browser session and its owned resources. Borrowed Page/context are not closed.',
};
export const commandDescriptions = Object.fromEntries(Object.keys(commandSchemas).map(name => [name, descriptions[name as CommandName] ?? `Execute native Playwright ${name.replaceAll('_', ' ')} on the selected browser session. No model call.`])) as Record<CommandName, string>;
export function commandReadOnly(name: CommandName): boolean {
  return ['screen_decide', 'snapshot', 'observe', 'extract', 'semantic_locate', 'semantic_locate_batch', 'semantic_compare', 'semantic_assert', 'semantic_compare_batch', 'semantic_assert_batch', 'screenshot'].includes(name) || nativeReadOnly.has(name as NativeName);
}
export function parseCommand(input: unknown): Command {
  if (typeof input !== 'object' || input === null || !('command' in input) || typeof input.command !== 'string' || !Object.hasOwn(commandSchemas, input.command))
    throw new BrowserError('INVALID_ARGUMENT', 'Unknown or missing browser command.');
  const { command, ...args } = input;
  const name = command as CommandName;
  const parsed = commandSchemas[name].safeParse(args);
  if (!parsed.success) throw name === 'screen' ? invalidScreenRequest(args, parsed.error.issues) : new BrowserError('INVALID_ARGUMENT', `Invalid arguments for ${name}. See --help or the tool input schema.`);
  return { command: name, ...parsed.data } as Command;
}
export async function executeCommand(browser: JevBrowser, request: Command, signal?: AbortSignal): Promise<object> {
  // screen_decide reads only viewport pixels, so screen-only sessions allow it.
  if (browser.screenOnly && request.command !== 'screen' && request.command !== 'screen_decide' && request.command !== 'close') {
    try { await browser.recordScreenDenied(request.command); } catch { /* Recording cannot authorize a forbidden command. */ }
    throw new BrowserError('SCREEN_ONLY', 'This session accepts only screen operations and close.');
  }
  const options = { signal, ...('scope' in request ? { scope: request.scope } : {}), ...(request.command==='act'||request.command==='observe'?{values:request.values}:{}),
    ...Object.fromEntries(observationKeys.flatMap(key => key in request && (request as Record<string, unknown>)[key] !== undefined ? [[key, (request as Record<string, unknown>)[key]]] : [])) };
  switch (request.command) {
    case 'screen': { const { command, ...screen } = request; return browser.screen(screen, { signal }); }
    case 'screen_decide': return browser.screenDecide({ questions: Object.fromEntries(Object.entries(request.questions).map(([id, question]) => [id, { type: 'choice' as const, ...question }])), ...(request.state ? { state: request.state as DecisionRequest['state'] } : {}), ...(request.capture ? { capture: request.capture } : {}) }, { signal, timeoutMs: request.timeoutMs });
    case 'goto': return browser.goto(request.url, options);
    case 'snapshot': return browser.snapshot(options);
    case 'observe': return { plan: await browser.observe(request.instruction, options) };
    case 'act': return browser.act(request.planId ? { id: request.planId } : request.instruction!, options);
    case 'run': { const {command,instruction,...runOptions}=request;return browser.run(instruction,{...runOptions,signal}); }
    case 'resume': return browser.resume(request.continuationId,{values:request.values,scope:request.scope,timeoutMs:request.timeoutMs,signal});
    case 'semantic_locate': return browser.locateSemantic(request.description, { ...options, minConfidence: request.minConfidence });
    case 'semantic_locate_batch': return {targets:await browser.locateSemanticBatch(request.descriptions,{...options,minConfidence:request.minConfidence})};
    case 'semantic_compare': return browser.compareSemantic({ actual: request.actual, expected: request.expected, minConfidence: request.minConfidence, minSourceConfidence: request.minSourceConfidence }, options);
    case 'semantic_assert': return browser.assertSemantic({ actual: request.actual, expected: request.expected, minConfidence: request.minConfidence, minSourceConfidence: request.minSourceConfidence }, options);
    case 'semantic_compare_batch':
    case 'semantic_assert_batch': {
      const method=request.command==='semantic_assert_batch'?'assertSemanticBatch':'compareSemanticBatch';
      const results=await browser[method](request.requests,{...options,minConfidence:request.minConfidence,minSourceConfidence:request.minSourceConfidence,timeoutMs:request.timeoutMs});
      return {results,usage:results[0]!.usage};
    }
    case 'extract': {
      let schema: z.ZodType;
      if (request.schema) {
        try { schema = z.fromJSONSchema(request.schema); }
        catch { throw new BrowserError('UNSUPPORTED_SCHEMA', 'JSON Schema could not be represented as a grounded extraction schema.'); }
      } else {
        const shape: Record<string, z.ZodType> = {};
        for (const [name, definition] of Object.entries(request.fields!)) {
          const spec = typeof definition === 'string' ? { type: definition } : definition;
          let field: z.ZodType = spec.type === 'string' ? z.string() : spec.type === 'number' ? z.number() : z.boolean();
          if (spec.description) field = field.describe(spec.description);
          if (spec.nullable) field = field.nullable();
          shape[name] = field;
        }
        schema = z.object(shape);
      }
      return browser.extract(request.instruction, schema, { ...options, recordsScope: request.recordsScope });
    }
    case 'screenshot': return { mimeType: 'image/png', data: (await browser.screenshot(options)).toString('base64') };
    case 'close': await browser.close(); return { status: 'closed' };
    default: return browser.native(request as NativeCommand, options);
  }
}
