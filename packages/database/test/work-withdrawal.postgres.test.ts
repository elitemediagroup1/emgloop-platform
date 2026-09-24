// Derived (MODEL-produced) work at the two ends of a Telegram connection, against a REAL Postgres.
// Local only (LOOP_TEST_POSTGRES_URL). The revoke path is proven in
// source-content-authorization.postgres.test.ts; this file proves the other two rows of §21.2
// (docs/architecture/daily-loop-employee-intelligence.md, dated 2026-09-24).
//
// WHAT IT PROVES, THAT AN IN-MEMORY DOUBLE CANNOT
//   - GRACE-WINDOW EXPIRY: discovery returns only connections that are NOT live with a disconnect
//     older than WORK_DISCONNECT_GRACE_DAYS; the scoped delete removes exactly that principal's
//     Telegram-derived items (observations with them), leaves a live or within-grace connection and
//     every other principal alone, and writes one audit row with counts -- and none when nothing was
//     deleted. A connection that is live again is refused even if discovery returned it.
//   - OFFBOARDING (the gap closed 2026-09-24): disabling or removing a member ends their Telegram
//     connection in the SAME transaction -- credential cleared, DISCONNECTED, gone from the worker's
//     cross-tenant discovery -- and stamps their content consent revoked, while their work rows are
//     erased; a colleague is untouched.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { SOURCE_CONNECTION_AUDIT_ACTIONS, WORK_DISCONNECT_GRACE_DAYS, telegramConversationSubjectRef } from '@emgloop/shared';

import { IamRepository } from '../src/repositories/iam.repository';
import { SourceConnectionRepository } from '../src/repositories/source-connection.repository';
import { SourceContentAuthorizationRepository } from '../src/repositories/source-content-authorization.repository';
import { WorkItemRepository } from '../src/repositories/work-state/work-item.repository';
import { WorkWithdrawalRepository } from '../src/repositories/work-state/work-withdrawal.repository';
import { ConnectionSecretSealer } from '../src/services/connections/connection-secret-sealer';

const URL = process.env.LOOP_TEST_POSTGRES_URL ?? '';
const LOCAL = /^postgres(ql)?:\/\/[^@]*@(localhost|127\.0\.0\.1)(:\d+)?\//.test(URL);
const skip = !URL ? 'LOOP_TEST_POSTGRES_URL is not set' : !LOCAL ? 'refusing a non-local database' : false;

const NOW = new Date('2026-09-24T12:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY_MS);
const TRIAGE_PRODUCER = 'telegram.content.triage';
const sealer = new ConnectionSecretSealer(randomBytes(32));

async function tenant(prisma: PrismaClient, label: string, people = 1) {
  const organizationId = `org_ww_${label}_${randomUUID()}`;
  await prisma.organization.create({ data: { id: organizationId, name: `WW ${label}`, slug: organizationId } });
  const users: string[] = [];
  for (let i = 0; i < people; i += 1) {
    const userId = `user_ww_${label}_${i}_${randomUUID()}`;
    await prisma.user.create({ data: { id: userId, organizationId, email: `${userId}@example.test`, name: 'WW', status: 'ACTIVE', metadata: { systemRole: 'EMPLOYEE', passwordHash: 'kept' } } });
    await prisma.organizationMembership.create({ data: { organizationId, userId, systemRole: 'EMPLOYEE', status: 'ACTIVE', effectiveFrom: new Date('2026-01-01T00:00:00Z') } });
    users.push(userId);
  }
  return { organizationId, users };
}

function derived(conversationKey: string, anchorId: number, title: string) {
  return {
    recurrenceKey: `${TRIAGE_PRODUCER}:${conversationKey}:${conversationKey}:${anchorId}`,
    class: 'NEEDS_YOU' as const,
    subjectKind: 'THREAD' as const,
    subjectRef: telegramConversationSubjectRef(conversationKey),
    title,
    producerKind: 'MODEL' as const,
    producerId: TRIAGE_PRODUCER,
    producerVersion: '2.1.0',
    evidence: { provider: 'TELEGRAM', providerEventId: `${conversationKey}:${anchorId}`, conversationKey, topic: 'Kickoff call', counterpartyLabel: 'Alice Displayname' },
    detectedAt: NOW,
  };
}

/**
 * A live content authorization, seeded directly. A derived (MODEL, Telegram) item is written only under
 * one: detect re-checks it inside its own transaction (2026-09-24). A disconnect does not revoke consent
 * (only the employee's revoke or an offboarding does), so a disconnected principal can still hold it.
 */
async function consented(prisma: PrismaClient, organizationId: string, userId: string) {
  await prisma.sourceContentAuthorization.create({ data: { organizationId, userId, provider: 'TELEGRAM', authorizedAt: daysAgo(60) } });
}

async function disconnected(prisma: PrismaClient, organizationId: string, userId: string, provider: 'TELEGRAM' | 'MICROSOFT_TEAMS', disconnectedAt: Date | null, state = 'DISCONNECTED') {
  return prisma.sourceConnection.create({
    data: { organizationId, userId, provider, state, disconnectedAt, backgroundObservation: 'UNAVAILABLE', connectedAt: daysAgo(90) },
  });
}

test('grace-window expiry: discovery finds only past-grace non-live connections; the scoped delete removes one principal\'s derived items and audits counts', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  const connections = new SourceConnectionRepository(prisma);
  const items = new WorkItemRepository(prisma);
  try {
    const { organizationId, users: [pastGrace, withinGrace, liveAgain, staleLive, nothingLeft, teams] } = await tenant(prisma, 'expiry', 6);
    // Past grace (31 days), within grace (29 days), live again (READY, disconnectedAt stale from an old
    // disconnect), RECONNECT_REQUIRED (live: never a disconnect anchor), past grace with no derived
    // items, and a Teams connection past grace (no derived-subject prefix).
    await disconnected(prisma, organizationId, pastGrace, 'TELEGRAM', daysAgo(WORK_DISCONNECT_GRACE_DAYS + 1));
    await disconnected(prisma, organizationId, withinGrace, 'TELEGRAM', daysAgo(WORK_DISCONNECT_GRACE_DAYS - 1));
    await disconnected(prisma, organizationId, liveAgain, 'TELEGRAM', daysAgo(40), 'READY');
    await disconnected(prisma, organizationId, staleLive, 'TELEGRAM', null, 'RECONNECT_REQUIRED');
    await disconnected(prisma, organizationId, nothingLeft, 'TELEGRAM', daysAgo(40));
    await disconnected(prisma, organizationId, teams, 'MICROSOFT_TEAMS', daysAgo(40));

    for (const [user, key] of [[pastGrace, 'ck_p'], [withinGrace, 'ck_w'], [liveAgain, 'ck_l'], [staleLive, 'ck_s']] as const) {
      const P = { organizationId, userId: user };
      await consented(prisma, organizationId, user);
      const a = (await items.detect(P, derived(key, 1, 'first obligation')))!;
      await items.record(P, a.id, { state: 'RESOLVED', observationType: 'RESOLVED', occurredAt: NOW, outcome: 'HANDLED' });
      await items.detect(P, derived(key, 2, 'second obligation'));
      // A RULE item on the same person survives an expiry: only derived items are governed here.
      await items.detect(P, { ...derived(key, 3, 'mail thread'), recurrenceKey: `mail:${key}`, producerKind: 'RULE', producerId: 'mail-attention', subjectRef: `t_${key}`, evidence: {} });
    }
    const countsFor = async (user: string) => ({
      items: await prisma.workItem.count({ where: { organizationId, userId: user } }),
      observations: await prisma.workItemObservation.count({ where: { organizationId, userId: user } }),
    });
    assert.deepEqual(await countsFor(pastGrace), { items: 3, observations: 4 });

    // DISCOVERY: platform-wide, routing fields only, exactly the past-grace non-live rows.
    const due = (await connections.dueForDerivedExpiry(NOW, 500)).filter((d) => d.organizationId === organizationId);
    assert.deepEqual(due.map((d) => d.userId).sort(), [nothingLeft, pastGrace, teams].sort());
    assert.deepEqual(Object.keys(due[0]!).sort(), ['organizationId', 'provider', 'userId'], 'routing fields only');

    // EXPIRY: the past-grace principal loses exactly the derived items and their observations.
    const expired = await connections.expireDerivedWork(organizationId, pastGrace, 'TELEGRAM', { now: NOW });
    assert.deepEqual(expired, { outcome: 'EXPIRED', items: 2, observations: 3, digests: 0 });
    assert.deepEqual(await countsFor(pastGrace), { items: 1, observations: 1 }, 'the RULE item and its log remain');
    assert.equal((await items.items({ organizationId, userId: pastGrace }))[0]!.producerKind, 'RULE');

    // Within grace, live again, RECONNECT_REQUIRED: refused by the scoped delete, whatever discovery said.
    for (const user of [withinGrace, liveAgain, staleLive]) {
      assert.deepEqual(await connections.expireDerivedWork(organizationId, user, 'TELEGRAM', { now: NOW }), { outcome: 'NOTHING_TO_DO' });
      assert.deepEqual(await countsFor(user), { items: 3, observations: 4 }, 'untouched');
    }
    // Nothing to delete, and a provider with no derived work: NOTHING_TO_DO, and no audit row.
    assert.deepEqual(await connections.expireDerivedWork(organizationId, nothingLeft, 'TELEGRAM', { now: NOW }), { outcome: 'NOTHING_TO_DO' });
    assert.deepEqual(await connections.expireDerivedWork(organizationId, teams, 'MICROSOFT_TEAMS', { now: NOW }), { outcome: 'NOTHING_TO_DO' });
    // The grace window is the repository's, from the shared constant: a "now" one day earlier keeps the row.
    assert.deepEqual(await connections.expireDerivedWork(organizationId, withinGrace, 'TELEGRAM', { now: daysAgo(-2) }), { outcome: 'EXPIRED', items: 2, observations: 3, digests: 0 }, 'two days later it is past grace');

    // ONE audit row per principal that lost rows, counts only, never an item.
    const audit = await prisma.auditLog.findMany({ where: { organizationId, action: SOURCE_CONNECTION_AUDIT_ACTIONS.derived_expired } });
    assert.equal(audit.length, 2);
    const forPast = audit.find((a) => (a.metadata as any).subjectUserId === pastGrace)!;
    assert.deepEqual((forPast.metadata as any).deleted, { items: 2, observations: 3 });
    assert.equal((forPast.metadata as any).graceDays, WORK_DISCONNECT_GRACE_DAYS);
    assert.equal(forPast.actorType, 'SYSTEM');
    assert.equal(JSON.stringify(forPast).includes('obligation'), false, 'counts only');
    assert.equal(JSON.stringify(forPast).includes('Kickoff'), false);

    // Expiring the same principal again: nothing left, nothing recorded.
    assert.deepEqual(await connections.expireDerivedWork(organizationId, pastGrace, 'TELEGRAM', { now: NOW }), { outcome: 'NOTHING_TO_DO' });
    assert.equal(await prisma.auditLog.count({ where: { organizationId, action: SOURCE_CONNECTION_AUDIT_ACTIONS.derived_expired } }), 2);
  } finally {
    await prisma.$disconnect();
  }
});

test('deleteDerived is scoped to the principal and the provider prefix; the withdrawal repository never reaches another person', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  const items = new WorkItemRepository(prisma);
  try {
    const { organizationId, users: [alice, bob] } = await tenant(prisma, 'scope', 2);
    await consented(prisma, organizationId, alice);
    await consented(prisma, organizationId, bob);
    await items.detect({ organizationId, userId: alice }, derived('ck_a', 1, 'alice'));
    await items.detect({ organizationId, userId: bob }, derived('ck_b', 1, 'bob'));
    const deleted = await prisma.$transaction((tx) => new WorkWithdrawalRepository(tx).deleteDerived({ organizationId, userId: alice }, { provider: 'TELEGRAM' }));
    assert.deepEqual(deleted, { items: 1, observations: 1 });
    assert.equal(await prisma.workItem.count({ where: { organizationId, userId: alice } }), 0);
    assert.equal(await prisma.workItem.count({ where: { organizationId, userId: bob } }), 1, "Bob's item is not Alice's to lose");
    assert.deepEqual(
      await prisma.$transaction((tx) => new WorkWithdrawalRepository(tx).deleteDerived({ organizationId, userId: bob }, { provider: 'MICROSOFT_TEAMS' })),
      { items: 0, observations: 0 },
      'a provider with no derived-subject prefix deletes nothing',
    );
    await assert.rejects(
      () => new WorkWithdrawalRepository(prisma).withdrawDerived({ organizationId, userId: '' }, { provider: 'TELEGRAM', occurredAt: NOW, reason: 'x' }),
      /requires both organizationId and userId/,
    );
  } finally {
    await prisma.$disconnect();
  }
});

for (const act of ['disableMember', 'removeMember'] as const) {
  test(`${act}: the Telegram credential is cleared, the connection ended, the content consent revoked and the derived items erased -- in one transaction; a colleague is untouched`, { skip }, async () => {
    const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
    const connections = new SourceConnectionRepository(prisma);
    const content = new SourceContentAuthorizationRepository(prisma);
    const items = new WorkItemRepository(prisma);
    try {
      const { organizationId, users: [admin, leaver, colleague] } = await tenant(prisma, act, 3);
      await prisma.user.update({ where: { id: admin }, data: { metadata: { systemRole: 'ADMIN' } } });
      for (const user of [leaver, colleague]) {
        await connections.beginConnect(organizationId, user, 'TELEGRAM', { actor: { userId: user }, now: NOW });
        const stored = await connections.storeCredential(
          organizationId, user, 'TELEGRAM',
          { credentialKind: 'MTPROTO_SESSION', adapter: null, accountLabel: '@x', backgroundObservation: 'OPERATIONAL', sealed: sealer.seal({ organizationId, userId: user, provider: 'TELEGRAM', credentialKind: 'MTPROTO_SESSION' }, `session-${user}`), cursor: '7', now: NOW },
          { userId: user },
        );
        assert.equal(stored.outcome, 'STORED');
        assert.equal((await content.authorize(organizationId, user, 'TELEGRAM', { now: NOW, actor: { userId: user } })).outcome, 'AUTHORIZED');
        await items.detect({ organizationId, userId: user }, derived(`ck_${user.slice(0, 8)}`, 1, 'an obligation'));
      }
      // Before: both are live for the worker's cross-tenant discovery, and both consents stand.
      const dueBefore = new Set((await connections.dueForObservation(2000)).map((d) => d.userId));
      assert.ok(dueBefore.has(leaver) && dueBefore.has(colleague));
      assert.ok(new Set((await content.dueForContent(2000)).map((d) => d.userId)).has(leaver));

      const result = await new IamRepository(prisma)[act](organizationId, leaver, { userId: admin, name: 'Admin' });
      assert.equal(result.changed, true);

      // The hard guarantee: no credential, DISCONNECTED, not discoverable, consent revoked, rows gone.
      const ended = (await connections.find(organizationId, leaver, 'TELEGRAM'))!;
      assert.equal(ended.state, 'DISCONNECTED');
      assert.equal(ended.hasCredential, false, 'the sealed session is destroyed in the offboarding transaction');
      assert.equal(ended.disconnectedAt !== null, true, 'the grace-window anchor is stamped');
      assert.equal(await connections.credential(organizationId, leaver, 'TELEGRAM'), null, 'the worker has nothing to open');
      const dueAfter = new Set((await connections.dueForObservation(2000)).map((d) => d.userId));
      assert.equal(dueAfter.has(leaver), false, 'gone from the observation sweep');
      assert.equal(dueAfter.has(colleague), true, 'the colleague is still due');
      const consent = (await content.get(organizationId, leaver, 'TELEGRAM'))!;
      assert.equal(consent.authorized, false);
      assert.equal(consent.revokedAt !== null, true, 'consent never outlives the membership');
      assert.equal(new Set((await content.dueForContent(2000)).map((d) => d.userId)).has(leaver), false, 'gone from the content sweep');
      assert.equal(await prisma.workItem.count({ where: { organizationId, userId: leaver } }), 0, 'the derived items are erased');

      // The colleague: untouched in every respect.
      assert.equal((await connections.find(organizationId, colleague, 'TELEGRAM'))?.hasCredential, true);
      assert.equal((await content.get(organizationId, colleague, 'TELEGRAM'))?.authorized, true);
      assert.equal(await prisma.workItem.count({ where: { organizationId, userId: colleague } }), 1);

      // The acts are recorded: the connection ended, the consent revoked with the offboarding reason.
      const offboarded = await prisma.auditLog.findMany({ where: { organizationId, action: SOURCE_CONNECTION_AUDIT_ACTIONS.offboarded } });
      assert.equal(offboarded.length, 1);
      assert.equal((offboarded[0]!.metadata as any).subjectUserId, leaver);
      assert.equal((offboarded[0]!.metadata as any).credentialDeleted, true);
      assert.equal(offboarded[0]!.userId, admin, 'attributed to the administrator who acted');
      const revoked = await prisma.auditLog.findMany({ where: { organizationId, action: SOURCE_CONNECTION_AUDIT_ACTIONS.content_revoked } });
      assert.equal(revoked.length, 1);
      assert.equal((revoked[0]!.metadata as any).reason, act === 'disableMember' ? 'MEMBER_DISABLED' : 'MEMBER_REMOVED');
      assert.equal(JSON.stringify([...offboarded, ...revoked]).includes('session-'), false, 'never a secret in the record');

      // Ending it again writes no second connection or consent row.
      await new IamRepository(prisma).removeMember(organizationId, leaver, { userId: admin });
      assert.equal(await prisma.auditLog.count({ where: { organizationId, action: SOURCE_CONNECTION_AUDIT_ACTIONS.offboarded } }), 1);
      assert.equal(await prisma.auditLog.count({ where: { organizationId, action: SOURCE_CONNECTION_AUDIT_ACTIONS.content_revoked } }), 1);
    } finally {
      await prisma.$disconnect();
    }
  });
}
