// SMS / messaging provider interface.
//
// Abstracts telephony + messaging providers (Twilio, Telnyx, ...). No direct
// Twilio dependency anywhere in the platform — everything goes through this.

import type { BaseProvider, ProviderContext } from '../types';

export interface SendSmsRequest {
  to: string;   // E.164
  from: string; // E.164 or messaging-service id
  body: string;
  mediaUrls?: string[];
  /** Idempotency key so retries don't double-send. */
  idempotencyKey?: string;
}

export interface SendSmsResult {
  /** Provider message id (stored as Message.externalId). */
  externalId: string;
  status: 'queued' | 'sent' | 'delivered' | 'failed' | 'unknown';
}

/** Normalized inbound message parsed from a provider webhook. */
export interface InboundSms {
  externalId: string;
  from: string;
  to: string;
  body: string;
  mediaUrls?: string[];
  receivedAt: string; // ISO
  raw?: unknown;
}

export interface SmsProvider extends BaseProvider {
  sendSms(ctx: ProviderContext, req: SendSmsRequest): Promise<SendSmsResult>;
  /** Parse a raw provider webhook payload into a normalized inbound message. */
  parseInbound(ctx: ProviderContext, payload: unknown): Promise<InboundSms>;
  /** Verify a webhook signature; returns true when authentic. */
  verifyWebhook?(
    ctx: ProviderContext,
    payload: unknown,
    headers: Record<string, string>,
  ): Promise<boolean>;
}
