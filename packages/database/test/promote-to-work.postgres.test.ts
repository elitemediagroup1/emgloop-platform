// Loop Intelligence Phase C (2026-09-26): Promote to Work against a REAL Postgres.
// OPT-IN AND LOCAL ONLY: LOOP_TEST_POSTGRES_URL (migrated through 20261007000000) and, for the
// pre-migration proof, LOOP_TEST_PRE_FABRIC_POSTGRES_URL (production as of d70f737).
//
// WHAT IT PROVES
//   - A private origin is re-resolved inside the promoter's own scope: someone else's is NOT_FOUND,
//     whatever their role. An organization origin needs the read authority the caller proved.
//   - Nothing is created without a confirmation or with a changed origin (STALE_CONFIRMATION). One
//     confirmed SUBMISSION creates one piece of work (a retry returns it); a new confirmed promotion of the
//     same origin -- a Case especially -- creates another.
//   - A private situation is promoted by its owner only (through SituationRepository), as a PRINCIPAL
//     origin, and its WORK_LINKED is written without an organization Case read.
//   - Self-assignment is always allowed; assigning a coworker needs work:manage, and only to an active member.
//   - The work and its origin link land in ONE transaction; the origin's own log records WORK_LINKED and
//     its state/lane does not move.
//   - The target date becomes the work's commitment (expectedReturnAt) -- the field every reader reads.
//   - Before the migration nothing is created (NOT_MIGRATED).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

import { IntelligenceDigestRepository } from '../src/repositories/intelligence/intelligence-digest.repository';
import { WorkItemRepository } from '../src/repositories/work-state/work-item.repository';
import { WorkRepository } from '../src/repositories/work.repository';
import { OperationalPriorityRepository } from '../src/repositories/operational-priority.repository';
import { SituationRepository, SITUATION_RECORD_SCHEMA } from '../src/repositories/intelligence/situation.repository';
import { PromoteToWorkService, type PromoteActor } from '../src/services/work/promote-to-work.service';

const LOCAL = (url: string) => /^postgres(ql)?:\/\/[^@]*@(localhost|127\.0\.0\.1)(:\d+)?\//.test(url);
const URL = process.env.LOOP_TEST_POSTGRES_URL ?? '';
const PRE_URL = process.env.LOOP_TEST_PRE_FABRIC_POSTGRES_URL ?? '';
const skip = !URL ? 'LOOP_TEST_POSTGRES_URL is not set' : !LOCAL(URL) ? 'refusing a non-local database' : false;
const skipPre = !PRE_URL ? 'LOOP_TEST_PRE_FABRIC_POSTGRES_URL is not set' : !LOCAL(PRE_URL) ? 'refusing a non-local database' : false;

const NOW = new Date('2026-09-26T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const at = (days: number) => new Date(NOW.getTime() + days * DAY);

async function world(prisma: PrismaClient, label: string) {
  const organizationId = `org_ptw_${label}_${randomUUID()}`;
  await prisma.organization.create({ data: { id: organizationId, name: `PTW ${label}`, slug: organizationId } });
  const users: string[] = [];
  for (const [i, role] of (['OWNER', 'EMPLOYEE', 'EMPLOYEE'] as const).entries()) {
    const userId = `user_ptw_${label}_${i}_${randomUUID()}`;
    await prisma.user.create({ data: { id: userId, organizationId, email: `${userId}@example.test`, name: `P${i}`, status: 'ACTIVE', metadata: { systemRole: role, passwordHash: 'kept' } } });
    await prisma.organizationMembership.create({ data: { organizationId, userId, systemRole: role, status: 'ACTIVE', effectiveFrom: new Date('2026-01-01T00:00:00Z') } });
    users.push(userId);
  }
  const type = await prisma.blueprint.create({ data: { organizationId, name: 'Follow-up', createdByUserId: users[0]!, metadata: { kind: 'work_type', defaultPriority: 'normal' } } });
  return { organizationId, users, workTypeId: type.id };
}

const actorOf = (organizationId: string, userId: string, over: Partial<PromoteActor> = {}): PromoteActor => ({
  organizationId,
  userId,
  mayAssignOthers: false,
  mayReadCases: false,
  mayReadOrganizationDomain: () => false,
  ...over,
});

async function authorizeTelegram(prisma: PrismaClient, organizationId: string, userId: string) {
  await prisma.sourceConnection.create({ data: { organizationId, userId, provider: 'TELEGRAM', state: 'READY', backgroundObservation: 'UNAVAILABLE', connectedAt: at(-90) } });
  await prisma.sourceContentAuthorization.create({ data: { organizationId, userId, provider: 'TELEGRAM', authorizedAt: at(-60) } });
}

async function chatsDigestWithObligation(prisma: PrismaClient, organizationId: string, userId: string) {
  await authorizeTelegram(prisma, organizationId, userId);
  const written = await new IntelligenceDigestRepository(prisma).upsert({ organizationId, userId }, {
    domain: 'CHATS', subjectKind: 'CONVERSATION', subjectRef: 'telegram_conversation:ck_premier', provider: 'TELEGRAM', consentBasis: 'CONTENT_AUTHORIZATION',
    content: {
      synthesis: 'Premier is waiting on the revised allocation.',
      signals: [{ key: 'obligation.a1', kind: 'OBLIGATION', knowledge: 'OBSERVED', owedBy: 'VIEWER', statement: 'Send Premier the revised allocation', evidenceRefs: ['telegram_message:ck_premier:9'], dueAt: '2026-09-30T17:00:00Z' }],
    },
    coverage: 'CONNECTED_SUFFICIENT', windowStart: at(-3), windowEnd: at(-0.1), evidenceCount: 4, lastEvidenceAt: at(-0.1),
    provenance: { sourceRefs: ['telegram_conversation:ck_premier'], producerVersion: 'test@1', producerKind: 'MODEL' },
    aiInvocationId: 'inv_1', fingerprint: 'fp-premier', generatedAt: NOW,
  });
  assert.equal(written.outcome, 'WRITTEN');
}

const SIGNAL = { kind: 'DIGEST_SIGNAL', scope: 'PRINCIPAL', domain: 'CHATS', subjectKind: 'CONVERSATION', subjectRef: 'telegram_conversation:ck_premier', signalKey: 'obligation.a1' } as const;

test('a private signal is promoted only by its owner, only when confirmed and unchanged; a retried submission is idempotent -- and the target becomes the commitment', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  const w = await world(prisma, 'signal');
  const [owner, matt, lexi] = w.users;
  try {
    await chatsDigestWithObligation(prisma, w.organizationId, matt!);
    const service = new PromoteToWorkService(prisma, { now: () => NOW });
    const mattActor = actorOf(w.organizationId, matt!);
    const preview = await service.preview(mattActor, SIGNAL);
    assert.equal(preview.outcome, 'READY');
    if (preview.outcome !== 'READY') return;
    assert.equal(preview.proposal.title, 'Send Premier the revised allocation');
    assert.equal(preview.proposal.originScope, 'PRINCIPAL');
    assert.equal(preview.proposal.suggestedAssigneeUserId, matt, 'a suggestion: the person themselves');
    assert.deepEqual(preview.proposal.sharedFields, ['title', 'outcome', 'assignee', 'targetDate']);
    // SOMEBODY ELSE'S PRIVATE ORIGIN IS NOT FOUND -- the OWNER included, whatever they may assign.
    for (const other of [actorOf(w.organizationId, owner!, { mayAssignOthers: true, mayReadCases: true, mayReadOrganizationDomain: () => true }), actorOf(w.organizationId, lexi!)]) {
      assert.deepEqual(await service.preview(other, SIGNAL), { outcome: 'REFUSED', refusal: 'NOT_FOUND' });
    }
    const confirm = { title: 'Send Premier the revised allocation', outcome: 'Premier has the revised allocation', workTypeId: w.workTypeId, assigneeUserId: matt!, targetAt: at(4), fingerprint: preview.proposal.fingerprint, confirmed: true, submissionNonce: preview.proposal.submissionNonce };
    assert.deepEqual(await service.promote(mattActor, SIGNAL, { ...confirm, submissionNonce: 'short' }), { outcome: 'REFUSED', refusal: 'INVALID_INPUT' }, 'a submission names its preview');
    assert.deepEqual(await service.promote(mattActor, SIGNAL, { ...confirm, confirmed: false }), { outcome: 'REFUSED', refusal: 'NOT_CONFIRMED' });
    assert.deepEqual(await service.promote(mattActor, SIGNAL, { ...confirm, fingerprint: 'promote:old' }), { outcome: 'REFUSED', refusal: 'STALE_CONFIRMATION' });
    assert.deepEqual(await service.promote(mattActor, SIGNAL, { ...confirm, title: '  ' }), { outcome: 'REFUSED', refusal: 'INVALID_INPUT' });
    assert.deepEqual(await service.promote(mattActor, SIGNAL, { ...confirm, workTypeId: 'nope' }), { outcome: 'REFUSED', refusal: 'WORK_TYPE_NOT_FOUND' });
    // A SUGGESTION IS NOT AUTHORITY: without work:manage, only yourself.
    assert.deepEqual(await service.promote(mattActor, SIGNAL, { ...confirm, assigneeUserId: lexi! }), { outcome: 'REFUSED', refusal: 'ASSIGNEE_NOT_PERMITTED' });
    assert.equal(await prisma.workInstance.count({ where: { organizationId: w.organizationId } }), 0, 'no refusal created anything');

    const promoted = await service.promote(mattActor, SIGNAL, confirm);
    assert.equal(promoted.outcome, 'PROMOTED');
    if (promoted.outcome !== 'PROMOTED') return;
    const work = await prisma.workInstance.findFirst({ where: { id: promoted.workInstanceId, organizationId: w.organizationId }, include: { stages: true, origins: true } });
    assert.equal(work!.title, 'Send Premier the revised allocation');
    assert.equal(work!.description, 'Premier has the revised allocation');
    assert.deepEqual(work!.expectedReturnAt, at(4), 'the target is the commitment every reader reads');
    assert.equal(work!.expectedReturnSetByUserId, matt);
    assert.equal(work!.stages[0]!.ownerUserId, matt);
    assert.equal(work!.origins.length, 1);
    const origin = work!.origins[0]!;
    assert.deepEqual([origin.originKind, origin.originScope, origin.originUserId, origin.promotedByUserId], ['DIGEST_SIGNAL', 'PRINCIPAL', matt, matt]);
    assert.match(origin.originRef, /#obligation\.a1$/);
    assert.equal(JSON.stringify(origin).includes('Premier'), false, 'the link carries keys, never the content');
    // A RETRIED SUBMISSION is idempotent: the same work, nothing new.
    assert.deepEqual(await service.promote(mattActor, SIGNAL, confirm), { outcome: 'PROMOTED', workInstanceId: promoted.workInstanceId });
    assert.equal(await prisma.workInstance.count({ where: { organizationId: w.organizationId } }), 1);
    // A later preview says it is already linked, with a NEW nonce.
    const again = await service.preview(mattActor, SIGNAL);
    assert.equal(again.outcome, 'READY');
    if (again.outcome !== 'READY') return;
    assert.equal(again.proposal.alreadyLinkedCount, 1);
    assert.notEqual(again.proposal.submissionNonce, preview.proposal.submissionNonce);
  } finally {
    await prisma.workInstance.deleteMany({ where: { organizationId: w.organizationId } }).catch(() => undefined);
    await prisma.blueprint.deleteMany({ where: { organizationId: w.organizationId } }).catch(() => undefined);
    await prisma.organization.delete({ where: { id: w.organizationId } }).catch(() => undefined);
    await prisma.$disconnect();
  }
});

test('assigning a coworker needs work:manage and an active member; a Daily Loop item records WORK_LINKED and keeps its state', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  const w = await world(prisma, 'item');
  const [owner, matt, lexi] = w.users;
  try {
    const items = new WorkItemRepository(prisma);
    await authorizeTelegram(prisma, w.organizationId, owner!);
    await items.detect({ organizationId: w.organizationId, userId: owner! }, {
      recurrenceKey: 'telegram.content.triage:ck:1', class: 'NEEDS_YOU', subjectKind: 'THREAD', subjectRef: 'telegram_conversation:ck', title: 'Confirm the October cap with Premier',
      producerKind: 'MODEL', producerId: 'telegram.content.triage', producerVersion: '4.0.0', evidence: { provider: 'TELEGRAM', nextStep: 'Confirm the cap', deadline: '2026-10-02' }, detectedAt: NOW,
    } as never);
    const item = (await items.items({ organizationId: w.organizationId, userId: owner! }))[0]!;
    const service = new PromoteToWorkService(prisma, { now: () => NOW });
    const ownerActor = actorOf(w.organizationId, owner!, { mayAssignOthers: true });
    const origin = { kind: 'WORK_ITEM', itemId: item.id } as const;
    const preview = await service.preview(ownerActor, origin);
    assert.equal(preview.outcome, 'READY');
    if (preview.outcome !== 'READY') return;
    assert.deepEqual(preview.proposal.targetAt, new Date('2026-10-02T17:00:00Z'), 'a deadline written as a date becomes a target');
    assert.deepEqual(await service.preview(actorOf(w.organizationId, matt!), origin), { outcome: 'REFUSED', refusal: 'NOT_FOUND' }, 'nobody promotes another person\'s item');
    const confirm = { title: item.title!, outcome: 'Cap confirmed', workTypeId: w.workTypeId, assigneeUserId: lexi!, targetAt: null, fingerprint: preview.proposal.fingerprint, confirmed: true, submissionNonce: preview.proposal.submissionNonce };
    assert.deepEqual(await service.promote(ownerActor, origin, { ...confirm, assigneeUserId: 'user_not_here' }), { outcome: 'REFUSED', refusal: 'ASSIGNEE_NOT_A_MEMBER' });
    const promoted = await service.promote(ownerActor, origin, confirm);
    assert.equal(promoted.outcome, 'PROMOTED');
    if (promoted.outcome !== 'PROMOTED') return;
    const stage = await prisma.workStage.findFirst({ where: { workInstanceId: promoted.workInstanceId } });
    assert.equal(stage!.ownerUserId, lexi, 'work:manage may give it to a coworker');
    const log = await items.observations({ organizationId: w.organizationId, userId: owner! }, item.id);
    const linked = log.find((o) => o.observationType === 'WORK_LINKED');
    assert.ok(linked);
    assert.equal(linked!.previousState, linked!.newState, 'the item\'s state did not move');
    assert.equal((await items.item({ organizationId: w.organizationId, userId: owner! }, item.id))!.state, 'OPEN');
  } finally {
    await prisma.workInstance.deleteMany({ where: { organizationId: w.organizationId } }).catch(() => undefined);
    await prisma.blueprint.deleteMany({ where: { organizationId: w.organizationId } }).catch(() => undefined);
    await prisma.organization.delete({ where: { id: w.organizationId } }).catch(() => undefined);
    await prisma.$disconnect();
  }
});

test('an organization Case needs the Cases read authority, may become TWO distinct pieces of work, records WORK_LINKED each time and moves no lane; another organization cannot reach it', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  const w = await world(prisma, 'case');
  const [owner] = w.users;
  try {
    const kase = await prisma.operationalPriority.create({
      data: { organizationId: w.organizationId, sourceSystem: 'commercial-intelligence', recurrenceKey: `headline:${randomUUID()}`, title: 'Premier conversion fell', summary: 'Conversion fell week over week', firstDetectedAt: at(-2), lastDetectedAt: at(-1), severity: 'HIGH' },
    });
    const service = new PromoteToWorkService(prisma, { now: () => NOW });
    const origin = { kind: 'CASE', caseId: kase.id } as const;
    // Without the Cases authority an organization Case is simply not there for this person.
    assert.deepEqual(await service.preview(actorOf(w.organizationId, owner!), origin), { outcome: 'REFUSED', refusal: 'NOT_FOUND' });
    const actor = actorOf(w.organizationId, owner!, { mayReadCases: true });
    const preview = await service.preview(actor, origin);
    assert.equal(preview.outcome, 'READY');
    if (preview.outcome !== 'READY') return;
    const promoted = await service.promote(actor, origin, { title: 'Investigate Premier conversion', outcome: 'Know why conversion fell', workTypeId: w.workTypeId, assigneeUserId: owner!, targetAt: null, fingerprint: preview.proposal.fingerprint, confirmed: true, submissionNonce: preview.proposal.submissionNonce });
    assert.equal(promoted.outcome, 'PROMOTED');
    // A SECOND legitimate piece of work from the same Case: a new preview, a new confirmed submission.
    const second = await service.preview(actor, origin);
    assert.equal(second.outcome, 'READY');
    if (second.outcome !== 'READY' || promoted.outcome !== 'PROMOTED') return;
    assert.equal(second.proposal.alreadyLinkedCount, 1);
    const promotedAgain = await service.promote(actor, origin, { title: 'Call Premier about conversion', outcome: 'Premier explains the drop', workTypeId: w.workTypeId, assigneeUserId: owner!, targetAt: null, fingerprint: second.proposal.fingerprint, confirmed: true, submissionNonce: second.proposal.submissionNonce });
    assert.equal(promotedAgain.outcome, 'PROMOTED');
    if (promotedAgain.outcome !== 'PROMOTED') return;
    assert.notEqual(promotedAgain.workInstanceId, promoted.workInstanceId);
    assert.equal(await prisma.workOrigin.count({ where: { organizationId: w.organizationId, originKind: 'CASE', originRef: kase.id } }), 2);
    const log = await prisma.operationalObservation.findMany({ where: { organizationId: w.organizationId, priorityId: kase.id } });
    assert.equal(log.filter((o) => o.observationType === 'WORK_LINKED').length, 2);
    const linked = log.find((o) => o.observationType === 'WORK_LINKED');
    assert.ok(linked);
    assert.equal((linked!.evidence as any).destination.system, 'work-os');
    const after = await prisma.operationalPriority.findFirst({ where: { id: kase.id } });
    assert.equal(after!.state, 'NEEDS_REVIEW', 'the Case lane did not move');
    // Another organization's Case is not found.
    const other = await world(prisma, 'case_other');
    try {
      assert.deepEqual(await service.preview(actorOf(other.organizationId, other.users[0]!, { mayReadCases: true }), origin), { outcome: 'REFUSED', refusal: 'NOT_FOUND' });
    } finally {
      await prisma.blueprint.deleteMany({ where: { organizationId: other.organizationId } }).catch(() => undefined);
      await prisma.organization.delete({ where: { id: other.organizationId } }).catch(() => undefined);
    }
  } finally {
    await prisma.workInstance.deleteMany({ where: { organizationId: w.organizationId } }).catch(() => undefined);
    await prisma.operationalObservation.deleteMany({ where: { organizationId: w.organizationId } }).catch(() => undefined);
    await prisma.operationalPriority.deleteMany({ where: { organizationId: w.organizationId } }).catch(() => undefined);
    await prisma.blueprint.deleteMany({ where: { organizationId: w.organizationId } }).catch(() => undefined);
    await prisma.organization.delete({ where: { id: w.organizationId } }).catch(() => undefined);
    await prisma.$disconnect();
  }
});

test('the Start Work form\'s target completion is now the work\'s commitment (expectedReturnAt), not a metadata field nobody reads', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  const w = await world(prisma, 'target');
  const [owner] = w.users;
  try {
    const work = new WorkRepository(prisma);
    const step = { name: 'Do it', instruction: 'Do it', assignment: { mode: 'creator' as const }, completionNote: 'optional' as const, notifyActive: false, notifyComplete: false };
    const withTarget = await work.createWorkItem({ organizationId: w.organizationId, creatorUserId: owner!, workTypeId: w.workTypeId, workTypeName: 'Follow-up', title: 'A', outcome: 'B', priority: 'normal', targetAtUtc: '2026-10-01T21:00:00.000Z', steps: [step] });
    const row = await prisma.workInstance.findFirst({ where: { id: withTarget.id } });
    assert.deepEqual(row!.expectedReturnAt, new Date('2026-10-01T21:00:00.000Z'));
    assert.equal(row!.expectedReturnSetByUserId, owner);
    assert.equal((row!.metadata as any).targetAtUtc, '2026-10-01T21:00:00.000Z', 'the history field is kept');
    const without = await work.createWorkItem({ organizationId: w.organizationId, creatorUserId: owner!, workTypeId: w.workTypeId, workTypeName: 'Follow-up', title: 'C', outcome: 'D', priority: 'normal', targetAtUtc: 'not a date', steps: [step] });
    assert.equal((await prisma.workInstance.findFirst({ where: { id: without.id } }))!.expectedReturnAt, null, 'an unreadable target is never guessed');
  } finally {
    await prisma.workInstance.deleteMany({ where: { organizationId: w.organizationId } }).catch(() => undefined);
    await prisma.blueprint.deleteMany({ where: { organizationId: w.organizationId } }).catch(() => undefined);
    await prisma.organization.delete({ where: { id: w.organizationId } }).catch(() => undefined);
    await prisma.$disconnect();
  }
});

test('PRE-MIGRATION: nothing is promoted and nothing is created (NOT_MIGRATED)', { skip: skipPre }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: PRE_URL } } });
  const w = await world(prisma, 'premig');
  const [owner] = w.users;
  try {
    const items = new WorkItemRepository(prisma);
    await authorizeTelegram(prisma, w.organizationId, owner!);
    await items.detect({ organizationId: w.organizationId, userId: owner! }, {
      recurrenceKey: 'k:1', class: 'NEEDS_YOU', subjectKind: 'THREAD', subjectRef: 'telegram_conversation:ck', title: 'Confirm the cap', producerKind: 'MODEL', producerId: 'p', producerVersion: '1', evidence: { provider: 'TELEGRAM' }, detectedAt: NOW,
    } as never);
    const item = (await items.items({ organizationId: w.organizationId, userId: owner! }))[0]!;
    const service = new PromoteToWorkService(prisma, { now: () => NOW });
    const actor = actorOf(w.organizationId, owner!);
    assert.deepEqual(await service.preview(actor, { kind: 'WORK_ITEM', itemId: item.id }), { outcome: 'REFUSED', refusal: 'NOT_MIGRATED' });
    assert.deepEqual(
      await service.promote(actor, { kind: 'WORK_ITEM', itemId: item.id }, { title: 'x', outcome: 'y', workTypeId: w.workTypeId, assigneeUserId: owner!, targetAt: null, fingerprint: 'f', confirmed: true, submissionNonce: 'nonce_premigration_0001' }),
      { outcome: 'REFUSED', refusal: 'STALE_CONFIRMATION' },
    );
    assert.equal(await prisma.workInstance.count({ where: { organizationId: w.organizationId } }), 0);
  } finally {
    await prisma.blueprint.deleteMany({ where: { organizationId: w.organizationId } }).catch(() => undefined);
    await prisma.organization.delete({ where: { id: w.organizationId } }).catch(() => undefined);
    await prisma.$disconnect();
  }
});

test('a PRIVATE situation is promoted by its owner only: a PRINCIPAL origin sharing what they confirm, WORK_LINKED written without an organization Case read; the OWNER and a coworker cannot preview or promote it', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  const w = await world(prisma, 'private');
  const [owner, matt, lexi] = w.users;
  try {
    const opened = await new SituationRepository(prisma).record({ scope: 'PRINCIPAL', organizationId: w.organizationId, userId: matt! }, {
      decision: 'NEW', caseId: null, title: 'Premier renewal and the October cap', narrative: 'Your chats and your work name Premier in the same week.', severity: 'HIGH', at: NOW,
      record: { schema: SITUATION_RECORD_SCHEMA, clusterKey: 'sc_p', fingerprint: 'situation:p', narrative: 'n', refs: ['work_instance:w1'], citations: ['digest:a/b'], domains: ['CHATS', 'WORK'], claims: [], limitations: [], verification: { state: 'UNAVAILABLE', providerId: null }, synthesis: { invocationId: 'i', providerId: 'anthropic', taskId: 'situation.synthesis.private', taskVersion: '1.0.0' }, windowStart: NOW.toISOString(), windowEnd: NOW.toISOString() },
    });
    assert.equal(opened.outcome, 'OPENED');
    const caseId = (opened as { caseId: string }).caseId;
    const origin = { kind: 'CASE', caseId } as const;
    const service = new PromoteToWorkService(prisma, { now: () => NOW });
    // Nobody else: not the OWNER with every authority, not a coworker.
    const admin = actorOf(w.organizationId, owner!, { mayAssignOthers: true, mayReadCases: true, mayReadOrganizationDomain: () => true });
    for (const other of [admin, actorOf(w.organizationId, lexi!, { mayReadCases: true })]) {
      assert.deepEqual(await service.preview(other, origin), { outcome: 'REFUSED', refusal: 'NOT_FOUND' });
      assert.deepEqual(await service.promote(other, origin, { title: 't', outcome: 'o', workTypeId: w.workTypeId, assigneeUserId: other.userId, targetAt: null, fingerprint: 'promote:x', confirmed: true, submissionNonce: 'nonce_somebody_else_01' }), { outcome: 'REFUSED', refusal: 'NOT_FOUND' });
    }
    // The owner -- who need not hold the Cases authority for their own situation.
    const mattActor = actorOf(w.organizationId, matt!);
    const preview = await service.preview(mattActor, origin);
    assert.equal(preview.outcome, 'READY');
    if (preview.outcome !== 'READY') return;
    assert.equal(preview.proposal.originScope, 'PRINCIPAL', 'private until confirmed');
    assert.equal(preview.proposal.originLabel, 'Your situation');
    const confirm = { title: 'Settle the Premier renewal', outcome: 'Premier renewed', workTypeId: w.workTypeId, assigneeUserId: matt!, targetAt: null, fingerprint: preview.proposal.fingerprint, confirmed: true, submissionNonce: preview.proposal.submissionNonce };
    const promoted = await service.promote(mattActor, origin, confirm);
    assert.equal(promoted.outcome, 'PROMOTED');
    if (promoted.outcome !== 'PROMOTED') return;
    const work = await prisma.workInstance.findFirst({ where: { id: promoted.workInstanceId }, include: { origins: true } });
    assert.equal(work!.title, 'Settle the Premier renewal', 'only what the person confirmed is the work');
    assert.equal(JSON.stringify(work).includes('same week'), false, 'the situation narrative is not shared unless confirmed');
    const o = work!.origins[0]!;
    assert.deepEqual([o.originKind, o.originScope, o.originUserId, o.promotedByUserId, o.originRef], ['CASE', 'PRINCIPAL', matt, matt, caseId]);
    // WORK_LINKED on the private situation's own log.
    const log = await prisma.operationalObservation.findMany({ where: { organizationId: w.organizationId, priorityId: caseId } });
    assert.ok(log.some((x) => x.observationType === 'WORK_LINKED' && x.actorUserId === matt));
    // Still private: no organization Case path sees it, even after the link.
    assert.equal(await new OperationalPriorityRepository(prisma).findById(w.organizationId, caseId), null);
    // A retried submission is idempotent.
    assert.deepEqual(await service.promote(mattActor, origin, confirm), promoted);
    // Another organization cannot reach it at all.
    const other = await world(prisma, 'private_other');
    try {
      assert.deepEqual(await service.preview(actorOf(other.organizationId, other.users[0]!, { mayReadCases: true }), origin), { outcome: 'REFUSED', refusal: 'NOT_FOUND' });
    } finally {
      await prisma.blueprint.deleteMany({ where: { organizationId: other.organizationId } }).catch(() => undefined);
      await prisma.organization.delete({ where: { id: other.organizationId } }).catch(() => undefined);
    }
  } finally {
    await prisma.workInstance.deleteMany({ where: { organizationId: w.organizationId } }).catch(() => undefined);
    await prisma.operationalObservation.deleteMany({ where: { organizationId: w.organizationId } }).catch(() => undefined);
    await prisma.operationalPriority.deleteMany({ where: { organizationId: w.organizationId } }).catch(() => undefined);
    await prisma.blueprint.deleteMany({ where: { organizationId: w.organizationId } }).catch(() => undefined);
    await prisma.organization.delete({ where: { id: w.organizationId } }).catch(() => undefined);
    await prisma.$disconnect();
  }
});
