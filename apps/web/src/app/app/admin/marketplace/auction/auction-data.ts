// Auction Intelligence — server data loader.
//
// Reads stored snapshots and run records, builds observations, and hands them to
// the pure confidence/rules layer. The split is the same one the rest of
// Marketplace uses: the repository counts, the engine judges, and neither
// invents.
//
// It reads STORED SNAPSHOTS ONLY. It never calls CallGrid. A page that fetched
// live on render would make an operator's page load depend on a third party's
// uptime, and would report a provider outage as missing marketplace data.

import {
  assessAuction,
  runAuctionIntelligence,
  observe,
  verifyDenominators,
  AUCTION_FUNNEL_STAGES,
  AUCTION_FUNNEL_TRANSITIONS,
  transitionIsPublishable,
  type AuctionEngineResult,
  type DenominatorVerdict,
  type AuctionObservation,
} from '@emgloop/intelligence';
import { MarketplaceAuctionRepository, prisma } from '@emgloop/database';

const PROVIDER = 'callgrid';

export interface AuctionWindowSummary {
  windowStart: Date;
  windowEnd: Date;
  label: string;
}

export interface AuctionPageData {
  /** Null when no auction sync has ever run for this organization. */
  window: AuctionWindowSummary | null;
  runs: Array<{
    endpoint: string;
    status: string;
    rowCount: number | null;
    truncated: boolean;
    inserted: number;
    updated: number;
    skipped: number;
    failed: number;
    moneyUnitEvidence: string | null;
    errorClassification: string | null;
    fetchedAt: Date;
  }>;
  sourceRows: number;
  destinationRows: number;
  /**
   * One result per grain, never merged. Source and destination are opposite
   * sides of the marketplace; a combined ranking would imply a comparability
   * no provider data asserts.
   */
  intelligence: { source: AuctionEngineResult; destination: AuctionEngineResult } | null;
  denominators: DenominatorVerdict[];
  funnel: Array<{
    id: string;
    from: string;
    to: string;
    numerator: string;
    denominator: string;
    comparability: string;
    publishable: boolean;
    reason: string;
  }>;
  stages: typeof AUCTION_FUNNEL_STAGES;
  /** True only when a money field carried a fractional part on the latest run. */
  moneyUnitProven: boolean;
}

/** Metrics observed at source grain, with `total` as the same-row denominator. */
const SOURCE_METRICS: ReadonlyArray<[string, string]> = [
  ['total', 'Bid report total'],
  ['bids', 'Bids'],
  ['rated', 'Rated'],
  ['won', 'Won'],
  ['rejected', 'Rejected'],
  ['duplicateBids', 'Duplicate bids'],
  ['duplicateCaller', 'Duplicate callers'],
  ['failedAcceptance', 'Failed acceptance'],
  ['failedTagRules', 'Failed tag rules'],
  ['paused', 'Rejected because paused'],
  ['closed', 'Rejected because closed'],
  ['callerIdRejected', 'Rejected on caller id'],
];

const DESTINATION_METRICS: ReadonlyArray<[string, string]> = [
  ['accepted', 'Pings accepted'],
  ['rateLimited', 'Pings rejected by rate limiting'],
  ['pingTimeout', 'Pings that timed out'],
  ['apiFailed', 'Pings lost to API failure'],
  ['suppressed', 'Suppressed pings'],
  ['minRevenue', 'Pings below the minimum-revenue floor'],
  ['missingAmount', 'Pings missing an amount'],
  ['invalidNumber', 'Pings with an invalid number'],
  ['failedAcceptance', 'Pings failing acceptance'],
  ['failedTagRules', 'Pings failing tag rules'],
];

export async function loadAuctionPageData(organizationId: string): Promise<AuctionPageData> {
  const repo = new MarketplaceAuctionRepository(prisma);
  const latest = await repo.latestRuns(organizationId, PROVIDER, 12);

  const empty: AuctionPageData = {
    window: null, runs: [], sourceRows: 0, destinationRows: 0,
    intelligence: null, denominators: [], funnel: [],
    stages: AUCTION_FUNNEL_STAGES, moneyUnitProven: false,
  };
  if (latest.length === 0) return empty;

  // The most recent window that was actually synced. Runs are ordered by
  // fetchedAt desc, so the first entry names it.
  const head = latest[0]!;
  const windowStart = head.reportWindowStart;
  const windowEnd = head.reportWindowEnd;
  const runs = latest.filter(
    (r) => r.reportWindowStart.getTime() === windowStart.getTime() &&
           r.reportWindowEnd.getTime() === windowEnd.getTime(),
  );

  const [sourceSnapshots, destinationSnapshots] = await Promise.all([
    repo.listBidSourceSnapshots(organizationId, PROVIDER, windowStart, windowEnd),
    repo.listPingDestinationSnapshots(organizationId, PROVIDER, windowStart, windowEnd),
  ]);

  const moneyUnitProven = runs.some((r) => r.moneyUnitEvidence === 'proven-dollars');

  const sourceRecords = sourceSnapshots as unknown as Array<Record<string, unknown>>;
  const destinationRecords = destinationSnapshots as unknown as Array<Record<string, unknown>>;

  // The denominator for every source-grain rule is `total` from the SAME rows.
  // Null when no row reported it, which withholds every rule that needs it
  // rather than letting them divide by an invented number.
  const sourceTotal = sumField(sourceRecords, 'total');
  const destinationAccepted = sumField(destinationRecords, 'accepted');

  const observations: AuctionObservation[] = [
    ...SOURCE_METRICS.map(([name, label]) =>
      observe(sourceRecords, name, label, 'source', {
        denominator: sourceTotal,
        denominatorName: 'bidStats.total',
      }),
    ),
    ...DESTINATION_METRICS.map(([name, label]) =>
      observe(destinationRecords, name, label, 'destination', {
        denominator: destinationAccepted,
        denominatorName: 'pingStats.accepted',
      }),
    ),
  ];

  // Two grains, assessed and run SEPARATELY. There is no combined report to
  // pass, so a cross-grain ranking is not something this loader could produce
  // even by accident.
  const assessment = assessAuction({
    measuredAt: new Date().toISOString(),
    windowLabel: windowStart.toISOString().slice(0, 10),
    observations,
    sourceRowsExamined: sourceRecords.length,
    destinationRowsExamined: destinationRecords.length,
    moneyUnitProven,
    sourceEndpoint: '/api/reports/bidStats',
    destinationEndpoint: '/api/reports/pingStats',
  });

  const intelligence = {
    source: runAuctionIntelligence({
      evidence: assessment.source, values: assessment.values,
    }),
    destination: runAuctionIntelligence({
      evidence: assessment.destination, values: assessment.values,
    }),
  };

  // Denominator hypotheses tested against the stored rows. Provider rates are
  // stored in percentage points, so the test compares against the same scale.
  const denominators = verifyDenominators(
    sourceSnapshots.map((s) => ({
      bids: s.bids, total: s.total, won: s.won, rejected: s.rejected,
      bidRate: s.bidRatePercent, winRate: s.winRatePercent, rejectRate: s.rejectRatePercent,
    })),
  );

  const funnel = AUCTION_FUNNEL_TRANSITIONS.map((t) => {
    const verdict = transitionIsPublishable(t, denominators, sourceRecords.length);
    return {
      id: t.id, from: t.from, to: t.to,
      numerator: t.numerator, denominator: t.denominator,
      comparability: t.comparability,
      publishable: verdict.publishable,
      reason: verdict.reason,
    };
  });

  return {
    window: {
      windowStart, windowEnd,
      label: `${windowStart.toISOString().slice(0, 10)} (UTC, as requested)`,
    },
    runs: runs.map((r) => ({
      endpoint: r.endpoint, status: r.status, rowCount: r.rowCount, truncated: r.truncated,
      inserted: r.inserted, updated: r.updated, skipped: r.skipped, failed: r.failed,
      moneyUnitEvidence: r.moneyUnitEvidence, errorClassification: r.errorClassification,
      fetchedAt: r.fetchedAt,
    })),
    sourceRows: sourceRecords.length,
    destinationRows: destinationRecords.length,
    intelligence,
    denominators,
    funnel,
    stages: AUCTION_FUNNEL_STAGES,
    moneyUnitProven,
  };
}

/** Null when no row reported the field. Never 0 — see sumOrNull's reasoning. */
function sumField(rows: ReadonlyArray<Record<string, unknown>>, field: string): number | null {
  let total = 0;
  let counted = 0;
  for (const r of rows) {
    const v = r[field];
    if (typeof v === 'number' && Number.isFinite(v)) { total += v; counted += 1; }
  }
  return counted > 0 ? total : null;
}
