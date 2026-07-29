// The CallGrid Intelligence Engine — deterministic behaviour, evidence
// guarantees, and the wording rules that keep a conclusion inside its evidence.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeCallGrid, analyzeDimension, allFindingViolations,
  findingViolations, isSafeRecommendation, gradeSeverity, escalate, capSeverity,
  deriveConfidence, significanceRule, CALLGRID_SIGNIFICANCE_RULES,
  FORBIDDEN_RECOMMENDATION_VERBS,
  type IntelligenceInput, type IntelligenceDimRow, type IntelligenceMetrics,
} from '../src/index';

const NOW = new Date('2026-07-22T18:30:00.000Z');

function metrics(over: Partial<IntelligenceMetrics> = {}): IntelligenceMetrics {
  return {
    available: true,
    totalCalls: 400,
    billableCalls: 200,
    revenueCents: 1_000_000,
    profitCents: 300_000,
    revenueCoverage: 1,
    profitCoverage: 1,
    ...over,
  };
}

function row(key: string, revenueCents: number | null, calls = 50, monetized = 25): IntelligenceDimRow {
  return {
    key,
    label: key.toUpperCase(),
    calls,
    monetized,
    converted: monetized,
    revenueCents,
    payoutCents: revenueCents === null ? null : Math.round(revenueCents * 0.5),
    costCents: revenueCents === null ? null : Math.round(revenueCents * 0.1),
    marginCents: revenueCents === null ? null : Math.round(revenueCents * 0.4),
    revenueCoverage: revenueCents === null ? 0 : 1,
  };
}

function input(over: Partial<IntelligenceInput> = {}): IntelligenceInput {
  const empty = { buyers: [], vendors: [], sources: [], campaigns: [] };
  return {
    now: NOW,
    reportOk: true,
    windowLabel: 'Today · Live',
    comparisonLabel: 'Yesterday · through 2:30 PM',
    comparisonBasis: 'elapsed_matched',
    includesLiveData: true,
    metrics: metrics(),
    comparison: metrics(),
    dimensions: { ...empty },
    comparisonDimensions: { ...empty },
    ...over,
  };
}

// --- Structural guarantees -----------------------------------------------------

test('no finding may exist without evidence, limitations and a rule version', () => {
  const result = analyzeCallGrid(input({
    metrics: metrics({ revenueCents: 690_000, totalCalls: 300, billableCalls: 150, profitCents: 150_000 }),
    comparison: metrics({ revenueCents: 1_000_000, totalCalls: 400, billableCalls: 200, profitCents: 300_000 }),
    dimensions: { buyers: [row('marklytek', 300_000), row('acme', 250_000), row('zenith', 140_000)], vendors: [], sources: [], campaigns: [] },
    comparisonDimensions: { buyers: [row('marklytek', 500_000), row('acme', 300_000), row('zenith', 200_000)], vendors: [], sources: [], campaigns: [] },
  }));
  assert.ok(result.findings.length > 0, 'expected findings for a material decline');
  assert.deepEqual(allFindingViolations(result.findings), []);
  for (const f of result.findings) {
    assert.ok(f.supportingEvidence.length > 0, `${f.id} has no evidence`);
    assert.ok(f.ruleId && f.ruleVersion, `${f.id} has no rule identity`);
    assert.ok(f.limitations.length > 0, `${f.id} states no limitations`);
    assert.ok(significanceRule(f.ruleId), `${f.id} cites unregistered rule ${f.ruleId}`);
  }
});

test('every finding is reproducible: the same input yields identical output', () => {
  const i = input({
    metrics: metrics({ revenueCents: 600_000 }),
    dimensions: { buyers: [row('a', 400_000), row('b', 200_000)], vendors: [], sources: [], campaigns: [] },
    comparisonDimensions: { buyers: [row('a', 700_000), row('b', 300_000)], vendors: [], sources: [], campaigns: [] },
  });
  assert.deepEqual(JSON.stringify(analyzeCallGrid(i)), JSON.stringify(analyzeCallGrid(i)));
});

test('severity comes from the registry ladder, never from a magnitude alone', () => {
  assert.equal(gradeSeverity(0.05, [0.1, 0.25, 0.4]), null); // below the floor: silent
  assert.equal(gradeSeverity(-0.12, [0.1, 0.25, 0.4]), 'NOTABLE');
  assert.equal(gradeSeverity(-0.31, [0.1, 0.25, 0.4]), 'HIGH');
  assert.equal(gradeSeverity(-0.55, [0.1, 0.25, 0.4]), 'CRITICAL');
  assert.equal(gradeSeverity(0.9, [0.15, 0.3, null]), 'HIGH'); // no CRITICAL rung
  assert.equal(escalate('NOTABLE'), 'HIGH');
  // A cap lowers a severity to the ceiling and leaves anything below it alone.
  assert.equal(capSeverity('CRITICAL', 'HIGH'), 'HIGH');
  assert.equal(capSeverity('INFORMATIONAL', 'HIGH'), 'INFORMATIONAL');
});

test('every registered rule declares its thresholds, suppressions and reasoning', () => {
  for (const r of CALLGRID_SIGNIFICANCE_RULES) {
    assert.match(r.version, /^v\d+$/, r.ruleId);
    assert.ok(r.minimumDataRequirements.length > 0, r.ruleId);
    assert.ok(r.severityLogic.length > 0, r.ruleId);
    assert.ok(r.suppressionConditions.length > 0, `${r.ruleId} must say when it stays silent`);
    assert.ok(r.explanation.length > 20, r.ruleId);
    assert.ok(r.minimumVolume > 0, r.ruleId);
  }
});

// --- Suppression ------------------------------------------------------------------

test('a large percentage swing on a tiny base is suppressed', () => {
  const result = analyzeCallGrid(input({
    // 300% up, but on $30 and 4 calls.
    metrics: metrics({ revenueCents: 12_000, totalCalls: 5, billableCalls: 3, profitCents: 4_000 }),
    comparison: metrics({ revenueCents: 3_000, totalCalls: 4, billableCalls: 2, profitCents: 1_000 }),
  }));
  assert.equal(result.findings.filter((f) => f.primaryMetric === 'revenue').length, 0);
  assert.match(result.executiveSummary.headline, /No change large enough to flag/);
});

test('a change is suppressed when revenue coverage is too low to trust the totals', () => {
  const result = analyzeCallGrid(input({
    metrics: metrics({ revenueCents: 400_000, revenueCoverage: 0.2 }),
    comparison: metrics({ revenueCents: 1_000_000 }),
  }));
  assert.equal(result.findings.filter((f) => f.primaryMetric === 'revenue').length, 0);
  assert.ok(result.unknowns.some((u) => u.id === 'unknown:revenue-coverage'));
});

test('no percentage change is reported against a zero or unknown baseline', () => {
  const zeroBase = analyzeCallGrid(input({
    metrics: metrics({ revenueCents: 500_000 }),
    comparison: metrics({ revenueCents: 0 }),
  }));
  assert.equal(zeroBase.findings.filter((f) => f.primaryMetric === 'revenue').length, 0);

  const unknownBase = analyzeCallGrid(input({
    metrics: metrics({ revenueCents: 500_000 }),
    comparison: metrics({ revenueCents: null }),
  }));
  assert.equal(unknownBase.findings.filter((f) => f.primaryMetric === 'revenue').length, 0);
});

test('with no comparison period, no change finding is produced and the gap is disclosed', () => {
  const result = analyzeCallGrid(input({ comparison: null, comparisonLabel: null, comparisonBasis: 'none' }));
  assert.equal(result.changes.length, 0);
  assert.ok(result.unknowns.some((u) => u.id === 'unknown:no-comparison'));
});

test('a failed read produces no findings and says so, rather than showing zeros', () => {
  const result = analyzeCallGrid(input({
    reportOk: false,
    metrics: { available: false, totalCalls: null, billableCalls: null, revenueCents: null, profitCents: null, revenueCoverage: null, profitCoverage: null },
  }));
  assert.equal(result.findings.length, 0);
  assert.match(result.executiveSummary.headline, /could not be read/);
  assert.ok(result.unknowns.some((u) => u.id === 'unknown:read-failed'));
});

// --- Contribution: arithmetic and wording --------------------------------------------

test('contribution analysis sums correctly and names the largest contributor', () => {
  const result = analyzeCallGrid(input({
    // Window revenue falls by $5,000 (500,000 cents).
    metrics: metrics({ revenueCents: 500_000, totalCalls: 200, billableCalls: 100 }),
    comparison: metrics({ revenueCents: 1_000_000, totalCalls: 400, billableCalls: 200 }),
    dimensions: { buyers: [row('marklytek', 190_000), row('acme', 310_000)], vendors: [], sources: [], campaigns: [] },
    // Marklytek falls 500k→190k (-310k = 62% of the -500k move); acme 500k→310k.
    comparisonDimensions: { buyers: [row('marklytek', 500_000), row('acme', 500_000)], vendors: [], sources: [], campaigns: [] },
  }));
  const driver = result.drivers.find((f) => f.id === 'driver:buyers:marklytek');
  assert.ok(driver, 'expected Marklytek to be identified as a contributor');
  assert.ok(Math.abs(driver!.affectedEntities[0]!.contributionToChange! - 0.62) < 0.001);
  assert.match(driver!.title, /62% of the decline/);
});

test('a contributor is never described as having caused the change', () => {
  const result = analyzeCallGrid(input({
    metrics: metrics({ revenueCents: 500_000 }),
    comparison: metrics({ revenueCents: 1_000_000 }),
    dimensions: { buyers: [row('big', 100_000)], vendors: [], sources: [], campaigns: [] },
    comparisonDimensions: { buyers: [row('big', 600_000)], vendors: [], sources: [], campaigns: [] },
  }));
  for (const f of result.findings) {
    const text = `${f.title} ${f.plainLanguageSummary}`;
    assert.doesNotMatch(text, /\bcaused\b|\bbecause of\b|\bdue to\b|\bresulted in\b/i, `${f.id}: ${text}`);
  }
  const driver = result.drivers[0];
  assert.ok(driver);
  assert.match(driver!.plainLanguageSummary, /contribution, not cause/);
});

test('an entity absent from a window contributes a proven zero, not an unknown', () => {
  const result = analyzeCallGrid(input({
    metrics: metrics({ revenueCents: 400_000 }),
    comparison: metrics({ revenueCents: 1_000_000 }),
    // "gone" existed before and is absent now — the whole window was read, so 0 is proven.
    dimensions: { buyers: [row('stays', 400_000)], vendors: [], sources: [], campaigns: [] },
    comparisonDimensions: { buyers: [row('stays', 400_000), row('gone', 600_000, 40, 20)], vendors: [], sources: [], campaigns: [] },
  }));
  const driver = result.drivers.find((f) => f.id === 'driver:buyers:gone');
  assert.ok(driver, 'an entity that disappeared should be a contributor to the decline');
  assert.equal(driver!.affectedEntities[0]!.currentValue, 0);
  assert.equal(driver!.affectedEntities[0]!.absoluteChange, -600_000);
});

test('an entity present but unpriced is excluded from revenue arithmetic, not counted as zero', () => {
  const result = analyzeDimension(input({
    metrics: metrics({ revenueCents: 400_000 }),
    comparison: metrics({ revenueCents: 500_000 }),
    dimensions: { buyers: [row('priced', 400_000), row('unpriced', null, 30, 10)], vendors: [], sources: [], campaigns: [] },
    comparisonDimensions: { buyers: [row('priced', 500_000), row('unpriced', null, 30, 10)], vendors: [], sources: [], campaigns: [] },
  }), 'buyers');
  const unpriced = result.contributions.find((c) => c.entityId === 'unpriced');
  assert.ok(unpriced);
  assert.equal(unpriced!.currentValue, null); // Unknown, never 0
  assert.equal(unpriced!.absoluteChange, null);
});

// --- Inference rules -------------------------------------------------------------

test('a volume-driven decline requires stable value-per-call evidence and is labelled INFERRED', () => {
  const result = analyzeCallGrid(input({
    // Revenue -50%, calls -50%, revenue per billable call unchanged at $50.
    metrics: metrics({ revenueCents: 500_000, totalCalls: 200, billableCalls: 100, profitCents: 150_000 }),
    comparison: metrics({ revenueCents: 1_000_000, totalCalls: 400, billableCalls: 200, profitCents: 300_000 }),
  }));
  const inf = result.findings.find((f) => f.id === 'inference:volume-value');
  assert.ok(inf);
  assert.equal(inf!.classification, 'INFERRED');
  assert.match(inf!.plainLanguageSummary, /volume-driven rather than price-driven/);
  // The inference must cite the verified metrics it rests on.
  const cited = inf!.supportingEvidence.map((e) => e.metricKey);
  assert.ok(cited.includes('revenue') && cited.includes('totalCalls') && cited.includes('revenuePerBillableCall'));
});

test('a margin concern is withheld when profit coverage cannot support it', () => {
  const shape = {
    // Revenue flat, profit down 50% — a margin story, if profit were trustworthy.
    metrics: metrics({ revenueCents: 1_000_000, profitCents: 150_000, profitCoverage: 0.2 }),
    comparison: metrics({ revenueCents: 1_000_000, profitCents: 300_000, profitCoverage: 0.2 }),
  };
  const withheld = analyzeCallGrid(input(shape));
  assert.equal(withheld.findings.filter((f) => f.findingType === 'MARGIN').length, 0);
  assert.ok(withheld.unknowns.some((u) => u.id === 'unknown:profit-coverage'));

  // The same shape with full coverage does produce it — proving the gate, not the absence.
  const supported = analyzeCallGrid(input({
    metrics: metrics({ revenueCents: 1_000_000, profitCents: 150_000 }),
    comparison: metrics({ revenueCents: 1_000_000, profitCents: 300_000 }),
  }));
  assert.ok(supported.findings.some((f) => f.findingType === 'MARGIN'));
});

test('billable efficiency is never described as call quality', () => {
  const result = analyzeCallGrid(input({
    metrics: metrics({ totalCalls: 400, billableCalls: 100 }),
    comparison: metrics({ totalCalls: 400, billableCalls: 200 }),
  }));
  const eff = result.findings.find((f) => f.id === 'efficiency:billable-rate');
  assert.ok(eff);
  assert.doesNotMatch(eff!.plainLanguageSummary, /quality/i);
  assert.ok(eff!.limitations.some((l) => /not a measure of call quality/i.test(l)));
});

test('billable efficiency is suppressed on a small sample', () => {
  const result = analyzeCallGrid(input({
    metrics: metrics({ totalCalls: 20, billableCalls: 5 }),
    comparison: metrics({ totalCalls: 20, billableCalls: 15 }),
  }));
  assert.equal(result.findings.filter((f) => f.id === 'efficiency:billable-rate').length, 0);
});

// --- Concentration ----------------------------------------------------------------

test('concentration uses the configured thresholds and describes dependency, not fault', () => {
  const result = analyzeCallGrid(input({
    dimensions: { buyers: [row('whale', 580_000), row('small', 420_000)], vendors: [], sources: [], campaigns: [] },
    comparisonDimensions: { buyers: [row('whale', 500_000), row('small', 500_000)], vendors: [], sources: [], campaigns: [] },
    metrics: metrics({ revenueCents: 1_000_000 }),
  }));
  const conc = result.findings.find((f) => f.id === 'concentration:buyers');
  assert.ok(conc);
  assert.equal(conc!.severity, 'HIGH'); // 58% clears the 55% rung
  assert.match(conc!.plainLanguageSummary, /not a problem in itself/);
  assert.doesNotMatch(conc!.plainLanguageSummary, /will leave|risk of losing/i);
});

test('a single-entity dimension produces no concentration finding', () => {
  const result = analyzeCallGrid(input({
    dimensions: { buyers: [row('only', 1_000_000)], vendors: [], sources: [], campaigns: [] },
    comparisonDimensions: { buyers: [row('only', 1_000_000)], vendors: [], sources: [], campaigns: [] },
  }));
  assert.equal(result.findings.filter((f) => f.findingType === 'CONCENTRATION').length, 0);
});

// --- Lifecycle --------------------------------------------------------------------

test('an inactive former producer requires prior activity and never claims a cap event', () => {
  const result = analyzeCallGrid(input({
    dimensions: { buyers: [row('active', 400_000)], vendors: [], sources: [], campaigns: [] },
    comparisonDimensions: { buyers: [row('active', 400_000), row('vanished', 600_000, 40, 20)], vendors: [], sources: [], campaigns: [] },
  }));
  const gone = result.findings.find((f) => f.id === 'inactive:buyers:vanished');
  assert.ok(gone);
  assert.equal(gone!.findingType, 'RISK');
  // The forbidden claims: cap reached, paused, stopped buying.
  assert.doesNotMatch(gone!.plainLanguageSummary, /cap|paused|stopped buying|capacity/i);
  assert.ok(gone!.unknowns.some((u) => /capacity|cap|schedule/i.test(u)));
});

test('rank movement uses the same ranked rows and only fires on a top-five crossing', () => {
  const many = (n: number, base: number) => Array.from({ length: n }, (_, i) => row(`e${i}`, base - i * 10_000, 30, 15));
  const cur = many(12, 200_000);
  const pri = many(12, 200_000);
  // e10 was #11, now promote it to #2 by revenue.
  cur[10] = row('e10', 195_000, 30, 15);
  const result = analyzeCallGrid(input({
    dimensions: { buyers: [...cur].sort((a, b) => (b.revenueCents ?? 0) - (a.revenueCents ?? 0)), vendors: [], sources: [], campaigns: [] },
    comparisonDimensions: { buyers: pri, vendors: [], sources: [], campaigns: [] },
  }));
  const rank = result.findings.find((f) => f.id === 'rank:buyers:e10');
  assert.ok(rank, 'expected a top-five crossing to be reported');
  assert.equal(rank!.primaryMetric, 'rankChange');
  assert.ok(rank!.supportingEvidence.some((e) => /same revenue-ranked/.test(e.notes ?? '')));
});

// --- Recommendation safety -----------------------------------------------------------

test('every recommendation uses an approved review verb', () => {
  const result = analyzeCallGrid(input({
    metrics: metrics({ revenueCents: 500_000, totalCalls: 200, billableCalls: 80 }),
    comparison: metrics({ revenueCents: 1_000_000, totalCalls: 400, billableCalls: 200 }),
    dimensions: { buyers: [row('a', 300_000), row('b', 200_000)], vendors: [], sources: [], campaigns: [] },
    comparisonDimensions: { buyers: [row('a', 700_000), row('b', 300_000)], vendors: [], sources: [], campaigns: [] },
  }));
  const recs = result.findings.map((f) => f.recommendedReview).filter((r): r is string => r !== null);
  assert.ok(recs.length > 0);
  for (const r of recs) {
    assert.ok(isSafeRecommendation(r), `unsafe recommendation: "${r}"`);
    for (const verb of FORBIDDEN_RECOMMENDATION_VERBS) {
      assert.doesNotMatch(r, new RegExp(`^${verb}\\b`), `recommendation opens with "${verb}": ${r}`);
    }
  }
});

test('no finding promises a revenue outcome or guarantees a result', () => {
  const result = analyzeCallGrid(input({
    metrics: metrics({ revenueCents: 500_000 }),
    comparison: metrics({ revenueCents: 1_000_000 }),
    dimensions: { buyers: [row('a', 500_000)], vendors: [], sources: [], campaigns: [] },
    comparisonDimensions: { buyers: [row('a', 1_000_000)], vendors: [], sources: [], campaigns: [] },
  }));
  for (const f of result.findings) {
    const text = `${f.title} ${f.plainLanguageSummary} ${f.recommendedReview ?? ''}`;
    assert.doesNotMatch(text, /will increase|guarantee|recover \$|recoverable revenue|lost revenue of/i, f.id);
  }
});

test('the violation checker rejects a malformed finding', () => {
  const bad = {
    id: 'x', findingType: 'CHANGE', title: 't', plainLanguageSummary: 's',
    classification: 'DERIVED', severity: 'NOTABLE', confidence: 0.5,
    currentWindow: 'w', comparisonWindow: null, primaryMetric: 'revenue',
    currentValue: null, comparisonValue: null, absoluteChange: null, percentageChange: null,
    affectedEntities: [], drivers: [], supportingEvidence: [], limitations: [],
    unknowns: [], recommendedReview: 'Increase the bid immediately',
    recommendedActionType: null, actionTarget: null, actionSafety: 'SAFE_TO_REVIEW',
    createdAt: NOW.toISOString(), ruleId: '', ruleVersion: '',
  } as never;
  const problems = findingViolations(bad);
  assert.ok(problems.includes('no supporting evidence'));
  assert.ok(problems.includes('no ruleId'));
  assert.ok(problems.includes('no stated limitations'));
  assert.ok(problems.some((p) => /unsafe recommendation verb/.test(p)));
});

// --- Live windows -----------------------------------------------------------------

test('an in-progress window states the comparison is elapsed-matched but still partial', () => {
  const result = analyzeCallGrid(input({
    metrics: metrics({ revenueCents: 500_000 }),
    comparison: metrics({ revenueCents: 1_000_000 }),
  }));
  const change = result.findings.find((f) => f.primaryMetric === 'revenue');
  assert.ok(change);
  assert.ok(change!.limitations.some((l) => /same point.*equal elapsed time|equal elapsed time/.test(l)));
  assert.ok(result.unknowns.some((u) => u.id === 'unknown:in-progress'));
});

test('a completed window carries no in-progress caveat', () => {
  const result = analyzeCallGrid(input({
    includesLiveData: false,
    comparisonBasis: 'complete_period',
    windowLabel: 'Yesterday · Completed',
    metrics: metrics({ revenueCents: 500_000 }),
    comparison: metrics({ revenueCents: 1_000_000 }),
  }));
  assert.ok(!result.unknowns.some((u) => u.id === 'unknown:in-progress'));
  const change = result.findings.find((f) => f.primaryMetric === 'revenue');
  assert.ok(!change!.limitations.some((l) => /still in progress/.test(l)));
});

// --- Confidence ---------------------------------------------------------------------

test('confidence is deterministic and falls with partial coverage and thin samples', () => {
  const full = deriveConfidence(1, 400, 10);
  const partial = deriveConfidence(0.5, 400, 10);
  const thin = deriveConfidence(1, 10, 10);
  assert.ok(full > partial, 'partial coverage must reduce confidence');
  assert.ok(full > thin, 'a thin sample must reduce confidence');
  assert.ok(full <= 0.95, 'confidence never claims certainty');
  assert.equal(deriveConfidence(1, 400, 10), deriveConfidence(1, 400, 10));
});

// --- Unknowns -----------------------------------------------------------------------

test('unknown revenue over real calls is disclosed as unknown, never as zero', () => {
  const result = analyzeCallGrid(input({
    metrics: metrics({ revenueCents: null, revenueCoverage: 0, totalCalls: 120 }),
    comparison: metrics({ revenueCents: null, revenueCoverage: 0 }),
  }));
  assert.ok(result.unknowns.some((u) => u.id === 'unknown:revenue'));
  assert.equal(result.findings.filter((f) => f.primaryMetric === 'revenue').length, 0);
});

test('the product always discloses that it cannot determine causation, or the roster', () => {
  const result = analyzeCallGrid(input());
  assert.ok(result.unknowns.some((u) => u.id === 'unknown:causation'));
  assert.ok(result.unknowns.some((u) => u.id === 'unknown:roster'));
});

// --- Dimension scope ------------------------------------------------------------------

test('a dimension page and the overview share one analysis path', () => {
  const i = input({
    metrics: metrics({ revenueCents: 500_000 }),
    comparison: metrics({ revenueCents: 1_000_000 }),
    dimensions: { buyers: [row('a', 200_000), row('b', 300_000)], vendors: [], sources: [], campaigns: [] },
    comparisonDimensions: { buyers: [row('a', 700_000), row('b', 300_000)], vendors: [], sources: [], campaigns: [] },
  });
  const overview = analyzeCallGrid(i).drivers.filter((f) => f.id.startsWith('driver:buyers:'));
  const page = analyzeDimension(i, 'buyers').findings.filter((f) => f.id.startsWith('driver:buyers:'));
  assert.deepEqual(overview.map((f) => f.id), page.map((f) => f.id));
  assert.deepEqual(
    overview.map((f) => f.affectedEntities[0]!.absoluteChange),
    page.map((f) => f.affectedEntities[0]!.absoluteChange),
  );
});

test('campaign and vendor pages disclose that profit is not attributable at their grain', () => {
  for (const dim of ['campaigns', 'vendors'] as const) {
    const r = analyzeDimension(input(), dim);
    assert.ok(r.unknowns.some((u) => /not reliably attributable/.test(u.statement)), dim);
  }
});

test('dimension contributions are ranked by how much they moved', () => {
  const r = analyzeDimension(input({
    metrics: metrics({ revenueCents: 500_000 }),
    comparison: metrics({ revenueCents: 1_000_000 }),
    dimensions: { buyers: [row('small', 290_000), row('big', 210_000)], vendors: [], sources: [], campaigns: [] },
    comparisonDimensions: { buyers: [row('small', 300_000), row('big', 700_000)], vendors: [], sources: [], campaigns: [] },
  }), 'buyers');
  assert.equal(r.contributions[0]!.entityId, 'big'); // -490k beats -10k
  assert.equal(r.contributions[0]!.absoluteChange, -490_000);
});

test('the executive summary shows at most three drivers and three reviews', () => {
  const rows = (revs: number[]) => revs.map((v, i) => row(`e${i}`, v, 40, 20));
  const result = analyzeCallGrid(input({
    metrics: metrics({ revenueCents: 400_000 }),
    comparison: metrics({ revenueCents: 2_000_000 }),
    dimensions: { buyers: rows([100_000, 100_000, 100_000, 100_000]), vendors: [], sources: [], campaigns: [] },
    comparisonDimensions: { buyers: rows([500_000, 500_000, 500_000, 500_000]), vendors: [], sources: [], campaigns: [] },
  }));
  assert.ok(result.executiveSummary.drivers.length <= 3);
  assert.ok(result.executiveSummary.recommendedReviews.length <= 3);
});
