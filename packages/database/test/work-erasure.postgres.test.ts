// When a membership ends, the person's private work state goes with it -- through the REAL
// offboarding path, against a REAL Postgres.
//
// OPT-IN AND LOCAL ONLY (LOOP_TEST_POSTGRES_URL, localhost). See google-connection.postgres.test.ts
// for how to run it.
//
// WHY THIS TEST EXISTS. Ending a membership is SOFT: `removeMember` and `disableMember` keep the
// membership row (it carries the removal marker), so the ON DELETE CASCADE that
// mail-offboarding.postgres.test.ts proves never fires on the path the product actually uses.
// Policy (daily-loop-employee-intelligence.md §21.2, §21.3 row 11): the work rows are deleted
// immediately. This proves the product path does it, leaves colleagues alone, keeps the
// organization's own policy and the membership row, and records the act with counts only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

import { IamRepository, WORK_STATE_ERASED_AUDIT_ACTION } from '../src/repositories/iam.repository';

const URL = process.env.LOOP_TEST_POSTGRES_URL ?? '';
const LOCAL = /^postgres(ql)?:\/\/[^@]*@(localhost|127\.0\.0\.1)(:\d+)?\//.test(URL);
const skip = !URL ? 'LOOP_TEST_POSTGRES_URL is not set' : !LOCAL ? 'refusing a non-local database' : false;
const NOW = new Date('2026-09-19T12:00:00Z');

async function seedEmployee(prisma: PrismaClient, organizationId: string, label: string) {
  const userId = `user_${label}_${randomUUID()}`;
  await prisma.user.create({ data: { id: userId, organizationId, email: `${userId}@example.test`, name: label, status: 'ACTIVE', metadata: { systemRole: 'EMPLOYEE', passwordHash: 'kept' } } });
  await prisma.organizationMembership.create({ data: { organizationId, userId, systemRole: 'EMPLOYEE', status: 'ACTIVE' } });
  const scope = { organizationId, userId };
  await prisma.workCorrespondent.create({ data: { ...scope, addressHash: randomBytes(32).toString('hex'), displayAddress: 'ben@cashion.example', firstSeenAt: NOW, lastSeenAt: NOW } });
  await prisma.workThread.create({ data: { ...scope, provider: 'GOOGLE', threadId: 't1', subject: 'Cashion pricing', messageCount: 1, lastMessageAt: NOW } });
  await prisma.workMessage.create({ data: { ...scope, provider: 'GOOGLE', messageId: 'm1', threadId: 't1', internalDate: NOW, direction: 'INBOUND', observedAt: NOW } });
  await prisma.workDraft.create({ data: { ...scope, provider: 'GOOGLE', threadId: 't1', inReplyToMessageId: 'm1', mode: 'REPLY', body: 'half-written reply', toAddresses: ['ben@cashion.example'] } });
  await prisma.workEvent.create({ data: { ...scope, provider: 'GOOGLE', eventId: 'e1', status: 'CONFIRMED', observedAt: NOW } });
  await prisma.workSourceCursor.create({ data: { ...scope, source: 'GMAIL', cursorKind: 'GMAIL_HISTORY_ID', cursor: '9001', lastSyncCompletedAt: NOW } });
  await prisma.workSyncRun.create({ data: { ...scope, source: 'GMAIL', startedAt: NOW, finishedAt: NOW, outcome: 'SUCCEEDED' } });
  const item = await prisma.workItem.create({
    data: { ...scope, recurrenceKey: 'mail:thread:t1:NEEDS_YOU', class: 'NEEDS_YOU', subjectKind: 'THREAD', subjectRef: 't1', producerKind: 'RULE', producerId: 'mail-attention', producerVersion: '1.0.0', firstDetectedAt: NOW, lastDetectedAt: NOW },
  });
  await prisma.workItemObservation.create({ data: { ...scope, itemId: item.id, sequence: 1, observationType: 'DETECTED', occurredAt: NOW, actorType: 'SYSTEM' } });
  await prisma.workFeedback.create({ data: { ...scope, kind: 'NOT_WAITING', subjectKind: 'THREAD', subjectRef: 't1', createdByUserId: userId } });
  await prisma.employeeWorkPreferences.create({ data: { ...scope, timeZone: 'America/New_York' } });
  return userId;
}

const TABLES = ['workCorrespondent', 'workThread', 'workMessage', 'workDraft', 'workEvent', 'workSourceCursor', 'workSyncRun', 'workItem', 'workItemObservation', 'workFeedback', 'employeeWorkPreferences'] as const;
async function rowsOf(prisma: PrismaClient, organizationId: string, userId: string) {
  const out: Record<string, number> = {};
  for (const t of TABLES) out[t] = await (prisma[t] as unknown as { count(a: unknown): Promise<number> }).count({ where: { organizationId, userId } });
  return out;
}
const ALL = (n: number) => Object.fromEntries(TABLES.map((t) => [t, n]));

for (const act of ['removeMember', 'disableMember'] as const) {
  test(`${act}: the person's work state is deleted; a colleague's, the policy and the membership row stay`, { skip }, async () => {
    const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
    const organizationId = `org_erase_${randomUUID()}`;
    try {
      await prisma.organization.create({ data: { id: organizationId, name: 'Erasure', slug: organizationId } });
      const admin = `user_admin_${randomUUID()}`;
      await prisma.user.create({ data: { id: admin, organizationId, email: `${admin}@example.test`, name: 'Admin', status: 'ACTIVE', metadata: { systemRole: 'ADMIN' } } });
      await prisma.organizationMembership.create({ data: { organizationId, userId: admin, systemRole: 'ADMIN', status: 'ACTIVE' } });
      const leaver = await seedEmployee(prisma, organizationId, 'leaver');
      const colleague = await seedEmployee(prisma, organizationId, 'colleague');
      await prisma.workRetentionOverride.create({ data: { organizationId, category: 'GMAIL_METADATA', days: 14, policyVersion: 'work-retention.2026-09-17.1', setByUserId: admin } });
      assert.deepEqual(await rowsOf(prisma, organizationId, leaver), ALL(1));

      const result = await new IamRepository(prisma)[act](organizationId, leaver, { userId: admin });
      assert.equal(result.changed, true);

      assert.deepEqual(await rowsOf(prisma, organizationId, leaver), ALL(0), 'nothing Loop derived from their work survives');
      assert.deepEqual(await rowsOf(prisma, organizationId, colleague), ALL(1), 'a colleague is untouched');
      assert.equal(await prisma.workRetentionOverride.count({ where: { organizationId } }), 1, 'the organization policy is not a person\'s data');
      const membership = await prisma.organizationMembership.findUnique({ where: { userId_organizationId: { userId: leaver, organizationId } } });
      assert.ok(membership, 'the membership row stays, carrying its standing');
      const user = await prisma.user.findUnique({ where: { id: leaver } });
      assert.equal((user!.metadata as Record<string, unknown>).passwordHash, 'kept', 'the metadata bag is merged, never replaced');

      const audit = await prisma.auditLog.findMany({ where: { organizationId, action: WORK_STATE_ERASED_AUDIT_ACTION } });
      assert.equal(audit.length, 1, 'the delete is recorded as an act');
      const metadata = audit[0]!.metadata as Record<string, unknown>;
      assert.equal(metadata.subjectUserId, leaver);
      assert.equal(metadata.reason, act === 'removeMember' ? 'MEMBER_REMOVED' : 'MEMBER_DISABLED');
      const erased = metadata.erased as Record<string, number>;
      assert.equal(erased.work_threads, 1);
      assert.equal(erased.work_drafts, 1);
      assert.equal(JSON.stringify(audit[0]).includes('Cashion'), false, 'counts only: no subject, address or body in the record');
      assert.equal(JSON.stringify(audit[0]).includes('half-written'), false);

      // Ending it again deletes nothing and records nothing.
      await new IamRepository(prisma).removeMember(organizationId, leaver, { userId: admin });
      assert.equal(await prisma.auditLog.count({ where: { organizationId, action: WORK_STATE_ERASED_AUDIT_ACTION } }), 1, 'no audit row for a delete that did not happen');
    } finally {
      await prisma.organization.delete({ where: { id: organizationId } }).catch(() => undefined);
      await prisma.$disconnect();
    }
  });
}
