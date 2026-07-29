import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  toDecisionSupportCard, buildDecisionSupport, byReviewPriority,
  reviewCategoryOf, evidenceStrengthOf, reviewPriorityOf,
  businessImpactOf, REVIEW_CATEGORIES, REVIEW_CATEGORY_LABEL,
  REVIEW_URGENCY_LABEL, EVIDENCE_STRENGTH_LABEL, REVIEW_URGENCY_RANK,
} from '../src/callgrid-decision-support';
import { scoreFinding } from '../src/callgrid-scoring';
import { analyzeCallGrid, analyzeDimension, type IntelligenceInput } from '../src/callgrid-intelligence-engine';
import { isSafeRecommendation, type CallGridFinding } from '../src/callgrid-intelligence';

const NOW = new Date('2026-07-29T14:15:00.000Z');

function finding(over: Partial<CallGridFinding> = {}): CallGridFinding {
  return {
    id: 'f1', findingType: 'CHANGE', title: 'Revenue declined',
    plainLanguageSummary: 'Revenue declined 18% against the prior completed period.',
    classification: 'DERIVED', severity: 'HIGH', confidence: 0.85,
    currentWindow: 'Yesterday', comparisonWindow: 'The day before',
    primaryMetric: 'revenue', currentValue: 820_000, comparisonValue: 1_000_000,
    absoluteChange: -180_000, percentageChange: -0.18,
    affectedEntities: [], drivers: [],
    supportingEvidence: [{
      id: 'f1:e1', findingId: 'f1', sourceType: 'call_projection', providerReport: 'CallGrid',
      metricKey: 'revenue', entityType: 'window', entityId: null, entityName: null,
      window: 'Yesterday', providerField: 'revenueCents', rawValue: null, normalizedValue: 820_000,
      derivedValue: null, formula: null, formulaVersion: null, classification: 'VERIFIED',
      completeness: 1, notes: null,
    }],
    limitations: ['Measured over a completed period.'],
    unknowns: ['Why revenue moved.'],
    recommendedReview: 'Review the buyer mix for this period.',
    recommendedActionType: null, actionTarget: null,
    actionSafety: 'SAFE_TO_REVIEW', createdAt: NOW.toISOString(),
    ruleId: 'revenue-change', ruleVersion: 'v1',
    ...over,
  };
}

const buyerEntity = (id: string) => ([{
  entityType: 'buyer' as const, entityId: id, entityName: id.toUpperCase(),
  currentValue: null, comparisonValue: null, absoluteChange: null,
  contributionToChange: null, currentShare: null, comparisonShare: null,
  currentRank: null, comparisonRank: null,
}]);

// --- Review categories ------------------------------------------------------------

test('every category has a label and the enum is complete', () => {
  for (const c of REVIEW_CATEGORIES) {
    assert.ok(REVIEW_CATEGORY_LABEL[c], `${c} has no label`);
  }
  assert.equal(REVIEW_CATEGORIES.length, 10);
});

test('data trustworthiness outranks the business question', () => {
  // If the measurement itself is in doubt, the review is about the data.
  const c = reviewCategoryOf(finding({ classification: 'UNKNOWN', unknowns: ['x'] }));
  assert.equal(c, 'DATA_QUALITY');
});

test('categories resolve from the rule and entity, not from wording', () => {
  assert.equal(reviewCategoryOf(finding({ ruleId: 'opportunity-diversification' })), 'COMMERCIAL');
  assert.equal(reviewCategoryOf(finding({ ruleId: 'anomaly-profit-divergence', primaryMetric: 'profit' })), 'FINANCIAL');
  assert.equal(reviewCategoryOf(finding({ ruleId: 'opportunity-efficiency-gap' })), 'SOURCE_QUALITY');
  assert.equal(reviewCategoryOf(finding({ ruleId: 'entity-dormant' })), 'OPERATIONAL_INVESTIGATION');
  assert.equal(reviewCategoryOf(finding({ ruleId: 'entity-contribution', affectedEntities: buyerEntity('b1') })), 'BUYER');
  assert.equal(reviewCategoryOf(finding({ ruleId: 'volume-change', primaryMetric: 'totalCalls' })), 'TRAFFIC_ALLOCATION');
});

test('rewording a finding cannot change its category', () => {
  const a = reviewCategoryOf(finding({ title: 'One phrasing' }));
  const b = reviewCategoryOf(finding({ title: 'A completely different phrasing', plainLanguageSummary: 'Other words.' }));
  assert.equal(a, b);
});

// --- Evidence strength ------------------------------------------------------------

test('an engine-declared INSUFFICIENT finding can never be upgraded here', () => {
  const s = evidenceStrengthOf(finding({ confidence: 0.95, actionSafety: 'INSUFFICIENT_EVIDENCE' }));
  assert.equal(s, 'INSUFFICIENT', 'this layer must not overrule the rule that produced the finding');
});

test('partial coverage caps evidence strength however tight the arithmetic', () => {
  const strong = finding({ confidence: 0.95 });
  assert.equal(evidenceStrengthOf(strong), 'HIGH');

  const halfCovered = finding({
    confidence: 0.95,
    supportingEvidence: [{ ...strong.supportingEvidence[0]!, completeness: 0.5 }],
  });
  assert.notEqual(evidenceStrengthOf(halfCovered), 'HIGH');
});

test('every evidence strength has a label', () => {
  for (const s of ['HIGH', 'MODERATE', 'LOW', 'INSUFFICIENT'] as const) {
    assert.ok(EVIDENCE_STRENGTH_LABEL[s]);
  }
});

// --- Review priority --------------------------------------------------------------

test('urgency requires trustworthy evidence — insufficient evidence is never Immediate', () => {
  const f = finding({ severity: 'CRITICAL', percentageChange: -0.9, actionSafety: 'INSUFFICIENT_EVIDENCE' });
  const p = reviewPriorityOf(f, evidenceStrengthOf(f), null);
  assert.equal(p, 'MONITOR', 'acting urgently on a number that may be wrong is worse than waiting');
});

test('a critical adverse move on high evidence is Immediate', () => {
  const f = finding({ severity: 'CRITICAL', percentageChange: -0.5, confidence: 0.9 });
  assert.equal(reviewPriorityOf(f, 'HIGH', null), 'IMMEDIATE');
});

test('good news is never urgent, however large', () => {
  const f = finding({
    findingType: 'OPPORTUNITY', severity: 'INFORMATIONAL',
    percentageChange: 4.0, absoluteChange: 9_000_000,
  });
  assert.equal(reviewPriorityOf(f, 'HIGH', null), 'INFORMATIONAL');
});

test('every urgency has a label and a stable rank', () => {
  for (const u of ['IMMEDIATE', 'TODAY', 'THIS_WEEK', 'MONITOR', 'INFORMATIONAL'] as const) {
    assert.ok(REVIEW_URGENCY_LABEL[u]);
    assert.equal(typeof REVIEW_URGENCY_RANK[u], 'number');
  }
});

// --- Business impact --------------------------------------------------------------

const impactCtx = (series: (number | null)[], periodsPerYear: number | null) =>
  ({ revenueSeries: series, periodsPerYear });

test('annualization is REFUSED without a series, and says why', () => {
  const i = businessImpactOf(finding(), null, impactCtx([], 365));
  assert.equal(i.annualizedCents, null);
  assert.ok(i.annualizationBasis && /withheld/i.test(i.annualizationBasis));
});

test('annualization is REFUSED when revenue is too volatile to project', () => {
  const volatile = [100_000, 900_000, 120_000, 850_000, 90_000];
  const i = businessImpactOf(finding(), null, impactCtx(volatile, 365));
  assert.equal(i.annualizedCents, null);
  assert.match(i.annualizationBasis!, /would not be defensible/i);
});

test('annualization is offered on a stable series, labelled a conditional projection', () => {
  const stable = [500_000, 505_000, 498_000, 502_000, 501_000];
  const i = businessImpactOf(finding(), null, impactCtx(stable, 365));
  assert.ok(i.annualizedCents !== null, 'a stable series supports a conditional annual figure');
  assert.match(i.annualizationBasis!, /if the current rate persists/i);
  assert.match(i.annualizationBasis!, /not a forecast/i);
});

test('an opportunity amount is exposure or a gap — never described as gain', () => {
  const opp = {
    finding: finding({ id: 'o1', ruleId: 'opportunity-diversification' }),
    estimatedImpactCents: 800_000,
    impactBasis: 'measured_exposure' as const,
    impactLabel: 'Revenue currently dependent on ACME',
    lever: 'Buyer mix',
  };
  const i = businessImpactOf(opp.finding, opp, impactCtx([], null));
  assert.equal(i.kind, 'revenue_exposure');
  assert.match(i.statement, /not what acting would gain/i);
  for (const banned of ['you would gain', 'expected gain', 'projected upside']) {
    assert.ok(!i.statement.toLowerCase().includes(banned));
  }
});

test('a volume change carries no money rather than an invented value', () => {
  const i = businessImpactOf(
    finding({ primaryMetric: 'totalCalls', absoluteChange: -120 }),
    null, impactCtx([], null),
  );
  assert.equal(i.amountCents, null);
  assert.match(i.statement, /cannot attach a value/i);
});

// --- The card ---------------------------------------------------------------------

test('observation and interpretation are separate, and observation is fact only', () => {
  const card = toDecisionSupportCard(finding());
  assert.notEqual(card.observation, card.interpretation);
  // The observation states measured values and windows, not a judgement.
  assert.match(card.observation, /revenue measured/i);
  assert.match(card.observation, /Yesterday/);
  assert.ok(!/therefore|appears|suggests|matters/i.test(card.observation));
});

test('observation is built from structured fields, so rewording cannot drift it', () => {
  const a = toDecisionSupportCard(finding());
  const b = toDecisionSupportCard(finding({ plainLanguageSummary: 'Totally different prose here.' }));
  assert.equal(a.observation, b.observation);
});

test('missing information is first-class and merges unknowns with limitations', () => {
  const card = toDecisionSupportCard(finding({
    unknowns: ['Why revenue moved.'],
    limitations: ['Coverage was partial.'],
  }));
  assert.ok(card.missingInformation.includes('Why revenue moved.'));
  assert.ok(card.missingInformation.includes('Coverage was partial.'));
});

test('measured facts come only from evidence — Loop owns the facts', () => {
  const card = toDecisionSupportCard(finding());
  assert.equal(card.measuredFacts.length, finding().supportingEvidence.length);
  const fact = card.measuredFacts[0]!;
  assert.equal(fact.metric, 'revenue');
  assert.equal(fact.reported, true, 'VERIFIED evidence is reported by the provider');
});

test('business judgment is the operator\'s, and is never phrased as an instruction', () => {
  const card = toDecisionSupportCard(finding());
  assert.ok(card.businessJudgment.length > 0);
  for (const j of card.businessJudgment) {
    assert.ok(
      !/^(increase|reduce|pause|expand|stop|launch)\b/i.test(j.trim()),
      `business judgment must not be an instruction: "${j}"`,
    );
  }
});

test('the recommended review keeps the safe review vocabulary', () => {
  const card = toDecisionSupportCard(finding());
  assert.ok(card.recommendedReview);
  assert.ok(isSafeRecommendation(card.recommendedReview!));
});

test('cards order by review priority, then evidence strength, and are stable', () => {
  const immediate = finding({ id: 'a', severity: 'CRITICAL', percentageChange: -0.6, confidence: 0.9 });
  const monitor = finding({ id: 'b', severity: 'NOTABLE', findingType: 'CONCENTRATION', percentageChange: null });
  const first = buildDecisionSupport([{ finding: immediate }, { finding: monitor }]);
  const second = buildDecisionSupport([{ finding: monitor }, { finding: immediate }]);
  assert.deepEqual(first.map((c) => c.findingId), second.map((c) => c.findingId));
  assert.equal(first[0]!.findingId, 'a');
});

test('byReviewPriority is a total order with no ties left to chance', () => {
  const a = toDecisionSupportCard(finding({ id: 'aaa' }));
  const b = toDecisionSupportCard(finding({ id: 'bbb' }));
  assert.equal(byReviewPriority(a, b) < 0, true);
  assert.equal(byReviewPriority(b, a) > 0, true);
});

test('the card carries its version so a conclusion stays reproducible', () => {
  const card = toDecisionSupportCard(finding(), { score: scoreFinding({
    finding: finding(), recurrenceCount: null, recurrenceWindow: null, windowRevenueCents: 1_000_000,
  }) });
  assert.ok(card.version);
  assert.ok(card.score);
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

test('the engine emits decision support for every ranked finding', () => {
  const intel = analyzeCallGrid(engineInput());
  assert.equal(intel.decisionSupport.length, intel.ranked.length);
});

test('engine decision support is ordered by review priority', () => {
  const intel = analyzeCallGrid(engineInput());
  const ranks = intel.decisionSupport.map((c) => REVIEW_URGENCY_RANK[c.reviewPriority]);
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b));
});

test('every engine card separates fact from judgment and states missing information', () => {
  const intel = analyzeCallGrid(engineInput());
  assert.ok(intel.decisionSupport.length > 0);
  for (const c of intel.decisionSupport) {
    assert.ok(c.observation.length > 0, `${c.findingId} has no observation`);
    assert.ok(c.interpretation.length > 0, `${c.findingId} has no interpretation`);
    assert.ok(c.measuredFacts.length > 0, `${c.findingId} has no measured facts`);
    assert.ok(c.businessJudgment.length > 0, `${c.findingId} has no business judgment`);
    assert.ok(c.missingInformation.length > 0, `${c.findingId} states nothing missing`);
    assert.ok(REVIEW_CATEGORY_LABEL[c.category], `${c.findingId} has no category`);
  }
});

test('no engine card issues an imperative operational instruction', () => {
  const intel = analyzeCallGrid(engineInput());
  const banned = /\b(increase|reduce|pause|expand|stop|launch|reroute|boost|scale)\b/i;
  for (const c of intel.decisionSupport) {
    if (c.recommendedReview) {
      assert.ok(!banned.test(c.recommendedReview), `${c.findingId}: "${c.recommendedReview}"`);
      assert.ok(isSafeRecommendation(c.recommendedReview));
    }
    for (const j of c.businessJudgment) {
      assert.ok(!banned.test(j.split(' ')[0] ?? ''), `${c.findingId} judgment opens with an imperative: "${j}"`);
    }
  }
});

test('a live window suppresses annualization entirely', () => {
  const intel = analyzeCallGrid(engineInput({ includesLiveData: true, periodsPerYear: null }));
  for (const c of intel.decisionSupport) {
    assert.equal(c.businessImpact.annualizedCents, null, 'a partial period must never be projected to a year');
  }
});

test('dimension pages emit the same decision support projection', () => {
  const buyers = analyzeDimension(engineInput(), 'buyers');
  assert.ok(Array.isArray(buyers.decisionSupport));
  const ranks = buyers.decisionSupport.map((c) => REVIEW_URGENCY_RANK[c.reviewPriority]);
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b));
});

test('decision support is deterministic', () => {
  const input = engineInput();
  assert.deepEqual(
    JSON.parse(JSON.stringify(analyzeCallGrid(input).decisionSupport)),
    JSON.parse(JSON.stringify(analyzeCallGrid(input).decisionSupport)),
  );
});
