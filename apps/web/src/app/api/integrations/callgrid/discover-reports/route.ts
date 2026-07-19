import { NextResponse } from 'next/server';
import { requireCrmContext } from '../../../../../crm/crm-data';
import { can } from '../../../../../auth/auth';
import {
  resolveCallGridBaseUrl,
  CALLGRID_REPORT_CONTRACTS,
  FIELDS_ABSENT_FROM_CONTRACT,
  probeReportContract,
} from '@emgloop/providers';

// CallGrid report contract VERIFICATION — read-only, admin-only.
//
// WHAT CHANGED, AND WHY THE PREVIOUS VERSION WOULD HAVE FAILED
//
// This route previously guessed. It probed eight candidate paths, sent the
// credential as `Authorization: Bearer`, passed a `groupBy` parameter, and
// reported keys only.
//
// CallGrid's OpenAPI document is publicly readable at
// https://api.callgrid.com/openapi (HTTP 200, no credential), and it settles
// every one of those guesses — three of them against us:
//
//   • Auth is securityScheme `apiKey`, in: QUERY. A Bearer header is not the
//     documented transport, so the old probe would very likely have 401'd on
//     every candidate and been read as "bid reporting is not exposed".
//   • `groupBy` does not exist anywhere in the spec. Grouping is FIXED —
//     bidStats by source, pingStats by destination. Buyer, campaign and vendor
//     breakdowns are simply not available from these endpoints.
//   • `page` is documented ZERO-based.
//
// So this no longer discovers paths. All four endpoints are confirmed to exist
// in the spec; what remains genuinely unknown is the DATA — units, denominators,
// real nullability, and whether the UI report's columns correspond to the API's
// fields at all. That is what this verifies now.
//
// DOCUMENTED IS NOT OBSERVED
//
// The spec is evidence about the contract, not about the data. It documents
// `avgBid: number` with no unit; whether that is dollars or cents decides
// whether every marketplace figure in Loop is wrong by 100x. No schema may be
// designed until a live response anchors it. This route produces that anchor.
//
// SECURITY
//   • Admin-gated on integrations:manage; organization from the signed session.
//   • The credential is sent as the documented query parameter but never
//     returned, logged, or thrown — `redact()` scrubs every error path.
//   • `organizationId` is deliberately NOT sent. CallGrid resolves it from the
//     key. Letting a caller name its own organization is the multi-tenant
//     defect class this platform has already been bitten by.
//   • `last5Bids` is never read, on any path — not even to describe its type.
//     It is the one field likely to carry caller identifiers.
//   • Values are read only from numeric aggregates and grouping identity.
//   • Bounded: one day, one page per endpoint, a timeout per probe.

export const dynamic = 'force-dynamic';

const MAX_LIMIT = 100;

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
      {
        ok: false,
        error: 'api-key-not-configured',
        // Stated plainly so an empty result is never mistaken for an empty report.
        detail:
          'CALLGRID_API_KEY is not set in this environment. Live contract verification cannot run, and nothing here may be treated as evidence about CallGrid data.',
      },
      { status: 400 },
    );
  }

  const url = new URL(req.url);
  const dateParam = url.searchParams.get('date');
  const day = dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam) ? dateParam : null;
  if (!day) {
    return NextResponse.json(
      {
        ok: false,
        error: 'date-required',
        detail:
          'Pass ?date=YYYY-MM-DD. An exact window is required; a defaulted one would make the result unreproducible.',
      },
      { status: 400 },
    );
  }

  const limitRaw = Number(url.searchParams.get('limit') ?? '25');
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(1, Math.trunc(limitRaw)), MAX_LIMIT) : 25;

  // Inclusive ISO 8601 bounds, exactly as the parameters are documented. The
  // three GET reports accept NO timezone parameter, so this is a UTC day and the
  // provider's own bucketing timezone is an open question the probe records.
  const startDate = `${day}T00:00:00.000Z`;
  const endDate = `${day}T23:59:59.999Z`;

  const results = [];
  for (const contract of CALLGRID_REPORT_CONTRACTS) {
    results.push(
      await probeReportContract(contract, {
        baseUrl: resolveCallGridBaseUrl(),
        apiKey,
        startDate,
        endDate,
        page: 0,
        limit,
      }),
    );
  }

  const reachable = results.filter((r) => r.status === 200);

  return NextResponse.json({
    ok: true,
    evidenceGrade: 'observed',
    window: {
      startDate,
      endDate,
      timezone: 'UTC',
      note: 'The three GET report endpoints accept no timezone parameter. Whether CallGrid buckets these rows in UTC or in an account-local zone is NOT established by this probe, and a UTC-day assumption must not be baked into a schema until it is.',
    },
    results,
    contractGaps: FIELDS_ABSENT_FROM_CONTRACT,
    summary:
      reachable.length === CALLGRID_REPORT_CONTRACTS.length
        ? `All ${reachable.length} report endpoints answered 200. Field drift, observed nullability and numeric representation are recorded per endpoint.`
        : `${reachable.length} of ${CALLGRID_REPORT_CONTRACTS.length} endpoints answered 200. A non-200 is NOT an empty report — see per-endpoint status.`,
    at: new Date().toISOString(),
  });
}
