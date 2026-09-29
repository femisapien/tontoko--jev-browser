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
      defaultModel: options.model ?? process.env.JEV_MODEL,
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
      raw = await this.client.systemOne(request, { signal: options.signal, retry: { maxRetries: options.maxRetries ?? 0 } });
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
