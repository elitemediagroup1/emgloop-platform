// Daily Loop work state against a REAL Postgres.
//
// OPT-IN AND LOCAL ONLY. Runs only when LOOP_TEST_POSTGRES_URL is set, and refuses any URL
// whose host is not localhost or 127.0.0.1 -- it creates rows and must never be pointed at a
// shared or production database. Run it against a disposable container with the migrations
// applied:
//
//   docker run -d --name loop-pg -e POSTGRES_PASSWORD=verify -p 127.0.0.1:55432:5432 postgres:18
//   DATABASE_URL=postgresql://postgres:verify@127.0.0.1:55432/postgres npx prisma migrate deploy
//   LOOP_TEST_POSTGRES_URL=postgresql://postgres:verify@127.0.0.1:55432/postgres \
//     npx tsx --test test/work-state.postgres.test.ts
//
// WHAT IT PROVES, THAT THE IN-MEMORY DOUBLE CANNOT.
//   - The database itself refuses a class, a state, an outcome, an actor or a retention
//     category the contract does not know -- and a raw address written into a hash column --
//     even when the repository is bypassed entirely.
//   - There is no body column to write to: the attempt fails at the database.
//   - Work state belongs to a MEMBERSHIP: ending the membership takes every row with it,
//     which is what offboarding depends on.
//   - The provider keys are per person, so the same Gmail thread read for two employees is
//     two rows, and one employee's row is never the other's.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

const URL = process.env.LOOP_TEST_POSTGRES_URL ?? '';
const LOCAL = /^postgres(ql)?:\/\/[^@]*@(localhost|127\.0\.0\.1)(:\d+)?\//.test(URL);
const skip = !URL ? 'LOOP_TEST_POSTGRES_URL is not set' : !LOCAL ? 'refusing a non-local database' : false;

const NOW = new Date('2026-09-17T12:00:00Z');
const hash = (v: string) => createHash('sha256').update(v).digest('hex');

async function tenant(prisma: PrismaClient, label: string, people = 2) {
  const organizationId = `org_w_${label}_${randomUUID()}`;
  await prisma.organization.create({ data: { id: organizationId, name: `W ${label}`, slug: organizationId } });
  const users: string[] = [];
  for (let i = 0; i < people; i += 1) {
    const userId = `user_w_${label}_${i}_${randomUUID()}`;
    await prisma.user.create({ data: { id: userId, organizationId, email: `${userId}@example.test`, name: 'W test', status: 'ACTIVE', metadata: { systemRole: 'EMPLOYEE' } } });
    await prisma.organizationMembership.create({ data: { organizationId, userId, systemRole: 'EMPLOYEE', status: 'ACTIVE' } });
    users.push(userId);
  }
  return { organizationId, users };
}

async function refused(promise: Promise<unknown>, what: string) {
  await assert.rejects(promise, (err: any) => {
    const text = `${err?.code ?? ''} ${err?.meta?.code ?? ''} ${err?.message ?? ''}`;
    assert.ok(/P2010|P2002|P2003|23514|23503|23505|check constraint|violates/i.test(text), `${what}: got ${text.slice(0, 160)}`);
    return true;
  }, what);
}

test('the database refuses what the contract forbids, even without the repository', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  let organizationId = '';
  try {
    const t = await tenant(prisma, 'checks', 1);
    organizationId = t.organizationId;
    const userId = t.users[0]!;
    const scope = { organizationId, userId };

    // A class, a state and an outcome the contract does not know.
    await refused(
      prisma.workItem.create({ data: { ...scope, recurrenceKey: 'k1', class: 'OPPORTUNITY', subjectKind: 'THREAD', subjectRef: 't', producerKind: 'RULE', producerId: 'r', producerVersion: 'v1', firstDetectedAt: NOW, lastDetectedAt: NOW } }),
      'a class metadata cannot establish',
    );
    await refused(
      prisma.workItem.create({ data: { ...scope, recurrenceKey: 'k2', class: 'NEEDS_YOU', subjectKind: 'THREAD', subjectRef: 't', producerKind: 'GUESS', producerId: 'r', producerVersion: 'v1', firstDetectedAt: NOW, lastDetectedAt: NOW } }),
      'an unknown producer kind',
    );
    await refused(
      prisma.workItem.create({ data: { ...scope, recurrenceKey: 'k3', class: 'NEEDS_YOU', subjectKind: 'THREAD', subjectRef: 't', producerKind: 'RULE', producerId: 'r', producerVersion: 'v1', firstDetectedAt: NOW, lastDetectedAt: NOW, state: 'RESOLVED' } }),
      'closed without a resolvedAt and an outcome',
    );
    await refused(
      prisma.workItem.create({ data: { ...scope, recurrenceKey: 'k4', class: 'NEEDS_YOU', subjectKind: 'THREAD', subjectRef: 't', producerKind: 'RULE', producerId: 'r', producerVersion: 'v1', firstDetectedAt: NOW, lastDetectedAt: NOW, state: 'OPEN', resolvedAt: NOW, outcome: 'HANDLED' } }),
      'an open item carrying an outcome',
    );

    // A quote longer than the cap, and a quote with no message behind it.
    await refused(
      prisma.workItem.create({ data: { ...scope, recurrenceKey: 'k5', class: 'NEEDS_YOU', subjectKind: 'THREAD', subjectRef: 't', producerKind: 'RULE', producerId: 'r', producerVersion: 'v1', firstDetectedAt: NOW, lastDetectedAt: NOW, evidenceQuote: 'x'.repeat(241), evidenceQuoteRef: 'm1' } }),
      'a quote past the cap',
    );
    await refused(
      prisma.workItem.create({ data: { ...scope, recurrenceKey: 'k6', class: 'NEEDS_YOU', subjectKind: 'THREAD', subjectRef: 't', producerKind: 'RULE', producerId: 'r', producerVersion: 'v1', firstDetectedAt: NOW, lastDetectedAt: NOW, evidenceQuote: 'short' } }),
      'a quote with no source',
    );

    // A raw address may never be written into a hash column.
    await refused(
      prisma.workCorrespondent.create({ data: { ...scope, addressHash: 'ben@cashionrods.com', displayAddress: 'ben@cashionrods.com', firstSeenAt: NOW, lastSeenAt: NOW } }),
      'a raw address in the hash column',
    );

    // A class without the rule version that set it, and an unknown direction.
    await refused(
      prisma.workThread.create({ data: { ...scope, provider: 'GOOGLE', threadId: 'th1', derivedClass: 'NEEDS_YOU' } }),
      'a class with no rule version',
    );
    await refused(
      prisma.workMessage.create({ data: { ...scope, provider: 'GOOGLE', messageId: 'm1', threadId: 'th1', internalDate: NOW, direction: 'SIDEWAYS' } }),
      'an unknown direction',
    );

    // A human act must name the human; a system act may not claim one.
    const item = await prisma.workItem.create({ data: { ...scope, recurrenceKey: 'ok', class: 'NEEDS_YOU', subjectKind: 'THREAD', subjectRef: 't', producerKind: 'RULE', producerId: 'r', producerVersion: 'v1', firstDetectedAt: NOW, lastDetectedAt: NOW } });
    await refused(
      prisma.workItemObservation.create({ data: { ...scope, itemId: item.id, sequence: 1, observationType: 'RESOLVED', occurredAt: NOW, actorType: 'HUMAN' } }),
      'a human act with no human',
    );
    await refused(
      prisma.workItemObservation.create({ data: { ...scope, itemId: item.id, sequence: 2, observationType: 'DETECTED', occurredAt: NOW, actorType: 'SYSTEM', actorUserId: userId } }),
      'a system act claiming a person',
    );

    // A brief whose window ends before it starts, and a retention override on a category
    // that is not a duration.
    await refused(
      prisma.workBrief.create({ data: { ...scope, localDate: new Date('2026-09-17'), windowStart: NOW, windowEnd: new Date('2026-09-17T11:00:00Z'), generatorVersion: 'v1' } }),
      'a window that ends before it starts',
    );
    await refused(
      prisma.workRetentionOverride.create({ data: { organizationId, category: 'SECURITY_AUDIT', days: 30, policyVersion: 'work-retention.2026-09-17.1' } }),
      'an override on a category that is not a duration',
    );

    // There is no body column: the attempt does not compile away, it fails at the database.
    await refused(
      prisma.$executeRawUnsafe(`INSERT INTO "work_messages" ("id","organizationId","userId","provider","messageId","threadId","internalDate","direction","body") VALUES ('x',$1,$2,'GOOGLE','m','t',now(),'INBOUND','hello')`, organizationId, userId),
      'a message body',
    );
  } finally {
    if (organizationId) await prisma.organization.deleteMany({ where: { id: organizationId } });
    await prisma.$disconnect();
  }
});

test('work state belongs to a membership: ending it takes every row, and two people never share one', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  let organizationId = '';
  try {
    const t = await tenant(prisma, 'cascade', 2);
    organizationId = t.organizationId;
    const [alice, bob] = t.users as [string, string];

    // The SAME Gmail thread, read for two people, is two rows -- the provider key is per person.
    for (const userId of [alice, bob]) {
      const scope = { organizationId, userId };
      await prisma.workThread.create({ data: { ...scope, provider: 'GOOGLE', threadId: 'shared-thread', subject: 'Pricing' } });
      await prisma.workMessage.create({ data: { ...scope, provider: 'GOOGLE', messageId: 'shared-message', threadId: 'shared-thread', internalDate: NOW, direction: 'INBOUND' } });
      await prisma.workCorrespondent.create({ data: { ...scope, addressHash: hash('ben@cashionrods.com'), displayAddress: 'ben@cashionrods.com', firstSeenAt: NOW, lastSeenAt: NOW } });
      await prisma.workSourceCursor.create({ data: { ...scope, source: 'GMAIL', cursor: '1', cursorKind: 'GMAIL_HISTORY_ID' } });
      await prisma.employeeWorkPreferences.create({ data: { ...scope, timeZone: 'UTC' } });
    }
    assert.equal(await prisma.workThread.count({ where: { organizationId } }), 2, 'one thread row per person');
    // And the per-person unique key holds: the same person cannot hold it twice.
    await refused(
      prisma.workThread.create({ data: { organizationId, userId: alice, provider: 'GOOGLE', threadId: 'shared-thread' } }),
      'the same thread twice for one person',
    );

    // A row cannot be filed under a membership that does not exist.
    await refused(
      prisma.workThread.create({ data: { organizationId, userId: `ghost_${randomUUID()}`, provider: 'GOOGLE', threadId: 'th' } }),
      'work state with no membership behind it',
    );

    // Offboarding: the membership goes, and every row of that person's work state goes with it.
    await prisma.organizationMembership.delete({ where: { userId_organizationId: { userId: alice, organizationId } } });
    assert.equal(await prisma.workThread.count({ where: { organizationId, userId: alice } }), 0);
    assert.equal(await prisma.workMessage.count({ where: { organizationId, userId: alice } }), 0);
    assert.equal(await prisma.workCorrespondent.count({ where: { organizationId, userId: alice } }), 0);
    assert.equal(await prisma.workSourceCursor.count({ where: { organizationId, userId: alice } }), 0);
    assert.equal(await prisma.employeeWorkPreferences.count({ where: { organizationId, userId: alice } }), 0);
    // And the colleague's work state is untouched.
    assert.equal(await prisma.workThread.count({ where: { organizationId, userId: bob } }), 1);
    assert.equal(await prisma.workMessage.count({ where: { organizationId, userId: bob } }), 1);
  } finally {
    if (organizationId) await prisma.organization.deleteMany({ where: { id: organizationId } });
    await prisma.$disconnect();
  }
});
