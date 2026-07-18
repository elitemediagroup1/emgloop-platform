// CallGridProvider - Sprint 11 (First Live Integration) + Sprint 17 hardening
// + Sprint 18 ingestion truth fix (PR #41).
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
//
// PR #41 - CallGrid ingestion truth fix. The audit in this sprint proved every
// live CallGrid webhook had Template Mode OFF and Body = literal '{}' (no data
// was ever sent). This adapter now parses the CONFIRMED canonical CallGrid
// webhook body - a flat JSON object using the real tag names available in
// CallGrid's own 'Insert tag' picker (see docs/integrations/CALLGRID.md history
// and the PR description for the exact [[category:VariableName]] template).
// Every canonical key is read FIRST; every previous/legacy key spelling is kept
// as a fallback so older test payloads keep working unchanged. A value CallGrid
// did not send is left OUT of the payload entirely (never fabricated to 0 /
// false / 'completed') so downstream readers see an honest 'unknown'.

import type { ProviderContext } from '../types';
import type {
    IngestionProvider,
    IngestionCapabilities,
    InboundEvent,
    PollOptions,
    PollResult,
    WebhookVerificationResult,
} from '../interfaces/ingestion.provider';
import { verifyCallGridAuth, parseTimestamp } from '../webhook-security';
import { fetchAllCallGridCalls } from './callgrid-api';

// ---- CallGrid raw event vocabulary ----------------------------------------
// CallGrid sends a 'callStatus' string (the real API/webhook enum: QUEUED,
// INITIATED, RINGING, IN_PROGRESS, COMPLETED, BUSY, FAILED, NO_ANSWER,
// CANCELED, REJECTED, BLOCKED) or, on older/legacy senders, a looser
// 'call_status'/'event'/'status' string. We map each to the canonical platform
// call.* event taxonomy. Anything unrecognized maps to a generic inbound call
// so no event is silently dropped - and, critically, is NEVER mapped to
// call.completed just because it is unrecognized (see mapCallgridEventType).
export const CALLGRID_EVENT_MAP: Record<string, string> = {
    call_inbound: 'call.inbound',
    inbound: 'call.inbound',
    ringing: 'call.inbound',
    queued: 'call.inbound',
    initiated: 'call.inbound',
    call_answered: 'call.answered',
    answered: 'call.answered',
    in_progress: 'call.answered',
    connected: 'call.answered',
    call_missed: 'call.missed',
    missed: 'call.missed',
    no_answer: 'call.missed',
    busy: 'call.missed',
    failed: 'call.missed',
    canceled: 'call.missed',
    cancelled: 'call.missed',
    rejected: 'call.missed',
    blocked: 'call.missed',
    call_completed: 'call.completed',
    completed: 'call.completed',
    hangup: 'call.completed',
    ended: 'call.completed',
    call_voicemail: 'call.voicemail',
    voicemail: 'call.voicemail',
    call_transferred: 'call.transferred',
    transferred: 'call.transferred',
};

/** Map a raw CallGrid status to the canonical loop event type string. Unknown
 * or unrecognized statuses fall through to the generic 'call.inbound' bucket -
 * they are NEVER defaulted to 'call.completed'. */
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
          // JSON booleans MUST be readable here. CallGrid sends billable /
          // converted / paid / noRoute as real booleans, and returning undefined
          // for them made the derived `qualified` flag undefined for every such
          // call — so qualified counts and qualification rate silently
          // under-reported against calls that were unambiguously billable.
          if (typeof v === 'boolean') return String(v);
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
      // Health is 'ok' as long as the adapter is registered and resolvable.
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
     *
     * PR #41: reads the CONFIRMED canonical CallGrid webhook body first (id,
     * callStatus, endedBy, occurredAtUnix, callerId, vendorId/vendorName,
     * sourceId/sourceName, campaignId/campaignName, buyerId/buyerName,
     * destinationId/destinationName, inboundState, inboundZip, durationSeconds,
     * billable, paid, converted, completed, noRoute, revenue, payout, cost), with
     * every older/legacy key spelling kept as a fallback so nothing that worked
     * before stops working. A field CallGrid did not actually send is left OUT of
     * the normalized payload (never fabricated) so it reads as 'unknown'
     * downstream, per the platform constitution.
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

      // Real CallGrid webhook/API status field is 'callStatus'. Checked FIRST;
      // legacy senders are still read via the fallback keys. Default is the
      // honest 'unknown' string, NEVER 'completed' or 'inbound' fabricated as if
      // it were a real status - mapCallgridEventType() below buckets an
      // unrecognized value into the generic call.inbound event, not call.completed.
      const rawEventType =
              pick(data, ['callStatus', 'status', 'call_status', 'event', 'type']) ?? 'unknown';

      // How the call ended (buyer/caller/system). Purely informational metadata;
      // no downstream reader depends on it yet, so a missing value is fine.
      const endedBy = pick(data, ['endedBy', 'call_ended_by', 'callEndedBy']);

      // occurredAtUnix is the canonical CallGrid timestamp (UTCUnixTime tag),
      // delivered as unix seconds or milliseconds. parseTimestamp (shared with
      // webhook-security's replay/timestamp checks) applies the same 10-digit vs
      // 13-digit heuristic. Older senders that post an ISO-ish timestamp under a
      // legacy key are still supported as a fallback.
      const occurredAtUnixRaw = pick(data, ['occurredAtUnix', 'UTCUnixTime']);
        const legacyOccurredRaw = pick(data, ['occurred_at', 'started_at', 'timestamp', 'created_at']);
        let occurredAt: Date;
        if (occurredAtUnixRaw !== undefined) {
                const ms = parseTimestamp(occurredAtUnixRaw);
                occurredAt = Number.isFinite(ms) ? new Date(ms) : new Date();
        } else if (legacyOccurredRaw) {
                const d = new Date(legacyOccurredRaw);
                occurredAt = Number.isNaN(d.getTime()) ? new Date() : d;
        } else {
                occurredAt = new Date();
        }

      // Caller phone: canonical key is 'callerId'; legacy aliases kept.
      const customerPhone = pick(data, [
              'callerId',
              'caller_number',
              'from',
              'from_number',
              'fromNumber',
              'caller',
            ]);

      // Attribution + routing dimensions. Canonical body sends BOTH an id and a
      // human-readable name for each dimension (e.g. vendorId + vendorName); we
      // preserve both under distinct metadata keys rather than collapsing them,
      // so a Truth Engine can later reconcile ids without losing the display name.
      const vendorId = pick(data, ['vendorId']);
        const vendorName = pick(data, ['vendorName', 'vendor', 'traffic_partner', 'trafficPartner']);
        const sourceId = pick(data, ['sourceId']);
        const sourceName = pick(data, ['sourceName', 'source', 'traffic_source', 'trafficSource']);
        const campaignId = pick(data, ['campaignId']);
        const campaignName = pick(data, ['campaignName', 'campaign', 'campaign_name']);
        const buyerId = pick(data, ['buyerId']);
        const buyerName = pick(data, ['buyerName', 'buyer', 'buyer_name']);
        const destinationId = pick(data, ['destinationId']);
        const destinationName = pick(data, [
                'destinationName',
                'destination',
                'routing_destination',
                'routingDestination',
                'destination_number',
              ]);
        const callerState = pick(data, ['inboundState', 'caller_state', 'callerState', 'state']);
        const callerZip = pick(data, ['inboundZip', 'caller_zip', 'callerZip', 'zip', 'zipcode']);

      // Numeric + boolean dimensions. numeric() coerces '135'/'24.00' to number;
      // boolFrom() coerces yes/no/true/false/1/0 to a real boolean. A field CallGrid
      // omitted stays undefined and is dropped by defined() below - never coerced
      // to 0/false.
      const durationSeconds = numeric(
              pick(data, ['durationSeconds', 'duration', 'duration_seconds', 'billable_duration']),
            );
        const revenue = numeric(pick(data, ['revenue', 'revenue_amount', 'revenueAmount']));
        const payout = numeric(pick(data, ['payout', 'payout_amount', 'payoutAmount']));
        // cost is CallGrid's telco-cost field (there is no separate 'Telco' tag);
      // mirrored onto both 'cost' and 'telco' metadata keys so either reader works.
      const cost = numeric(pick(data, ['cost', 'telco', 'telco_cost', 'telcoCost']));
        const billable = boolFrom(pick(data, ['billable', 'is_billable', 'isBillable']));
        const paid = boolFrom(pick(data, ['paid', 'is_paid', 'isPaid']));
        const converted = boolFrom(pick(data, ['converted', 'is_converted', 'isConverted', 'conversion']));
        const completed = boolFrom(pick(data, ['completed', 'is_completed', 'isCompleted']));
        const noRoute = boolFrom(pick(data, ['noRoute', 'no_route', 'isNoRoute']));
        // Qualified: a call the buyer/business treats as a real, valuable lead.
      // Derived from CallGrid's own economic outcome flags so Live Calls /
      // Traffic Intelligence show qualification instead of a blank column. Stays
      // undefined (unknown) when none of the three signals were sent.
      const qualified =
              billable === true || converted === true || paid === true
            ? true
                : billable === false && converted === false && paid === false
              ? false
                  : undefined;

      // Canonical, normalization-ready payload. Spread the raw data FIRST so
      // every original key is preserved (backwards compatible), then layer the
      // canonical keys the downstream readers expect. defined() drops undefined
      // so we never clobber an existing value with undefined, and never fabricate
      // a value CallGrid did not send.
      const normalizedPayload: Record<string, unknown> = {
              ...data,
              ...defined({
                        // Live Calls reads fromNumber then caller for the caller column.
                                 caller: customerPhone,
                        fromNumber: customerPhone,
                        callerState,
                        callerZip,
                        endedBy,
                        vendorId,
                        vendor: vendorName,
                        sourceId,
                        source: sourceName,
                        campaignId,
                        campaign: campaignName,
                        buyerId,
                        buyer: buyerName,
                        destinationId,
                        destination: destinationName,
                        durationSeconds,
                        revenue,
                        payout,
                        cost,
                        telco: cost,
                        billable,
                        paid,
                        converted,
                        completed,
                        noRoute,
                        qualified,
              }),
      };

      return [
        {
                  externalId,
                  rawEventType,
                  occurredAt,
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
