// The CallGrid command center's pure layer: what the executive surface may say, and
// what it may never say. `now` is injected; every assertion is fixed.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CALLGRID_FRESHNESS_POLICY,
  assessCallGridFreshness,
  bidFunnel,
  callFunnel,
  callGridBuckets,
  callGridKpis,
  composeCallGridBrief,
  assessCallGridCoverage,
  callGridRecordCovers,
  effectiveCallGridWindow,
  selectCallGridPeriod,
  callGridPeriodWindow,
  easternYmd,
  resolveCallGridWindow,
  selectTopPriorities,
  situationKind,
  type CommandMetrics,
  type Situation,
} from '../src/index';

const NOW = new Date('2026-09-18T18:30:00.000Z'); // Fri 2:30 PM EDT
const metrics = (over: Partial<CommandMetrics> = {}): CommandMetrics => ({
  available: true, totalCalls: 400, billableCalls: 132, revenueCents: 37_241_800, profitCents: 6_452_800,
  costCents: 8_391_200, revenueCoverage: 1, profitCoverage: 1, ...over,
});
const point = (over: Record<string, number> = {}) => ({
  calls: 10, monetized: 3, revenueCents: 30_000, payoutCents: 20_000, costCents: 1_000,
  callsWithRevenue: 10, callsWithCost: 10, ...over,
});

test('the day is charted hourly up to now, and the comparison stops at the same elapsed point', () => {
  const b = callGridBuckets(resolveCallGridWindow({ preset: 'today' }, NOW));
  assert.equal(b.grain, 'hour');
  assert.equal(b.current.length, 15, 'midnight to the 2 PM hour');
  assert.equal(b.current[0]!.label, '12 AM');
  assert.equal(b.current.at(-1)!.end.getTime(), NOW.getTime(), 'the live hour ends at now');
  assert.equal(b.comparison.length, 15);
  assert.equal(b.comparison.at(-1)!.end.toISOString(), '2026-09-17T18:30:00.000Z');

  const week = callGridBuckets(resolveCallGridWindow({ preset: 'last_week' }, NOW));
  assert.equal(week.grain, 'day');
  assert.equal(week.current.length, 7);
  assert.equal(week.current[0]!.label, 'Mon 7');
  const ymd = easternYmd(week.current[0]!.start);
  assert.deepEqual([ymd.month, ymd.day], [9, 7]);
});

test('Net Profit, Margin and Telco Cost are the report’s own figures, never recomputed from the series', () => {
  const kpis = callGridKpis({
    metrics: metrics(),
    comparison: metrics({ totalCalls: 470, billableCalls: 130, revenueCents: 34_000_000, profitCents: 6_000_000, costCents: 8_000_000 }),
    series: [point(), point({ calls: 0, monetized: 0, revenueCents: 0, payoutCents: 0, costCents: 0, callsWithRevenue: 0, callsWithCost: 0 })],
  });
  const by = Object.fromEntries(kpis.map((k) => [k.key, k]));
  assert.deepEqual(kpis.map((k) => k.label), ['Net Profit', 'Revenue', 'Billable Calls', 'Margin', 'Telco Cost']);
  assert.equal(by.netProfit!.value, 6_452_800);
  assert.equal(by.telcoCost!.value, 8_391_200);
  assert.equal(by.margin!.value, 17.3, 'net profit ÷ revenue');
  assert.equal(by.revenue!.change!.text, '10%');
  assert.equal(by.margin!.change!.text, '−0.3 pts');
  // Telco cost going up is not good news.
  assert.equal(by.telcoCost!.change!.direction, 'up');
  assert.equal(by.telcoCost!.change!.favorable, false);
  // A bucket with no calls is a real zero; the sparkline still carries it.
  assert.deepEqual(by.netProfit!.spark, [9_000, 0]);
});

test('no honest comparison, no change line — and unknown is never zero', () => {
  const noCompare = callGridKpis({ metrics: metrics(), comparison: null, series: [] });
  assert.ok(noCompare.every((k) => k.change === null && k.noChangeReason === 'No comparison period for this selection.'));

  const priorZero = callGridKpis({ metrics: metrics(), comparison: metrics({ revenueCents: 0, profitCents: 0 }), series: [] });
  assert.equal(priorZero.find((k) => k.key === 'revenue')!.change, null, 'never a percentage off nothing');

  const unknown = callGridKpis({ metrics: metrics({ revenueCents: null, profitCents: null }), comparison: null, series: [] });
  const revenue = unknown.find((k) => k.key === 'revenue')!;
  assert.equal(revenue.state, 'UNKNOWN');
  assert.equal(revenue.value, null);

  const down = callGridKpis({ metrics: metrics({ available: false }), comparison: null, series: [] });
  assert.ok(down.every((k) => k.state === 'UNAVAILABLE' && k.value === null));

  const partial = callGridKpis({ metrics: metrics({ revenueCoverage: 0.8, profitCoverage: 0.8 }), comparison: null, series: [] });
  assert.match(partial.find((k) => k.key === 'revenue')!.coverageNote!, /80% of calls reported revenue/);
});

test('freshness: Live is earned by a recent delivery, never by the render clock', () => {
  const base = { now: NOW, readOk: true, periodLive: true, pollCompletedThrough: null, recentDeliveries: [], factsOk: true };
  const minutes = (m: number) => new Date(NOW.getTime() - m * 60_000);

  const live = assessCallGridFreshness({ ...base, lastDeliveryAt: minutes(4) });
  assert.equal(live.state, 'LIVE');
  assert.equal(live.asOf!.getTime(), minutes(4).getTime(), 'the badge time is the delivery, not now');

  assert.equal(assessCallGridFreshness({ ...base, lastDeliveryAt: minutes(90) }).state, 'CURRENT');
  const stale = assessCallGridFreshness({ ...base, lastDeliveryAt: minutes(5 * 60) });
  assert.equal(stale.state, 'STALE');
  assert.match(stale.detail, /can mean no calls, or a delivery problem/);
  assert.ok(CALLGRID_FRESHNESS_POLICY.currentMs < 5 * 3_600_000);

  // The poll's proven coverage counts as currency too.
  assert.equal(assessCallGridFreshness({ ...base, lastDeliveryAt: minutes(300), pollCompletedThrough: minutes(2) }).state, 'LIVE');

  const degraded = assessCallGridFreshness({
    ...base, lastDeliveryAt: minutes(2),
    recentDeliveries: [{ status: 'FAILED', receivedAt: minutes(10) }, { status: 'PROCESSED', receivedAt: minutes(2) }],
  });
  assert.equal(degraded.state, 'DEGRADED');
  assert.match(degraded.detail, /1 of the last 2/);

  assert.equal(assessCallGridFreshness({ ...base, readOk: false, lastDeliveryAt: minutes(1) }).state, 'UNAVAILABLE');
  assert.equal(assessCallGridFreshness({ ...base, lastDeliveryAt: null }).state, 'UNAVAILABLE');
  assert.equal(assessCallGridFreshness({ ...base, factsOk: false, lastDeliveryAt: null }).word, 'Unverified');
  // A completed period is never called live, however recent the last delivery.
  assert.equal(assessCallGridFreshness({ ...base, periodLive: false, lastDeliveryAt: minutes(1) }).state, 'COMPLETED');
});

test('the brief tags every sentence with its basis, names no cause, and says what is not known', () => {
  const brief = composeCallGridBrief({
    window: resolveCallGridWindow({ preset: 'today' }, NOW),
    metrics: metrics({ revenueCoverage: 0.9 }),
    comparison: metrics({ totalCalls: 470, billableCalls: 132, revenueCents: 34_000_000 }),
    buyers: [{ label: 'Markytek', revenueCents: 18_620_900 }, { label: 'Buyer B', revenueCents: 3_844_200 }],
    campaigns: [{ label: 'Pest Control RTB', revenueCents: 15_000_000 }],
    health: { band: 'WATCH', explanation: 'Buyer concentration is the weakest measured signal.' },
  });
  assert.equal(brief.band, 'WATCH');
  const [calls, revenue, concentration, reading, unknown] = brief.sentences;
  assert.equal(calls!.text, 'Calls are down 15% versus yesterday to the same time, while the billable rate rose from 28% to 33%.');
  assert.equal(calls!.basis, 'ARITHMETIC');
  assert.match(revenue!.text, /^Revenue is up 10% at \$372,418, with net profit of \$64,528 \(17\.3% margin\)\.$/);
  assert.equal(concentration!.text, 'Markytek accounts for 50% of buyer revenue, and Pest Control RTB carries 40% by campaign.');
  assert.equal(reading!.basis, 'READING');
  assert.equal(unknown!.basis, 'UNKNOWN');
  for (const s of brief.sentences) {
    for (const cause of ['because', 'due to', 'caused', 'driven by', 'as a result']) {
      assert.equal(s.text.toLowerCase().includes(cause), false, `${cause}: ${s.text}`);
    }
  }
  const empty = composeCallGridBrief({
    window: resolveCallGridWindow({ preset: 'today' }, NOW), metrics: metrics({ totalCalls: 0 }), comparison: null,
    buyers: [], campaigns: [], health: { band: 'UNKNOWN', explanation: null },
  });
  assert.equal(empty.sentences[0]!.text, 'No calls were recorded for this period so far.');
});

// --- Coverage: incomplete periods are never compared ----------------------------------------------

const RECORD = new Date('2026-08-14T13:05:00Z'); // Aug 14, 9:05 AM EDT: the seed's first call
const monthly = (date: string) => callGridPeriodWindow(selectCallGridPeriod({ period: 'monthly', date }, NOW)!, NOW);

test('coverage: a comparison is valid only when Loop’s record covers its first day', () => {
  // September against August: the record starts Aug 14, inside August.
  const sep = monthly('2026-09-18');
  const cov = assessCallGridCoverage(sep, { ok: true, startsAt: RECORD });
  assert.equal(cov.comparison, 'BEFORE_RECORD');
  assert.equal(cov.currentPartial, false);
  assert.equal(cov.note, 'Not compared: Loop’s call record starts Aug 14, after the comparison period began.');
  const eff = effectiveCallGridWindow(sep, cov);
  assert.equal(eff.comparisonStart, null);
  assert.equal(eff.comparisonBasis, 'none');
  assert.equal(eff.start.getTime(), sep.start.getTime(), 'the selected period itself is untouched');

  // August itself is partial, and so has no valid comparison either.
  const aug = assessCallGridCoverage(monthly('2026-08-20'), { ok: true, startsAt: RECORD });
  assert.equal(aug.currentPartial, true);
  assert.equal(aug.comparison, 'BEFORE_RECORD');
  assert.equal(aug.note, 'Partial period: Loop’s call record starts Aug 14, so there is no valid comparison.');

  // July is before the record entirely.
  assert.equal(assessCallGridCoverage(monthly('2026-07-10'), { ok: true, startsAt: RECORD }).note, 'No data: Loop’s call record starts Aug 14, after this period.');

  // Today against yesterday: covered, nothing withheld, nothing said.
  const today = resolveCallGridWindow({ preset: 'today' }, NOW);
  const ok = assessCallGridCoverage(today, { ok: true, startsAt: RECORD });
  assert.deepEqual([ok.comparison, ok.currentPartial, ok.note], ['VALID', false, null]);
  assert.equal(effectiveCallGridWindow(today, ok), today);
});

test('coverage is judged by Eastern business day, so the first call’s hour never voids its own day', () => {
  // The record's first call at 9:05 AM on Aug 14 still covers a period starting that midnight.
  assert.equal(callGridRecordCovers(RECORD, new Date('2026-08-14T04:00:00Z')), true);
  assert.equal(callGridRecordCovers(RECORD, new Date('2026-08-13T04:00:00Z')), false);
  // 11:30 PM Eastern on Aug 13 is still Aug 13, although it is Aug 14 in UTC.
  assert.equal(callGridRecordCovers(new Date('2026-08-14T03:30:00Z'), new Date('2026-08-13T04:00:00Z')), true);
  assert.equal(callGridRecordCovers(null, new Date('2026-08-13T04:00:00Z')), false);
});

test('coverage fails closed: no record, or a record that could not be read, compares against nothing', () => {
  const today = resolveCallGridWindow({ preset: 'today' }, NOW);
  const none = assessCallGridCoverage(today, { ok: true, startsAt: null });
  assert.equal(none.comparison, 'NO_RECORD');
  assert.equal(effectiveCallGridWindow(today, none).comparisonStart, null);
  const unread = assessCallGridCoverage(today, { ok: false, startsAt: null });
  assert.equal(unread.comparison, 'UNKNOWN');
  assert.equal(unread.note, 'Not compared: Loop could not confirm when its call record starts.');
  assert.equal(effectiveCallGridWindow(today, unread).comparisonStart, null);
});

test('the executive surface shows at most three priorities, in the engine’s order, undecided only', () => {
  const items = ['a', 'b', 'c', 'd', 'e'].map((id, i) => ({ id, open: i !== 1 }));
  assert.deepEqual(selectTopPriorities(items, (i) => i.open).map((i) => i.id), ['a', 'c', 'd']);
  assert.deepEqual(selectTopPriorities(items, (i) => i.open, 10).length, 3, 'never more than three, whatever is asked');
  assert.deepEqual(selectTopPriorities(items.slice(0, 2), (i) => i.open).map((i) => i.id), ['a'], 'fewer when fewer are undecided');
});

test('a situation’s kind comes from the finding that raised it — and which way the metric moved', () => {
  const sit = (findingType: string, over: Record<string, unknown> = {}, opportunity: unknown = null) =>
    ({ opportunity, observations: [{ findingType, primaryMetric: 'revenue', percentageChange: null, absoluteChange: null, ...over }] } as unknown as Situation);
  assert.equal(situationKind(sit('CONCENTRATION')), 'RISK');
  assert.equal(situationKind(sit('BID_REJECTION', { percentageChange: 40 })), 'RISK', 'a risk whichever way it moved');
  assert.equal(situationKind(sit('CHANGE', { percentageChange: -15, primaryMetric: 'totalCalls' })), 'NEEDS_INVESTIGATION', 'calls fell');
  assert.equal(situationKind(sit('QUALITY', { percentageChange: 34, primaryMetric: 'billableRate' })), 'OPPORTUNITY', 'billable rate rose: not a risk');
  assert.equal(situationKind(sit('QUALITY', { percentageChange: -20, primaryMetric: 'billableRate' })), 'RISK');
  assert.equal(situationKind(sit('DRIVER', { absoluteChange: 900, primaryMetric: 'contributionToChange' })), 'NEEDS_INVESTIGATION', 'no stated good direction: never guessed');
  assert.equal(situationKind(sit('CHANGE', { percentageChange: 10, primaryMetric: 'cost' })), 'NEEDS_INVESTIGATION', 'cost rising is not good news');
  assert.equal(situationKind(sit('DRIVER', {}, { finding: {} })), 'OPPORTUNITY');
  assert.equal(situationKind({ opportunity: null, observations: [] } as unknown as Situation), 'WATCH');
});

test('funnels never infer a stage the data does not carry', () => {
  const stages = callFunnel(
    { calls: 50, completed: 0, completedReported: 0, monetized: 12, noRoute: 0, noRouteReported: 0 },
    { revenueCents: null, profitCents: null },
  );
  const completed = stages.find((s) => s.key === 'completed')!;
  assert.equal(completed.value, null, 'not reported is unknown, not zero');
  assert.match(completed.note!, /did not report completion/);
  assert.equal(stages.find((s) => s.key === 'revenue')!.value, null);

  const partial = callFunnel({ calls: 50, completed: 30, completedReported: 40, monetized: 12, noRoute: 0, noRouteReported: 0 }, { revenueCents: 1, profitCents: 1 });
  assert.match(partial.find((s) => s.key === 'completed')!.note!, /40 of 50/);

  const bids = bidFunnel(null);
  assert.ok(bids.every((s) => s.value === null && s.grain === 'bid_snapshot'), 'no snapshot, no bid numbers');
});

test('a finding’s value is shown in its metric’s unit: cents as dollars, fractions as percentages', async () => {
  const { formatMetricValue, formatRelativeChange } = await import('../src/callgrid-command');
  assert.equal(formatMetricValue('revenue', 403_838), '$4,038');
  assert.equal(formatMetricValue('billableRate', 0.336), '33.6%');
  assert.equal(formatMetricValue('totalCalls', 277), '277');
  assert.equal(formatMetricValue('revenue', null), 'Unknown');
  assert.equal(formatRelativeChange(0.12857817560901996), '+12.9%');
  assert.equal(formatRelativeChange(-0.15), '−15.0%');
  assert.equal(formatRelativeChange(null), '—');
});
