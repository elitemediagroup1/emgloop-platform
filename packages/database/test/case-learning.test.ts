// Learning assembled from what was already recorded — and writing nothing.
//
// WHAT THESE PROVE
//
// EVERY FACT WAS ALREADY THERE. Machine options, the human selection, the human
// revision, the monitoring verdict and the outcome are all read back from rows
// some earlier act wrote. This service adds assembly and nothing else.
//
// IT CANNOT WRITE. No create, no update, no append, no transaction — asserted
// against the source and against the database. In particular `nominate` writes
// no KnowledgeAssertion: promotion is a decision a person takes.
//
// WHAT IT REFUSES TO KNOW. Whether the selected sequence is the executed one.
// `executed` is null, and that is the honest answer rather than the
// useful-looking one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  EVIDENCE_AT_DECISION_UNRECORDED,
  FINDING_ESTABLISHMENT_RULE_VERSION,
  INVESTIGATION_PRODUCER,
  LEARNING_REFUSALS,
  investigationRecurrenceKey,
  type CaseFindingView,
} from '@emgloop/shared';

import { makeCognitivePrisma } from './helpers/cognitive-prisma-fake';
import { DecisionEngine } from '../src/services/decision/decision-engine';
import { CaseRecommendationService } from '../src/services/case-recommendation.service';
import { CaseLearningService } from '../src/services/case-learning.service';

const ORG = 'org_alpha';
const OTHER = 'org_beta';
const CHARLIE = 'usr_charlie';
const NOW = new Date('2026-09-08T12:00:00.000Z');
const human = { type: 'HUMAN' as const, userId: CHARLIE, source: 'operator' };

/**
 * The statement CARRIES ITS VERB, exactly as the recommendation contract
 * requires. `isSafeRecommendation` reads the statement, not the field beside it,
 * so a fixture that set them independently would be describing an action the
 * verb guard would refuse in production.
 */
const step = (position: number, verb: string, rest: string) => ({
  position, verb: verb as never, statement: `${verb} ${rest}`, intent: null,
});

const revenueFirst = () => ({
  key: 'protect-revenue',
  label: 'Protect Revenue First',
  summary: 'Move volume away while the cause is established.',
  posture: 'REVERSIBLE_MITIGATION' as const,
  factors: [
    { factor: 'EXPECTED_BENEFIT' as const, level: 'HIGH' as const, basis: 'The exposed spend is the largest line.' },
    { factor: 'RELATIONSHIP_RISK' as const, level: 'HIGH' as const, basis: 'The buyer notices within a day.' },
    { factor: 'REVERSIBILITY' as const, level: 'HIGH' as const, basis: 'Routing can be restored the same day.' },
  ],
  actions: [step(1, 'Evaluate', 'shifting volume to the backup buyer.'), step(2, 'Monitor', 'recovery.')],
  rank: 1,
});

const learnFirst = (rank = 2) => ({
  key: 'learn-first',
  label: 'Learn Before Acting',
  summary: 'Establish the cause before changing anything.',
  posture: 'LEARN_BEFORE_ACTING' as const,
  factors: [
    { factor: 'EXPECTED_BENEFIT' as const, level: 'LOW' as const, basis: 'Nothing changes this week.' },
    { factor: 'RELATIONSHIP_RISK' as const, level: 'LOW' as const, basis: 'The buyer sees nothing.' },
    { factor: 'REVERSIBILITY' as const, level: 'HIGH' as const, basis: 'Nothing to reverse.' },
  ],
  actions: [step(1, 'Review', 'the settlement feed.')],
  rank,
});

/**
 * A Finding strong enough to carry a recommendation set.
 *
 * SUPPLIED DIRECTLY, DELIBERATELY. What is under test here is the ASSEMBLY of a
 * learning record, and driving the whole readiness gate through every case would
 * be testing the Finding service instead -- which has its own suite doing
 * exactly that.
 *
 * TYPED AS THE PRODUCTION CONTRACT, with no cast. A stub that bypassed the
 * contract would keep compiling after the contract changed under it, which is
 * exactly what happened to the old `as never` version of this: it went on
 * claiming ESTABLISHED through a field the service had stopped reading.
 */
const establishedFinding = (): CaseFindingView => ({
  findingId: 'fnd_1',
  caseId: 'case_1',
  claim: 'A claim strong enough to carry options.',
  conclusion: null,
  claimKind: 'MEASUREMENT_BACKED',
  generatedBy: 'DETERMINISTIC_RULE',
  evidenceState: 'ESTABLISHED',
  judgment: null,
  lifecycle: 'CURRENT',
  establishment: {
    ruleVersion: FINDING_ESTABLISHMENT_RULE_VERSION,
    eligible: true,
    basis: 'DETERMINISTIC_POLICY',
    reasons: [],
    readinessWithholdings: [],
  },
  reasoning: { known: [], inferred: [], missing: [], contradictory: [], unavailable: {} },
  supporting: ['ev_1', 'ev_2', 'ev_3'].map((id) => ({
    id,
    source: 'commercial-intelligence',
    metricKey: 'MONETIZED_RATE',
    window: 'Trailing 7 business days',
    value: 0.412,
    completeness: 1,
  })),
  createdAt: NOW.toISOString(),
  supportingWindowStart: null,
  supportingWindowEnd: null,
  ruleVersion: null,
  lineage: [],
});

async function world() {
  const prisma = makeCognitivePrisma();
  const engine = new DecisionEngine(prisma as never);
  const findings = { async get() { return establishedFinding(); } };
  const recommendations = new CaseRecommendationService(prisma as never, { cases: engine, findings });
  // NO FINDING SEAM HERE ANY MORE. Learning no longer reads the Finding: what
  // the evidence looked like when a decision was taken is not recorded, and a
  // reading taken now is not that.
  const learning = new CaseLearningService(prisma as never, {
    cases: engine,
    monitoring: { async get() { return null; } } as never,
  });

  const open = async (headlineId: string) => {
    const { decision } = await engine.create(ORG, {
      producer: INVESTIGATION_PRODUCER,
      recurrenceKey: investigationRecurrenceKey(headlineId),
      detectionKey: `promotion:${headlineId}`,
      detectedAt: NOW,
      title: `Something happened on ${headlineId}`,
      severity: 'NOTABLE',
      sourceReference: headlineId,
    });
    return decision.id;
  };
  return { prisma, engine, recommendations, learning, open };
}

const SET = { author: 'MACHINE' as const, actor: human, issuedAt: NOW };

// --- 1. Assembly from what already exists ---------------------------------------------

test('1. the machine options, the human selection and the human revision all read back', async () => {
  const { recommendations, learning, open } = await world();
  const caseId = await open('hl_cem');
  await recommendations.record(ORG, caseId, { ...SET, options: [revenueFirst(), learnFirst()] });
  await recommendations.select(ORG, caseId, 'protect-revenue', human);

  const o = await learning.observationFor(ORG, caseId, NOW);
  assert.equal(o?.machineOptions.length, 2);
  assert.deepEqual(o?.machineOptions.map((m) => m.key), ['protect-revenue', 'learn-first']);
  assert.deepEqual(o?.machineOptions[0]?.actions, ['Evaluate', 'Monitor']);
  assert.equal(o?.selected?.key, 'protect-revenue');
  assert.equal(o?.revised, null, 'nobody revised, and that is null rather than a guess');
});

test('1b. a revision is recorded without erasing what Loop proposed', async () => {
  const { recommendations, learning, open } = await world();
  const caseId = await open('hl_cem');
  await recommendations.record(ORG, caseId, { ...SET, options: [revenueFirst(), learnFirst()] });
  await recommendations.revise(ORG, caseId, 'protect-revenue', [step(1, 'Review', 'the feed first.')], human);

  const o = await learning.observationFor(ORG, caseId, NOW);
  assert.ok(o?.revised, 'the revision is there');
  // AND THE MACHINE'S VERSION IS UNTOUCHED. Two actions, as Loop wrote them.
  const machine = o!.machineOptions.find((m) => m.key === 'protect-revenue');
  assert.deepEqual(machine?.actions, ['Evaluate', 'Monitor']);
});

test('1c. the LAST selection wins, and the earlier one stays on the log', async () => {
  const { prisma, recommendations, learning, open } = await world();
  const caseId = await open('hl_cem');
  await recommendations.record(ORG, caseId, { ...SET, options: [revenueFirst(), learnFirst()] });
  await recommendations.select(ORG, caseId, 'learn-first', human);
  await recommendations.select(ORG, caseId, 'protect-revenue', human);

  const o = await learning.observationFor(ORG, caseId, NOW);
  assert.equal(o?.selected?.key, 'protect-revenue', 'what they settled on');
  // A person who changed their mind selected twice, and both acts are history.
  const selections = (await prisma.operationalObservation.findMany({ where: { priorityId: caseId } }))
    .filter((r) => r.observationType === 'RECOMMENDATION_SELECTED');
  assert.equal(selections.length, 2);
});

test('1c2. the evidence at decision time is UNRECORDED, and says so', async () => {
  // IT MUST NOT MASQUERADE AS A SNAPSHOT. Nothing records what the evidence
  // looked like when the decision was taken, and a reading taken now would be
  // today's evidence wearing yesterday's label. The learning record therefore
  // reports it as unknown, with the reason -- until Loop records evaluations as
  // they happen.
  const { recommendations, learning, open } = await world();
  const caseId = await open('hl_cem');
  await recommendations.record(ORG, caseId, { ...SET, options: [revenueFirst(), learnFirst()] });
  await recommendations.select(ORG, caseId, 'protect-revenue', human);

  const o = await learning.observationFor(ORG, caseId, NOW);
  assert.equal(o?.evidenceAtDecision.recorded, false);
  assert.equal(o?.evidenceAtDecision.reason, EVIDENCE_AT_DECISION_UNRECORDED);
  // And there is no way to read a value out of it: the only shape it has is the
  // unrecorded one.
  assert.deepEqual(Object.keys(o?.evidenceAtDecision ?? {}).sort(), ['reason', 'recorded']);
});

test('1c3. the learning service does not read the Finding at all', () => {
  // The seam is gone rather than unused: a service that still held a Finding
  // reader would be one edit away from filling a historical field from a
  // present-tense read, which is the defect this replaced.
  const source = readFileSync(
    new URL('../src/services/case-learning.service.ts', import.meta.url),
    'utf8',
  )
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ');
  assert.equal(/CaseFindingService|findings\./.test(source), false);
});

test('1d. `executed` is null, because Loop does not know what anybody did', async () => {
  // THE REFUSAL THAT MATTERS MOST IN THIS FILE. Assuming the selected sequence
  // was the executed one would invent the single fact every comparison turns on.
  const { recommendations, learning, open } = await world();
  const caseId = await open('hl_cem');
  await recommendations.record(ORG, caseId, { ...SET, options: [revenueFirst()] });
  await recommendations.select(ORG, caseId, 'protect-revenue', human);
  const o = await learning.observationFor(ORG, caseId, NOW);
  assert.equal(o?.executed, null);
});

test('1e. the comparability key is the producer\'s own recurrence key', async () => {
  const { learning, open } = await world();
  const caseId = await open('hl_cem');
  const o = await learning.observationFor(ORG, caseId, NOW);
  assert.equal(o?.subject, investigationRecurrenceKey('hl_cem'));
});

// --- 2. Patterns over closed Cases ------------------------------------------------------

test('2. only closed Cases count toward a pattern', async () => {
  // An investigation still running has not finished saying what happened, and
  // counting it would let a pattern move on work in progress.
  const { engine, recommendations, learning, open } = await world();
  const openCase = await open('hl_open');
  await recommendations.record(ORG, openCase, { ...SET, options: [revenueFirst()] });

  const closedCase = await open('hl_closed');
  await recommendations.record(ORG, closedCase, { ...SET, options: [revenueFirst()] });
  await engine.resolve(ORG, closedCase, { actor: human, outcome: 'RECOVERED' });

  const patterns = await learning.patterns(ORG, { now: NOW });
  const subjects = patterns.map((p) => p.subject);
  assert.ok(subjects.includes(investigationRecurrenceKey('hl_closed').toLowerCase()));
  assert.equal(subjects.includes(investigationRecurrenceKey('hl_open').toLowerCase()), false);
});

test('2b. one closed Case is an OBSERVATION carrying every refusal', async () => {
  const { engine, recommendations, learning, open } = await world();
  const caseId = await open('hl_cem');
  await recommendations.record(ORG, caseId, { ...SET, options: [revenueFirst()] });
  await recommendations.select(ORG, caseId, 'protect-revenue', human);
  await engine.resolve(ORG, caseId, { actor: human, outcome: 'RECOVERED' });

  const [pattern] = await learning.patterns(ORG, { now: NOW });
  assert.equal(pattern?.maturity, 'OBSERVATION');
  assert.ok(pattern?.cannotConclude.includes(LEARNING_REFUSALS.CAUSE));
  assert.ok(pattern?.cannotConclude.includes(LEARNING_REFUSALS.PROMOTION));
  assert.deepEqual(pattern?.caseIds, [caseId]);
});

// --- 3. Nothing is written ----------------------------------------------------------------

test('3. reading a pattern and nominating it write nothing at all', async () => {
  const { prisma, engine, recommendations, learning, open } = await world();
  const caseId = await open('hl_cem');
  await recommendations.record(ORG, caseId, { ...SET, options: [revenueFirst()] });
  await recommendations.select(ORG, caseId, 'protect-revenue', human);
  await engine.resolve(ORG, caseId, { actor: human, outcome: 'RECOVERED' });

  const before = {
    observations: (await prisma.operationalObservation.findMany({ where: {} })).length,
    decisions: (await prisma.cognitiveDecision.findMany({ where: {} })).length,
    assertions: (await prisma.knowledgeAssertion.findMany({ where: {} })).length,
    hypotheses: (await prisma.intelligenceHypothesis.findMany({ where: {} })).length,
  };

  const [pattern] = await learning.patterns(ORG, { now: NOW });
  const nomination = learning.nominate(pattern!, 'Reaching the buyer first tends to precede recovery.');
  assert.equal(nomination.destination, 'KnowledgeAssertion');
  assert.ok(nomination.blockers.includes('HUMAN_APPROVAL_REQUIRED'));

  const after = {
    observations: (await prisma.operationalObservation.findMany({ where: {} })).length,
    decisions: (await prisma.cognitiveDecision.findMany({ where: {} })).length,
    assertions: (await prisma.knowledgeAssertion.findMany({ where: {} })).length,
    hypotheses: (await prisma.intelligenceHypothesis.findMany({ where: {} })).length,
  };
  assert.deepEqual(after, before, 'not one row was written');
  // NO SECOND BRAIN. Nothing became durable knowledge because nothing can here.
  assert.equal(after.assertions, 0);
});

test('3b. the learning service has no write path in it', () => {
  const src = readFileSync(new URL('../src/services/case-learning.service.ts', import.meta.url), 'utf8');
  for (const forbidden of ['.create(', '.update(', '.upsert(', '.delete(', '$transaction', 'addObservation']) {
    assert.equal(src.includes(forbidden), false, `must not contain ${forbidden}`);
  }
  // And it reaches no knowledge repository, so it could not promote if it tried.
  assert.equal(/KnowledgeAssertionRepository/.test(src), false);
});

// --- 4. Tenancy --------------------------------------------------------------------------------

test('4. another organization sees nothing', async () => {
  const { engine, recommendations, learning, open } = await world();
  const caseId = await open('hl_cem');
  await recommendations.record(ORG, caseId, { ...SET, options: [revenueFirst()] });
  await engine.resolve(ORG, caseId, { actor: human, outcome: 'RECOVERED' });

  assert.equal(await learning.observationFor(OTHER, caseId, NOW), null);
  assert.deepEqual(await learning.patterns(OTHER, { now: NOW }), []);
});
