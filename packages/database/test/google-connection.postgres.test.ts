// Google Workspace connection, against a REAL Postgres.
//
// OPT-IN AND LOCAL ONLY. Runs only when LOOP_TEST_POSTGRES_URL is set, and refuses any
// URL whose host is not localhost or 127.0.0.1 -- it creates rows and must never be
// pointed at a shared or production database. Run it against a disposable container with
// the migrations applied:
//
//   docker run -d --name loop-pg -e POSTGRES_PASSWORD=verify -p 127.0.0.1:55432:5432 postgres:18
//   DATABASE_URL=postgresql://postgres:verify@127.0.0.1:55432/postgres npx prisma migrate deploy
//   LOOP_TEST_POSTGRES_URL=postgresql://postgres:verify@127.0.0.1:55432/postgres \
//     npx tsx --test test/google-connection.postgres.test.ts
//
// WHAT IT PROVES, THAT THE IN-MEMORY DOUBLE CANNOT.
//   - The database itself refuses a broader scope, a credential on a revoked or expired
//     row, a connected row without one, a live link that is not the linked account, a
//     connection or attempt with no membership behind it, and a malformed attempt --
//     even when the repository is bypassed.
//   - Two people racing to link the same Google account in one organization: one wins.
//   - The repository's writes and IAM offboarding commit against the real schema.
//   - Deleting an organization or a session removes what it owned.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

import { GoogleConnectionRepository } from '../src/repositories/google-connection.repository';
import { IamRepository } from '../src/repositories/iam.repository';
import { GoogleTokenSealer } from '../src/services/google/google-token-sealer';

const URL = process.env.LOOP_TEST_POSTGRES_URL ?? '';
const LOCAL = /^postgres(ql)?:\/\/[^@]*@(localhost|127\.0\.0\.1)(:\d+)?\//.test(URL);
const skip = !URL ? 'LOOP_TEST_POSTGRES_URL is not set' : !LOCAL ? 'refusing a non-local database' : false;

const GMAIL = 'https://www.googleapis.com/auth/gmail.readonly';
const GMAIL_SEND = 'https://www.googleapis.com/auth/gmail.send';
const GMAIL_LEGACY = 'https://www.googleapis.com/auth/gmail.metadata';
const CALENDAR = 'https://www.googleapis.com/auth/calendar.events.readonly';
const NOW = new Date('2026-09-17T12:00:00Z');

async function tenant(prisma: PrismaClient, label: string, people = 2) {
  const organizationId = `org_g_${label}_${randomUUID()}`;
  await prisma.organization.create({ data: { id: organizationId, name: `G ${label}`, slug: organizationId } });
  const users: { userId: string; sessionId: string }[] = [];
  for (let i = 0; i < people; i += 1) {
    const userId = `user_g_${label}_${i}_${randomUUID()}`;
    await prisma.user.create({ data: { id: userId, organizationId, email: `${userId}@example.test`, name: 'G test', status: 'ACTIVE', metadata: { systemRole: 'EMPLOYEE' } } });
    await prisma.organizationMembership.create({ data: { organizationId, userId, systemRole: 'EMPLOYEE', status: 'ACTIVE' } });
    const session = await prisma.userSession.create({ data: { organizationId, userId, tokenHash: randomBytes(32).toString('hex'), expiresAt: new Date('2099-01-01T00:00:00Z') } });
    users.push({ userId, sessionId: session.id });
  }
  return { organizationId, users };
}

const sealer = new GoogleTokenSealer(randomBytes(32));
const sealedFor = (organizationId: string, userId: string, sub: string) => sealer.seal({ organizationId, userId, googleSubject: sub }, `1//refresh-${sub}`);

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
    const { users } = checks;
    const [{ userId, sessionId }] = users as [{ userId: string; sessionId: string }];
    const sub = `sub_${randomUUID().slice(0, 12)}`;
    const sealed = sealedFor(organizationId, userId, sub);
    const base = {
      organizationId,
      userId,
      googleSubject: sub,
      activeGoogleSubject: sub,
      emailAtLink: 'person@example.com',
      status: 'CONNECTED',
      grantedScopes: [GMAIL],
      requestedScopes: [GMAIL],
      refreshTokenSealed: Buffer.from(sealed.sealed),
      sealVersion: sealed.sealVersion,
      keyRef: sealed.keyRef,
      connectedAt: NOW,
    };
    const bad = (data: Record<string, unknown>) => prisma.googleConnection.create({ data: { ...base, ...data } as any });
    await refused(bad({ grantedScopes: [GMAIL, 'https://www.googleapis.com/auth/gmail.modify'] }), '23514', 'a broader granted scope');
    await refused(bad({ requestedScopes: ['https://www.googleapis.com/auth/drive'] }), '23514', 'a broader requested scope');
    await refused(bad({ refreshTokenSealed: null, sealVersion: null, keyRef: null }), '23514', 'connected without a credential');
    await refused(bad({ keyRef: null }), '23514', 'a credential without its key reference');
    await refused(bad({ status: 'REVOKED', activeGoogleSubject: null, revokedAt: NOW, revocationReason: 'SELF_DISCONNECT' }), '23514', 'revoked but still holding a credential');
    await refused(bad({ status: 'EXPIRED', expiredAt: NOW }), '23514', 'expired but still holding a credential');
    await refused(bad({ activeGoogleSubject: 'someone-else' }), '23514', 'a live link that is not the linked account');
    await refused(bad({ status: 'PAUSED' }), '23514', 'an unknown status');
    await refused(bad({ lastFailureClass: 'Google said: invalid_grant for 1//x' }), '23514', 'provider text as a failure class');
    await refused(bad({ userId: `nobody_${randomUUID()}` }), 'P2003', 'no membership behind the connection');

    const created = await prisma.googleConnection.create({ data: base as any });
    assert.equal(created.status, 'CONNECTED');
    await refused(bad({ userId, emailAtLink: 'dup@example.com' }), 'P2002', 'a second connection for the same person');

    const attempt = {
      organizationId,
      userId,
      sessionId,
      stateHash: 'a'.repeat(64),
      nonceHash: 'b'.repeat(64),
      capabilities: ['gmail'],
      returnTo: 'ONBOARDING',
      expiresAt: new Date(Date.now() + 600_000),
    };
    const badAttempt = (data: Record<string, unknown>) => prisma.googleOAuthState.create({ data: { ...attempt, stateHash: randomBytes(32).toString('hex'), ...data } as any });
    await refused(badAttempt({ capabilities: ['gmail', 'contacts'] }), '23514', 'an unknown capability');
    await refused(badAttempt({ capabilities: [] }), '23514', 'no capability');
    await refused(badAttempt({ capabilities: ['gmail', 'calendar', 'drive', 'gmail'] }), '23514', 'more than three');
    await refused(badAttempt({ stateHash: 'the-raw-state-value' }), '23514', 'a raw state instead of its hash');
    await refused(badAttempt({ returnTo: 'https://evil.example' }), '23514', 'an arbitrary return target');
    await refused(badAttempt({ expiresAt: new Date('2000-01-01T00:00:00Z') }), '23514', 'an expiry before creation');
    await refused(badAttempt({ sessionId: `no_session_${randomUUID()}` }), 'P2003', 'a session that does not exist');
    await prisma.googleOAuthState.create({ data: attempt as any });

    // Deleting the session drops its attempts; deleting the organization drops everything.
    await prisma.userSession.delete({ where: { id: sessionId } });
    assert.equal(await prisma.googleOAuthState.count({ where: { organizationId } }), 0);
    await prisma.organization.delete({ where: { id: organizationId } });
    assert.equal(await prisma.googleConnection.count({ where: { organizationId } }), 0);
  } finally {
    // Leave nothing behind, even when an assertion failed part-way.
    if (organizationId) await prisma.organization.deleteMany({ where: { id: organizationId } });
    await prisma.$disconnect();
  }
});

test('the repository and IAM offboarding commit against the real schema; one account, one person', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  let organizationId = '';
  try {
    const repo = new GoogleConnectionRepository(prisma);
    const iam = new IamRepository(prisma);
    const created = await tenant(prisma, 'repo', 3);
    organizationId = created.organizationId;
    const { users } = created;
    const [alice, bob, carol] = users as [typeof users[0], typeof users[0], typeof users[0]];
    const sub = `sub_${randomUUID().slice(0, 12)}`;

    assert.equal(
      await repo.openState(organizationId, alice.userId, {
        sessionId: alice.sessionId,
        stateHash: randomBytes(32).toString('hex'),
        nonceHash: randomBytes(32).toString('hex'),
        capabilities: ['gmail'],
        returnTo: 'CONNECTIONS',
        now: new Date(),
      }),
      'OPENED',
    );

    // Two people race to link the same Google account: exactly one succeeds. A conflicting
    // serializable write is retried, and the retry sees the winner. (Grants carry the real
    // clock: membership standing is judged at that instant.)
    const outcomes = await Promise.all(
      [alice, bob].map((p) =>
        repo.storeGrant(
          organizationId,
          p.userId,
          { googleSubject: sub, emailAtLink: 'shared@example.com', hostedDomain: null, grantedScopes: [GMAIL], requestedScopes: [GMAIL], sealed: sealedFor(organizationId, p.userId, sub), now: new Date() },
          { userId: p.userId },
        ),
      ),
    );
    assert.deepEqual(outcomes.map((o) => o.outcome).sort(), ['ACCOUNT_IN_USE', 'STORED']);
    assert.equal(await prisma.googleConnection.count({ where: { organizationId, activeGoogleSubject: sub } }), 1);
    const winner = outcomes[0]!.outcome === 'STORED' ? alice : bob;

    // Adding a capability updates the one row and audits the change.
    const upgraded = await repo.storeGrant(
      organizationId,
      winner.userId,
      { googleSubject: sub, emailAtLink: 'shared@example.com', hostedDomain: null, grantedScopes: [GMAIL, CALENDAR], requestedScopes: [CALENDAR], sealed: sealedFor(organizationId, winner.userId, sub), now: new Date() },
      { userId: winner.userId },
    );
    assert.equal(upgraded.outcome, 'STORED');
    const row = await prisma.googleConnection.findFirstOrThrow({ where: { organizationId, userId: winner.userId } });
    assert.deepEqual(row.grantedScopes, [GMAIL, CALENDAR]);
    assert.deepEqual([...row.requestedScopes].sort(), [CALENDAR, GMAIL].sort());
    const credential = await repo.credential(organizationId, winner.userId);
    assert.equal(sealer.open({ organizationId, userId: winner.userId, googleSubject: sub }, credential!.sealed), `1//refresh-${sub}`);

    // Offboarding: the membership change and the revocation commit together.
    const ended = await iam.disableMember(organizationId, winner.userId, { userId: carol.userId, name: 'Admin' });
    assert.equal(ended.changed, true);
    assert.equal(ended.googleRevocation?.googleSubject, sub);
    const revoked = await prisma.googleConnection.findFirstOrThrow({ where: { organizationId, userId: winner.userId } });
    assert.deepEqual([revoked.status, revoked.refreshTokenSealed, revoked.activeGoogleSubject, revoked.revocationReason], ['REVOKED', null, null, 'MEMBER_DISABLED']);
    const membership = await prisma.organizationMembership.findFirstOrThrow({ where: { organizationId, userId: winner.userId } });
    assert.equal(membership.status, 'DISABLED');
    assert.equal(await prisma.googleOAuthState.count({ where: { organizationId, userId: winner.userId } }), 0);
    assert.ok((await prisma.auditLog.count({ where: { organizationId, action: 'google.connection.revoked' } })) === 1);
    await repo.recordRevocationResult(organizationId, revoked.id, { confirmed: false, failureClass: 'REVOKE_UNCONFIRMED' }, NOW, { userId: carol.userId });
    assert.equal((await prisma.googleConnection.findFirstOrThrow({ where: { id: revoked.id } })).lastFailureClass, 'REVOKE_UNCONFIRMED');

    // The account is released: the other person may now link it.
    const loser = winner === alice ? bob : alice;
    const second = await repo.storeGrant(
      organizationId,
      loser.userId,
      { googleSubject: sub, emailAtLink: 'shared@example.com', hostedDomain: null, grantedScopes: [GMAIL], requestedScopes: [GMAIL], sealed: sealedFor(organizationId, loser.userId, sub), now: new Date() },
      { userId: loser.userId },
    );
    assert.equal(second.outcome, 'STORED');
    assert.equal(await repo.markExpired(organizationId, loser.userId, (second as { connectionId: string }).connectionId, 'REFRESH_REFUSED', NOW), true);
    const expired = await prisma.googleConnection.findFirstOrThrow({ where: { organizationId, userId: loser.userId } });
    assert.deepEqual([expired.status, expired.refreshTokenSealed, expired.activeGoogleSubject], ['EXPIRED', null, sub]);

  } finally {
    if (organizationId) await prisma.organization.deleteMany({ where: { id: organizationId } });
    await prisma.$disconnect();
  }
});

// --- Who the scheduled Calendar cycle may attempt (DL-5) -------------------------------------

test('eligibility is one organization, one capability, and a connection that can actually be read', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  const organizations: string[] = [];
  try {
    const home = await tenant(prisma, 'cycle', 6);
    const away = await tenant(prisma, 'cycle_away', 1);
    organizations.push(home.organizationId, away.organizationId);
    const repo = new GoogleConnectionRepository(prisma);
    const [ready, gmailOnly, expired, revoked, disabled, unconnected] = home.users as {
      userId: string;
      sessionId: string;
    }[];
    const connection = (userId: string, over: Record<string, unknown> = {}) => {
      const sub = `sub_${randomUUID().slice(0, 12)}`;
      const sealed = sealedFor(home.organizationId, userId, sub);
      return prisma.googleConnection.create({
        data: {
          organizationId: home.organizationId,
          userId,
          googleSubject: sub,
          activeGoogleSubject: sub,
          emailAtLink: `${userId}@example.com`,
          status: 'CONNECTED',
          grantedScopes: [CALENDAR],
          requestedScopes: [CALENDAR],
          refreshTokenSealed: Buffer.from(sealed.sealed),
          sealVersion: sealed.sealVersion,
          keyRef: sealed.keyRef,
          connectedAt: NOW,
          ...over,
        } as any,
      });
    };

    await connection(ready!.userId);
    await connection(gmailOnly!.userId, { grantedScopes: [GMAIL, GMAIL_SEND], requestedScopes: [GMAIL, GMAIL_SEND] });
    // A lapsed or withdrawn grant keeps no credential, by CHECK constraint. Neither is worth a
    // Google request: both need the employee, not the scheduler.
    await connection(expired!.userId, { status: 'EXPIRED', expiredAt: NOW, refreshTokenSealed: null, sealVersion: null, keyRef: null });
    await connection(revoked!.userId, {
      status: 'REVOKED',
      activeGoogleSubject: null,
      revokedAt: NOW,
      revocationReason: 'SELF_DISCONNECT',
      refreshTokenSealed: null,
      sealVersion: null,
      keyRef: null,
    });
    await connection(disabled!.userId);
    await prisma.organizationMembership.update({
      where: { userId_organizationId: { userId: disabled!.userId, organizationId: home.organizationId } },
      data: { status: 'DISABLED' },
    });
    // `unconnected` holds no connection at all.

    const eligible = await repo.connectedMembers(home.organizationId, 'calendar');
    assert.deepEqual(eligible, [{ userId: ready!.userId }], 'only a live, calendar-scoped connection behind an active membership');
    assert.equal(eligible.some((m) => m.userId === unconnected!.userId), false);

    // The capability is the filter, not "has any Google connection" -- and Gmail's filter is
    // BOTH its scopes, so a half-granted Gmail is not eligible for a pass that would fail.
    assert.deepEqual(await repo.connectedMembers(home.organizationId, 'gmail'), [{ userId: gmailOnly!.userId }]);
    await prisma.googleConnection.updateMany({ where: { organizationId: home.organizationId, userId: gmailOnly!.userId }, data: { grantedScopes: [GMAIL] } });
    assert.deepEqual(await repo.connectedMembers(home.organizationId, 'gmail'), [], 'read without send cannot answer mail');
    assert.deepEqual(await repo.connectedMembers(home.organizationId, 'drive'), []);

    // And it is one tenant's question. Another organization's connected member is not returned
    // here, whoever asks -- there is no platform-wide sweep to be had from this method.
    const [visitor] = away.users as { userId: string }[];
    const sub = `sub_${randomUUID().slice(0, 12)}`;
    const sealed = sealer.seal({ organizationId: away.organizationId, userId: visitor!.userId, googleSubject: sub }, `1//refresh-${sub}`);
    await prisma.googleConnection.create({
      data: {
        organizationId: away.organizationId,
        userId: visitor!.userId,
        googleSubject: sub,
        activeGoogleSubject: sub,
        emailAtLink: 'visitor@example.com',
        status: 'CONNECTED',
        grantedScopes: [CALENDAR],
        requestedScopes: [CALENDAR],
        refreshTokenSealed: Buffer.from(sealed.sealed),
        sealVersion: sealed.sealVersion,
        keyRef: sealed.keyRef,
        connectedAt: NOW,
      } as any,
    });
    assert.deepEqual(await repo.connectedMembers(home.organizationId, 'calendar'), [{ userId: ready!.userId }]);
    assert.deepEqual(await repo.connectedMembers(away.organizationId, 'calendar'), [{ userId: visitor!.userId }]);

    // 5. EMPLOYEE #3. The member who had no connection now grants Gmail and Calendar. The cycle's own
    // query includes them from that moment: no variable, list, argument or deploy names them.
    await connection(unconnected!.userId, { grantedScopes: [GMAIL, GMAIL_SEND, CALENDAR], requestedScopes: [GMAIL, GMAIL_SEND, CALENDAR] });
    const ids = async (capability: 'gmail' | 'calendar') => (await repo.connectedMembers(home.organizationId, capability)).map((m) => m.userId).sort();
    assert.deepEqual(await ids('calendar'), [ready!.userId, unconnected!.userId].sort());
    assert.deepEqual(await ids('gmail'), [unconnected!.userId], 'the half-granted Gmail above is still not eligible');
  } finally {
    for (const id of organizations) await prisma.organization.delete({ where: { id } }).catch(() => undefined);
    await prisma.$disconnect();
  }
});

// --- The Gmail scopes the database itself permits (GM-1) -------------------------------------

test('the database permits exactly the approved scopes, including the two Gmail now needs', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  let organizationId = '';
  try {
    const home = await tenant(prisma, 'scopes', 1);
    organizationId = home.organizationId;
    const [{ userId }] = home.users as [{ userId: string }];
    const sub = `sub_${randomUUID().slice(0, 12)}`;
    const sealed = sealedFor(organizationId, userId, sub);
    const base = {
      organizationId,
      userId,
      googleSubject: sub,
      activeGoogleSubject: sub,
      emailAtLink: 'person@example.com',
      status: 'CONNECTED',
      refreshTokenSealed: Buffer.from(sealed.sealed),
      sealVersion: sealed.sealVersion,
      keyRef: sealed.keyRef,
      connectedAt: NOW,
    };

    // The Gmail capability's two scopes are accepted together...
    const accepted = await prisma.googleConnection.create({
      data: { ...base, grantedScopes: [GMAIL, GMAIL_SEND], requestedScopes: [GMAIL, GMAIL_SEND] } as any,
    });
    assert.deepEqual([...accepted.grantedScopes].sort(), [GMAIL, GMAIL_SEND].sort());
    await prisma.googleConnection.delete({ where: { id: accepted.id } });

    // ...and so is a connection made before GM-1, which is why it can ask to reconnect rather
    // than being a row the database now refuses.
    const legacy = await prisma.googleConnection.create({
      data: { ...base, grantedScopes: [GMAIL_LEGACY], requestedScopes: [GMAIL_LEGACY] } as any,
    });
    await prisma.googleConnection.delete({ where: { id: legacy.id } });

    // Every scope that would let Loop write to, relabel or delete a mailbox is still refused by
    // the database itself, whatever any caller believes.
    for (const broader of [
      'https://www.googleapis.com/auth/gmail.modify',
      'https://www.googleapis.com/auth/gmail.compose',
      'https://www.googleapis.com/auth/gmail.insert',
      'https://www.googleapis.com/auth/gmail.labels',
      'https://mail.google.com/',
      'https://www.googleapis.com/auth/drive',
    ]) {
      await refused(
        prisma.googleConnection.create({ data: { ...base, grantedScopes: [GMAIL, broader], requestedScopes: [GMAIL] } as any }),
        '23514',
        broader,
      );
    }
  } finally {
    if (organizationId) await prisma.organization.delete({ where: { id: organizationId } }).catch(() => undefined);
    await prisma.$disconnect();
  }
});
