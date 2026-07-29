import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  assessBusinessHealth, healthByUrgency, healthUnknowns,
  HEALTH_BAND_RANK, type HealthInput,
} from '../src/callgrid-health';
import { assessMarketplaceRisk } from '../src/callgrid-risk';
import { findOpportunities, OPPORTUNITY_SIGNIFICANCE_RULES, type OpportunityInput } from '../src/callgrid-opportunity';
import { analyzeCallGrid, analyzeDimension, type IntelligenceInput } from '../src/callgrid-intelligence-engine';
import { findingViolations } from '../src/callgrid-intelligence';
import type { HistoryPoint, HistorySeries } from '../src/callgrid-history';
import { historyEntityKey } from '../src/callgrid-history';

const NOW = new Date('2026-07-29T14:15:00.000Z');

const metrics = (over: Partial<HealthInput['metrics']> = {}): HealthInput['metrics'] => ({
  available: true, totalCalls: 400, billableCalls: 160,
  revenueCents: 1_000_000, profitCents: 400_000,
  revenueCoverage: 1, profitCoverage: 1, ...over,
});

const hRow = (key: string, revenueCents: number | null, calls = 100, monetized = 40) =>
  ({ key, label: key.toUpperCase(), calls, monetized, revenueCents });

const emptyRisk = () => assessMarketplaceRisk({
  buyers: [], vendors: [], sources: [], campaigns: [],
  windowRevenueCents: null, revenueSeries: [],
  bidRejectRate: null, rateLimitedShare: null, includesLiveData: false,
});

const healthInput = (over: Partial<HealthInput> = {}): HealthInput => ({
  metrics: metrics(),
  risk: emptyRisk(),
  revenueSeries: [], profitSeries: [], callSeries: [],
  dimensions: { buyers: [], vendors: [], campaigns: [], sources: [] },
  includesLiveData: false,
  ...over,
});

// --- Health: the UNKNOWN rule is the one that matters -----------------------------

test('a dimension with no measurable signal is UNKNOWN, never HEALTHY', () => {
  const health = assessBusinessHealth(healthInput({
    metrics: metrics({ totalCalls: null, billableCalls: null, revenueCoverage: null, profitCoverage: null }),
  }));
  for (const d of health.dimensions) {
    assert.notEqual(d.band, 'HEALTHY', `${d.label} claimed HEALTHY with nothing measured`);
  }
  assert.equal(health.overall.band, 'UNKNOWN');
  assert.match(health.overall.explanation, /not a clean bill of health/i);
});

test('an UNKNOWN dimension states that it is not a clean bill of health', () => {
  const health = assessBusinessHealth(healthInput({
    metrics: metrics({ totalCalls: null, billableCalls: null, revenueCoverage: null, profitCoverage: null }),
  }));
  const unknown = health.dimensions.find((d) => d.band === 'UNKNOWN');
  assert.ok(unknown);
  assert.match(unknown!.explanation, /cannot be assessed/i);
});

test('health reports determinacy when only some signals were measurable', () => {
  const health = assessBusinessHealth(healthInput({
    metrics: metrics({ revenueCoverage: 1 }),
    revenueSeries: [], // no series → trend and stability unmeasurable
  }));
  const revenue = health.dimensions.find((d) => d.id === 'revenue')!;
  assert.ok(revenue.determinacy > 0 && revenue.determinacy < 1);
  assert.ok(revenue.unknowns.length > 0);
});

test('the explanation names the WEAKEST signal, not the average', () => {
  // Full coverage but a hard sustained decline: the decline must be what is said.
  const health = assessBusinessHealth(healthInput({
    revenueSeries: [100_000, 300_000, 600_000, 1_000_000, 1_400_000],
    metrics: metrics({ revenueCoverage: 1 }),
  }));
  const revenue = health.dimensions.find((d) => d.id === 'revenue')!;
  assert.match(revenue.explanation, /downward and sustained|falling/i);
});

test('growth does not reduce health — only decline does', () => {
  const growing = assessBusinessHealth(healthInput({
    revenueSeries: [1_400_000, 1_000_000, 600_000, 300_000],
  }));
  const trend = growing.dimensions.find((d) => d.id === 'revenue')!
    .signals.find((s) => s.id === 'revenue-trend')!;
  assert.equal(trend.available, true);
  assert.equal(trend.score, 1, 'a growing business must score full marks on direction');
});

test('billable efficiency is described as efficiency, never as quality', () => {
  const health = assessBusinessHealth(healthInput());
  const sig = health.dimensions
    .flatMap((d) => d.signals)
    .find((s) => s.id === 'billable-efficiency');
  assert.ok(sig);
  assert.match(sig!.interpretation, /efficiency measure/i);
  assert.match(sig!.interpretation, /not.*quality|never.*quality/i);
});

test('health is ordered worst-band-first, never alphabetically', () => {
  const health = assessBusinessHealth(healthInput({
    metrics: metrics({ billableCalls: 4, totalCalls: 400 }), // poor efficiency
    dimensions: {
      buyers: [hRow('a', 1_000_000)], vendors: [], campaigns: [], sources: [],
    },
  }));
  const ordered = healthByUrgency(health);
  for (let i = 1; i < ordered.length; i += 1) {
    assert.ok(
      HEALTH_BAND_RANK[ordered[i - 1]!.band] <= HEALTH_BAND_RANK[ordered[i]!.band],
      'health must be sorted by band severity',
    );
  }
});

test('health consumes the risk model rather than recomputing concentration', () => {
  const risk = assessMarketplaceRisk({
    buyers: [hRow('dominant', 900_000), hRow('small', 100_000)],
    vendors: [], sources: [], campaigns: [],
    windowRevenueCents: 1_000_000, revenueSeries: [],
    bidRejectRate: null, rateLimitedShare: null, includesLiveData: false,
  });
  const health = assessBusinessHealth(healthInput({
    risk,
    dimensions: { buyers: [hRow('dominant', 900_000), hRow('small', 100_000)], vendors: [], campaigns: [], sources: [] },
  }));
  const buyer = health.dimensions.find((d) => d.id === 'buyer')!;
  const conc = buyer.signals.find((s) => s.id === 'buyer-concentration')!;
  const riskFactor = risk.factors.find((f) => f.id === 'buyer-concentration')!;
  // Health is the inverse of the risk factor — same measurement string, no second computation.
  assert.equal(conc.measurement, riskFactor.measurement);
  assert.equal(conc.score, 1 - (riskFactor.level ?? 0));
});

test('healthUnknowns surfaces every dimension that could not be assessed', () => {
  const health = assessBusinessHealth(healthInput({
    metrics: metrics({ totalCalls: null, billableCalls: null, revenueCoverage: null, profitCoverage: null }),
  }));
  const unknowns = healthUnknowns(health);
  assert.ok(unknowns.length > 0);
  assert.ok(unknowns.some((u) => /rather than healthy/i.test(u)));
});

// --- Opportunities: the money must never be a forecast ---------------------------

const oRow = (key: string, revenueCents: number | null, calls = 100, monetized = 40) =>
  ({ key, label: key.toUpperCase(), calls, monetized, revenueCents });

const emptyMap = new Map<string, ReturnType<typeof oRow>>();

const oppInput = (over: Partial<OpportunityInput> = {}): OpportunityInput => ({
  now: NOW, windowLabel: 'Yesterday', comparisonLabel: 'The day before',
  includesLiveData: false,
  windowRevenueCents: 1_000_000, totalCalls: 400, billableCalls: 160,
  revenueCoverage: 1,
  dimensions: { buyers: [], vendors: [], sources: [], campaigns: [] },
  comparisonByKey: { buyers: emptyMap, vendors: emptyMap, sources: emptyMap, campaigns: emptyMap },
  history: { points: [], suppressedForLiveWindow: false },
  risk: emptyRisk(),
  ...over,
});

test('a diversification opportunity sizes MEASURED EXPOSURE, never predicted gain', () => {
  const found = findOpportunities(oppInput({
    dimensions: {
      buyers: [oRow('big', 800_000), oRow('small', 200_000)],
      vendors: [], sources: [], campaigns: [],
    },
  }));
  const div = found.find((o) => o.finding.ruleId === 'opportunity-diversification');
  assert.ok(div);
  assert.equal(div!.impactBasis, 'measured_exposure');
  assert.equal(div!.estimatedImpactCents, 800_000);
  assert.match(div!.finding.plainLanguageSummary, /cannot size the benefit/i);
  assert.ok(div!.finding.unknowns.some((u) => /no benefit can be estimated/i.test(u)));
});

test('no opportunity claims a forecast anywhere in its text', () => {
  const found = findOpportunities(oppInput({
    dimensions: {
      buyers: [oRow('big', 800_000), oRow('small', 200_000)],
      vendors: [], sources: [oRow('bad', 300_000, 200, 10), oRow('ok', 700_000, 200, 90)], campaigns: [],
    },
  }));
  assert.ok(found.length > 0);
  for (const o of found) {
    const text = `${o.finding.title} ${o.finding.plainLanguageSummary} ${o.impactLabel}`.toLowerCase();
    for (const banned of ['you would earn', 'expected gain', 'projected revenue', 'will increase revenue', 'guaranteed']) {
      assert.ok(!text.includes(banned), `forecast language "${banned}" in ${o.finding.ruleId}`);
    }
  }
});

test('one measured entity is a data limit, not a 100% concentration opportunity', () => {
  const found = findOpportunities(oppInput({
    dimensions: {
      buyers: [oRow('only', 900_000), oRow('unpriced', null)],
      vendors: [], sources: [], campaigns: [],
    },
  }));
  assert.equal(found.filter((o) => o.finding.ruleId === 'opportunity-diversification').length, 0);
});

test('the efficiency gap is framed as arithmetic against the period, not a projection', () => {
  const found = findOpportunities(oppInput({
    totalCalls: 400, billableCalls: 200, // period rate 50%
    dimensions: {
      buyers: [], vendors: [], campaigns: [],
      sources: [oRow('weak', 200_000, 200, 10)], // 5% — a 45-point gap
    },
  }));
  const gap = found.find((o) => o.finding.ruleId === 'opportunity-efficiency-gap');
  assert.ok(gap);
  assert.equal(gap!.impactBasis, 'measured_gap');
  assert.match(gap!.finding.plainLanguageSummary, /not a promise/i);
  assert.match(gap!.finding.plainLanguageSummary, /arithmetic difference/i);
  assert.ok(gap!.finding.unknowns.some((u) => /could convert at the period rate/i.test(u)));
  // Never states call quality — billable rate is efficiency.
  assert.ok(gap!.finding.limitations.some((l) => /efficiency measure/i.test(l)));
});

test('opportunities are ordered by measured money, most material first', () => {
  const found = findOpportunities(oppInput({
    dimensions: {
      buyers: [oRow('big', 800_000), oRow('small', 200_000)],
      vendors: [oRow('v1', 600_000), oRow('v2', 100_000)],
      sources: [], campaigns: [],
    },
  }));
  const amounts = found.map((o) => o.estimatedImpactCents ?? 0);
  assert.deepEqual(amounts, [...amounts].sort((a, b) => b - a));
});

test('every opportunity finding is well-formed and recommends only review', () => {
  const found = findOpportunities(oppInput({
    dimensions: {
      buyers: [oRow('big', 800_000), oRow('small', 200_000)],
      vendors: [], campaigns: [],
      sources: [oRow('weak', 200_000, 200, 10), oRow('ok', 800_000, 200, 150)],
    },
    totalCalls: 400, billableCalls: 160,
  }));
  for (const o of found) {
    assert.deepEqual(findingViolations(o.finding), [], `${o.finding.ruleId}: ${o.finding.title}`);
    if (o.finding.recommendedReview) {
      assert.ok(
        !/\b(increase|decrease|pause|reroute|raise|lower|optimize|boost|scale)\b/i.test(o.finding.recommendedReview),
        `unsafe verb: ${o.finding.recommendedReview}`,
      );
    }
  }
});

test('every opportunity rule declares its version, suppression and reason', () => {
  for (const rule of OPPORTUNITY_SIGNIFICANCE_RULES) {
    assert.ok(rule.ruleId && rule.version);
    assert.ok(rule.suppressionConditions.length > 0, `${rule.ruleId} must say when it stays silent`);
    assert.ok(rule.explanation.length > 20, `${rule.ruleId} must explain why it exists`);
  }
});

// --- Engine integration -----------------------------------------------------------

const dimRow = (key: string, revenueCents: number | null, calls = 50) => ({
  key, label: key.toUpperCase(), calls, monetized: Math.floor(calls / 2), converted: 0,
  revenueCents, payoutCents: 0, costCents: 0, marginCents: revenueCents, revenueCoverage: 1,
});

const engineInput = (over: Partial<IntelligenceInput> = {}): IntelligenceInput => ({
  now: NOW, reportOk: true, windowLabel: 'Yesterday', comparisonLabel: 'The day before',
  comparisonBasis: 'complete_period', includesLiveData: false,
  metrics: {
    available: true, totalCalls: 300, billableCalls: 120,
    revenueCents: 1_000_000, profitCents: 400_000, revenueCoverage: 1, profitCoverage: 1,
  },
  comparison: {
    available: true, totalCalls: 600, billableCalls: 240,
    revenueCents: 2_000_000, profitCents: 800_000, revenueCoverage: 1, profitCoverage: 1,
  },
  dimensions: {
    buyers: [dimRow('a', 800_000), dimRow('b', 200_000)],
    vendors: [dimRow('v1', 700_000), dimRow('v2', 300_000)],
    sources: [dimRow('s1', 600_000), dimRow('s2', 400_000)],
    campaigns: [dimRow('c1', 1_000_000)],
  },
  comparisonDimensions: {
    buyers: [dimRow('a', 1_600_000), dimRow('b', 400_000)],
    vendors: [dimRow('v1', 1_400_000)],
    sources: [dimRow('s1', 1_200_000)],
    campaigns: [dimRow('c1', 2_000_000)],
  },
  ...over,
});

test('the engine exposes health and opportunities on the Overview', () => {
  const intel = analyzeCallGrid(engineInput());
  assert.ok(intel.health.modelVersion);
  assert.equal(intel.health.dimensions.length, 7);
  assert.ok(Array.isArray(intel.opportunityFindings));
});

test('health never reads HEALTHY when the report could not be read', () => {
  const intel = analyzeCallGrid(engineInput({
    reportOk: false,
    metrics: { available: false, totalCalls: null, billableCalls: null, revenueCents: null, profitCents: null, revenueCoverage: null, profitCoverage: null },
    comparison: null,
  }));
  assert.equal(intel.health.overall.band, 'UNKNOWN');
  assert.deepEqual(intel.opportunityFindings, []);
});

test('a dimension page gets the SAME health as the Overview — no second source of truth', () => {
  const input = engineInput();
  const overview = analyzeCallGrid(input);
  const buyers = analyzeDimension(input, 'buyers');
  const overviewBuyerHealth = overview.health.dimensions.find((d) => d.id === 'buyer')!;
  assert.equal(buyers.health.band, overviewBuyerHealth.band);
  assert.equal(buyers.health.score, overviewBuyerHealth.score);
  assert.equal(buyers.health.explanation, overviewBuyerHealth.explanation);
});

test('dimension intelligence is attention-ordered and carries scoped risks', () => {
  const buyers = analyzeDimension(engineInput(), 'buyers');
  const scores = buyers.ranked.map((r) => r.score.score);
  assert.deepEqual(scores, [...scores].sort((a, b) => b - a));
  assert.ok(Array.isArray(buyers.risks));
  assert.ok(Array.isArray(buyers.opportunities));
});

test('health unknowns reach the page unknowns section', () => {
  const intel = analyzeCallGrid(engineInput());
  assert.ok(intel.unknowns.some((u) => u.id.startsWith('health-unknown-') || u.id.startsWith('opportunity-unknown-')));
});

test('the opportunity unknown states Loop measures stake, not gain', () => {
  const intel = analyzeCallGrid(engineInput());
  const oppUnknown = intel.unknowns.find((u) => u.id.startsWith('opportunity-unknown-'));
  if (oppUnknown) {
    assert.match(oppUnknown.statement, /not what would be gained/i);
  }
});

test('the engine remains deterministic with health and opportunities added', () => {
  const input = engineInput();
  assert.deepEqual(
    JSON.parse(JSON.stringify(analyzeCallGrid(input))),
    JSON.parse(JSON.stringify(analyzeCallGrid(input))),
  );
});

test('every finding the engine emits, opportunities included, is well-formed', () => {
  const intel = analyzeCallGrid(engineInput());
  for (const f of intel.findings) assert.deepEqual(findingViolations(f), [], f.ruleId);
  for (const o of intel.opportunityFindings) assert.deepEqual(findingViolations(o.finding), [], o.finding.ruleId);
});
