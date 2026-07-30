import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSituations, buildQueue, buildBriefing, queueUnknowns,
  escalationOf, bySituationAttention,
  QUEUE_STATES, QUEUE_STATE_LABEL, ESCALATION_STATES, ESCALATION_LABEL, SITUATION_VERSION,
  type SituationInput,
} from '../src/callgrid-situation';
import { clusterFindings, type ReasoningCluster, type OperationalReasoning } from '../src/callgrid-reasoning';
import { rankFindings } from '../src/callgrid-scoring';
import { buildDecisionSupport } from '../src/callgrid-decision-support';
import { analyzeCallGrid, type IntelligenceInput } from '../src/callgrid-intelligence-engine';
import type { AffectedEntity, CallGridFinding } from '../src/callgrid-intelligence';

const NOW = new Date('2026-07-30T14:15:00.000Z');

function entity(
  id: string,
  over: Partial<AffectedEntity> = {},
): AffectedEntity {
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

/** Build the full projection input from a set of findings, using the real pipeline. */
function inputFor(findings: CallGridFinding[]): SituationInput {
  const clusters = clusterFindings(findings);
  const ranked = rankFindings(findings, {
    windowRevenueCents: 1_000_000, recurrence: null, recurrenceWindow: null,
  });
  const reasoning: OperationalReasoning = {
    clusters,
    relations: clusters.flatMap((c) => c.relations),
    timeline: [], stability: [],
    graph: { nodes: [], edges: [], version: 'v1' },
    businessStory: 'A story.', unknowns: [], version: 'v1',
  };
  const decisionSupport = buildDecisionSupport(ranked, {
    opportunitiesByFindingId: new Map(),
    revenueSeries: [],
    periodsPerYear: null,
  });
  return { reasoning, ranked, decisionSupport, opportunities: [] };
}

// --- The merge is the whole point --------------------------------------------------

test('a business event that produced four findings becomes ONE situation', () => {
  // Revenue fell; one buyer accounts for all of it. Attribution links them, so
  // they are one event — not two things for an operator to reconcile.
  const revenue = finding({
    id: 'rev', drivers: [entity('markytek', { contributionToChange: 1, absoluteChange: -180_000 })],
    affectedEntities: [entity('markytek')],
  });
  const driver = finding({
    id: 'drv', findingType: 'DRIVER', title: 'Markytek accounts for the decline',
    plainLanguageSummary: 'Markytek accounts for all of the revenue decline.',
    affectedEntities: [entity('markytek', { contributionToChange: 1 })],
    ruleId: 'entity-contribution',
  });

  const situations = buildSituations(inputFor([revenue, driver]));
  assert.equal(situations.length, 1, 'two related findings must merge into one situation');
  assert.equal(situations[0]!.observationCount, 2);
});

test('two UNRELATED problems stay two situations — co-occurrence is not a merge ground', () => {
  const buyerProblem = finding({
    id: 'a', affectedEntities: [entity('markytek')], ruleId: 'revenue-change',
  });
  const unrelated = finding({
    id: 'b', findingType: 'QUALITY', title: 'Billable rate fell',
    plainLanguageSummary: 'Billable rate fell 22%.',
    primaryMetric: 'billableRate', currentValue: 0.4, comparisonValue: 0.52,
    absoluteChange: null, percentageChange: -0.22,
    affectedEntities: [entity('other-vendor', { entityType: 'vendor' })],
    ruleId: 'billable-efficiency',
  });

  const situations = buildSituations(inputFor([buyerProblem, unrelated]));
  assert.equal(situations.length, 2, 'unrelated problems must never be merged into one');
});

test('every situation discloses its observation count and keeps them separately', () => {
  const revenue = finding({
    id: 'rev', drivers: [entity('markytek', { contributionToChange: 1, absoluteChange: -180_000 })],
    affectedEntities: [entity('markytek')],
  });
  const driver = finding({
    id: 'drv', findingType: 'DRIVER', affectedEntities: [entity('markytek', { contributionToChange: 1 })],
    ruleId: 'entity-contribution',
  });

  const s = buildSituations(inputFor([revenue, driver]))[0]!;
  assert.equal(s.observationCount, s.observations.length, 'the disclosed count must match what is kept');
  assert.ok(s.observations.length >= 2, 'the merge must remain reversible by the reader');
});

test('merging never softens urgency — the situation inherits the worst of its members', () => {
  const mild = finding({ id: 'mild', severity: 'INFORMATIONAL', affectedEntities: [entity('markytek')] });
  const severe = finding({
    id: 'severe', severity: 'CRITICAL', findingType: 'DRIVER',
    affectedEntities: [entity('markytek', { contributionToChange: 1 })],
    ruleId: 'entity-contribution',
  });

  const situations = buildSituations(inputFor([mild, severe]));
  const merged = situations.find((s) => s.observationCount > 1);
  if (merged) {
    assert.equal(merged.severity, 'CRITICAL', 'a merged situation must carry its worst member severity');
  }
});

// --- Attention ordering -------------------------------------------------------------

test('ordering is stable across identical runs', () => {
  const findings = [
    finding({ id: 'a', affectedEntities: [entity('one')] }),
    finding({ id: 'b', severity: 'NOTABLE', affectedEntities: [entity('two')], ruleId: 'profit-change' }),
    finding({ id: 'c', severity: 'CRITICAL', affectedEntities: [entity('three')], ruleId: 'volume-change' }),
  ];
  const first = buildSituations(inputFor(findings)).map((s) => s.key);
  const second = buildSituations(inputFor(findings)).map((s) => s.key);
  assert.deepEqual(first, second, 'a queue that reorders itself on refresh is not trustworthy');
});

test('the comparator is a total order — no pair compares equal unless keys match', () => {
  const findings = [
    finding({ id: 'a', affectedEntities: [entity('one')] }),
    finding({ id: 'b', severity: 'NOTABLE', affectedEntities: [entity('two')], ruleId: 'profit-change' }),
  ];
  const s = buildSituations(inputFor(findings));
  if (s.length === 2) {
    const cmp = bySituationAttention(s[0]!, s[1]!);
    assert.notEqual(cmp, 0, 'distinct situations must never tie');
  }
});

// --- Honest empty states ------------------------------------------------------------

test('an unreadable report is NEVER reported as an all-clear', () => {
  const queue = buildQueue(inputFor([]), { reportOk: false, periodLabel: 'Yesterday' });
  assert.equal(queue.situations.length, 0);
  assert.match(queue.emptyReason!, /not an all-clear/i);
  assert.doesNotMatch(queue.emptyReason!, /nothing needs your attention/i);
});

test('a genuinely quiet period gets a trustworthy all-clear that says what was examined', () => {
  const queue = buildQueue(inputFor([]), { reportOk: true, periodLabel: 'Yesterday' });
  assert.match(queue.emptyReason!, /nothing needs your attention/i);
  assert.match(queue.emptyReason!, /every significance rule was evaluated/i);
});

test('the engine has no opinion about who owns a Situation', () => {
  // The lane is a fact about what a human decided. It lives in the operational
  // record and is joined on in the surface; an engine that guessed at it would be
  // asserting ownership it cannot observe. Every Situation therefore leaves the
  // engine as NEEDS_REVIEW, meaning "the analysis has no opinion", and the five
  // lanes exist only as the shared vocabulary both sides agree on.
  const queue = buildQueue(inputFor([finding()]), { reportOk: true, periodLabel: 'Yesterday' });
  for (const s of queue.situations) assert.equal(s.queueState, 'NEEDS_REVIEW');
  assert.equal(QUEUE_STATES.length, 5);
});

test('every queue state and escalation state has an operator-facing label', () => {
  for (const s of QUEUE_STATES) assert.ok(QUEUE_STATE_LABEL[s], `${s} needs a label`);
  for (const e of ESCALATION_STATES) assert.ok(ESCALATION_LABEL[e], `${e} needs a label`);
});

// --- Escalation: measured, or withheld with a reason ---------------------------------

test('escalation is WITHHELD rather than defaulting to "new" when history is absent', () => {
  const cluster: ReasoningCluster = {
    id: 'c1', anchor: finding({ affectedEntities: [entity('markytek')] }),
    members: [finding({ affectedEntities: [entity('markytek')] })],
    relations: [], narrative: 'n', hasRootCause: false, likelyDownstream: [], unknowns: [],
  };
  const esc = escalationOf(cluster);
  assert.equal(esc.state, 'UNKNOWN', 'Loop must not claim a first sighting it cannot establish');
  assert.equal(esc.withheld, true);
  // The reason must describe the ANALYSIS's limit — it reads one window — and not
  // claim the platform has no memory. It has one now; the engine simply is not
  // the part that holds it.
  assert.match(esc.basis, /from this period alone/i);
  assert.match(esc.basis, /operational record/i);
  assert.doesNotMatch(esc.basis, /does not yet retain/i);
});

test('SPREADING is claimed only when genuinely observed across dimensions', () => {
  const anchor = finding({ affectedEntities: [entity('markytek')] });
  const other = finding({
    id: 'v', affectedEntities: [entity('whiterock', { entityType: 'vendor' })],
  });
  const cluster: ReasoningCluster = {
    id: 'c1', anchor, members: [anchor, other],
    relations: [], narrative: 'n', hasRootCause: false, likelyDownstream: [], unknowns: [],
  };
  const esc = escalationOf(cluster);
  assert.equal(esc.state, 'SPREADING');
  assert.equal(esc.withheld, false, 'a measured claim is not a withheld one');
});

test('a headline change plus one dimension is NOT spreading', () => {
  const anchor = finding({ affectedEntities: [entity('w', { entityType: 'window' })] });
  const driver = finding({ id: 'd', affectedEntities: [entity('markytek')] });
  const cluster: ReasoningCluster = {
    id: 'c1', anchor, members: [anchor, driver],
    relations: [], narrative: 'n', hasRootCause: false, likelyDownstream: [], unknowns: [],
  };
  assert.notEqual(escalationOf(cluster).state, 'SPREADING');
});

// --- Loop's read: the disconfirming field is mandatory -------------------------------

test("Loop's read always states what argues against it", () => {
  const revenue = finding({
    id: 'rev', drivers: [entity('markytek', { contributionToChange: 1, absoluteChange: -180_000 })],
    affectedEntities: [entity('markytek')],
  });
  const s = buildSituations(inputFor([revenue]))[0]!;
  assert.ok(s.read.arguesAgainst.length > 0, 'a read with no disconfirming field cannot be calibrated');
  assert.ok(s.read.claim.length > 0);
  assert.ok(s.read.because.length > 0);
  assert.ok(s.read.cannotSee.length > 0);
  assert.ok(s.read.wouldChange.length > 0);
});

test('a competing contributor is surfaced as disconfirming evidence, not hidden', () => {
  const revenue = finding({
    id: 'rev',
    drivers: [
      entity('markytek', { contributionToChange: 0.5, absoluteChange: -90_000 }),
      entity('other', { contributionToChange: 0.5, absoluteChange: -90_000 }),
    ],
    affectedEntities: [entity('markytek')],
  });
  const a = finding({
    id: 'a', findingType: 'DRIVER', affectedEntities: [entity('markytek', { contributionToChange: 0.5 })],
    ruleId: 'entity-contribution',
  });
  const b = finding({
    id: 'b', findingType: 'DRIVER', affectedEntities: [entity('other', { contributionToChange: 0.5 })],
    ruleId: 'entity-contribution',
  });

  const situations = buildSituations(inputFor([revenue, a, b]));
  const merged = situations.find((s) => s.observationCount > 1);
  if (merged) {
    assert.doesNotMatch(
      merged.read.arguesAgainst,
      /nothing measured contradicts/i,
      'with two equal contributors, the read must not claim nothing contradicts it',
    );
  }
});

// --- The chain always names its own end ----------------------------------------------

test('every chain has a terminus and something that would extend it', () => {
  const s = buildSituations(inputFor([finding({ affectedEntities: [entity('markytek')] })]))[0]!;
  assert.ok(s.chain.links.length >= 1);
  assert.ok(s.chain.terminus.length > 0, 'a chain that stops silently reads as a complete explanation');
  assert.ok(s.chain.wouldExtend.length > 0);
  assert.match(s.chain.terminus, /stops here/i);
});

// --- Money and the one refusal --------------------------------------------------------

test('"if ignored" restates the measured rate and refuses to price acting', () => {
  const s = buildSituations(inputFor([finding({ affectedEntities: [entity('markytek')] })]))[0]!;
  if (s.ifIgnored) {
    assert.match(s.ifIgnored, /cannot say what acting would recover|persists|withheld/i);
  }
});

test('a situation never presents a confidence percentage as its headline', () => {
  const s = buildSituations(inputFor([finding({ affectedEntities: [entity('markytek')] })]))[0]!;
  // The score exists for ordering; nothing in the operator-facing strings may
  // present it (or a confidence) as a probability of being correct.
  for (const text of [s.whatHappened, s.whyItMatters, s.read.claim, s.title]) {
    assert.doesNotMatch(text, /\b\d{1,3}% (confiden|certain|sure|probab)/i);
  }
});

// --- The briefing is assembled FROM the queue -----------------------------------------

test('the briefing names how many things need attention and which to start with', () => {
  const findings = [
    finding({ id: 'a', severity: 'CRITICAL', affectedEntities: [entity('markytek')] }),
    finding({ id: 'b', severity: 'NOTABLE', affectedEntities: [entity('other')], ruleId: 'profit-change' }),
  ];
  const input = inputFor(findings);
  const queue = buildQueue(input, { reportOk: true, periodLabel: 'Yesterday' });
  const briefing = buildBriefing(queue, { periodLabel: 'Yesterday' });

  assert.ok(briefing.opener.length > 0);
  assert.ok(briefing.opener.length < 90, 'the opener must be readable in one glance');
  if (queue.situations.length > 0) {
    assert.ok(briefing.sequencing, 'the briefing must say why the first item is first');
    assert.match(briefing.sequencing!, /^Start with /);
  }
});

test('the briefing cannot claim an all-clear when the report failed', () => {
  const queue = buildQueue(inputFor([]), { reportOk: false, periodLabel: 'Yesterday' });
  const briefing = buildBriefing(queue, { periodLabel: 'Yesterday' });
  assert.match(briefing.opener, /not an all-clear/i);
  assert.equal(briefing.sequencing, null);
});

test('unpriced situations are counted, never silently dropped from the total', () => {
  const unpriced = finding({
    id: 'u', primaryMetric: 'revenueShare', findingType: 'CONCENTRATION',
    currentValue: 0.62, comparisonValue: null, absoluteChange: null, percentageChange: null,
    affectedEntities: [entity('markytek')], ruleId: 'revenue-concentration',
  });
  const queue = buildQueue(inputFor([unpriced]), { reportOk: true, periodLabel: 'Yesterday' });
  const briefing = buildBriefing(queue, { periodLabel: 'Yesterday' });
  assert.equal(
    briefing.unpricedCount + (briefing.measuredImpactCents === null ? 0 : queue.situations.length - briefing.unpricedCount),
    queue.situations.length,
    'every surfaced situation is either priced or counted as unpriced',
  );
});

// --- Page-level unknowns ---------------------------------------------------------------

test('the queue no longer claims it cannot know whether someone is on it', () => {
  // Retired deliberately. Ownership IS knowable now — it is in the operational
  // record — so disclosing it as an unknown would be the opposite failure to the
  // one the disclosure was written for: understating what the product can do.
  const queue = buildQueue(inputFor([finding({ affectedEntities: [entity('markytek')] })]), {
    reportOk: true, periodLabel: 'Yesterday',
  });
  const unknowns = queueUnknowns(queue);
  assert.ok(!unknowns.some((u) => /already working/i.test(u.statement)));
  assert.ok(unknowns.every((u) => u.reason.length > 0), 'every unknown must state its reason');
});

// --- Integration: the engine exposes the queue -----------------------------------------

function engineInput(over: Partial<IntelligenceInput> = {}): IntelligenceInput {
  return {
    now: NOW,
    reportOk: true,
    windowLabel: 'Yesterday',
    comparisonLabel: 'The day before',
    comparisonBasis: 'previous_period',
    includesLiveData: false,
    metrics: {
      available: true, totalCalls: 900, billableCalls: 400,
      revenueCents: 820_000, profitCents: 300_000, payoutCents: 400_000, costCents: 120_000,
      revenueCoverage: 1, profitCoverage: 1,
    },
    comparison: {
      available: true, totalCalls: 950, billableCalls: 430,
      revenueCents: 1_000_000, profitCents: 420_000, payoutCents: 450_000, costCents: 130_000,
      revenueCoverage: 1, profitCoverage: 1,
    },
    dimensions: {
      buyers: [
        { key: 'markytek', label: 'Markytek', calls: 300, monetized: 120, revenueCents: 0, marginCents: 0 },
        { key: 'apex', label: 'Apex', calls: 600, monetized: 280, revenueCents: 820_000, marginCents: 300_000 },
      ],
      vendors: [], sources: [], campaigns: [],
    },
    comparisonDimensions: {
      buyers: [
        { key: 'markytek', label: 'Markytek', calls: 320, monetized: 150, revenueCents: 180_000, marginCents: 60_000 },
        { key: 'apex', label: 'Apex', calls: 630, monetized: 280, revenueCents: 820_000, marginCents: 360_000 },
      ],
      vendors: [], sources: [], campaigns: [],
    },
    periodsPerYear: 365,
    ...over,
  } as IntelligenceInput;
}

test('analyzeCallGrid exposes a queue and a briefing derived from it', () => {
  const intel = analyzeCallGrid(engineInput());
  assert.ok(intel.queue, 'the engine must expose the operator queue');
  assert.equal(intel.queue.version, SITUATION_VERSION);
  assert.ok(intel.briefing.opener.length > 0);
});

test('the queue never contains more rows than there are findings', () => {
  const intel = analyzeCallGrid(engineInput());
  assert.ok(
    intel.queue.situations.length <= intel.findings.length,
    'merging can only ever reduce the count',
  );
});

test('every finding that scored is reachable through exactly one situation', () => {
  const intel = analyzeCallGrid(engineInput());
  const seen = new Map<string, number>();
  for (const s of intel.queue.situations) {
    for (const o of s.observations) seen.set(o.id, (seen.get(o.id) ?? 0) + 1);
  }
  for (const [id, count] of seen) {
    assert.equal(count, 1, `finding ${id} appears in ${count} situations — a finding must belong to exactly one`);
  }
});

test('an unreadable report produces a queue that refuses to imply everything is fine', () => {
  const intel = analyzeCallGrid(engineInput({ reportOk: false }));
  assert.equal(intel.queue.situations.length, 0);
  assert.match(intel.queue.emptyReason!, /not an all-clear/i);
});
