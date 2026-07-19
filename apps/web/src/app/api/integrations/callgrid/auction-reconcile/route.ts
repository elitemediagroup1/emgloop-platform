// Auction report reconciliation — GET-only, admin-gated, read-only.
//
// Fetches the provider's report for one UTC day and compares it against the
// snapshots Loop stored for that same window. It writes nothing.
//
// READ THE `clean` FLAG, NOT THE DIFF COUNT. The diff list is expected to be
// non-empty even on a perfect run: every money field appears in it as a
// `money-conversion` entry, because 11.09 dollars and 1109 cents are different
// numbers that agree. `clean` is true only when no DEFECT classification
// appeared, which is the question an operator is actually asking.

import { NextResponse } from 'next/server';
import { requireCrmContext } from '../../../../../crm/crm-data';
import { can } from '../../../../../auth/auth';
import {
  prisma,
  MarketplaceAuctionRepository,
  reconcileGrain,
  reconcileTotals,
  BID_FIELD_PLAN,
  REJECTION_FIELD_PLAN,
  PING_FIELD_PLAN,
} from '@emgloop/database';
import {
  resolveCallGridBaseUrl,
  fetchWholeReport,
  parseBidStatsRow,
  parseBidRejectionsRow,
  parsePingStatsRow,
  CallGridReportError,
  scrub,
} from '@emgloop/providers';

export const dynamic = 'force-dynamic';

const PROVIDER = 'callgrid';

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
        detail: 'CALLGRID_API_KEY is not set. Reconciliation cannot run; this is not a passing reconciliation.',
      },
      { status: 400 },
    );
  }

  const url = new URL(req.url);
  const date = url.searchParams.get('date');
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json(
      { ok: false, error: 'date-required', detail: 'Pass ?date=YYYY-MM-DD (one UTC day).' },
      { status: 400 },
    );
  }

  const startDate = `${date}T00:00:00.000Z`;
  const endDate = `${date}T23:59:59.999Z`;
  const windowStart = new Date(startDate);
  const windowEnd = new Date(endDate);

  const repo = new MarketplaceAuctionRepository(prisma);
  const [storedBid, storedPing, runs] = await Promise.all([
    repo.listBidSourceSnapshots(organizationId, PROVIDER, windowStart, windowEnd),
    repo.listPingDestinationSnapshots(organizationId, PROVIDER, windowStart, windowEnd),
    repo.listRuns(organizationId, PROVIDER, windowStart, windowEnd),
  ]);

  const opts = { baseUrl: resolveCallGridBaseUrl(), apiKey, startDate, endDate, limit: 100, maxPages: 20 };

  const live = async <T,>(
    endpoint: 'bidStats' | 'bidRejections' | 'pingStats',
    parse: (r: Record<string, unknown>) => T | null,
  ) => {
    try {
      const raw = await fetchWholeReport(endpoint, opts);
      return {
        ok: true as const,
        rows: raw.rows.map(parse).filter((r): r is T => r !== null),
        footerTotals: raw.footerTotals,
        totalPages: raw.totalPages,
        truncated: raw.truncated,
      };
    } catch (error) {
      const detail =
        error instanceof CallGridReportError
          ? `${error.classification}: ${scrub(error.message, apiKey)}`
          : 'endpoint-failure';
      return { ok: false as const, detail };
    }
  };

  const [bid, rej, ping] = await Promise.all([
    live('bidStats', parseBidStatsRow),
    live('bidRejections', parseBidRejectionsRow),
    live('pingStats', parsePingStatsRow),
  ]);

  const asRecords = (rows: readonly unknown[]) => rows as ReadonlyArray<Record<string, unknown>>;

  const bidRecon = bid.ok
    ? reconcileGrain(
        'source',
        {
          liveRows: asRecords(bid.rows),
          storedRows: asRecords(storedBid),
          liveIdField: 'sourceExternalId',
          storedIdField: 'sourceExternalId',
          liveNameField: 'sourceName',
          storedNameField: 'sourceName',
        },
        BID_FIELD_PLAN,
      )
    : null;

  const rejRecon = rej.ok
    ? reconcileGrain(
        'source',
        {
          liveRows: asRecords(rej.rows),
          storedRows: asRecords(storedBid),
          liveIdField: 'sourceExternalId',
          storedIdField: 'sourceExternalId',
          liveNameField: 'sourceName',
          storedNameField: 'sourceName',
        },
        REJECTION_FIELD_PLAN,
      )
    : null;

  const pingRecon = ping.ok
    ? reconcileGrain(
        'destination',
        {
          liveRows: asRecords(ping.rows),
          storedRows: asRecords(storedPing),
          liveIdField: 'destinationExternalId',
          storedIdField: 'destinationExternalId',
          liveNameField: 'destinationName',
          storedNameField: 'destinationName',
        },
        PING_FIELD_PLAN,
      )
    : null;

  // Provider footers vs the totals the last ingestion run recomputed. Compared
  // only for summable fields — an average is not a sum and comparing it to one
  // would manufacture a discrepancy.
  const runFor = (endpoint: string) => runs.find((r) => r.endpoint === endpoint) ?? null;
  const totalsFor = (
    endpoint: string,
    pairs: ReadonlyArray<{ live: string; stored: string; kind: 'count' | 'money' }>,
  ) => {
    const run = runFor(endpoint);
    if (!run) return [];
    return reconcileTotals(
      (run.providerFooterTotals as Record<string, unknown> | null) ?? null,
      (run.recomputedTotals as Record<string, { value: number | null }> | null) ?? null,
      pairs,
    );
  };

  if (bidRecon) {
    bidRecon.totalsDiffs = totalsFor('bidStats', [
      { live: 'total', stored: 'total', kind: 'count' },
      { live: 'bids', stored: 'bids', kind: 'count' },
      { live: 'rated', stored: 'rated', kind: 'count' },
      { live: 'won', stored: 'won', kind: 'count' },
      { live: 'rejected', stored: 'rejected', kind: 'count' },
      { live: 'totalBidAmount', stored: 'totalBidAmountCents', kind: 'money' },
      { live: 'totalWonAmount', stored: 'totalWonAmountCents', kind: 'money' },
    ]);
  }
  if (pingRecon) {
    pingRecon.totalsDiffs = totalsFor('pingStats', [
      'accepted', 'failedAcceptance', 'failedTagRules', 'minRevenue', 'missingAmount',
      'invalidNumber', 'durationElapsed', 'pingTimeout', 'apiFailed', 'rateLimited', 'suppressed',
    ].map((f) => ({ live: f, stored: f, kind: 'count' as const })));
  }

  const sections = [bidRecon, rejRecon, pingRecon].filter((s): s is NonNullable<typeof s> => s !== null);
  const allClean = sections.length === 3 && sections.every((s) => s.clean);

  return NextResponse.json({
    ok: true,
    window: { start: startDate, end: endDate, timezone: 'UTC' },
    fetchFailures: [
      !bid.ok ? { endpoint: 'bidStats', detail: bid.detail } : null,
      !rej.ok ? { endpoint: 'bidRejections', detail: rej.detail } : null,
      !ping.ok ? { endpoint: 'pingStats', detail: ping.detail } : null,
    ].filter(Boolean),
    bidStats: bidRecon,
    bidRejections: rejRecon,
    pingStats: pingRecon,
    runs: runs.map((r) => ({
      endpoint: r.endpoint,
      status: r.status,
      rowCount: r.rowCount,
      truncated: r.truncated,
      inserted: r.inserted,
      updated: r.updated,
      skipped: r.skipped,
      failed: r.failed,
      moneyUnitEvidence: r.moneyUnitEvidence,
      errorClassification: r.errorClassification,
      fetchedAt: r.fetchedAt,
    })),
    verdict: allClean
      ? 'CLEAN — every compared field either matched exactly or differed by an explained conversion'
      : 'NOT CLEAN — see diffs whose classification is a defect class, or a fetch failure above',
    clean: allClean,
  });
}
