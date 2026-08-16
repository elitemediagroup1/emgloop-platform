// The Stage 3 measurement layer and the one materiality rule.
//
// The properties these tests exist to hold, in order of how badly they would hurt
// if they broke:
//
//   1. SPARSITY. Twenty ordinary calls must produce nothing. If this collapses,
//      Headlines become "everything Loop could compute", which is the thing the
//      whole stage exists to not be.
//   2. NULL IS NOT ZERO, AND A ZERO DENOMINATOR IS NOT 0%. An absent measurement
//      and a measured zero are opposite claims about the world.
//   3. THE THRESHOLDS ARE INHERITED, NOT INVENTED. Every number must still match
//      the approved CallGrid significance rule it was copied from.
//   4. COMPLETE PERIODS ONLY. A partial window can never enter a comparison.
//   5. IDENTITY IS TIMESTAMP-FREE. The same development next period must land on
//      the same key.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CI_MATERIALITY_RULE_ID,
  CI_MATERIALITY_RULE_VERSION,
  COMPARISON_SPAN_DAYS,
  composeStatement,
  describeThreshold,
  formatValue,
  materialityThreshold,
  measureChange,
  measureWindow,
  type PopulationWindowAggregate,
} from '../src/commercial-measurement';
import { CALLGRID_SIGNIFICANCE_RULES } from '../src/callgrid-intelligence';
import {
  easternTrailingCompleteWindows,
  startOfEasternDay,
} from '../src/business-time';
import { headlineDetectionKey, headlineRecurrenceKey } from '../src/headline';
import { describePopulation, validateBindingShape } from '../src/objective-measure-binding';

// --- Fixtures -------------------------------------------------------------------

function agg(over: Partial<PopulationWindowAggregate> = {}): PopulationWindowAggregate {
  return {
    totalCalls: 100,
    revenueCents: 1_000_000,
    revenueReported: 100,
    monetizedTrue: 40,
    monetizedReported: 100,
    convertedTrue: 20,
    convertedReported: 100,
    noRouteTrue: 3,
    noRouteReported: 100,
    ...over,
  };
}

const WINDOWS = easternTrailingCompleteWindows(new Date('2026-08-16T14:30:00Z'), COMPARISON_SPAN_DAYS);

function change(
  metric: Parameters<typeof measureChange>[0]['metric'],
  current: PopulationWindowAggregate,
  prior: PopulationWindowAggregate,
  direction: 'HIGHER_IS_BETTER' | 'LOWER_IS_BETTER' = 'HIGHER_IS_BETTER',
) {
  return measureChange({
    metric,
    direction,
    current,
    prior,
    currentWindow: WINDOWS.current,
    priorWindow: WINDOWS.prior,
  });
}

// --- 1. Sparsity: the acceptance invariant ---------------------------------------

test('twenty ordinary calls produce no material development, for any metric', () => {
  // Twenty calls behaving exactly as before. This is THE acceptance test for the
  // whole stage: measurement being possible is not a reason to tell anybody.
  const ordinary = agg({
    totalCalls: 20,
    revenueCents: 200_000,
    revenueReported: 20,
    monetizedTrue: 8,
    monetizedReported: 20,
    convertedTrue: 4,
    convertedReported: 20,
    noRouteTrue: 1,
    noRouteReported: 20,
  });

  for (const metric of ['CALL_VOLUME', 'REVENUE', 'MONETIZED_RATE', 'CONVERSION_RATE', 'NO_ROUTE_RATE'] as const) {
    const r = change(metric, ordinary, ordinary);
    assert.equal(r.material, false, `${metric} must not be material`);
    assert.ok(r.withheld, `${metric} must say why it stayed silent`);
  }
});

test('an identical week over an identical week is never material', () => {
  const r = change('REVENUE', agg(), agg());
  assert.equal(r.material, false);
  assert.equal(r.withheld, 'BELOW_THRESHOLD');
  assert.equal(r.absoluteChange, 0);
  assert.equal(r.percentageChange, 0);
  assert.equal(r.movement, null);
});

test('a large percentage on a tiny base stays quiet', () => {
  // Revenue tripled — but on $60 over 12 calls. Both thresholds must pass, which
  // is exactly why revenue-change pairs a percentage with an absolute floor.
  const r = change(
    'REVENUE',
    agg({ totalCalls: 14, revenueCents: 18_000, revenueReported: 14 }),
    agg({ totalCalls: 12, revenueCents: 6_000, revenueReported: 12 }),
  );
  assert.equal(r.material, false);
  assert.equal(r.withheld, 'BELOW_THRESHOLD');
});

test('a move that clears both thresholds IS material', () => {
  const r = change(
    'REVENUE',
    agg({ totalCalls: 120, revenueCents: 700_000, revenueReported: 120 }),
    agg({ totalCalls: 100, revenueCents: 1_000_000, revenueReported: 100 }),
  );
  assert.equal(r.material, true);
  assert.equal(r.withheld, null);
  assert.equal(r.movement, 'DECREASE');
  assert.equal(r.absoluteChange, -300_000);
  assert.ok(r.percentageChange !== null && Math.abs(r.percentageChange + 0.3) < 1e-9);
});

// --- 2. Null is not zero ---------------------------------------------------------

test('a metric nobody reported is UNKNOWN, never zero', () => {
  const v = measureWindow('REVENUE', agg({ revenueCents: null, revenueReported: 0 }));
  assert.equal(v.value, null);
  assert.ok(v.unknownReason);
  assert.match(v.unknownReason, /No call in this period reported a revenue value/);
});

test('a rate with no denominator is UNKNOWN, never 0%', () => {
  const v = measureWindow('CONVERSION_RATE', agg({ convertedTrue: 0, convertedReported: 0 }));
  assert.equal(v.value, null);
  assert.equal(v.denominator, 0);
  assert.ok(v.unknownReason);
  assert.match(v.unknownReason, /no denominator/);
});

test('a rate divides by the calls that CARRIED the flag, not by every call', () => {
  // 10 converted out of 40 that reported = 25%. Dividing by all 100 would report
  // 10% and would be counting silence as a failure to convert.
  const v = measureWindow('CONVERSION_RATE', agg({ totalCalls: 100, convertedTrue: 10, convertedReported: 40 }));
  assert.equal(v.value, 0.25);
  assert.equal(v.denominator, 40);
  assert.equal(v.coverage, 0.4);
});

test('an unmeasurable side withholds the whole comparison and says so', () => {
  const r = change(
    'REVENUE',
    agg({ totalCalls: 100, revenueCents: null, revenueReported: 0 }),
    agg({ totalCalls: 100 }),
  );
  assert.equal(r.material, false);
  assert.equal(r.withheld, 'VALUE_UNKNOWN');
  assert.ok(r.unknowns.some((u) => u.startsWith('Current period:')));
});

test('a zero baseline produces NO_BASELINE rather than an infinite percentage', () => {
  const r = change(
    'REVENUE',
    agg({ totalCalls: 100, revenueCents: 900_000, revenueReported: 100 }),
    agg({ totalCalls: 100, revenueCents: 0, revenueReported: 100 }),
  );
  assert.equal(r.percentageChange, null);
  assert.equal(r.material, false);
  assert.equal(r.withheld, 'NO_BASELINE');
});

test('a call count has no coverage concept, and does not pretend to', () => {
  const v = measureWindow('CALL_VOLUME', agg({ totalCalls: 42 }));
  assert.equal(v.value, 42);
  assert.equal(v.coverage, null);
});

// --- 3. Coverage and sample guards ------------------------------------------------

test('partial coverage withholds the conclusion and states the caveat', () => {
  const r = change(
    'REVENUE',
    // 30 of 100 calls priced. The total is a lower bound, not a measurement.
    agg({ totalCalls: 100, revenueCents: 400_000, revenueReported: 30 }),
    agg({ totalCalls: 100, revenueCents: 1_000_000, revenueReported: 100 }),
  );
  assert.equal(r.material, false);
  assert.equal(r.withheld, 'INSUFFICIENT_COVERAGE');
  assert.ok(r.unknowns.some((u) => /lower bounds/.test(u)));
});

test('a thin earlier period withholds, whatever the move looks like', () => {
  const r = change(
    'CALL_VOLUME',
    agg({ totalCalls: 400 }),
    agg({ totalCalls: 3 }),
  );
  assert.equal(r.material, false);
  assert.equal(r.withheld, 'INSUFFICIENT_VOLUME');
});

test('a genuine collapse from a healthy base is NOT suppressed for having few calls left', () => {
  // volume-change requires its minimum in the COMPARISON window only, on purpose:
  // requiring it on both sides would hide exactly the collapses worth knowing.
  const r = change('CALL_VOLUME', agg({ totalCalls: 2 }), agg({ totalCalls: 500 }));
  assert.equal(r.material, true);
  assert.equal(r.movement, 'DECREASE');
});

test('a rate requires its minimum sample in BOTH periods, because it needs two denominators', () => {
  const r = change(
    'MONETIZED_RATE',
    agg({ totalCalls: 12, monetizedTrue: 1, monetizedReported: 12 }),
    agg({ totalCalls: 500, monetizedTrue: 200, monetizedReported: 500 }),
  );
  assert.equal(r.material, false);
  assert.equal(r.withheld, 'INSUFFICIENT_VOLUME');
});

// --- 4. Direction is intent, not judgement ---------------------------------------

test('againstObjective follows the direction a human declared, not the sign', () => {
  const worse = change(
    'NO_ROUTE_RATE',
    agg({ totalCalls: 200, noRouteTrue: 40, noRouteReported: 200 }),
    agg({ totalCalls: 200, noRouteTrue: 6, noRouteReported: 200 }),
    'LOWER_IS_BETTER',
  );
  assert.equal(worse.material, true);
  assert.equal(worse.movement, 'INCREASE');
  assert.equal(worse.againstObjective, true);

  const better = change(
    'NO_ROUTE_RATE',
    agg({ totalCalls: 200, noRouteTrue: 6, noRouteReported: 200 }),
    agg({ totalCalls: 200, noRouteTrue: 40, noRouteReported: 200 }),
    'LOWER_IS_BETTER',
  );
  assert.equal(better.movement, 'DECREASE');
  assert.equal(better.againstObjective, false);
});

test('positive news is measured exactly like negative news', () => {
  // The whole reason a Headline is not a Decision: good news must be expressible
  // without a remediation vocabulary.
  const r = change(
    'REVENUE',
    agg({ totalCalls: 150, revenueCents: 1_800_000, revenueReported: 150 }),
    agg({ totalCalls: 100, revenueCents: 1_000_000, revenueReported: 100 }),
  );
  assert.equal(r.material, true);
  assert.equal(r.movement, 'INCREASE');
  assert.equal(r.againstObjective, false);
});

// --- 5. Thresholds are inherited, not invented ------------------------------------

test('every threshold still matches the approved CallGrid significance rule', () => {
  // If someone retunes a CallGrid rule, or quietly retunes a CI one, this fails.
  // The point is that Commercial Intelligence did not get a second opinion about
  // what "material" means.
  const rule = (id: string) => {
    const r = CALLGRID_SIGNIFICANCE_RULES.find((x) => x.ruleId === id);
    assert.ok(r, `${id} must exist`);
    return r;
  };

  const volume = rule('volume-change');
  const t1 = materialityThreshold('CALL_VOLUME');
  assert.equal(t1.relative, volume.percentageThreshold);
  assert.equal(t1.absolute, volume.absoluteThreshold);
  assert.equal(t1.minimumVolume, volume.minimumVolume);

  const revenue = rule('revenue-change');
  const t2 = materialityThreshold('REVENUE');
  assert.equal(t2.relative, revenue.percentageThreshold);
  assert.equal(t2.absolute, revenue.absoluteThreshold);
  assert.equal(t2.minimumVolume, revenue.minimumVolume);

  const efficiency = rule('billable-efficiency');
  for (const metric of ['MONETIZED_RATE', 'CONVERSION_RATE', 'NO_ROUTE_RATE'] as const) {
    const t = materialityThreshold(metric);
    assert.equal(t.relative, efficiency.percentageThreshold, metric);
    assert.equal(t.minimumVolume, efficiency.minimumVolume, metric);
    assert.equal(t.absolute, null, metric);
  }
});

test('the rule states its own threshold in words a reader can check', () => {
  const described = describeThreshold('REVENUE');
  assert.match(described, /at least 10%/);
  assert.match(described, /\$250/);
  assert.match(described, /revenue-change v1/);
});

test('the rule is versioned, so a determination stays interpretable after it changes', () => {
  const r = change('CALL_VOLUME', agg({ totalCalls: 200 }), agg({ totalCalls: 100 }));
  assert.equal(r.ruleId, CI_MATERIALITY_RULE_ID);
  assert.equal(r.ruleVersion, CI_MATERIALITY_RULE_VERSION);
  assert.ok(r.formulaVersion);
});

// --- 6. Complete periods only ------------------------------------------------------

test('the comparison never touches the in-progress day', () => {
  const now = new Date('2026-08-16T18:45:00Z');
  const w = easternTrailingCompleteWindows(now, COMPARISON_SPAN_DAYS);
  const todayStart = startOfEasternDay(now);
  // The current window ENDS at the first instant of today Eastern, exclusive.
  assert.equal(w.current.end.getTime(), todayStart.getTime());
  assert.ok(w.current.end.getTime() <= now.getTime());
  // The two windows are adjacent and equal in span, with no gap and no overlap.
  assert.equal(w.prior.end.getTime(), w.current.start.getTime());
});

test('the windows are DST-safe: seven Eastern days, not 7 x 86400000ms', () => {
  // 2026-11-01 is the US fall-back day and is 25 hours long. Millisecond
  // arithmetic would land an hour off and shift every boundary.
  const now = new Date('2026-11-05T15:00:00Z');
  const w = easternTrailingCompleteWindows(now, 7);
  const naive = w.current.end.getTime() - 7 * 86_400_000;
  assert.notEqual(w.current.start.getTime(), naive);
  // And the two spans still match each other exactly, which is what the
  // comparison depends on.
  const currentSpan = w.current.end.getTime() - w.current.start.getTime();
  const priorSpan = w.prior.end.getTime() - w.prior.start.getTime();
  assert.equal(currentSpan + priorSpan, w.current.end.getTime() - w.prior.start.getTime());
});

// --- 7. Identity is timestamp-free -------------------------------------------------

test('the recurrence key contains no timestamp, so the same development recurs', () => {
  const key = { measureBindingId: 'bind_1', metric: 'REVENUE' as const, ruleId: 'r', movement: 'DECREASE' as const };
  assert.equal(headlineRecurrenceKey(key), headlineRecurrenceKey(key));
  assert.ok(!/\d{4}-\d{2}-\d{2}/.test(headlineRecurrenceKey(key)));
});

test('rose and fell are two different developments, not one row that flips meaning', () => {
  const base = { measureBindingId: 'bind_1', metric: 'REVENUE' as const, ruleId: 'r' };
  assert.notEqual(
    headlineRecurrenceKey({ ...base, movement: 'INCREASE' }),
    headlineRecurrenceKey({ ...base, movement: 'DECREASE' }),
  );
});

test('a superseded binding starts a fresh lineage rather than reinterpreting the old one', () => {
  const base = { metric: 'REVENUE' as const, ruleId: 'r', movement: 'DECREASE' as const };
  assert.notEqual(
    headlineRecurrenceKey({ ...base, measureBindingId: 'bind_1' }),
    headlineRecurrenceKey({ ...base, measureBindingId: 'bind_2' }),
  );
});

test('the detection key identifies the completed period, so a re-run is idempotent', () => {
  const a = headlineDetectionKey(WINDOWS.current.start);
  const b = headlineDetectionKey(WINDOWS.current.start);
  assert.equal(a, b);
  assert.notEqual(a, headlineDetectionKey(WINDOWS.prior.start));
});

// --- 8. The statement is display, and it says only what was measured ---------------

test('the statement names the move and the numbers, and nothing else', () => {
  const r = change(
    'REVENUE',
    agg({ totalCalls: 120, revenueCents: 700_000, revenueReported: 120 }),
    agg({ totalCalls: 100, revenueCents: 1_000_000, revenueReported: 100 }),
  );
  const s = composeStatement(r, { metricLabel: 'Revenue', population: '3 campaigns' });
  assert.match(s, /Revenue fell/);
  assert.match(s, /\$10,000/);
  assert.match(s, /\$7,000/);
  assert.match(s, /3 campaigns/);
  // No cause, no recommendation, no judgement about the business.
  assert.ok(!/because|caused|should|recommend|investigate/i.test(s));
});

test('a value renders in its own unit, and unknown renders as unknown', () => {
  assert.equal(formatValue(1_000_000, 'CENTS'), '$10,000');
  assert.equal(formatValue(0.256, 'RATIO'), '25.6%');
  assert.equal(formatValue(1234, 'COUNT'), '1,234');
  assert.equal(formatValue(null, 'CENTS'), 'unknown');
});

test('limitations travel with every measurement, including the derived-monetized caveat', () => {
  const r = change(
    'MONETIZED_RATE',
    agg({ totalCalls: 200, monetizedTrue: 20, monetizedReported: 200 }),
    agg({ totalCalls: 200, monetizedTrue: 80, monetizedReported: 200 }),
  );
  assert.equal(r.material, true);
  assert.ok(r.limitations.some((l) => /DERIVED BY LOOP/.test(l)));
  assert.ok(r.limitations.some((l) => /never that it met a qualification standard/.test(l)));
});

// --- 9. Purity ----------------------------------------------------------------------

test('the same inputs give the same answer, so a stored headline is reproducible', () => {
  const a = change('CALL_VOLUME', agg({ totalCalls: 200 }), agg({ totalCalls: 100 }));
  const b = change('CALL_VOLUME', agg({ totalCalls: 200 }), agg({ totalCalls: 100 }));
  assert.deepEqual(
    { ...a, currentWindow: null, priorWindow: null },
    { ...b, currentWindow: null, priorWindow: null },
  );
});

// --- 10. The binding contract ---------------------------------------------------------

test('a binding with no selected member is refused: an empty population measures nothing', () => {
  assert.equal(
    validateBindingShape({ metric: 'REVENUE', direction: 'HIGHER_IS_BETTER', members: [] }),
    'POPULATION_REQUIRED',
  );
});

test('a member with no external id is refused, because a label is not an identity', () => {
  assert.equal(
    validateBindingShape({
      metric: 'REVENUE',
      direction: 'HIGHER_IS_BETTER',
      members: [{ dimension: 'CAMPAIGN', externalId: '   ' }],
    }),
    'MEMBER_IDENTITY_REQUIRED',
  );
});

test('there is no VERTICAL dimension, and asking for one is refused', () => {
  assert.equal(
    validateBindingShape({
      metric: 'REVENUE',
      direction: 'HIGHER_IS_BETTER',
      members: [{ dimension: 'VERTICAL', externalId: 'roofing' }],
    }),
    'MEMBER_DIMENSION_INVALID',
  );
});

test('a caller-state restriction must be a state code, and is optional', () => {
  const members = [{ dimension: 'CAMPAIGN', externalId: 'c1' }];
  assert.equal(
    validateBindingShape({ metric: 'REVENUE', direction: 'HIGHER_IS_BETTER', members }),
    null,
    'no restriction is valid',
  );
  assert.equal(
    validateBindingShape({ metric: 'REVENUE', direction: 'HIGHER_IS_BETTER', members, callerStates: ['TX'] }),
    null,
  );
  assert.equal(
    validateBindingShape({ metric: 'REVENUE', direction: 'HIGHER_IS_BETTER', members, callerStates: ['Texas'] }),
    'CALLER_STATE_INVALID',
  );
});

test('the population description reports what was selected, never what it means', () => {
  const described = describePopulation({
    members: [
      { dimension: 'CAMPAIGN', externalId: 'c1', labelAtConfirmation: 'Roofing - TX' },
      { dimension: 'CAMPAIGN', externalId: 'c2', labelAtConfirmation: 'Roofing - Texas DR' },
      { dimension: 'SOURCE', externalId: 's1', labelAtConfirmation: null },
    ],
    callerStates: [],
  });
  assert.equal(described, '2 campaigns, 1 source');
  // It must not claim a vertical or a place. Loop does not know that these three
  // are "the Texas roofing business"; a person decided that.
  assert.ok(!/roofing|texas/i.test(described));
});

test('a caller-state restriction is stated when present, and absent when not', () => {
  const members = [{ dimension: 'CAMPAIGN' as const, externalId: 'c1', labelAtConfirmation: null }];
  assert.equal(describePopulation({ members, callerStates: [] }), '1 campaign');
  assert.match(describePopulation({ members, callerStates: ['TX'] }), /restricted to callers in TX/);
});
