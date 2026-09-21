// Governed historical baseline checkpoints against a REAL Postgres. Local only (LOOP_TEST_POSTGRES_URL).
//
// WHAT IT PROVES, THAT AN IN-MEMORY DOUBLE CANNOT
//   - authorize/changeScope/revoke write the checkpoint and an audit trail; the window is validated
//     against the closed allowlist; a baseline never precedes a connection (NO_CONNECTION).
//   - dueForBaseline is routing-only and excludes REVOKED, COMPLETE and backed-off checkpoints.
//   - THE LOAD-BEARING GUARANTEE: recordBaselineProgress advances ONLY the checkpoint and NEVER
//     touches source_connections -- the live observation cursor is byte-identical before and after.
//   - Employee-private isolation: another person's checkpoint is not found.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

import { SourceBaselineCheckpointRepository } from '../src/repositories/source-baseline.repository';

const URL = process.env.LOOP_TEST_POSTGRES_URL ?? '';
const LOCAL = /^postgres(ql)?:\/\/[^@]*@(localhost|127\.0\.0\.1)(:\d+)?\//.test(URL);
const skip = !URL ? 'LOOP_TEST_POSTGRES_URL is not set' : !LOCAL ? 'refusing a non-local database' : false;

const NOW = new Date('2026-09-20T12:00:00Z');
const CONNECTED_AT = new Date('2026-09-10T00:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const actor = (userId: string) => ({ userId });

async function tenant(prisma: PrismaClient, label: string, people = 1) {
  const organizationId = `org_bl_${label}_${randomUUID()}`;
  await prisma.organization.create({ data: { id: organizationId, name: `BL ${label}`, slug: organizationId } });
  const users: string[] = [];
  for (let i = 0; i < people; i += 1) {
    const userId = `user_bl_${label}_${i}_${randomUUID()}`;
    await prisma.user.create({ data: { id: userId, organizationId, email: `${userId}@example.test`, name: 'BL', status: 'ACTIVE', metadata: { systemRole: 'EMPLOYEE' } } });
    await prisma.organizationMembership.create({ data: { organizationId, userId, systemRole: 'EMPLOYEE', status: 'ACTIVE', effectiveFrom: new Date('2026-01-01T00:00:00Z') } });
    users.push(userId);
  }
  return { organizationId, users };
}

/** A live-ish Telegram connection with a NON-NULL live cursor, so cursor immutability is testable. */
async function connection(prisma: PrismaClient, organizationId: string, userId: string, cursor: string) {
  await prisma.sourceConnection.create({
    data: { organizationId, userId, provider: 'TELEGRAM', state: 'READY', connectedAt: CONNECTED_AT, cursor, backgroundObservation: 'OPERATIONAL' },
  });
}

test('authorize creates a NOT_STARTED checkpoint at the chosen depth, with an audit row', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  const repo = new SourceBaselineCheckpointRepository(prisma);
  try {
    const { organizationId, users: [alice] } = await tenant(prisma, 'auth');
    // No connection yet -> NO_CONNECTION, and nothing is written.
    assert.deepEqual(await repo.authorize(organizationId, alice, 'TELEGRAM', { windowDays: 90, now: NOW, actor: actor(alice) }), { outcome: 'NO_CONNECTION' });
    assert.equal(await repo.get(organizationId, alice, 'TELEGRAM'), null);

    await connection(prisma, organizationId, alice, 'LIVE-CURSOR-1');
    // An off-allowlist window is refused.
    assert.deepEqual(await repo.authorize(organizationId, alice, 'TELEGRAM', { windowDays: 45, now: NOW, actor: actor(alice) }), { outcome: 'INVALID_WINDOW' });

    const res = await repo.authorize(organizationId, alice, 'TELEGRAM', { windowDays: 90, now: NOW, actor: actor(alice) });
    assert.equal(res.outcome, 'AUTHORIZED');
    const cp = await repo.get(organizationId, alice, 'TELEGRAM');
    assert.equal(cp?.state, 'NOT_STARTED');
    assert.equal(cp?.windowDays, 90);
    // windowFloorAt = connectedAt - 90 days.
    assert.equal(cp?.windowFloorAt.getTime(), CONNECTED_AT.getTime() - 90 * DAY_MS);
    assert.equal(cp?.checkpointCursor, null);
    assert.equal(cp?.revokedAt, null);
    assert.equal(await prisma.auditLog.count({ where: { organizationId, entityType: 'source_connection', action: 'source_connection.baseline.authorized' } }), 1);
  } finally {
    await prisma.$disconnect();
  }
});

test('changeScope keeps the walk resumable; revoke stops it; both leave an audit trail', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  const repo = new SourceBaselineCheckpointRepository(prisma);
  try {
    const { organizationId, users: [alice] } = await tenant(prisma, 'scope');
    await connection(prisma, organizationId, alice, 'LIVE-CURSOR-2');
    await repo.authorize(organizationId, alice, 'TELEGRAM', { windowDays: 90, now: NOW, actor: actor(alice) });
    // Simulate a walk in progress with a cursor already advanced.
    await repo.recordBaselineProgress(organizationId, alice, 'TELEGRAM', { checkpointCursor: '500', oldestReachedAt: new Date('2026-08-01T00:00:00Z'), state: 'IN_PROGRESS', now: NOW });

    const changed = await repo.changeScope(organizationId, alice, 'TELEGRAM', { windowDays: 365, now: NOW, actor: actor(alice) });
    assert.equal(changed.outcome, 'SCOPE_CHANGED');
    let cp = await repo.get(organizationId, alice, 'TELEGRAM');
    assert.equal(cp?.windowDays, 365);
    assert.equal(cp?.windowFloorAt.getTime(), CONNECTED_AT.getTime() - 365 * DAY_MS);
    assert.equal(cp?.state, 'IN_PROGRESS'); // resumable: kept in progress
    assert.equal(cp?.checkpointCursor, '500'); // the cursor is preserved (deeper walk resumes from here)

    const revoked = await repo.revoke(organizationId, alice, 'TELEGRAM', { now: NOW, actor: actor(alice) });
    assert.equal(revoked.outcome, 'REVOKED');
    cp = await repo.get(organizationId, alice, 'TELEGRAM');
    assert.equal(cp?.state, 'REVOKED');
    assert.ok(cp?.revokedAt);
    // A second revoke is a no-op with no audit row for a revoke that did not happen.
    assert.deepEqual(await repo.revoke(organizationId, alice, 'TELEGRAM', { now: NOW, actor: actor(alice) }), { outcome: 'NOTHING_TO_DO' });

    assert.equal(await prisma.auditLog.count({ where: { organizationId, action: 'source_connection.baseline.scope_changed' } }), 1);
    assert.equal(await prisma.auditLog.count({ where: { organizationId, action: 'source_connection.baseline.revoked' } }), 1);
  } finally {
    await prisma.$disconnect();
  }
});

test('dueForBaseline is routing-only and excludes REVOKED, COMPLETE and backed-off checkpoints', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  const repo = new SourceBaselineCheckpointRepository(prisma);
  try {
    const t = await tenant(prisma, 'due', 4);
    const [a, b, c, d] = t.users as [string, string, string, string];
    for (const u of [a, b, c, d]) await connection(prisma, t.organizationId, u, `LIVE-${u}`);
    await repo.authorize(t.organizationId, a, 'TELEGRAM', { windowDays: 90, now: NOW, actor: actor(a) }); // NOT_STARTED -> due
    await repo.authorize(t.organizationId, b, 'TELEGRAM', { windowDays: 90, now: NOW, actor: actor(b) });
    await repo.recordBaselineProgress(t.organizationId, b, 'TELEGRAM', { checkpointCursor: '10', oldestReachedAt: null, state: 'COMPLETE', now: NOW }); // COMPLETE -> not due
    await repo.authorize(t.organizationId, c, 'TELEGRAM', { windowDays: 90, now: NOW, actor: actor(c) });
    await repo.revoke(t.organizationId, c, 'TELEGRAM', { now: NOW, actor: actor(c) }); // REVOKED -> not due
    await repo.authorize(t.organizationId, d, 'TELEGRAM', { windowDays: 90, now: NOW, actor: actor(d) });
    await repo.recordBaselineProgress(t.organizationId, d, 'TELEGRAM', { checkpointCursor: '20', oldestReachedAt: null, state: 'IN_PROGRESS', backoffUntil: new Date(Date.now() + 60 * 60 * 1000), now: NOW }); // backed off -> not due

    const dueRows = await repo.dueForBaseline(500);
    const forOrg = dueRows.filter((r) => r.organizationId === t.organizationId);
    assert.deepEqual(forOrg.map((r) => r.userId), [a]); // only the NOT_STARTED one
    // Routing fields ONLY: no state, no consent, no audit, no failure class.
    assert.deepEqual(Object.keys(forOrg[0]!).sort(), ['checkpointCursor', 'organizationId', 'provider', 'userId', 'windowFloorAt']);
  } finally {
    await prisma.$disconnect();
  }
});

test('recordBaselineProgress advances ONLY the checkpoint -- the live connection cursor is byte-identical', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  const repo = new SourceBaselineCheckpointRepository(prisma);
  try {
    const { organizationId, users: [alice] } = await tenant(prisma, 'cursor');
    const LIVE = 'LIVE-CURSOR-DO-NOT-MOVE';
    await connection(prisma, organizationId, alice, LIVE);
    await repo.authorize(organizationId, alice, 'TELEGRAM', { windowDays: 90, now: NOW, actor: actor(alice) });

    const before = await prisma.sourceConnection.findFirstOrThrow({ where: { organizationId, userId: alice, provider: 'TELEGRAM' } });
    // A full baseline run: advances the checkpoint, sets startedAt, records the oldest reached.
    const ok = await repo.recordBaselineProgress(organizationId, alice, 'TELEGRAM', { checkpointCursor: '123', oldestReachedAt: new Date('2026-07-01T00:00:00Z'), state: 'IN_PROGRESS', now: NOW });
    assert.equal(ok, true);
    const cp = await repo.get(organizationId, alice, 'TELEGRAM');
    assert.equal(cp?.checkpointCursor, '123');
    assert.ok(cp?.startedAt);

    const after = await prisma.sourceConnection.findFirstOrThrow({ where: { organizationId, userId: alice, provider: 'TELEGRAM' } });
    // THE GUARANTEE: the live observation cursor did not move, and neither did lastObservedAt/state.
    assert.equal(after.cursor, LIVE);
    assert.equal(after.cursor, before.cursor);
    assert.equal(after.lastObservedAt, before.lastObservedAt);
    assert.equal(after.state, before.state);

    // A revoked checkpoint is not advanced by a late run (revoke wins).
    await repo.revoke(organizationId, alice, 'TELEGRAM', { now: NOW, actor: actor(alice) });
    const held = await repo.recordBaselineProgress(organizationId, alice, 'TELEGRAM', { checkpointCursor: '999', oldestReachedAt: null, state: 'IN_PROGRESS', now: NOW });
    assert.equal(held, false); // nothing advanced
    assert.equal((await repo.get(organizationId, alice, 'TELEGRAM'))?.checkpointCursor, '123'); // unchanged
  } finally {
    await prisma.$disconnect();
  }
});

test('a checkpoint is employee-private: another person in the same org cannot read it', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  const repo = new SourceBaselineCheckpointRepository(prisma);
  try {
    const { organizationId, users: [alice, bob] } = await tenant(prisma, 'private', 2);
    await connection(prisma, organizationId, alice, 'LIVE-A');
    await repo.authorize(organizationId, alice, 'TELEGRAM', { windowDays: 30, now: NOW, actor: actor(alice) });
    assert.ok(await repo.get(organizationId, alice, 'TELEGRAM'));
    assert.equal(await repo.get(organizationId, bob, 'TELEGRAM'), null); // not Bob's; not found
  } finally {
    await prisma.$disconnect();
  }
});
