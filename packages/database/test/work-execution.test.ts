// Execution truth at the boundary that writes it.
//
// WHAT THESE PROVE
//
// A STATUS AND ITS LOG ROW LAND TOGETHER OR NOT AT ALL. A status written without
// its event would make every duration wrong forever, and nothing would notice --
// the projection would simply be quietly short.
//
// A STAGE IN ANOTHER TENANT IS UNREACHABLE, for reads and for every write.
// `work_stages` carries no organizationId, so the gate is its work instance
// resolved within the organization, and a stage whose instance does not resolve
// never leaves the repository.
//
// DEPENDENCIES FAIL CLOSED. Self-dependency, cross-tenant, cycles, duplicates
// and a missing subject are each refused with a named reason rather than
// written and sorted out later.
//
// COMMERCIAL INTELLIGENCE CANNOT REACH ANY OF IT. The execution surface is in
// Work OS, takes an organization first, and is not exported through any Case
// service.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { WORK_EXECUTION_STATES, isWorkExecutionState } from '@emgloop/shared';

import { makeCognitivePrisma } from './helpers/cognitive-prisma-fake';
import { WorkExecutionRepository } from '../src/repositories/work-execution.repository';
import { WorkExecutionService } from '../src/services/work-execution.service';

const ORG = 'org_alpha';
const OTHER = 'org_beta';
const MATT = 'usr_matt';
const HOUR = 3_600_000;
const T0 = new Date('2026-09-01T09:00:00.000Z');
const at = (h: number) => new Date(T0.getTime() + h * HOUR);

async function world() {
  const prisma = makeCognitivePrisma();
  const repo = new WorkExecutionRepository(prisma as never);
  const service = new WorkExecutionService(prisma as never, { execution: repo });

  const mine = await prisma.workInstance.create({
    data: { organizationId: ORG, title: 'Contact CEM about the settlement drop', createdByUserId: MATT },
  });
  const theirs = await prisma.workInstance.create({
    data: { organizationId: OTHER, title: "Another tenant's work", createdByUserId: 'usr_beta' },
  });
  const stage = await prisma.workStage.create({
    data: { workInstanceId: mine.id, name: 'Call the buyer', position: 1, status: 'ready', ownerUserId: MATT },
  });
  const theirStage = await prisma.workStage.create({
    data: { workInstanceId: theirs.id, name: 'Their step', position: 1, status: 'ready' },
  });
  return { prisma, repo, service, mine, theirs, stage, theirStage };
}

const actor = { userId: MATT, type: 'HUMAN' as const };

// --- 1. Transitions ------------------------------------------------------------------

test('1. a transition writes the status and its log row together', async () => {
  const { prisma, repo, stage } = await world();
  const r = await repo.transition(ORG, stage.id, { to: 'in_progress', actorUserId: MATT, occurredAt: at(1) });
  assert.equal(r.ok, true);

  const stored = await prisma.workStage.findFirst({ where: { id: stage.id } });
  assert.equal(stored.status, 'in_progress');
  assert.equal(stored.startedAt?.getTime(), at(1).getTime());

  const events = await repo.listEvents(ORG, stage.id);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.eventType, 'STATE_CHANGED');
  assert.equal(events[0]?.fromStatus, 'ready');
  assert.equal(events[0]?.toStatus, 'in_progress');
  assert.equal(events[0]?.sequence, 1);
});

test('1b. actionableAt is stamped ONCE and never reset by a return from waiting', async () => {
  // The first moment an obligation could be acted on is the origin of every
  // duration in the assessment. Re-stamping it would silently reset an
  // accountability clock that must never be resettable.
  const { prisma, repo, stage } = await world();
  await repo.transition(ORG, stage.id, { to: 'in_progress', actorUserId: MATT, occurredAt: at(0) });
  const first = (await prisma.workStage.findFirst({ where: { id: stage.id } })).actionableAt;

  await repo.transition(ORG, stage.id, {
    to: 'waiting_external', actorUserId: MATT, occurredAt: at(2),
    wait: { reason: 'AWAITING_EXTERNAL_RESPONSE', subject: 'CEM' },
  });
  await repo.transition(ORG, stage.id, { to: 'in_progress', actorUserId: MATT, occurredAt: at(50) });

  const after = (await prisma.workStage.findFirst({ where: { id: stage.id } })).actionableAt;
  assert.equal(after.getTime(), first.getTime(), 'unchanged across a week of waiting');
});

test('1c. entering a wait REQUIRES a structured reason', async () => {
  // Free text must not decide whether the clock pauses. "waiting on the buyer"
  // and "waiting on Mike" are the same English shape and completely different
  // accountability.
  const { repo, stage } = await world();
  const r = await repo.transition(ORG, stage.id, { to: 'waiting_internal', actorUserId: MATT, note: 'waiting on Mike' });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.refusal, 'WAIT_REASON_REQUIRED');
});

test('1d. the wait state and its reason cannot disagree', async () => {
  const { repo, stage } = await world();
  const r = await repo.transition(ORG, stage.id, {
    to: 'waiting_internal', actorUserId: MATT,
    wait: { reason: 'AWAITING_EXTERNAL_RESPONSE', subject: 'CEM' },
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.refusal, 'WAIT_REASON_MISMATCH');
});

test('1e. completed work cannot be reopened through a status write', async () => {
  const { repo, stage } = await world();
  await repo.transition(ORG, stage.id, { to: 'completed', actorUserId: MATT, occurredAt: at(1) });
  for (const to of WORK_EXECUTION_STATES) {
    const r = await repo.transition(ORG, stage.id, { to, actorUserId: MATT });
    assert.equal(r.ok, false, `completed → ${to} is refused`);
    if (!r.ok) assert.equal(r.refusal, 'TRANSITION_NOT_ALLOWED');
  }
});

test('1f. a refused transition writes nothing at all', async () => {
  const { repo, stage } = await world();
  await repo.transition(ORG, stage.id, { to: 'waiting_internal', actorUserId: MATT });
  const events = await repo.listEvents(ORG, stage.id);
  assert.equal(events.length, 0, 'no log entry for a write that did not happen');
});

// --- 2. Tenancy ------------------------------------------------------------------------

test('2. another tenant\'s stage is not found, for reads and for writes', async () => {
  const { repo, service, theirStage } = await world();
  assert.equal(await repo.getStage(ORG, theirStage.id), null);
  assert.equal(await service.get(ORG, theirStage.id), null);

  const t = await repo.transition(ORG, theirStage.id, { to: 'in_progress', actorUserId: MATT });
  assert.equal(t.ok, false);
  if (!t.ok) assert.equal(t.refusal, 'STAGE_NOT_FOUND', 'indistinguishable from an id that does not exist');

  assert.equal(await repo.setDue(ORG, theirStage.id, at(4), actor), null);
  const d = await repo.addDependency(ORG, theirStage.id, {
    kind: 'EXTERNAL_CONDITION', conditionSubject: 'anything', description: 'x', createdByUserId: MATT,
  });
  assert.equal(d.ok, false);
});

test('2b. a cross-tenant write leaves the other tenant untouched', async () => {
  const { prisma, repo, theirStage } = await world();
  await repo.transition(ORG, theirStage.id, { to: 'completed', actorUserId: MATT });
  const still = await prisma.workStage.findFirst({ where: { id: theirStage.id } });
  assert.equal(still.status, 'ready', 'unchanged');
  assert.equal((await prisma.workStageEvent.findMany({ where: { workStageId: theirStage.id } })).length, 0);
});

// --- 3. Due times -----------------------------------------------------------------------

test('3. a first setting and a move are different events, and every move is kept', async () => {
  const { repo, stage } = await world();
  await repo.setDue(ORG, stage.id, at(8), actor);
  await repo.setDue(ORG, stage.id, at(20), actor);
  await repo.setDue(ORG, stage.id, at(40), actor);

  const events = await repo.listEvents(ORG, stage.id);
  assert.deepEqual(events.map((e) => e.eventType), ['DUE_SET', 'DUE_EXTENDED', 'DUE_EXTENDED']);
  // Each event carries the due time AS OF that moment. Overwriting only the
  // column would leave "pushed twice" underivable.
  assert.deepEqual(events.map((e) => e.dueAt?.getTime()), [at(8).getTime(), at(20).getTime(), at(40).getTime()]);
});

// --- 4. Dependencies ----------------------------------------------------------------------

test('4. work cannot wait for itself', async () => {
  const { repo, stage, mine } = await world();
  const r = await repo.addDependency(ORG, stage.id, {
    kind: 'WORK_INSTANCE', dependsOnWorkInstanceId: mine.id, description: 'itself', createdByUserId: MATT,
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.refusal, 'SELF_DEPENDENCY');
});

test('4b. a dependency cannot cross a tenant boundary', async () => {
  const { repo, stage, theirs } = await world();
  const r = await repo.addDependency(ORG, stage.id, {
    kind: 'WORK_INSTANCE', dependsOnWorkInstanceId: theirs.id, description: 'their work', createdByUserId: MATT,
  });
  assert.equal(r.ok, false);
  // CROSS_TENANT and WORK_NOT_FOUND are the same observable outcome from
  // outside: nothing here tells the caller that another tenant's row exists.
  if (!r.ok) assert.equal(r.refusal, 'CROSS_TENANT');
  assert.equal((await repo.listDependencies(ORG, stage.id)).length, 0);
});

test('4c. a dependency must name what it is waiting for', async () => {
  const { repo, stage } = await world();
  const a = await repo.addDependency(ORG, stage.id, { kind: 'EXTERNAL_CONDITION', description: 'x', createdByUserId: MATT });
  assert.equal(a.ok, false);
  if (!a.ok) assert.equal(a.refusal, 'MISSING_SUBJECT');
  const b = await repo.addDependency(ORG, stage.id, { kind: 'WORK_INSTANCE', description: 'x', createdByUserId: MATT });
  assert.equal(b.ok, false);
  if (!b.ok) assert.equal(b.refusal, 'MISSING_SUBJECT');
});

test('4d. a cycle is refused, and the chain can be any length', async () => {
  const { prisma, repo } = await world();
  const mk = async (title: string) => {
    const wi = await prisma.workInstance.create({ data: { organizationId: ORG, title, createdByUserId: MATT } });
    const st = await prisma.workStage.create({
      data: { workInstanceId: wi.id, name: 'step', position: 1, status: 'ready' },
    });
    return { wi, st };
  };
  const a = await mk('A');
  const b = await mk('B');
  const c = await mk('C');

  assert.equal((await repo.addDependency(ORG, a.st.id, { kind: 'WORK_INSTANCE', dependsOnWorkInstanceId: b.wi.id, description: 'A waits for B', createdByUserId: MATT })).ok, true);
  assert.equal((await repo.addDependency(ORG, b.st.id, { kind: 'WORK_INSTANCE', dependsOnWorkInstanceId: c.wi.id, description: 'B waits for C', createdByUserId: MATT })).ok, true);

  const closing = await repo.addDependency(ORG, c.st.id, {
    kind: 'WORK_INSTANCE', dependsOnWorkInstanceId: a.wi.id, description: 'C waits for A', createdByUserId: MATT,
  });
  assert.equal(closing.ok, false);
  if (!closing.ok) assert.equal(closing.refusal, 'CYCLE');
});

test('4e. the same work dependency cannot be declared twice', async () => {
  const { prisma, repo, stage } = await world();
  const other = await prisma.workInstance.create({ data: { organizationId: ORG, title: 'Other', createdByUserId: MATT } });
  const first = await repo.addDependency(ORG, stage.id, { kind: 'WORK_INSTANCE', dependsOnWorkInstanceId: other.id, description: 'x', createdByUserId: MATT });
  assert.equal(first.ok, true);
  const again = await repo.addDependency(ORG, stage.id, { kind: 'WORK_INSTANCE', dependsOnWorkInstanceId: other.id, description: 'x', createdByUserId: MATT });
  assert.equal(again.ok, false);
  if (!again.ok) assert.equal(again.refusal, 'ALREADY_DECLARED');
});

test('4f. several DIFFERENT external waits on one stage are legal', async () => {
  // NULLs are distinct in Postgres, so the unique on (stage, dependsOnWork)
  // does not constrain external conditions -- and it should not: one step can
  // legitimately be waiting on two different outside things.
  const { repo, stage } = await world();
  const a = await repo.addDependency(ORG, stage.id, { kind: 'EXTERNAL_CONDITION', conditionSubject: 'CEM reply', description: 'a', createdByUserId: MATT });
  const b = await repo.addDependency(ORG, stage.id, { kind: 'EXTERNAL_CONDITION', conditionSubject: 'August sheet', description: 'b', createdByUserId: MATT });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal((await repo.listDependencies(ORG, stage.id, { openOnly: true })).length, 2);
});

test('4g. an open dependency keeps a stage from being marked actionable', async () => {
  const { repo, stage } = await world();
  await repo.addDependency(ORG, stage.id, { kind: 'EXTERNAL_CONDITION', conditionSubject: 'CEM', description: 'x', createdByUserId: MATT });
  const r = await repo.transition(ORG, stage.id, { to: 'in_progress', actorUserId: MATT });
  assert.equal(r.ok, false);
  // Marking it actionable would make the assessment claim somebody can act on
  // something they demonstrably cannot, and start a clock against them for it.
  if (!r.ok) assert.equal(r.refusal, 'BLOCKED_BY_DEPENDENCY');
});

test('4h. resolving is idempotent, keeps the row, and records HOW', async () => {
  const { repo, stage } = await world();
  const added = await repo.addDependency(ORG, stage.id, { kind: 'EXTERNAL_CONDITION', conditionSubject: 'CEM', description: 'x', createdByUserId: MATT });
  assert.equal(added.ok, true);
  if (!added.ok) return;

  const first = await repo.resolveDependency(ORG, added.dependency.id, 'CONFIRMED_BY_PERSON', actor, at(5));
  assert.equal(first?.resolution, 'CONFIRMED_BY_PERSON');
  assert.equal(first?.resolvedAt?.getTime(), at(5).getTime());

  // A completion event can arrive twice. The second must not manufacture a
  // second history.
  const again = await repo.resolveDependency(ORG, added.dependency.id, 'ABANDONED', actor, at(9));
  assert.equal(again?.resolvedAt?.getTime(), at(5).getTime(), 'unchanged');
  assert.equal(again?.resolution, 'CONFIRMED_BY_PERSON');
  const resolvedEvents = (await repo.listEvents(ORG, stage.id)).filter((e) => e.eventType === 'DEPENDENCY_RESOLVED');
  assert.equal(resolvedEvents.length, 1);

  // And the row survives. Deleting it would erase the reason work was stalled.
  assert.equal((await repo.listDependencies(ORG, stage.id)).length, 1);
  assert.equal((await repo.listDependencies(ORG, stage.id, { openOnly: true })).length, 0);
});

// --- 5. The assembled view -----------------------------------------------------------------

test('5. the service assembles an assessment and stores none of it', async () => {
  const { prisma, service, repo, stage } = await world();
  await repo.transition(ORG, stage.id, { to: 'in_progress', actorUserId: MATT, occurredAt: at(0) });

  const early = await service.get(ORG, stage.id, at(5));
  const late = await service.get(ORG, stage.id, at(30));
  assert.equal(early?.assessment.sla, 'WITHIN_POLICY');
  assert.equal(late?.assessment.sla, 'ESCALATION_ELIGIBLE');
  assert.equal(late?.assessment.escalationDestinationUserId, null);

  // NOTHING WAS WRITTEN BY EITHER READ. The verdict is a function of the moment,
  // so a stored copy would be wrong within the hour.
  const stored = await prisma.workStage.findFirst({ where: { id: stage.id } });
  assert.equal('slaState' in stored, false);
  assert.equal(stored.status, 'in_progress', 'the read changed nothing');
  assert.equal((await repo.listEvents(ORG, stage.id)).length, 1, 'reads append nothing');
});

test('5b. the current wait is read from the log, and a later change clears it', async () => {
  const { service, repo, stage } = await world();
  await repo.transition(ORG, stage.id, { to: 'in_progress', actorUserId: MATT, occurredAt: at(0) });
  await repo.transition(ORG, stage.id, {
    to: 'waiting_external', actorUserId: MATT, occurredAt: at(1),
    wait: { reason: 'AWAITING_EXTERNAL_RESPONSE', subject: 'CEM', expectedResolutionAt: at(48) },
  });

  const waiting = await service.get(ORG, stage.id, at(10));
  assert.equal(waiting?.assessment.waiting?.reason, 'AWAITING_EXTERNAL_RESPONSE');
  assert.equal(waiting?.assessment.waiting?.subject, 'CEM');
  assert.equal(waiting?.assessment.sla, 'PAUSED_WAITING');

  await repo.transition(ORG, stage.id, { to: 'in_progress', actorUserId: MATT, occurredAt: at(12) });
  const moving = await service.get(ORG, stage.id, at(13));
  assert.equal(moving?.assessment.waiting, null, 'the wait is over, without a second write to clear it');
});

test('5c. a status this build cannot interpret refuses to be assessed', async () => {
  // Assuming the nearest known state would attribute accountability on the
  // strength of a guess.
  const { prisma, service, stage } = await world();
  await prisma.workStage.update({ where: { id: stage.id }, data: { status: 'something_from_a_later_build' } });
  assert.equal(isWorkExecutionState('something_from_a_later_build'), false);
  assert.equal(await service.get(ORG, stage.id), null);
});

// --- 6. The boundary --------------------------------------------------------------------------

test('6. Commercial Intelligence has no path to execution truth', async () => {
  // The Case side may READ an assessment. It has no method that writes one, and
  // none of its services imports the execution repository.
  for (const file of [
    '../src/services/case-participation.service.ts',
    '../src/services/case-recommendation.service.ts',
    '../src/services/case-finding.service.ts',
    '../src/services/case-brief.service.ts',
  ]) {
    const src = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.equal(
      /work-execution\.repository/.test(src),
      false,
      `${file} must not reach the execution repository`,
    );
    for (const method of ['transition(', 'setDue(', 'addDependency(', 'resolveDependency(']) {
      assert.equal(src.includes(method), false, `${file} must not call ${method}`);
    }
  }
});

test('6b. every execution write takes the organization first', () => {
  const src = readFileSync(new URL('../src/repositories/work-execution.repository.ts', import.meta.url), 'utf8');
  for (const m of ['transition', 'setDue', 'addDependency', 'resolveDependency', 'getStage', 'listEvents', 'listDependencies']) {
    assert.ok(
      new RegExp(`\\b(async )?${m}\\(\\s*\\n?\\s*organizationId: string`).test(src),
      `${m} takes organizationId first`,
    );
  }
});
