// Content-free observations against a REAL Postgres: idempotent append, employee-private reads,
// governed retention purge, and offboarding cascade. Local only (LOOP_TEST_POSTGRES_URL).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

import { SourceObservationRepository } from '../src/repositories/source-observation.repository';
import type { ConversationEvent } from '@emgloop/shared';

const URL = process.env.LOOP_TEST_POSTGRES_URL ?? '';
const LOCAL = /^postgres(ql)?:\/\/[^@]*@(localhost|127\.0\.0\.1)(:\d+)?\//.test(URL);
const skip = !URL ? 'LOOP_TEST_POSTGRES_URL is not set' : !LOCAL ? 'refusing a non-local database' : false;

async function tenant(prisma: PrismaClient, label: string) {
  const organizationId = `org_obs_${label}_${randomUUID()}`;
  await prisma.organization.create({ data: { id: organizationId, name: `OBS ${label}`, slug: organizationId } });
  const userId = `user_obs_${label}_${randomUUID()}`;
  await prisma.user.create({ data: { id: userId, organizationId, email: `${userId}@example.test`, name: 'OBS', status: 'ACTIVE', metadata: { systemRole: 'EMPLOYEE' } } });
  await prisma.organizationMembership.create({ data: { organizationId, userId, systemRole: 'EMPLOYEE', status: 'ACTIVE', effectiveFrom: new Date('2026-01-01T00:00:00Z') } });
  return { organizationId, userId };
}

const evt = (id: string, observedAt = '2026-09-20T12:00:00Z'): ConversationEvent => ({
  provider: 'TELEGRAM', conversationKey: 'ck', providerEventId: `ck:${id}`, participantKeys: ['pk1', 'pk2'],
  senderKey: 'pk2', direction: 'INBOUND', occurredAt: '2026-09-20T11:59:00Z', observedAt, hadText: true, cursor: null,
});

test('append is idempotent; reads are employee-private; nothing raw is stored', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  const repo = new SourceObservationRepository(prisma);
  try {
    const { organizationId, userId } = await tenant(prisma, 'append');
    const first = await repo.append(organizationId, userId, 'TELEGRAM', [evt('10'), evt('11')]);
    assert.equal(first.inserted, 2);
    // Re-appending the same events + one new: only the new one is inserted (idempotent).
    const second = await repo.append(organizationId, userId, 'TELEGRAM', [evt('10'), evt('11'), evt('12')]);
    assert.equal(second.inserted, 1);
    assert.equal(await prisma.sourceObservation.count({ where: { organizationId, userId, provider: 'TELEGRAM' } }), 3);

    // Another person in the same org sees none of it (employee-private).
    const other = await tenant(prisma, 'append');
    assert.equal(await prisma.sourceObservation.count({ where: { organizationId: other.organizationId, userId: other.userId, provider: 'TELEGRAM' } }), 0);

    const rows = await repo.recent(organizationId, userId, 'TELEGRAM', 10);
    assert.equal(rows.length, 3);
    // The stored columns are metadata only -- no content field exists.
    assert.equal((rows[0] as Record<string, unknown>).message, undefined);
    assert.equal((rows[0] as Record<string, unknown>).text, undefined);
    assert.equal(rows[0]!.hadText, true);
  } finally {
    await prisma.$disconnect();
  }
});

test('activitySince counts one person\'s messages and conversations since a moment -- content-free, employee-private', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  const repo = new SourceObservationRepository(prisma);
  try {
    const { organizationId, userId } = await tenant(prisma, 'activity');
    const at = (iso: string, key: string, id: string): ConversationEvent => ({ ...evt(id, iso), conversationKey: key, providerEventId: `${key}:${id}`, occurredAt: iso });
    await repo.append(organizationId, userId, 'TELEGRAM', [
      at('2026-09-24T09:00:00Z', 'ck-a', '1'),
      at('2026-09-24T10:00:00Z', 'ck-a', '2'),
      at('2026-09-24T11:00:00Z', 'ck-b', '3'),
      at('2026-09-22T11:00:00Z', 'ck-c', '4'), // before the window
    ]);
    // A colleague's activity in the same organization is never counted into this person's summary.
    const other = await tenant(prisma, 'activity');
    await repo.append(other.organizationId, other.userId, 'TELEGRAM', [at('2026-09-24T10:30:00Z', 'ck-z', '9')]);

    const since = new Date('2026-09-23T12:00:00Z');
    assert.deepEqual(await repo.activitySince(organizationId, userId, 'TELEGRAM', since), { messages: 3, conversations: 2 });
    assert.deepEqual(await repo.activitySince(organizationId, userId, 'TELEGRAM', new Date('2026-09-25T00:00:00Z')), { messages: 0, conversations: 0 });
    assert.deepEqual(await repo.activitySince(organizationId, userId, 'TEAMS', since), { messages: 0, conversations: 0 });
  } finally {
    await prisma.$disconnect();
  }
});

test('purgeOlderThan enforces a retention horizon across tenants', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  const repo = new SourceObservationRepository(prisma);
  try {
    const { organizationId, userId } = await tenant(prisma, 'purge');
    await repo.append(organizationId, userId, 'TELEGRAM', [evt('1', '2026-08-01T00:00:00Z'), evt('2', '2026-09-19T00:00:00Z')]);
    const { purged } = await repo.purgeOlderThan(new Date('2026-09-01T00:00:00Z'));
    assert.ok(purged >= 1);
    const remaining = await repo.recent(organizationId, userId, 'TELEGRAM', 10);
    assert.equal(remaining.length, 1); // the August one is gone, the September one stays
    assert.equal(remaining[0]!.providerEventId, 'ck:2');
  } finally {
    await prisma.$disconnect();
  }
});

test('offboarding (deleting the membership) cascades observations away', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  const repo = new SourceObservationRepository(prisma);
  try {
    const { organizationId, userId } = await tenant(prisma, 'offboard');
    await repo.append(organizationId, userId, 'TELEGRAM', [evt('5')]);
    assert.equal(await prisma.sourceObservation.count({ where: { organizationId, userId, provider: 'TELEGRAM' } }), 1);
    await prisma.organizationMembership.delete({ where: { userId_organizationId: { userId, organizationId } } });
    assert.equal(await prisma.sourceObservation.count({ where: { organizationId, userId } }), 0);
  } finally {
    await prisma.$disconnect();
  }
});
