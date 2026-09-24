// WorkItemRepository.detect re-checks content consent INSIDE its own transaction, against a REAL
// Postgres. Local only (LOOP_TEST_POSTGRES_URL).
//
// THE RACE IT CLOSES (found by the independent review of #328). `dueForContent` snapshots a principal;
// while the worker is triaging that person's conversations they revoke content authorization (or are
// offboarded): `revoke` stamps revokedAt and withdraws every derived item in that transaction -- and
// then the sweep's in-flight `detect` CREATES a fresh OPEN paraphrase, or REFRESHES the title and
// evidence of a row the revoke had just minimized. Nothing withdraws it later. The guarantee "no derived
// intelligence after the authorization ended" has to hold at the write, so detect reads the
// authorization inside the transaction that would write and refuses: no create, no update, no
// observation, no audit.
//
// WHAT IT PROVES, THAT AN IN-MEMORY DOUBLE CANNOT (the real revoke transaction, the real withdrawal,
// the migration's CHECK constraints, the real minimized JSON)
//   - authorized: a MODEL Telegram detection creates;
//   - after the revoke (which withdrew): the SAME detection returns null and the minimized row keeps
//     title = null, its provenance-only evidence and its detectionCount, with no new observation -- and
//     a NEW obligation from the same sweep is not created either;
//   - re-authorized: the same detection on the closed REVOKED row refreshes its title and evidence and
//     appends REDETECTED WITHOUT reopening -- detect's existing semantics, observed and pinned here,
//     not changed (a follow-up recorded in #328);
//   - unaffected by this person's revoke: another principal's MODEL item, a MODEL item on a subject
//     with no derived prefix, and a RULE item are all still written; a person who never consented
//     receives no derived item at all.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { telegramConversationSubjectRef } from '@emgloop/shared';

import { SourceContentAuthorizationRepository } from '../src/repositories/source-content-authorization.repository';
import { WorkItemRepository } from '../src/repositories/work-state/work-item.repository';

const URL = process.env.LOOP_TEST_POSTGRES_URL ?? '';
const LOCAL = /^postgres(ql)?:\/\/[^@]*@(localhost|127\.0\.0\.1)(:\d+)?\//.test(URL);
const skip = !URL ? 'LOOP_TEST_POSTGRES_URL is not set' : !LOCAL ? 'refusing a non-local database' : false;

const T0 = new Date('2026-09-24T12:00:00Z'); // the sweep's first sighting
const T1 = new Date('2026-09-24T12:05:00Z'); // the revoke commits while the sweep is mid-flight
const T2 = new Date('2026-09-24T12:06:00Z'); // the in-flight detect lands
const T3 = new Date('2026-09-24T13:00:00Z'); // a later re-authorization
const TRIAGE_PRODUCER = 'telegram.content.triage';
const actor = (userId: string) => ({ userId });

async function tenant(prisma: PrismaClient, label: string, people = 1) {
  const organizationId = `org_dc_${label}_${randomUUID()}`;
  await prisma.organization.create({ data: { id: organizationId, name: `DC ${label}`, slug: organizationId } });
  const users: string[] = [];
  for (let i = 0; i < people; i += 1) {
    const userId = `user_dc_${label}_${i}_${randomUUID()}`;
    await prisma.user.create({ data: { id: userId, organizationId, email: `${userId}@example.test`, name: 'DC', status: 'ACTIVE', metadata: { systemRole: 'EMPLOYEE' } } });
    await prisma.organizationMembership.create({ data: { organizationId, userId, systemRole: 'EMPLOYEE', status: 'ACTIVE', effectiveFrom: new Date('2026-01-01T00:00:00Z') } });
    users.push(userId);
  }
  return { organizationId, users };
}

async function connection(prisma: PrismaClient, organizationId: string, userId: string) {
  await prisma.sourceConnection.create({
    data: { organizationId, userId, provider: 'TELEGRAM', state: 'READY', connectedAt: new Date('2026-09-10T00:00:00Z'), cursor: 'LIVE-1', backgroundObservation: 'OPERATIONAL' },
  });
}

/** What the triage producer writes: provenance keys plus the model's paraphrases. */
function derived(conversationKey: string, anchorId: number, title: string, detectedAt = T0) {
  return {
    recurrenceKey: `${TRIAGE_PRODUCER}:${conversationKey}:${conversationKey}:${anchorId}`,
    class: 'NEEDS_YOU' as const,
    subjectKind: 'THREAD' as const,
    subjectRef: telegramConversationSubjectRef(conversationKey),
    title,
    producerKind: 'MODEL' as const,
    producerId: TRIAGE_PRODUCER,
    producerVersion: '2.1.0',
    evidence: {
      provider: 'TELEGRAM',
      providerEventId: `${conversationKey}:${anchorId}`,
      conversationKey,
      aiInvocationId: 'inv-1',
      aiTaskVersion: '2.1.0',
      topic: 'Kickoff call',
      nextStep: 'Propose a new time',
      counterpartyLabel: 'Alice Displayname',
    },
    detectedAt,
  };
}

/** The words that must not be stored once the authorization has ended. */
const PARAPHRASES = ['Kickoff call', 'Propose a new time', 'Alice Displayname', 'topic', 'nextStep', 'counterpartyLabel'];

test('the revoke wins over an in-flight detect: the same detection is refused, the minimized row is untouched, and a new obligation is not created', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  const consent = new SourceContentAuthorizationRepository(prisma);
  const items = new WorkItemRepository(prisma);
  try {
    const { organizationId, users: [alice] } = await tenant(prisma, 'race');
    const P = { organizationId, userId: alice! };
    await connection(prisma, organizationId, alice!);
    assert.equal((await consent.authorize(organizationId, alice!, 'TELEGRAM', { now: T0, actor: actor(alice!) })).outcome, 'AUTHORIZED');

    // Authorized: the sweep's first sighting is written, with its opening observation.
    const first = await items.detect(P, derived('ck_a', 7, 'Send the invoice'));
    assert.ok(first, 'written while the authorization is in force');
    assert.equal(first.state, 'OPEN');
    assert.equal(first.title, 'Send the invoice');
    assert.equal(first.detectionCount, 1);
    assert.deepEqual((await items.observations(P, first.id)).map((o) => o.observationType), ['DETECTED']);

    // The revoke commits while the sweep is still triaging: it withdraws what was derived.
    assert.equal((await consent.revoke(organizationId, alice!, 'TELEGRAM', { now: T1, actor: actor(alice!) })).outcome, 'REVOKED');
    const minimized = (await items.item(P, first.id))!;
    assert.equal(minimized.state, 'RESOLVED');
    assert.equal(minimized.outcome, 'REVOKED');
    assert.equal(minimized.title, null);
    const provenanceOnly = minimized.evidence as Record<string, unknown>;
    assert.deepEqual(
      Object.keys(provenanceOnly).sort(),
      ['aiInvocationId', 'aiTaskVersion', 'conversationKey', 'minimizedAt', 'minimizedReason', 'provider', 'providerEventId'],
      'the revoke left provenance and the fact of the minimization, nothing else',
    );
    assert.deepEqual((await items.observations(P, first.id)).map((o) => o.observationType), ['DETECTED', 'RESOLVED']);
    const rowsBefore = await prisma.workItem.count({ where: { organizationId, userId: alice } });
    const auditBefore = await prisma.auditLog.count({ where: { organizationId } });

    // THE IN-FLIGHT DETECT: the same obligation re-sighted by the sweep that began before the revoke...
    assert.equal(await items.detect(P, derived('ck_a', 7, 'Send the invoice (fresh paraphrase)', T2)), null, 'the refresh is refused');
    // ...and a NEW obligation from the same sweep.
    assert.equal(await items.detect(P, derived('ck_a', 9, 'Confirm the cap', T2)), null, 'the create is refused');

    // Nothing was written: the minimized row is exactly what the revoke left, and there is no new row.
    const untouched = (await items.item(P, first.id))!;
    assert.equal(untouched.title, null, 'the refresh branch did not restore a paraphrase');
    assert.deepEqual(untouched.evidence, provenanceOnly, 'provenance-only evidence, unchanged');
    assert.equal(untouched.detectionCount, 1, 'not counted as a re-sighting');
    assert.equal(untouched.lastDetectedAt.getTime(), T0.getTime());
    assert.equal(untouched.state, 'RESOLVED');
    assert.equal(untouched.outcome, 'REVOKED');
    assert.deepEqual((await items.observations(P, first.id)).map((o) => o.observationType), ['DETECTED', 'RESOLVED'], 'no REDETECTED observation');
    assert.equal(await prisma.workItem.count({ where: { organizationId, userId: alice } }), rowsBefore, 'no new row');
    assert.equal(await prisma.workItem.count({ where: { organizationId, userId: alice, state: 'OPEN' } }), 0, 'no OPEN derived item after the authorization ended');
    const stored = JSON.stringify(await prisma.workItem.findMany({ where: { organizationId, userId: alice } }));
    for (const paraphrase of [...PARAPHRASES, 'fresh paraphrase', 'Confirm the cap']) {
      assert.equal(stored.includes(paraphrase), false, `${paraphrase} is not stored`);
    }
    // No audit entry for a write that did not happen.
    assert.equal(await prisma.auditLog.count({ where: { organizationId } }), auditBefore);
  } finally {
    await prisma.$disconnect();
  }
});

test('re-authorized: the same detection on the closed REVOKED row refreshes its title and evidence and appends REDETECTED without reopening (existing detect semantics, pinned not changed)', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  const consent = new SourceContentAuthorizationRepository(prisma);
  const items = new WorkItemRepository(prisma);
  try {
    const { organizationId, users: [alice] } = await tenant(prisma, 'reauth');
    const P = { organizationId, userId: alice! };
    await connection(prisma, organizationId, alice!);
    await consent.authorize(organizationId, alice!, 'TELEGRAM', { now: T0, actor: actor(alice!) });
    const first = (await items.detect(P, derived('ck_r', 3, 'Send the invoice')))!;
    await consent.revoke(organizationId, alice!, 'TELEGRAM', { now: T1, actor: actor(alice!) });
    assert.equal((await items.item(P, first.id))?.title, null, 'minimized by the revoke');

    // Fresh consent: the write is authorized again.
    assert.equal((await consent.authorize(organizationId, alice!, 'TELEGRAM', { now: T3, actor: actor(alice!) })).outcome, 'AUTHORIZED');
    const again = await items.detect(P, derived('ck_r', 3, 'Send the invoice', T3));
    assert.ok(again, 'written under the new authorization');
    assert.equal(again.id, first.id, 'the same situation is the same row');
    // OBSERVED, NOT DESIGNED HERE: the "seen before" branch refreshes the projection and counts a
    // re-sighting, and it never changes state -- so the row stays closed as REVOKED while carrying a
    // current title and evidence. Whether a re-detect under fresh consent should reopen is the open
    // follow-up recorded in #328; this test pins today's behaviour so a change to it is deliberate.
    assert.equal(again.state, 'RESOLVED');
    assert.equal(again.outcome, 'REVOKED');
    assert.equal(again.title, 'Send the invoice');
    assert.equal(again.detectionCount, 2);
    assert.equal(again.lastDetectedAt.getTime(), T3.getTime());
    assert.equal((again.evidence as Record<string, unknown>).topic, 'Kickoff call', 'the paraphrase is back, under a live authorization');
    assert.deepEqual((await items.observations(P, first.id)).map((o) => o.observationType), ['DETECTED', 'RESOLVED', 'REDETECTED']);
  } finally {
    await prisma.$disconnect();
  }
});

test("this person's revoke reaches nobody else and nothing else: another principal's MODEL item, a non-derived MODEL item and a RULE item are still written; a person who never consented gets no derived item", { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  const consent = new SourceContentAuthorizationRepository(prisma);
  const items = new WorkItemRepository(prisma);
  try {
    const { organizationId, users: [alice, bob, carol] } = await tenant(prisma, 'scope', 3);
    const A = { organizationId, userId: alice! };
    const B = { organizationId, userId: bob! };
    const C = { organizationId, userId: carol! };
    for (const user of [alice!, bob!]) {
      await connection(prisma, organizationId, user);
      await consent.authorize(organizationId, user, 'TELEGRAM', { now: T0, actor: actor(user) });
    }
    await consent.revoke(organizationId, alice!, 'TELEGRAM', { now: T1, actor: actor(alice!) });

    // Alice, revoked: a Telegram-derived MODEL item is refused...
    assert.equal(await items.detect(A, derived('ck_s', 1, 'An obligation', T2)), null);
    // ...but a RULE item on a mail thread needs no content authorization and is written...
    const rule = await items.detect(A, {
      recurrenceKey: 'unanswered-inbound.v1:thread-1',
      class: 'NEEDS_YOU',
      subjectKind: 'THREAD',
      subjectRef: 'thread-1',
      title: 'Ben is waiting on you',
      producerKind: 'RULE',
      producerId: 'unanswered-inbound',
      producerVersion: 'v1',
      evidence: { threadId: 'thread-1' },
      detectedAt: T2,
    });
    assert.equal(rule?.state, 'OPEN', 'a RULE item is not governed by content consent');
    // ...and so is a MODEL item whose subject carries no derived-subject prefix.
    const model = await items.detect(A, { ...derived('ck_s', 2, 'A model conclusion on mail', T2), recurrenceKey: 'some-model:thread-1', subjectRef: 'thread-1' });
    assert.equal(model?.state, 'OPEN', 'a MODEL item on a non-derived subject was not produced under this authorization');
    assert.equal(await prisma.workItem.count({ where: { organizationId, userId: alice } }), 2);

    // Bob, still authorized: written.
    const bobs = await items.detect(B, derived('ck_b', 1, 'An obligation', T2));
    assert.equal(bobs?.state, 'OPEN', "Alice's revoke is not Bob's");
    // Carol never consented (no row at all): refused.
    assert.equal(await items.detect(C, derived('ck_c', 1, 'An obligation', T2)), null, 'no authorization row is not an authorization');
    assert.equal(await prisma.workItem.count({ where: { organizationId, userId: carol } }), 0);
  } finally {
    await prisma.$disconnect();
  }
});
