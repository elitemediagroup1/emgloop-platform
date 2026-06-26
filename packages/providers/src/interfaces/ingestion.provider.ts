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
}

// ---- Polling support -------------------------------------------------------

export interface PollOptions {
  /** ISO timestamp — fetch events that occurred after this date. */
  since: Date;
  /** Maximum number of events to return per poll. */
  limit?: number;
  /** Pagination cursor from the previous poll response. */
  cursor?: string;
}

export interface PollResult {
  events: InboundEvent[];
  /** Cursor for the next poll call. Undefined means no more pages. */
  nextCursor?: string;
  hasMore: boolean;
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
