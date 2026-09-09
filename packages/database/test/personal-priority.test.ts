// One person's queue — assembled from rows, ordered by a declared walk, and able
// to say why.
//
// WHAT THESE PROVE
//
// TWO PEOPLE LOOKING AT THE SAME ORGANIZATION SEE DIFFERENT ORDERS, and the
// difference traces entirely to participant rows. That is the whole product rule:
// business impact and user priority are different questions, and this is the
// suite that stops them collapsing into one.
//
// EVERY POSITION IS EXPLAINED. Each adjacent pair carries the sentence produced
// by the same walk that produced the order, so the explanation cannot be a
// rationalisation.
//
// NOTHING IS HIDDEN AND NOTHING IS WRITTEN. A case nobody connected to this
// person still appears, because the most important thing in the business must not
// be invisible to everybody not personally named on it. And reading a queue
// writes nothing at all.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  INVESTIGATION_PRODUCER,
  PRIORITY_NOT_CONSIDERED,
  investigationRecurrenceKey,
  type HeadlineView,
} from '@emgloop/shared';

import { makeCognitivePrisma } from './helpers/cognitive-prisma-fake';
import { DecisionEngine } from '../src/services/decision/decision-engine';
import { CaseParticipantRepository } from '../src/repositories/case-participant.repository';
import { PersonalPriorityService } from '../src/services/personal-priority.service';

const ORG = 'org-alpha';
const OTHER_ORG = 'org-beta';
const CHARLIE = 'usr_charlie';
const MATT = 'usr_matt';
const MIKE = 'usr_mike';
const NOW = new Date('2026-08-23T14:30:00.000Z');

const asHuman = (userId: string) => ({ type: 'HUMAN' as const, userId, source: 'operator' });

function headlineFor(id: string, objectiveId: string, againstObjective = true): HeadlineView {
  return {
    id,
    performanceObjectiveId: objectiveId,
    objectiveTitle: 'An objective',
    measureBindingId: 'bind_1',
    measureBindingVersion: 1,
    measurement: {
      metric: 'MONETIZED_RATE', metricLabel: 'Monetized rate', unit: 'RATIO',
      movement: 'DECREASE', againstObjective, currentValue: 0.412, priorValue: 0.597,
      absoluteChange: -0.185, percentageChange: -0.31, currentDenominator: 3184,
      priorDenominator: 2996, currentCoverage: 0.98, priorCoverage: 0.99,
      comparisonBasis: 'Trailing 7 complete Eastern business days.',
      currentWindowStart: '2026-08-15T04:00:00.000Z', currentWindowEnd: '2026-08-22T04:00:00.000Z',
      priorWindowStart: '2026-08-08T04:00:00.000Z', priorWindowEnd: '2026-08-15T04:00:00.000Z',
    },
    statement: 'Something moved.',
    limitations: [], unknowns: [],
    ruleId: 'ci.objective-measure-change', ruleVersion: 'v1', producerVersion: 'ci-headline.v1',
    ruleDescription: 'A rule.',
    firstDetectedAt: '2026-08-20T11:02:00.000Z', lastDetectedAt: '2026-08-22T06:15:00.000Z',
    detectionCount: 1, dismissedAt: null, dismissedByUserId: null, dismissedByName: null,
    dismissalBasis: null, createdAt: '2026-08-20T11:02:00.000Z',
  };
}

async function world(
  options: { objectiveOwners?: Record<string, string | null>; against?: Record<string, boolean> } = {},
) {
  const prisma = makeCognitivePrisma();
  const engine = new DecisionEngine(prisma as never);
  const participants = new CaseParticipantRepository(prisma as never);

  for (const [id, org] of [[CHARLIE, ORG], [MATT, ORG], [MIKE, ORG], ['usr_beta', OTHER_ORG]] as const) {
    await prisma.user.create({
      data: { id, organizationId: org, email: `${id}@test`, name: id, status: 'ACTIVE', metadata: {} },
    });
  }

  const reads: string[] = [];
  const priority = new PersonalPriorityService(prisma as never, {
    cases: engine,
    participants,
    headlines: {
      async get(org: string, id: string) {
        reads.push(`headline:${org}:${id}`);
        if (org !== ORG) return null;
        return headlineFor(id, `obj_${id}`, options.against?.[id] ?? true);
      },
    },
    objectives: {
      async get(org: string, id: string) {
        if (org !== ORG) return null;
        return { id, scopeUserId: options.objectiveOwners?.[id] ?? null } as never;
      },
    } as never,
  });

  async function openCase(headlineId: string, severity: string) {
    const { decision } = await engine.create(ORG, {
      producer: INVESTIGATION_PRODUCER,
      recurrenceKey: investigationRecurrenceKey(headlineId),
      detectionKey: `promotion:${headlineId}`,
      detectedAt: NOW,
      title: `Case for ${headlineId}`,
      severity,
      sourceReference: headlineId,
    });
    return decision.id;
  }

  return { prisma, engine, participants, priority, openCase, reads };
}

// --- The product rule ---------------------------------------------------------------

test('two people see the same organization in two different orders', async () => {
  const { priority, participants, openCase } = await world();
  const severe = await openCase('hl_severe', 'CRITICAL');
  const small = await openCase('hl_small', 'NOTABLE');

  // Only Matt was asked for something, and only on the smaller one.
  await participants.add(ORG, small, {
    userId: MATT,
    contribution: 'DECIDE',
    request: 'Whether the feed fix ships today.',
  });

  const mattQueue = await priority.queueFor(ORG, MATT);
  const mikeQueue = await priority.queueFor(ORG, MIKE);

  // BUSINESS IMPACT AND USER PRIORITY ARE DIFFERENT QUESTIONS, and this is the
  // whole reason the two are never one number.
  assert.deepEqual(mattQueue.items.map((i) => i.caseId), [small, severe]);
  assert.deepEqual(mikeQueue.items.map((i) => i.caseId), [severe, small]);

  assert.equal(mattQueue.items[0]?.tier, 'AWAITED_DECISION');
  assert.equal(mikeQueue.items[0]?.tier, 'ORGANIZATION_WIDE');
  // AND THE SEVERITY IS IDENTICAL IN BOTH. Relevance did not change what the
  // case is worth to the business.
  assert.equal(mattQueue.items[1]?.significance.severity, 'CRITICAL');
  assert.equal(mikeQueue.items[0]?.significance.severity, 'CRITICAL');
});

test('every position in the queue is explained', async () => {
  const { priority, participants, openCase } = await world();
  const a = await openCase('hl_a', 'CRITICAL');
  const b = await openCase('hl_b', 'NOTABLE');
  await participants.add(ORG, b, { userId: MATT, contribution: 'DECIDE', request: 'Decide this.' });

  const queue = await priority.queueFor(ORG, MATT);
  assert.equal(queue.orderings.length, 1);
  assert.equal(queue.orderings[0]?.aboveCaseId, b);
  assert.equal(queue.orderings[0]?.belowCaseId, a);
  assert.equal(queue.orderings[0]?.reason, 'TIER');
  assert.ok(queue.orderings[0]?.statement.length > 20);
});

test('a case nobody connected to this person still appears', async () => {
  const { priority, openCase } = await world();
  await openCase('hl_a', 'CRITICAL');
  const queue = await priority.queueFor(ORG, MIKE);
  assert.equal(queue.items.length, 1);
  assert.equal(queue.items[0]?.tier, 'ORGANIZATION_WIDE');
  assert.deepEqual(queue.items[0]?.reasons, []);
});

test('owning the objective a case was measured against makes it yours', async () => {
  const { priority, openCase } = await world({ objectiveOwners: { obj_hl_a: MIKE } });
  const a = await openCase('hl_a', 'NOTABLE');
  const queue = await priority.queueFor(ORG, MIKE);
  assert.equal(queue.items[0]?.tier, 'YOUR_OBJECTIVE');
  assert.equal(queue.items[0]?.reasons[0]?.source, 'PERFORMANCE_OBJECTIVE');
  assert.equal(queue.items[0]?.reasons[0]?.sourceId, 'obj_hl_a');
  assert.equal(queue.items[0]?.caseId, a);
});

test('owner and assignee are relationships too, and are reported as such', async () => {
  const { priority, engine, openCase } = await world();
  const a = await openCase('hl_a', 'NOTABLE');
  await engine.setOwner(ORG, a, { ownerUserId: CHARLIE, actor: asHuman(CHARLIE) });
  await engine.assign(ORG, a, { assigneeUserId: MATT, actor: asHuman(CHARLIE) });

  assert.equal((await priority.queueFor(ORG, CHARLIE)).items[0]?.tier, 'ACCOUNTABLE');
  assert.equal((await priority.queueFor(ORG, MATT)).items[0]?.tier, 'WORKING_IT');
  assert.equal((await priority.queueFor(ORG, MIKE)).items[0]?.tier, 'ORGANIZATION_WIDE');
});

test('a released participant drops out of that person’s relevance', async () => {
  const { priority, participants, openCase } = await world();
  const a = await openCase('hl_a', 'NOTABLE');
  await participants.add(ORG, a, { userId: MATT, contribution: 'DECIDE', request: 'Decide.' });
  assert.equal((await priority.queueFor(ORG, MATT)).items[0]?.tier, 'AWAITED_DECISION');

  await participants.release(ORG, a, MATT, 'DECIDE', CHARLIE);
  assert.equal((await priority.queueFor(ORG, MATT)).items[0]?.tier, 'ORGANIZATION_WIDE');
});

// --- Significance comes from rows -------------------------------------------------------

test('significance is read from the case and its headline, never invented', async () => {
  const { priority, openCase } = await world({ against: { hl_a: false } });
  await openCase('hl_a', 'HIGH');
  const item = (await priority.queueFor(ORG, MIKE)).items[0];
  assert.equal(item?.significance.severity, 'HIGH');
  assert.equal(item?.significance.againstObjective, false);
  assert.equal(item?.significance.percentageChange, -0.31);
  // NOBODY MEASURED AN IMPACT ON THIS CASE, and null says exactly that rather
  // than a zero that would read as "measured, and it was nothing".
  assert.equal(item?.significance.measuredImpactCents, null);
});

test('a case from another producer reports no objective facts rather than false ones', async () => {
  const { prisma, priority } = await world();
  const engine = new DecisionEngine(prisma as never);
  await engine.create(ORG, {
    producer: 'ACCOUNTING',
    recurrenceKey: 'invoice-aging::acme',
    detectionKey: 'month:2026-08',
    detectedAt: NOW,
    title: 'Acme invoices ageing',
    severity: 'HIGH',
    sourceReference: 'customer:acme',
  });
  const item = (await priority.queueFor(ORG, MIKE)).items[0];
  assert.equal(item?.significance.severity, 'HIGH');
  // NOT `false`. The producer never measured against an objective, which is a
  // different fact from measuring and finding the move went the right way.
  assert.equal(item?.significance.againstObjective, null);
  assert.equal(item?.significance.percentageChange, null);
});

test('a severity this build cannot read is treated as the least alarming', async () => {
  const { prisma, priority } = await world();
  const engine = new DecisionEngine(prisma as never);
  const { decision } = await engine.create(ORG, {
    producer: 'ACCOUNTING',
    recurrenceKey: 'r', detectionKey: 'd', detectedAt: NOW, title: 'x', severity: 'HIGH',
  });
  // A vocabulary widened in a later build must not make an older one shout.
  await prisma.operationalPriority.update({ where: { id: decision.id }, data: { severity: 'APOCALYPTIC' } });
  const item = (await priority.queueFor(ORG, MIKE)).items[0];
  assert.equal(item?.significance.severity, 'INFORMATIONAL');
});

// --- Tenancy -----------------------------------------------------------------------------

test('another organization’s queue is empty, not somebody else’s', async () => {
  const { priority, openCase, participants } = await world();
  const a = await openCase('hl_a', 'CRITICAL');
  await participants.add(ORG, a, { userId: MATT, contribution: 'DECIDE', request: 'Decide.' });

  const queue = await priority.queueFor(OTHER_ORG, MATT);
  assert.deepEqual(queue.items, []);
  assert.deepEqual(queue.orderings, []);
  // AND THE GAPS ARE STILL REPORTED, so an empty queue does not read as a
  // confident "nothing matters to you".
  assert.deepEqual(queue.notConsidered, PRIORITY_NOT_CONSIDERED);
});

test('a participant row from another organization cannot reach this queue', async () => {
  const { prisma, priority, openCase } = await world();
  const a = await openCase('hl_a', 'NOTABLE');
  // Written directly, bypassing the repository's tenant guard, to prove the READ
  // is scoped too rather than relying on the write path having been careful.
  await prisma.caseParticipant.create({
    data: {
      id: 'cp_foreign', organizationId: OTHER_ORG, priorityId: a, userId: MATT,
      contribution: 'DECIDE', request: 'Should not count.', addedByUserId: null, addedAt: NOW,
    },
  });
  assert.equal((await priority.queueFor(ORG, MATT)).items[0]?.tier, 'ORGANIZATION_WIDE');
});

// --- It is a read --------------------------------------------------------------------------

test('reading a queue writes nothing', async () => {
  const { priority, prisma, openCase, participants } = await world();
  const a = await openCase('hl_a', 'CRITICAL');
  await participants.add(ORG, a, { userId: MATT, contribution: 'DECIDE', request: 'Decide.' });

  const before = {
    observations: (await prisma.operationalObservation.findMany({})).length,
    participants: (await prisma.caseParticipant.findMany({})).length,
    decisions: (await prisma.cognitiveDecision.findMany({})).length,
  };
  await priority.queueFor(ORG, MATT);
  await priority.queueFor(ORG, MIKE);
  assert.deepEqual(
    {
      observations: (await prisma.operationalObservation.findMany({})).length,
      participants: (await prisma.caseParticipant.findMany({})).length,
      decisions: (await prisma.cognitiveDecision.findMany({})).length,
    },
    before,
  );
});

test('a resolved investigation leaves everybody’s queue', async () => {
  const { priority, engine, openCase, participants } = await world();
  const a = await openCase('hl_a', 'CRITICAL');
  await participants.add(ORG, a, { userId: MATT, contribution: 'DECIDE', request: 'Decide.' });
  assert.equal((await priority.queueFor(ORG, MATT)).items.length, 1);

  await engine.resolve(ORG, a, { actor: asHuman(MATT), outcome: 'RECOVERED' });
  assert.equal((await priority.queueFor(ORG, MATT)).items.length, 0);
});

const SERVICE_SOURCE = readFileSync(
  new URL('../src/services/personal-priority.service.ts', import.meta.url),
  'utf8',
);

test('the service holds only reads, and computes no score', () => {
  for (const write of ['.create(', '.update(', '.upsert(', '.delete(', '$transaction', 'addObservation']) {
    assert.equal(SERVICE_SOURCE.includes(write), false, `a queue read must not call ${write}`);
  }
  for (const scored of ['score', 'weight', 'coefficient']) {
    assert.equal(
      new RegExp(`\\b${scored}\\s*[?]?\\s*[:(]`).test(SERVICE_SOURCE),
      false,
      `must not declare ${scored}`,
    );
  }
});
