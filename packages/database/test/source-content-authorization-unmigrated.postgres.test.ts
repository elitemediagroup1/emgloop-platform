// The content-authorization paths against a database the hydration migration has NOT reached yet.
// Local only (LOOP_TEST_POSTGRES_URL).
//
// WHY. Merging to `main` deploys the web tier to production at once; the migration
// 20261004000000_chats_intelligence_hydration reaches production only when a human dispatches it
// afterwards. In that window the Prisma client knows seven `intelligenceHydration*` columns the database
// does not have, and any statement that names one -- including a full-row read or a write that returns
// the full row, which Prisma expands to every model column -- fails with P2022.
//
// HOW. The REAL repositories run against the REAL Postgres through a proxy that behaves exactly like
// that unmigrated database for `sourceContentAuthorization`: it throws P2022 for a read (or a returned
// row) without an explicit `select`, and for any argument that names an intelligenceHydration* column.
// Everything else passes through. It covers the client AND every interactive-transaction client.
//
// WHAT IT PROVES. get / authorize (fresh, re-affirm, and re-authorize after a revoke, whose hydration
// reset is skipped) / revoke / dueForContent / dueForHistoricalContent / enableHistoricalBackfill /
// recordContentProgress / recordHistoricalProgress / revokeContentAuthorizationsInTx / the consent
// re-check all still work, and dueForChatsHydration answers [] instead of throwing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';

import {
  SourceContentAuthorizationRepository,
  contentAuthorizedInTx,
  revokeContentAuthorizationsInTx,
} from '../src/repositories/source-content-authorization.repository';

const URL = process.env.LOOP_TEST_POSTGRES_URL ?? '';
const LOCAL = /^postgres(ql)?:\/\/[^@]*@(localhost|127\.0\.0\.1)(:\d+)?\//.test(URL);
const skip = !URL ? 'LOOP_TEST_POSTGRES_URL is not set' : !LOCAL ? 'refusing a non-local database' : false;

const NOW = new Date('2026-09-25T12:00:00Z');
const FLOOR = new Date('2026-06-01T00:00:00Z');
const actor = (userId: string) => ({ userId });

const RETURNS_ROWS = new Set(['findFirst', 'findFirstOrThrow', 'findUnique', 'findUniqueOrThrow', 'findMany', 'create', 'update', 'upsert', 'delete']);
const missingColumn = () =>
  new Prisma.PrismaClientKnownRequestError('The column `source_content_authorizations.intelligenceHydrationState` does not exist in the current database.', {
    code: 'P2022',
    clientVersion: 'test',
  });

/** The sourceContentAuthorization delegate, as an unmigrated database would answer it. */
function unmigratedDelegate(delegate: Record<string, unknown>, seen: string[]) {
  return new Proxy(delegate, {
    get(target, prop) {
      const value = Reflect.get(target, prop);
      if (typeof value !== 'function') return value;
      return async (args: Record<string, unknown> = {}) => {
        seen.push(String(prop));
        if (JSON.stringify(args).includes('intelligenceHydration')) throw missingColumn();
        if (RETURNS_ROWS.has(String(prop)) && !args.select) throw missingColumn(); // a full row names every column
        return (value as (a: unknown) => unknown).call(target, args);
      };
    },
  });
}

function unmigrated<T extends object>(client: T, seen: string[]): T {
  return new Proxy(client, {
    get(target, prop) {
      const value = Reflect.get(target, prop);
      if (prop === 'sourceContentAuthorization') return unmigratedDelegate(value as Record<string, unknown>, seen);
      if (prop === '$transaction') {
        return (arg: unknown, options?: unknown) =>
          typeof arg === 'function'
            ? (value as (f: unknown, o?: unknown) => unknown).call(target, (tx: object) => (arg as (t: object) => unknown)(unmigrated(tx, seen)), options)
            : (value as (a: unknown, o?: unknown) => unknown).call(target, arg, options);
      }
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}

async function tenant(prisma: PrismaClient, label: string, people = 1) {
  const organizationId = `org_um_${label}_${randomUUID()}`;
  await prisma.organization.create({ data: { id: organizationId, name: `UM ${label}`, slug: organizationId } });
  const users: string[] = [];
  for (let i = 0; i < people; i += 1) {
    const userId = `user_um_${label}_${i}_${randomUUID()}`;
    await prisma.user.create({ data: { id: userId, organizationId, email: `${userId}@example.test`, name: 'UM', status: 'ACTIVE', metadata: { systemRole: 'EMPLOYEE' } } });
    await prisma.organizationMembership.create({ data: { organizationId, userId, systemRole: 'EMPLOYEE', status: 'ACTIVE', effectiveFrom: new Date('2026-01-01T00:00:00Z') } });
    await prisma.sourceConnection.create({
      data: { organizationId, userId, provider: 'TELEGRAM', state: 'READY', connectedAt: new Date('2026-09-10T00:00:00Z'), cursor: 'LIVE-1', backgroundObservation: 'OPERATIONAL' },
    });
    users.push(userId);
  }
  return { organizationId, users };
}

test('the simulated unmigrated database refuses exactly what a real one would', { skip }, async () => {
  const real = new PrismaClient({ datasources: { db: { url: URL } } });
  const db = unmigrated(real, []);
  try {
    await assert.rejects(db.sourceContentAuthorization.findFirst({ where: { id: 'x' } }), (e: unknown) => (e as { code?: string }).code === 'P2022', 'a full-row read names the new columns');
    await assert.rejects(db.sourceContentAuthorization.findMany({ where: { intelligenceHydrationState: 'COMPLETE' }, select: { id: true } }), (e: unknown) => (e as { code?: string }).code === 'P2022');
    assert.deepEqual(await db.sourceContentAuthorization.findMany({ where: { id: 'none' }, select: { id: true } }), []);
  } finally {
    await real.$disconnect();
  }
});

test('before the hydration migration every pre-existing content-authorization path still works, and nothing is due for hydration', { skip }, async () => {
  const real = new PrismaClient({ datasources: { db: { url: URL } } });
  const seen: string[] = [];
  const db = unmigrated(real, seen);
  const repo = new SourceContentAuthorizationRepository(db);
  try {
    const { organizationId, users: [alice, bob] } = await tenant(real, 'paths', 2);

    // authorize (fresh), get, re-affirm.
    assert.equal((await repo.authorize(organizationId, alice!, 'TELEGRAM', { now: NOW, actor: actor(alice!) })).outcome, 'AUTHORIZED');
    const rec = await repo.get(organizationId, alice!, 'TELEGRAM');
    assert.equal(rec?.authorized, true);
    assert.equal(rec?.historicalState, 'NOT_STARTED');
    assert.equal((await repo.authorize(organizationId, alice!, 'TELEGRAM', { now: NOW, actor: actor(alice!) })).outcome, 'AUTHORIZED');

    // Worker discovery and progress (the forward and historical sweeps).
    assert.ok((await repo.dueForContent(500)).some((d) => d.userId === alice));
    assert.equal(await repo.recordContentProgress(organizationId, alice!, 'TELEGRAM', { contentCursor: 'C-1', now: NOW }), true);
    assert.equal(await repo.enableHistoricalBackfill(organizationId, alice!, 'TELEGRAM', { floorAt: FLOOR }), true);
    assert.ok((await repo.dueForHistoricalContent(500)).some((d) => d.userId === alice));
    assert.equal(await repo.recordHistoricalProgress(organizationId, alice!, 'TELEGRAM', { historicalCursor: 'H-1', state: 'COMPLETE', now: NOW }), true);
    assert.equal((await repo.get(organizationId, alice!, 'TELEGRAM'))?.contentCursor, 'C-1');

    // Hydration discovery answers "nothing" rather than failing the worker.
    assert.deepEqual(await repo.dueForChatsHydration(500), []);

    // The consent re-check the digest and WorkItem writers make.
    assert.equal(await real.$transaction((tx) => contentAuthorizedInTx(unmigrated(tx, seen), organizationId, alice!, 'TELEGRAM')), true);

    // revoke, then re-authorize after the revoke: the hydration reset is skipped, the authorization is live.
    assert.equal((await repo.revoke(organizationId, alice!, 'TELEGRAM', { now: NOW, actor: actor(alice!) })).outcome, 'REVOKED');
    assert.equal((await repo.get(organizationId, alice!, 'TELEGRAM'))?.authorized, false);
    assert.equal((await repo.authorize(organizationId, alice!, 'TELEGRAM', { now: NOW, actor: actor(alice!) })).outcome, 'AUTHORIZED');
    assert.equal((await repo.get(organizationId, alice!, 'TELEGRAM'))?.authorized, true);

    // Offboarding's in-transaction revoke.
    await repo.authorize(organizationId, bob!, 'TELEGRAM', { now: NOW, actor: actor(bob!) });
    const revoked = await db.$transaction((tx) =>
      revokeContentAuthorizationsInTx(db, tx, organizationId, bob!, { actor: actor(bob!), now: NOW, reason: 'MEMBER_DISABLED', digests: false }),
    );
    assert.equal(revoked, 1);
    assert.equal((await repo.get(organizationId, bob!, 'TELEGRAM'))?.authorized, false);

    // The proxy really was in the path for every one of those calls.
    for (const method of ['findFirst', 'findMany', 'create', 'update', 'updateMany']) assert.ok(seen.includes(method), `${method} went through the unmigrated schema`);
  } finally {
    await real.$disconnect();
  }
});
