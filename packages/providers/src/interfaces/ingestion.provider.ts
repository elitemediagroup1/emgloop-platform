// IngestionProvider — Sprint 10 (Loop Intelligence Foundation).
//
// Provider-agnostic interface for external event ingestion sources.
// CallGrid, Google Analytics, Google Ads, Search Console, Microsoft Clarity,
// Stripe, Twilio, Telnyx, Postmark — all implement this interface.
// No vendor SDK is imported here. The interface defines the contract only.


import type { BaseProvider, ProviderContext } from '../types';


// ---- Inbound event shape from the external system -------------------------

/** Raw event as delivered by the source system (before normalization). */
export interface InboundEvent {
  /** Stable id in the source system. Used for idempotency. */
  externalId: string;
  /** Source-specific event type string (e.g. "call_completed", "session"). */
  rawEventType: string;
  /** When the event occurred in the source system. */
  occurredAt: Date;
  /** Full raw payload from the source. Stored as-is in IntegrationEvent. */
  payload: Record<string, unknown>;
  /** Optional customer identifiers extracted by the adapter. */
  customerEmail?: string;
  customerPhone?: string;
}

// ---- Provider capabilities ------------------------------------------------

export interface IngestionCapabilities {
  /** Whether the provider supports inbound webhooks. */
  webhooks: boolean;
  /** Whether the provider supports polling/batch fetch. */
  polling: boolean;
  /** Whether the provider supports real-time streaming. */
  streaming: boolean;
  /** Human-readable list of event types this provider can deliver. */
  eventTypes: readonly string[];
}

// ---- Webhook verification --------------------------------------------------

export interface WebhookVerificationResult {
  valid: boolean;
  reason?: string;
  /** Which auth method succeeded (CallGrid multi-mode): hmac | bearer | static-header | unsigned-preview. */
  method?: 'hmac' | 'bearer' | 'static-header' | 'unsigned-preview';
  /** Signed timestamp validated during verification (ms epoch), if present. */
  timestamp?: number;
  /** Short non-secret fingerprint of the accepted signature, for diagnostics. */
  signaturePrefix?: string;
}

// ---- Polling support -------------------------------------------------------

export interface PollOptions {
  /** ISO timestamp — fetch events that occurred after this date. */
  since: Date;
  /**
   * Exclusive upper bound. Absent means "up to now".
   *
   * Required for any BOUNDED read — certifying one business date, or recovering
   * one historical day — because a window with no end is a window whose contents
   * change while you are reading it, and nothing may be certified over that.
   */
  until?: Date;
  /** Maximum number of events to return per poll. */
  limit?: number;
  /**
   * Adapter page budget. A safety bound, never a completeness claim: an adapter
   * that reaches it while the provider has more MUST report `truncated`.
   */
  maxPages?: number;
  /** Pagination cursor from the previous poll response. */
  cursor?: unknown;
}

export interface PollResult {
  events: InboundEvent[];
  /** Cursor for the next poll call. Undefined means no more pages. */
  nextCursor?: unknown;
  hasMore: boolean;
  // --- Pagination evidence. Optional, because not every adapter paginates. -----
  //
  // An adapter that DOES paginate must populate these truthfully. They exist so a
  // caller can record WHY a read ended, which is the difference between "the
  // provider had nothing more" and "we ran out of budget". Reporting a budgeted
  // stop as a clean finish is what let a 6,918-call day look like 2,500.
  /** Pages actually requested. */
  pagesFetched?: number;
  /** The budget that applied. */
  pageCap?: number;
  /** Raw records seen, before mapping dropped any. */
  recordsFetched?: number;
  /** True only when the adapter stopped while the provider still had pages. */
  truncated?: boolean;
}

// ---- Provider interface ---------------------------------------------------

export interface IngestionProvider extends BaseProvider {
  readonly info: BaseProvider['info'] & { category: 'ingestion' };

  /** Describe this provider's supported capabilities. */
  capabilities(): IngestionCapabilities;

  /**
   * Verify that an inbound webhook request is authentic.
   * Returns { valid: true } if the signature / token is valid.
   * No provider secret is stored here — credentials come from ProviderContext.
   */
  verifyWebhook(
    ctx: ProviderContext,
    headers: Record<string, string>,
    rawBody: string,
  ): Promise<WebhookVerificationResult>;

  /**
   * Parse a verified webhook payload into normalized InboundEvents.
   * One webhook delivery may contain multiple events.
   */
  parseWebhook(
    ctx: ProviderContext,
    payload: Record<string, unknown>,
  ): Promise<InboundEvent[]>;

  /**
   * Poll the source for events since the given timestamp.
   * Only available if capabilities().polling === true.
   * Providers that do not support polling should throw an Error.
   */
  poll(ctx: ProviderContext, options: PollOptions): Promise<PollResult>;
}
