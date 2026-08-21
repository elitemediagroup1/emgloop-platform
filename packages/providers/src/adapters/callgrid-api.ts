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
import { resolveCallOccurrence } from './callgrid-occurrence';
import { NO_IDENTITY_MESSAGE, resolveCallGridIdentity } from './callgrid-identity';

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
    /** The provider's own count for the filter, when the envelope carries one.
        ADVISORY: it is reported so a discrepancy is visible, and it never
        certifies completeness on its own. */
  totalCount?: number;
}

/** Resolve the API base URL (option > env > documented default). */
export function resolveCallGridBaseUrl(override?: string): string {
    return (
          override ||
          (typeof process !== 'undefined' && process.env && process.env.CALLGRID_API_BASE_URL) ||
          CALLGRID_API_DEFAULT_BASE_URL
        );
}

/**
 * WHY a CallGrid request failed, as a machine-readable kind.
 *
 * Callers used to classify failures by matching on the message text, which meant
 * a reworded sentence silently changed how an outcome was recorded. The
 * observation ledger records a status per failure kind, so that classification
 * has to be stated by the thrower rather than inferred by the reader.
 */
export type CallGridApiErrorKind =
  /** Network-level failure; no HTTP response at all. */
  | 'request-failed'
  /** A response arrived with a non-2xx status. */
  | 'http-status'
  /** 2xx whose body would not parse as JSON. */
  | 'non-json'
  /** 2xx JSON whose shape we do not recognise. NEVER an empty page. */
  | 'unrecognised-envelope'
  /** A record carried no usable occurrence timestamp. */
  | 'no-occurrence'
  /** A record carried no usable provider call id. */
  | 'no-identity';

/** A small typed error so callers can surface API failures as diagnostics. */
export class CallGridApiError extends Error {
    constructor(
          message: string,
          readonly status?: number,
          readonly kind: CallGridApiErrorKind = 'request-failed',
          /** The provider's Retry-After header, verbatim, when it sent one.
              Carried rather than parsed here: how long to wait is the caller's
              policy, and this class does not have one. */
          readonly retryAfter?: string | null,
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
    // CANONICAL IDENTITY, OR NOTHING. Shared with the webhook parser, and
    // refused the same way an unusable occurrence is refused below. The
    // fallback this replaces was the worse of the two in the codebase: it mixed
    // Date.now() with Math.random(), so re-reading one malformed record minted a
    // brand-new canonical call on every poll -- and re-reading is exactly what a
    // poller does.
    const externalId = resolveCallGridIdentity(record);
    if (externalId === null) {
          throw new CallGridApiError(NO_IDENTITY_MESSAGE, undefined, 'no-identity');
    }

  // Real field is 'callStatus'. Default is the honest 'unknown' - NEVER
  // 'completed' - so an unrecognized/unmatched status cannot silently inflate
  // the Completed count (this was the root cause of the Today/7-day mismatch).
  const rawEventType =
        pickField(record, ['callStatus', 'CallStatus', 'Status', 'status', 'Event', 'event']) || 'unknown';

  // Real field is 'createdAt'. Previously absent from the candidate list, so
  // occurredAt always fell back to "now" (sync execution time), corrupting
  // Today / Last 7 Days date-window bucketing.
  // Canonical precedence — see callgrid-occurrence.ts. `createdAt` was FIRST in
  // the old alias list, which is record-creation time and ran ~16s after the
  // event on a real record.
  const occurrence = resolveCallOccurrence(record);
  if (!occurrence.at) {
        throw new CallGridApiError(
                'CallGrid record carries no usable occurrence timestamp ' +
                '(UTCUnixTimeMs / UTCISODate / UTCUnixTime all absent or invalid)',
                undefined,
                'no-occurrence',
              );
  }
  const occurredAt = occurrence.at;

  // Caller phone: real field is 'from'. Destination number: real field is 'to'.
  const customerPhone = pickField(record, [
        'from', 'CallerId', 'CallerID', 'callerId', 'Caller', 'FromNumber', 'From', 'AniNumber', 'Ani',
      ]);
    const destinationNumber = pickField(record, ['to', 'DestinationNumber', 'destination_number']);

  // Attribution. The raw Call object carries the ids (buyerId, sourceId,
  // campaignId, destinationId) AND the PascalCase display names -- VendorName,
  // BuyerName, CampaignName, SourceName and DestinationName were all VERIFIED
  // on the list endpoint (19 records, 2026-08-20).
  //
  // CORRECTED 2026-08-20. This comment previously asserted the endpoint exposes
  // "ONLY ids ... no vendor field and no name field at all", and dismissed the
  // PascalCase readers as legacy compatibility for old mocks. That was wrong,
  // and it is the reason the economics below were looked for under the wrong
  // spellings: the record is a MIX of camelCase ids and PascalCase Call-prefixed
  // attributes, not camelCase throughout.
  //
  // Identity is still the id. A name is display only and is never fabricated
  // from a cuid.
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
    // `InboundZipCode` is DEFENSIVE -- not observed on the compact list endpoint,
  // which carries no geography at all. Kept because the single-call detail
  // contract has not been inspected and an absent alias drops a fact silently.
  const callerZip = pickField(record, [
        'InboundZipCode', 'InboundZip', 'Zip', 'ZipCode', 'inboundZip', 'callerZip',
      ]);

  // 'BillableDuration' removed — see the note in callgrid.provider.ts. Billable
  // duration is a distinct business quantity and must not populate total duration.
  const durationSeconds = parseDurationSeconds(
        pickField(record, ['callDuration', 'Duration', 'CallDuration', 'duration']),
      );
    // ECONOMICS AND OUTCOME FLAGS.
  //
  // TWO TIERS, AND THE DIFFERENCE IS EVIDENCE. A `get-calls` sample of 19 call
  // objects across 6 campaigns and 3 statuses (2026-08-20) established the
  // list-endpoint response key union exactly. Everything below is labelled by
  // what that sample actually showed, because "we read the wrong spelling" is
  // the defect this block exists to fix and guessing again would repeat it.
  //
  //   VERIFIED on the list endpoint : CallRevenue, CallPayout, CallProfit,
  //                                   converted (lowercase), callStatus,
  //                                   callDuration, CallerId, DestinationNumber,
  //                                   DestinationName, CampaignName, SourceName,
  //                                   BuyerName, VendorName, Duplicate, outcome
  //   NOT OBSERVED there           : CallCost, CallBillable, CallPaid,
  //                                   CallCompleted, CallNoRoute, InboundZipCode
  //
  // NOT OBSERVED IS NOT DISPROVED. `get-calls` returns COMPACT SUMMARY records,
  // so a field missing from it may still exist on the single-call detail
  // contract or on the webhook template. Those aliases are therefore kept as
  // DEFENSIVE, not asserted as provider contract. An alias for a field the
  // provider never sends costs nothing -- pickField moves on -- while a missing
  // one silently drops a fact, which is precisely how this block came to read
  // none of the economics at all.
  //
  // Note also that FILTERABILITY IS NOT PRESENCE: `CallBillable` is accepted as
  // a get-calls filter tagName and filters correctly, and is still not emitted
  // as a response key. A filter name is not a mapping contract.
  //
  // Verified name first, then legacy and defensive spellings, matching the
  // convention the callStatus / from / to fields above already follow.
  const revenue = toNumber(pickField(record, ['CallRevenue', 'revenue', 'Revenue', 'RevenueAmount']));
    const payout = toNumber(pickField(record, ['CallPayout', 'payout', 'Payout', 'PayoutAmount']));
    // cost is CallGrid's telco-cost field; rate is preserved separately in case
  // it is useful for validation, but cost/telco is the primary figure.
  // `CallCost` is DEFENSIVE -- not observed on the list endpoint.
  const cost = toNumber(pickField(record, ['CallCost', 'cost', 'Cost']));
    const rate = toNumber(pickField(record, ['rate', 'Rate']));
    const billable = toBool(pickField(record, ['CallBillable', 'billable', 'Billable', 'IsBillable']));
    const paid = toBool(pickField(record, ['CallPaid', 'paid', 'Paid', 'IsPaid']));
    // CONVERSION IS TRI-STATE ON THIS PATH, AND ZERO IS NOT A NEGATIVE.
  //
  // The field is `converted`, lowercase -- VERIFIED, present on every sampled
  // record, as an INTEGER. There is no `CallConverted` here: the sample looked
  // for it and six other spellings and found none.
  //
  // What is NOT established is that 0 means "did not convert". Every sampled
  // value was 0, no 1 was ever observed, `outcome` was null on every record, the
  // webhook template's [[tag:CallConverted]] resolved to "" across the captured
  // Aug 10-14 payloads, and CallGrid's own campaign logs say for many campaigns:
  // "BillableType is POSTBACK. Revenue and billable will be set when the
  // postback is received." Conversion is therefore a LATER, out-of-band fact,
  // and 0 at list-read time reads as the unset default rather than a decision.
  //
  // WHY THE DIFFERENCE IS NOT ACADEMIC. `convertedReported` counts rows where
  // the column is NOT NULL, and CONVERSION_RATE is "calls flagged converted,
  // divided by calls that carried the flag at all". A stored `false` therefore
  // ENTERS the denominator as a negative; a null is excluded. Mapping 0 to false
  // would make a population of not-yet-postbacked calls compute 0% at FULL
  // coverage -- which is the exact business falsehood the 2026-08-05 population
  // demonstrated, where all 974 records carried converted=false.
  //
  // AND IT WOULD BE PERMANENT. `IngestionService` short-circuits an event that
  // already reached PROCESSED, so a later poll cannot replace a stored false
  // with a true. A premature negative is not a value that gets corrected; it is
  // a value nothing can correct.
  //
  // So: a positive asserts a conversion, anything else stays UNKNOWN. Note that
  // "1 means true" is the safe DEFAULT rather than an observed fact -- no
  // converted=1 record has been seen -- but it errs toward silence, and this
  // also makes the two ingress paths converge: the webhook's blank tag already
  // resolves to unknown.
  const convertedRaw = pickField(record, ['converted', 'Converted', 'IsConverted', 'Conversion']);
    // EXPLICIT NULL, NOT AN OMISSION. The payload spreads the raw record first,
  // and the provider's key is `converted` too -- so simply leaving the canonical
  // value out would let the raw literal stand in its place. A raw 0 happens to
  // read as null downstream, but a raw "false" would read as a decided negative,
  // and a rule that only works for the value we happened to sample is not a rule.
  // The provider's literal is kept beside it, so nothing is lost.
  const converted = toBool(convertedRaw) === true ? true : null;
    // DEFENSIVE. Neither field was observed on the list endpoint. `callStatus`
    // DOES carry the values COMPLETED and NO_ROUTE, so these facts look
    // derivable from it -- deliberately NOT done here. On the webhook path
    // `completed` and `noRoute` are PROVIDER-ASSERTED booleans read straight off
    // the payload; deriving them from a status string on this path only would
    // make one canonical fact mean two different things depending on how the
    // call arrived. That is a contract decision, not a spelling fix.
  const completed = toBool(pickField(record, ['CallCompleted', 'completed', 'Completed']));
    const noRoute = toBool(pickField(record, ['CallNoRoute', 'noRoute', 'NoRoute', 'no_route']));
    // `outcome` is VERIFIED PRESENT and null in every sampled record, and is
    // deliberately NOT mapped to anything. Its populated representation has
    // never been observed, and the get-calls request accepting
    // converted/not-converted as an outcomes FILTER says nothing about what the
    // response field contains. It survives raw in the payload spread below.
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
                providerConverted: convertedRaw,
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
/** Envelope shapes CallGrid may legitimately return, in precedence order. */
const RECORD_ENVELOPE_KEYS = ['data', 'calls', 'results', 'items', 'records'] as const;

/**
 * Locate the records array inside a CallGrid response.
 *
 * Returns null when the envelope is UNRECOGNISED, which is deliberately
 * different from an empty page. The previous version returned `[]` for both, so
 * a response shape we do not understand was indistinguishable from a day with
 * no calls — it would have reported "0 calls, reconciled clean" against a
 * marketplace that had traffic. A shape we cannot parse is an error, not a zero.
 */
export function extractRecordsOrNull(
  body: unknown,
): { records: Array<Record<string, unknown>>; envelope: string } | null {
    if (Array.isArray(body)) {
          return { records: body as Array<Record<string, unknown>>, envelope: 'array' };
    }
    if (body && typeof body === 'object') {
          const o = body as Record<string, unknown>;
          for (const key of RECORD_ENVELOPE_KEYS) {
                  if (Array.isArray(o[key])) {
                            return { records: o[key] as Array<Record<string, unknown>>, envelope: key };
                  }
          }
    }
    return null;
}

/**
 * Describe a response shape for an error message: top-level KEYS ONLY.
 *
 * Never includes values, so a diagnostic cannot leak a phone number, a
 * recording URL, or a credential echoed back by the provider.
 */
export function describeShape(body: unknown): string {
    if (Array.isArray(body)) return 'array';
    if (body === null) return 'null';
    if (typeof body !== 'object') return typeof body;
    const keys = Object.keys(body as Record<string, unknown>).slice(0, 20);
    return `object{${keys.join(',')}}`;
}

function extractRecords(body: unknown): Array<Record<string, unknown>> {
    return extractRecordsOrNull(body)?.records ?? [];
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
                  undefined,
                  'request-failed',
                );
    }
    if (!res.ok) {
          // Retry-After is read for EVERY non-2xx, not only 429: a provider may
          // advise a wait on a 503 too, and discarding it here would force the
          // caller to guess.
          throw new CallGridApiError(
                  'CallGrid API returned ' + res.status,
                  res.status,
                  'http-status',
                  res.headers?.get?.('retry-after') ?? null,
                );
    }
    let body: unknown;
    try {
          body = await res.json();
    } catch {
          throw new CallGridApiError('CallGrid API returned non-JSON body', res.status, 'non-json');
    }
    const parsed = extractRecordsOrNull(body);
    if (!parsed) {
          // Keys only — never values. An unparseable envelope must fail loudly
          // rather than masquerade as a day with no calls.
          throw new CallGridApiError(
                  'CallGrid API returned an unrecognised response shape: ' + describeShape(body),
                  res.status,
                  'unrecognised-envelope',
                );
    }
    const records = parsed.records;
    const envelope = (body && typeof body === 'object' ? body : {}) as {
          hasMore?: unknown;
          nextCursor?: unknown;
          totalCount?: unknown;
    };
    const apiHasMore = envelope.hasMore === true;
    const nextCursor: unknown = envelope.nextCursor != null ? envelope.nextCursor : extractCursor(body);
    // ADVISORY ONLY, AND SURFACED RATHER THAN TRUSTED. A provider total is worth
  // reporting beside a fetched count so a discrepancy is visible, but it cannot
  // certify completeness on its own: it is computed by the provider over its own
  // view of the filter, and nothing here has verified it means the same
  // population this reader asked for.
  const totalCount =
          typeof envelope.totalCount === 'number' && Number.isFinite(envelope.totalCount)
                ? envelope.totalCount
                : undefined;
    return {
          records,
          nextCursor,
          hasMore: (apiHasMore || Boolean(nextCursor)) && records.length > 0,
          ...(totalCount === undefined ? {} : { totalCount }),
    };
}

// THE MULTI-PAGE LOOP LIVES IN `callgrid-interval.ts`, AND ONLY THERE.
//
// `fetchAllCallGridCalls` used to own a second one. It was the loop that learned,
// the hard way, that a page budget reached and a provider exhausted are different
// endings -- a 6,918-call window once came back as a clean 2,500 because they
// were not. `readCallGridInterval` carries that lesson and four more it could not
// express: a repeated cursor, more-pages-with-no-cursor, a throttled page and an
// oversized request are each a named outcome rather than an exception or a
// boolean.
//
// Two loops over one page primitive was an intentional temporary state while the
// callers moved. It is not one any more: `poll()` is the only multi-page caller
// and it delegates. What stays here is the page request, the envelope parse and
// the cursor extraction -- shared by construction, and asserted to be the only
// copies by test.

