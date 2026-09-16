// Provider errors, mapped into Loop's taxonomy. Slice B5 (S1 preparation).
//
// AN ADAPTER MAPS; THE RUNTIME DECIDES. This is the only judgement an adapter makes:
// which class of failure a provider just reported. Whether to retry, fall back,
// repair or give up is Loop's, decided by `providerFailurePolicy` -- so two providers
// cannot come to mean different things by "try again", and adding a third provider
// cannot change what a rate limit implies.
//
// STATUS CODES, NOT MESSAGES. Both SDKs expose the same error shape (a `status`
// number and named subclasses). Matching on prose would break the first time either
// vendor rewrote a sentence, and the breakage would look like a retry policy change.

import type { AiFailureClass } from '@emgloop/shared';

/** What both SDKs' errors carry. Structural, so neither SDK's types leak outward. */
export interface ProviderErrorShape {
  readonly status?: number;
  readonly name?: string;
  readonly headers?: Record<string, string | undefined> | { get?(name: string): string | null };
}

/**
 * The failure class a provider error belongs to. Anything unrecognised is
 * UNAVAILABLE, which the runtime retries a bounded number of times and may fall back
 * from -- the safe reading for "something went wrong and we do not know what".
 */
export function classifyProviderError(err: unknown): AiFailureClass {
  const e = (err ?? {}) as ProviderErrorShape;
  const status = typeof e.status === 'number' ? e.status : undefined;
  const name = typeof e.name === 'string' ? e.name : '';

  if (status === 401 || status === 403 || name === 'AuthenticationError' || name === 'PermissionDeniedError') return 'AUTH';
  if (status === 429 || name === 'RateLimitError') return 'RATE_LIMITED';
  if (status === 408 || name === 'APIConnectionTimeoutError') return 'TIMEOUT';
  // A context that does not fit is a 400, but it is not the same bug as a malformed
  // request: one is re-assembled smaller, the other is Loop's to fix.
  if (status === 400 && /context|token|too long|maximum/i.test(String((err as { message?: string })?.message ?? ''))) {
    return 'CONTEXT_TOO_LARGE';
  }
  if (status === 400 || status === 404 || status === 422 || name === 'BadRequestError' || name === 'NotFoundError') return 'INVALID_REQUEST';
  if (status !== undefined && status >= 500) return 'UNAVAILABLE';
  if (name === 'APIConnectionError' || name === 'InternalServerError') return 'UNAVAILABLE';
  return 'UNAVAILABLE';
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
