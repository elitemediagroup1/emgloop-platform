// CallGridProvider — Sprint 11 (First Live Integration).
//
// The platform's FIRST real ingestion adapter. CallGrid is a call-tracking
// provider: it delivers webhooks for inbound/answered/missed/completed calls,
// each carrying a tracking number, caller/called numbers, duration, billable
// duration, recording URL, optional transcript, and campaign/source attribution.
//
// This adapter ONLY translates CallGrid's wire format into the platform's
// provider-agnostic InboundEvent shape. It contains NO business logic and writes
// NO data — normalization, persistence, signals, and workflows all happen
// downstream in the NormalizationEngine. Swapping CallGrid for another call
// provider means writing another adapter; nothing else changes.
//
// No vendor SDK is imported. Webhook authenticity is verified with an HMAC-SHA256
// signature over the raw body using a shared secret resolved from ProviderContext
// (never stored in this file). Node's built-in crypto keeps dependencies at zero.

import { createHmac, timingSafeEqual } from 'crypto';
import type { ProviderContext } from '../types';
import type {
  IngestionProvider,
  IngestionCapabilities,
  InboundEvent,
  PollOptions,
  PollResult,
  WebhookVerificationResult,
} from '../interfaces/ingestion.provider';

// ---- CallGrid raw event vocabulary ----------------------------------------
// CallGrid sends a "call_status" (or "event") string. We map each to the
// canonical platform call.* event taxonomy. Anything unknown maps to a generic
// inbound call so no event is silently dropped.
export const CALLGRID_EVENT_MAP: Record<string, string> = {
  call_inbound: 'call.inbound',
  inbound: 'call.inbound',
  ringing: 'call.inbound',
  call_answered: 'call.answered',
  answered: 'call.answered',
  in_progress: 'call.answered',
  call_missed: 'call.missed',
  missed: 'call.missed',
  no_answer: 'call.missed',
  call_completed: 'call.completed',
  completed: 'call.completed',
  hangup: 'call.completed',
  call_voicemail: 'call.voicemail',
  voicemail: 'call.voicemail',
  call_transferred: 'call.transferred',
  transferred: 'call.transferred',
};

/** Map a raw CallGrid status to the canonical loop event type string. */
export function mapCallgridEventType(raw: string): string {
  const key = String(raw ?? '').toLowerCase().trim();
  return CALLGRID_EVENT_MAP[key] ?? 'call.inbound';
}

/** Pull a string field from a raw payload trying several common key spellings. */
function pick(payload: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = payload[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number') return String(v);
  }
  return undefined;
}

function pickNumber(payload: Record<string, unknown>, keys: string[]): number | undefined {
  for (const k of keys) {
    const v = payload[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v);
  }
  return undefined;
}

// ---- Provider --------------------------------------------------------------

export class CallGridProvider implements IngestionProvider {
  readonly info = {
    id: 'callgrid',
    category: 'ingestion' as const,
    displayName: 'CallGrid',
  };

  async healthCheck(_ctx: ProviderContext) {
    // No outbound network call in this sprint — the adapter is webhook-driven.
    // Health is "ok" as long as the adapter is registered and resolvable.
    return { ok: true, checkedAt: new Date().toISOString() };
  }

  capabilities(): IngestionCapabilities {
    return {
      webhooks: true,
      polling: false,
      streaming: false,
      eventTypes: [
        'call.inbound',
        'call.answered',
        'call.missed',
        'call.completed',
        'call.voicemail',
        'call.transferred',
      ],
    };
  }

  /**
   * Verify an inbound CallGrid webhook with an HMAC-SHA256 signature.
   * The shared secret comes from ProviderContext.credentials.webhookSecret.
   * If no secret is configured the request is rejected (fail closed), except
   * when ctx.config.allowUnsigned === true (used only for the sandbox/test
   * connection so reviewers can exercise the pipeline without a real secret).
   */
  async verifyWebhook(
    ctx: ProviderContext,
    headers: Record<string, string>,
    rawBody: string,
  ): Promise<WebhookVerificationResult> {
    const secret = ctx.credentials?.['webhookSecret'] ?? '';
    const allowUnsigned = ctx.config?.['allowUnsigned'] === true;

    if (!secret) {
      return allowUnsigned
        ? { valid: true, reason: 'unsigned-allowed' }
        : { valid: false, reason: 'no-secret-configured' };
    }

    const provided =
      headers['x-callgrid-signature'] ??
      headers['x-callgrid-sig'] ??
      headers['x-signature'] ??
      '';
    if (!provided) {
      return { valid: false, reason: 'missing-signature-header' };
    }

    const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(provided.replace(/^sha256=/, ''), 'utf8');
    const valid = a.length === b.length && timingSafeEqual(a, b);
    return valid ? { valid: true } : { valid: false, reason: 'signature-mismatch' };
  }

  /**
   * Parse a verified CallGrid webhook body into one InboundEvent.
   * CallGrid delivers a single call event per webhook. The full raw payload is
   * preserved on .payload so the NormalizationEngine and the customer timeline
   * keep every CallGrid attribute (recording, transcript, campaign, etc.).
   */
  async parseWebhook(
    _ctx: ProviderContext,
    payload: Record<string, unknown>,
  ): Promise<InboundEvent[]> {
    const data =
      payload && typeof payload['call'] === 'object' && payload['call'] !== null
        ? (payload['call'] as Record<string, unknown>)
        : payload;

    const externalId =
      pick(data, ['id', 'call_id', 'callId', 'uuid', 'sid']) ??
      'callgrid-' + Date.now();

    const rawEventType = pick(data, ['status', 'call_status', 'event', 'type']) ?? 'inbound';

    const occurredRaw = pick(data, ['occurred_at', 'started_at', 'timestamp', 'created_at']);
    const occurredAt = occurredRaw ? new Date(occurredRaw) : new Date();

    const customerPhone = pick(data, ['caller_number', 'from', 'from_number', 'caller']);

    return [
      {
        externalId,
        rawEventType,
        occurredAt: Number.isNaN(occurredAt.getTime()) ? new Date() : occurredAt,
        payload: data,
        customerPhone,
      },
    ];
  }

  async poll(_ctx: ProviderContext, _options: PollOptions): Promise<PollResult> {
    // CallGrid is webhook-only in this sprint.
    return { events: [], hasMore: false };
  }
}
