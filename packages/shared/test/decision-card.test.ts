// The decision card's composition.
//
// These assert the two things that could go wrong in a presentation layer built
// over an honest engine: that it never says more than the engine established,
// and that it never drops anything the operator is entitled to see.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { buildSituations, type SituationInput } from '../src/callgrid-situation';
import { clusterFindings, type OperationalReasoning } from '../src/callgrid-reasoning';
import { rankFindings } from '../src/callgrid-scoring';
import { buildDecisionSupport } from '../src/callgrid-decision-support';
import type { AffectedEntity, CallGridFinding } from '../src/callgrid-intelligence';
import {
  confidenceOf,
  whyItMatters,
  expectedOutcomes,
  outcomeChoices,
  ownershipOf,
  priorClosure,
  unknownGroupOf,
  groupUnknowns,
  storyDigest,
  tierDecisions,
  PRIMARY_TIER_SIZE,
} from '../src/decision-card';
import { OPERATIONAL_OUTCOMES, type LifecycleHistory } from '../src/operational-lifecycle';

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

// --- Outcome choices: grouping must not narrow ------------------------------

test('grouping outcomes conserves every choice — a group is a divider, not a filter', () => {
  const [s] = situationsFor([finding({ affectedEntities: [entity('markytek')] })]);
  const flat = expectedOutcomes(s!);
  const grouped = outcomeChoices(s!).flatMap((g) => g.choices);

  assert.deepEqual(
    grouped.map((c) => c.value).sort(),
    [...new Set(flat.map((c) => c.value))].sort(),
    'every ending offered flat must still be offered grouped',
  );
});

test('every outcome the server will accept can actually be chosen', () => {
  // The action validates against OPERATIONAL_OUTCOMES and fails closed to
  // UNKNOWN. An outcome the enum accepts but no operator can select is a lane of
  // the feedback loop that silently never fills.
  const [s] = situationsFor([finding({ affectedEntities: [entity('markytek')] })]);
  const offered = new Set(outcomeChoices(s!).flatMap((g) => g.choices.map((c) => c.value)));
  for (const outcome of OPERATIONAL_OUTCOMES) {
    assert.ok(offered.has(outcome), `${outcome} is recordable but not selectable`);
  }
});

test('a weakly-evidenced decision still leads with "Loop was wrong" after grouping', () => {
  const [s] = situationsFor([
    finding({ affectedEntities: [entity('markytek')], actionSafety: 'INSUFFICIENT_EVIDENCE' }),
  ]);
  const groups = outcomeChoices(s!);
  assert.equal(groups[0]!.key, 'WRONG', 'regrouping must not bury the feedback Loop needs most');
});

test('no outcome appears in two groups', () => {
  const [s] = situationsFor([finding({ affectedEntities: [entity('markytek')] })]);
  const all = outcomeChoices(s!).flatMap((g) => g.choices.map((c) => c.value));
  assert.equal(new Set(all).size, all.length);
});

// --- Ownership: accountability is not execution -----------------------------

test('owner and assignee stay distinguishable, whichever is set', () => {
  const working = ownershipOf({ state: 'ASSIGNED', accountable: 'Matt', working: 'Dana' });
  assert.equal(working.standing, 'IN_PROGRESS');
  assert.match(working.detail, /Dana is working it/);
  assert.match(working.detail, /Matt answers for it/);

  const owned = ownershipOf({ state: 'ASSIGNED', accountable: 'Matt', working: null });
  assert.equal(owned.standing, 'OWNED');
  assert.match(owned.detail, /Matt answers for it/);

  const unowned = ownershipOf({ state: 'NEEDS_REVIEW', accountable: null, working: null });
  assert.equal(unowned.standing, 'UNOWNED');
  assert.match(unowned.label, /Nobody owns this/);
});

test('a closed decision reports closed, never who is working it', () => {
  const closed = ownershipOf({ state: 'RESOLVED', accountable: 'Matt', working: 'Dana' });
  assert.equal(closed.standing, 'CLOSED');
  assert.equal(closed.working, null, 'nobody is working a closed decision');
  assert.equal(closed.label, 'Resolved');
});

// --- Prior closure ----------------------------------------------------------

const label = (o: string) => o.replace(/_/g, ' ');

function history(over: Partial<LifecycleHistory> = {}): LifecycleHistory {
  return {
    firstDetectedAt: NOW, lastDetectedAt: NOW, detectionCount: 1, timesReopened: 0,
    msToFirstDecision: null, msToResolution: null, contactAttempts: 0,
    recordedOutcomes: [], humanActors: [],
    ...over,
  };
}

test('prior closure is null when nothing was ever closed — never a placeholder', () => {
  assert.equal(priorClosure(null, label), null);
  assert.equal(priorClosure(history(), label), null);
  assert.equal(
    priorClosure(history({ recordedOutcomes: [{ outcome: null, cents: null, at: NOW }] }), label),
    null,
  );
});

test('prior closure reports the LAST outcome and that a resolution did not hold', () => {
  const text = priorClosure(
    history({
      timesReopened: 2,
      recordedOutcomes: [
        { outcome: 'NOT_RECOVERED', cents: null, at: NOW },
        { outcome: 'RECOVERED', cents: 198_000, at: NOW },
      ],
    }),
    label,
  );
  assert.match(text!, /recovered/i, 'the latest outcome, not the first');
  assert.match(text!, /came back 2 times/);
  assert.match(text!, /\$1,980/);
});

// --- Unknowns: the grouping table cannot silently rot -----------------------

test('every unknown id the engines emit belongs to a real group', () => {
  // The anti-EVENT_BUS.md device, applied to a presentation table. Without this
  // the grouping quietly drops the next rule's unknown into "Everything else",
  // and a page that claims to categorise its own limits stops doing so without
  // anything failing.
  const sources = ['callgrid-intelligence-engine.ts', 'callgrid-bid-intelligence.ts']
    .map((f) => readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8'))
    .join('\n');

  const ids = new Set(
    [...sources.matchAll(/id:\s*'((?:unknown:|bid-unknown:)[a-z-]+|no-historical-series)'/g)]
      .map((m) => m[1]!),
  );

  assert.ok(ids.size >= 10, `expected the engines to emit unknowns; found ${ids.size}`);
  for (const id of ids) {
    assert.notEqual(
      unknownGroupOf(id),
      'OTHER',
      `${id} has no group — add it to UNKNOWN_GROUP_BY_ID in decision-card.ts`,
    );
  }
});

test('risk unknowns are matched by prefix, since they carry an index', () => {
  assert.equal(unknownGroupOf('risk-unknown-1'), 'PLATFORM');
  assert.equal(unknownGroupOf('risk-unknown-9'), 'PLATFORM');
});

test('grouping unknowns conserves every item and drops empty groups', () => {
  const unknowns = [
    { id: 'unknown:revenue', statement: 'a', reason: 'r' },
    { id: 'unknown:causation', statement: 'b', reason: 'r' },
    { id: 'no-historical-series', statement: 'c', reason: 'r' },
    { id: 'risk-unknown-1', statement: 'd', reason: 'r' },
    { id: 'something-nobody-mapped', statement: 'e', reason: 'r' },
  ];
  const groups = groupUnknowns(unknowns);
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  assert.equal(total, unknowns.length, 'a caveat must never be dropped by being ungrouped');
  assert.ok(groups.every((g) => g.items.length > 0), 'an empty group is noise');
  assert.ok(groups.some((g) => g.key === 'OTHER'), 'an unmapped id is kept, visibly');
});

test('grouping unknowns of nothing is nothing', () => {
  assert.deepEqual(groupUnknowns([]), []);
});

// --- Today's story ----------------------------------------------------------

test('the story headline is the first sentence, and the rest is kept verbatim', () => {
  const d = storyDigest('Revenue fell 18%. Two buyers account for most of it.', []);
  assert.equal(d.headline, 'Revenue fell 18%.');
  assert.equal(d.rest, 'Two buyers account for most of it.');
});

test('decimals and money do not split the headline', () => {
  const d = storyDigest('Revenue fell 18.4% to $1,980.50 this period. Then it steadied.', []);
  assert.equal(d.headline, 'Revenue fell 18.4% to $1,980.50 this period.');
  assert.equal(d.rest, 'Then it steadied.');
});

test('an unsplittable story becomes the headline whole, rather than an invented one', () => {
  const d = storyDigest('Nothing connected this period', []);
  assert.equal(d.headline, 'Nothing connected this period');
  assert.equal(d.rest, null);
});

test('bullets are whole narratives — a clipped hedge reads as a confident claim', () => {
  const long =
    'Buyer concentration rose, though this cannot be attributed to any routing change Loop can see.';
  const d = storyDigest('A story. And more.', [long, 'b', 'c', 'd']);
  assert.equal(d.bullets[0], long, 'never truncated');
  assert.equal(d.bullets.length, 3);
  assert.equal(d.moreCount, 1, 'what is not shown is disclosed, not dropped');
});
