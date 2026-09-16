// Provider errors, mapped into Loop's taxonomy. Slices B5 and AI-3.
//
// AN ADAPTER MAPS; THE RUNTIME DECIDES. This is the only judgement an adapter makes:
// which class of failure a provider just reported. Whether to retry, fall back,
// repair or give up is Loop's, decided by `providerFailurePolicy` -- so two providers
// cannot come to mean different things by "try again".
//
// STATUS CODES AND ERROR TYPES, NOT PROSE. Both SDKs expose an HTTP `status`, a named
// error class, and the provider's own error `type`. Those decide the class. A
// provider's message is read in exactly one place -- to tell an oversized context
// from any other bad request -- and is never kept.
//
// THE MESSAGE NEVER TRAVELS. A provider's error text can quote the request it
// rejected, and the request carries the organization's evidence. So the error Loop
// raises carries the failure class and the HTTP status, and nothing the provider wrote.
//
// UNKNOWN IS UNKNOWN. An error nobody recognises is UNCLASSIFIED, which the runtime
// neither retries nor falls back from. Guessing that an unknown error is transient is
// how a bug becomes a bill.

import type { AiFailureClass } from '@emgloop/shared';

/** What both SDKs' errors carry. Structural, so neither SDK's types leak outward. */
export interface ProviderErrorShape {
  readonly status?: number;
  readonly name?: string;
  readonly type?: string;
  readonly code?: string | null;
  readonly error?: { readonly type?: string; readonly code?: string } | null;
  readonly headers?: Record<string, string | undefined> | { get?(name: string): string | null };
}

const CONTEXT_WORDS = /context|token|too long|maximum|too large|exceeds/i;

function providerType(e: ProviderErrorShape): string {
  const nested = e.error && typeof e.error === 'object' ? e.error : null;
  const candidates = [nested?.type, nested?.code, e.type, e.code];
  return String(candidates.find((c) => typeof c === 'string' && c) ?? '');
}

export function classifyProviderError(err: unknown): AiFailureClass {
  const e = (err ?? {}) as ProviderErrorShape;
  const status = typeof e.status === 'number' ? e.status : undefined;
  const name = typeof e.name === 'string' ? e.name : '';
  const type = providerType(e);

  if (name === 'APIUserAbortError' || name === 'AbortError') return 'CANCELLED';
  if (name === 'APIConnectionTimeoutError' || status === 408) return 'TIMEOUT';
  if (name === 'APIConnectionError') return 'UNAVAILABLE';

  if (status === 401 || status === 403 || name === 'AuthenticationError' || name === 'PermissionDeniedError') return 'AUTH';
  if (type === 'authentication_error' || type === 'permission_error' || type === 'invalid_api_key') return 'AUTH';
  // A billing problem is not weather: somebody needs to know, and retrying cannot fix it.
  if (status === 402 || type === 'billing_error' || type === 'insufficient_quota') return 'AUTH';

  if (status === 429 || name === 'RateLimitError' || type === 'rate_limit_error' || type === 'rate_limit_exceeded') return 'RATE_LIMITED';
  if (status === 529 || type === 'overloaded_error') return 'UNAVAILABLE';

  if (status === 413 || type === 'request_too_large' || type === 'context_length_exceeded') return 'CONTEXT_TOO_LARGE';
  // A context that does not fit is a 400, but it is not the same bug as a malformed
  // request: one is re-assembled smaller, the other is Loop's to fix. This is the only
  // place a provider's words are read, and they are not kept.
  if (status === 400 && CONTEXT_WORDS.test(String((err as { message?: unknown })?.message ?? ''))) return 'CONTEXT_TOO_LARGE';
  if (
    status === 400 ||
    status === 404 ||
    status === 409 ||
    status === 422 ||
    name === 'BadRequestError' ||
    name === 'NotFoundError' ||
    name === 'ConflictError' ||
    name === 'UnprocessableEntityError' ||
    type === 'invalid_request_error' ||
    type === 'not_found_error'
  ) {
    return 'INVALID_REQUEST';
  }

  if ((status !== undefined && status >= 500) || name === 'InternalServerError' || type === 'api_error' || type === 'server_error') return 'UNAVAILABLE';
  return 'UNCLASSIFIED';
}

/** How long a provider asked us to wait, when it said. Never invented. */
export function retryAfterMs(err: unknown): number | null {
  const headers = (err as ProviderErrorShape)?.headers;
  if (!headers) return null;
  const raw =
    typeof (headers as { get?(name: string): string | null }).get === 'function'
      ? (headers as { get(name: string): string | null }).get('retry-after')
      : (headers as Record<string, string | undefined>)['retry-after'];
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : null;
}

/**
 * The only message a provider failure carries out of an adapter: the class and the
 * HTTP status. Nothing the provider wrote.
 */
export function providerFailureMessage(failure: AiFailureClass, err: unknown): string {
  const status = (err as ProviderErrorShape)?.status;
  return typeof status === 'number' ? `provider failure: ${failure} (HTTP ${status})` : `provider failure: ${failure}`;
}
