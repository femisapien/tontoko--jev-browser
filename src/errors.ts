import type { RunResult, SemanticFailure } from './types.js';

/** Codes this package emits. They are never renamed or removed; new codes are additive. */
export type BrowserErrorCode =
  | 'ACTION_DENIED' | 'ACTION_FAILED' | 'ACTION_INTERRUPTED' | 'AMBIGUOUS_REGION' | 'AMBIGUOUS_SELECTION' | 'AMBIGUOUS_TARGET' | 'ASSERTION_FAILED'
  | 'BROWSER_LAUNCH_FAILED' | 'BUSY' | 'CANCELLED' | 'CANDIDATE_LIMIT' | 'CAPABILITY_DISABLED' | 'CLOSED' | 'CONFIG'
  | 'CONTINUATION_CONFLICT' | 'CONTINUATION_CONTEXT_CHANGED' | 'CONTINUATION_NOT_FOUND' | 'DECISION_LIMIT' | 'DIALOG_PENDING'
  | 'EXTRACTION_MISSING' | 'EXTRACTION_SCHEMA' | 'FILE_ACCESS_DENIED' | 'INVALID_ARGUMENT' | 'INVALID_DECISION' | 'INVALID_SELECTOR' | 'INVALID_URL'
  | 'NAVIGATION_FAILED' | 'NO_DIALOG' | 'NO_FILE_CHOOSER' | 'NO_MATCH' | 'NO_TRACE' | 'NOT_FOUND' | 'OBSERVATION_LIMIT' | 'OPERATION_FAILED' | 'ORIGIN_DENIED'
  | 'PROVIDER_ERROR' | 'RUN_FAILED' | 'SCOPE_NOT_FOUND' | 'SCREEN_COORDINATES' | 'SCREEN_DIALOG_UNSUPPORTED' | 'SCREEN_FAILED' | 'SCREEN_FILE_CHOOSER_UNSUPPORTED'
  | 'SCREEN_INTERRUPTED' | 'SCREEN_ONLY' | 'SCREEN_POPUP_UNSUPPORTED' | 'SCREEN_VIEWPORT_UNSUPPORTED' | 'SEMANTIC_AMBIGUOUS' | 'SEMANTIC_ASSERTION_FAILED'
  | 'SEMANTIC_ASSERTION_INCONCLUSIVE' | 'SEMANTIC_INCONCLUSIVE' | 'SEMANTIC_NO_MATCH' | 'SESSION_ACCESS' | 'SESSION_ERROR' | 'SESSION_MODE_MISMATCH'
  | 'SESSION_NOT_FOUND' | 'SESSION_START_FAILED' | 'SESSION_UNAVAILABLE' | 'STALE_DIALOG' | 'STALE_PLAN' | 'STALE_SCREEN' | 'STALE_SNAPSHOT' | 'STALE_TARGET'
  | 'STEP_LIMIT' | 'TARGET_OBSCURED' | 'TIMEOUT' | 'UNAUTHORIZED' | 'UNRESOLVED_ACTION' | 'UNSUPPORTED_INPUT' | 'UNSUPPORTED_SCHEMA' | 'VALUE_MISMATCH';
export interface BrowserErrorOptions { cause?: unknown; retryable?: boolean }
export interface PublicError { code: BrowserErrorCode; message: string; retryable: boolean; partial?: RunResult; semantic?: SemanticFailure }

/** Stable error codes are safe to expose over CLI/MCP; never include provider bodies. `cause` stays local and is never serialized. */
export class BrowserError extends Error {
  partial?: RunResult;
  semantic?: SemanticFailure;
  /** True only when repeating the same call unchanged may succeed and cannot repeat an effect of this attempt. */
  retryable: boolean;
  constructor(readonly code: BrowserErrorCode, message: string, options: BrowserErrorOptions = {}) {
    super(message, 'cause' in options ? { cause: options.cause } : undefined);
    this.name = 'BrowserError';
    this.retryable = options.retryable === true;
  }
}

const urls = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi;
const evaluation = /^\w+\.(?:evaluate|evaluateHandle|\$eval|\$\$eval|waitForFunction):/;
/** First line of a local failure, without URL credentials, query or fragment. Page-thrown evaluation messages are withheld. */
export function diagnostic(error: unknown): string | undefined {
  if (!(error instanceof Error) || !error.message) return;
  let line = error.message.split('\n', 1)[0]!.trim();
  if (evaluation.test(line) && !/Execution context was destroyed|Target page, context or browser has been closed|Target closed|Timeout \d+ms exceeded|operation was aborted/.test(line)) line = line.slice(0, line.indexOf(':') + 1) + ' page evaluation failed';
  line = line.replace(urls, value => { try { const url = new URL(value); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; return url.href; } catch { return '[URL]'; } });
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}
const detail = (error: unknown): string => { const line = diagnostic(error); return line ? ` Cause: ${line}` : ''; };

/** Playwright retries an intercepted pointer action before dispatching it; a call log without a dispatch line proves no click was delivered. */
export function obscuredTarget(error: unknown): BrowserError | undefined {
  if (!(error instanceof Error) || !error.message.includes('intercepts pointer events') || /performing \w+ action|action done/.test(error.message)) return;
  return new BrowserError('TARGET_OBSCURED', 'Another element intercepts pointer events over the target, so the action was not delivered. Dismiss or wait for the covering element (for example a banner or modal), then observe again.', { cause: error });
}

/** Map an unexpected local failure to a stable code. The original error remains available as `cause`. */
export function browserError(error: unknown): BrowserError {
  if (error instanceof BrowserError) return error;
  const name = error instanceof Error ? error.name : '', message = error instanceof Error ? error.message : '', first = message.split('\n', 1)[0]!;
  const obscured = obscuredTarget(error); if (obscured) return obscured;
  if (/Timeout/.test(name)) return new BrowserError('TIMEOUT', `The operation timed out.${detail(error)}`, { cause: error });
  if (/Abort/.test(name)) return new BrowserError('CANCELLED', 'The operation was cancelled.', { cause: error });
  if (/strict mode violation/.test(first)) {
    const count = /resolved to (\d+) elements/.exec(first)?.[1] ?? 'several';
    return new BrowserError('AMBIGUOUS_TARGET', `The selector matched ${count} elements; strict mode requires exactly one. Use a more specific selector or a snapshot ref.${detail(error)}`, { cause: error });
  }
  if (/while parsing (?:css )?selector|Unknown engine|Unexpected token .*selector|is not a valid selector/i.test(first)) return new BrowserError('INVALID_SELECTOR', `The selector is invalid.${detail(error)}`, { cause: error });
  if (/^(?:page|frame)\.(?:goto|goBack|goForward|reload):/.test(first)) return new BrowserError('NAVIGATION_FAILED', `Navigation failed.${detail(error)}`, { cause: error });
  return new BrowserError('OPERATION_FAILED', `Operation failed. Inspect the local browser or trace; no action was automatically retried.${detail(error)}`, { cause: error });
}

/** Keep Playwright's install guidance while withholding its local banner and paths. */
export function launchError(error: unknown, browser: string): BrowserError {
  if (error instanceof BrowserError) return error;
  const message = error instanceof Error ? error.message : '';
  if (/Looks like Playwright|npx playwright install/i.test(message))
    return new BrowserError('BROWSER_LAUNCH_FAILED', `The ${browser} build required by this Playwright version is not installed. Run \`jev-browser install ${browser}\` (or \`npx playwright install ${browser}\`).`, { cause: error });
  return new BrowserError('BROWSER_LAUNCH_FAILED', `The browser could not be launched or connected.${detail(error)}`, { cause: error });
}

export function publicError(error: unknown): PublicError {
  const mapped = browserError(error);
  return { code: mapped.code, message: mapped.message, retryable: mapped.retryable, ...(mapped.partial ? { partial: mapped.partial } : {}), ...(mapped.semantic ? { semantic: mapped.semantic } : {}) };
}
