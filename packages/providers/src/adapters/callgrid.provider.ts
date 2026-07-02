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
import { verifyCallGridAuth } from '../webhook-security';
import { fetchAllCallGridCalls } from './callgrid-api';

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


/** Coerce a string/number field into a finite number, or undefined. */
function numeric(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(String(value).trim());
  return Number.isFinite(n) ? n : undefined;
}

/** Coerce a CallGrid yes/no/true/1 style flag into a real boolean, or undefined. */
function boolFrom(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const v = String(value).trim().toLowerCase();
  if (v === 'yes' || v === 'true' || v === '1' || v === 'y') return true;
  if (v === 'no' || v === 'false' || v === '0' || v === 'n') return false;
  return undefined;
}

/** Drop keys whose value is undefined so a spread never clobbers a real value. */
function defined(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(obj)) {
    if (obj[k] !== undefined) out[k] = obj[k];
  }
  return out;
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
      polling: true,
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
    return verifyCallGridAuth(headers, rawBody, {
      secret: ctx.credentials?.['webhookSecret'] ?? '',
      allowUnsigned: ctx.config?.['allowUnsigned'] === true,
      signatureHeaders: ['x-callgrid-signature', 'x-callgrid-sig', 'x-signature'],
      timestampHeaders: ['x-callgrid-timestamp', 'x-timestamp'],
      staticHeaders: ['x-emg-webhook-secret'],
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

    // ---- Real CallGrid template body mapping (Sprint 17) -----------------
    // The live CallGrid webhook UI substitutes flat template keys such as
    // callerId, inboundState, inboundZip, vendor, source, campaign, buyer,
    // destination, duration, billable, paid, revenue, payout. Map them onto
    // the canonical attribute keys the NormalizationEngine / Live Calls /
    // Traffic Intelligence read, WITHOUT dropping any original field (the
    // full raw payload is still preserved on .payload). Existing field names
    // are kept and take precedence so older senders keep working.

    // Caller phone: prefer the real CallGrid key, then legacy aliases.
    const customerPhone = pick(data, [
      'callerId',
      'caller_number',
      'from',
      'from_number',
      'fromNumber',
      'caller',
    ]);

    // Attribution + routing dimensions (string).
    const vendor = pick(data, ['vendor', 'traffic_partner', 'trafficPartner']);
    const source = pick(data, ['source', 'traffic_source', 'trafficSource']);
    const campaign = pick(data, ['campaign', 'campaign_name', 'campaignName']);
    const buyer = pick(data, ['buyer', 'buyer_name', 'buyerName']);
    const destination = pick(data, ['destination', 'routing_destination', 'routingDestination', 'destination_number']);
    const callerState = pick(data, ['inboundState', 'caller_state', 'callerState', 'state']);
    const callerZip = pick(data, ['inboundZip', 'caller_zip', 'callerZip', 'zip', 'zipcode']);

    // Numeric + boolean dimensions. numeric() coerces "135"/"24.00" to number;
    // boolFrom() coerces yes/no/true/false/1/0 to a real boolean.
    const durationSeconds = numeric(pick(data, ['duration', 'duration_seconds', 'durationSeconds', 'billable_duration']));
    const revenue = numeric(pick(data, ['revenue', 'revenue_amount', 'revenueAmount']));
    const payout = numeric(pick(data, ['payout', 'payout_amount', 'payoutAmount']));
    const billable = boolFrom(pick(data, ['billable', 'is_billable', 'isBillable']));
    const paid = boolFrom(pick(data, ['paid', 'is_paid', 'isPaid']));
  const converted = boolFrom(pick(data, ['converted', 'is_converted', 'isConverted', 'conversion']));
  // Qualified: a call the buyer/business treats as a real, valuable lead.
  // Derived from CallGrid's own economic outcome flags so Live Calls /
  // Traffic Intelligence show qualification instead of a blank column.
  const qualified =
    billable === true || converted === true || paid === true
      ? true
      : billable === false && converted === false && paid === false
        ? false
        : undefined;

    // Canonical, normalization-ready payload. Spread the raw data FIRST so
    // every original key is preserved (backwards compatible), then layer the
    // canonical keys the downstream readers expect. defined() drops undefined
    // so we never clobber an existing value with undefined.
    const normalizedPayload: Record<string, unknown> = {
      ...data,
      ...defined({
        // Live Calls reads fromNumber then caller for the caller column.
        caller: customerPhone,
        fromNumber: customerPhone,
        callerState,
        callerZip,
        vendor,
        source,
        campaign,
        buyer,
        destination,
        durationSeconds,
        revenue,
        payout,
        billable,
        paid,
        converted,
        qualified,
      }),
    };

    return [
      {
        externalId,
        rawEventType,
        occurredAt: Number.isNaN(occurredAt.getTime()) ? new Date() : occurredAt,
        payload: normalizedPayload,
        customerPhone,
      },
    ];
  }

  async poll(ctx: ProviderContext, options: PollOptions): Promise<PollResult> {
    // Reconciliation / backfill layer. Reads completed calls from the CallGrid
    // REST API (source of truth) so the Loop can fill gaps the webhook missed.
    // The API key is resolved from ProviderContext.credentials (never stored).
    const apiKey = ctx.credentials.apiKey || ctx.credentials.callgridApiKey;
    if (!apiKey) {
      // No key configured: behave like webhook-only (no polling), do not throw
      // so callers can degrade gracefully and surface a diagnostic instead.
      return { events: [], hasMore: false };
    }
    const baseUrl =
      typeof ctx.config?.['apiBaseUrl'] === 'string'
        ? (ctx.config['apiBaseUrl'] as string)
        : undefined;
    const { events } = await fetchAllCallGridCalls({
      apiKey,
      since: options.since,
      limit: options.limit,
      cursor: options.cursor,
      baseUrl,
    });
    return { events, hasMore: false };
  }
}
