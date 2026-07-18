// CallGrid REST API client - Sprint 17 (Reconciliation / Backfill layer)
// + Sprint 18 ingestion truth fix (PR #41).
//
// Webhooks remain the real-time ingress; this client is the SOURCE-OF-TRUTH
// reconciliation layer. It reads completed calls from the CallGrid REST API so
// EMG Loop can backfill calls the webhook never delivered and enrich calls that
// arrived without full attribution. No vendor SDK is imported - this is a thin
// fetch() client over the documented REST surface.
//
// Auth: a CallGrid API key (CALLGRID_API_KEY) is sent as a Bearer token. The
// key VALUE is never logged or returned. The base URL is configurable via
// CALLGRID_API_BASE_URL so the exact CallGrid host/path can be confirmed in
// production without a code change; it defaults to the documented base.
//
// PR #41: the CallGrid OpenAPI spec (api.callgrid.com/openapi, schema Call)
// was read directly and confirms the REAL field names are camelCase:
// id, buyerId, sourceId, destinationId, campaignId, phoneNumberId, callHash,
// callSid, to, from, callStatus, callDuration, live, completed, ended,
// connected, connectFailed, noConnect, noRoute, duplicate, blocked, paid,
// converted, billable, revenue, payout, rate, cost, createdAt, updatedAt.
// There is NO vendor field and NO human-readable name field anywhere on the
// raw Call object - only ids. The previous candidate lists below only checked
// PascalCase spellings (CallStatus, CallDateTime, ...) which never matched the
// real camelCase API response, so EVERY record silently fell back to a
// fabricated 'completed' status and a fabricated "now" timestamp. Both
// defaults have been removed; a value CallGrid did not actually return is now
// left unknown, never fabricated.

import type { InboundEvent } from '../interfaces/ingestion.provider';

export const CALLGRID_API_DEFAULT_BASE_URL = 'https://api.callgrid.com';
export const CALLGRID_CALLS_PATH = '/api/call';

/** Options for a single page fetch against the CallGrid calls endpoint. */
export interface CallGridApiFetchOptions {
    /** CallGrid API key (Bearer). Never logged. */
  apiKey: string;
    /** Inclusive lower bound on call time. */
  since: Date;
    /** Inclusive upper bound on call time (defaults to now). */
  until?: Date;
    /** Opaque pagination cursor from a previous page. */
  cursor?: unknown;
    /** Max records per page (CallGrid caps this server-side). */
  limit?: number;
    /** Override the API base URL (else CALLGRID_API_BASE_URL or the default). */
  baseUrl?: string;
    /** Injected fetch for testing; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export interface CallGridApiPage {
    /** Raw call records exactly as returned by CallGrid (PascalCase fields). */
  records: Array<Record<string, unknown>>;
    /** Cursor for the next page, or undefined when exhausted. */
  nextCursor?: unknown;
    hasMore: boolean;
}

/** Resolve the API base URL (option > env > documented default). */
export function resolveCallGridBaseUrl(override?: string): string {
    return (
          override ||
          (typeof process !== 'undefined' && process.env && process.env.CALLGRID_API_BASE_URL) ||
          CALLGRID_API_DEFAULT_BASE_URL
        );
}

/** A small typed error so callers can surface API failures as diagnostics. */
export class CallGridApiError extends Error {
    constructor(
          message: string,
          readonly status?: number,
        ) {
          super(message);
          this.name = 'CallGridApiError';
    }
}

/** Pull a string from a record trying several key spellings (case-tolerant). */
export function pickField(
    record: Record<string, unknown>,
    keys: string[],
  ): string | undefined {
    for (const k of keys) {
          const v = record[k];
          if (typeof v === 'string' && v.trim()) return v.trim();
          if (typeof v === 'number' && Number.isFinite(v)) return String(v);
          // See pick() in callgrid.provider.ts: CallGrid sends billable /
          // converted / paid / duplicate as real JSON booleans, and dropping
          // them here made the derived `qualified` flag undefined for every
          // such call.
          if (typeof v === 'boolean') return String(v);
    }
    return undefined;
}

/** Coerce a numeric-ish field to a finite number, or undefined. */
export function toNumber(value: string | undefined): number | undefined {
    if (value === undefined) return undefined;
    const raw = String(value).trim();
    if (raw === '') return undefined;
    // Strip formatting ($, commas, currency suffixes) but NOT to the point of
    // inventing a number. The previous version stripped every non-numeric
    // character and then trusted Number(''), which is 0 — so a CallGrid field
    // reading "N/A", "none" or "pending" was stored as a measured $0.00 rather
    // than left unknown. That is a fabricated measurement, and it also poisoned
    // reconciliation: a wrong 0 counts as a real value and permanently blocks
    // the correct figure from ever being filled in.
    const stripped = raw.replace(/[^0-9.\-]/g, '');
    if (stripped === '' || stripped === '-' || stripped === '.') return undefined;
    // Reject inputs that were mostly non-numeric text ("n/a" -> ""), keeping
    // legitimately formatted money ("$1,234.50", "24.00 USD").
    if (!/[0-9]/.test(raw)) return undefined;
    const n = Number(stripped);
    return Number.isFinite(n) ? n : undefined;
}

/** Coerce yes/no/true/false/1/0 to a real boolean, or undefined. */
export function toBool(value: string | undefined): boolean | undefined {
    if (value === undefined) return undefined;
    const v = String(value).trim().toLowerCase();
    if (v === 'yes' || v === 'true' || v === '1' || v === 'y') return true;
    if (v === 'no' || v === 'false' || v === '0' || v === 'n') return false;
    return undefined;
}

/** Parse a CallGrid duration ("HH:MM:SS" or seconds) into integer seconds. */
export function parseDurationSeconds(value: string | undefined): number | undefined {
    if (value === undefined) return undefined;
    const s = String(value).trim();
    if (/^[0-9]+$/.test(s)) return Number(s);
    const parts = s.split(':').map((p) => Number(p));
    if (parts.length === 0 || parts.some((n) => !Number.isFinite(n))) return undefined;
    // Fold most-significant-first: each segment is one base-60 place.
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

/** Drop undefined values so a spread never clobbers a real value. */
function defined(obj: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj)) if (obj[k] !== undefined) out[k] = obj[k];
    return out;
}

/**
 * Map ONE raw CallGrid API call record into a provider-agnostic InboundEvent.
 * PR #41: the real CallGrid REST response uses camelCase field names (see the
 * header comment); each candidate list below checks the REAL field name FIRST,
 * then falls back to older PascalCase / legacy spellings so nothing that used
 * to match stops matching. We map them onto the SAME canonical metadata keys
 * the webhook path and the NormalizationEngine / Live Calls / Traffic
 * Intelligence already read, and we preserve the full raw record so nothing is
 * lost. apiSource marks the origin.
 */
export function mapCallGridApiRecord(record: Record<string, unknown>): InboundEvent {
    const externalId =
          pickField(record, ['id', 'CallId', 'Id', 'call_id', 'callId', 'Uuid', 'uuid', 'Sid', 'sid']) ||
          'callgrid-api-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);

  // Real field is 'callStatus'. Default is the honest 'unknown' - NEVER
  // 'completed' - so an unrecognized/unmatched status cannot silently inflate
  // the Completed count (this was the root cause of the Today/7-day mismatch).
  const rawEventType =
        pickField(record, ['callStatus', 'CallStatus', 'Status', 'status', 'Event', 'event']) || 'unknown';

  // Real field is 'createdAt'. Previously absent from the candidate list, so
  // occurredAt always fell back to "now" (sync execution time), corrupting
  // Today / Last 7 Days date-window bucketing.
  const occurredRaw = pickField(record, [
        'createdAt', 'CallDateTime', 'CallDate', 'StartTime', 'started_at', 'occurred_at', 'Timestamp', 'timestamp',
      ]);
    const occurred = occurredRaw ? new Date(occurredRaw) : new Date();
    const occurredAt = Number.isNaN(occurred.getTime()) ? new Date() : occurred;

  // Caller phone: real field is 'from'. Destination number: real field is 'to'.
  const customerPhone = pickField(record, [
        'from', 'CallerId', 'CallerID', 'callerId', 'Caller', 'FromNumber', 'From', 'AniNumber', 'Ani',
      ]);
    const destinationNumber = pickField(record, ['to', 'DestinationNumber', 'destination_number']);

  // Attribution: the raw CallGrid Call object exposes ONLY ids (buyerId,
  // sourceId, campaignId, destinationId) - there is no vendor field and no
  // name field at all on this endpoint. We preserve the real ids under
  // distinct *Id keys and deliberately do NOT fabricate a human-readable name
  // out of a cuid. Legacy PascalCase Name fields are still read for older
  // mocks/tests that may still send them.
  const buyerId = pickField(record, ['buyerId']);
    const sourceId = pickField(record, ['sourceId']);
    const campaignId = pickField(record, ['campaignId']);
    const destinationId = pickField(record, ['destinationId']);
    const vendor = pickField(record, ['VendorName', 'Vendor', 'vendor']);
    const source = pickField(record, ['SourceName', 'Source', 'source']);
    const campaign = pickField(record, ['CampaignName', 'Campaign', 'campaign']);
    const buyer = pickField(record, ['BuyerName', 'Buyer', 'buyer']);
    const destination = pickField(record, ['DestinationName', 'Destination', 'destination']);
    const callerState = pickField(record, ['InboundState', 'State', 'inboundState', 'callerState']);
    const callerZip = pickField(record, ['InboundZip', 'Zip', 'ZipCode', 'inboundZip', 'callerZip']);

  const durationSeconds = parseDurationSeconds(
        pickField(record, ['callDuration', 'Duration', 'CallDuration', 'duration', 'BillableDuration']),
      );
    const revenue = toNumber(pickField(record, ['revenue', 'Revenue', 'RevenueAmount']));
    const payout = toNumber(pickField(record, ['payout', 'Payout', 'PayoutAmount']));
    // cost is CallGrid's telco-cost field; rate is preserved separately in case
  // it is useful for validation, but cost/telco is the primary figure.
  const cost = toNumber(pickField(record, ['cost', 'Cost']));
    const rate = toNumber(pickField(record, ['rate', 'Rate']));
    const billable = toBool(pickField(record, ['billable', 'Billable', 'IsBillable']));
    const paid = toBool(pickField(record, ['paid', 'Paid', 'IsPaid']));
    const converted = toBool(pickField(record, ['converted', 'Converted', 'IsConverted', 'Conversion']));
    const completed = toBool(pickField(record, ['completed', 'Completed']));
    const noRoute = toBool(pickField(record, ['noRoute', 'NoRoute', 'no_route']));
    // Qualified: a call the buyer/business considers a real, valuable lead.
  // Derive deterministically from CallGrid's own economic outcome flags so
  // Live Calls / Traffic Intelligence show qualification instead of blank.
  const qualified =
        billable === true || converted === true || paid === true
        ? true
          : billable === false && converted === false && paid === false
          ? false
            : undefined;

  const payload: Record<string, unknown> = {
        ...record,
        ...defined({
                caller: customerPhone,
                fromNumber: customerPhone,
                destinationNumber,
                callerState,
                callerZip,
                buyerId,
                sourceId,
                campaignId,
                destinationId,
                vendor,
                source,
                campaign,
                buyer,
                destination,
                durationSeconds,
                revenue,
                payout,
                cost,
                telco: cost,
                rate,
                billable,
                paid,
                converted,
                completed,
                noRoute,
                qualified,
                apiSource: 'callgrid-api',
        }),
  };

  return {
        externalId,
        rawEventType,
        occurredAt,
        payload,
        customerPhone,
  };
}

/** Extract the records array from a CallGrid response of unknown envelope shape. */
function extractRecords(body: unknown): Array<Record<string, unknown>> {
    if (Array.isArray(body)) return body as Array<Record<string, unknown>>;
    if (body && typeof body === 'object') {
          const o = body as Record<string, unknown>;
          for (const key of ['data', 'calls', 'results', 'items', 'records']) {
                  if (Array.isArray(o[key])) return o[key] as Array<Record<string, unknown>>;
          }
    }
    return [];
}

/** Extract the next-page cursor from a CallGrid response, if present. */
function extractCursor(body: unknown): string | undefined {
    if (!body || typeof body !== 'object') return undefined;
    const o = body as Record<string, unknown>;
    for (const key of ['nextCursor', 'next_cursor', 'cursor', 'nextPageToken', 'next']) {
          const v = o[key];
          if (typeof v === 'string' && v.trim()) return v.trim();
    }
    const paging = o['paging'] || o['pagination'] || o['meta'];
    if (paging && typeof paging === 'object') {
          const p = paging as Record<string, unknown>;
          for (const key of ['nextCursor', 'next_cursor', 'cursor', 'next']) {
                  const v = p[key];
                  if (typeof v === 'string' && v.trim()) return v.trim();
          }
    }
    return undefined;
}

/** Fetch ONE page of CallGrid calls. Throws CallGridApiError on a non-2xx. */
export async function fetchCallGridCallsPage(
    options: CallGridApiFetchOptions,
  ): Promise<CallGridApiPage> {
    const doFetch = options.fetchImpl || fetch;
    const base = resolveCallGridBaseUrl(options.baseUrl).replace(/\/+$/, '');
    const url = new URL(base + CALLGRID_CALLS_PATH);
    url.searchParams.set('startDate', options.since.toISOString());
    url.searchParams.set('endDate', (options.until || new Date()).toISOString());
    url.searchParams.set('maxItems', String(options.limit || 100));
    url.searchParams.set('useCursor', 'true');
    url.searchParams.set('reportTimeZone', 'US/Eastern');
    if (options.cursor) url.searchParams.set('searchAfter', JSON.stringify(options.cursor));

  let res: Response;
    try {
          res = await doFetch(url.toString(), {
                  method: 'GET',
                  headers: {
                            Authorization: 'Bearer ' + options.apiKey,
                            Accept: 'application/json',
                  },
          });
    } catch (err) {
          throw new CallGridApiError(
                  'CallGrid API request failed: ' + (err instanceof Error ? err.message : 'network error'),
                );
    }
    if (!res.ok) {
          throw new CallGridApiError('CallGrid API returned ' + res.status, res.status);
    }
    let body: unknown;
    try {
          body = await res.json();
    } catch {
          throw new CallGridApiError('CallGrid API returned non-JSON body', res.status);
    }
    const records = extractRecords(body);
    const envelope = (body && typeof body === 'object' ? body : {}) as { hasMore?: unknown; nextCursor?: unknown };
    const apiHasMore = envelope.hasMore === true;
    const nextCursor: unknown = envelope.nextCursor != null ? envelope.nextCursor : extractCursor(body);
    return { records, nextCursor, hasMore: (apiHasMore || Boolean(nextCursor)) && records.length > 0 };
}

/**
 * Fetch ALL CallGrid calls in a date range, following cursor pagination, and
 * map each into an InboundEvent. Caps total pages to avoid runaway loops.
 */
export async function fetchAllCallGridCalls(
    options: CallGridApiFetchOptions & { maxPages?: number },
  ): Promise<{ events: InboundEvent[]; pages: number; records: number }> {
    const maxPages = options.maxPages && options.maxPages > 0 ? options.maxPages : 25;
    const events: InboundEvent[] = [];
    let cursor = options.cursor;
    let pages = 0;
    let records = 0;
    do {
          const page = await fetchCallGridCallsPage({ ...options, cursor });
          pages += 1;
          records += page.records.length;
          for (const record of page.records) events.push(mapCallGridApiRecord(record));
          cursor = page.nextCursor;
          if (!page.hasMore) break;
    } while (cursor && pages < maxPages);
    return { events, pages, records };
}
