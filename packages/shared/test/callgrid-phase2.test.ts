import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildHistoryPeriods, easternSpanDays, mean, stdev, volatility, trendPerPeriod,
  oscillations, extremeVersusSeries, zScore, historyEntityKey, MIN_SERIES_POINTS,
  type HistorySeries, type HistoryPoint,
} from '../src/callgrid-history';
import { scoreFinding, rankFindings, recurrenceKey, INTELLIGENCE_SCORE_VERSION } from '../src/callgrid-scoring';
import { assessMarketplaceRisk, topShare } from '../src/callgrid-risk';
import { detectAnomalies, ANOMALY_SIGNIFICANCE_RULES } from '../src/callgrid-anomaly';
import { analyzeCallGrid, allFindingViolations, type IntelligenceInput } from '../src/callgrid-intelligence-engine';
import { resolveCallGridWindow } from '../src/callgrid-window';
import { findingViolations, type CallGridFinding } from '../src/callgrid-intelligence';

const NOW = new Date('2026-07-29T14:15:00.000Z');

// --- History period generation -------------------------------------------------

test('a completed single-day window yields prior whole Eastern days', () => {
  const w = resolveCallGridWindow({ preset: 'yesterday' }, NOW);
  const periods = buildHistoryPeriods(w, 5);
  assert.equal(periods.length, 5);
  assert.equal(periods[0]!.spanDays, 1);
  // Contiguous, walking backwards from the window start.
  assert.equal(periods[0]!.end.toISOString(), w.start.toISOString());
  for (let i = 1; i < periods.length; i += 1) {
    assert.equal(periods[i]!.end.toISOString(), periods[i - 1]!.start.toISOString());
  }
});

test('a LIVE window yields no history at all — never a partial period in a distribution', () => {
  const today = resolveCallGridWindow({ preset: 'today' }, NOW);
  assert.equal(buildHistoryPeriods(today, 8).length, 0);
  const last7 = resolveCallGridWindow({ preset: 'last_7_days' }, NOW);
  assert.equal(last7.includesLiveData, true);
  assert.equal(buildHistoryPeriods(last7, 8).length, 0);
});

test('history periods span DST correctly rather than dividing elapsed milliseconds', () => {
  // A completed week containing the spring-forward day is still 7 Eastern days.
  const w = resolveCallGridWindow({ preset: 'custom', start: '2026-03-02', end: '2026-03-08' }, NOW);
  assert.equal(easternSpanDays(w.start, w.end), 7);
  const periods = buildHistoryPeriods(w, 2);
  assert.equal(periods.length, 2);
  for (const p of periods) assert.equal(p.spanDays, 7);
  // The period containing the 23-hour day is shorter in real time, and that is correct.
  assert.equal(easternSpanDays(periods[0]!.start, periods[0]!.end), 7);
});

// --- Distribution statistics ---------------------------------------------------

test('statistics refuse to compute below the minimum and say why', () => {
  const tooFew = [100, 200, 300];
  for (const stat of [stdev(tooFew), volatility(tooFew), trendPerPeriod(tooFew), oscillations(tooFew)]) {
    assert.equal(stat.value, null);
    assert.ok(stat.reason && stat.reason.length > 0, 'a declined statistic must carry a reason');
  }
});

test('nulls are excluded from statistics, never counted as zero', () => {
  const withGaps = [100, null, 100, null, 100, 100];
  const m = mean(withGaps);
  assert.equal(m.value, 100);
  assert.equal(m.usablePoints, 4);
  assert.equal(m.totalPoints, 6);
  // Had nulls been zeroed the mean would have been 66.7.
});

test('volatility is undefined at a zero mean rather than infinite', () => {
  const v = volatility([0, 0, 0, 0, 0]);
  assert.equal(v.value, null);
  assert.match(v.reason!, /average is zero/i);
});

test('a flat series produces no z-score instead of an infinite one', () => {
  const z = zScore(500, [100, 100, 100, 100, 100]);
  assert.equal(z.value, null);
  assert.match(z.reason!, /same value/i);
});

test('trend is positive when the series grows over time (most-recent-first ordering)', () => {
  // Most-recent-first: 400 is the latest, 100 the earliest → growth.
  const t = trendPerPeriod([400, 300, 200, 100]);
  assert.ok(t.value !== null && t.value > 0, 'growth must read as a positive slope');
  const declining = trendPerPeriod([100, 200, 300, 400]);
  assert.ok(declining.value !== null && declining.value < 0);
});

test('oscillation counts direction flips, distinguishing unstable from declining', () => {
  const steadyDecline = oscillations([100, 200, 300, 400, 500]);
  assert.equal(steadyDecline.value, 0);
  const unstable = oscillations([100, 300, 120, 280, 140]);
  assert.ok((unstable.value ?? 0) >= 3);
});

test('a new high needs a full minimum series, not two lucky points', () => {
  assert.equal(extremeVersusSeries(999, [1, 2]).extreme, null);
  assert.equal(extremeVersusSeries(999, [1, 2, 3, 4]).extreme, 'HIGH');
  assert.equal(extremeVersusSeries(0, [1, 2, 3, 4]).extreme, 'LOW');
  assert.equal(extremeVersusSeries(3, [1, 2, 3, 4]).extreme, null);
});

// --- Scoring -------------------------------------------------------------------

function finding(over: Partial<CallGridFinding> = {}): CallGridFinding {
  return {
    id: 'f1', findingType: 'CHANGE', title: 'Revenue declined',
    plainLanguageSummary: 'Revenue declined.', classification: 'DERIVED',
    severity: 'HIGH', confidence: 0.8,
    currentWindow: 'Yesterday', comparisonWindow: 'The day before',
    primaryMetric: 'revenue', currentValue: 100_000, comparisonValue: 200_000,
    absoluteChange: -100_000, percentageChange: -0.5,
    affectedEntities: [], drivers: [],
    supportingEvidence: [{
      id: 'f1:e1', findingId: 'f1', sourceType: 'call_projection', providerReport: 'r',
      metricKey: 'revenue', entityType: 'window', entityId: null, entityName: null,
      window: 'Yesterday', providerField: null, rawValue: null, normalizedValue: 100_000,
      derivedValue: null, formula: null, formulaVersion: null, classification: 'VERIFIED',
      completeness: 1, notes: null,
    }],
    limitations: ['limited'], unknowns: [],
    recommendedReview: 'Review the buyer mix.', recommendedActionType: null, actionTarget: null,
    actionSafety: 'SAFE_TO_REVIEW', createdAt: NOW.toISOString(),
    ruleId: 'revenue-change', ruleVersion: 'v1',
    ...over,
  };
}

test('novelty is WITHHELD without history — never scored as zero or as brand new', () => {
  const s = scoreFinding({ finding: finding(), recurrenceCount: null, recurrenceWindow: null, windowRevenueCents: 500_000 });
  const novelty = s.components.find((c) => c.id === 'novelty')!;
  assert.equal(novelty.available, false);
  assert.equal(novelty.points, null);
  assert.deepEqual(s.unmeasured, ['novelty']);
  assert.ok(s.determinacy < 1, 'determinacy must fall when a component is withheld');
  assert.match(novelty.explanation, /no historical series/i);
});

test('a withheld component leaves the denominator, so the score is not depressed by it', () => {
  const base = { finding: finding(), windowRevenueCents: 500_000 };
  const withoutHistory = scoreFinding({ ...base, recurrenceCount: null, recurrenceWindow: null });
  // Same finding, but observed in NONE of 8 prior periods → maximum novelty.
  const fullyNovel = scoreFinding({ ...base, recurrenceCount: 0, recurrenceWindow: 8 });
  // A fully-novel finding must not score BELOW one where novelty was unmeasurable.
  assert.ok(fullyNovel.score >= withoutHistory.score);
  assert.equal(fullyNovel.determinacy, 1);
});

test('an ongoing pattern scores lower than a new one, all else equal', () => {
  const base = { finding: finding(), windowRevenueCents: 500_000 };
  const isNew = scoreFinding({ ...base, recurrenceCount: 0, recurrenceWindow: 8 });
  const ongoing = scoreFinding({ ...base, recurrenceCount: 8, recurrenceWindow: 8 });
  assert.ok(isNew.score > ongoing.score, 'news must outrank the standing state of the business');
});

test('ranking is stable — equal findings never reorder between renders', () => {
  const a = finding({ id: 'aaa' });
  const b = finding({ id: 'bbb' });
  const first = rankFindings([a, b], { windowRevenueCents: 1, recurrence: null, recurrenceWindow: null });
  const second = rankFindings([b, a], { windowRevenueCents: 1, recurrence: null, recurrenceWindow: null });
  assert.deepEqual(first.map((r) => r.finding.id), second.map((r) => r.finding.id));
});

test('recurrence identity includes the entity, so one buyer cannot answer for another', () => {
  const withEntity = (id: string) => finding({
    affectedEntities: [{
      entityType: 'buyer', entityId: id, entityName: id, currentValue: null, comparisonValue: null,
      absoluteChange: null, contributionToChange: null, currentShare: null, comparisonShare: null,
      currentRank: null, comparisonRank: null,
    }],
  });
  assert.notEqual(recurrenceKey(withEntity('buyer-a')), recurrenceKey(withEntity('buyer-b')));
});

test('the score reports its formula version', () => {
  const s = scoreFinding({ finding: finding(), recurrenceCount: 0, recurrenceWindow: 4, windowRevenueCents: 1 });
  assert.equal(s.formulaVersion, INTELLIGENCE_SCORE_VERSION);
});

// --- Risk ----------------------------------------------------------------------

const row = (key: string, revenueCents: number | null, calls = 100) => ({
  key, label: key, calls, revenueCents, marginCents: revenueCents,
});

test('unpriced rows are excluded from concentration, never counted as zero', () => {
  // One priced buyer and three unpriced ones must NOT read as 100% concentration
  // by treating the unpriced ones as zero-revenue.
  const t = topShare([row('a', 100_000), row('b', null), row('c', null)], 'revenueCents');
  assert.equal(t.share, 1);
  assert.equal(t.measuredRows, 1);
  assert.equal(t.totalRows, 3);
  // The finding must disclose that only 1 of 3 was measured.
  const risk = assessMarketplaceRisk({
    buyers: [row('a', 100_000), row('b', null), row('c', null)],
    vendors: [], sources: [], campaigns: [],
    windowRevenueCents: 100_000, revenueSeries: [],
    bidRejectRate: null, rateLimitedShare: null, includesLiveData: false,
  });
  const buyerFactor = risk.factors.find((f) => f.id === 'buyer-concentration')!;
  assert.ok(buyerFactor.unknowns.some((u) => /carried no revenue value/i.test(u)));
});

test('an unmeasurable risk factor is withheld, never scored as safe', () => {
  const risk = assessMarketplaceRisk({
    buyers: [], vendors: [], sources: [], campaigns: [],
    windowRevenueCents: null, revenueSeries: [],
    bidRejectRate: null, rateLimitedShare: null, includesLiveData: false,
  });
  assert.equal(risk.determinacy, 0);
  assert.equal(risk.unmeasured.length, risk.factors.length);
  assert.match(risk.headline, /could not be assessed/i);
  for (const f of risk.factors) assert.equal(f.available, false);
});

test('a LOW band built from partial data reports its determinacy', () => {
  const risk = assessMarketplaceRisk({
    buyers: [row('a', 10_000), row('b', 10_000), row('c', 10_000)],
    vendors: [], sources: [], campaigns: [],
    windowRevenueCents: 30_000, revenueSeries: [],
    bidRejectRate: null, rateLimitedShare: null, includesLiveData: false,
  });
  assert.ok(risk.determinacy < 1, 'not every factor had data');
  assert.ok(risk.unmeasured.length > 0);
});

test('growth never contributes to risk — only decline does', () => {
  const growing = assessMarketplaceRisk({
    buyers: [], vendors: [], sources: [], campaigns: [],
    windowRevenueCents: 100, revenueSeries: [500, 400, 300, 200, 100],
    bidRejectRate: null, rateLimitedShare: null, includesLiveData: false,
  });
  const trend = growing.factors.find((f) => f.id === 'revenue-trend')!;
  assert.equal(trend.available, true);
  assert.equal(trend.level, 0, 'a growing business must score zero fragility on trend');
});

test('risk never predicts a counterparty will leave', () => {
  const risk = assessMarketplaceRisk({
    buyers: [row('dominant', 900_000), row('small', 10_000)],
    vendors: [], sources: [], campaigns: [],
    windowRevenueCents: 910_000, revenueSeries: [],
    bidRejectRate: null, rateLimitedShare: null, includesLiveData: false,
  });
  const text = JSON.stringify(risk).toLowerCase();
  for (const forbidden of ['will leave', 'likely to leave', 'will churn', 'will reduce', 'expected to leave']) {
    assert.ok(!text.includes(forbidden), `risk must not predict behaviour: "${forbidden}"`);
  }
});

// --- Anomalies -----------------------------------------------------------------

const metrics = (over: Partial<{
  totalCalls: number | null; billableCalls: number | null;
  revenueCents: number | null; profitCents: number | null;
  revenueCoverage: number | null; profitCoverage: number | null;
}> = {}) => ({
  available: true, totalCalls: 100, billableCalls: 40,
  revenueCents: 100_000, profitCents: 40_000,
  revenueCoverage: 1, profitCoverage: 1, ...over,
});

function series(revenues: (number | null)[]): HistorySeries {
  const points: HistoryPoint[] = revenues.map((r, i) => ({
    period: { index: i + 1, start: new Date(0), end: new Date(0), spanDays: 1 },
    totalCalls: 100, billableCalls: 40, revenueCents: r, profitCents: r,
    entityRevenueCents: {}, entityCalls: {}, entityLabels: {},
  }));
  return { points, suppressedForLiveWindow: false };
}

const anomalyInput = (over: Partial<Parameters<typeof detectAnomalies>[0]> = {}) => ({
  now: NOW, windowLabel: 'Yesterday', comparisonLabel: 'The day before',
  includesLiveData: false,
  metrics: metrics(), comparison: metrics(),
  dimensions: { buyers: [], vendors: [], sources: [], campaigns: [] },
  history: series([]),
  ...over,
});

test('distribution anomalies stay SILENT without a series rather than guessing', () => {
  const found = detectAnomalies(anomalyInput({
    metrics: metrics({ revenueCents: 1_000_000 }),
    history: series([]),
  }));
  assert.equal(found.filter((f) => f.ruleId.startsWith('anomaly-revenue-outlier')).length, 0);
  assert.equal(found.filter((f) => f.ruleId === 'anomaly-oscillation').length, 0);
});

test('a revenue outlier fires against a real distribution and cites the deviation', () => {
  const found = detectAnomalies(anomalyInput({
    metrics: metrics({ revenueCents: 1_000_000 }),
    history: series([100_000, 105_000, 98_000, 102_000, 101_000, 99_000]),
  }));
  const outlier = found.find((f) => f.ruleId === 'anomaly-revenue-outlier');
  assert.ok(outlier, 'a 10x move against a tight distribution must be flagged');
  assert.equal(outlier!.findingType, 'ANOMALY');
  assert.ok(outlier!.supportingEvidence.length >= 3);
  assert.ok(outlier!.unknowns.length > 0, 'an anomaly must say what it cannot explain');
});

test('an outlier explains that it measures unusualness, not cause', () => {
  const found = detectAnomalies(anomalyInput({
    metrics: metrics({ revenueCents: 1_000_000 }),
    history: series([100_000, 105_000, 98_000, 102_000, 101_000, 99_000]),
  }));
  const outlier = found.find((f) => f.ruleId === 'anomaly-revenue-outlier')!;
  assert.match(outlier.plainLanguageSummary, /not why it moved/i);
});

test('divergence fires only when revenue and volume move in OPPOSITE directions', () => {
  const sameDirection = detectAnomalies(anomalyInput({
    metrics: metrics({ revenueCents: 200_000, totalCalls: 200 }),
    comparison: metrics({ revenueCents: 100_000, totalCalls: 100 }),
  }));
  assert.equal(sameDirection.filter((f) => f.ruleId === 'anomaly-divergence').length, 0);

  const opposite = detectAnomalies(anomalyInput({
    metrics: metrics({ revenueCents: 200_000, totalCalls: 50 }),
    comparison: metrics({ revenueCents: 100_000, totalCalls: 100 }),
  }));
  assert.equal(opposite.filter((f) => f.ruleId === 'anomaly-divergence').length, 1);
});

test('profit divergence is suppressed when profit coverage is too low to trust', () => {
  const found = detectAnomalies(anomalyInput({
    metrics: metrics({ revenueCents: 200_000, profitCents: 10_000, profitCoverage: 0.2 }),
    comparison: metrics({ revenueCents: 100_000, profitCents: 60_000 }),
  }));
  assert.equal(found.filter((f) => f.ruleId === 'anomaly-profit-divergence').length, 0);
});

test('every anomaly rule is registered with a version and an explanation', () => {
  for (const rule of ANOMALY_SIGNIFICANCE_RULES) {
    assert.ok(rule.ruleId && rule.version, 'a rule must be identifiable');
    assert.ok(rule.explanation.length > 20, `${rule.ruleId} must explain why it exists`);
    assert.ok(rule.suppressionConditions.length > 0, `${rule.ruleId} must say when it stays silent`);
  }
});

// --- Engine integration --------------------------------------------------------

const dimRow = (key: string, revenueCents: number | null, calls = 50) => ({
  key, label: key.toUpperCase(), calls, monetized: Math.floor(calls / 2), converted: 0,
  revenueCents, payoutCents: 0, costCents: 0, marginCents: revenueCents, revenueCoverage: 1,
});

const engineInput = (over: Partial<IntelligenceInput> = {}): IntelligenceInput => ({
  now: NOW, reportOk: true, windowLabel: 'Yesterday', comparisonLabel: 'The day before',
  comparisonBasis: 'complete_period', includesLiveData: false,
  metrics: metrics({ revenueCents: 500_000, totalCalls: 300 }),
  comparison: metrics({ revenueCents: 1_000_000, totalCalls: 600 }),
  dimensions: {
    buyers: [dimRow('a', 300_000), dimRow('b', 200_000)],
    vendors: [dimRow('v1', 500_000)],
    sources: [dimRow('s1', 500_000)],
    campaigns: [dimRow('c1', 500_000)],
  },
  comparisonDimensions: {
    buyers: [dimRow('a', 800_000), dimRow('b', 200_000)],
    vendors: [dimRow('v1', 1_000_000)],
    sources: [dimRow('s1', 1_000_000)],
    campaigns: [dimRow('c1', 1_000_000)],
  },
  ...over,
});

test('the brief is capped at five and reports what it omitted', () => {
  const intel = analyzeCallGrid(engineInput());
  assert.ok(intel.brief.items.length <= 5, 'the brief is a ceiling, not a target');
  assert.equal(intel.brief.items.length + intel.brief.omittedCount, intel.ranked.length);
});

test('the brief is ordered by Intelligence Score, descending', () => {
  const intel = analyzeCallGrid(engineInput());
  const scores = intel.brief.items.map((i) => i.score.score);
  assert.deepEqual(scores, [...scores].sort((a, b) => b - a));
});

test('an empty brief states WHY it is empty rather than rendering blank', () => {
  const intel = analyzeCallGrid(engineInput({
    reportOk: false,
    metrics: { available: false, totalCalls: null, billableCalls: null, revenueCents: null, profitCents: null, revenueCoverage: null, profitCoverage: null },
    comparison: null,
  }));
  assert.equal(intel.brief.items.length, 0);
  assert.ok(intel.brief.emptyReason && intel.brief.emptyReason.length > 0);
  assert.match(intel.brief.emptyReason!, /could not be read/i);
});

test('the engine flags that it scored without history', () => {
  const intel = analyzeCallGrid(engineInput());
  assert.equal(intel.brief.scoredWithoutHistory, true);
  const withHistory = analyzeCallGrid(engineInput({ history: series([100_000, 100_000, 100_000, 100_000]) }));
  assert.equal(withHistory.brief.scoredWithoutHistory, false);
});

test('the absence of a series is surfaced as an explicit unknown', () => {
  const intel = analyzeCallGrid(engineInput());
  assert.ok(intel.unknowns.some((u) => u.id === 'no-historical-series'));
});

test('every finding the engine emits — including anomalies — is well-formed', () => {
  const intel = analyzeCallGrid(engineInput({
    history: series([100_000, 105_000, 98_000, 102_000, 101_000]),
    metrics: metrics({ revenueCents: 900_000, totalCalls: 300 }),
  }));
  assert.deepEqual(allFindingViolations(intel.findings), []);
  for (const f of intel.findings) assert.deepEqual(findingViolations(f), []);
});

test('no finding claims causation, anomalies included', () => {
  const intel = analyzeCallGrid(engineInput({
    history: series([100_000, 105_000, 98_000, 102_000, 101_000]),
    metrics: metrics({ revenueCents: 900_000, totalCalls: 50 }),
  }));
  for (const f of intel.findings) {
    const text = `${f.title} ${f.plainLanguageSummary}`.toLowerCase();
    for (const banned of ['caused by', 'because of', 'due to', 'resulted from']) {
      assert.ok(!text.includes(banned), `"${banned}" in ${f.ruleId}: ${f.title}`);
    }
  }
});

test('the engine is deterministic — same input, identical output', () => {
  const input = engineInput({ history: series([100_000, 105_000, 98_000, 102_000]) });
  assert.deepEqual(
    JSON.parse(JSON.stringify(analyzeCallGrid(input))),
    JSON.parse(JSON.stringify(analyzeCallGrid(input))),
  );
});

test('risk is computed on the Overview and carries its determinacy', () => {
  const intel = analyzeCallGrid(engineInput());
  assert.ok(intel.risk.modelVersion);
  assert.ok(intel.risk.determinacy >= 0 && intel.risk.determinacy <= 1);
  assert.ok(intel.risk.factors.length === 9, 'all nine factors are always reported, measured or not');
});

test('entity keys are namespaced per dimension so ids cannot collide', () => {
  assert.notEqual(historyEntityKey('buyers', 'x1'), historyEntityKey('sources', 'x1'));
});

test('MIN_SERIES_POINTS is the single stated bar for every distribution rule', () => {
  assert.ok(MIN_SERIES_POINTS >= 3, 'a distribution needs more than a couple of points');
});
