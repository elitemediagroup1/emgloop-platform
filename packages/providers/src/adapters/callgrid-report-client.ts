// CallGrid aggregate report client — the OBSERVED contract, made fetchable.
//
// `callgrid-reports.ts` records what the provider DOCUMENTS and probes one page
// to see whether the document is true. This file is the next grade up: it reads
// the three endpoints that returned HTTP 200 with production data on
// 2026-07-18, parses them into typed rows, and paginates.
//
// WHAT IS VERIFIED HERE, AND WHAT IS NOT
//
//   VERIFIED  the transport (GET, apiKey in query, zero-based `page`, `limit`),
//             the envelope keys, the row keys, the footerTotals keys, and the
//             grouping grain of each of the three endpoints.
//   NOT       the money unit, the percentage denominator, and the timezone the
//             provider buckets in. Every one of those is a value question, and
//             values are anchored at ingestion time by `anchorMoneyUnit` and
//             recorded on the run record — never assumed here.
//
// POST /api/reports/stats returned HTTP 400 and is deliberately absent. It has a
// contract test only (`callStatsRequestBody`), no client, no schema.
//
// THREE GRAINS, NEVER MERGED
//   bidStats            grouped by SOURCE
//   bidStats/rejections grouped by SOURCE          (joinable to bidStats by sourceId)
//   pingStats           grouped by DESTINATION     (NOT joinable to either)
//
// Source and destination are different sides of the marketplace. Joining them —
// or matching either by name — would fabricate a relationship the provider never
// asserted. `sourceId` is the only join key, and only within one report window.

// Bare 'crypto', not 'node:crypto'. The providers barrel is reachable from a
// client component (crm/customers/bulk-bar.tsx → @emgloop/database → here), and
// webpack cannot resolve the `node:` scheme in that graph. Matches the
// convention in webhook-security.ts and auth.ts.
import { createHash } from 'crypto';

/** Endpoints that returned live production data. `callStats` is NOT one of them. */
export type VerifiedReportEndpoint = 'bidStats' | 'bidRejections' | 'pingStats';

export const VERIFIED_REPORT_PATHS: Readonly<Record<VerifiedReportEndpoint, string>> = {
  bidStats: '/api/reports/bidStats',
  bidRejections: '/api/reports/bidStats/rejections',
  pingStats: '/api/reports/pingStats',
};

/**
 * The grain each endpoint reports on.
 *
 * Kept as data rather than a comment because Phase 3's join rule depends on it:
 * two reports may be joined only when their grains are identical.
 */
export const REPORT_GRAIN: Readonly<Record<VerifiedReportEndpoint, 'source' | 'destination'>> = {
  bidStats: 'source',
  bidRejections: 'source',
  pingStats: 'destination',
};

/** Never read, never parsed, never stored. See EXCLUDED_FIELDS in callgrid-reports.ts. */
const DROPPED_ROW_FIELDS: readonly string[] = ['last5Bids'];

// --- Row types (observed) -----------------------------------------------------

/**
 * Every metric is `number | null`.
 *
 * Null means the provider did not report the field. Zero means the provider
 * reported zero. Collapsing the two is the fabrication defect this platform has
 * already shipped once; the parser below never coerces one into the other.
 */
export interface BidStatsRow {
  sourceExternalId: string;
  sourceName: string | null;
  total: number | null;
  bids: number | null;
  rated: number | null;
  won: number | null;
  rejected: number | null;
  totalBidAmount: number | null;
  totalWonAmount: number | null;
  avgBid: number | null;
  avgWinningBid: number | null;
  winRate: number | null;
  bidRate: number | null;
  rejectRate: number | null;
}

export interface BidRejectionsRow {
  sourceExternalId: string;
  sourceName: string | null;
  rejected: number | null;
  /** Provider field `callerId`. A COUNT of caller-id rejections, not an identifier. */
  callerIdRejected: number | null;
  closed: number | null;
  paused: number | null;
  /** Provider `duplicate`. Distinct from `duplicateBids` — kept separate deliberately. */
  duplicateCaller: number | null;
  duplicateBids: number | null;
  failedAcceptance: number | null;
  failedTagRules: number | null;
}

export interface PingStatsRow {
  destinationExternalId: string;
  destinationName: string | null;
  /**
   * The provider's own row date. Rows are bucketed per day, so a multi-day
   * window returns one row PER DESTINATION PER DAY. Ingestion is single-day for
   * exactly this reason; this field lets the ingester prove it.
   */
  rowDate: string | null;
  accepted: number | null;
  agents: number | null;
  failedAcceptance: number | null;
  failedTagRules: number | null;
  minRevenue: number | null;
  missingAmount: number | null;
  invalidNumber: number | null;
  durationElapsed: number | null;
  pingTimeout: number | null;
  apiFailed: number | null;
  rateLimited: number | null;
  suppressed: number | null;
}

export type ReportRow = BidStatsRow | BidRejectionsRow | PingStatsRow;

/** Provider footer totals, kept as a raw bag — never merged with recomputed totals. */
export type FooterTotals = Readonly<Record<string, number | null>>;

export interface ReportPage<TRow> {
  rows: TRow[];
  /** Provider-reported totals for the WHOLE report, not this page. */
  footerTotals: FooterTotals | null;
  totalPages: number | null;
  /** pingStats only. */
  count: number | null;
  /** Row keys actually present, for drift detection against the observed contract. */
  observedRowKeys: string[];
  /** SHA-256 over the canonicalised page body, minus dropped fields. */
  payloadHash: string;
}

/** A failure that is NOT an empty report. Every one of these must reach the run record. */
export class CallGridReportError extends Error {
  readonly classification:
    | 'endpoint-failure'
    | 'malformed-response'
    | 'unknown-envelope'
    | 'partial-pagination';
  readonly status: number | null;

  constructor(
    classification: CallGridReportError['classification'],
    message: string,
    status: number | null = null,
  ) {
    super(message);
    this.name = 'CallGridReportError';
    this.classification = classification;
    this.status = status;
  }
}

// --- Parsing ------------------------------------------------------------------

/**
 * Read a numeric metric.
 *
 * Absent / null / non-numeric → null. A numeric string is accepted and coerced,
 * because the provider documents `number` and a string would be drift we want to
 * survive rather than a reason to reject a whole report. `NaN` is null, never 0.
 */
export function metric(row: Record<string, unknown>, key: string): number | null {
  const v = row[key];
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function requiredId(row: Record<string, unknown>, key: string): string | null {
  const v = row[key];
  if (typeof v === 'string' && v.trim() !== '') return v.trim();
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

function optionalName(row: Record<string, unknown>, key: string): string | null {
  const v = row[key];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

/**
 * `bidStats/rejections` nests identity as `source: { id, name }` while `bidStats`
 * uses flat `sourceName`. Observed, and confirmed against the documented schema.
 * Both are read here so the two source-grain reports produce the same shape.
 */
function rejectionSourceName(row: Record<string, unknown>): string | null {
  const src = row['source'];
  if (src && typeof src === 'object' && !Array.isArray(src)) {
    return optionalName(src as Record<string, unknown>, 'name');
  }
  return optionalName(row, 'source');
}

export function parseBidStatsRow(row: Record<string, unknown>): BidStatsRow | null {
  const id = requiredId(row, 'sourceId');
  if (id === null) return null;
  return {
    sourceExternalId: id,
    sourceName: optionalName(row, 'sourceName'),
    total: metric(row, 'total'),
    bids: metric(row, 'bids'),
    rated: metric(row, 'rated'),
    won: metric(row, 'won'),
    rejected: metric(row, 'rejected'),
    totalBidAmount: metric(row, 'totalBidAmount'),
    totalWonAmount: metric(row, 'totalWonAmount'),
    avgBid: metric(row, 'avgBid'),
    avgWinningBid: metric(row, 'avgWinningBid'),
    winRate: metric(row, 'winRate'),
    bidRate: metric(row, 'bidRate'),
    rejectRate: metric(row, 'rejectRate'),
  };
}

export function parseBidRejectionsRow(row: Record<string, unknown>): BidRejectionsRow | null {
  const id = requiredId(row, 'sourceId');
  if (id === null) return null;
  return {
    sourceExternalId: id,
    sourceName: rejectionSourceName(row),
    rejected: metric(row, 'rejected'),
    callerIdRejected: metric(row, 'callerId'),
    closed: metric(row, 'closed'),
    paused: metric(row, 'paused'),
    duplicateCaller: metric(row, 'duplicate'),
    duplicateBids: metric(row, 'duplicateBids'),
    failedAcceptance: metric(row, 'failedAcceptance'),
    failedTagRules: metric(row, 'failedTagRules'),
  };
}

export function parsePingStatsRow(row: Record<string, unknown>): PingStatsRow | null {
  const id = requiredId(row, 'destinationId');
  if (id === null) return null;
  const date = row['date'];
  return {
    destinationExternalId: id,
    destinationName: optionalName(row, 'destinationName'),
    rowDate: typeof date === 'string' && date.trim() !== '' ? date : null,
    accepted: metric(row, 'accepted'),
    agents: metric(row, 'agents'),
    failedAcceptance: metric(row, 'failedAcceptance'),
    failedTagRules: metric(row, 'failedTagRules'),
    minRevenue: metric(row, 'minRevenue'),
    missingAmount: metric(row, 'missingAmount'),
    invalidNumber: metric(row, 'invalidNumber'),
    durationElapsed: metric(row, 'durationElapsed'),
    pingTimeout: metric(row, 'pingTimeout'),
    apiFailed: metric(row, 'apiFailed'),
    rateLimited: metric(row, 'rateLimited'),
    suppressed: metric(row, 'suppressed'),
  };
}

/**
 * `organizationId` on a pingStats row is CALLGRID's organization id, not Loop's.
 *
 * It is read only to prove the provider returned one organization's data, and is
 * never stored in a Loop `organizationId` column. Conflating the two would let a
 * provider-side identifier silently become a tenant boundary.
 */
export function distinctProviderOrgIds(rows: ReadonlyArray<Record<string, unknown>>): string[] {
  const out = new Set<string>();
  for (const r of rows) {
    const v = r['organizationId'];
    if (typeof v === 'string' && v.trim() !== '') out.add(v.trim());
  }
  return [...out].sort();
}

// --- Hashing ------------------------------------------------------------------

/** Stable stringify: key-sorted, dropped fields removed, so the hash is reproducible. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort()) {
      if (DROPPED_ROW_FIELDS.includes(k)) continue;
      out[k] = canonical(src[k]);
    }
    return out;
  }
  return value;
}

export function hashPayload(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

// --- Fetch --------------------------------------------------------------------

export interface ReportFetchInput {
  baseUrl: string;
  apiKey: string;
  /** Inclusive ISO 8601 instant. */
  startDate: string;
  /** Inclusive ISO 8601 instant. */
  endDate: string;
  page?: number;
  limit?: number;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

function readFooter(body: Record<string, unknown>): FooterTotals | null {
  const raw = body['footerTotals'];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out: Record<string, number | null> = {};
  for (const k of Object.keys(raw as Record<string, unknown>)) {
    if (DROPPED_ROW_FIELDS.includes(k)) continue;
    // A footer field that is not numeric becomes null, not 0 — the footer is a
    // provider claim and an unreadable claim is unknown, not zero.
    out[k] = metric(raw as Record<string, unknown>, k);
  }
  return out;
}

/**
 * Fetch one page. Throws `CallGridReportError` on anything that is not a
 * readable report — an unreadable envelope is never an empty report.
 */
export async function fetchReportPage(
  endpoint: VerifiedReportEndpoint,
  input: ReportFetchInput,
): Promise<ReportPage<Record<string, unknown>>> {
  const doFetch = input.fetchImpl ?? fetch;
  const url = new URL(input.baseUrl.replace(/\/+$/, '') + VERIFIED_REPORT_PATHS[endpoint]);

  // Verified transport: apiKey in query. organizationId is deliberately not sent
  // — the provider resolves it from the credential, and letting a caller name
  // its own organization is the tenancy defect class this repo has been bitten by.
  url.searchParams.set('apiKey', input.apiKey);
  url.searchParams.set('startDate', input.startDate);
  url.searchParams.set('endDate', input.endDate);
  url.searchParams.set('page', String(input.page ?? 0)); // verified zero-based
  url.searchParams.set('limit', String(input.limit ?? 100));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 20_000);

  let res: Response;
  try {
    res = await doFetch(url.toString(), {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
  } catch (error) {
    const raw = error instanceof Error ? error.message : 'unknown';
    throw new CallGridReportError('endpoint-failure', scrub(raw, input.apiKey));
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw new CallGridReportError('endpoint-failure', `HTTP ${res.status}`, res.status);
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new CallGridReportError('malformed-response', 'response body was not JSON', res.status);
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new CallGridReportError('unknown-envelope', 'response body was not an object', res.status);
  }

  const rec = body as Record<string, unknown>;
  const raw = rec['data'];
  if (!Array.isArray(raw)) {
    throw new CallGridReportError(
      'unknown-envelope',
      `envelope has no readable "data" array (keys: ${Object.keys(rec).sort().join(',')}) — REJECTED, not treated as empty`,
      res.status,
    );
  }

  const rows: Record<string, unknown>[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new CallGridReportError(
        'unknown-envelope',
        'a row in "data" was not an object — REJECTED, not treated as empty',
        res.status,
      );
    }
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(item as Record<string, unknown>)) {
      if (DROPPED_ROW_FIELDS.includes(k)) continue; // dropped at the boundary
      clean[k] = v;
    }
    rows.push(clean);
  }

  const observedRowKeys = rows.length > 0 ? Object.keys(rows[0]!).sort() : [];

  return {
    rows,
    footerTotals: readFooter(rec),
    totalPages: typeof rec['totalPages'] === 'number' ? rec['totalPages'] : null,
    count: typeof rec['count'] === 'number' ? rec['count'] : null,
    observedRowKeys,
    payloadHash: hashPayload({ data: rows, footerTotals: rec['footerTotals'] ?? null }),
  };
}

/** Remove the credential from any string that could be logged, thrown, or returned. */
export function scrub(text: string, apiKey: string): string {
  let out = text.replace(/([?&]apiKey=)[^&\s]+/gi, '$1[redacted]');
  if (apiKey && apiKey.length >= 6) out = out.split(apiKey).join('[redacted]');
  return out;
}

export interface PaginatedReport<TRow> {
  rows: TRow[];
  /** Footer from the FIRST page. Provider-reported, whole-report scope. */
  footerTotals: FooterTotals | null;
  pagesFetched: number;
  totalPages: number | null;
  count: number | null;
  observedRowKeys: string[];
  /** Hash over every page, in order. */
  payloadHash: string;
  /** True when `totalPages` exceeded the page cap — the report is INCOMPLETE. */
  truncated: boolean;
}

export interface PaginateInput extends Omit<ReportFetchInput, 'page'> {
  /** Hard ceiling. Exceeding it yields `truncated: true`, never a silent short read. */
  maxPages?: number;
}

/**
 * Walk every page the provider declares, up to `maxPages`.
 *
 * Two properties matter more than throughput:
 *   • `totalPages` is honoured, not guessed from an empty page.
 *   • Running out of page budget sets `truncated`. A truncated report must never
 *     be reconciled or aggregated as if it were complete.
 */
export async function fetchWholeReport(
  endpoint: VerifiedReportEndpoint,
  input: PaginateInput,
): Promise<PaginatedReport<Record<string, unknown>>> {
  const maxPages = Math.max(1, Math.min(input.maxPages ?? 20, 100));
  const rows: Record<string, unknown>[] = [];
  const hashes: string[] = [];
  let footerTotals: FooterTotals | null = null;
  let totalPages: number | null = null;
  let count: number | null = null;
  let observedRowKeys: string[] = [];
  let pagesFetched = 0;

  for (let page = 0; page < maxPages; page += 1) {
    const res = await fetchReportPage(endpoint, { ...input, page });
    pagesFetched += 1;
    hashes.push(res.payloadHash);
    rows.push(...res.rows);
    if (page === 0) {
      footerTotals = res.footerTotals;
      totalPages = res.totalPages;
      count = res.count;
    }
    if (res.observedRowKeys.length > 0 && observedRowKeys.length === 0) {
      observedRowKeys = res.observedRowKeys;
    }
    // Honour the provider's own page count. Falling back to "stop on an empty
    // page" only when it is absent, because a provider that omits totalPages has
    // told us nothing about how many pages exist.
    if (totalPages !== null) {
      if (page + 1 >= totalPages) return done(false);
    } else if (res.rows.length === 0) {
      return done(false);
    }
  }

  // Falling out of the loop means the budget ran out with no terminating
  // condition met. When `totalPages` is known that is a plain overrun. When it
  // is absent, every page fetched was non-empty and the provider told us nothing
  // about how many remain — so the report is equally incomplete, and saying
  // otherwise would be the silent short read this function exists to prevent.
  return done(totalPages === null || totalPages > maxPages);

  function done(truncated: boolean): PaginatedReport<Record<string, unknown>> {
    return {
      rows,
      footerTotals,
      pagesFetched,
      totalPages,
      count,
      observedRowKeys,
      payloadHash: hashPayload(hashes),
      truncated,
    };
  }
}

// --- POST /api/reports/stats — UNVERIFIED, contract only ----------------------
//
// This endpoint returned HTTP 400 on the live discovery run. It has no client,
// no snapshot model, and no place in the funnel, and it must not acquire one
// until a 200 is observed.
//
// What IS known comes from the OpenAPI document, and explains the 400: unlike
// the three GET reports, this endpoint takes NO query parameters at all. Every
// input travels in a JSON body, and a request that put startDate/endDate on the
// query string — as the GET reports require — would arrive with an empty body.
//
// The spec declares no `required` array on the request body, so the 400 is the
// server asserting a requirement the document does not state. `pivot` is the
// likeliest candidate: it is the grouping dimension, and a summary report with
// no grouping has nothing to group by.

/** The documented request body. Transcribed, not inferred. */
export const CALL_STATS_CONTRACT = {
  method: 'POST' as const,
  path: '/api/reports/stats',
  /** apiKey in query; every other input is body-only. */
  credentialLocation: 'query' as const,
  bodyFields: [
    'startDate', 'endDate', 'pivot', 'pivot2', 'pivots', 'filters',
    'permission', 'page', 'maxItems', 'sortColumn', 'sortDirection', 'reportTimeZone',
  ] as const,
  /**
   * The spec declares none. The live 400 proves at least one exists, so this
   * records a HYPOTHESIS to test, never a fact to build on.
   */
  documentedRequiredFields: [] as const,
  suspectedRequiredFields: ['startDate', 'endDate', 'pivot'] as const,
  envelopeKeys: ['aggregations', 'footerTotals', 'totalPages', 'data'] as const,
  /**
   * The ONLY report endpoint that accepts a bucketing timezone. The three GET
   * reports do not, which is why their bucketing timezone is unverified — and
   * why a call-vs-report comparison cannot be settled from this API alone today.
   */
  acceptsReportTimeZone: true,
  status: 'UNVERIFIED — HTTP 400 on the live run; no 200 has been observed' as const,
} as const;

/**
 * Build a candidate request body for a future verification attempt.
 *
 * Exported so the shape is written down once and reviewable, NOT so it can be
 * called from an ingestion path. There is no client for this endpoint on
 * purpose: a 400 is not a contract.
 */
export function callStatsRequestBody(input: {
  startDate: string;
  endDate: string;
  pivot: string;
  page?: number;
  maxItems?: number;
  reportTimeZone?: string;
}): Record<string, unknown> {
  return {
    startDate: input.startDate,
    endDate: input.endDate,
    pivot: input.pivot,
    page: input.page ?? 0,
    maxItems: input.maxItems ?? 100,
    ...(input.reportTimeZone ? { reportTimeZone: input.reportTimeZone } : {}),
  };
}
