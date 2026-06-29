// CallGridProvider - Sprint 11 (First Live Integration) + Sprint 17 hardening.
//
// The platform's FIRST real ingestion adapter. CallGrid is a call-tracking
// provider: it delivers webhooks for inbound/answered/missed/completed calls,
// each carrying a tracking number, caller/called numbers, duration, billable
// duration, recording URL, optional transcript, and campaign/source attribution.
//
// This adapter ONLY translates CallGrid's wire format into the platform's
// provider-agnostic InboundEvent shape. It contains NO business logic and writes
// NO data - normalization, persistence, signals, and workflows all happen
// downstream in the NormalizationEngine. Swapping CallGrid for another call
// provider means writing another adapter; nothing else changes.
//
// No vendor SDK is imported. Sprint 17 routes verification through the shared
// verifySignedWebhook helper so CallGrid gets HMAC-SHA256 signature checking,
// timestamp validation and replay protection identically to every other signed
// ingress. The shared secret is resolved from ProviderContext (never stored here).

import type { ProviderContext } from '../types';
import type {
  IngestionProvider,
  IngestionCapabilities,
  InboundEvent,
  PollOptions,
  PollResult,
  WebhookVerificationResult,
} from '../interfaces/ingestion.provider';
import { verifySignedWebhook } from '../webhook-security';

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

// ---- Provider --------------------------------------------------------------

export class CallGridProvider implements IngestionProvider {
  readonly info = {
    id: 'callgrid',
    category: 'ingestion' as const,
    displayName: 'CallGrid',
  };

  async healthCheck(_ctx: ProviderContext) {
    // No outbound network call in this sprint - the adapter is webhook-driven.
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
   * Verify an inbound CallGrid webhook. Sprint 17 delegates to the shared
   * verifySignedWebhook helper so signature, timestamp and replay checks are
   * identical across every signed ingress. The shared secret comes from
   * ProviderContext.credentials.webhookSecret. If no secret is configured the
   * request is rejected (fail closed) unless ctx.config.allowUnsigned === true
   * (sandbox/preview only - production callers must pass allowUnsigned: false).
   */
  async verifyWebhook(
    ctx: ProviderContext,
    headers: Record<string, string>,
    rawBody: string,
  ): Promise<WebhookVerificationResult> {
    return verifySignedWebhook(headers, rawBody, {
      secret: ctx.credentials?.['webhookSecret'] ?? '',
      allowUnsigned: ctx.config?.['allowUnsigned'] === true,
      signatureHeaders: ['x-callgrid-signature', 'x-callgrid-sig', 'x-signature'],
      timestampHeaders: ['x-callgrid-timestamp', 'x-timestamp'],
    });
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
