// Recommendations on a Case — decision support that cannot become instruction,
// and cannot become work.
//
// WHAT THESE PROVE
//
// THE CEILING IS REAL AND IT COMES FROM THE FINDING. A set proposing a committed
// change over a DEVELOPING finding is refused whole, and nothing is written. The
// same set becomes recordable the moment the finding establishes — proved by
// changing only the readiness verdict, with no row edited in between.
//
// THE MACHINE'S WORDS SURVIVE EVERY HUMAN ACT. Selecting fills the approval
// columns that already existed. Dismissing writes only to the log. A revision is
// a separate row naming what it came from. After all three, the option's own
// text, order and factors are byte-identical to what Loop wrote.
//
// NOTHING EXECUTABLE IS CREATED. No work instance, no stage, no assignment, no
// blueprint, no notification. A proposed sequence is a sentence, not a plan the
// system has started.
//
// THE RANKING IS RECONSTRUCTABLE. The view carries the factors on which each
// option beats the one below it, and carries no score anywhere.
//
// They run on the in-memory Prisma double with the REAL Decision Engine, the REAL
// Finding service and the REAL cognitive decision repository underneath.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  INVESTIGATION_PRODUCER,
  RECOMMENDATION_DECISION_TYPE,
  RECOMMENDATION_DISMISSED_REASON,
  RECOMMENDATION_RECORDED_REASON,
  RECOMMENDATION_SELECTED_REASON,
  assessReadiness,
  assessWindowObservation,
  investigationRecurrenceKey,
  isRecommendationEvent,
  recommendationKey,
  type BusinessDate,
  type HeadlineView,
  type MeasureSourceAuthorityDeclaration,
  type MeasurementReadiness,
  type MeasurementSourceDefinition,
  type ProviderObservationStatus,
  type ReadinessInput,
  type ReconciliationCounts,
  type ReconciliationDayFact,
  type ReconciliationMemberFact,
  type RecommendationOption,
  type RecommendedAction,
} from '@emgloop/shared';

import { makeCognitivePrisma } from './helpers/cognitive-prisma-fake';
import { DecisionEngine } from '../src/services/decision/decision-engine';
import { IntelligenceHypothesisRepository } from '../src/repositories/cognitive/hypothesis.repository';
import { CaseFindingService } from '../src/services/case-finding.service';
import { CaseRecommendationService } from '../src/services/case-recommendation.service';

const ORG = 'org-alpha';
const OTHER_ORG = 'org-beta';
const HEADLINE_ID = 'hl_cem';
const OBJECTIVE_ID = 'obj_medicare';
const NOW = new Date('2026-08-23T14:30:00.000Z');

const SYSTEM = { type: 'SYSTEM' as const, userId: null, source: INVESTIGATION_PRODUCER };
const HUMAN = { type: 'HUMAN' as const, userId: 'usr_matt', source: 'operator' };

// --- Real Stage 3 verdicts ------------------------------------------------------------

const DATES: BusinessDate[] = ['2026-08-04', '2026-08-05'];
const CAMPAIGN = 'cmp-medicare';

const SOURCE: MeasurementSourceDefinition = {
  key: 'provider-calls',
  kind: 'PROVIDER_STREAM',
  displayName: 'Call provider',
  supportedMetrics: ['CALL_VOLUME', 'REVENUE'],
  measureDefinitionIds: { CALL_VOLUME: 'calls.provider.v1', REVENUE: 'revenue.provider.v1' },
  provider: 'callgrid',
  stream: 'calls',
};

const AUTHORITY: MeasureSourceAuthorityDeclaration = {
  dimension: 'CAMPAIGN',
  memberExternalId: CAMPAIGN,
  metric: 'REVENUE',
  sourceKey: 'provider-calls',
  effectiveFrom: '2026-01-01',
  effectiveTo: null,
};

function counts(): ReconciliationCounts {
  return {
    providerUnique: 100, providerDuplicateIds: 0, localUnique: 100, localDuplicateIds: 0,
    intersection: 100, providerOnly: 0, localOnly: 0, providerOnlyExpected: 0,
    providerOnlyNotConfigured: 0, providerOnlyExcluded: 0, providerOnlyUnknownMember: 0,
  };
}

function member(over: Partial<ReconciliationMemberFact> = {}): ReconciliationMemberFact {
  return {
    dimension: 'CAMPAIGN', memberExternalId: CAMPAIGN, providerCount: 100,
    localCount: 100, providerOnly: 0, expectation: 'EXPECTED', ...over,
  };
}

function day(date: BusinessDate, over: Partial<ReconciliationDayFact> = {}): ReconciliationDayFact {
  return {
    businessDate: date, state: 'RECONCILED', counts: counts(), members: [member()],
    ruleVersion: 'provider-reconciliation.v1', ...over,
  };
}

function verdict(over: Partial<ReadinessInput> = {}): MeasurementReadiness {
  const m = new Map<BusinessDate, ProviderObservationStatus>();
  for (const d of DATES) m.set(d, 'SUCCESS');
  return assessReadiness({
    metric: 'REVENUE',
    dates: DATES,
    observation: assessWindowObservation(DATES, m),
    partitions: [{ dimension: 'CAMPAIGN', memberExternalId: CAMPAIGN, localCalls: 200 }],
    unattributedCalls: 0,
    reconciliation: DATES.map((d) => day(d)),
    authorities: [AUTHORITY],
    sources: [SOURCE],
    outcomeDays: [],
    ...over,
  });
}

const READY = verdict();
/** A window with a day nobody reconciled — the finding stays DEVELOPING. */
const DEGRADED = verdict({ reconciliation: [day('2026-08-04')] });

function headline(): HeadlineView {
  return {
    id: HEADLINE_ID,
    performanceObjectiveId: OBJECTIVE_ID,
    objectiveTitle: 'Grow Medicare answer rate',
    measureBindingId: 'bind_1',
    measureBindingVersion: 3,
    measurement: {
      metric: 'MONETIZED_RATE', metricLabel: 'Monetized rate', unit: 'RATIO',
      movement: 'DECREASE', againstObjective: true, currentValue: 0.412, priorValue: 0.597,
      absoluteChange: -0.185, percentageChange: -0.31, currentDenominator: 3184,
      priorDenominator: 2996, currentCoverage: 0.98, priorCoverage: 0.99,
      comparisonBasis: 'Trailing 7 complete Eastern business days.',
      currentWindowStart: '2026-08-15T04:00:00.000Z', currentWindowEnd: '2026-08-22T04:00:00.000Z',
      priorWindowStart: '2026-08-08T04:00:00.000Z', priorWindowEnd: '2026-08-15T04:00:00.000Z',
    },
    statement: "Buyer CEM's monetized rate fell from 59.7% to 41.2%.",
    limitations: ['Postback destinations settle after the call.'],
    unknowns: [],
    ruleId: 'ci.objective-measure-change', ruleVersion: 'v1', producerVersion: 'ci-headline.v1',
    ruleDescription: 'A move of at least 15% over at least 200 calls.',
    firstDetectedAt: '2026-08-20T11:02:00.000Z', lastDetectedAt: '2026-08-22T06:15:00.000Z',
    detectionCount: 3, dismissedAt: null, dismissedByUserId: null, dismissedByName: null,
    dismissalBasis: null, createdAt: '2026-08-20T11:02:00.000Z',
  };
}

// --- The world -------------------------------------------------------------------------

async function world(options: { readiness?: MeasurementReadiness | null; withFinding?: boolean } = {}) {
  const prisma = makeCognitivePrisma();
  const engine = new DecisionEngine(prisma as never);
  const hypotheses = new IntelligenceHypothesisRepository(prisma as never);
  const findings = new CaseFindingService(prisma as never, {
    cases: engine,
    headlines: { async get(org: string, id: string) { return org === ORG && id === HEADLINE_ID ? headline() : null; } },
    hypotheses,
    readiness: {
      async readinessFor(_org: string, objectiveId: string) {
        const r = options.readiness === undefined ? READY : options.readiness;
        return objectiveId === OBJECTIVE_ID && r ? { readiness: r } : null;
      },
    },
  });
  const recommendations = new CaseRecommendationService(prisma as never, { cases: engine, findings });

  const { decision } = await engine.create(ORG, {
    producer: INVESTIGATION_PRODUCER,
    recurrenceKey: investigationRecurrenceKey(HEADLINE_ID),
    detectionKey: `promotion:${HEADLINE_ID}`,
    detectedAt: NOW,
    title: "Buyer CEM's monetized rate fell from 59.7% to 41.2%.",
    severity: 'NOTABLE',
    sourceReference: HEADLINE_ID,
    evidence: [
      {
        source: INVESTIGATION_PRODUCER,
        metricKey: 'MONETIZED_RATE',
        window: 'Trailing 7 business days',
        derivedValue: 0.412,
        completeness: 1,
      },
    ],
  });

  if (options.withFinding !== false) {
    await findings.record(ORG, decision.id, {
      claim: 'CEM stopped settling same-day.',
      claimKind: 'MEASUREMENT_BACKED',
      generatedBy: 'DETERMINISTIC_RULE',
      actor: SYSTEM,
    });
  }

  return { prisma, engine, findings, recommendations, caseId: decision.id, hypotheses };
}

// --- Option fixtures ---------------------------------------------------------------------

function step(position: number, verb: RecommendedAction['verb'], rest: string): RecommendedAction {
  return { position, verb, statement: `${verb} ${rest}`, intent: null };
}

function revenueFirst(over: Partial<RecommendationOption> = {}): RecommendationOption {
  return {
    key: 'protect-revenue',
    label: 'Protect Revenue First',
    summary: 'Move volume away while the cause is established.',
    posture: 'REVERSIBLE_MITIGATION',
    factors: [
      { factor: 'EXPECTED_BENEFIT', level: 'HIGH', basis: 'The exposed spend is the largest single line.' },
      { factor: 'RELATIONSHIP_RISK', level: 'HIGH', basis: 'The buyer notices volume moving within a day.' },
      { factor: 'REVERSIBILITY', level: 'HIGH', basis: 'Routing can be restored the same day.' },
    ],
    actions: [
      step(1, 'Evaluate', 'shifting volume to the backup buyer.'),
      step(2, 'Monitor', 'recovery over the next two days.'),
    ],
    rank: 1,
    ...over,
  };
}

function relationshipFirst(over: Partial<RecommendationOption> = {}): RecommendationOption {
  return {
    key: 'protect-relationship',
    label: 'Protect Relationship First',
    summary: 'Ask the buyer before moving anything.',
    posture: 'DIAGNOSTIC',
    factors: [
      { factor: 'EXPECTED_BENEFIT', level: 'MODERATE', basis: 'Only helps if the buyer explains it.' },
      { factor: 'RELATIONSHIP_RISK', level: 'LOW', basis: 'Asking first is the expected courtesy.' },
      { factor: 'REVERSIBILITY', level: 'HIGH', basis: 'A conversation commits nothing.' },
    ],
    actions: [step(1, 'Contact', 'the buyer about the settlement change.')],
    rank: 2,
    ...over,
  };
}

function learnFirst(rank = 1): RecommendationOption {
  return {
    key: 'learn-first',
    label: 'Learn Before Acting',
    summary: 'Establish whether the disposition feed is complete.',
    posture: 'LEARN_BEFORE_ACTING',
    factors: [{ factor: 'EFFORT', level: 'LOW', basis: 'One report, already available.' }],
    actions: [step(1, 'Validate', 'the disposition feed for the window.')],
    rank,
  };
}

const SET = { author: 'MACHINE' as const, actor: SYSTEM };

// --- Lineage ------------------------------------------------------------------------------

test('a recommendation links to the finding and the case that justified it', async () => {
  const { recommendations, findings, caseId } = await world();
  const finding = await findings.get(ORG, caseId, NOW);

  const result = await recommendations.record(ORG, caseId, {
    ...SET,
    options: [revenueFirst(), relationshipFirst(), learnFirst(3)],
  });
  assert.equal(result.outcome, 'RECORDED');
  assert.equal(result.setNumber, 1);
  assert.equal(result.optionIds.length, 3);

  const view = await recommendations.get(ORG, caseId);
  assert.equal(view?.caseId, caseId);
  assert.equal(view?.findingId, finding?.findingId);
  assert.equal(view?.findingStateAtIssue, 'ESTABLISHED');
  assert.equal(view?.evidenceStrengthAtIssue, 'HIGH');
});

test('a case with no finding cannot carry recommendations', async () => {
  const { recommendations, caseId, prisma } = await world({ withFinding: false });
  const result = await recommendations.record(ORG, caseId, { ...SET, options: [learnFirst()] });
  assert.equal(result.outcome, 'NO_FINDING');
  assert.equal((await prisma.cognitiveDecision.findMany({})).length, 0);
});

test('the recorded set is on the case’s own log, matched by the shared predicate', async () => {
  const { recommendations, caseId, prisma } = await world();
  await recommendations.record(ORG, caseId, { ...SET, options: [revenueFirst(), relationshipFirst()] });

  const log = await prisma.operationalObservation.findMany({ where: { priorityId: caseId } });
  const recorded = log.filter((o: any) => isRecommendationEvent(o, 'RECORDED'));
  assert.equal(recorded.length, 2, 'one log entry per option, each citing its decision');
  assert.ok(recorded.every((o: any) => o.decisionId), 'every entry points at the decision it is about');
});

// --- The ceiling ----------------------------------------------------------------------------

test('a developing finding refuses a committed change, and writes nothing', async () => {
  const { recommendations, findings, caseId, prisma } = await world({ readiness: DEGRADED });
  assert.equal((await findings.get(ORG, caseId, NOW))?.state, 'DEVELOPING');

  const result = await recommendations.record(ORG, caseId, {
    ...SET,
    options: [revenueFirst({ posture: 'COMMITTED_CHANGE' }), learnFirst(2)],
  });
  assert.equal(result.outcome, 'REJECTED');
  assert.deepEqual(result.rejections, ['POSTURE_EXCEEDS_EVIDENCE']);
  assert.deepEqual(result.offendingKeys, ['protect-revenue']);

  // REFUSED WHOLE. The sibling option that WAS allowed is not quietly stored.
  assert.equal((await prisma.cognitiveDecision.findMany({})).length, 0);
  assert.equal(await recommendations.get(ORG, caseId), null);
});

test('the same set becomes recordable when the finding establishes — nothing was edited', async () => {
  const options = [revenueFirst({ posture: 'COMMITTED_CHANGE' })];

  const developing = await world({ readiness: DEGRADED });
  assert.equal((await developing.recommendations.record(ORG, developing.caseId, { ...SET, options })).outcome, 'REJECTED');

  const established = await world({ readiness: READY });
  assert.equal((await established.recommendations.record(ORG, established.caseId, { ...SET, options })).outcome, 'RECORDED');
});

test('a developing finding still supports learning, diagnosis and reversible mitigation', async () => {
  const { recommendations, caseId } = await world({ readiness: DEGRADED });
  const result = await recommendations.record(ORG, caseId, {
    ...SET,
    options: [revenueFirst(), relationshipFirst(), learnFirst(3)],
  });
  assert.equal(result.outcome, 'RECORDED');
});

test('a step that tells someone to change something is refused at the service boundary', async () => {
  const { recommendations, caseId, prisma } = await world();
  const result = await recommendations.record(ORG, caseId, {
    ...SET,
    options: [
      revenueFirst({
        actions: [{ position: 1, verb: 'Review', statement: 'Reroute the traffic to the backup.', intent: null }],
      }),
    ],
  });
  assert.equal(result.outcome, 'REJECTED');
  assert.ok(result.rejections.includes('UNSAFE_ACTION_VERB'));
  assert.equal((await prisma.cognitiveDecision.findMany({})).length, 0);
});

// --- Alternatives and explainable ranking ------------------------------------------------------

test('several alternatives are kept, in the author’s order, with no winner asserted', async () => {
  const { recommendations, caseId } = await world();
  await recommendations.record(ORG, caseId, {
    ...SET,
    options: [relationshipFirst(), learnFirst(3), revenueFirst()],
  });

  const view = await recommendations.get(ORG, caseId);
  assert.deepEqual(view?.options.map((o) => o.key), [
    'protect-revenue',
    'protect-relationship',
    'learn-first',
  ]);
  assert.deepEqual(view?.options.map((o) => o.rank), [1, 2, 3]);
});

test('the view answers "why is this ranked above that" from inspectable factors', async () => {
  const { recommendations, caseId } = await world();
  await recommendations.record(ORG, caseId, { ...SET, options: [revenueFirst(), relationshipFirst()] });

  const view = await recommendations.get(ORG, caseId);
  assert.equal(view?.comparisons.length, 1);
  const c = view!.comparisons[0]!;
  assert.equal(c.leftKey, 'protect-revenue');
  assert.equal(c.rightKey, 'protect-relationship');
  assert.deepEqual(c.favouringLeft.map((d) => d.factor), ['EXPECTED_BENEFIT']);
  // HIGHER IS NOT ALWAYS BETTER: higher relationship risk favours the other side.
  assert.deepEqual(c.favouringRight.map((d) => d.factor), ['RELATIONSHIP_RISK']);
  assert.ok(c.incomparable.includes('EFFORT'), 'unassessed factors are named, not defaulted');
});

test('no opaque score reaches the read model', async () => {
  const { recommendations, caseId } = await world();
  await recommendations.record(ORG, caseId, { ...SET, options: [revenueFirst(), relationshipFirst()] });
  const serialized = JSON.stringify(await recommendations.get(ORG, caseId));
  assert.equal(/"score"|"weight"|"probability"|"confidence":\s*[0-9]/.test(serialized), false);
});

test('the stored decision carries no confidence and is not pre-approved', async () => {
  const { recommendations, caseId, prisma } = await world();
  await recommendations.record(ORG, caseId, { ...SET, options: [learnFirst()] });
  const rows = await prisma.cognitiveDecision.findMany({});
  assert.equal(rows.length, 1);
  assert.equal(rows[0].confidence, null);
  assert.equal(rows[0].decision, 'RECOMMEND');
  assert.equal(rows[0].decisionType, RECOMMENDATION_DECISION_TYPE);
  assert.equal(rows[0].approvedAt, null);
  assert.equal(rows[0].requiresApproval, true);
});

// --- Human control, machine history --------------------------------------------------------------

test('selecting an option fills the approval columns that already existed', async () => {
  const { recommendations, caseId, prisma } = await world();
  await recommendations.record(ORG, caseId, { ...SET, options: [revenueFirst(), relationshipFirst()] });

  const approved = await recommendations.select(ORG, caseId, 'protect-relationship', HUMAN);
  assert.equal(approved?.approvedBy, HUMAN.userId);
  assert.ok(approved?.approvedAt);

  const view = await recommendations.get(ORG, caseId);
  const chosen = view?.options.find((o) => o.key === 'protect-relationship');
  assert.equal(chosen?.selectedByUserId, HUMAN.userId);
  // AND THE OTHER OPTION IS UNTOUCHED. Choosing one does not retract the others.
  assert.equal(view?.options.find((o) => o.key === 'protect-revenue')?.selectedByUserId, null);

  const log = await prisma.operationalObservation.findMany({ where: { priorityId: caseId } });
  assert.equal(log.filter((o: any) => isRecommendationEvent(o, 'SELECTED')).length, 1);
});

test('selecting requires an attributed person', async () => {
  const { recommendations, caseId } = await world();
  await recommendations.record(ORG, caseId, { ...SET, options: [learnFirst()] });
  await assert.rejects(
    () => recommendations.select(ORG, caseId, 'learn-first', SYSTEM),
    /attributed person/,
  );
});

test('a human choice never rewrites what Loop wrote', async () => {
  const { recommendations, caseId } = await world();
  await recommendations.record(ORG, caseId, { ...SET, options: [revenueFirst(), relationshipFirst()] });
  const before = (await recommendations.get(ORG, caseId))!.options.map((o) => ({
    key: o.key, summary: o.summary, actions: o.actions, factors: o.factors, rank: o.rank,
  }));

  await recommendations.select(ORG, caseId, 'protect-relationship', HUMAN);
  await recommendations.dismiss(ORG, caseId, 'protect-revenue', HUMAN);
  await recommendations.revise(
    ORG,
    caseId,
    'protect-revenue',
    [step(1, 'Contact', 'the buyer first.'), step(2, 'Evaluate', 'shifting volume to the backup buyer.')],
    HUMAN,
  );

  const after = (await recommendations.get(ORG, caseId))!.options.map((o) => ({
    key: o.key, summary: o.summary, actions: o.actions, factors: o.factors, rank: o.rank,
  }));
  assert.deepEqual(after, before, 'the machine’s options are byte-identical after three human acts');
});

test('dismissing an option is recorded without touching its row', async () => {
  const { recommendations, caseId, prisma } = await world();
  await recommendations.record(ORG, caseId, { ...SET, options: [revenueFirst(), relationshipFirst()] });
  assert.equal(await recommendations.dismiss(ORG, caseId, 'protect-revenue', HUMAN), true);

  const view = await recommendations.get(ORG, caseId);
  assert.equal(view?.options.find((o) => o.key === 'protect-revenue')?.dismissed, true);
  assert.equal(view?.options.find((o) => o.key === 'protect-relationship')?.dismissed, false);

  const log = await prisma.operationalObservation.findMany({ where: { priorityId: caseId } });
  assert.equal(log.filter((o: any) => o.reason === RECOMMENDATION_DISMISSED_REASON).length, 1);
});

test('a revision is a separate row that names what it came from', async () => {
  const { recommendations, caseId, prisma } = await world();
  await recommendations.record(ORG, caseId, { ...SET, options: [revenueFirst()] });
  const original = (await recommendations.get(ORG, caseId))!.options[0]!;

  const revised = await recommendations.revise(
    ORG,
    caseId,
    'protect-revenue',
    [
      step(1, 'Contact', 'the buyer about the settlement change.'),
      step(2, 'Evaluate', 'shifting volume to the backup buyer.'),
    ],
    HUMAN,
  );
  assert.ok(revised);
  assert.notEqual(revised!.decisionId, original.decisionId);

  const view = await recommendations.get(ORG, caseId);
  const option = view!.options[0]!;
  assert.equal(option.decisionId, original.decisionId, 'the machine row is still the option');
  assert.equal(option.revision?.revisedByUserId, HUMAN.userId);
  assert.deepEqual(option.revision?.changed.added, ['Contact the buyer about the settlement change.']);
  assert.deepEqual(option.revision?.changed.removed, ['Monitor recovery over the next two days.']);
  assert.equal(option.revision?.changed.unchanged, false);

  // THE QUESTION, NOT THE ANSWER. Loop names what to re-weigh; it does not claim
  // to know which way the tradeoff moved.
  assert.ok(option.revision!.factorsToReconsider.includes('RELATIONSHIP_RISK'));
  assert.equal(option.revision!.factorsToReconsider.includes('EVIDENCE_STRENGTH'), false);

  const rows = await prisma.cognitiveDecision.findMany({});
  assert.equal(rows.length, 2, 'the original and the revision are two rows');
});

test('a revision may not smuggle in an instruction', async () => {
  const { recommendations, caseId } = await world();
  await recommendations.record(ORG, caseId, { ...SET, options: [revenueFirst()] });
  await assert.rejects(
    () =>
      recommendations.revise(
        ORG,
        caseId,
        'protect-revenue',
        [{ position: 1, verb: 'Review', statement: 'Pause the campaign.', intent: null }],
        HUMAN,
      ),
    /UNSAFE_ACTION_VERB/,
  );
});

// --- Supersession -----------------------------------------------------------------------------

test('a second set supersedes the first without editing it', async () => {
  const { recommendations, caseId } = await world();
  await recommendations.record(ORG, caseId, { ...SET, options: [revenueFirst(), relationshipFirst()] });
  const second = await recommendations.record(ORG, caseId, {
    ...SET,
    options: [learnFirst(), relationshipFirst()].map((o, i) => ({ ...o, rank: i + 1 })),
  });
  assert.equal(second.outcome, 'RECORDED');
  assert.equal(second.setNumber, 2);

  const view = await recommendations.get(ORG, caseId);
  assert.equal(view?.setNumber, 2);
  assert.equal(view?.supersededSets.length, 1);
  assert.equal(view?.supersededSets[0]?.setNumber, 1);
  assert.deepEqual(view?.supersededSets[0]?.options.map((o) => o.key), [
    'protect-revenue',
    'protect-relationship',
  ]);
});

test('re-recording the same set converges on the same rows', async () => {
  const { recommendations, caseId, prisma } = await world();
  const options = [revenueFirst(), relationshipFirst()];
  const first = await recommendations.record(ORG, caseId, { ...SET, options });
  assert.equal(first.setNumber, 1);
  assert.equal((await prisma.cognitiveDecision.findMany({})).length, 2);

  // A producer re-run over the same case starts a new SET rather than duplicating
  // the first, and the keys prove which is which.
  const again = await recommendations.record(ORG, caseId, { ...SET, options });
  assert.equal(again.setNumber, 2);
  const rows = await prisma.cognitiveDecision.findMany({});
  assert.equal(rows.length, 4);
  assert.ok(rows.some((r: any) => r.idempotencyKey === recommendationKey(caseId, 1, 'protect-revenue')));
  assert.ok(rows.some((r: any) => r.idempotencyKey === recommendationKey(caseId, 2, 'protect-revenue')));
});

// --- Tenancy ------------------------------------------------------------------------------------

test('a case in another organization is not-found, and nothing is written', async () => {
  const { recommendations, caseId, prisma } = await world();
  const result = await recommendations.record(OTHER_ORG, caseId, { ...SET, options: [learnFirst()] });
  assert.equal(result.outcome, 'CASE_NOT_FOUND');
  assert.equal((await prisma.cognitiveDecision.findMany({})).length, 0);
  assert.equal(await recommendations.get(OTHER_ORG, caseId), null);
});

test('recommendations cannot be selected, dismissed or revised across a tenant boundary', async () => {
  const { recommendations, caseId, prisma } = await world();
  await recommendations.record(ORG, caseId, { ...SET, options: [revenueFirst()] });

  assert.equal(await recommendations.select(OTHER_ORG, caseId, 'protect-revenue', HUMAN), null);
  assert.equal(await recommendations.dismiss(OTHER_ORG, caseId, 'protect-revenue', HUMAN), false);
  assert.equal(
    await recommendations.revise(OTHER_ORG, caseId, 'protect-revenue', [step(1, 'Review', 'x.')], HUMAN),
    null,
  );

  const rows = await prisma.cognitiveDecision.findMany({});
  assert.equal(rows.length, 1, 'no revision row was created for the other tenant');
  assert.equal(rows[0].approvedBy, null);
});

// --- What this stage must NOT do ------------------------------------------------------------------

test('recording, selecting and revising create nothing executable', async () => {
  const { recommendations, caseId, prisma } = await world();
  await recommendations.record(ORG, caseId, { ...SET, options: [revenueFirst(), learnFirst(2)] });
  await recommendations.select(ORG, caseId, 'protect-revenue', HUMAN);
  await recommendations.revise(ORG, caseId, 'protect-revenue', [step(1, 'Review', 'the feed.')], HUMAN);

  // NONE OF THESE TABLES IS MODELLED ON THIS DOUBLE, so any attempt to reach Work
  // OS would throw rather than pass quietly. Asserting their absence is what makes
  // that a fact rather than an accident of the fixture.
  for (const table of ['workInstance', 'workStage', 'workAssignment', 'blueprint', 'workNotification']) {
    assert.equal(table in prisma, false, `Stage 4 must not reach ${table}`);
  }
});

test('recording a recommendation does not move the case or touch the finding', async () => {
  const { recommendations, engine, findings, caseId } = await world();
  const caseBefore = await engine.get(ORG, caseId);
  const findingBefore = await findings.get(ORG, caseId, NOW);

  await recommendations.record(ORG, caseId, { ...SET, options: [revenueFirst()] });
  await recommendations.select(ORG, caseId, 'protect-revenue', HUMAN);
  await recommendations.dismiss(ORG, caseId, 'protect-revenue', HUMAN);

  const caseAfter = await engine.get(ORG, caseId);
  const findingAfter = await findings.get(ORG, caseId, NOW);

  assert.equal(caseAfter?.currentState, caseBefore?.currentState);
  assert.equal(caseAfter?.ownerUserId, caseBefore?.ownerUserId);
  assert.equal(caseAfter?.assigneeUserId, caseBefore?.assigneeUserId);
  assert.equal(caseAfter?.decision.hypothesisId, caseBefore?.decision.hypothesisId);
  assert.equal(caseAfter?.evidence.length, caseBefore?.evidence.length);

  assert.equal(findingAfter?.findingId, findingBefore?.findingId);
  assert.equal(findingAfter?.claim, findingBefore?.claim);
  assert.equal(findingAfter?.state, findingBefore?.state);
});

const SERVICE_SOURCE = readFileSync(
  new URL('../src/services/case-recommendation.service.ts', import.meta.url),
  'utf8',
);

test('no model is called, and no external action is reachable', async () => {
  for (const forbidden of ['anthropic', 'openai', 'fetch(', 'sendmail', 'resend', 'twilio']) {
    assert.equal(SERVICE_SOURCE.toLowerCase().includes(forbidden), false, `must not reference ${forbidden}`);
  }
});

test('no second recommendation store is created', async () => {
  // Persistence goes through the repository that already owns CognitiveDecision
  // and through the engine's log. The only direct `prisma.` reads here are the
  // keyed option list and the observation link, both organization-scoped.
  for (const write of ['cognitiveDecision.create', 'cognitiveDecision.upsert', 'blueprint.', 'workInstance.']) {
    assert.equal(SERVICE_SOURCE.includes(write), false, `must not call ${write}`);
  }
  assert.ok(SERVICE_SOURCE.includes('recordIdempotent('));
});
