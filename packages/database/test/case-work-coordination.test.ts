// The Case reads Work state, and owns none of it.
//
// WHAT THESE PROVE
//
// CI CANNOT WRITE EXECUTION TRUTH. The coordination service has no create, no
// update, no append and no transaction, and reading a Case changes nothing in
// Work OS. That is asserted against the source and against the database, because
// a comment saying "read-only" is not a boundary.
//
// EVERY EXECUTION ANSWER IS DERIVED AT READ TIME. The same Case read at two
// moments gives two different SLA verdicts with nothing written in between,
// which is only possible because nothing was copied.
//
// UNKNOWN SURVIVES. An unreadable system, a missing work item and unmeasured
// work are three distinct answers, each reaching the caller by name, and none of
// them reads as "fine".
//
// THE REFERENCE IS DATA, NOT A CAPABILITY. A reference naming another tenant's
// work resolves to not-found.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  INVESTIGATION_PRODUCER,
  WORK_OS_SYSTEM,
  caseBlockers,
  caseHasEscalationEligibleWork,
  caseWorkAllComplete,
  coordinationIsComplete,
  investigationRecurrenceKey,
} from '@emgloop/shared';

import { makeCognitivePrisma } from './helpers/cognitive-prisma-fake';
import { DecisionEngine } from '../src/services/decision/decision-engine';
import { CaseParticipantRepository } from '../src/repositories/case-participant.repository';
import { CaseParticipationService } from '../src/services/case-participation.service';
import { WorkExecutionRepository } from '../src/repositories/work-execution.repository';
import { WorkExecutionService } from '../src/services/work-execution.service';
import { CaseWorkCoordinationService } from '../src/services/case-work-coordination.service';

const ORG = 'org_alpha';
const OTHER = 'org_beta';
const CHARLIE = 'usr_charlie';
const MATT = 'usr_matt';
const HEADLINE_ID = 'hl_cem';
const HOUR = 3_600_000;
const T0 = new Date('2026-09-01T09:00:00.000Z');
const at = (h: number) => new Date(T0.getTime() + h * HOUR);
const asHuman = (userId: string) => ({ type: 'HUMAN' as const, userId, source: 'operator' });

async function world() {
  const prisma = makeCognitivePrisma();
  const engine = new DecisionEngine(prisma as never);
  const execution = new WorkExecutionRepository(prisma as never);
  const workService = new WorkExecutionService(prisma as never, { execution });

  for (const [id, org] of [[CHARLIE, ORG], [MATT, ORG], ['usr_beta', OTHER]] as const) {
    await prisma.user.create({
      data: { id, organizationId: org, email: `${id}@test`, name: id, status: 'ACTIVE', metadata: {} },
    });
  }

  const participation = new CaseParticipationService(prisma as never, {
    cases: engine,
    participants: new CaseParticipantRepository(prisma as never),
    headlines: { async get() { return null; } },
    objectives: { async get() { return null; } } as never,
  });
  const coordination = new CaseWorkCoordinationService(prisma as never, {
    participation,
    work: workService,
  });

  const { decision } = await engine.create(ORG, {
    producer: INVESTIGATION_PRODUCER,
    recurrenceKey: investigationRecurrenceKey(HEADLINE_ID),
    detectionKey: `promotion:${HEADLINE_ID}`,
    detectedAt: T0,
    title: "Buyer CEM's monetized rate fell.",
    severity: 'NOTABLE',
    sourceReference: HEADLINE_ID,
  });

  /** Record that this Case produced work somewhere, exactly as the engine does. */
  const pointAt = async (system: string, id: string | null) =>
    engine.addObservation(ORG, decision.id, {
      observationType: 'OUTCOME_RECORDED',
      actor: asHuman(CHARLIE),
      outcome: 'CONVERTED_TO_WORK',
      destination: { system, type: 'work_instance', id },
    });

  const makeWork = async (title: string, organizationId = ORG) => {
    const wi = await prisma.workInstance.create({
      data: { organizationId, title, createdByUserId: MATT },
    });
    const st = await prisma.workStage.create({
      data: { workInstanceId: wi.id, name: 'Call the buyer', position: 1, status: 'ready', ownerUserId: MATT },
    });
    await prisma.workInstance.update({ where: { id: wi.id }, data: { currentStageId: st.id } });
    return { wi, st };
  };

  return { prisma, engine, execution, workService, participation, coordination, caseId: decision.id, pointAt, makeWork };
}

// --- 1. The questions a Case surface has to answer -------------------------------------

test('1. the read answers what was asked, of whom, and where the work stands', async () => {
  const { execution, coordination, caseId, participation, pointAt, makeWork } = await world();
  await participation.add(ORG, caseId, {
    userId: MATT, contribution: 'INVESTIGATE', request: 'Find out why settlement fell.', actor: asHuman(CHARLIE),
  });
  const work = await makeWork('Contact CEM');
  await pointAt(WORK_OS_SYSTEM, work.wi.id);
  await execution.transition(ORG, work.st.id, { to: 'in_progress', actorUserId: MATT, occurredAt: at(0) });

  const view = await coordination.get(ORG, caseId, at(2));
  assert.equal(view?.asks.length, 1);
  assert.equal(view?.asks[0]?.contribution, 'INVESTIGATE');
  assert.equal(view?.work.length, 1);
  assert.equal(view?.work[0]?.workStatus, 'active');
  assert.equal(view?.work[0]?.execution?.state, 'in_progress');
  assert.equal(view?.work[0]?.execution?.sla, 'WITHIN_POLICY');
  assert.equal(view?.work[0]?.execution?.actionable, true);
  assert.equal(view?.work[0]?.unknown, null);
  assert.equal(coordinationIsComplete(view!), true);
});

test('1b. a blocked work item reports what is blocking it and when that is expected', async () => {
  const { execution, coordination, caseId, pointAt, makeWork } = await world();
  const work = await makeWork('Reconcile August');
  await pointAt(WORK_OS_SYSTEM, work.wi.id);
  await execution.addDependency(ORG, work.st.id, {
    kind: 'EXTERNAL_CONDITION',
    conditionSubject: 'CEM settlement sheet',
    description: 'Waiting for the next-day buyer sheet.',
    expectedResolutionAt: at(24),
    createdByUserId: CHARLIE,
  });
  await execution.transition(ORG, work.st.id, {
    to: 'blocked', actorUserId: MATT, occurredAt: at(1),
    wait: { reason: 'AWAITING_DEPENDENCY', subject: 'CEM settlement sheet', expectedResolutionAt: at(24) },
  });

  const view = await coordination.get(ORG, caseId, at(5));
  const blockers = caseBlockers(view!);
  assert.equal(blockers.length, 1);
  assert.equal(blockers[0]?.description, 'Waiting for the next-day buyer sheet.');
  assert.equal(blockers[0]?.expectedResolutionAt, at(24).toISOString());
  assert.equal(view?.work[0]?.execution?.state, 'blocked');
  assert.equal(view?.work[0]?.execution?.actionable, false);
  assert.equal(view?.work[0]?.execution?.sla, 'PAUSED_WAITING');
});

test('1c. eligibility is read from Work OS, never re-decided here', async () => {
  const { execution, coordination, caseId, pointAt, makeWork } = await world();
  const work = await makeWork('Contact CEM');
  await pointAt(WORK_OS_SYSTEM, work.wi.id);
  await execution.transition(ORG, work.st.id, { to: 'in_progress', actorUserId: MATT, occurredAt: at(0) });

  const early = await coordination.get(ORG, caseId, at(5));
  const late = await coordination.get(ORG, caseId, at(30));
  assert.equal(caseHasEscalationEligibleWork(early!), false);
  assert.equal(caseHasEscalationEligibleWork(late!), true);
  // AND STILL NO DESTINATION. The Case does not get to invent one either.
  assert.equal(late?.work[0]?.execution?.escalationDestinationUserId, null);
});

// --- 2. Nothing is copied --------------------------------------------------------------

test('2. two reads at two moments disagree, with nothing written in between', async () => {
  // THE PROOF THAT NOTHING IS STORED. A copied status could not do this.
  const { prisma, execution, coordination, caseId, pointAt, makeWork } = await world();
  const work = await makeWork('Contact CEM');
  await pointAt(WORK_OS_SYSTEM, work.wi.id);
  await execution.transition(ORG, work.st.id, { to: 'in_progress', actorUserId: MATT, occurredAt: at(0) });

  const stageBefore = await prisma.workStage.findFirst({ where: { id: work.st.id } });
  const eventsBefore = (await execution.listEvents(ORG, work.st.id)).length;
  const obsBefore = (await prisma.operationalObservation.findMany({ where: { priorityId: caseId } })).length;

  const a = await coordination.get(ORG, caseId, at(5));
  const b = await coordination.get(ORG, caseId, at(30));
  assert.notEqual(a?.work[0]?.execution?.sla, b?.work[0]?.execution?.sla);

  const stageAfter = await prisma.workStage.findFirst({ where: { id: work.st.id } });
  assert.deepEqual(stageAfter, stageBefore, 'the Case read changed nothing in Work OS');
  assert.equal((await execution.listEvents(ORG, work.st.id)).length, eventsBefore);
  assert.equal((await prisma.operationalObservation.findMany({ where: { priorityId: caseId } })).length, obsBefore);
});

test('2b. no Commercial Intelligence table carries an execution field', async () => {
  const { prisma, execution, coordination, caseId, participation, pointAt, makeWork } = await world();
  await participation.add(ORG, caseId, { userId: MATT, contribution: 'INVESTIGATE', request: 'x', actor: asHuman(CHARLIE) });
  const work = await makeWork('Contact CEM');
  await pointAt(WORK_OS_SYSTEM, work.wi.id);
  await execution.setDue(ORG, work.st.id, at(8), { userId: CHARLIE });
  await coordination.get(ORG, caseId, at(30));

  const serialized = JSON.stringify([
    await prisma.caseParticipant.findMany({ where: { priorityId: caseId } }),
    await prisma.operationalPriority.findMany({ where: { id: caseId } }),
    await prisma.operationalObservation.findMany({ where: { priorityId: caseId } }),
  ]);
  for (const owned of ['dueAt', 'actionableAt', 'slaState', 'escalationEligible', 'waitReason', 'in_progress']) {
    assert.equal(serialized.includes(owned), false, `no CI row may carry ${owned}`);
  }
});

test('2c. the coordination service has no write anywhere in it', () => {
  const src = readFileSync(new URL('../src/services/case-work-coordination.service.ts', import.meta.url), 'utf8');
  // The enforced form of "CI reads Work state". A comment saying read-only is
  // not a boundary; the absence of a write path is.
  for (const forbidden of ['.create(', '.update(', '.upsert(', '.delete(', '$transaction', 'addObservation', 'transition(', 'setDue(', 'resolveDependency(']) {
    assert.equal(src.includes(forbidden), false, `must not contain ${forbidden}`);
  }
});

// --- 3. Unknown survives ------------------------------------------------------------------

test('3. an unreadable system, a missing work item and unmeasured work are three answers', async () => {
  const { coordination, caseId, pointAt, makeWork } = await world();
  await pointAt('some-other-product', 'ext_1');
  await pointAt(WORK_OS_SYSTEM, 'wi_deleted');
  const unmeasured = await makeWork('Never measured');
  await pointAt(WORK_OS_SYSTEM, unmeasured.wi.id);

  const view = await coordination.get(ORG, caseId, at(500));
  const byUnknown = view!.work.map((w) => w.unknown);
  assert.deepEqual(byUnknown, ['SYSTEM_NOT_READABLE', 'WORK_NOT_FOUND', 'NOT_MEASURED']);

  // NONE OF THEM READS AS FINE. Every one lands in notKnown, and the view is not
  // complete enough for anything downstream to reason from.
  assert.equal(view?.notKnown.length, 3);
  assert.equal(coordinationIsComplete(view!), false);
});

test('3b. work with no history is UNKNOWN, and the Case says so rather than nothing', async () => {
  const { coordination, caseId, pointAt, makeWork } = await world();
  const work = await makeWork('Created before any of this existed');
  await pointAt(WORK_OS_SYSTEM, work.wi.id);

  const view = await coordination.get(ORG, caseId, at(1000));
  assert.equal(view?.work[0]?.unknown, 'NOT_MEASURED');
  assert.equal(view?.work[0]?.execution?.sla, 'UNKNOWN');
  assert.equal(view?.work[0]?.execution?.escalationEligible, false, 'unmeasured is not late');
  assert.ok(view?.notKnown[0]?.includes('cannot say'));
});

test('3c. "all complete" is false while anything is unknown', async () => {
  // A Case with one completed work item and one that cannot be read is not a
  // Case whose work is done, and answering true would let a later
  // auto-resolution close it on a reference nobody could follow.
  const { execution, coordination, caseId, pointAt, makeWork } = await world();
  const done = await makeWork('Finished');
  await pointAt(WORK_OS_SYSTEM, done.wi.id);
  await execution.transition(ORG, done.st.id, { to: 'completed', actorUserId: MATT, occurredAt: at(1) });
  await pointAt(WORK_OS_SYSTEM, 'wi_gone');

  const view = await coordination.get(ORG, caseId, at(5));
  assert.equal(caseWorkAllComplete(view!), false);
});

test('3d. a Case that produced no work is not a Case whose work is complete', async () => {
  const { coordination, caseId } = await world();
  const view = await coordination.get(ORG, caseId, at(5));
  assert.equal(view?.work.length, 0);
  assert.equal(caseWorkAllComplete(view!), false, 'nothing to complete is not completion');
  assert.equal(coordinationIsComplete(view!), true, 'but there is no gap in what was read');
});

// --- 4. The reference is data, not a capability -------------------------------------------

test('4. a reference naming another tenant\'s work resolves to not-found', async () => {
  const { coordination, caseId, pointAt, makeWork } = await world();
  const theirs = await makeWork("Another tenant's work", OTHER);
  await pointAt(WORK_OS_SYSTEM, theirs.wi.id);

  const view = await coordination.get(ORG, caseId, at(5));
  assert.equal(view?.work[0]?.unknown, 'WORK_NOT_FOUND');
  assert.equal(view?.work[0]?.execution, null, 'no execution state crossed the boundary');
  // Indistinguishable from a deleted id: nothing here confirms another tenant's
  // row exists.
  assert.equal(view?.work[0]?.workStatus, null);
});

test('4b. a Case in another organization is not readable at all', async () => {
  const { coordination, caseId } = await world();
  assert.equal(await coordination.get(OTHER, caseId, at(5)), null);
});

// --- 5. The representative stage ------------------------------------------------------------

test('5. one work item resolves to one stage, chosen the same way every time', async () => {
  const { prisma, workService } = await world();
  const wi = await prisma.workInstance.create({ data: { organizationId: ORG, title: 'Three steps', createdByUserId: MATT } });
  const one = await prisma.workStage.create({ data: { workInstanceId: wi.id, name: 'One', position: 1, status: 'completed' } });
  const two = await prisma.workStage.create({ data: { workInstanceId: wi.id, name: 'Two', position: 2, status: 'ready' } });
  await prisma.workStage.create({ data: { workInstanceId: wi.id, name: 'Three', position: 3, status: 'pending' } });

  // No currentStageId: the first unfinished stage answers.
  let found = await workService.getForWorkInstance(ORG, wi.id, at(1));
  assert.equal(found?.view?.workStageId, two.id);

  // With one named, it wins -- the instance's own answer beats the derivation.
  await prisma.workInstance.update({ where: { id: wi.id }, data: { currentStageId: one.id } });
  found = await workService.getForWorkInstance(ORG, wi.id, at(1));
  assert.equal(found?.view?.workStageId, one.id);
});

test('5b. a work item with no stages is unreadable, not fine', async () => {
  const { prisma, coordination, caseId, pointAt } = await world();
  const wi = await prisma.workInstance.create({ data: { organizationId: ORG, title: 'Mid-creation', createdByUserId: MATT } });
  await pointAt(WORK_OS_SYSTEM, wi.id);

  const view = await coordination.get(ORG, caseId, at(5));
  assert.equal(view?.work[0]?.unknown, 'NOT_MEASURED');
  assert.equal(view?.work[0]?.workStatus, 'active', 'what IS known is still reported');
});
