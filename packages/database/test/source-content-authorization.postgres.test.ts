// Employee content-processing consent against a REAL Postgres. Local only (LOOP_TEST_POSTGRES_URL).
//
// WHAT IT PROVES, THAT AN IN-MEMORY DOUBLE CANNOT
//   - authorize/revoke write the row and an audit trail; content consent never precedes a connection
//     (NO_CONNECTION); a revoke that did not happen writes no audit row (NOTHING_TO_DO).
//   - dueForContent is routing-only and excludes REVOKED and backed-off authorizations.
//   - THE LOAD-BEARING GUARANTEE: recordContentProgress advances ONLY the content cursor and NEVER
//     touches source_connections (the live observation cursor) OR source_baseline_checkpoints (the
//     baseline cursor) -- both are byte-identical before and after.
//   - Employee-private isolation: another person's authorization is not found.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

import { SourceContentAuthorizationRepository } from '../src/repositories/source-content-authorization.repository';

const URL = process.env.LOOP_TEST_POSTGRES_URL ?? '';
const LOCAL = /^postgres(ql)?:\/\/[^@]*@(localhost|127\.0\.0\.1)(:\d+)?\//.test(URL);
const skip = !URL ? 'LOOP_TEST_POSTGRES_URL is not set' : !LOCAL ? 'refusing a non-local database' : false;

const NOW = new Date('2026-09-21T12:00:00Z');
const actor = (userId: string) => ({ userId });

async function tenant(prisma: PrismaClient, label: string, people = 1) {
  const organizationId = `org_ca_${label}_${randomUUID()}`;
  await prisma.organization.create({ data: { id: organizationId, name: `CA ${label}`, slug: organizationId } });
  const users: string[] = [];
  for (let i = 0; i < people; i += 1) {
    const userId = `user_ca_${label}_${i}_${randomUUID()}`;
    await prisma.user.create({ data: { id: userId, organizationId, email: `${userId}@example.test`, name: 'CA', status: 'ACTIVE', metadata: { systemRole: 'EMPLOYEE' } } });
    await prisma.organizationMembership.create({ data: { organizationId, userId, systemRole: 'EMPLOYEE', status: 'ACTIVE', effectiveFrom: new Date('2026-01-01T00:00:00Z') } });
    users.push(userId);
  }
  return { organizationId, users };
}

async function connection(prisma: PrismaClient, organizationId: string, userId: string, cursor: string) {
  await prisma.sourceConnection.create({
    data: { organizationId, userId, provider: 'TELEGRAM', state: 'READY', connectedAt: new Date('2026-09-10T00:00:00Z'), cursor, backgroundObservation: 'OPERATIONAL' },
  });
}

test('authorize creates a consent row + audit; content consent never precedes a connection', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  const repo = new SourceContentAuthorizationRepository(prisma);
  try {
    const { organizationId, users: [alice] } = await tenant(prisma, 'auth');
    // No connection yet -> NO_CONNECTION, nothing written.
    assert.deepEqual(await repo.authorize(organizationId, alice, 'TELEGRAM', { now: NOW, actor: actor(alice) }), { outcome: 'NO_CONNECTION' });
    assert.equal(await repo.get(organizationId, alice, 'TELEGRAM'), null);

    await connection(prisma, organizationId, alice, 'LIVE-1');
    const res = await repo.authorize(organizationId, alice, 'TELEGRAM', { now: NOW, actor: actor(alice) });
    assert.equal(res.outcome, 'AUTHORIZED');
    const rec = await repo.get(organizationId, alice, 'TELEGRAM');
    assert.equal(rec?.authorized, true);
    assert.equal(rec?.revokedAt, null);
    assert.equal(rec?.contentCursor, null);
    assert.equal(await prisma.auditLog.count({ where: { organizationId, entityType: 'source_connection', action: 'source_connection.content.authorized' } }), 1);
  } finally {
    await prisma.$disconnect();
  }
});

test('revoke stops processing and audits; a no-op revoke writes nothing', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  const repo = new SourceContentAuthorizationRepository(prisma);
  try {
    const { organizationId, users: [bob] } = await tenant(prisma, 'revoke');
    // Revoke with nothing there -> NOTHING_TO_DO, no audit.
    assert.deepEqual(await repo.revoke(organizationId, bob, 'TELEGRAM', { now: NOW, actor: actor(bob) }), { outcome: 'NOTHING_TO_DO' });
    await connection(prisma, organizationId, bob, 'LIVE-1');
    await repo.authorize(organizationId, bob, 'TELEGRAM', { now: NOW, actor: actor(bob) });

    const rev = await repo.revoke(organizationId, bob, 'TELEGRAM', { now: NOW, actor: actor(bob) });
    assert.equal(rev.outcome, 'REVOKED');
    assert.equal((await repo.get(organizationId, bob, 'TELEGRAM'))?.authorized, false);
    // A second revoke does nothing and writes no second audit row.
    assert.deepEqual(await repo.revoke(organizationId, bob, 'TELEGRAM', { now: NOW, actor: actor(bob) }), { outcome: 'NOTHING_TO_DO' });
    assert.equal(await prisma.auditLog.count({ where: { organizationId, action: 'source_connection.content.revoked' } }), 1);
  } finally {
    await prisma.$disconnect();
  }
});

test('dueForContent is routing-only and excludes REVOKED and backed-off authorizations', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  const repo = new SourceContentAuthorizationRepository(prisma);
  try {
    const { organizationId, users: [live, revoked, backed] } = await tenant(prisma, 'due', 3);
    for (const u of [live, revoked, backed]) await connection(prisma, organizationId, u, 'LIVE-1');
    await repo.authorize(organizationId, live, 'TELEGRAM', { now: NOW, actor: actor(live) });
    await repo.authorize(organizationId, revoked, 'TELEGRAM', { now: NOW, actor: actor(revoked) });
    await repo.revoke(organizationId, revoked, 'TELEGRAM', { now: NOW, actor: actor(revoked) });
    await repo.authorize(organizationId, backed, 'TELEGRAM', { now: NOW, actor: actor(backed) });
    // A far-future backoff (dueForContent uses real wall-clock time, so a NOW-relative backoff would
    // already have passed by the time the test runs).
    await repo.recordContentProgress(organizationId, backed, 'TELEGRAM', { contentCursor: '9', failureClass: 'FLOOD_WAIT', backoffUntil: new Date('2099-01-01T00:00:00Z'), now: NOW });

    const dueUsers = new Set((await repo.dueForContent(500)).map((d) => d.userId));
    assert.ok(dueUsers.has(live), 'an authorized, not-backed-off authorization is due');
    assert.ok(!dueUsers.has(revoked), 'a revoked authorization is never due');
    assert.ok(!dueUsers.has(backed), 'a backed-off authorization is not due until the backoff passes');
    // Routing-only: it carries no credential and no content.
    const one = (await repo.dueForContent(500)).find((d) => d.userId === live)!;
    assert.deepEqual(Object.keys(one).sort(), ['contentCursor', 'organizationId', 'provider', 'userId']);
  } finally {
    await prisma.$disconnect();
  }
});

test('recordContentProgress advances ONLY the content cursor: live cursor and baseline are byte-identical', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  const repo = new SourceContentAuthorizationRepository(prisma);
  try {
    const { organizationId, users: [alice] } = await tenant(prisma, 'immut');
    await connection(prisma, organizationId, alice, 'LIVE-CURSOR-IMMUTABLE');
    // A baseline checkpoint with its own cursor, to prove the content path never moves it either.
    await prisma.sourceBaselineCheckpoint.create({
      data: { organizationId, userId: alice, provider: 'TELEGRAM', windowDays: 90, windowFloorAt: new Date('2026-06-01T00:00:00Z'), consentAt: NOW, state: 'IN_PROGRESS', checkpointCursor: 'BASELINE-CURSOR-IMMUTABLE' },
    });
    await repo.authorize(organizationId, alice, 'TELEGRAM', { now: NOW, actor: actor(alice) });

    const liveBefore = (await prisma.sourceConnection.findFirstOrThrow({ where: { organizationId, userId: alice, provider: 'TELEGRAM' } })).cursor;
    const baseBefore = (await prisma.sourceBaselineCheckpoint.findFirstOrThrow({ where: { organizationId, userId: alice, provider: 'TELEGRAM' } })).checkpointCursor;

    const advanced = await repo.recordContentProgress(organizationId, alice, 'TELEGRAM', { contentCursor: '4242', failureClass: null, backoffUntil: null, now: NOW });
    assert.equal(advanced, true);
    assert.equal((await repo.get(organizationId, alice, 'TELEGRAM'))?.contentCursor, '4242', 'the content cursor advanced');

    const liveAfter = (await prisma.sourceConnection.findFirstOrThrow({ where: { organizationId, userId: alice, provider: 'TELEGRAM' } })).cursor;
    const baseAfter = (await prisma.sourceBaselineCheckpoint.findFirstOrThrow({ where: { organizationId, userId: alice, provider: 'TELEGRAM' } })).checkpointCursor;
    assert.equal(liveAfter, liveBefore, 'the live observation cursor is byte-identical');
    assert.equal(liveAfter, 'LIVE-CURSOR-IMMUTABLE');
    assert.equal(baseAfter, baseBefore, 'the baseline checkpoint cursor is byte-identical');
    assert.equal(baseAfter, 'BASELINE-CURSOR-IMMUTABLE');

    // A revoke in flight always wins: recordContentProgress on a revoked row advances nothing.
    await repo.revoke(organizationId, alice, 'TELEGRAM', { now: NOW, actor: actor(alice) });
    assert.equal(await repo.recordContentProgress(organizationId, alice, 'TELEGRAM', { contentCursor: '9999', failureClass: null, backoffUntil: null, now: NOW }), false);
    assert.equal((await repo.get(organizationId, alice, 'TELEGRAM'))?.contentCursor, '4242', 'a revoked authorization does not advance');
  } finally {
    await prisma.$disconnect();
  }
});

test('employee-private: another person in the same org cannot find this authorization', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  const repo = new SourceContentAuthorizationRepository(prisma);
  try {
    const { organizationId, users: [alice, mallory] } = await tenant(prisma, 'priv', 2);
    await connection(prisma, organizationId, alice, 'LIVE-1');
    await repo.authorize(organizationId, alice, 'TELEGRAM', { now: NOW, actor: actor(alice) });
    assert.equal(await repo.get(organizationId, mallory, 'TELEGRAM'), null, "another person's authorization is not found");
  } finally {
    await prisma.$disconnect();
  }
});

// --- v2 historical backfill ----------------------------------------------------------------------

async function baseline(prisma: PrismaClient, organizationId: string, userId: string, state: string, cursor: string) {
  await prisma.sourceBaselineCheckpoint.create({
    data: { organizationId, userId, provider: 'TELEGRAM', windowDays: 90, windowFloorAt: new Date('2026-06-01T00:00:00Z'), consentAt: NOW, state, checkpointCursor: cursor },
  });
}

const FLOOR = new Date('2026-06-01T00:00:00Z');

test('enableHistoricalBackfill arms the columns ONCE (idempotent) and never resets an in-progress backfill', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  const repo = new SourceContentAuthorizationRepository(prisma);
  try {
    const { organizationId, users: [alice] } = await tenant(prisma, 'histenable');
    await connection(prisma, organizationId, alice, 'LIVE-1');
    await repo.authorize(organizationId, alice, 'TELEGRAM', { now: NOW, actor: actor(alice) });

    // Not enabled yet -> not due, and the record shows NOT_STARTED with no floor.
    assert.equal((await repo.dueForHistoricalContent(500)).some((d) => d.userId === alice), false, 'a not-enabled backfill is not due');
    const before = await repo.get(organizationId, alice, 'TELEGRAM');
    assert.equal(before?.historicalState, 'NOT_STARTED');
    assert.equal(before?.historicalWindowFloorAt, null);

    assert.equal(await repo.enableHistoricalBackfill(organizationId, alice, 'TELEGRAM', { floorAt: FLOOR }), true, 'enables exactly one');
    const after = await repo.get(organizationId, alice, 'TELEGRAM');
    assert.equal(after?.historicalWindowFloorAt?.toISOString(), FLOOR.toISOString());
    assert.ok((await repo.dueForHistoricalContent(500)).some((d) => d.userId === alice), 'an enabled backfill is due');

    // Advance the backfill, then re-enable: idempotent, it must NOT reset the frontier back to null.
    await repo.recordHistoricalProgress(organizationId, alice, 'TELEGRAM', { historicalCursor: 'H-99', state: 'IN_PROGRESS', now: NOW });
    assert.equal(await repo.enableHistoricalBackfill(organizationId, alice, 'TELEGRAM', { floorAt: new Date('2020-01-01T00:00:00Z') }), false, 'already enabled -> no-op');
    const due = (await repo.dueForHistoricalContent(500)).find((d) => d.userId === alice)!;
    assert.equal(due.historicalCursor, 'H-99', 'the frontier was NOT reset');
  } finally {
    await prisma.$disconnect();
  }
});

test('dueForHistoricalContent is routing-only and excludes revoked, backed-off and baseline-incomplete backfills', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  const repo = new SourceContentAuthorizationRepository(prisma);
  try {
    const { organizationId, users: [live, revoked, backed, incomplete] } = await tenant(prisma, 'histdue', 4);
    for (const u of [live, revoked, backed, incomplete]) await connection(prisma, organizationId, u, 'LIVE-1');
    for (const u of [live, revoked, backed, incomplete]) await repo.authorize(organizationId, u, 'TELEGRAM', { now: NOW, actor: actor(u) });

    await repo.enableHistoricalBackfill(organizationId, live, 'TELEGRAM', { floorAt: FLOOR });
    await repo.enableHistoricalBackfill(organizationId, revoked, 'TELEGRAM', { floorAt: FLOOR });
    await repo.revoke(organizationId, revoked, 'TELEGRAM', { now: NOW, actor: actor(revoked) });
    await repo.enableHistoricalBackfill(organizationId, backed, 'TELEGRAM', { floorAt: FLOOR });
    await repo.recordHistoricalProgress(organizationId, backed, 'TELEGRAM', { historicalCursor: 'H1', state: 'IN_PROGRESS', backoffUntil: new Date('2099-01-01T00:00:00Z'), now: NOW });
    // `incomplete` authorized content but the backfill was never enabled (baseline was not COMPLETE).

    const dueUsers = new Set((await repo.dueForHistoricalContent(500)).map((d) => d.userId));
    assert.ok(dueUsers.has(live), 'an enabled, live backfill is due');
    assert.ok(!dueUsers.has(revoked), 'a revoked backfill is never due');
    assert.ok(!dueUsers.has(backed), 'a backed-off backfill is not due until the backoff passes');
    assert.ok(!dueUsers.has(incomplete), 'a not-enabled (baseline-incomplete) backfill is not due');

    const one = (await repo.dueForHistoricalContent(500)).find((d) => d.userId === live)!;
    assert.deepEqual(Object.keys(one).sort(), ['historicalCursor', 'historicalWindowFloorAt', 'organizationId', 'provider', 'userId']);
  } finally {
    await prisma.$disconnect();
  }
});

test('recordHistoricalProgress advances ONLY the historical* columns: live cursor, baseline checkpoint AND the forward contentCursor are byte-identical', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  const repo = new SourceContentAuthorizationRepository(prisma);
  try {
    const { organizationId, users: [alice] } = await tenant(prisma, 'histimmut');
    await connection(prisma, organizationId, alice, 'LIVE-CURSOR-IMMUTABLE');
    await baseline(prisma, organizationId, alice, 'COMPLETE', 'BASELINE-CURSOR-IMMUTABLE');
    await repo.authorize(organizationId, alice, 'TELEGRAM', { now: NOW, actor: actor(alice) });
    // Advance the FORWARD content cursor, so we can prove the historical run leaves it byte-identical too.
    await repo.recordContentProgress(organizationId, alice, 'TELEGRAM', { contentCursor: 'FORWARD-CURSOR-IMMUTABLE', failureClass: null, backoffUntil: null, now: NOW });
    await repo.enableHistoricalBackfill(organizationId, alice, 'TELEGRAM', { floorAt: FLOOR });

    const liveBefore = (await prisma.sourceConnection.findFirstOrThrow({ where: { organizationId, userId: alice, provider: 'TELEGRAM' } })).cursor;
    const baseBefore = (await prisma.sourceBaselineCheckpoint.findFirstOrThrow({ where: { organizationId, userId: alice, provider: 'TELEGRAM' } })).checkpointCursor;
    const fwdBefore = (await repo.get(organizationId, alice, 'TELEGRAM'))?.contentCursor;

    const advanced = await repo.recordHistoricalProgress(organizationId, alice, 'TELEGRAM', { historicalCursor: 'H-1', state: 'IN_PROGRESS', failedItemsDelta: 2, oldestReachedAt: FLOOR, now: NOW });
    assert.equal(advanced, true);

    const liveAfter = (await prisma.sourceConnection.findFirstOrThrow({ where: { organizationId, userId: alice, provider: 'TELEGRAM' } })).cursor;
    const baseAfter = (await prisma.sourceBaselineCheckpoint.findFirstOrThrow({ where: { organizationId, userId: alice, provider: 'TELEGRAM' } })).checkpointCursor;
    const row = await prisma.sourceContentAuthorization.findFirstOrThrow({ where: { organizationId, userId: alice, provider: 'TELEGRAM' } });

    assert.equal(liveAfter, liveBefore, 'the live observation cursor is byte-identical');
    assert.equal(liveAfter, 'LIVE-CURSOR-IMMUTABLE');
    assert.equal(baseAfter, baseBefore, 'the baseline checkpoint cursor is byte-identical');
    assert.equal(baseAfter, 'BASELINE-CURSOR-IMMUTABLE');
    assert.equal(row.contentCursor, fwdBefore, 'the FORWARD content cursor is byte-identical');
    assert.equal(row.contentCursor, 'FORWARD-CURSOR-IMMUTABLE');
    // The historical* columns DID advance.
    assert.equal(row.historicalCursor, 'H-1');
    assert.equal(row.historicalState, 'IN_PROGRESS');
    assert.equal(row.historicalFailedItems, 2, 'a permanent failure was counted');

    // A revoke in flight always wins: recordHistoricalProgress on a revoked row advances nothing.
    await repo.revoke(organizationId, alice, 'TELEGRAM', { now: NOW, actor: actor(alice) });
    assert.equal(await repo.recordHistoricalProgress(organizationId, alice, 'TELEGRAM', { historicalCursor: 'H-2', state: 'IN_PROGRESS', now: NOW }), false);
    assert.equal((await prisma.sourceContentAuthorization.findFirstOrThrow({ where: { organizationId, userId: alice, provider: 'TELEGRAM' } })).historicalCursor, 'H-1');
  } finally {
    await prisma.$disconnect();
  }
});
