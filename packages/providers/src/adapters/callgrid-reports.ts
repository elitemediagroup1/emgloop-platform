// CallGrid aggregate report contract — Phase 1 verification instrument.
//
// WHAT THIS IS, AND WHAT IT IS NOT
//
// This records the DOCUMENTED contract of CallGrid's four aggregate report
// endpoints, taken from the publicly readable OpenAPI document at
// https://api.callgrid.com/openapi (HTTP 200, no credential required), and
// provides a bounded read-only probe that verifies the documented contract
// against LIVE responses.
//
// Those are two different grades of evidence and this file never conflates
// them:
//
//   DOCUMENTED  the provider says this is the shape. Real evidence about the
//               contract. NOT evidence about the data, the units, the
//               denominators, or whether a field is ever null in practice.
//   OBSERVED    a live response proved it. Only `probeReportContract` produces
//               this, and only with a credential.
//
// No schema may be designed from DOCUMENTED alone. The provider documents
// `avgBid: number` with no unit; whether that is dollars or cents decides
// whether every marketplace figure in Loop is off by 100x. That question is
// answerable only from live values, and this project has already been burned
// once by inferring a money unit rather than anchoring it.
//
// SECURITY
//   • The credential is passed as a query parameter because that is the
//     transport the provider documents (securityScheme apiKey, in: query).
//     Query-string credentials leak into access logs and referrers; the key is
//     therefore never placed in a URL that is returned, logged, or thrown.
//     `redact()` scrubs it from every error path.
//   • Values are read ONLY from numeric aggregate fields and grouping identity.
//     EXCLUDED_FIELDS are never read at all, not even to measure their type,
//     because they are the fields most likely to carry caller data.
//   • Read-only. GET, plus the one POST the provider requires for /stats, which
//     is a read expressed as a POST — it creates nothing.

/** Grade of evidence behind a claim. Never widened without a live probe. */
export type EvidenceGrade = 'documented' | 'observed';

export interface ReportEndpointContract {
  id: string;
  method: 'GET' | 'POST';
  path: string;
  /** What the provider says this returns. */
  summary: string;
  /** The dimension rows are grouped by. NOT configurable — see groupingNote. */
  groupingType: string;
  groupingNote: string;
  /** Envelope key holding the row array. */
  rowsKey: string;
  /** Documented row fields. */
  rowFields: readonly string[];
  /** Documented footerTotals fields, or null when none is documented. */
  footerTotalsFields: readonly string[] | null;
  /** Other documented top-level envelope keys. */
  envelopeKeys: readonly string[];
}

/**
 * Fields that are never read, in any code path.
 *
 * `last5Bids` is an object of unknown shape on both bid endpoints. It is named
 * for individual bid events, which is exactly where caller identifiers would
 * live. We do not read it to classify it, because classifying requires touching
 * it. It is excluded at the boundary instead.
 */
export const EXCLUDED_FIELDS: readonly string[] = ['last5Bids'];

/**
 * The documented contract, transcribed from the public OpenAPI document.
 *
 * Transcription only — no inference. Where the provider documents a bare
 * `number` with no unit, this records a bare number.
 */
export const CALLGRID_REPORT_CONTRACTS: readonly ReportEndpointContract[] = [
  {
    id: 'bidStats',
    method: 'GET',
    path: '/api/reports/bidStats',
    summary: 'Get aggregated bid statistics by source',
    groupingType: 'source',
    groupingNote:
      'Grouping is fixed to source. The spec documents no grouping parameter, so buyer, campaign and vendor breakdowns are NOT available from this endpoint.',
    rowsKey: 'data',
    rowFields: [
      'sourceId', 'sourceName', 'bids', 'won', 'total', 'rated', 'rejected',
      'totalBidAmount', 'totalWonAmount', 'avgBid', 'avgWinningBid',
      'winRate', 'bidRate', 'rejectRate', 'last5Bids',
    ],
    footerTotalsFields: [
      'bids', 'won', 'total', 'rejected', 'rated', 'totalBidAmount',
      'totalWonAmount', 'avgBid', 'avgWinningBid', 'winRate', 'bidRate', 'rejectRate',
    ],
    envelopeKeys: ['data', 'totalPages', 'footerTotals'],
  },
  {
    id: 'bidRejections',
    method: 'GET',
    path: '/api/reports/bidStats/rejections',
    summary: 'Get bid rejection reasons by source',
    groupingType: 'source',
    groupingNote: 'Grouping is fixed to source. No grouping parameter is documented.',
    rowsKey: 'data',
    rowFields: [
      'sourceId', 'source', 'rejected', 'callerId', 'closed', 'paused',
      'duplicate', 'duplicateBids', 'failedAcceptance', 'failedTagRules', 'last5Bids',
    ],
    footerTotalsFields: [
      'rejected', 'callerId', 'closed', 'paused', 'duplicate', 'duplicateBids',
      'failedAcceptance', 'failedTagRules',
    ],
    envelopeKeys: ['data', 'totalPages', 'footerTotals'],
  },
  {
    id: 'pingStats',
    method: 'GET',
    path: '/api/reports/pingStats',
    summary: 'Get ping statistics by destination',
    groupingType: 'destination',
    groupingNote: 'Grouping is fixed to destination. No grouping parameter is documented.',
    rowsKey: 'data',
    rowFields: [
      'id', 'date', 'organizationId', 'destinationId', 'destinationName',
      'accepted', 'failedAcceptance', 'failedTagRules', 'minRevenue',
      'missingAmount', 'invalidNumber', 'durationElapsed', 'pingTimeout',
      'apiFailed', 'rateLimited', 'suppressed', 'agents',
    ],
    footerTotalsFields: [
      'accepted', 'failedAcceptance', 'failedTagRules', 'minRevenue',
      'missingAmount', 'invalidNumber', 'durationElapsed', 'pingTimeout',
      'apiFailed', 'rateLimited', 'suppressed',
    ],
    // pingStats uniquely documents `count` alongside totalPages.
    envelopeKeys: ['data', 'totalPages', 'count', 'footerTotals'],
  },
  {
    id: 'callStats',
    method: 'POST',
    path: '/api/reports/stats',
    summary: 'Get call statistics (summary report)',
    groupingType: 'pivot',
    groupingNote:
      'The ONLY endpoint with configurable grouping (pivot / pivot2 / pivots) and the ONLY one accepting reportTimeZone.',
    rowsKey: 'data',
    rowFields: [],
    footerTotalsFields: [],
    envelopeKeys: ['aggregations', 'footerTotals', 'totalPages', 'data'],
  },
];

/**
 * Fields the marketplace requirement asks for that the documented contract does
 * NOT expose. Recorded so a schema is never designed around a field that has no
 * source.
 *
 * This list is the single most important output of Phase 1 discovery: it is the
 * gap between what the operator sees in CallGrid's UI report and what the API
 * will actually give Loop.
 */
export const FIELDS_ABSENT_FROM_CONTRACT: ReadonlyArray<{
  requested: string;
  foundInSpec: boolean;
  note: string;
}> = [
  { requested: 'pings', foundInSpec: false, note: 'No `pings` field on any documented endpoint. pingStats reports `accepted` plus failure reasons, never a ping total. The funnel\'s top stage has no documented source.' },
  { requested: 'made', foundInSpec: false, note: 'Absent from the entire spec. The UI report\'s "Made" column has no documented API equivalent. `rated` is the only candidate and equivalence is UNPROVEN.' },
  { requested: 'duplicatePing', foundInSpec: false, note: 'Absent. bidStats/rejections documents `duplicate` and `duplicateBids`; neither is documented as a ping-level duplicate.' },
  { requested: 'responseTime', foundInSpec: false, note: 'Absent from the entire spec. The UI report\'s "Average Bid response: 521 ms" has no documented API source.' },
  { requested: 'tagRules', foundInSpec: false, note: 'Named `failedTagRules` on both the rejections and ping endpoints.' },
  { requested: 'capped', foundInSpec: true, note: 'Exists ONLY on the Destination and Buyer entities (a configured capacity limit), never as a report metric. Storing it as a bid-report field would misrepresent config as measurement.' },
  { requested: 'blocked', foundInSpec: true, note: 'Exists ONLY on the Call schema, never as a report metric.' },
  { requested: 'rateLimited', foundInSpec: true, note: 'Exists on pingStats (destination-grouped), NOT on either bid endpoint. It is a ping-stage metric, not a bid-stage one.' },
];

// --- Live probe --------------------------------------------------------------

export interface ReportProbeInput {
  baseUrl: string;
  apiKey: string;
  /** Inclusive ISO 8601 start, per the documented parameter semantics. */
  startDate: string;
  /** Inclusive ISO 8601 end. */
  endDate: string;
  page?: number;
  limit?: number;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** How a numeric field is represented, inferred from OBSERVED values only. */
export interface NumericRepresentation {
  field: string;
  /** Whole numbers only, across every observed row. */
  allIntegers: boolean;
  min: number;
  max: number;
  /** Decimal places seen. 2 suggests dollars; 0 suggests cents or a count. */
  maxDecimalPlaces: number;
}

export interface ReportProbeResult {
  endpointId: string;
  method: string;
  path: string;
  status: number | 'network-error' | 'timeout';
  /** Top-level envelope keys actually returned. */
  envelopeKeys: string[] | null;
  rowCount: number | null;
  /** Row keys actually returned. */
  rowKeys: string[] | null;
  /** Documented but missing from the live response. */
  documentedButAbsent: string[] | null;
  /** Returned but not documented. */
  undocumentedExtra: string[] | null;
  footerTotalsKeys: string[] | null;
  totalPages: number | null;
  /** Fields observed null at least once — the real nullability, not the doc's. */
  nullableObserved: string[] | null;
  /** Representation of every numeric field, for unit anchoring. */
  numerics: NumericRepresentation[] | null;
  note: string | null;
}

/** Remove the credential from anything that could be logged or returned. */
export function redact(text: string, apiKey: string): string {
  let out = text.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]');
  out = out.replace(/([?&]apiKey=)[^&\s]+/gi, '$1[redacted]');
  if (apiKey && apiKey.length >= 6) out = out.split(apiKey).join('[redacted]');
  return out;
}

function decimalPlaces(n: number): number {
  if (!Number.isFinite(n) || Number.isInteger(n)) return 0;
  const s = String(n);
  const i = s.indexOf('.');
  return i === -1 ? 0 : s.length - i - 1;
}

/**
 * Measure numeric representation across rows.
 *
 * EXCLUDED_FIELDS are skipped before any read, so a caller identifier cannot be
 * measured, summarised, or reach the output by any path.
 */
export function measureNumerics(rows: ReadonlyArray<Record<string, unknown>>): NumericRepresentation[] {
  const acc = new Map<string, { all: boolean; min: number; max: number; dp: number }>();
  for (const row of rows) {
    for (const [k, v] of Object.entries(row)) {
      if (EXCLUDED_FIELDS.includes(k)) continue;
      if (typeof v !== 'number' || !Number.isFinite(v)) continue;
      const cur = acc.get(k) ?? { all: true, min: v, max: v, dp: 0 };
      cur.all = cur.all && Number.isInteger(v);
      cur.min = Math.min(cur.min, v);
      cur.max = Math.max(cur.max, v);
      cur.dp = Math.max(cur.dp, decimalPlaces(v));
      acc.set(k, cur);
    }
  }
  return [...acc.entries()].map(([field, a]) => ({
    field,
    allIntegers: a.all,
    min: a.min,
    max: a.max,
    maxDecimalPlaces: a.dp,
  }));
}

/** Fields observed null/undefined at least once. Real nullability beats documented. */
export function observedNullable(rows: ReadonlyArray<Record<string, unknown>>): string[] {
  const nullable = new Set<string>();
  for (const row of rows) {
    for (const [k, v] of Object.entries(row)) {
      if (EXCLUDED_FIELDS.includes(k)) continue;
      if (v === null || v === undefined) nullable.add(k);
    }
  }
  return [...nullable].sort();
}

/**
 * An unreadable envelope is NEVER an empty report.
 *
 * Returning `[]` for a shape we failed to parse would let "we could not read
 * this" render as "there was no bid activity" — the exact unknown-as-zero
 * defect the platform Truth model exists to prevent.
 */
export function extractRows(body: unknown, rowsKey: string): { rows: Record<string, unknown>[] } | null {
  if (!body || typeof body !== 'object') return null;
  const rec = body as Record<string, unknown>;
  const raw = rec[rowsKey];
  if (!Array.isArray(raw)) return null;
  const rows = raw.filter((r): r is Record<string, unknown> => !!r && typeof r === 'object' && !Array.isArray(r));
  if (rows.length !== raw.length) return null;
  return { rows };
}

/**
 * Verify one endpoint's contract against a live response.
 *
 * Bounded: one window, one page, one timeout. Read-only.
 */
export async function probeReportContract(
  contract: ReportEndpointContract,
  input: ReportProbeInput,
): Promise<ReportProbeResult> {
  const doFetch = input.fetchImpl ?? fetch;
  const base = input.baseUrl.replace(/\/+$/, '');
  const url = new URL(base + contract.path);

  // Documented transport: securityScheme `apiKey`, in: query.
  url.searchParams.set('apiKey', input.apiKey);
  // organizationId is deliberately NOT sent. The provider resolves it from the
  // key. Letting a caller name its own organization is the multi-tenant defect
  // class this platform has already been bitten by.
  const isPost = contract.method === 'POST';
  if (!isPost) {
    url.searchParams.set('startDate', input.startDate);
    url.searchParams.set('endDate', input.endDate);
    url.searchParams.set('page', String(input.page ?? 0)); // documented zero-based
    url.searchParams.set('limit', String(input.limit ?? 25));
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 15_000);

  const fail = (status: ReportProbeResult['status'], note: string | null): ReportProbeResult => ({
    endpointId: contract.id,
    method: contract.method,
    path: contract.path,
    status,
    envelopeKeys: null, rowCount: null, rowKeys: null,
    documentedButAbsent: null, undocumentedExtra: null,
    footerTotalsKeys: null, totalPages: null,
    nullableObserved: null, numerics: null,
    note,
  });

  try {
    const res = await doFetch(url.toString(), {
      method: contract.method,
      headers: { Accept: 'application/json', ...(isPost ? { 'Content-Type': 'application/json' } : {}) },
      ...(isPost
        ? { body: JSON.stringify({ startDate: input.startDate, endDate: input.endDate, page: input.page ?? 0, maxItems: input.limit ?? 25 }) }
        : {}),
      signal: controller.signal,
    });

    if (!res.ok) return fail(res.status, null);

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return fail(res.status, 'response body was not JSON');
    }

    const rec = body as Record<string, unknown>;
    const envelopeKeys = Object.keys(rec).sort();
    const found = extractRows(body, contract.rowsKey);

    if (!found) {
      // Unknown envelope is REJECTED, never treated as empty.
      return {
        ...fail(res.status, `envelope did not contain a readable "${contract.rowsKey}" array — REJECTED, not treated as empty`),
        envelopeKeys,
      };
    }

    const rowKeys = found.rows.length > 0 ? Object.keys(found.rows[0]!).sort() : [];
    const documented = contract.rowFields;
    const footer = rec['footerTotals'];

    return {
      endpointId: contract.id,
      method: contract.method,
      path: contract.path,
      status: res.status,
      envelopeKeys,
      rowCount: found.rows.length,
      rowKeys,
      documentedButAbsent: documented.filter((f) => rowKeys.length > 0 && !rowKeys.includes(f)),
      undocumentedExtra: rowKeys.filter((f) => !documented.includes(f)),
      footerTotalsKeys: footer && typeof footer === 'object' ? Object.keys(footer as Record<string, unknown>).sort() : null,
      totalPages: typeof rec['totalPages'] === 'number' ? (rec['totalPages'] as number) : null,
      nullableObserved: observedNullable(found.rows),
      numerics: measureNumerics(found.rows),
      note: null,
    };
  } catch (error) {
    const msg = error instanceof Error ? redact(error.message, input.apiKey) : 'unknown';
    return fail(msg.toLowerCase().includes('abort') ? 'timeout' : 'network-error', msg);
  } finally {
    clearTimeout(timer);
  }
}
