// Auction report projection, reconciliation, and ingestion.
//
// Everything here is either a pure function or a dependency-injected service.
// No database, no clock, no network — which is deliberate: the decisions worth
// pinning are all decisions about MEANING, and none of them need Postgres to be
// wrong.
//
// The three that would be most expensive to get wrong, and are therefore the
// spine of this file:
//
//   • the money unit. Off by 100x in either direction and every marketplace
//     figure in Loop is wrong while looking entirely plausible.
//   • the join key. Joining sources by name merges two businesses' economics
//     into one row, and the result reconciles green.
//   • the difference between "we did not measure this" and "this was zero".
//     Summing nulls as 0 converts an unknown into a confident claim.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PrismaClient } from '@prisma/client';
import type { BidStatsRow, BidRejectionsRow, PingStatsRow } from '@emgloop/providers';
import {
  centsOrNull,
  countOrNull,
  percentOrNull,
  anchorMoneyUnit,
  projectBidSourceSnapshots,
  collidingDestinations,
  sumOrNull,
  type BidSourceSnapshotInput,
} from '../src/repositories/marketplace-auction-projection';
import {
  reconcileGrain,
  DEFECT_CLASSIFICATIONS,
  BID_FIELD_PLAN,
} from '../src/services/auction-reconciliation';
import {
  MarketplaceAuctionRepository,
  type ReportRunRecord,
  type UpsertCounts,
} from '../src/repositories/marketplace-auction.repository';
import { AuctionReportIngestionService } from '../src/services/auction-report-ingestion.service';

// --- Fixtures -----------------------------------------------------------------

const WINDOW: BidSourceSnapshotInput = {
  organizationId: 'org_a',
  provider: 'callgrid',
  reportWindowStart: new Date('2026-07-18T00:00:00.000Z'),
  reportWindowEnd: new Date('2026-07-18T23:59:59.999Z'),
  reportTimezone: 'UTC',
  fetchedAt: new Date('2026-07-19T06:00:00.000Z'),
  sourceEndpoint: '/api/reports/bidStats',
  sourcePage: null,
  sourceTotalPages: 1,
  providerPayloadHash: 'hash:hash',
};

function bidRow(over: Partial<BidStatsRow> & { sourceExternalId: string }): BidStatsRow {
  return {
    sourceName: null,
    total: null, bids: null, rated: null, won: null, rejected: null,
    totalBidAmount: null, totalWonAmount: null, avgBid: null, avgWinningBid: null,
    winRate: null, bidRate: null, rejectRate: null,
    ...over,
  };
}

function rejRow(over: Partial<BidRejectionsRow> & { sourceExternalId: string }): BidRejectionsRow {
  return {
    sourceName: null, rejected: null, callerIdRejected: null, closed: null, paused: null,
    duplicateCaller: null, duplicateBids: null, failedAcceptance: null, failedTagRules: null,
    ...over,
  };
}

function pingRow(over: Partial<PingStatsRow> & { destinationExternalId: string }): PingStatsRow {
  return {
    destinationName: null, rowDate: null, accepted: null, agents: null,
    failedAcceptance: null, failedTagRules: null, minRevenue: null, missingAmount: null,
    invalidNumber: null, durationElapsed: null, pingTimeout: null, apiFailed: null,
    rateLimited: null, suppressed: null,
    ...over,
  };
}

// --- Money, counts, rates -----------------------------------------------------

test('money crosses the boundary as integer cents, and silence stays silent', () => {
  assert.equal(centsOrNull(11.09), 1109);
  assert.equal(centsOrNull(0), 0, 'the provider reporting zero is a measurement');
  assert.equal(centsOrNull(null), null, 'the provider reporting nothing is not');
  assert.equal(centsOrNull(undefined), null);
  // Rounding must match marketplace-call-projection exactly. Two rounding rules
  // for one currency in one product is a reconciliation bug with a long fuse.
  assert.equal(centsOrNull(585382.56), 58538256);
});

test('the money unit can be proven dollars but is never guessed to be cents', () => {
  // Cents are integers by construction, so a fractional part is proof.
  assert.equal(anchorMoneyUnit([{ avgBid: 11.09 }], null), 'proven-dollars');
  // All-integer money is equally consistent with dollars and with cents, so it
  // proves nothing and must say so rather than picking the convenient answer.
  assert.equal(anchorMoneyUnit([{ avgBid: 11, totalBidAmount: 200 }], null), 'assumed-dollars');
  assert.equal(anchorMoneyUnit([{ avgBid: 0 }], null), 'assumed-dollars', 'zero is money observed');
  // No money at all is a third state — reporting it as "assumed" would imply we
  // looked at a value we never saw.
  assert.equal(anchorMoneyUnit([{ avgBid: null }], null), 'no-money-observed');
  assert.equal(anchorMoneyUnit([], null), 'no-money-observed');
  // The footer is evidence too: a paginated report can carry integral rows and a
  // fractional total.
  assert.equal(anchorMoneyUnit([{ avgBid: 11 }], { totalBidAmount: 585382.56 }), 'proven-dollars');
  assert.equal(anchorMoneyUnit([], { avgBid: 11.09 }), 'proven-dollars');
});

test('a fractional count is rejected rather than rounded', () => {
  assert.equal(countOrNull(12), 12);
  assert.equal(countOrNull(0), 0);
  assert.equal(countOrNull(null), null);
  // If CallGrid ever sends `bids: 3.5` the field is not the count we think it
  // is. Rounding to 4 would bury the only evidence of that.
  assert.equal(countOrNull(3.5), null);
  assert.notEqual(countOrNull(3.5), 4);
});

test('a provider rate is stored in percentage points exactly as sent', () => {
  // Never divided by 100 and never recomputed from counts: the provider's rate
  // is the provider's claim, and overwriting it destroys the disagreement that
  // reconciliation exists to surface.
  assert.equal(percentOrNull(14.473684), 14.473684);
  assert.equal(percentOrNull(0.9184), 0.9184);
  assert.equal(percentOrNull(null), null);
});

// --- The join ------------------------------------------------------------------

test('the two source-grain reports join on the provider id, in both directions', () => {
  const bids = [bidRow({ sourceExternalId: 's1', sourceName: 'Alpha', bids: 10, avgBid: 11.09 })];
  const rejections = [
    rejRow({ sourceExternalId: 's1', rejected: 4, callerIdRejected: 1 }),
    rejRow({ sourceExternalId: 's2', sourceName: 'Beta', rejected: 9 }),
  ];
  const out = projectBidSourceSnapshots(bids, rejections, WINDOW);
  const byId = new Map(out.map((s) => [s.sourceExternalId, s]));
  assert.equal(out.length, 2);

  const s1 = byId.get('s1')!;
  assert.equal(s1.bids, 10);
  assert.equal(s1.avgBidCents, 1109);
  assert.equal(s1.rejectedDetail, 4);

  // A source only the rejections report knows about still produces a snapshot.
  // Dropping it would discard real rejection volume; null bid metrics state
  // "bidStats did not describe this source", which is not "zero bids".
  const s2 = byId.get('s2')!;
  assert.equal(s2.rejectedDetail, 9);
  assert.equal(s2.bids, null);
  assert.equal(s2.avgBidCents, null);
  assert.equal(s2.winRatePercent, null);

  // A source only bidStats knows about keeps null rejection fields, for the
  // same reason in the other direction — a rejection-rate rule must not read
  // "not reported" as "none".
  const onlyBids = projectBidSourceSnapshots([bidRow({ sourceExternalId: 's9', bids: 3 })], [], WINDOW);
  assert.equal(onlyBids[0]!.rejectedDetail, null);
  assert.equal(onlyBids[0]!.failedTagRules, null);
});

test('two sources sharing a display name stay two rows', () => {
  // The scenario the name join gets wrong: provider-editable labels collide, and
  // a merged row looks entirely plausible while containing two businesses' bid
  // economics added together.
  const bids = [
    bidRow({ sourceExternalId: 's1', sourceName: 'Plumbing Co', bids: 10 }),
    bidRow({ sourceExternalId: 's2', sourceName: 'Plumbing Co', bids: 20 }),
  ];
  const rejections = [rejRow({ sourceExternalId: 's2', sourceName: 'Plumbing Co', rejected: 7 })];
  const out = projectBidSourceSnapshots(bids, rejections, WINDOW);
  assert.equal(out.length, 2);
  const byId = new Map(out.map((s) => [s.sourceExternalId, s]));
  assert.equal(byId.get('s1')!.bids, 10);
  assert.equal(byId.get('s1')!.rejectedDetail, null, 's1 must not inherit s2 rejections');
  assert.equal(byId.get('s2')!.rejectedDetail, 7);
});

test('projection is deterministic, so the upsert key is stable across syncs', () => {
  const bids = [bidRow({ sourceExternalId: 's1', bids: 10 }), bidRow({ sourceExternalId: 's2', bids: 2 })];
  const rejections = [rejRow({ sourceExternalId: 's2', rejected: 1 })];
  // Re-running a window must UPDATE, never duplicate. That relies on the
  // projection producing byte-identical identity fields for identical input.
  assert.deepEqual(
    projectBidSourceSnapshots(bids, rejections, WINDOW),
    projectBidSourceSnapshots(bids, rejections, WINDOW),
  );
});

test('a repeated destinationId within one window is detected, not silently overwritten', () => {
  // pingStats buckets per day. A two-day window returns two rows per destination
  // and the snapshot identity collides — the upsert would keep whichever row
  // landed last and discard the rest without a trace.
  assert.deepEqual(
    collidingDestinations([
      pingRow({ destinationExternalId: 'd1', rowDate: '2026-07-18' }),
      pingRow({ destinationExternalId: 'd1', rowDate: '2026-07-19' }),
      pingRow({ destinationExternalId: 'd2' }),
    ]),
    ['d1'],
  );
  assert.deepEqual(
    collidingDestinations([pingRow({ destinationExternalId: 'd1' }), pingRow({ destinationExternalId: 'd2' })]),
    [],
  );
  assert.deepEqual(collidingDestinations([]), []);
});

// --- Totals --------------------------------------------------------------------

test('a total nobody reported is null, not zero', () => {
  // A 0 here would reconcile against the provider's real total and produce a
  // confident false mismatch — or, worse, a false match.
  const none = sumOrNull([{ bids: null }, { bids: 'x' }, {}], 'bids');
  assert.deepEqual(none, { value: null, counted: 0, missing: 3 });

  const some = sumOrNull([{ bids: 5 }, { bids: null }, { bids: 7 }], 'bids');
  // counted/missing travel with the value so a partial total is never read as
  // a complete one.
  assert.deepEqual(some, { value: 12, counted: 2, missing: 1 });

  assert.deepEqual(sumOrNull([{ bids: 0 }], 'bids'), { value: 0, counted: 1, missing: 0 });
});

// --- Reconciliation classification ---------------------------------------------

const IDS = {
  liveIdField: 'sourceId',
  storedIdField: 'sourceExternalId',
  liveNameField: 'sourceName',
  storedNameField: 'sourceName',
};

function bidRecon(live: Record<string, unknown>[], stored: Record<string, unknown>[]) {
  return reconcileGrain('source', { liveRows: live, storedRows: stored, ...IDS }, BID_FIELD_PLAN);
}

test('identical counts reconcile as exact matches with no diffs', () => {
  const r = bidRecon(
    [{ sourceId: 's1', sourceName: 'Alpha', total: 6, bids: 5, rated: 1, won: 1, rejected: 0 }],
    [{ sourceExternalId: 's1', sourceName: 'Alpha', total: 6, bids: 5, rated: 1, won: 1, rejected: 0 }],
  );
  assert.deepEqual(r.diffs, []);
  assert.equal(r.exactMatches, r.comparedFields);
  assert.equal(r.rowCountMatches, true);
  assert.equal(r.clean, true);
});

test('a dollars-to-cents difference is an agreement, not a defect', () => {
  const r = bidRecon(
    [{ sourceId: 's1', sourceName: 'Alpha', avgBid: 11.09 }],
    [{ sourceExternalId: 's1', sourceName: 'Alpha', avgBidCents: 1109 }],
  );
  const d = r.diffs.find((x) => x.field === 'avgBid')!;
  assert.equal(d.classification, 'money-conversion');
  assert.match(d.explanation, /agrees under the dollars→cents rule/);
  // "avgBid 11.09 vs 1109" is the conversion working. Reporting it as a failure
  // is how a reconciliation report becomes noise nobody reads.
  assert.equal(r.clean, true);
});

test('an unconverted money value is classified the same way but explained as a fault', () => {
  const r = bidRecon(
    [{ sourceId: 's1', sourceName: 'Alpha', avgBid: 11.09 }],
    [{ sourceExternalId: 's1', sourceName: 'Alpha', avgBidCents: 11.09 }],
  );
  const d = r.diffs.find((x) => x.field === 'avgBid')!;
  assert.equal(d.classification, 'money-conversion');
  // Same classification, opposite meaning — the explanation is what carries it,
  // which is why the explanation is asserted rather than treated as prose.
  assert.match(d.explanation, /conversion did NOT run/);
  assert.match(d.explanation, /100x too small/);
});

test('a fraction-vs-percentage-points difference is a representation finding', () => {
  const r = bidRecon(
    [{ sourceId: 's1', sourceName: 'Alpha', winRate: 91.84 }],
    [{ sourceExternalId: 's1', sourceName: 'Alpha', winRatePercent: 0.9184 }],
  );
  const d = r.diffs.find((x) => x.field === 'winRate')!;
  assert.equal(d.classification, 'percentage-representation');
  assert.match(d.explanation, /100x/);
  assert.equal(r.clean, true, 'two denominators, both correct');
});

test('a row on only one side is a defect, and names which side', () => {
  const missing = bidRecon([{ sourceId: 's1', sourceName: 'Alpha' }], []);
  assert.equal(missing.diffs[0]!.classification, 'missing-source');
  assert.equal(missing.clean, false, 'the provider returned a source Loop never stored');

  const extra = bidRecon([], [{ sourceExternalId: 's1', sourceName: 'Alpha' }]);
  assert.equal(extra.diffs[0]!.classification, 'extra-source');
  assert.equal(extra.clean, false);
});

test('the destination grain reports its own classifications, never the source ones', () => {
  const ids = {
    liveIdField: 'destinationId',
    storedIdField: 'destinationExternalId',
    liveNameField: 'destinationName',
    storedNameField: 'destinationName',
  };
  const plan = { counts: [{ live: 'accepted', stored: 'accepted' }], money: [], percent: [] };
  const missing = reconcileGrain('destination', { liveRows: [{ destinationId: 'd1' }], storedRows: [], ...ids }, plan);
  assert.equal(missing.diffs[0]!.classification, 'missing-destination');
  const extra = reconcileGrain('destination', { liveRows: [], storedRows: [{ destinationExternalId: 'd1' }], ...ids }, plan);
  assert.equal(extra.diffs[0]!.classification, 'extra-destination');
});

test('a renamed source is recorded but is not a defect', () => {
  const r = bidRecon(
    [{ sourceId: 's1', sourceName: 'New Name', total: 6 }],
    [{ sourceExternalId: 's1', sourceName: 'Old Name', total: 6 }],
  );
  const d = r.diffs.find((x) => x.classification === 'source-name-variation')!;
  assert.ok(d, 'the rename is visible');
  assert.equal(d.live, 'New Name');
  assert.equal(d.stored, 'Old Name');
  assert.equal(r.diffs.length, 1, 'the rename is the only difference');
  // Names are editable display strings and the match was on the id. Failing on a
  // rename would train operators to ignore a red reconciliation.
  assert.equal(r.clean, true);
});

test('a defect anywhere in the diff list makes the whole grain unclean', () => {
  const r = bidRecon(
    [{ sourceId: 's1', sourceName: 'Alpha', total: 6 }, { sourceId: 's2' }],
    [{ sourceExternalId: 's1', sourceName: 'Alpha', total: 6 }],
  );
  assert.equal(r.clean, false);
  assert.ok(r.diffs.some((d) => d.classification === 'missing-source'));
});

test('representation and naming differences are structurally excluded from the defect set', () => {
  // The single most important line in the module: reconciliation "passes" when
  // the DEFECT set is empty, not when the diff list is — the diff list never
  // will be. A denominator or a label is not a data failure.
  assert.equal(DEFECT_CLASSIFICATIONS.has('money-conversion'), false);
  assert.equal(DEFECT_CLASSIFICATIONS.has('percentage-representation'), false);
  assert.equal(DEFECT_CLASSIFICATIONS.has('source-name-variation'), false);
  assert.equal(DEFECT_CLASSIFICATIONS.has('exact-match'), false);
  // And the ones that ARE failures stay failures.
  for (const c of ['missing-source', 'extra-source', 'missing-destination', 'extra-destination', 'pagination', 'unexplained'] as const) {
    assert.equal(DEFECT_CLASSIFICATIONS.has(c), true, `${c} must remain a defect`);
  }
});

// --- Tenant isolation at the write boundary -----------------------------------

/** Records every Prisma call so "did not write" can be asserted, not inferred. */
function fakePrisma() {
  const calls: string[] = [];
  const model = (name: string) => ({
    findUnique: async () => {
      calls.push(`${name}.findUnique`);
      return null;
    },
    upsert: async () => {
      calls.push(`${name}.upsert`);
      return {};
    },
  });
  return {
    calls,
    client: {
      marketplaceBidSourceSnapshot: model('bidSource'),
      marketplacePingDestinationSnapshot: model('pingDestination'),
      marketplaceReportRun: model('reportRun'),
    } as unknown as PrismaClient,
  };
}

test('a snapshot belonging to another tenant is refused, counted, and never written', async () => {
  const fake = fakePrisma();
  const repo = new MarketplaceAuctionRepository(fake.client);
  const foreign = projectBidSourceSnapshots(
    [bidRow({ sourceExternalId: 's1', bids: 5 })],
    [],
    { ...WINDOW, organizationId: 'org_b' },
  );

  const counts = await repo.upsertBidSourceSnapshots('org_a', foreign);

  // Scope is enforced at the data layer, not the call site. The projection can
  // only produce a foreign snapshot through a programming error — which is
  // exactly the case where a caller-side guard would already have been skipped.
  assert.deepEqual(counts, { inserted: 0, updated: 0, failed: 1 });
  assert.deepEqual(fake.calls, [], 'not even a read touched the other tenant');

  // The same snapshot under its own organization writes, proving the refusal is
  // the tenancy check and not a broken fake.
  const own = new MarketplaceAuctionRepository(fakePrisma().client);
  const okCounts = await own.upsertBidSourceSnapshots('org_b', foreign);
  assert.equal(okCounts.inserted, 1);
  assert.equal(okCounts.failed, 0);
});

test('a run record for another tenant is not written either', async () => {
  const fake = fakePrisma();
  const repo = new MarketplaceAuctionRepository(fake.client);
  const run = { organizationId: 'org_b', provider: 'callgrid', endpoint: 'bidStats' } as unknown as ReportRunRecord;
  await repo.recordRun('org_a', run);
  // No audit entry for a write that did not happen.
  assert.deepEqual(fake.calls, []);
});

// --- Ingestion -----------------------------------------------------------------

/** A repo double: records what the service asked it to store, stores nothing. */
function fakeRepo(counts: UpsertCounts = { inserted: 0, updated: 0, failed: 0 }) {
  const runs: ReportRunRecord[] = [];
  const bidWrites: unknown[][] = [];
  const pingWrites: unknown[][] = [];
  const repo = {
    upsertBidSourceSnapshots: async (_org: string, snaps: unknown[]) => {
      bidWrites.push([...snaps]);
      return counts;
    },
    upsertPingDestinationSnapshots: async (_org: string, snaps: unknown[]) => {
      pingWrites.push([...snaps]);
      return counts;
    },
    recordRun: async (_org: string, run: ReportRunRecord) => {
      runs.push(run);
    },
  };
  return { runs, bidWrites, pingWrites, repo: repo as unknown as MarketplaceAuctionRepository };
}

/** Route each endpoint to its own canned body, so one endpoint can fail alone. */
function routedFetch(bodies: Partial<Record<'bidStats' | 'rejections' | 'pingStats', unknown>>) {
  return (async (u: string) => {
    const path = new URL(u).pathname;
    const key = path.endsWith('/rejections')
      ? 'rejections'
      : path.endsWith('/pingStats')
        ? 'pingStats'
        : 'bidStats';
    const body = bodies[key] ?? { data: [], totalPages: 1 };
    if (typeof body === 'string') {
      return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

const INGEST_BASE = {
  organizationId: 'org_a',
  provider: 'callgrid',
  apiKey: 'super-secret-key-value',
  baseUrl: 'https://example.invalid',
  now: new Date('2026-07-19T06:00:00.000Z'),
};

function service(repo: MarketplaceAuctionRepository) {
  // The prisma argument is unreachable once a repo is injected; the service
  // constructs one only when it is not given one.
  return new AuctionReportIngestionService(null as unknown as PrismaClient, repo);
}

test('an inexact window is refused before any request is made', async () => {
  const f = fakeRepo();
  let called = false;
  const fetchImpl = (async () => {
    called = true;
    return new Response('{}');
  }) as unknown as typeof fetch;
  // A defaulted or ranged window is unreproducible, and a multi-day window
  // collides the pingStats grain outright.
  await assert.rejects(
    () => service(f.repo).ingestDay({ ...INGEST_BASE, date: '2026-07', fetchImpl }),
    /YYYY-MM-DD/,
  );
  await assert.rejects(
    () => service(f.repo).ingestDay({ ...INGEST_BASE, date: '2026-07-18T00:00:00Z', fetchImpl }),
    /YYYY-MM-DD/,
  );
  assert.equal(called, false);
  assert.deepEqual(f.runs, [], 'a refused window leaves no run record');
});

test('an unreadable envelope records UNKNOWN_ENVELOPE with a null row count', async () => {
  const f = fakeRepo();
  const res = await service(f.repo).ingestDay({
    ...INGEST_BASE,
    date: '2026-07-18',
    fetchImpl: routedFetch({ bidStats: { results: [], totalPages: 1 } }),
  });
  const bid = res.outcomes.find((o) => o.endpoint === 'bidStats')!;
  assert.equal(bid.status, 'UNKNOWN_ENVELOPE');
  // 0 would render a provider contract change as a quiet day. null says "we do
  // not know", which is the only honest answer available.
  assert.equal(bid.rowCount, null);
  assert.notEqual(bid.rowCount, 0);
  assert.equal(bid.errorClassification, 'unknown-envelope');
  assert.match(bid.errorDetail!, /REJECTED/);

  const run = f.runs.find((r) => r.endpoint === 'bidStats')!;
  assert.equal(run.status, 'UNKNOWN_ENVELOPE');
  assert.equal(run.rowCount, null);
  // One endpoint failing while the others read is the normal case in a provider
  // incident, and `partial` says so without hiding either half.
  assert.equal(res.overall, 'partial');
  // The credential must not survive into anything that gets stored.
  assert.doesNotMatch(JSON.stringify(f.runs), /super-secret-key-value/);
});

test('a genuinely empty report is EMPTY, which is a success', async () => {
  const f = fakeRepo();
  const res = await service(f.repo).ingestDay({
    ...INGEST_BASE,
    date: '2026-07-18',
    fetchImpl: routedFetch({
      bidStats: { data: [], totalPages: 1 },
      rejections: { data: [], totalPages: 1 },
      pingStats: { data: [], count: 0, totalPages: 1 },
    }),
  });
  for (const o of res.outcomes) {
    assert.equal(o.status, 'EMPTY', `${o.endpoint} read cleanly and found nothing`);
    assert.equal(o.rowCount, 0, 'zero rows WERE observed here, unlike the unreadable case');
  }
  assert.equal(res.overall, 'complete');
  // Nothing was measured, so nothing is claimed about the money unit.
  assert.equal(res.moneyUnitEvidence, 'no-money-observed');
});

test('a pingStats grain collision refuses the write entirely', async () => {
  const f = fakeRepo();
  const res = await service(f.repo).ingestDay({
    ...INGEST_BASE,
    date: '2026-07-18',
    fetchImpl: routedFetch({
      pingStats: {
        data: [
          { destinationId: 'd1', date: '2026-07-18', accepted: 4 },
          { destinationId: 'd1', date: '2026-07-19', accepted: 9 },
        ],
        count: 2,
        totalPages: 1,
      },
    }),
  });
  const ping = res.outcomes.find((o) => o.endpoint === 'pingStats')!;
  assert.equal(ping.status, 'UNKNOWN_ENVELOPE');
  assert.equal(ping.errorClassification, 'grain-collision');
  assert.match(ping.errorDetail!, /buckets per day/);
  // Partial storage is worse than none here: the upsert would keep whichever of
  // the two days landed last, under a key that claims to be the whole window.
  assert.deepEqual(f.pingWrites, [], 'nothing was stored');
  assert.equal(res.pingDestinationsStored, 0);
});

test('write counts and the money anchor reach the run record', async () => {
  const f = fakeRepo({ inserted: 2, updated: 1, failed: 3 });
  const res = await service(f.repo).ingestDay({
    ...INGEST_BASE,
    date: '2026-07-18',
    fetchImpl: routedFetch({
      bidStats: {
        data: [
          { sourceId: 's1', sourceName: 'Alpha', bids: 10, avgBid: 11.09, totalBidAmount: 585382.56 },
          { sourceId: 's2', sourceName: 'Beta', bids: 4, avgBid: 9 },
        ],
        footerTotals: { bids: 14 },
        totalPages: 1,
      },
      rejections: { data: [{ sourceId: 's1', source: { id: 's1', name: 'Alpha' }, rejected: 2 }], totalPages: 1 },
      pingStats: { data: [{ destinationId: 'd1', accepted: 3 }], count: 1, totalPages: 1 },
    }),
  });

  const bid = res.outcomes.find((o) => o.endpoint === 'bidStats')!;
  assert.equal(bid.status, 'SUCCESS');
  assert.equal(bid.rowCount, 2);
  assert.deepEqual(
    { inserted: bid.inserted, updated: bid.updated, failed: bid.failed },
    { inserted: 2, updated: 1, failed: 3 },
  );
  // A failed row is not allowed to vanish: the report is stored partially, and
  // the count is the only thing that makes that visible.
  const run = f.runs.find((r) => r.endpoint === 'bidStats')!;
  assert.equal(run.failed, 3);
  assert.equal(run.inserted, 2);

  // Both source-grain endpoints share one set of stored snapshots, so both
  // carry the same counts — splitting them would imply two writes.
  const rej = res.outcomes.find((o) => o.endpoint === 'bidRejections')!;
  assert.deepEqual(
    { inserted: rej.inserted, updated: rej.updated, failed: rej.failed },
    { inserted: 2, updated: 1, failed: 3 },
  );
  assert.equal(res.bidSourcesStored, 3, 'inserted + updated');

  // 11.09 has a fractional part, so dollars is proven rather than assumed.
  assert.equal(res.moneyUnitEvidence, 'proven-dollars');
  assert.equal(run.moneyUnitEvidence, 'proven-dollars');
  assert.equal(res.overall, 'complete');

  // The two source reports were joined into one snapshot per source id.
  assert.equal(f.bidWrites.length, 1);
  assert.equal(f.bidWrites[0]!.length, 2);
});
