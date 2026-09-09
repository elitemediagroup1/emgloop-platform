// What happens to everything that was waiting, when a piece of work finishes.
//
// WHAT THESE PROVE
//
// THE TRANSITION IS WORK OS'S. A dependency resolves because Work OS observed
// its own completion, or because an attributed person said so. Commercial
// Intelligence may hear about it; it cannot cause it, and nothing in this file
// gives it a way to.
//
// ONE OF THREE BLOCKS CLEARING IS NOT BEING UNBLOCKED. A stage still waiting on
// something else stays blocked and is reported as such, because publishing
// "this is actionable" for it would send somebody to work they still cannot do.
//
// THE EXISTING OUTBOX IS THE MECHANISM. `WORK_ITEM` and `WORK` have been in the
// schema since the Decision Center shipped, waiting for a producer. No new
// table, no new publisher, no second retry policy.
//
// IT IS SAFE TO RUN TWICE. A completion can be observed twice — a retry, a
// double-click, a redelivery — and the second pass publishes nothing and changes
// nothing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { makeCognitivePrisma } from './helpers/cognitive-prisma-fake';
import { WorkExecutionRepository } from '../src/repositories/work-execution.repository';
import { WorkReactivationService, WORK_EVENT_NAMES } from '../src/services/work-reactivation.service';

const ORG = 'org_alpha';
const OTHER = 'org_beta';
const MATT = 'usr_matt';
const NOW = new Date('2026-09-08T12:00:00.000Z');

async function world() {
  const prisma = makeCognitivePrisma();
  const execution = new WorkExecutionRepository(prisma as never);
  const reactivation = new WorkReactivationService(prisma as never, { execution });

  const mk = async (title: string, organizationId = ORG) => {
    const wi = await prisma.workInstance.create({
      data: { organizationId, title, createdByUserId: MATT },
    });
    const st = await prisma.workStage.create({
      data: { workInstanceId: wi.id, name: `${title} step`, position: 1, status: 'ready', ownerUserId: MATT },
    });
    return { wi, st };
  };
  return { prisma, execution, reactivation, mk };
}

const outboxRows = (prisma: ReturnType<typeof makeCognitivePrisma>) =>
  prisma.stateChangeOutbox.findMany({ where: {} });

const complete = (prisma: ReturnType<typeof makeCognitivePrisma>, id: string) =>
  prisma.workInstance.update({ where: { id }, data: { status: 'completed', completedAt: NOW } });

// --- 1. The happy path -------------------------------------------------------------

test('1. completing work resolves what waited on it and reactivates the stage', async () => {
  const { prisma, execution, reactivation, mk } = await world();
  const blocker = await mk('Get the buyer sheet');
  const waiter = await mk('Reconcile August');

  const dep = await execution.addDependency(ORG, waiter.st.id, {
    kind: 'WORK_INSTANCE',
    dependsOnWorkInstanceId: blocker.wi.id,
    description: 'Cannot reconcile until the sheet arrives.',
    createdByUserId: MATT,
  });
  assert.equal(dep.ok, true);
  await execution.transition(ORG, waiter.st.id, {
    to: 'blocked', actorUserId: MATT,
    wait: { reason: 'AWAITING_DEPENDENCY', subject: blocker.wi.id },
  });

  await complete(prisma, blocker.wi.id);
  const result = await reactivation.onWorkCompleted(ORG, blocker.wi.id, { userId: MATT, type: 'HUMAN' }, NOW);

  assert.equal(result?.resolvedDependencyIds.length, 1);
  assert.deepEqual(result?.reactivatedStageIds, [waiter.st.id]);
  assert.deepEqual(result?.stillBlockedStageIds, []);

  const stage = await prisma.workStage.findFirst({ where: { id: waiter.st.id } });
  assert.equal(stage.status, 'ready', 'it can be acted on again');

  // The resolution says HOW, and it came from Work OS observing its own
  // completion rather than from anybody inferring one.
  const deps = await execution.listDependencies(ORG, waiter.st.id);
  assert.equal(deps[0]?.resolution, 'DEPENDED_WORK_COMPLETED');
});

test('1b. the events published are the three Work OS owns, on the existing outbox', async () => {
  const { prisma, execution, reactivation, mk } = await world();
  const blocker = await mk('A');
  const waiter = await mk('B');
  await execution.addDependency(ORG, waiter.st.id, {
    kind: 'WORK_INSTANCE', dependsOnWorkInstanceId: blocker.wi.id, description: 'x', createdByUserId: MATT,
  });
  await execution.transition(ORG, waiter.st.id, {
    to: 'blocked', actorUserId: MATT, wait: { reason: 'AWAITING_DEPENDENCY', subject: blocker.wi.id },
  });
  await complete(prisma, blocker.wi.id);
  await reactivation.onWorkCompleted(ORG, blocker.wi.id, { userId: MATT, type: 'HUMAN' }, NOW);

  const rows = await outboxRows(prisma);
  assert.deepEqual(
    rows.map((r) => r.eventType),
    [WORK_EVENT_NAMES.COMPLETED, WORK_EVENT_NAMES.DEPENDENCY_RESOLVED, WORK_EVENT_NAMES.BECAME_ACTIONABLE],
  );
  for (const row of rows) {
    // BOTH VALUES ALREADY EXISTED IN THE SCHEMA. This producer needed no
    // migration and no second event mechanism.
    assert.equal(row.subjectType, 'WORK_ITEM');
    assert.equal(row.domain, 'WORK');
    assert.equal(row.organizationId, ORG);
    // NO BUSINESS CONTENT. A subscriber re-reads by id, scoped to the
    // organization on the outbox row — never to anything inside this payload.
    const serialized = JSON.stringify(row.payload);
    for (const leaked of ['title', 'Reconcile', 'severity', 'ownerUserId']) {
      assert.equal(serialized.includes(leaked), false, `payload must not carry ${leaked}`);
    }
  }
});

// --- 2. Partial unblocking --------------------------------------------------------

test('2. one of two blocks clearing leaves the stage blocked, and says so', async () => {
  const { prisma, execution, reactivation, mk } = await world();
  const first = await mk('First blocker');
  const waiter = await mk('Waiter');

  await execution.addDependency(ORG, waiter.st.id, {
    kind: 'WORK_INSTANCE', dependsOnWorkInstanceId: first.wi.id, description: 'a', createdByUserId: MATT,
  });
  await execution.addDependency(ORG, waiter.st.id, {
    kind: 'EXTERNAL_CONDITION', conditionSubject: 'CEM confirms the credit', description: 'b', createdByUserId: MATT,
  });
  await execution.transition(ORG, waiter.st.id, {
    to: 'blocked', actorUserId: MATT, wait: { reason: 'AWAITING_DEPENDENCY', subject: first.wi.id },
  });

  await complete(prisma, first.wi.id);
  const result = await reactivation.onWorkCompleted(ORG, first.wi.id, { userId: MATT, type: 'HUMAN' }, NOW);

  assert.deepEqual(result?.reactivatedStageIds, []);
  assert.deepEqual(result?.stillBlockedStageIds, [waiter.st.id]);
  const stage = await prisma.workStage.findFirst({ where: { id: waiter.st.id } });
  assert.equal(stage.status, 'blocked', 'still cannot be acted on');

  // And nothing claimed otherwise.
  const rows = await outboxRows(prisma);
  assert.equal(rows.some((r) => r.eventType === WORK_EVENT_NAMES.BECAME_ACTIONABLE), false);
});

// --- 3. Idempotency -----------------------------------------------------------------

test('3. observing the same completion twice changes and publishes nothing', async () => {
  const { prisma, execution, reactivation, mk } = await world();
  const blocker = await mk('A');
  const waiter = await mk('B');
  await execution.addDependency(ORG, waiter.st.id, {
    kind: 'WORK_INSTANCE', dependsOnWorkInstanceId: blocker.wi.id, description: 'x', createdByUserId: MATT,
  });
  await execution.transition(ORG, waiter.st.id, {
    to: 'blocked', actorUserId: MATT, wait: { reason: 'AWAITING_DEPENDENCY', subject: blocker.wi.id },
  });
  await complete(prisma, blocker.wi.id);

  const first = await reactivation.onWorkCompleted(ORG, blocker.wi.id, { userId: MATT, type: 'HUMAN' }, NOW);
  const eventsAfterFirst = (await execution.listEvents(ORG, waiter.st.id)).length;

  const second = await reactivation.onWorkCompleted(ORG, blocker.wi.id, { userId: MATT, type: 'HUMAN' }, NOW);
  assert.equal(first?.resolvedDependencyIds.length, 1);
  assert.deepEqual(second?.resolvedDependencyIds, [], 'nothing left to resolve');
  assert.deepEqual(second?.reactivatedStageIds, []);
  assert.equal(
    (await execution.listEvents(ORG, waiter.st.id)).length,
    eventsAfterFirst,
    'no second history was manufactured',
  );
  // Only the completion event repeats, because a completion genuinely was
  // observed again; nothing about the dependency did.
  const rows = await outboxRows(prisma);
  assert.equal(rows.filter((r) => r.eventType === WORK_EVENT_NAMES.BECAME_ACTIONABLE).length, 1);
});

// --- 4. The completion is verified, not trusted ---------------------------------------

test('4. an unfinished work item unblocks nothing', async () => {
  // A retry firing against a cancelled item, or a stale queue message, would
  // otherwise unblock work on the strength of an assertion nobody checked.
  const { execution, reactivation, mk } = await world();
  const blocker = await mk('Still going');
  const waiter = await mk('Waiter');
  await execution.addDependency(ORG, waiter.st.id, {
    kind: 'WORK_INSTANCE', dependsOnWorkInstanceId: blocker.wi.id, description: 'x', createdByUserId: MATT,
  });
  assert.equal(await reactivation.onWorkCompleted(ORG, blocker.wi.id, { userId: MATT, type: 'HUMAN' }, NOW), null);
  assert.equal((await execution.listDependencies(ORG, waiter.st.id, { openOnly: true })).length, 1);
});

test('4b. another tenant cannot trigger a reactivation, and cannot tell it exists', async () => {
  const { prisma, execution, reactivation, mk } = await world();
  const blocker = await mk('A');
  const waiter = await mk('B');
  await execution.addDependency(ORG, waiter.st.id, {
    kind: 'WORK_INSTANCE', dependsOnWorkInstanceId: blocker.wi.id, description: 'x', createdByUserId: MATT,
  });
  await execution.transition(ORG, waiter.st.id, {
    to: 'blocked', actorUserId: MATT, wait: { reason: 'AWAITING_DEPENDENCY', subject: blocker.wi.id },
  });
  await complete(prisma, blocker.wi.id);

  // Same id, wrong organization. Null, exactly as a missing id would be.
  assert.equal(await reactivation.onWorkCompleted(OTHER, blocker.wi.id, { userId: 'usr_beta', type: 'HUMAN' }, NOW), null);
  const stage = await prisma.workStage.findFirst({ where: { id: waiter.st.id } });
  assert.equal(stage.status, 'blocked', 'untouched');
  assert.equal((await outboxRows(prisma)).length, 0, 'and nothing was published');
});

// --- 5. A stage nobody left blocked is left alone ----------------------------------------

test('5. a stage its owner already moved on from is not dragged back to ready', async () => {
  // Work OS does not know better than the last person who touched it.
  const { prisma, execution, reactivation, mk } = await world();
  const blocker = await mk('A');
  const waiter = await mk('B');
  await execution.addDependency(ORG, waiter.st.id, {
    kind: 'WORK_INSTANCE', dependsOnWorkInstanceId: blocker.wi.id, description: 'x', createdByUserId: MATT,
  });
  // Left in `ready` rather than moved to `blocked`.
  await complete(prisma, blocker.wi.id);
  const result = await reactivation.onWorkCompleted(ORG, blocker.wi.id, { userId: MATT, type: 'HUMAN' }, NOW);

  assert.equal(result?.resolvedDependencyIds.length, 1, 'the block still cleared');
  assert.deepEqual(result?.reactivatedStageIds, [], 'but nothing was transitioned');
  const stage = await prisma.workStage.findFirst({ where: { id: waiter.st.id } });
  assert.equal(stage.status, 'ready');
});

// --- 6. The boundary --------------------------------------------------------------------

test('6. Commercial Intelligence has no path to resolve a dependency', async () => {
  for (const file of [
    '../src/services/case-participation.service.ts',
    '../src/services/case-recommendation.service.ts',
    '../src/services/case-finding.service.ts',
    '../src/services/case-brief.service.ts',
    '../src/services/personal-priority.service.ts',
  ]) {
    const src = readFileSync(new URL(file, import.meta.url), 'utf8');
    for (const forbidden of ['resolveDependency', 'work-reactivation', 'onWorkCompleted']) {
      assert.equal(src.includes(forbidden), false, `${file} must not reference ${forbidden}`);
    }
  }
});

test('6b. no second event mechanism was built', () => {
  const src = readFileSync(new URL('../src/services/work-reactivation.service.ts', import.meta.url), 'utf8');
  // It publishes through StateChangeOutboxRepository and nothing else. A private
  // queue table, a direct notification write or a webhook here would be the
  // second bus this repository has already paid for once.
  assert.ok(src.includes('StateChangeOutboxRepository'));
  for (const forbidden of ['workNotification', 'fetch(', 'setTimeout', 'setInterval']) {
    assert.equal(src.includes(forbidden), false, `must not use ${forbidden}`);
  }
});
