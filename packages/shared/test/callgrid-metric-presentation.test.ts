// What a situation's "What happened" says, and the Measured values beside it: a
// metric's name (never its key), its value in its unit (never a raw fraction or
// cents), and a comparison worded as what the rule actually compared against.
//
// REGRESSION (PR #300 review): the situation page read
//   "billableRate measured 0.332 in Today · Live against 0.249 in Yesterday · through 7:51 PM."

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  BID_REJECTION_CLASSIFICATIONS,
  RULE_COMPARISONS,
  analyzeBidSnapshotChange,
  analyzeBids,
  analyzeCallGrid,
  comparisonPhrase,
  formatEvidenceValue,
  historyEntityKey,
  humanizeFormula,
  measuredValuesOf,
  metricLabel,
  observationSentence,
  periodPhrase,
  type BidIntelligenceInput,
  type CallGridEvidenceReference,
  type CallGridFinding,
  type HistoryPoint,
  type IntelligenceInput,
} from '../src/index';

const NOW = new Date('2026-09-18T23:10:00.000Z');
const SRC = join(__dirname, '..', 'src');

function ev(over: Partial<CallGridEvidenceReference>): CallGridEvidenceReference {
  return {
    id: 'f:e1', findingId: 'f', sourceType: 'call_projection', providerReport: 'CallGrid',
    metricKey: 'revenue', entityType: 'window', entityId: null, entityName: null,
    window: 'Today · Live', providerField: null, rawValue: null, normalizedValue: null,
    derivedValue: null, formula: null, formulaVersion: null, classification: 'DERIVED',
    completeness: 1, notes: null,
    ...over,
  };
}

function finding(over: Partial<CallGridFinding>): CallGridFinding {
  return {
    id: 'f', findingType: 'CHANGE', title: 'A title', plainLanguageSummary: 'A summary.',
    classification: 'DERIVED', severity: 'NOTABLE', confidence: 0.8,
    currentWindow: 'Today · Live', comparisonWindow: 'Yesterday · through 9:09 PM',
    primaryMetric: 'revenue', currentValue: null, comparisonValue: null,
    absoluteChange: null, percentageChange: null, affectedEntities: [], drivers: [],
    supportingEvidence: [], limitations: [], unknowns: [], recommendedReview: null,
    recommendedActionType: null, actionTarget: null, actionSafety: 'SAFE_TO_REVIEW',
    createdAt: NOW.toISOString(), ruleId: 'revenue-change', ruleVersion: 'v1',
    ...over,
  };
}

// Internal keys and raw fractions, as they could leak into prose.
const CAMEL_KEY = /\b[a-z]+[A-Z][A-Za-z]*\b/;
const RAW_FRACTION = /(?<![\d$.,])0\.\d+(?![\d%])/;
function assertReadable(text: string, where: string) {
  assert.doesNotMatch(text, CAMEL_KEY, `${where}: an internal key in "${text}"`);
  assert.doesNotMatch(text, RAW_FRACTION, `${where}: a raw fraction in "${text}"`);
  assert.doesNotMatch(text, / measured \d/, `${where}: the old "X measured N" form in "${text}"`);
}

// --- The shipped case --------------------------------------------------------------------

test('REGRESSION: the billable-rate situation reads as a sentence, with percentages and a truthful comparison', () => {
  const f = finding({
    id: 'efficiency:billable-rate', findingType: 'OPERATIONAL', ruleId: 'billable-efficiency',
    primaryMetric: 'billableRate', currentValue: 0.332, comparisonValue: 0.249, percentageChange: 0.333,
    currentWindow: 'Today · Live', comparisonWindow: 'Yesterday · through 7:51 PM',
    supportingEvidence: [
      ev({ metricKey: 'billableCalls', window: 'Today · Live', normalizedValue: 112 }),
      ev({ metricKey: 'totalCalls', window: 'Today · Live', normalizedValue: 337 }),
      ev({ metricKey: 'billableRate', window: 'Today · Live', derivedValue: 0.332, formula: 'billableCalls / totalCalls' }),
    ],
  });
  assert.equal(observationSentence(f), 'Billable rate increased from 25% to 33% compared with yesterday through 7:51 PM.');
  const m = measuredValuesOf(f)!;
  assert.deepEqual(m, {
    subject: 'Billable rate',
    current: { label: 'Today · Live', value: '33%' },
    comparison: { label: 'Yesterday · through 7:51 PM', value: '25%' },
  });
});

// --- Metric families -----------------------------------------------------------------------

test('money: cents read as dollars, with cents only when the dollars alone would hide the move', () => {
  const revenue = finding({
    primaryMetric: 'revenue', currentValue: 820_000, comparisonValue: 1_000_000,
    currentWindow: 'Yesterday · Completed', comparisonWindow: 'Previous Day',
    supportingEvidence: [ev({ metricKey: 'revenue', window: 'Yesterday · Completed', normalizedValue: 820_000 })],
  });
  assert.equal(observationSentence(revenue), 'Revenue decreased from $10,000 to $8,200 compared with the previous day.');

  const profit = finding({
    ruleId: 'profit-change', primaryMetric: 'profit', currentValue: 158_100, comparisonValue: 141_400,
    supportingEvidence: [ev({ metricKey: 'profit', normalizedValue: 158_100 })],
  });
  assert.equal(observationSentence(profit), 'Net profit increased from $1,414 to $1,581 compared with yesterday through 9:09 PM.');

  const perCall = finding({
    ruleId: 'value-per-call', primaryMetric: 'revenuePerBillableCall', currentValue: 2_540, comparisonValue: 2_510,
    comparisonWindow: 'Prior Week', currentWindow: 'Last Week',
    supportingEvidence: [ev({ metricKey: 'revenuePerBillableCall', window: 'Last Week', derivedValue: 2_540, entityType: 'buyer', entityName: 'Markytek' })],
  });
  assert.equal(observationSentence(perCall), 'Revenue per billable call for Markytek increased from $25.10 to $25.40 compared with the prior week.');
});

test('rates: fractions read as percentages, one more digit only when whole percents would look equal', () => {
  const share = finding({
    ruleId: 'revenue-concentration', findingType: 'CONCENTRATION', primaryMetric: 'revenueShare',
    currentValue: 0.4213, comparisonValue: 0.3811, currentWindow: 'This Month', comparisonWindow: 'Last Month · through 9:10 PM',
    supportingEvidence: [ev({ metricKey: 'revenueShare', window: 'This Month', entityType: 'buyer', entityName: 'Markytek', derivedValue: 0.4213 })],
  });
  assert.equal(observationSentence(share), 'Share of revenue for Markytek increased from 38% to 42% compared with last month through 9:10 PM.');

  const close = finding({
    ruleId: 'billable-efficiency', primaryMetric: 'billableRate', currentValue: 0.251, comparisonValue: 0.249,
    supportingEvidence: [ev({ metricKey: 'billableRate', derivedValue: 0.251 })],
  });
  assert.equal(observationSentence(close), 'Billable rate increased from 24.9% to 25.1% compared with yesterday through 9:09 PM.');
});

test('counts read as whole numbers, and bid outcomes by their provider name', () => {
  const calls = finding({
    ruleId: 'volume-change', findingType: 'VOLUME', primaryMetric: 'totalCalls', currentValue: 351, comparisonValue: 403,
    supportingEvidence: [ev({ metricKey: 'totalCalls', normalizedValue: 351 })],
  });
  assert.equal(observationSentence(calls), 'Total calls decreased from 403 to 351 compared with yesterday through 9:09 PM.');

  const closed = finding({
    ruleId: 'bid-outcome-volume', findingType: 'BID_REJECTION', primaryMetric: 'closed', currentValue: 1_240, comparisonValue: null,
    currentWindow: 'Sep 17, 2026', comparisonWindow: null,
    supportingEvidence: [ev({ metricKey: 'closed', window: 'Sep 17, 2026', rawValue: 1_240, entityType: 'bid_source' })],
  });
  assert.equal(observationSentence(closed), '“Closed Target” outcomes were 1,240 on Sep 17, 2026.');
});

test('a rank reads as a place, moved from one to the other', () => {
  const rank = finding({
    ruleId: 'rank-movement', primaryMetric: 'rankChange', currentValue: 3, comparisonValue: 7,
    currentWindow: 'Last Week', comparisonWindow: 'Prior Week',
    supportingEvidence: [ev({ metricKey: 'rankChange', window: 'Last Week vs Prior Week', entityType: 'buyer', entityName: 'Harbor Insurance', derivedValue: 4 })],
  });
  assert.equal(observationSentence(rank), 'Revenue rank for Harbor Insurance moved from #7 to #3 compared with the prior week.');
});

// --- The comparison is what the rule compared against --------------------------------------

test('an average of earlier periods is never called "yesterday"', () => {
  const outlier = finding({
    ruleId: 'anomaly-revenue-outlier', findingType: 'ANOMALY', primaryMetric: 'revenue',
    currentValue: 500_000, comparisonValue: 300_000, currentWindow: 'Yesterday · Completed', comparisonWindow: 'Previous Day',
    supportingEvidence: [ev({ metricKey: 'revenue', window: 'Yesterday · Completed', normalizedValue: 500_000 })],
  });
  const text = observationSentence(outlier);
  assert.equal(text, 'Revenue was $5,000 yesterday, against an average of $3,000 across earlier complete periods.');
  assert.doesNotMatch(text, /previous day/i);
  assert.equal(measuredValuesOf(outlier)!.comparison!.label, 'Average of earlier complete periods');
});

test('a period-wide rate is stated as all sources in the same period, not as the comparison period', () => {
  const gap = finding({
    ruleId: 'opportunity-efficiency-gap', findingType: 'OPPORTUNITY', primaryMetric: 'billableRate',
    currentValue: 0.18, comparisonValue: 0.332,
    supportingEvidence: [
      ev({ metricKey: 'billableRate', entityType: 'source', entityName: 'Turtle Leads', derivedValue: 0.18 }),
      ev({ metricKey: 'billableRate', entityType: 'window', derivedValue: 0.332 }),
    ],
  });
  assert.equal(observationSentence(gap), 'Billable rate for Turtle Leads was 18% today so far, against 33% across all sources.');
  assert.equal(measuredValuesOf(gap)!.comparison!.label, 'All sources, same period');
});

test('fails closed: an unknown rule claims no comparison, and a value no evidence records names nothing', () => {
  const unknownRule = finding({
    ruleId: 'some-future-rule', primaryMetric: 'revenue', currentValue: 820_000, comparisonValue: 1_000_000,
    supportingEvidence: [ev({ metricKey: 'revenue', normalizedValue: 820_000 })],
  });
  assert.equal(observationSentence(unknownRule), 'Revenue was $8,200 today so far.');
  assert.equal(measuredValuesOf(unknownRule)!.comparison!.label, 'Reference value');

  const unrecorded = finding({ primaryMetric: 'revenue', currentValue: 820_000, comparisonValue: 1_000_000, supportingEvidence: [ev({ metricKey: 'totalCalls', normalizedValue: 40 })] });
  assert.equal(observationSentence(unrecorded), 'Measured from 1 evidence point today so far.');
  assert.equal(measuredValuesOf(unrecorded), null);

  // A count of reversals is not an amount of revenue: never "$0".
  const oscillation = finding({
    ruleId: 'anomaly-oscillation', findingType: 'ANOMALY', primaryMetric: 'revenue', currentValue: 5,
    supportingEvidence: [ev({ metricKey: 'revenue', normalizedValue: 5 }), ev({ metricKey: 'revenue', normalizedValue: 300_000 })],
  });
  assert.equal(observationSentence(oscillation), 'Measured from 2 evidence points today so far.');
  assert.equal(measuredValuesOf(oscillation), null);
});

test('period wording', () => {
  assert.equal(periodPhrase('Today · Live'), 'today so far');
  assert.equal(periodPhrase('Yesterday · Completed'), 'yesterday');
  assert.equal(periodPhrase('Sep 14, 2026 · Completed'), 'on Sep 14, 2026');
  assert.equal(periodPhrase('This Week'), 'this week');
  assert.equal(periodPhrase('Last 7 Days'), 'in the last 7 days');
  assert.equal(periodPhrase('Sep 1 – Sep 30, 2026'), 'in Sep 1 – Sep 30, 2026');
  assert.equal(periodPhrase('Latest synchronized bid snapshot (2026-09-17)'), 'in the latest synchronized bid snapshot (2026-09-17)');
  assert.equal(comparisonPhrase('Yesterday · through 9:09 PM'), 'yesterday through 9:09 PM');
  assert.equal(comparisonPhrase('Last Week · through 9:10 PM'), 'last week through 9:10 PM');
  assert.equal(comparisonPhrase('Prior Month'), 'the prior month');
  assert.equal(comparisonPhrase('The day before'), 'the day before');
});

test('evidence values and formulas read in words and units', () => {
  assert.equal(metricLabel('billableRate'), 'Billable rate');
  assert.equal(metricLabel('revenuePerBillableCall'), 'Revenue per billable call');
  assert.equal(metricLabel('callerIdRejected'), '“Caller ID Rejected” outcomes');
  assert.equal(metricLabel('shareOfGrain'), 'Share of outcomes');
  assert.equal(metricLabel('destinationAccepted'), 'Accepted pings');
  assert.equal(formatEvidenceValue({ metricKey: 'revenue', formula: null, normalizedValue: 413_200 }), '$4,132');
  assert.equal(formatEvidenceValue({ metricKey: 'revenuePerBillableCall', formula: null, derivedValue: 2_540 }), '$25.40');
  assert.equal(formatEvidenceValue({ metricKey: 'billableRate', formula: null, derivedValue: 0.332 }), '33.2%');
  assert.equal(formatEvidenceValue({ metricKey: 'contributionToChange', formula: null, derivedValue: 0.36 }), '36.0%');
  assert.equal(formatEvidenceValue({ metricKey: 'totalCalls', formula: null, normalizedValue: 1_956 }), '1,956');
  assert.equal(formatEvidenceValue({ metricKey: 'rankChange', formula: null, derivedValue: 4 }), '+4 places');
  assert.equal(formatEvidenceValue({ metricKey: 'revenue', formula: '(current - mean) / standard deviation', derivedValue: 2.14 }), '2.14 standard deviations');
  assert.equal(humanizeFormula('billableCalls / totalCalls'), 'billable calls / total calls');
  assert.equal(humanizeFormula('comparisonRank - currentRank'), 'comparison rank - current rank');
});

// --- Every rule and every metric is covered, so this cannot recur elsewhere ------------------

const sources = readdirSync(SRC).filter((f) => f.startsWith('callgrid-') && f.endsWith('.ts')).map((f) => readFileSync(join(SRC, f), 'utf8'));

test('every rule the engines emit states what its comparison value is', () => {
  const ruleIds = new Set(sources.flatMap((s) => [...s.matchAll(/ruleId: '([a-z-]+)'/g)].map((m) => m[1]!)));
  ruleIds.add('anomaly-revenue-outlier');
  ruleIds.add('anomaly-volume-outlier');
  assert.ok(ruleIds.size >= 25, `found ${ruleIds.size} rules`);
  for (const id of ruleIds) assert.ok(RULE_COMPARISONS[id], `rule ${id} has no comparison entry`);
});

test('every metric a finding can carry reads as a sentence with a name and a unit', () => {
  const metrics = new Set(sources.flatMap((s) => [...s.matchAll(/primaryMetric: '([A-Za-z]+)'/g)].map((m) => m[1]!)));
  metrics.add('totalCalls'); // the headline and anomaly rules pass it through a variable
  for (const c of BID_REJECTION_CLASSIFICATIONS) metrics.add(c.providerField);
  for (const metric of metrics) {
    const bid = BID_REJECTION_CLASSIFICATIONS.find((c) => c.providerField === metric);
    const f = finding({
      ruleId: 'entity-emerging', primaryMetric: metric, currentValue: metric === 'rankChange' ? 3 : 12, comparisonValue: metric === 'rankChange' ? 5 : null,
      supportingEvidence: [ev({ metricKey: bid ? bid.key : metric === 'contributionToChange' ? 'revenue' : metric, normalizedValue: 12, derivedValue: metric === 'rankChange' ? 2 : 12 })],
    });
    const text = observationSentence(f);
    assert.doesNotMatch(text, /^Measured from/, `${metric} has no name or unit: "${text}"`);
    assertReadable(text, metric);
  }
});

// --- What the engines actually produce ------------------------------------------------------

const dim = (key: string, revenueCents: number | null, calls = 60, monetized = 24) => ({
  key, label: key.replace(/(^|-)(\w)/g, (_m, sep, ch) => (sep ? ' ' : '') + ch.toUpperCase()),
  calls, monetized, converted: 0, revenueCents, payoutCents: 0, costCents: 0,
  marginCents: revenueCents, revenueCoverage: revenueCents === null ? 0 : 1,
});

function history(): { points: HistoryPoint[]; suppressedForLiveWindow: boolean } {
  const revenue = [900_000, 1_400_000, 800_000, 1_500_000, 850_000, 1_450_000, 900_000, 1_350_000];
  return {
    suppressedForLiveWindow: false,
    points: revenue.map((r, i) => {
      const keys = { harbor: historyEntityKey('buyers', 'harbor'), markytek: historyEntityKey('buyers', 'markytek'), quiet: historyEntityKey('buyers', 'quiet-buyer') };
      return {
        period: { index: i + 1, start: new Date(NOW.getTime() - (i + 2) * 86_400_000), end: new Date(NOW.getTime() - (i + 1) * 86_400_000), spanDays: 1 },
        totalCalls: 400 + i * 5, billableCalls: 120, revenueCents: r, profitCents: Math.round(r * 0.35),
        entityRevenueCents: { [keys.harbor]: Math.round(r * 0.3), [keys.markytek]: Math.round(r * 0.4), [keys.quiet]: i < 3 ? 0 : 150_000 },
        entityCalls: { [keys.harbor]: 100, [keys.markytek]: 150, [keys.quiet]: i < 3 ? 0 : 40 },
        entityLabels: { [keys.harbor]: 'Harbor Insurance', [keys.markytek]: 'Markytek', [keys.quiet]: 'Quiet Buyer' },
      };
    }),
  };
}

function engineInputs(): IntelligenceInput[] {
  const base: IntelligenceInput = {
    now: NOW, reportOk: true, windowLabel: 'Yesterday · Completed', comparisonLabel: 'Previous Day',
    comparisonBasis: 'complete_period', includesLiveData: false, periodsPerYear: 365,
    metrics: { available: true, totalCalls: 351, billableCalls: 119, revenueCents: 2_900_000, profitCents: 1_100_000, payoutCents: 1_700_000, costCents: 9_600, revenueCoverage: 0.9, profitCoverage: 0.9 },
    comparison: { available: true, totalCalls: 403, billableCalls: 99, revenueCents: 1_200_000, profitCents: 430_000, payoutCents: 700_000, costCents: 10_800, revenueCoverage: 1, profitCoverage: 1 },
    dimensions: {
      buyers: [dim('markytek', 1_900_000, 150, 60), dim('harbor', 600_000, 100, 30), dim('quiet-buyer', 400_000, 40, 10), dim('new-buyer', 100_000, 30, 5)],
      vendors: [dim('turtle-media', 1_700_000, 200, 70), dim('white-rock', 1_200_000, 151, 49)],
      sources: [dim('turtle-leads', 1_800_000, 250, 20), dim('home-ins-direct', 1_100_000, 101, 99)],
      campaigns: [dim('pest-control', 2_000_000, 200, 80), dim('hvac', 900_000, 151, 39)],
    },
    comparisonDimensions: {
      buyers: [dim('markytek', 300_000, 200, 40), dim('harbor', 700_000, 150, 45), dim('gone-buyer', 200_000, 53, 14)],
      vendors: [dim('turtle-media', 600_000, 250, 50), dim('white-rock', 600_000, 153, 49)],
      sources: [dim('turtle-leads', 500_000, 280, 50), dim('home-ins-direct', 700_000, 123, 49)],
      campaigns: [dim('pest-control', 800_000, 250, 60), dim('hvac', 400_000, 153, 39)],
    },
    history: history(),
  } as IntelligenceInput;
  return [
    base,
    { ...base, windowLabel: 'Today · Live', comparisonLabel: 'Yesterday · through 9:09 PM', comparisonBasis: 'elapsed_matched', includesLiveData: true, history: undefined } as IntelligenceInput,
  ];
}

function bidInput(prior: boolean): BidIntelligenceInput {
  const source = (key: string, closed: number) => ({
    key, name: key.toUpperCase(), total: 5_000, bids: 3_000, won: 400, rejected: 2_000, rejectRatePct: 40,
    rejections: { failedAcceptance: 50, duplicateBids: 20, closed, paused: 10, failedTagRules: 900, duplicateCaller: 40, callerIdRejected: 30 },
  });
  const dest = (key: string) => ({
    key, name: key.toUpperCase(), accepted: 900, rateLimited: 600, pingTimeout: 50, minRevenue: 300,
    failedTagRules: 10, failedAcceptance: 10, apiFailed: 5, suppressed: 5, invalidNumber: 2, missingAmount: 1,
  });
  const snapshot = (closed: number) => ({
    windowStart: new Date('2026-09-17T00:00:00.000Z'), windowEnd: new Date('2026-09-18T00:00:00.000Z'),
    sources: [source('alpha', closed), source('beta', 100)], destinations: [dest('north'), dest('south')],
  });
  return {
    now: NOW, ok: true, hasData: true, fetchedAt: new Date('2026-09-18T06:00:00.000Z'), reportTimezone: 'UTC',
    snapshot: snapshot(1_500),
    prior: prior ? { ...snapshot(200), windowStart: new Date('2026-09-16T00:00:00.000Z'), windowEnd: new Date('2026-09-17T00:00:00.000Z') } : null,
    selectedPeriodLabel: 'Today · Live', matchesSelectedPeriod: false,
  } as BidIntelligenceInput;
}

// Identifiers are never displayed; everything else in a Situation's shown fields is prose.
const IDENTIFIER = /^(id|key|kind|type|ruleId|ruleVersion|version|findingId|targetId|sourceId|entityId|entityType|category|basisKind|severity|classification|state)$|Id$|Key$/;
function strings(value: unknown, out: string[] = [], field = ''): string[] {
  if (typeof value === 'string') { if (!IDENTIFIER.test(field)) out.push(value); }
  else if (Array.isArray(value)) value.forEach((v) => strings(v, out, field));
  else if (value && typeof value === 'object') Object.entries(value).forEach(([k, v]) => strings(v, out, k));
  return out;
}

test('across what the engines produce, "What happened", Measured values and the reasoning read as prose', () => {
  const findings: CallGridFinding[] = [];
  const fired = new Set<string>();
  for (const input of engineInputs()) {
    const intel = analyzeCallGrid(input);
    findings.push(...intel.findings);
    for (const card of intel.decisionSupport) assertReadable(card.observation, `card ${card.findingId}`);
    for (const s of intel.queue.situations) {
      // What the situation page shows as prose: headline, what happened, why, advice,
      // if-ignored, Loop's read and the reasoning chain (the evidence drawer is provenance).
      const shown = { title: s.title, whatHappened: s.whatHappened, whyItMatters: s.whyItMatters, decision: s.decision, ifIgnored: s.ifIgnored, impact: s.impact, read: s.read, chain: s.chain, unknowns: s.unknowns };
      for (const text of strings(shown)) assertReadable(text, `situation "${s.title}"`);
    }
  }
  const bids = analyzeBids(bidInput(false));
  findings.push(...bids.findings, ...analyzeBidSnapshotChange(bidInput(true)));

  for (const f of findings) {
    fired.add(f.ruleId);
    assertReadable(observationSentence(f), `${f.ruleId} observation`);
    const m = measuredValuesOf(f);
    if (m) for (const text of [m.subject, m.current.value, m.comparison?.label ?? '', m.comparison?.value ?? '']) assertReadable(text, `${f.ruleId} measured values`);
  }
  // The sweep reaches every family -- money, rate, count, entity, history, bids -- not one rule.
  for (const rule of [
    'revenue-change', 'profit-change', 'billable-efficiency', 'revenue-concentration', 'anomaly-volume-outlier',
    'entity-contribution', 'entity-record-period', 'anomaly-oscillation', 'bid-outcome-volume', 'bid-win-rate',
  ]) {
    assert.ok(fired.has(rule), `the sweep did not reach ${rule}; it reached ${[...fired].join(', ')}`);
  }
});
