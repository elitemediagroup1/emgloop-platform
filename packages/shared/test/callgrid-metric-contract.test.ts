// The canonical metric contract — structural guarantees plus the formulas that
// must never coerce absence into a number.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CALLGRID_METRICS, CALLGRID_UNAVAILABLE_METRICS, metricDefinition, isValidDimensionFor, unavailableReason,
  profitCents, revenuePerBillableCall, profitPerBillableCall, billableRate, share,
  sourceWinRate, absoluteChange, percentageChange, contributionToChange, shareChangePoints,
  sumReported, coverage, classifyValue,
} from '../src/index';

// --- Registry integrity -------------------------------------------------------

test('every required metric is declared exactly once', () => {
  const required = [
    // Call performance
    'revenue', 'profit', 'billableCalls', 'totalCalls',
    'revenuePerBillableCall', 'profitPerBillableCall', 'billableRate', 'revenueShare', 'callShare',
    // Entity counts
    'totalBuyers', 'activeBuyers', 'totalVendors', 'activeVendors',
    'totalSources', 'activeSources', 'totalCampaigns', 'activeCampaigns',
    // Bid source grain
    'bidOpportunities', 'bidsSubmitted', 'bidsWon', 'rejectedOpportunities',
    'sourceWinRate', 'sourceRejectRate', 'failedAcceptance', 'duplicateBids',
    'closedTarget', 'pausedTarget', 'failedTagRules', 'duplicateCaller', 'callerIdRejected',
    // Bid destination grain
    'destinationAccepted', 'destinationRateLimited', 'destinationTimedOut',
    'destinationBelowMinimumRevenue', 'destinationFailedTagRules', 'destinationApiFailed',
    'destinationSuppressed', 'destinationInvalidNumber', 'destinationMissingAmount',
    // Trend
    'absoluteChange', 'percentageChange', 'shareChange', 'rankChange',
    'concentrationChange', 'contributionToChange',
  ];
  for (const key of required) {
    assert.ok(metricDefinition(key), `missing metric definition: ${key}`);
  }
  const keys = CALLGRID_METRICS.map((m) => m.metricKey);
  assert.equal(new Set(keys).size, keys.length, 'duplicate metricKey in the registry');
});

test('every definition carries its provenance, formula version and truth semantics', () => {
  for (const m of CALLGRID_METRICS) {
    assert.ok(m.providerSource.length > 0, `${m.metricKey}: providerSource`);
    assert.match(m.formulaVersion, /^v\d+$/, `${m.metricKey}: formulaVersion`);
    assert.ok(m.formula.length > 0, `${m.metricKey}: formula`);
    assert.ok(m.zeroSemantics.length > 0, `${m.metricKey}: zeroSemantics`);
    assert.ok(m.unknownSemantics.length > 0, `${m.metricKey}: unknownSemantics`);
    assert.ok(m.unavailableSemantics.length > 0, `${m.metricKey}: unavailableSemantics`);
    assert.ok(m.completenessRule.length > 0, `${m.metricKey}: completenessRule`);
    assert.ok(m.grain.length > 0, `${m.metricKey}: grain`);
  }
});

test('bid source and bid destination metrics never share a grain', () => {
  for (const m of CALLGRID_METRICS) {
    const isSource = m.grain.includes('bid_source');
    const isDest = m.grain.includes('bid_destination');
    assert.ok(!(isSource && isDest), `${m.metricKey} spans both bid grains`);
    if (isSource || isDest) {
      assert.ok(
        m.invalidCrossGrainUses.length > 0,
        `${m.metricKey} must state what combining it across grains would be`,
      );
    }
  }
});

test('source win rate is defined as won / submitted bids, never won / opportunities', () => {
  const def = metricDefinition('sourceWinRate')!;
  assert.equal(def.formula, 'won / bids');
  assert.ok(def.invalidCrossGrainUses.some((u) => /NEVER won \/ total/.test(u)));
});

test('snapshot-grain metrics declare that they cannot honor an arbitrary window', () => {
  for (const key of ['bidOpportunities', 'destinationAccepted', 'sourceWinRate']) {
    const def = metricDefinition(key)!;
    assert.equal(def.dateWindowSupport, 'latest_snapshot_only', key);
    assert.equal(def.comparisonSupport, 'snapshot_only', key);
  }
});

test('call metrics support arbitrary elapsed-matched windows', () => {
  for (const key of ['revenue', 'profit', 'billableCalls', 'totalCalls']) {
    const def = metricDefinition(key)!;
    assert.equal(def.dateWindowSupport, 'arbitrary_window', key);
    assert.equal(def.comparisonSupport, 'elapsed_matched', key);
  }
});

test('entity counts disclose that no roster is exposed, so "total" means observed', () => {
  for (const key of ['totalBuyers', 'totalVendors', 'totalSources', 'totalCampaigns']) {
    const def = metricDefinition(key)!;
    assert.match(def.completenessRule, /no roster/i, key);
  }
});

test('profit declares that partial payout or cost coverage overstates it', () => {
  assert.match(metricDefinition('profit')!.completenessRule, /WEAKEST|OVERSTATES/);
});

test('billable rate is never allowed to be described as call quality', () => {
  assert.ok(metricDefinition('billableRate')!.invalidCrossGrainUses.some((u) => /QUALITY/.test(u)));
});

test('contribution to change explicitly forbids claiming causation', () => {
  assert.ok(
    metricDefinition('contributionToChange')!.invalidCrossGrainUses.some((u) => /not causation/i.test(u)),
  );
});

test('total calls may not be used as a bid denominator', () => {
  assert.ok(metricDefinition('totalCalls')!.invalidCrossGrainUses.some((u) => /denominator/i.test(u)));
});

test('isValidDimensionFor rejects a grain the metric does not support', () => {
  assert.equal(isValidDimensionFor('revenue', 'buyer'), true);
  assert.equal(isValidDimensionFor('revenue', 'bid_destination'), false);
  assert.equal(isValidDimensionFor('destinationAccepted', 'buyer'), false);
  assert.equal(isValidDimensionFor('nonexistent', 'window'), false);
});

test('metrics the provider cannot supply are declared with a stated reason', () => {
  for (const key of ['volatility', 'consecutiveDirectionDays', 'buyerCapacity', 'bidOpportunityValue', 'bidHistory']) {
    const reason = unavailableReason(key);
    assert.ok(reason && reason.length > 20, `${key} needs an explanation, not a blank`);
  }
  assert.equal(unavailableReason('revenue'), null);
  assert.ok(CALLGRID_UNAVAILABLE_METRICS.every((m) => m.displayName.length > 0));
});

// --- Formulas: absence must survive, never become a number --------------------

test('profit is unknown when revenue is unknown, never a negative made of costs', () => {
  assert.equal(profitCents(null, 5000, 1000), null);
  assert.equal(profitCents(10000, 5000, 1000), 4000);
  assert.equal(profitCents(0, 0, 0), 0); // a proven zero survives
});

test('per-billable-call metrics are unknown without a billable denominator', () => {
  assert.equal(revenuePerBillableCall(10000, 0), null);
  assert.equal(revenuePerBillableCall(null, 5), null);
  assert.equal(revenuePerBillableCall(10000, 4), 2500);
  assert.equal(profitPerBillableCall(null, 5), null);
  assert.equal(profitPerBillableCall(1000, 0), null);
  assert.equal(profitPerBillableCall(1000, 4), 250);
});

test('billable rate is unknown with no calls, and a true zero with no billables', () => {
  assert.equal(billableRate(0, 0), null);
  assert.equal(billableRate(0, 10), 0);
  assert.equal(billableRate(3, 12), 0.25);
});

test('share is unknown when the whole is zero or unknown', () => {
  assert.equal(share(5, 0), null);
  assert.equal(share(5, null), null);
  assert.equal(share(null, 10), null);
  assert.equal(share(5, 20), 0.25);
});

test('source win rate uses submitted bids and is unknown when none were submitted', () => {
  assert.equal(sourceWinRate(3, 12), 0.25);
  assert.equal(sourceWinRate(3, 0), null);
  assert.equal(sourceWinRate(null, 12), null);
  // The classic defect: 3 wins from 12 bids out of 100 opportunities is 25%, not 3%.
  assert.notEqual(sourceWinRate(3, 12), 3 / 100);
});

test('percentage change is unknown against a zero or unknown baseline', () => {
  assert.equal(percentageChange(100, 0), null); // never "infinite growth"
  assert.equal(percentageChange(100, null), null);
  assert.equal(percentageChange(null, 100), null);
  assert.equal(percentageChange(75, 100), -0.25);
  assert.equal(absoluteChange(75, 100), -25);
  assert.equal(absoluteChange(75, null), null);
});

test('contribution to change is unknown when the window did not move', () => {
  assert.equal(contributionToChange(-500, 0), null);
  assert.equal(contributionToChange(-500, null), null);
  assert.equal(contributionToChange(-620, -1000), 0.62);
});

test('share change is expressed in percentage points, not a percentage of a percentage', () => {
  assert.ok(Math.abs(shareChangePoints(0.42, 0.3)! - 12) < 1e-9); // 12 points, not 40%
  assert.ok(Math.abs(shareChangePoints(0.3, 0.42)! + 12) < 1e-9);
  assert.equal(shareChangePoints(null, 0.3), null);
});

test('sumReported distinguishes "all reported zero" from "nobody reported"', () => {
  const none = sumReported([{ v: null }, { v: null }], (r) => r.v);
  assert.equal(none.total, null); // NOT 0
  assert.equal(none.reported, 0);
  assert.equal(none.of, 2);

  const zeros = sumReported([{ v: 0 }, { v: 0 }], (r) => r.v);
  assert.equal(zeros.total, 0); // a proven zero
  assert.equal(zeros.reported, 2);

  const partial = sumReported([{ v: 5 }, { v: null }, { v: 7 }], (r) => r.v);
  assert.equal(partial.total, 12);
  assert.equal(partial.reported, 2);
  assert.equal(partial.of, 3); // caller can disclose 2-of-3 coverage
});

test('sumReported ignores non-finite values rather than propagating NaN', () => {
  const r = sumReported([{ v: Number.NaN }, { v: 4 }], (r) => r.v);
  assert.equal(r.total, 4);
  assert.equal(r.reported, 1);
});

test('coverage is unknown with nothing to cover', () => {
  assert.equal(coverage(0, 0), null);
  assert.equal(coverage(3, 12), 0.25);
});

test('classification degrades to UNAVAILABLE on a failed read and UNKNOWN on absence', () => {
  assert.equal(classifyValue(10, false, 'VERIFIED'), 'UNAVAILABLE');
  assert.equal(classifyValue(null, true, 'VERIFIED'), 'UNKNOWN');
  assert.equal(classifyValue(10, true, 'VERIFIED'), 'VERIFIED');
  assert.equal(classifyValue(10, true, 'DERIVED'), 'DERIVED');
  assert.equal(classifyValue(0, true, 'DERIVED'), 'DERIVED'); // a proven zero keeps its class
});
