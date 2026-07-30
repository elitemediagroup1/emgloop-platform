// The decision card's composition.
//
// These assert the two things that could go wrong in a presentation layer built
// over an honest engine: that it never says more than the engine established,
// and that it never drops anything the operator is entitled to see.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildSituations, type SituationInput } from '../src/callgrid-situation';
import { clusterFindings, type OperationalReasoning } from '../src/callgrid-reasoning';
import { rankFindings } from '../src/callgrid-scoring';
import { buildDecisionSupport } from '../src/callgrid-decision-support';
import type { AffectedEntity, CallGridFinding } from '../src/callgrid-intelligence';
import {
  confidenceOf,
  whyItMatters,
  expectedOutcomes,
  tierDecisions,
  PRIMARY_TIER_SIZE,
} from '../src/decision-card';

const NOW = new Date('2026-07-30T18:00:00.000Z');

function entity(id: string, over: Partial<AffectedEntity> = {}): AffectedEntity {
  return {
    entityType: 'buyer', entityId: id, entityName: id.toUpperCase(),
    currentValue: null, comparisonValue: null, absoluteChange: null,
    contributionToChange: null, currentShare: null, comparisonShare: null,
    currentRank: null, comparisonRank: null,
    ...over,
  };
}

function finding(over: Partial<CallGridFinding> = {}): CallGridFinding {
  const id = over.id ?? 'f1';
  return {
    id, findingType: 'CHANGE', title: 'Revenue declined',
    plainLanguageSummary: 'Revenue declined 18%.',
    classification: 'DERIVED', severity: 'HIGH', confidence: 0.9,
    currentWindow: 'Yesterday', comparisonWindow: 'The day before',
    primaryMetric: 'revenue', currentValue: 820_000, comparisonValue: 1_000_000,
    absoluteChange: -180_000, percentageChange: -0.18,
    affectedEntities: [], drivers: [],
    supportingEvidence: [{
      id: `${id}:e1`, findingId: id, sourceType: 'call_projection', providerReport: 'CallGrid',
      metricKey: 'revenue', entityType: 'window', entityId: null, entityName: null,
      window: 'Yesterday', providerField: null, rawValue: null, normalizedValue: 820_000,
      derivedValue: null, formula: null, formulaVersion: null, classification: 'VERIFIED',
      completeness: 1, notes: null,
    }],
    limitations: ['Coverage is partial.'], unknowns: ['Why it moved.'],
    recommendedReview: 'Review the buyer mix.', recommendedActionType: null, actionTarget: null,
    actionSafety: 'SAFE_TO_REVIEW', createdAt: NOW.toISOString(),
    ruleId: 'revenue-change', ruleVersion: 'v1',
    ...over,
  };
}

function situationsFor(findings: CallGridFinding[]) {
  const clusters = clusterFindings(findings);
  const ranked = rankFindings(findings, {
    windowRevenueCents: 1_000_000, recurrence: null, recurrenceWindow: null,
  });
  const reasoning: OperationalReasoning = {
    clusters, relations: clusters.flatMap((c) => c.relations),
    timeline: [], stability: [],
    graph: { nodes: [], edges: [], version: 'v1' },
    businessStory: 'A story.', unknowns: [], version: 'v1',
  };
  const decisionSupport = buildDecisionSupport(ranked, {
    opportunitiesByFindingId: new Map(), revenueSeries: [], periodsPerYear: null,
  });
  const input: SituationInput = { reasoning, ranked, decisionSupport, opportunities: [] };
  return buildSituations(input);
}

// --- Confidence --------------------------------------------------------------

test('confidence takes the WORST merged strength, never the best or an average', () => {
  // A Situation is a claim about all of its members, so it can only be as
  // trustworthy as its weakest one. Averaging would let two strong findings
  // launder a third the engine declared insufficient.
  const [s] = situationsFor([
    finding({ id: 'f1', affectedEntities: [entity('markytek')] }),
    finding({
      id: 'f2', affectedEntities: [entity('markytek')],
      actionSafety: 'INSUFFICIENT_EVIDENCE',
    }),
  ]);
  if (!s) return;
  const c = confidenceOf(s);
  if (s.observationCount > 1) {
    assert.equal(c.strength, 'INSUFFICIENT');
    assert.match(c.label, /Insufficient/);
  }
});

test('confidence always states what it is based on, in countable terms', () => {
  const [s] = situationsFor([finding({ affectedEntities: [entity('markytek')] })]);
  const c = confidenceOf(s!);
  assert.ok(c.basis.length > 0, 'a badge with no stated basis is just a colour');
  assert.ok(c.basis.some((b) => /observation/.test(b)));
  assert.ok(
    c.basis.some((b) => /limitation/.test(b)),
    'stated limitations are part of the basis, not a footnote',
  );
});

test('a partially-measurable ranking says so, separately from evidence strength', () => {
  const [s] = situationsFor([finding({ affectedEntities: [entity('markytek')] })]);
  const c = confidenceOf(s!);
  if (s!.score.determinacy < 1) {
    assert.match(c.determinacyNote!, /% of the scoring model/);
  } else {
    assert.equal(c.determinacyNote, null);
  }
});

// --- Why this matters --------------------------------------------------------

test('why-it-matters is null rather than a restatement when nothing is measurable', () => {
  const [s] = situationsFor([
    finding({
      primaryMetric: 'calls', currentValue: null, comparisonValue: null,
      absoluteChange: null, percentageChange: null,
    }),
  ]);
  const why = whyItMatters(s!);
  // Either a measured consequence, or nothing at all — never filler.
  if (why !== null) {
    assert.ok(why.length > 0);
    assert.notEqual(why, s!.title, 'it must not simply repeat the title');
  }
});

test('why-it-matters never claims what acting would achieve', () => {
  const situations = situationsFor([
    finding({ id: 'a', affectedEntities: [entity('markytek')] }),
    finding({ id: 'b', affectedEntities: [entity('other')], severity: 'CRITICAL' }),
  ]);
  for (const s of situations) {
    const why = whyItMatters(s);
    if (!why) continue;
    // A counterfactual needs constraints Loop cannot see, so an AFFIRMATIVE
    // recovery claim is forbidden. The engine's own disclaimer — "Loop cannot say
    // what acting would recover" — contains the same words and is the opposite of
    // the failure, so each sentence is judged on whether it NEGATES the claim it
    // mentions. Matching the bare phrase would flag the honesty as the fault.
    for (const sentence of why.split(/(?<=\.)\s+/)) {
      const claims = /(would|could|will)\s+(recover|return|regain|gain)/i.test(sentence);
      const negated = /\b(cannot|can't|does not|doesn't|never|no)\b/i.test(sentence);
      assert.ok(
        !claims || negated,
        `"${sentence}" asserts what acting would achieve, which needs a counterfactual Loop cannot see`,
      );
    }
    assert.ok(!/expected uplift|projected recovery/i.test(why), `"${why}" forecasts`);
  }
});

// --- Expected outcomes -------------------------------------------------------

test('every decision offers a way to say Loop was wrong', () => {
  const situations = situationsFor([finding({ affectedEntities: [entity('markytek')] })]);
  for (const s of situations) {
    const outcomes = expectedOutcomes(s);
    assert.ok(
      outcomes.some((o) => o.value === 'FALSE_POSITIVE'),
      'suppressing this would suppress the feedback the intelligence needs most',
    );
    assert.ok(outcomes.some((o) => o.value === 'UNKNOWN'), 'closing without knowing is honest');
  }
});

test('a weakly-evidenced decision leads with "Loop should not have raised this"', () => {
  const [s] = situationsFor([
    finding({ affectedEntities: [entity('markytek')], actionSafety: 'INSUFFICIENT_EVIDENCE' }),
  ]);
  const outcomes = expectedOutcomes(s!);
  assert.equal(outcomes[0]!.value, 'FALSE_POSITIVE');
});

test('recovery outcomes are offered only when there is something measurable to recover', () => {
  const [s] = situationsFor([
    finding({
      primaryMetric: 'calls', currentValue: null, comparisonValue: null,
      absoluteChange: null, percentageChange: null,
    }),
  ]);
  const values = expectedOutcomes(s!).map((o) => o.value);
  if (s!.impact.amountCents === null) {
    assert.ok(!values.includes('RECOVERED'), 'nothing measured cannot be measured as returned');
  }
});

// --- Tiering: nothing is ever hidden -----------------------------------------

test('tiering conserves every item — an inbox may not summarise', () => {
  const items = Array.from({ length: 17 }, (_, i) => ({
    id: i,
    undecided: i % 3 === 0,
    closed: i % 5 === 0,
  }));
  const tiers = tierDecisions(items, (i) => ({ undecided: i.undecided, closed: i.closed }));
  const total =
    tiers.primary.length + tiers.active.length + tiers.monitoring.length + tiers.closed.length;
  assert.equal(total, items.length, 'every decision must appear in exactly one tier');

  const ids = new Set([
    ...tiers.primary, ...tiers.active, ...tiers.monitoring, ...tiers.closed,
  ].map((i) => i.id));
  assert.equal(ids.size, items.length, 'and never in two');
});

test('only the first few undecided items get the primary tier; the rest stay visible', () => {
  const items = Array.from({ length: 10 }, (_, i) => ({ id: i }));
  const tiers = tierDecisions(items, () => ({ undecided: true, closed: false }));
  assert.equal(tiers.primary.length, PRIMARY_TIER_SIZE);
  assert.equal(tiers.active.length, 10 - PRIMARY_TIER_SIZE, 'the remainder is shown, not counted');
  assert.equal(tiers.monitoring.length, 0);
});

test('owned and closed items never occupy the primary tier', () => {
  const items = [
    { id: 1, undecided: false, closed: false },
    { id: 2, undecided: false, closed: true },
    { id: 3, undecided: true, closed: false },
  ];
  const tiers = tierDecisions(items, (i) => ({ undecided: i.undecided, closed: i.closed }));
  assert.deepEqual(tiers.primary.map((i) => i.id), [3]);
  assert.deepEqual(tiers.monitoring.map((i) => i.id), [1]);
  assert.deepEqual(tiers.closed.map((i) => i.id), [2]);
});

test('a zero-size primary tier still shows everything', () => {
  const items = Array.from({ length: 4 }, (_, i) => ({ id: i }));
  const tiers = tierDecisions(items, () => ({ undecided: true, closed: false }), 0);
  assert.equal(tiers.primary.length, 0);
  assert.equal(tiers.active.length, 4);
});
