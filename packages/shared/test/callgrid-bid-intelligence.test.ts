// Bid intelligence — grain separation, classification honesty, deterministic
// review ordering, and the claims that may never be made from count-only data.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeBids, analyzeBidSnapshotChange, scoreReviewPriority, rejectionClassification,
  BID_REJECTION_CLASSIFICATIONS, BID_PRIORITY_FORMULA_VERSION,
  allFindingViolations, isSafeRecommendation, FORBIDDEN_RECOMMENDATION_VERBS,
  type BidIntelligenceInput, type BidSourceInput, type BidDestinationInput,
} from '../src/index';

const NOW = new Date('2026-07-22T18:30:00.000Z');

function source(key: string, over: Partial<BidSourceInput> = {}): BidSourceInput {
  return {
    key, name: key.toUpperCase(),
    total: 1000, bids: 800, won: 200, rejected: 200, rejectRatePct: 20,
    rejections: {
      failedAcceptance: 10, duplicateBids: 10, closed: 10, paused: 10,
      failedTagRules: 10, duplicateCaller: 10, callerIdRejected: 10,
    },
    ...over,
  };
}

function dest(key: string, over: Partial<BidDestinationInput> = {}): BidDestinationInput {
  return {
    key, name: key.toUpperCase(),
    accepted: 500, rateLimited: 10, pingTimeout: 10, minRevenue: 10,
    failedTagRules: 10, failedAcceptance: 10, apiFailed: 10, suppressed: 10,
    invalidNumber: 10, missingAmount: 10,
    ...over,
  };
}

function input(over: Partial<BidIntelligenceInput> = {}): BidIntelligenceInput {
  return {
    now: NOW,
    ok: true,
    hasData: true,
    fetchedAt: new Date('2026-07-22T06:00:00.000Z'),
    reportTimezone: 'UTC',
    snapshot: {
      windowStart: new Date('2026-07-21T00:00:00.000Z'),
      windowEnd: new Date('2026-07-22T00:00:00.000Z'),
      sources: [source('alpha'), source('beta')],
      destinations: [dest('north'), dest('south')],
    },
    prior: null,
    selectedPeriodLabel: 'Today · Live',
    matchesSelectedPeriod: false,
    ...over,
  };
}

// --- Classification registry ---------------------------------------------------

test('every rejection classification is complete and versioned', () => {
  for (const c of BID_REJECTION_CLASSIFICATIONS) {
    assert.ok(c.operationalMeaning.length > 30, `${c.key}: operationalMeaning`);
    assert.ok(c.requiredEvidence.length > 10, `${c.key}: requiredEvidence`);
    assert.ok(c.unsafeClaims.length > 0, `${c.key} must name what would be an unsafe claim`);
    assert.match(c.ruleVersion, /^v\d+$/, c.key);
    assert.ok(isSafeRecommendation(c.safeRecommendation), `${c.key}: "${c.safeRecommendation}"`);
  }
});

test('closed and paused targets are classified as expected configuration, not failures', () => {
  for (const key of ['closed', 'paused']) {
    const c = rejectionClassification(key)!;
    assert.equal(c.category, 'EXPECTED_CONFIGURATION', key);
    assert.equal(c.preventability, 'EXPECTED', key);
    assert.ok(c.unsafeClaims.some((u) => /system failure/i.test(u)), key);
  }
});

test('API failures are possibly preventable, never guaranteed preventable', () => {
  const c = rejectionClassification('apiFailed')!;
  assert.equal(c.category, 'POTENTIALLY_PREVENTABLE');
  assert.equal(c.preventability, 'POSSIBLY_PREVENTABLE');
  assert.ok(c.unsafeClaims.some((u) => /guarantee/i.test(u)));
});

test('suppression is UNKNOWN because the provider does not document it', () => {
  const c = rejectionClassification('suppressed')!;
  assert.equal(c.category, 'UNKNOWN');
  assert.equal(c.preventability, 'NOT_DETERMINABLE');
});

test('duplicate bids and duplicate callers are distinct and never summed', () => {
  const bids = rejectionClassification('duplicateBids')!;
  const caller = rejectionClassification('duplicateCaller')!;
  assert.notEqual(bids.providerField, caller.providerField);
  assert.ok(bids.unsafeClaims.some((u) => /Summing with duplicate-caller/i.test(u)));
  assert.ok(caller.unsafeClaims.some((u) => /Summing with duplicate-bid/i.test(u)));
});

test('rate limiting names throughput and alternate routing as what must be confirmed', () => {
  const c = rejectionClassification('rateLimited')!;
  assert.match(c.safeRecommendation, /throughput limit/);
  assert.match(c.safeRecommendation, /alternate routing/);
  assert.ok(c.unsafeClaims.some((u) => /cap be raised/i.test(u)));
  assert.ok(c.unsafeClaims.some((u) => /revenue/i.test(u)));
});

// --- Grain separation ------------------------------------------------------------

test('source and destination findings never share a grain or a denominator', () => {
  const r = analyzeBids(input());
  for (const f of r.findings) {
    const grains = new Set(f.supportingEvidence.map((e) => e.entityType));
    assert.ok(
      !(grains.has('bid_source') && grains.has('bid_destination')),
      `${f.id} mixes grains in its evidence`,
    );
  }
  // Every share is computed within its own grain, and says so.
  const shares = r.findings.flatMap((f) => f.supportingEvidence).filter((e) => e.metricKey === 'shareOfGrain');
  assert.ok(shares.length > 0);
  for (const e of shares) {
    assert.match(e.notes ?? '', /denominator is this grain only/);
  }
});

test('accepted destinations are never presented as a total-pings denominator', () => {
  const r = analyzeBids(input({
    snapshot: {
      windowStart: new Date('2026-07-21T00:00:00.000Z'),
      windowEnd: new Date('2026-07-22T00:00:00.000Z'),
      sources: [source('alpha'), source('beta')],
      destinations: [dest('north', { accepted: 900 }), dest('south', { accepted: 100 })],
    },
  }));
  const conc = r.findings.find((f) => f.id === 'bid:concentration:accepted');
  assert.ok(conc);
  assert.ok(conc!.limitations.some((l) => /not a complete funnel denominator/i.test(l)));
  assert.ok(r.unknowns.some((u) => u.id === 'bid-unknown:accepted-denominator'));
  for (const f of r.findings) {
    assert.doesNotMatch(`${f.title} ${f.plainLanguageSummary}`, /total pings/i, f.id);
  }
});

// --- No fabricated revenue or configuration claims -----------------------------------

test('no bid finding estimates revenue, a bid price, or a capacity change', () => {
  const r = analyzeBids(input({
    snapshot: {
      windowStart: new Date('2026-07-21T00:00:00.000Z'),
      windowEnd: new Date('2026-07-22T00:00:00.000Z'),
      sources: [source('alpha')],
      destinations: [dest('abc', { rateLimited: 7921 }), dest('south')],
    },
  }));
  assert.ok(r.findings.length > 0);
  for (const f of r.findings) {
    const text = `${f.title} ${f.plainLanguageSummary} ${f.recommendedReview ?? ''}`;
    assert.doesNotMatch(text, /\$\d/, `${f.id} states a monetary amount: ${text}`);
    assert.doesNotMatch(text, /recover|recoverable|lost revenue|raise the (cap|bid)|increase the (cap|bid)/i, f.id);
  }
  assert.ok(r.unknowns.some((u) => u.id === 'bid-unknown:revenue'));
});

test('a rate-limited finding discloses that recoverability is unknown', () => {
  const r = analyzeBids(input({
    snapshot: {
      windowStart: new Date('2026-07-21T00:00:00.000Z'),
      windowEnd: new Date('2026-07-22T00:00:00.000Z'),
      sources: [source('alpha')],
      destinations: [dest('abc', { rateLimited: 7921 }), dest('south', { rateLimited: 5 })],
    },
  }));
  const f = r.findings.find((x) => x.id === 'bid:bid_destination:rateLimited');
  assert.ok(f);
  assert.equal(f!.affectedEntities[0]!.entityName, 'ABC'); // identifies where
  assert.ok(f!.unknowns.some((u) => /throughput limit|contractual/i.test(u)));
  assert.ok(f!.unknowns.some((u) => /no revenue/i.test(u)));
  assert.match(f!.recommendedReview!, /^Confirm/);
});

test('a timeout finding identifies the destination', () => {
  const r = analyzeBids(input({
    snapshot: {
      windowStart: new Date('2026-07-21T00:00:00.000Z'),
      windowEnd: new Date('2026-07-22T00:00:00.000Z'),
      sources: [source('alpha')],
      destinations: [dest('slowone', { pingTimeout: 4000 }), dest('south', { pingTimeout: 1 })],
    },
  }));
  const f = r.findings.find((x) => x.id === 'bid:bid_destination:pingTimeout');
  assert.ok(f);
  assert.equal(f!.affectedEntities[0]!.entityName, 'SLOWONE');
});

test('every bid finding is well-formed and safely worded', () => {
  const r = analyzeBids(input());
  assert.deepEqual(allFindingViolations(r.findings), []);
  for (const f of r.findings) {
    if (!f.recommendedReview) continue;
    assert.ok(isSafeRecommendation(f.recommendedReview), f.id);
    for (const verb of FORBIDDEN_RECOMMENDATION_VERBS) {
      assert.doesNotMatch(f.recommendedReview, new RegExp(`^${verb}\\b`), f.id);
    }
  }
});

// --- Win rate --------------------------------------------------------------------------

test('win rate uses submitted bids and suppresses tiny samples', () => {
  const r = analyzeBids(input({
    snapshot: {
      windowStart: new Date('2026-07-21T00:00:00.000Z'),
      windowEnd: new Date('2026-07-22T00:00:00.000Z'),
      sources: [
        source('winner', { total: 1000, bids: 400, won: 200 }), // 50%
        source('loser', { total: 1000, bids: 400, won: 40 }),   // 10%
        source('tiny', { total: 10, bids: 3, won: 3 }),         // 100% on 3 bids — must not rank
      ],
      destinations: [dest('north')],
    },
  }));
  const highest = r.findings.find((f) => f.id.startsWith('bid:winrate:highest'));
  const lowest = r.findings.find((f) => f.id.startsWith('bid:winrate:lowest'));
  assert.ok(highest && lowest);
  assert.match(highest!.id, /winner/);
  assert.match(lowest!.id, /loser/);
  assert.equal(highest!.currentValue, 0.5); // 200/400, not 200/1000
  assert.ok(highest!.supportingEvidence.some((e) => /NOT the denominator/.test(e.notes ?? '')));
});

test('a highest rejection COUNT is never described as the worst rate or worst quality', () => {
  const r = analyzeBids(input());
  for (const f of r.findings) {
    const text = `${f.title} ${f.plainLanguageSummary}`;
    assert.doesNotMatch(text, /worst (rate|quality)|low.?quality|bad source/i, f.id);
  }
});

// --- Missing data ----------------------------------------------------------------------

test('a field no destination reported is absent, never summed as zero', () => {
  const r = analyzeBids(input({
    snapshot: {
      windowStart: new Date('2026-07-21T00:00:00.000Z'),
      windowEnd: new Date('2026-07-22T00:00:00.000Z'),
      sources: [source('alpha')],
      destinations: [dest('north', { apiFailed: null }), dest('south', { apiFailed: null })],
    },
  }));
  assert.equal(r.findings.filter((f) => f.id === 'bid:bid_destination:apiFailed').length, 0);
});

test('partial reporting is disclosed on the finding rather than silently totalled', () => {
  const r = analyzeBids(input({
    snapshot: {
      windowStart: new Date('2026-07-21T00:00:00.000Z'),
      windowEnd: new Date('2026-07-22T00:00:00.000Z'),
      sources: [source('alpha')],
      destinations: [dest('north', { rateLimited: 900 }), dest('south', { rateLimited: null })],
    },
  }));
  const f = r.findings.find((x) => x.id === 'bid:bid_destination:rateLimited');
  assert.ok(f);
  assert.ok(f!.limitations.some((l) => /1 of 2 destinations/.test(l)));
  assert.ok(f!.supportingEvidence.some((e) => /not counted as zero/.test(e.notes ?? '')));
});

test('an unreadable or unsynchronized snapshot produces no findings and says why', () => {
  const failed = analyzeBids(input({ ok: false }));
  assert.equal(failed.findings.length, 0);
  assert.match(failed.headline, /could not be read/);

  const empty = analyzeBids(input({ hasData: false, snapshot: null }));
  assert.equal(empty.findings.length, 0);
  assert.match(empty.headline, /No bid report data has been synchronized/);
});

// --- Snapshot grain honesty ---------------------------------------------------------------

test('bid findings always disclose that they do not honor the selected period', () => {
  const r = analyzeBids(input({ selectedPeriodLabel: 'Jul 1–7, 2026' }));
  assert.ok(r.unknowns.some((u) => u.id === 'bid-unknown:period' && /Jul 1–7, 2026/.test(u.statement)));
  for (const f of r.findings) {
    assert.ok(f.limitations.some((l) => /snapshot-only/i.test(l)), f.id);
  }
});

test('no historical comparison appears when no prior snapshot exists', () => {
  const r = analyzeBids(input());
  assert.equal(analyzeBidSnapshotChange(input()).length, 0);
  assert.ok(r.unknowns.some((u) => u.id === 'bid-unknown:history'));
  for (const f of r.findings) {
    assert.equal(f.comparisonWindow, null, `${f.id} invented a comparison window`);
  }
});

test('a change finding appears only when a genuinely earlier snapshot is stored', () => {
  const withPrior = input({
    prior: {
      windowStart: new Date('2026-07-20T00:00:00.000Z'),
      windowEnd: new Date('2026-07-21T00:00:00.000Z'),
      sources: [source('alpha')],
      destinations: [dest('north', { rateLimited: 100 }), dest('south', { rateLimited: 100 })],
    },
    snapshot: {
      windowStart: new Date('2026-07-21T00:00:00.000Z'),
      windowEnd: new Date('2026-07-22T00:00:00.000Z'),
      sources: [source('alpha')],
      destinations: [dest('north', { rateLimited: 500 }), dest('south', { rateLimited: 500 })],
    },
  });
  const changes = analyzeBidSnapshotChange(withPrior);
  const rl = changes.find((f) => f.id === 'bid:change:rateLimited');
  assert.ok(rl, 'expected a rate-limit change between two stored snapshots');
  assert.equal(rl!.currentValue, 1000);
  assert.equal(rl!.comparisonValue, 200);
  assert.ok(rl!.limitations.some((l) => /may differ in length/.test(l)));

  // Identical snapshot windows are not a comparison.
  assert.equal(analyzeBidSnapshotChange({ ...withPrior, prior: withPrior.snapshot }).length, 0);
});

// --- Review priority ----------------------------------------------------------------------

test('review priority is deterministic, versioned, and orders by review need', () => {
  const preventable = scoreReviewPriority({
    eventCount: 5000, shareOfGrain: 0.4, preventability: 'POSSIBLY_PREVENTABLE',
    affectedEntities: 3, completeness: 1, snapshotAgeDays: 0,
  });
  const expected = scoreReviewPriority({
    eventCount: 5000, shareOfGrain: 0.4, preventability: 'EXPECTED',
    affectedEntities: 3, completeness: 1, snapshotAgeDays: 0,
  });
  // Same volume and share: the possibly-preventable one must rank higher.
  assert.ok(preventable.score > expected.score);
  assert.equal(preventable.formulaVersion, BID_PRIORITY_FORMULA_VERSION);
  assert.deepEqual(preventable, scoreReviewPriority({
    eventCount: 5000, shareOfGrain: 0.4, preventability: 'POSSIBLY_PREVENTABLE',
    affectedEntities: 3, completeness: 1, snapshotAgeDays: 0,
  }));
  assert.ok(preventable.components.length >= 5);
});

test('review priority never expresses a revenue or monetary value', () => {
  const r = scoreReviewPriority({
    eventCount: 100000, shareOfGrain: 1, preventability: 'POSSIBLY_PREVENTABLE',
    affectedEntities: 10, completeness: 1, snapshotAgeDays: 0,
  });
  assert.ok(r.score <= 100, 'the score is a bounded ordering index, not an amount');
  for (const c of r.components) {
    assert.doesNotMatch(c.label, /revenue|\$|value|cost/i);
  }
});

test('partial reporting and a stale snapshot both reduce priority', () => {
  const base = { eventCount: 5000, shareOfGrain: 0.4, preventability: 'POSSIBLY_PREVENTABLE' as const, affectedEntities: 3 };
  const full = scoreReviewPriority({ ...base, completeness: 1, snapshotAgeDays: 0 });
  const partial = scoreReviewPriority({ ...base, completeness: 0.5, snapshotAgeDays: 0 });
  const stale = scoreReviewPriority({ ...base, completeness: 1, snapshotAgeDays: 10 });
  assert.ok(partial.score < full.score);
  assert.ok(stale.score < full.score);
});

test('the review queue sorts deterministically by score', () => {
  const r = analyzeBids(input({
    snapshot: {
      windowStart: new Date('2026-07-21T00:00:00.000Z'),
      windowEnd: new Date('2026-07-22T00:00:00.000Z'),
      sources: [source('alpha', { rejections: { ...source('alpha').rejections, closed: 5000 } })],
      destinations: [dest('north', { rateLimited: 4000 })],
    },
  }));
  const scores = r.priorityQueue.map((q) => q.score);
  assert.deepEqual(scores, [...scores].sort((a, b) => b - a));
  // Re-running produces the same order.
  assert.deepEqual(
    r.priorityQueue.map((q) => q.id),
    analyzeBids(input({
      snapshot: {
        windowStart: new Date('2026-07-21T00:00:00.000Z'),
        windowEnd: new Date('2026-07-22T00:00:00.000Z'),
        sources: [source('alpha', { rejections: { ...source('alpha').rejections, closed: 5000 } })],
        destinations: [dest('north', { rateLimited: 4000 })],
      },
    })).priorityQueue.map((q) => q.id),
  );
});

test('an expected-configuration category does not outrank a preventable one at equal share', () => {
  const r = analyzeBids(input({
    snapshot: {
      windowStart: new Date('2026-07-21T00:00:00.000Z'),
      windowEnd: new Date('2026-07-22T00:00:00.000Z'),
      // Closed target (expected) dwarfs everything else at source grain;
      // rate limiting (preventable) dominates destination grain by the same share.
      sources: [source('alpha', { rejections: { failedAcceptance: 0, duplicateBids: 0, closed: 4000, paused: 0, failedTagRules: 0, duplicateCaller: 0, callerIdRejected: 0 } })],
      destinations: [dest('north', { accepted: 0, rateLimited: 4000, pingTimeout: 0, minRevenue: 0, failedTagRules: 0, failedAcceptance: 0, apiFailed: 0, suppressed: 0, invalidNumber: 0, missingAmount: 0 })],
    },
  }));
  const closed = r.priorityQueue.find((q) => q.issue === 'Closed Target')!;
  const rateLimited = r.priorityQueue.find((q) => q.issue === 'Rate Limited')!;
  assert.ok(rateLimited.score > closed.score, 'a possible fault must outrank configuration behaving as configured');
  assert.equal(closed.category, 'EXPECTED_CONFIGURATION');
  assert.equal(rateLimited.category, 'POTENTIALLY_PREVENTABLE');
});

test('the headline names the largest issue and whether it is expected', () => {
  const r = analyzeBids(input({
    snapshot: {
      windowStart: new Date('2026-07-21T00:00:00.000Z'),
      windowEnd: new Date('2026-07-22T00:00:00.000Z'),
      sources: [source('alpha')],
      destinations: [dest('abc', { rateLimited: 7921 })],
    },
  }));
  assert.match(r.headline, /Rate Limited/);
  assert.match(r.headline, /ABC/);
  assert.match(r.headline, /not visible to Loop/);
});
