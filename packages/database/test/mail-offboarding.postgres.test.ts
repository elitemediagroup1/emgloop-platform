// What happens to an employee's Gmail state when the relationship ends, against a REAL Postgres.
//
// OPT-IN AND LOCAL ONLY (LOOP_TEST_POSTGRES_URL, localhost). See google-connection.postgres.test.ts
// for how to run it.
//
// WHAT IT PROVES, THAT THE IN-MEMORY DOUBLE CANNOT: the DATABASE removes an employee's mail state
// when their membership ends -- threads, messages, correspondents, drafts, items, observations,
// cursors and runs -- because every one of those tables is keyed to the membership with ON DELETE
// CASCADE. Offboarding does not depend on anybody remembering to write a cleanup job.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

const URL = process.env.LOOP_TEST_POSTGRES_URL ?? '';
const LOCAL = /^postgres(ql)?:\/\/[^@]*@(localhost|127\.0\.0\.1)(:\d+)?\//.test(URL);
const skip = !URL ? 'LOOP_TEST_POSTGRES_URL is not set' : !LOCAL ? 'refusing a non-local database' : false;
const NOW = new Date('2026-09-18T12:00:00Z');

test('ending a membership takes every trace of that employee’s mail with it', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  const organizationId = `org_mail_${randomUUID()}`;
  try {
    await prisma.organization.create({ data: { id: organizationId, name: 'Mail offboarding', slug: organizationId } });
    const userId = `user_mail_${randomUUID()}`;
    await prisma.user.create({ data: { id: userId, organizationId, email: `${userId}@example.test`, name: 'Leaver', status: 'ACTIVE', metadata: { systemRole: 'EMPLOYEE' } } });
    await prisma.organizationMembership.create({ data: { organizationId, userId, systemRole: 'EMPLOYEE', status: 'ACTIVE' } });

    const scope = { organizationId, userId };
    await prisma.workCorrespondent.create({ data: { ...scope, addressHash: randomBytes(32).toString('hex'), displayAddress: 'ben@cashion.example', firstSeenAt: NOW, lastSeenAt: NOW } });
    await prisma.workThread.create({ data: { ...scope, provider: 'GOOGLE', threadId: 't1', subject: 'Cashion pricing', messageCount: 1, lastMessageAt: NOW } });
    await prisma.workMessage.create({ data: { ...scope, provider: 'GOOGLE', messageId: 'm1', threadId: 't1', internalDate: NOW, direction: 'INBOUND', observedAt: NOW } });
    await prisma.workDraft.create({ data: { ...scope, provider: 'GOOGLE', threadId: 't1', inReplyToMessageId: 'm1', mode: 'REPLY', body: 'half-written reply', toAddresses: ['ben@cashion.example'] } });
    await prisma.workSourceCursor.create({ data: { ...scope, source: 'GMAIL', cursorKind: 'GMAIL_HISTORY_ID', cursor: '9001', lastSyncCompletedAt: NOW } });
    await prisma.workSyncRun.create({ data: { ...scope, source: 'GMAIL', startedAt: NOW, finishedAt: NOW, outcome: 'SUCCEEDED' } });
    const item = await prisma.workItem.create({
      data: { ...scope, recurrenceKey: 'gmail:thread:t1:NEEDS_YOU', class: 'NEEDS_YOU', subjectKind: 'THREAD', subjectRef: 't1', producerKind: 'RULE', producerId: 'mail-attention', producerVersion: '1.0.0', firstDetectedAt: NOW, lastDetectedAt: NOW },
    });
    await prisma.workItemObservation.create({ data: { ...scope, itemId: item.id, sequence: 1, observationType: 'DETECTED', occurredAt: NOW, actorType: 'SYSTEM' } });
    await prisma.workFeedback.create({ data: { ...scope, kind: 'NOT_WAITING', subjectKind: 'THREAD', subjectRef: 't1', createdByUserId: userId } });

    const counts = async () => ({
      correspondents: await prisma.workCorrespondent.count({ where: scope }),
      threads: await prisma.workThread.count({ where: scope }),
      messages: await prisma.workMessage.count({ where: scope }),
      drafts: await prisma.workDraft.count({ where: scope }),
      cursors: await prisma.workSourceCursor.count({ where: scope }),
      runs: await prisma.workSyncRun.count({ where: scope }),
      items: await prisma.workItem.count({ where: scope }),
      observations: await prisma.workItemObservation.count({ where: scope }),
      feedback: await prisma.workFeedback.count({ where: scope }),
    });
    assert.deepEqual(await counts(), { correspondents: 1, threads: 1, messages: 1, drafts: 1, cursors: 1, runs: 1, items: 1, observations: 1, feedback: 1 });

    // The membership ends -- the one act that means "this person no longer works here".
    await prisma.organizationMembership.delete({ where: { userId_organizationId: { userId, organizationId } } });

    assert.deepEqual(await counts(), { correspondents: 0, threads: 0, messages: 0, drafts: 0, cursors: 0, runs: 0, items: 0, observations: 0, feedback: 0 },
      'no half-written reply, no thread, no attention item and no sync state survives the membership');
  } finally {
    await prisma.organization.delete({ where: { id: organizationId } }).catch(() => undefined);
    await prisma.$disconnect();
  }
});
