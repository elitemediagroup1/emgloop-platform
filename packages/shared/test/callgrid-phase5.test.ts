import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  relate, relateAll, clusterFindings, assessStability, buildTimeline,
  buildRelationshipGraph, reasonAboutFindings,
  RELATION_KINDS, RELATION_LABEL, RELATION_DEFINITION,
  STABILITY_CLASSES, STABILITY_LABEL, REASONING_VERSION,
} from '../src/callgrid-reasoning';
import { analyzeCallGrid, analyzeDimension, type IntelligenceInput } from '../src/callgrid-intelligence-engine';
import { historyEntityKey, type HistoryPoint, type HistorySeries } from '../src/callgrid-history';
import type { AffectedEntity, CallGridFinding } from '../src/callgrid-intelligence';

const NOW = new Date('2026-07-29T14:15:00.000Z');

const entity = (id: string, contribution: number | null = null): AffectedEntity => ({
  entityType: 'buyer', entityId: id, entityName: id.toUpperCase(),
  currentValue: null, comparisonValue: null, absoluteChange: null,
  contributionToChange: contribution, currentShare: null, comparisonShare: null,
  currentRank: null, comparisonRank: null,
});

function finding(over: Partial<CallGridFinding> = {}): CallGridFinding {
  return {
    id: 'f1', findingType: 'CHANGE', title: 'Revenue declined',
    plainLanguageSummary: 'Revenue declined 18%.',
    classification: 'DERIVED', severity: 'HIGH', confidence: 0.9,
    currentWindow: 'Yesterday', comparisonWindow: 'The day before',
    primaryMetric: 'revenue', currentValue: 820_000, comparisonValue: 1_000_000,
    absoluteChange: -180_000, percentageChange: -0.18,
    affectedEntities: [], drivers: [],
    supportingEvidence: [{
      id: 'f1:e1', findingId: 'f1', sourceType: 'call_projection', providerReport: 'CallGrid',
      metricKey: 'revenue', entityType: 'window', entityId: null, entityName: null,
      window: 'Yesterday', providerField: null, rawValue: null, normalizedValue: 820_000,
      derivedValue: null, formula: null, formulaVersion: null, classification: 'VERIFIED',
      completeness: 1, notes: null,
    }],
    limitations: ['limited'], unknowns: ['why'],
    recommendedReview: 'Review the buyer mix.', recommendedActionType: null, actionTarget: null,
    actionSafety: 'SAFE_TO_REVIEW', createdAt: NOW.toISOString(),
    ruleId: 'revenue-change', ruleVersion: 'v1',
    ...over,
  };
}

// --- The causality boundary — the point of this whole phase -------------------------

test('every relation kind has a label AND a definition of what it may mean', () => {
  for (const k of RELATION_KINDS) {
    assert.ok(RELATION_LABEL[k], `${k} has no label`);
    assert.ok(RELATION_DEFINITION[k].length > 40, `${k} must define what it is allowed to mean`);
  }
});

test('LIKELY_ROOT_CAUSE is defined as arithmetic attribution, never mechanism', () => {
  const def = RELATION_DEFINITION.LIKELY_ROOT_CAUSE.toLowerCase();
  assert.match(def, /where the change came from/);
  assert.match(def, /not why/);
});

test('a dominant contributor with no competitor is the arithmetic origin', () => {
  const target = finding({ id: 'rev', drivers: [entity('big', 0.72), entity('tiny', 0.05)] });
  const source = finding({ id: 'src', affectedEntities: [entity('big')] });
  const r = relate(target, source, [target, source]);
  assert.ok(r);
  assert.equal(r!.kind, 'LIKELY_ROOT_CAUSE');
  assert.match(r!.basis, /not why it happened/i);
});

test('a competing contributor BLOCKS a root-cause claim', () => {
  // 62% would be dominant alone, but a 30% competitor means the change is spread.
  const target = finding({ id: 'rev', drivers: [entity('big', 0.62), entity('other', 0.30)] });
  const source = finding({ id: 'src', affectedEntities: [entity('big')] });
  const r = relate(target, source, [target, source]);
  assert.ok(r);
  assert.equal(r!.kind, 'POSSIBLE_CONTRIBUTOR', 'dominance alone is not enough — a rival explanation must be absent');
});

test('a small contributor is never named as a contributor or a cause', () => {
  const target = finding({ id: 'rev', drivers: [entity('small', 0.04)] });
  const source = finding({ id: 'src', affectedEntities: [entity('small')] });
  const r = relate(target, source, [target, source]);
  // It may still correlate weakly — both concern economics in the same period —
  // but 4% of a change must never be presented as a contributor or an origin.
  assert.notEqual(r?.kind, 'LIKELY_ROOT_CAUSE');
  assert.notEqual(r?.kind, 'POSSIBLE_CONTRIBUTOR');
});

test('formula lineage is a downstream effect — profit follows revenue by construction', () => {
  const profit = finding({ id: 'p', primaryMetric: 'profit' });
  const revenue = finding({ id: 'r', primaryMetric: 'revenue' });
  const rel = relate(profit, revenue, [profit, revenue]);
  assert.ok(rel);
  assert.equal(rel!.kind, 'DOWNSTREAM_EFFECT');
  assert.match(rel!.basis, /by construction rather than by inference/i);
});

test('lineage is directional — revenue is not downstream of profit', () => {
  const profit = finding({ id: 'p', primaryMetric: 'profit' });
  const revenue = finding({ id: 'r', primaryMetric: 'revenue' });
  const backwards = relate(revenue, profit, [revenue, profit]);
  // Same metric family, so it may correlate — but it must NOT be downstream.
  assert.notEqual(backwards?.kind, 'DOWNSTREAM_EFFECT');
});

test('co-occurrence is labelled CORRELATED_CHANGE and implies no direction', () => {
  // Same entity, no contribution recorded and no formula lineage between them.
  const a = finding({ id: 'a', primaryMetric: 'revenue', affectedEntities: [entity('x')] });
  const b = finding({ id: 'b', primaryMetric: 'revenue', affectedEntities: [entity('x')] });
  const r = relate(a, b, [a, b]);
  assert.ok(r);
  assert.equal(r!.kind, 'CORRELATED_CHANGE');
  assert.match(r!.basis, /co-occur|neither is shown to lead/i);
});

test('no relation text ever asserts causation', () => {
  const target = finding({ id: 'rev', drivers: [entity('big', 0.8)] });
  const source = finding({ id: 'src', affectedEntities: [entity('big')] });
  const all = relateAll([target, source, finding({ id: 'p', primaryMetric: 'profit' })]);
  assert.ok(all.length > 0);
  for (const r of all) {
    const text = `${r.basis} ${r.measurement ?? ''}`.toLowerCase();
    for (const banned of ['caused by', 'because of', 'due to', 'resulted from', 'led to']) {
      assert.ok(!text.includes(banned), `causal language "${banned}" in ${r.kind}`);
    }
    assert.ok(r.unknownDependencies.length > 0, 'every relation must state what would be needed for causality');
  }
});

test('every relation names the mechanism as an unknown dependency', () => {
  const target = finding({ id: 'rev', drivers: [entity('big', 0.8)] });
  const source = finding({ id: 'src', affectedEntities: [entity('big')] });
  const r = relate(target, source, [target, source])!;
  assert.ok(r.unknownDependencies.some((u) => /mechanism/i.test(u)));
});

// --- Clusters -----------------------------------------------------------------------

test('unrelated findings become separate clusters, and isolation is stated', () => {
  const a = finding({ id: 'a', primaryMetric: 'revenue' });
  const b = finding({ id: 'b', primaryMetric: 'bidWinRate', affectedEntities: [] });
  const clusters = clusterFindings([a, b]);
  assert.equal(clusters.length, 2);
  const isolated = clusters.find((c) => c.members.length === 1 && c.anchor.id === 'b');
  assert.ok(isolated);
  assert.match(isolated!.narrative, /isolated rather than systemic/i);
});

test('related findings collapse into one cluster so a single movement is not read as several', () => {
  const revenue = finding({ id: 'rev', primaryMetric: 'revenue', drivers: [entity('big', 0.8)] });
  const driver = finding({ id: 'drv', affectedEntities: [entity('big')] });
  const profit = finding({ id: 'pro', primaryMetric: 'profit' });
  const clusters = clusterFindings([revenue, driver, profit]);
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0]!.members.length, 3);
});

test('a cluster with a dominant contributor reports a root cause; one without does not', () => {
  const withRoot = clusterFindings([
    finding({ id: 'rev', drivers: [entity('big', 0.8)] }),
    finding({ id: 'drv', affectedEntities: [entity('big')] }),
  ]);
  assert.equal(withRoot[0]!.hasRootCause, true);

  const spread = clusterFindings([
    finding({ id: 'rev', drivers: [entity('a', 0.4), entity('b', 0.35)] }),
    finding({ id: 'da', affectedEntities: [entity('a')] }),
    finding({ id: 'db', affectedEntities: [entity('b')] }),
  ]);
  assert.equal(spread[0]!.hasRootCause, false);
  assert.match(spread[0]!.narrative, /spread across/i);
});

test('cluster narratives never assert causation', () => {
  const clusters = clusterFindings([
    finding({ id: 'rev', drivers: [entity('big', 0.8)] }),
    finding({ id: 'drv', affectedEntities: [entity('big')] }),
    finding({ id: 'pro', primaryMetric: 'profit' }),
  ]);
  for (const c of clusters) {
    const text = c.narrative.toLowerCase();
    for (const banned of ['caused by', 'because of', 'due to', 'resulted from']) {
      assert.ok(!text.includes(banned), `"${banned}" in cluster narrative`);
    }
  }
});

// --- Stability ----------------------------------------------------------------------

function series(entityRevenues: (number | null)[]): HistorySeries {
  const key = historyEntityKey('buyers', 'b1');
  const points: HistoryPoint[] = entityRevenues.map((r, i) => ({
    period: { index: i + 1, start: new Date(0), end: new Date(0), spanDays: 1 },
    totalCalls: 100, billableCalls: 40, revenueCents: r, profitCents: r,
    entityRevenueCents: { [key]: r }, entityCalls: { [key]: 10 },
    entityLabels: { [key]: 'ACME' },
  }));
  return { points, suppressedForLiveWindow: false };
}

test('stability is UNKNOWN below the minimum series — never a guess', () => {
  const a = assessStability('buyers', 'b1', 'ACME', series([100, 200]), 150);
  assert.equal(a.classification, 'UNKNOWN');
  assert.equal(a.confidence, 0);
  assert.match(a.basis, /Fewer than/i);
});

test('a monotonic decline reads as DECLINING', () => {
  // Most-recent-first: 100 latest, 800 earliest.
  const a = assessStability('buyers', 'b1', 'ACME', series([100_000, 300_000, 500_000, 800_000]), 100_000);
  assert.equal(a.classification, 'DECLINING');
});

test('sustained growth reads as IMPROVING', () => {
  const a = assessStability('buyers', 'b1', 'ACME', series([800_000, 500_000, 300_000, 100_000]), 800_000);
  assert.equal(a.classification, 'IMPROVING');
});

test('volatility outranks trend — an erratic series is VOLATILE, not trending', () => {
  const a = assessStability('buyers', 'b1', 'ACME', series([900_000, 100_000, 800_000, 120_000, 850_000]), 900_000);
  assert.equal(a.classification, 'VOLATILE', 'a trend line through an erratic series describes the line, not the business');
});

test('absent early and present recently reads as EMERGING', () => {
  const a = assessStability('buyers', 'b1', 'ACME', series([300_000, 200_000, null, null]), 300_000);
  assert.equal(a.classification, 'EMERGING');
});

test('present early and absent recently reads as DORMANT', () => {
  const a = assessStability('buyers', 'b1', 'ACME', series([null, null, 200_000, 300_000]), 0);
  assert.equal(a.classification, 'DORMANT');
});

test('every stability class has a label', () => {
  for (const c of STABILITY_CLASSES) assert.ok(STABILITY_LABEL[c], `${c} has no label`);
});

test('stability classifications rest only on completed periods', () => {
  const a = assessStability('buyers', 'b1', 'ACME', series([100_000, 300_000, 500_000, 800_000]), 100_000);
  assert.ok(a.periods > 0);
  assert.match(a.basis, /complete/i);
});

// --- Timeline -----------------------------------------------------------------------

test('no timeline is produced below the minimum series', () => {
  assert.deepEqual(buildTimeline(series([100, 200]), 'Yesterday'), []);
});

test('the timeline is ordered oldest first — the sequence is the point', () => {
  const events = buildTimeline(series([500_000, 100_000, 900_000, 400_000, 300_000]), 'Yesterday');
  assert.ok(events.length > 0);
  const indices = events.map((e) => e.periodIndex);
  assert.deepEqual(indices, [...indices].sort((a, b) => b - a));
});

test('the timeline marks the peak and the trough', () => {
  const events = buildTimeline(series([500_000, 100_000, 900_000, 400_000, 300_000]), 'Yesterday');
  assert.ok(events.some((e) => e.kind === 'PEAK'));
  assert.ok(events.some((e) => e.kind === 'TROUGH'));
});

// --- Graph --------------------------------------------------------------------------

test('the logical graph emits plain data any consumer can read', () => {
  const findings = [
    finding({ id: 'rev', drivers: [entity('big', 0.8)] }),
    finding({ id: 'drv', affectedEntities: [entity('big')] }),
  ];
  const graph = buildRelationshipGraph(findings, relateAll(findings));
  assert.ok(graph.nodes.some((n) => n.kind === 'finding'));
  assert.ok(graph.nodes.some((n) => n.kind === 'metric'));
  assert.ok(graph.nodes.some((n) => n.kind === 'entity'));
  assert.ok(graph.edges.every((e) => typeof e.basis === 'string' && e.basis.length > 0),
    'every edge must carry its basis so the reasoning stays inspectable');
  assert.equal(graph.version, REASONING_VERSION);
});

test('graph node ids are unique — one node per entity, not one per mention', () => {
  const findings = [
    finding({ id: 'a', affectedEntities: [entity('big')] }),
    finding({ id: 'b', affectedEntities: [entity('big')] }),
  ];
  const graph = buildRelationshipGraph(findings, []);
  const ids = graph.nodes.map((n) => n.id);
  assert.equal(ids.length, new Set(ids).size);
});

// --- Business story -----------------------------------------------------------------

const reasoningInput = (over: Partial<Parameters<typeof reasonAboutFindings>[0]> = {}) => ({
  findings: [finding()],
  history: series([500_000, 480_000, 510_000, 495_000]),
  selectedPeriodLabel: 'Yesterday',
  includesLiveData: false,
  entities: [{ dimension: 'buyers', key: 'b1', name: 'ACME', revenueCents: 500_000 }],
  ...over,
});

test('an empty period produces an honest story, not a generic summary', () => {
  const r = reasonAboutFindings(reasoningInput({ findings: [] }));
  assert.match(r.businessStory, /no evidence-backed finding/i);
});

test('the business story states isolation when nothing connects', () => {
  const r = reasonAboutFindings(reasoningInput({
    findings: [
      finding({ id: 'a', primaryMetric: 'revenue' }),
      finding({ id: 'b', primaryMetric: 'bidWinRate' }),
    ],
  }));
  assert.match(r.businessStory, /isolated|standing alone/i);
});

test('a live window is disclosed in the story', () => {
  const r = reasonAboutFindings(reasoningInput({ includesLiveData: true }));
  assert.match(r.businessStory, /still in progress/i);
});

test('reasoning always states that mechanism is unknown', () => {
  const r = reasonAboutFindings(reasoningInput());
  assert.ok(r.unknowns.some((u) => /cannot observe routing|not a causal claim/i.test(u)));
});

test('reasoning declares its version so a chain stays reproducible', () => {
  assert.equal(reasonAboutFindings(reasoningInput()).version, REASONING_VERSION);
});

// --- Engine integration -------------------------------------------------------------

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
    vendors: [dimRow('v1', 700_000)],
    sources: [dimRow('s1', 600_000)],
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

test('the engine emits reasoning with a story, clusters and a graph', () => {
  const intel = analyzeCallGrid(engineInput());
  assert.ok(intel.reasoning.businessStory.length > 0);
  assert.ok(intel.reasoning.clusters.length > 0);
  assert.ok(intel.reasoning.graph.nodes.length > 0);
  assert.equal(intel.reasoning.version, REASONING_VERSION);
});

test('every engine cluster covers every finding exactly once', () => {
  const intel = analyzeCallGrid(engineInput());
  const covered = intel.reasoning.clusters.flatMap((c) => c.members.map((m) => m.id));
  assert.equal(covered.length, intel.findings.length);
  assert.equal(new Set(covered).size, intel.findings.length);
});

test('no engine narrative or relation asserts causation', () => {
  const intel = analyzeCallGrid(engineInput());
  const texts = [
    intel.reasoning.businessStory,
    ...intel.reasoning.clusters.map((c) => c.narrative),
    ...intel.reasoning.relations.map((r) => r.basis),
  ];
  for (const t of texts) {
    const lower = t.toLowerCase();
    for (const banned of ['caused by', 'because of', 'due to', 'resulted from']) {
      assert.ok(!lower.includes(banned), `"${banned}" in: ${t.slice(0, 120)}`);
    }
  }
});

test('reasoning unknowns reach the page unknowns section', () => {
  const intel = analyzeCallGrid(engineInput());
  assert.ok(intel.unknowns.some((u) => u.id.startsWith('reasoning-unknown-')));
});

test('dimension pages get scoped reasoning', () => {
  const buyers = analyzeDimension(engineInput(), 'buyers');
  assert.ok(buyers.reasoning.businessStory.length > 0);
  assert.equal(buyers.reasoning.version, REASONING_VERSION);
});

test('reasoning is deterministic', () => {
  const input = engineInput();
  assert.deepEqual(
    JSON.parse(JSON.stringify(analyzeCallGrid(input).reasoning)),
    JSON.parse(JSON.stringify(analyzeCallGrid(input).reasoning)),
  );
});

test('a live window still yields reasoning, but no timeline and no stability', () => {
  const intel = analyzeCallGrid(engineInput({ includesLiveData: true }));
  assert.deepEqual(intel.reasoning.timeline, [], 'sequence needs completed periods');
  for (const s of intel.reasoning.stability) {
    assert.equal(s.classification, 'UNKNOWN', 'stability must not be classified without completed history');
  }
});
