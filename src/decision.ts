import { TypeSafeClient, type ChoiceQuestion, type EntryType, type Fetch, type Usage } from '@typesafe-ai/sdk';
import { z } from 'zod';
import { BrowserError } from './errors.js';

export interface DecisionRequest {
  state: EntryType;
  questions: Record<string, ChoiceQuestion>;
}
export interface DecisionResult {
  answers: Record<string, { choice: string; confidence: number }>;
  model?: string;
  models?: string[];
  usage?: Usage;
  elapsedMs?: number;
}
/** A small test seam, not a model router. Production uses JevDecisionEngine. */
export interface DecisionEngine {
  decide(request: DecisionRequest, options?: { signal?: AbortSignal; maxRetries?: number }): Promise<DecisionResult>;
}
export interface JevOptions {
  apiKey?: string;
  baseURL?: string;
  model?: string;
  timeoutMs?: number;
  fetch?: Fetch;
}
const choiceAnswer = z.object({ choice: z.string(), confidence: z.number().min(0).max(1) });
const wireResult = z.object({
  answers: z.record(z.string(), choiceAnswer),
  model: z.string(),
  usage: z.object({ input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative() }),
});
/** The whole-request budget shared by every decision call, measured on the compact wire form. */
export const DECISION_REQUEST_BYTES = 128 * 1024;
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
const isObject = (value: unknown): value is Record<string, Json> => typeof value === 'object' && value !== null && !Array.isArray(value);
// Element and option flags whose absence reads as false; `expanded`, `checked`, `filled` and `value` stay explicit.
const falseDefaults = ['disabled', 'readOnly', 'fillable', 'required', 'multiple'];
const LEGEND = 'contextId refers to state.contextTable. Omitted frame means the main frame (0). Omitted disabled, readOnly, fillable, required and multiple element flags, and omitted option selected/disabled flags, mean false.';
/**
 * Lossless wire compaction. Repeated row/form context strings move into one state.contextTable and are
 * referenced by contextId; default-valued element flags and frame 0 are omitted. Criteria keys, roles
 * and names are unchanged, so answer validation and the candidates the model compares stay the same.
 */
export function compactDecisionRequest(request: DecisionRequest): DecisionRequest {
  const copy = JSON.parse(JSON.stringify(request)) as { state: Json; questions: Record<string, { criteria: Record<string, Json> } & Record<string, Json>> };
  const counts = new Map<string, number>();
  let compacted = false;
  const visit = (value: Json, each: (object: Record<string, Json>) => void) => {
    if (Array.isArray(value)) { for (const item of value) visit(item, each); return; }
    if (!isObject(value)) return;
    each(value);
    for (const child of Object.values(value)) visit(child, each);
  };
  const roots = [copy.state, ...Object.values(copy.questions).map(question => question.criteria as Json)];
  for (const root of roots) visit(root, object => { if (typeof object.context === 'string') counts.set(object.context, (counts.get(object.context) ?? 0) + 1); });
  const table: Record<string, string> = {}, ids = new Map<string, string>();
  const shareable = isObject(copy.state) && !Object.hasOwn(copy.state, 'contextTable');
  for (const root of roots) visit(root, object => {
    const context = object.context;
    // A context seen once stays inline: a reference would cost more than it saves.
    if (shareable && typeof context === 'string' && context.length > 8 && (counts.get(context) ?? 0) > 1) {
      let id = ids.get(context);
      if (!id) { id = `c${ids.size}`; ids.set(context, id); table[id] = context; }
      const entries = Object.entries(object);
      for (const key of Object.keys(object)) delete object[key];
      for (const [key, value] of entries) object[key === 'context' ? 'contextId' : key] = key === 'context' ? id : value;
    }
    if (object.frame === 0) { delete object.frame; compacted = true; }
    const element = typeof object.role === 'string' && typeof object.tag === 'string';
    if (element) {
      for (const key of falseDefaults) if (object[key] === false) { delete object[key]; compacted = true; }
      if (Array.isArray(object.controls) && !object.controls.length) delete object.controls;
      if (object.inputType === '') delete object.inputType;
    }
    if (typeof object.index === 'number' && typeof object.label === 'string') {
      if (object.selected === false) { delete object.selected; compacted = true; }
      if (object.disabled === false) { delete object.disabled; compacted = true; }
    }
  });
  if (isObject(copy.state) && (ids.size || compacted)) {
    if (ids.size) copy.state.contextTable = table;
    copy.state.legend = LEGEND;
  }
  return copy as unknown as DecisionRequest;
}
export const decisionRequestBytes = (request: DecisionRequest): number => Buffer.byteLength(JSON.stringify(compactDecisionRequest(request)));
const hostedOrigin = 'https://api.typesafe.ai';
/** Empty or whitespace-only settings are unset, matching `.env` files that leave a key blank. */
const setting = (value: string | undefined) => value?.trim() || undefined;
const loopback = (host: string) => host === 'localhost' || host === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(host);

export class JevDecisionEngine implements DecisionEngine {
  private readonly client: TypeSafeClient;
  constructor(options: JevOptions = {}) {
    const url = URL.parse(setting(options.baseURL) ?? setting(process.env.JEV_BASE_URL) ?? hostedOrigin);
    if (!url || !['http:', 'https:'].includes(url.protocol)) throw new BrowserError('CONFIG', 'The decision baseURL must be an HTTP(S) URL.');
    // Hosted keys from the environment stay with hosted Jev; another endpoint needs apiKey or JEV_ENDPOINT_API_KEY, else a keyless placeholder.
    const hosted = url.origin === hostedOrigin;
    const apiKey = setting(options.apiKey) ?? (hosted ? setting(process.env.JEV_API_KEY) ?? setting(process.env.TYPESAFE_API_KEY) : setting(process.env.JEV_ENDPOINT_API_KEY));
    if (hosted && !apiKey) throw new BrowserError('CONFIG', 'Hosted Jev needs apiKey, JEV_API_KEY or TYPESAFE_API_KEY. A custom System One baseURL or JEV_BASE_URL needs no hosted key.');
    if (apiKey && url.protocol === 'http:' && !loopback(url.hostname))
      throw new BrowserError('CONFIG', 'An API key is sent only over HTTPS or to a loopback endpoint. Use an https:// decision baseURL.');
    this.client = new TypeSafeClient({
      apiKey: apiKey ?? 'local',
      // Always explicit, so the SDK's own TYPESAFE_BASE_URL cannot redirect a hosted key.
      baseURL: url.href,
      defaultModel: setting(options.model) ?? setting(process.env.JEV_MODEL),
      timeout: options.timeoutMs ?? 15_000,
      retry: { maxRetries: 0 },
      logLevel: 'off',
      fetch: options.fetch,
    });
  }
  async decide(request: DecisionRequest, options: { signal?: AbortSignal; maxRetries?: number } = {}): Promise<DecisionResult> {
    options.signal?.throwIfAborted();
    const start = performance.now();
    let raw: unknown;
    try {
      raw = await this.client.systemOne(compactDecisionRequest(request), { signal: options.signal, retry: { maxRetries: options.maxRetries ?? 0 } });
    } catch (error) {
      if (options.signal?.aborted) throw new BrowserError('CANCELLED', 'Jev decision cancelled.', { cause: error });
      const status = typeof error === 'object' && error !== null && 'status' in error && typeof error.status === 'number' ? error.status : undefined;
      // Transport failures, 408, 429 and 5xx may succeed unchanged; the core clears this once a browser effect started.
      throw new BrowserError('PROVIDER_ERROR', `Jev request failed${status === undefined ? '' : ` (HTTP ${status})`}; no browser action was retried.`, { cause: error, retryable: status === undefined || status === 408 || status === 429 || status >= 500 });
    }
    const parsed = wireResult.safeParse(raw);
    if (!parsed.success) throw new BrowserError('INVALID_DECISION', 'Jev returned an invalid decision envelope.');
    for (const [id, question] of Object.entries(request.questions)) {
      const answer = parsed.data.answers[id];
      if (!answer || !Object.hasOwn(question.criteria, answer.choice))
        throw new BrowserError('INVALID_DECISION', 'Jev selected an unknown candidate or omitted an answer.');
    }
    return { ...parsed.data, elapsedMs: performance.now() - start };
  }
}
