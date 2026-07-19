import { NextResponse } from 'next/server';
import { requireCrmContext } from '../../../../../crm/crm-data';
import { can } from '../../../../../auth/auth';
import { resolveCallGridBaseUrl, describeShape } from '@emgloop/providers';

// CallGrid bid/auction report DISCOVERY — read-only, admin-only.
//
// WHY THIS EXISTS
//
// Sprint 38 Phase 1 requires verifying how CallGrid exposes bid data BEFORE any
// schema is designed. That verification cannot be done from the repository, and
// the evidence says the obvious shortcut would be wrong:
//
//   • The only path the client knows is /api/call. There is NO client, NO route
//     and NO fetch for any report endpoint anywhere in the codebase.
//   • `CallGridBidStatsRow` exists, but only as a contract stub in
//     @emgloop/marketplace-intelligence — a package with zero importers that
//     does not typecheck. It was classified [REPO], unconfirmed, in Sprint 32.
//   • That stub is demonstrably NOT the shape of the observed report. The
//     report's core funnel is Pings -> Bids -> Made -> Won; the stub has no
//     `pings` and no `made` at all, and no capped / rateLimited / duplicatePing
//     / response-time fields.
//
// So designing a schema from the stub would encode a shape we already know is
// wrong, and designing one from screenshots would assume field names the sprint
// explicitly forbids assuming. This endpoint resolves that by asking CallGrid.
//
// WHAT IT RETURNS
//
// For each candidate endpoint: HTTP status, content type, and the TOP-LEVEL
// KEYS of the response — plus the keys of the first row when the body contains
// an array. Keys only. No values, ever.
//
// That is enough to establish the real field inventory, the envelope shape, and
// which groupings are supported, without a single caller id or bid amount
// leaving CallGrid.
//
// SECURITY
//   • GET only, no writes of any kind.
//   • Admin-gated on integrations:manage.
//   • Organization from the signed session.
//   • The API key is read from the environment and never returned, logged, or
//     echoed. Error text is scrubbed of any Bearer token.
//   • VALUES ARE NEVER RETURNED — only key names and array lengths. A bid amount
//     or caller id cannot leave through this route because it is never read.
//   • Bounded: a fixed candidate list, one day, a short timeout per probe.
//
// Delete this route once the report contract is established and recorded.

export const dynamic = 'force-dynamic';

/**
 * Candidate report endpoints, from the contract stubs' own doc comments
 * (`/api/reports/bidStats`, `/api/reports/bidStats/rejections`,
 * `/api/reports/stats`) plus the obvious siblings of the verified `/api/call`.
 *
 * None are confirmed. That is the entire point of probing them.
 */
const CANDIDATES = [
  '/api/reports/bidStats',
  '/api/reports/bidStats/rejections',
  '/api/reports/stats',
  '/api/report/bidStats',
  '/api/bidStats',
  '/api/reports',
  '/api/auction',
  '/api/bid',
] as const;

/** Groupings the business requirement names. Probed as a query parameter. */
const GROUPINGS = ['campaign', 'buyer', 'destination', 'vendor', 'source'] as const;

const PROBE_TIMEOUT_MS = 12_000;

const scrub = (s: string): string => s.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]');

interface ProbeResult {
  path: string;
  status: number | 'network-error';
  contentType: string | null;
  /** Top-level shape, keys only. */
  shape: string | null;
  /** Keys of the first row when the payload contains an array. Keys only. */
  rowKeys: string[] | null;
  /** How many rows came back — a count is not PII. */
  rowCount: number | null;
  /** Which envelope key held the array, when one did. */
  envelope: string | null;
  note: string | null;
}

/** Find an array anywhere in the top level of a body, without reading values. */
function findRows(body: unknown): { rows: unknown[]; envelope: string } | null {
  if (Array.isArray(body)) return { rows: body, envelope: 'array' };
  if (body && typeof body === 'object') {
    for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
      if (Array.isArray(v)) return { rows: v, envelope: k };
    }
  }
  return null;
}

export async function GET(req: Request) {
  if (!(await can('integrations', 'manage'))) {
    return NextResponse.json({ ok: false, error: 'forbidden' }, { status: 403 });
  }
  const { organizationId } = await requireCrmContext();
  if (!organizationId) {
    return NextResponse.json({ ok: false, error: 'no-organization' }, { status: 400 });
  }

  const apiKey = process.env.CALLGRID_API_KEY || '';
  if (!apiKey) {
    return NextResponse.json(
      { ok: false, error: 'api-key-not-configured' },
      { status: 400 },
    );
  }

  const url = new URL(req.url);
  const dateParam = url.searchParams.get('date');
  const day =
    dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam)
      ? new Date(`${dateParam}T00:00:00.000Z`)
      : new Date(Date.now() - 24 * 60 * 60 * 1000);
  const since = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 4));
  const until = new Date(since.getTime() + 24 * 60 * 60 * 1000);

  const base = resolveCallGridBaseUrl().replace(/\/+$/, '');

  async function probe(path: string, grouping?: string): Promise<ProbeResult> {
    const target = new URL(base + path);
    target.searchParams.set('startDate', since.toISOString());
    target.searchParams.set('endDate', until.toISOString());
    target.searchParams.set('reportTimeZone', 'US/Eastern');
    if (grouping) target.searchParams.set('groupBy', grouping);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    try {
      const res = await fetch(target.toString(), {
        method: 'GET',
        headers: { Authorization: 'Bearer ' + apiKey, Accept: 'application/json' },
        signal: controller.signal,
      });
      const contentType = res.headers.get('content-type');
      const label = grouping ? `${path}?groupBy=${grouping}` : path;

      if (!res.ok) {
        return { path: label, status: res.status, contentType, shape: null, rowKeys: null, rowCount: null, envelope: null, note: null };
      }
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        return { path: label, status: res.status, contentType, shape: 'non-json', rowKeys: null, rowCount: null, envelope: null, note: 'body was not JSON' };
      }

      const found = findRows(body);
      const firstRow = found?.rows[0];
      return {
        path: label,
        status: res.status,
        contentType,
        // Keys only — describeShape never emits a value.
        shape: describeShape(body),
        rowKeys:
          firstRow && typeof firstRow === 'object' && !Array.isArray(firstRow)
            ? Object.keys(firstRow as Record<string, unknown>).slice(0, 80)
            : null,
        rowCount: found ? found.rows.length : null,
        envelope: found?.envelope ?? null,
        note: null,
      };
    } catch (error) {
      return {
        path: grouping ? `${path}?groupBy=${grouping}` : path,
        status: 'network-error',
        contentType: null,
        shape: null,
        rowKeys: null,
        rowCount: null,
        envelope: null,
        note: error instanceof Error ? scrub(error.message) : 'unknown',
      };
    } finally {
      clearTimeout(timer);
    }
  }

  // Probe the candidates sequentially to stay well inside CallGrid's documented
  // 100 req/min limit.
  const endpoints: ProbeResult[] = [];
  for (const path of CANDIDATES) endpoints.push(await probe(path));

  // For whichever candidate answered 200, probe each grouping so the supported
  // dimensions are established rather than assumed.
  const reachable = endpoints.find((e) => e.status === 200 && e.rowKeys);
  const groupings: ProbeResult[] = [];
  if (reachable) {
    const basePath = reachable.path.split('?')[0]!;
    for (const g of GROUPINGS) groupings.push(await probe(basePath, g));
  }

  return NextResponse.json({
    ok: true,
    window: { since: since.toISOString(), until: until.toISOString(), reportTimeZone: 'US/Eastern' },
    // Keys and counts only. No values are read from any response body.
    endpoints,
    groupings,
    summary: reachable
      ? `Reachable report endpoint: ${reachable.path} (envelope: ${reachable.envelope}, ${reachable.rowCount} row(s)).`
      : 'No candidate report endpoint returned a usable JSON array. Bid reporting may not be exposed on this API, or uses a different path.',
    at: new Date().toISOString(),
  });
}
