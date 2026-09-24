// TikTok Login Kit connection, against a REAL Postgres.
//
// OPT-IN AND LOCAL ONLY. Runs only when LOOP_TEST_POSTGRES_URL is set, and refuses any URL
// whose host is not localhost or 127.0.0.1 -- it creates rows and must never be pointed at a
// shared or production database. Run it against a disposable container with the migrations
// applied:
//
//   docker run -d --name loop-pg -e POSTGRES_PASSWORD=verify -p 127.0.0.1:55432:5432 postgres:18
//   DATABASE_URL=postgresql://postgres:verify@127.0.0.1:55432/postgres npx prisma migrate deploy
//   LOOP_TEST_POSTGRES_URL=postgresql://postgres:verify@127.0.0.1:55432/postgres \
//     npx tsx --test test/tiktok-connection.postgres.test.ts
//
// WHAT IT PROVES, THAT THE IN-MEMORY DOUBLE CANNOT.
//   - The database itself refuses a scope outside the four, a credential on a revoked or
//     expired row, a connected row without one (or with half of one), a live link that is not
//     the linked account, a connection or attempt with no membership behind it, provider text
//     as a failure class, and a malformed attempt -- even when the repository is bypassed.
//   - Two people racing to link the same TikTok account in one organization: one wins.
//   - The repository's writes commit against the real schema, and a refresh rotates in place.
//   - Deleting an organization or a session removes what it owned.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

import { TikTokConnectionRepository, type TikTokSealedCredential } from '../src/repositories/tiktok-connection.repository';
import { TikTokTokenSealer } from '../src/services/tiktok/tiktok-token-sealer';

const URL = process.env.LOOP_TEST_POSTGRES_URL ?? '';
const LOCAL = /^postgres(ql)?:\/\/[^@]*@(localhost|127\.0\.0\.1)(:\d+)?\//.test(URL);
const skip = !URL ? 'LOOP_TEST_POSTGRES_URL is not set' : !LOCAL ? 'refusing a non-local database' : false;

const BASIC = 'user.info.basic';
const STATS = 'user.info.stats';
const NOW = new Date('2026-09-24T12:00:00Z');
const LATER = new Date('2026-09-25T12:00:00Z');

async function tenant(prisma: PrismaClient, label: string, people = 2) {
  const organizationId = `org_t_${label}_${randomUUID()}`;
  await prisma.organization.create({ data: { id: organizationId, name: `T ${label}`, slug: organizationId } });
  const users: { userId: string; sessionId: string }[] = [];
  for (let i = 0; i < people; i += 1) {
    const userId = `user_t_${label}_${i}_${randomUUID()}`;
    await prisma.user.create({ data: { id: userId, organizationId, email: `${userId}@example.test`, name: 'T test', status: 'ACTIVE', metadata: { systemRole: 'CREATOR' } } });
    await prisma.organizationMembership.create({ data: { organizationId, userId, systemRole: 'CREATOR', status: 'ACTIVE' } });
    const session = await prisma.userSession.create({ data: { organizationId, userId, tokenHash: randomBytes(32).toString('hex'), expiresAt: new Date('2099-01-01T00:00:00Z') } });
    users.push({ userId, sessionId: session.id });
  }
  return { organizationId, users };
}

const sealer = new TikTokTokenSealer(randomBytes(32));
function credentialFor(organizationId: string, userId: string, openId: string, suffix = ''): TikTokSealedCredential {
  const binding = { organizationId, userId, tiktokOpenId: openId };
  return {
    refresh: sealer.seal(binding, 'refresh', `rft.${openId}${suffix}`),
    access: sealer.seal(binding, 'access', `act.${openId}${suffix}`),
    accessExpiresAt: LATER,
  };
}
function columns(credential: TikTokSealedCredential) {
  return {
    refreshTokenSealed: Buffer.from(credential.refresh.sealed),
    accessTokenSealed: Buffer.from(credential.access.sealed),
    accessTokenExpiresAt: credential.accessExpiresAt,
    sealVersion: credential.refresh.sealVersion,
    keyRef: credential.refresh.keyRef,
  };
}

async function refused(promise: Promise<unknown>, code: string, what: string) {
  await assert.rejects(promise, (err: any) => {
    const text = `${err?.code ?? ''} ${err?.meta?.code ?? ''} ${err?.message ?? ''}`;
    assert.ok(text.includes(code), `${what}: expected ${code}, got ${text.slice(0, 200)}`);
    return true;
  }, what);
}

test('the database refuses what the contract forbids, even without the repository', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  let organizationId = '';
  try {
    const checks = await tenant(prisma, 'checks', 1);
    organizationId = checks.organizationId;
    const [{ userId, sessionId }] = checks.users as [{ userId: string; sessionId: string }];
    const openId = `open_${randomUUID().slice(0, 12)}`;
    const credential = credentialFor(organizationId, userId, openId);
    const base = {
      organizationId,
      userId,
      tiktokOpenId: openId,
      activeTiktokOpenId: openId,
      status: 'CONNECTED',
      grantedScopes: [BASIC],
      requestedScopes: [BASIC],
      ...columns(credential),
      connectedAt: NOW,
    };
    const bad = (data: Record<string, unknown>) => prisma.tikTokConnection.create({ data: { ...base, ...data } as any });
    await refused(bad({ grantedScopes: [BASIC, 'video.upload'] }), '23514', 'a scope outside the four');
    await refused(bad({ requestedScopes: ['user.info.email'] }), '23514', 'a requested scope outside the four');
    await refused(bad({ refreshTokenSealed: null, accessTokenSealed: null, accessTokenExpiresAt: null, sealVersion: null, keyRef: null }), '23514', 'connected without a credential');
    await refused(bad({ accessTokenSealed: null }), '23514', 'a refresh token without its access token');
    await refused(bad({ accessTokenExpiresAt: null }), '23514', 'an access token without its expiry');
    await refused(bad({ keyRef: null }), '23514', 'a credential without its key reference');
    await refused(bad({ status: 'REVOKED', activeTiktokOpenId: null, revokedAt: NOW, revocationReason: 'SELF_DISCONNECT' }), '23514', 'revoked but still holding a credential');
    await refused(bad({ status: 'EXPIRED', expiredAt: NOW }), '23514', 'expired but still holding a credential');
    await refused(bad({ activeTiktokOpenId: 'someone-else' }), '23514', 'a live link that is not the linked account');
    await refused(bad({ status: 'PAUSED' }), '23514', 'an unknown status');
    await refused(bad({ lastFailureClass: 'TikTok said: invalid_grant for rft.x' }), '23514', 'provider text as a failure class');
    await refused(bad({ userId: `nobody_${randomUUID()}` }), 'P2003', 'no membership behind the connection');

    const created = await prisma.tikTokConnection.create({ data: base as any });
    assert.equal(created.status, 'CONNECTED');
    await refused(bad({ userId }), 'P2002', 'a second connection for the same person');

    const attempt = { organizationId, userId, sessionId, stateHash: 'a'.repeat(64), expiresAt: new Date(Date.now() + 600_000) };
    const badAttempt = (data: Record<string, unknown>) => prisma.tikTokOAuthState.create({ data: { ...attempt, stateHash: randomBytes(32).toString('hex'), ...data } as any });
    await refused(badAttempt({ stateHash: 'the-raw-state-value' }), '23514', 'a raw state instead of its hash');
    await refused(badAttempt({ expiresAt: new Date('2000-01-01T00:00:00Z') }), '23514', 'an expiry before creation');
    await refused(badAttempt({ sessionId: `no_session_${randomUUID()}` }), 'P2003', 'a session that does not exist');
    await prisma.tikTokOAuthState.create({ data: attempt as any });

    // Deleting the session drops its attempts; deleting the organization drops everything.
    await prisma.userSession.delete({ where: { id: sessionId } });
    assert.equal(await prisma.tikTokOAuthState.count({ where: { organizationId } }), 0);
    await prisma.organization.delete({ where: { id: organizationId } });
    assert.equal(await prisma.tikTokConnection.count({ where: { organizationId } }), 0);
  } finally {
    if (organizationId) await prisma.organization.deleteMany({ where: { id: organizationId } });
    await prisma.$disconnect();
  }
});

test('the repository commits against the real schema: one account, one person; a refresh rotates in place; expiry deletes both tokens', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  let organizationId = '';
  try {
    const repo = new TikTokConnectionRepository(prisma);
    const created = await tenant(prisma, 'repo', 2);
    organizationId = created.organizationId;
    const [kona, river] = created.users as [typeof created.users[0], typeof created.users[0]];
    const openId = `open_${randomUUID().slice(0, 12)}`;

    assert.equal(
      await repo.openState(organizationId, kona.userId, { sessionId: kona.sessionId, stateHash: randomBytes(32).toString('hex'), now: new Date() }),
      'OPENED',
    );

    // Two people race to link the same TikTok account: exactly one succeeds. A conflicting
    // serializable write is retried, and the retry sees the winner.
    const outcomes = await Promise.all(
      [kona, river].map((p) =>
        repo.storeGrant(
          organizationId,
          p.userId,
          { tiktokOpenId: openId, handleAtLink: null, grantedScopes: [BASIC, STATS], requestedScopes: [BASIC, STATS], credential: credentialFor(organizationId, p.userId, openId), now: new Date() },
          { userId: p.userId },
        ),
      ),
    );
    assert.deepEqual(outcomes.map((o) => o.outcome).sort(), ['ACCOUNT_IN_USE', 'STORED']);
    assert.equal(await prisma.tikTokConnection.count({ where: { organizationId, activeTiktokOpenId: openId } }), 1);
    const winner = outcomes[0]!.outcome === 'STORED' ? kona : river;
    const connectionId = (outcomes.find((o) => o.outcome === 'STORED') as { connectionId: string }).connectionId;

    // A refresh replaces both sealed tokens in place and keeps one row.
    const rotated = credentialFor(organizationId, winner.userId, openId, '.r');
    assert.equal(await repo.recordRefresh(organizationId, winner.userId, connectionId, { credential: rotated, grantedScopes: null }, NOW), true);
    const held = await repo.credential(organizationId, winner.userId);
    const binding = { organizationId, userId: winner.userId, tiktokOpenId: openId };
    assert.equal(sealer.open(binding, 'refresh', held!.credential.refresh), `rft.${openId}.r`);
    assert.equal(sealer.open(binding, 'access', held!.credential.access), `act.${openId}.r`);
    assert.equal(await repo.recordRead(organizationId, winner.userId, connectionId, NOW, 'konareyes'), true);
    assert.equal((await repo.find(organizationId, winner.userId))!.handleAtLink, 'konareyes');

    // Expiry deletes both tokens and keeps the account linked.
    assert.equal(await repo.markExpired(organizationId, winner.userId, connectionId, 'REFRESH_REFUSED', NOW), true);
    const expired = await prisma.tikTokConnection.findFirstOrThrow({ where: { id: connectionId } });
    assert.deepEqual([expired.status, expired.refreshTokenSealed, expired.accessTokenSealed, expired.accessTokenExpiresAt, expired.activeTiktokOpenId], ['EXPIRED', null, null, null, openId]);
    assert.equal(await prisma.auditLog.count({ where: { organizationId, action: 'tiktok.connection.expired' } }), 1);

    // Revoking releases the account for the other person.
    const revocation = await repo.revoke(organizationId, winner.userId, { reason: 'SELF_DISCONNECT', actor: { userId: winner.userId }, now: NOW });
    assert.equal(revocation?.credential, null, 'an expired row had no credential left');
    await repo.recordRevocationResult(organizationId, connectionId, { confirmed: false, failureClass: 'REVOKE_UNCONFIRMED' }, NOW, { userId: winner.userId });
    assert.equal((await prisma.tikTokConnection.findFirstOrThrow({ where: { id: connectionId } })).lastFailureClass, 'REVOKE_UNCONFIRMED');
    assert.equal(await prisma.auditLog.count({ where: { organizationId, action: 'tiktok.connection.revoked' } }), 1);
    const loser = winner === kona ? river : kona;
    const second = await repo.storeGrant(
      organizationId,
      loser.userId,
      { tiktokOpenId: openId, handleAtLink: null, grantedScopes: [BASIC], requestedScopes: [BASIC], credential: credentialFor(organizationId, loser.userId, openId), now: new Date() },
      { userId: loser.userId },
    );
    assert.equal(second.outcome, 'STORED');
  } finally {
    if (organizationId) await prisma.organization.deleteMany({ where: { id: organizationId } });
    await prisma.$disconnect();
  }
});
