// Shared provider abstraction types.
//
// EMG Loop owns the intelligence, not the infrastructure. Every external
// capability (AI, voice, SMS, email, payments, calendars) is expressed through
// a narrow interface so providers can be swapped without touching the core.

import type { ProviderCategory } from '@emgloop/shared';

export type { ProviderCategory };

/** Identifies a concrete provider implementation. */
export interface ProviderInfo {
  /** Stable machine name, e.g. "anthropic", "twilio", "telnyx", "stripe". */
  readonly id: string;
  readonly category: ProviderCategory;
  readonly displayName: string;
}

/** Credentials/config resolved per tenant from a ProviderConnection. */
export interface ProviderContext {
  organizationId: string;
  /** Opaque, resolved by the host (secrets manager ref -> values). */
  credentials: Record<string, string>;
  config?: Record<string, unknown>;
}

/** Base contract every provider adapter implements. */
export interface BaseProvider {
  readonly info: ProviderInfo;
  /** Lightweight connectivity / credential check. */
  healthCheck(ctx: ProviderContext): Promise<ProviderHealth>;
}

export interface ProviderHealth {
  ok: boolean;
  message?: string;
  checkedAt: string; // ISO timestamp
}

/** Normalized error surface so callers never depend on a vendor SDK error. */
export class ProviderError extends Error {
  constructor(
    public readonly providerId: string,
    message: string,
    public readonly code?: string,
    public override readonly cause?: unknown,  ) {
    super(message);
    this.name = 'ProviderError';
  }
}
