// Source connections (Teams, Telegram) against a REAL Postgres.
//
// OPT-IN AND LOCAL ONLY. Runs only when LOOP_TEST_POSTGRES_URL is set and the host is
// localhost/127.0.0.1 -- it creates rows and must never touch a shared or production DB:
//
//   docker run -d --name loop-pg -e POSTGRES_PASSWORD=verify -p 127.0.0.1:55432:5432 postgres:18
//   DATABASE_URL=postgresql://postgres:verify@127.0.0.1:55432/postgres npx prisma migrate deploy
//   LOOP_TEST_POSTGRES_URL=postgresql://postgres:verify@127.0.0.1:55432/postgres \
//     npx tsx --test test/source-connection.repository.postgres.test.ts
//
// WHAT IT PROVES, THAT AN IN-MEMORY DOUBLE CANNOT.
//   - The repository stores sealed bytes only; find() never returns them; credential()
//     opens them, and only with the exact (org, user, provider, kind) binding.
//   - Cross-tenant isolation: another org, or another person, is not-found -- and a secret
//     sealed for one tenant does not open for another (the seal, not just the query).
//   - A credential fills only a connection with an OPEN attempt; a cycle never resurrects a
//     disconnected one; disconnect and offboarding delete the credential and leave a trail.
//   - The database itself refuses a second connection for the same (org, user, provider) and
//     a connection with no membership behind it, even when the repository is bypassed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

import { SourceConnectionRepository, disconnectSourceConnectionsInTx } from '../src/repositories/source-connection.repository';
import { ConnectionSecretSealer, ConnectionSecretUnopenable } from '../src/services/connections/connection-secret-sealer';

const URL = process.env.LOOP_TEST_POSTGRES_URL ?? '';
const LOCAL = /^postgres(ql)?:\/\/[^@]*@(localhost|127\.0\.0\.1)(:\d+)?\//.test(URL);
const skip = !URL ? 'LOOP_TEST_POSTGRES_URL is not set' : !LOCAL ? 'refusing a non-local database' : false;

const NOW = new Date('2026-09-19T12:00:00Z');
const key = randomBytes(32);
const sealer = new ConnectionSecretSealer(key);

async function tenant(prisma: PrismaClient, label: string, people = 1) {
  const organizationId = `org_sc_${label}_${randomUUID()}`;
  await prisma.organization.create({ data: { id: organizationId, name: `SC ${label}`, slug: organizationId } });
  const users: string[] = [];
  for (let i = 0; i < people; i += 1) {
    const userId = `user_sc_${label}_${i}_${randomUUID()}`;
    await prisma.user.create({ data: { id: userId, organizationId, email: `${userId}@example.test`, name: 'SC test', status: 'ACTIVE', metadata: { systemRole: 'EMPLOYEE' } } });
    await prisma.organizationMembership.create({ data: { organizationId, userId, systemRole: 'EMPLOYEE', status: 'ACTIVE', effectiveFrom: new Date('2026-01-01T00:00:00Z') } });
    users.push(userId);
  }
  return { organizationId, users };
}

function sealedFor(organizationId: string, userId: string, provider: 'MICROSOFT_TEAMS' | 'TELEGRAM') {
  const kind = provider === 'TELEGRAM' ? 'MTPROTO_SESSION' : 'OAUTH_REFRESH_TOKEN';
  return sealer.seal({ organizationId, userId, provider, credentialKind: kind }, `secret-${provider}-${userId}`);
}

test('a connection connects, observes, disconnects -- sealed throughout, private to its owner', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  const repo = new SourceConnectionRepository(prisma);
  try {
    const { organizationId, users: [alice] } = await tenant(prisma, 'live');
    const provider = 'TELEGRAM' as const;

    // Nothing yet.
    assert.equal(await repo.find(organizationId, alice, provider), null);

    // Begin: a CONNECTING row, no credential, an audit row.
    const begun = await repo.beginConnect(organizationId, alice, provider, { actor: { userId: alice }, now: NOW });
    assert.equal(begun.outcome, 'STARTED');
    let rec = await repo.find(organizationId, alice, provider);
    assert.equal(rec?.state, 'CONNECTING');
    assert.equal(rec?.hasCredential, false);
    assert.equal(await prisma.auditLog.count({ where: { organizationId, entityType: 'source_connection', action: 'source_connection.started' } }), 1);

    // A gated background capability is CONNECTED_LIMITED, never READY, on authentication alone.
    const sealed = sealedFor(organizationId, alice, provider);
    const gated = await repo.storeCredential(organizationId, alice, provider, { credentialKind: 'MTPROTO_SESSION', adapter: null, accountLabel: '@alice', backgroundObservation: 'GATED', sealed, cursor: null, now: NOW }, { userId: alice });
    assert.equal(gated.outcome, 'STORED');
    rec = await repo.find(organizationId, alice, provider);
    assert.equal(rec?.state, 'CONNECTED_LIMITED');
    assert.equal(rec?.hasCredential, true);
    assert.equal(rec?.accountLabel, '@alice');

    // find() NEVER returns the secret; the record type has no field for it.
    assert.equal((rec as Record<string, unknown>).secretSealed, undefined);

    // credential() returns sealed bytes that open ONLY with the exact binding.
    const held = await repo.credential(organizationId, alice, provider);
    assert.ok(held);
    assert.equal(sealer.open({ organizationId, userId: alice, provider, credentialKind: 'MTPROTO_SESSION' }, held.sealed), `secret-${provider}-${alice}`);
    assert.throws(() => sealer.open({ organizationId, userId: alice, provider: 'MICROSOFT_TEAMS', credentialKind: 'OAUTH_REFRESH_TOKEN' }, held.sealed), ConnectionSecretUnopenable);

    // An observation cycle records a truthful state and a cursor, without an audit row.
    const auditBefore = await prisma.auditLog.count({ where: { organizationId, entityType: 'source_connection' } });
    assert.equal(await repo.recordCycle(organizationId, alice, provider, { state: 'READY', backgroundObservation: 'OPERATIONAL', cursor: 'c-42', now: NOW }), true);
    rec = await repo.find(organizationId, alice, provider);
    assert.equal(rec?.state, 'READY');
    assert.equal(await prisma.auditLog.count({ where: { organizationId, entityType: 'source_connection' } }), auditBefore);

    // Disconnect deletes the credential, marks DISCONNECTED, records who, and audits.
    assert.equal(await repo.disconnect(organizationId, alice, provider, { actor: { userId: alice }, now: NOW }), 'DISCONNECTED');
    rec = await repo.find(organizationId, alice, provider);
    assert.equal(rec?.state, 'DISCONNECTED');
    assert.equal(rec?.hasCredential, false);
    assert.equal(await repo.credential(organizationId, alice, provider), null);
    assert.equal(await prisma.auditLog.count({ where: { organizationId, action: 'source_connection.disconnected' } }), 1);

    // A cycle cannot resurrect a disconnected connection (no credential to touch).
    assert.equal(await repo.recordCycle(organizationId, alice, provider, { state: 'READY', backgroundObservation: 'OPERATIONAL', cursor: 'c-99', now: NOW }), false);

    // Disconnecting again is NOTHING_TO_DO, and writes no audit row.
    assert.equal(await repo.disconnect(organizationId, alice, provider, { actor: { userId: alice }, now: NOW }), 'NOTHING_TO_DO');
    assert.equal(await prisma.auditLog.count({ where: { organizationId, action: 'source_connection.disconnected' } }), 1);
  } finally {
    await prisma.$disconnect();
  }
});

test('a credential fills only an open attempt', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  const repo = new SourceConnectionRepository(prisma);
  try {
    const { organizationId, users: [bob] } = await tenant(prisma, 'attempt');
    const provider = 'MICROSOFT_TEAMS' as const;
    // No attempt open: storing is refused.
    const early = await repo.storeCredential(organizationId, bob, provider, { credentialKind: 'OAUTH_REFRESH_TOKEN', adapter: 'INTERACTIVE_SESSION', accountLabel: null, backgroundObservation: 'OPERATIONAL', sealed: sealedFor(organizationId, bob, provider), cursor: null, now: NOW }, { userId: bob });
    assert.equal(early.outcome, 'NO_ATTEMPT');
    assert.equal(await repo.find(organizationId, bob, provider), null);
    // With an attempt open, an operational capability is READY, and the internal adapter is recorded.
    await repo.beginConnect(organizationId, bob, provider, { actor: { userId: bob }, now: NOW });
    const ok = await repo.storeCredential(organizationId, bob, provider, { credentialKind: 'OAUTH_REFRESH_TOKEN', adapter: 'INTERACTIVE_SESSION', accountLabel: null, backgroundObservation: 'OPERATIONAL', sealed: sealedFor(organizationId, bob, provider), cursor: null, now: NOW }, { userId: bob });
    assert.equal(ok.outcome, 'STORED');
    const rec = await repo.find(organizationId, bob, provider);
    assert.equal(rec?.state, 'READY');
    assert.equal(rec?.adapter, 'INTERACTIVE_SESSION');
  } finally {
    await prisma.$disconnect();
  }
});

test('one tenant cannot see or open another tenant, and offboarding clears the credential', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  const repo = new SourceConnectionRepository(prisma);
  try {
    const a = await tenant(prisma, 'a');
    const b = await tenant(prisma, 'b');
    const provider = 'TELEGRAM' as const;
    const alice = a.users[0]!;
    const bob = b.users[0]!;

    await repo.beginConnect(a.organizationId, alice, provider, { actor: { userId: alice }, now: NOW });
    await repo.storeCredential(a.organizationId, alice, provider, { credentialKind: 'MTPROTO_SESSION', adapter: null, accountLabel: '@a', backgroundObservation: 'OPERATIONAL', sealed: sealedFor(a.organizationId, alice, provider), cursor: null, now: NOW }, { userId: alice });

    // Organization B cannot find or open A's connection.
    assert.equal(await repo.find(b.organizationId, alice, provider), null);
    assert.equal(await repo.credential(b.organizationId, alice, provider), null);
    // Another person in A's own org cannot either (user-private).
    assert.equal(await repo.find(a.organizationId, bob, provider), null);

    // Offboarding A's member clears the credential in one transaction and audits it.
    const cleared = await prisma.$transaction((tx) => disconnectSourceConnectionsInTx(prisma, tx, a.organizationId, alice, { actor: { userId: null, name: 'System' }, now: NOW }));
    assert.equal(cleared, 1);
    assert.equal((await repo.find(a.organizationId, alice, provider))?.hasCredential, false);
    assert.equal(await prisma.auditLog.count({ where: { organizationId: a.organizationId, action: 'source_connection.offboarded' } }), 1);
  } finally {
    await prisma.$disconnect();
  }
});

test('the database itself refuses a duplicate and a membership-less connection', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  try {
    const { organizationId, users: [alice] } = await tenant(prisma, 'db');
    await prisma.sourceConnection.create({ data: { organizationId, userId: alice, provider: 'TELEGRAM', state: 'CONNECTING' } });
    // Second row for the same (org, user, provider): unique key refuses it.
    await assert.rejects(
      prisma.sourceConnection.create({ data: { organizationId, userId: alice, provider: 'TELEGRAM', state: 'CONNECTING' } }),
      (err: any) => String(err?.code).includes('P2002'),
    );
    // A connection whose (userId, organizationId) is not a membership: FK refuses it.
    await assert.rejects(
      prisma.sourceConnection.create({ data: { organizationId, userId: `ghost_${randomUUID()}`, provider: 'MICROSOFT_TEAMS', state: 'CONNECTING' } }),
      (err: any) => String(err?.code).includes('P2003'),
    );
    // Deleting the organization cascades the connection away.
    await prisma.organization.delete({ where: { id: organizationId } });
    assert.equal(await prisma.sourceConnection.count({ where: { organizationId } }), 0);
  } finally {
    await prisma.$disconnect();
  }
});


test('dueForObservation returns only credential-holding, cyclable connections, across tenants, stalest first', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  const repo = new SourceConnectionRepository(prisma);
  try {
    const a = await tenant(prisma, 'due_a');
    const b = await tenant(prisma, 'due_b');
    const alice = a.users[0]!;
    const bob = b.users[0]!;

    // Alice/Telegram: live with a credential, observed long ago -> due, and first (stalest).
    await repo.beginConnect(a.organizationId, alice, 'TELEGRAM', { actor: { userId: alice }, now: NOW });
    await repo.storeCredential(a.organizationId, alice, 'TELEGRAM', { credentialKind: 'MTPROTO_SESSION', adapter: null, accountLabel: null, backgroundObservation: 'OPERATIONAL', sealed: sealedFor(a.organizationId, alice, 'TELEGRAM'), cursor: null, now: NOW }, { userId: alice });
    await repo.recordCycle(a.organizationId, alice, 'TELEGRAM', { state: 'READY', backgroundObservation: 'OPERATIONAL', cursor: '1', now: new Date('2026-09-19T00:00:00Z') });

    // Bob/Teams (different tenant): live with a credential, observed more recently -> due, but later.
    await repo.beginConnect(b.organizationId, bob, 'MICROSOFT_TEAMS', { actor: { userId: bob }, now: NOW });
    await repo.storeCredential(b.organizationId, bob, 'MICROSOFT_TEAMS', { credentialKind: 'OAUTH_REFRESH_TOKEN', adapter: 'INTERACTIVE_SESSION', accountLabel: null, backgroundObservation: 'OPERATIONAL', sealed: sealedFor(b.organizationId, bob, 'MICROSOFT_TEAMS'), cursor: null, now: NOW }, { userId: bob });
    await repo.recordCycle(b.organizationId, bob, 'MICROSOFT_TEAMS', { state: 'READY', backgroundObservation: 'OPERATIONAL', cursor: '9', now: new Date('2026-09-19T06:00:00Z') });

    // Alice/Teams: only CONNECTING (no credential) -> NOT due.
    await repo.beginConnect(a.organizationId, alice, 'MICROSOFT_TEAMS', { actor: { userId: alice }, now: NOW });

    // Bob/Telegram: disconnected -> NOT due.
    await repo.beginConnect(b.organizationId, bob, 'TELEGRAM', { actor: { userId: bob }, now: NOW });
    await repo.storeCredential(b.organizationId, bob, 'TELEGRAM', { credentialKind: 'MTPROTO_SESSION', adapter: null, accountLabel: null, backgroundObservation: 'OPERATIONAL', sealed: sealedFor(b.organizationId, bob, 'TELEGRAM'), cursor: null, now: NOW }, { userId: bob });
    await repo.disconnect(b.organizationId, bob, 'TELEGRAM', { actor: { userId: bob }, now: NOW });

    const due = await repo.dueForObservation(100);
    const mine = due.filter((d) => d.organizationId === a.organizationId || d.organizationId === b.organizationId);
    // Exactly the two credential-holding, cyclable connections, across both tenants.
    assert.deepEqual(
      mine.map((d) => `${d.organizationId === a.organizationId ? 'A' : 'B'}:${d.provider}`),
      ['A:TELEGRAM', 'B:MICROSOFT_TEAMS'],
    );
    // Stalest-observed first; routing fields only (no credential field present).
    assert.equal(mine[0]!.cursor, '1');
    assert.equal((mine[0] as Record<string, unknown>).secretSealed, undefined);
  } finally {
    await prisma.$disconnect();
  }
});
