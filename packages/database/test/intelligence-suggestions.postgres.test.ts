// D1 identity match suggestions and D2 attendee keys, against a REAL Postgres: the constraints
// the migration adds, the whole suggestion lifecycle through the real services, and offboarding.
//
// OPT-IN AND LOCAL ONLY (LOOP_TEST_POSTGRES_URL, localhost). See google-connection.postgres.test.ts
// for how to run it.
//
// WHY A DATABASE TEST. Three guarantees live in the schema rather than in code, and a test double
// cannot prove them: the unique (organization, match key, evidence fingerprint) that makes a
// rejection permanent against unchanged evidence even under a race; the CHECKs that refuse a
// decided suggestion with no person or reason; and the CHECK that refuses anything but a one-way
// key in `work_events.attendeeHashes`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

import { IamRepository, WORK_STATE_ERASED_AUDIT_ACTION } from '../src/repositories/iam.repository';
import { IdentityEvidenceRepository, IdentitySuggestionRepository } from '../src/repositories/cognitive';
import { WorkGraphRepository } from '../src/repositories/work-state';
import { PartyService } from '../src/services/party.service';
import { IdentitySuggestionService } from '../src/services/identity-suggestion.service';
import { SourceReadDispatcher, personalIntelligence, sourceReadDetectors } from '../src/services/intelligence';

// Identity suggestions compare only under a CONFIGURED identifier key (never the development
// fallback). This process is the test, so it configures one.
process.env.COGNITIVE_HASH_SECRET ||= 'test-identifier-key';

const URL = process.env.LOOP_TEST_POSTGRES_URL ?? '';
const LOCAL = /^postgres(ql)?:\/\/[^@]*@(localhost|127\.0\.0\.1)(:\d+)?\//.test(URL);
const skip = !URL ? 'LOOP_TEST_POSTGRES_URL is not set' : !LOCAL ? 'refusing a non-local database' : false;
const NOW = new Date('2026-09-20T15:00:00Z');
const H = 3_600_000;
const key = (address: string) => createHash('sha256').update(address.trim().toLowerCase()).digest('hex');

async function member(prisma: PrismaClient, organizationId: string, label: string, role: string) {
  const userId = `user_${label}_${randomUUID()}`;
  await prisma.user.create({ data: { id: userId, organizationId, email: `${userId}@example.test`, name: label, status: 'ACTIVE', metadata: { systemRole: role, passwordHash: 'kept' } } });
  await prisma.organizationMembership.create({ data: { organizationId, userId, systemRole: role as never, status: 'ACTIVE' } });
  return { organizationId, userId };
}

async function mailFromDana(prisma: PrismaClient, who: { organizationId: string; userId: string }) {
  const graph = new WorkGraphRepository(prisma);
  const at = new Date(NOW.getTime() - 3 * H);
  await graph.recordCorrespondent(who, { addressHash: key('dana@acme.test'), displayAddress: 'dana@acme.test', displayName: 'Dana', domain: 'acme.test', seenAt: at, direction: 'INBOUND' });
  await graph.upsertThread(who, { provider: 'GOOGLE', threadId: 't-dana', subject: 'Renewal', participantHashes: [key('dana@acme.test')], messageCount: 1, firstMessageAt: at, lastMessageAt: at, lastDirection: 'INBOUND', lastMessageId: 'm1', labels: ['INBOX', 'UNREAD'] });
  await graph.upsertEvent(who, {
    provider: 'GOOGLE', eventId: 'ev-review', startsAt: new Date(NOW.getTime() + 20 * H), endsAt: new Date(NOW.getTime() + 21 * H), summary: 'Review',
    status: 'CONFIRMED', kind: 'DEFAULT', blocking: 'BLOCKING', attendanceKnown: true, attendeeCount: 2, externalAttendeeCount: 1,
    organizerHash: key('me@emg.test'), organizerIsSelf: true, attendeeHashes: [key('dana@acme.test')], observedAt: NOW,
  });
}

const read = (prisma: PrismaClient, who: { organizationId: string; userId: string }, at = NOW) =>
  new SourceReadDispatcher(sourceReadDetectors(prisma)).dispatch({ organizationId: who.organizationId, userId: who.userId, source: 'GMAIL', completedAt: at });

test('D1 and D2 against Postgres: lifecycle, constraints and offboarding', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  const organizationId = `org_d1d2_${randomUUID()}`;
  try {
    await prisma.organization.create({ data: { id: organizationId, name: 'D1 D2', slug: organizationId } });
    const matt = await member(prisma, organizationId, 'matt', 'OWNER');
    const charlie = await member(prisma, organizationId, 'charlie', 'OWNER');

    // An established Party with an identifier the organization recorded.
    const parties = new PartyService(prisma);
    const made = await parties.create(organizationId, matt.userId, { partyType: 'PERSON', displayName: 'Dana Diaz' });
    assert.equal(made.outcome, 'RECORDED');
    const dana = made.outcome === 'RECORDED' ? made.party.id : '';
    assert.equal((await parties.establish(organizationId, matt.userId, dana, 'MANUAL')).outcome, 'RECORDED');
    await new IdentityEvidenceRepository(prisma).record(organizationId, { identityId: dana, evidenceType: 'EMAIL', rawValue: 'dana@acme.test', source: 'crm-entry' });

    for (const who of [matt, charlie]) await mailFromDana(prisma, who);

    // D2: keys are stored; an address, keys without known attendance, or too many are refused.
    const stored = await prisma.workEvent.findFirstOrThrow({ where: { organizationId, userId: matt.userId, eventId: 'ev-review' } });
    assert.deepEqual(stored.attendeeHashes, [key('dana@acme.test')]);
    const base = { organizationId, userId: matt.userId, provider: 'GOOGLE', status: 'CONFIRMED', observedAt: NOW };
    await assert.rejects(prisma.workEvent.create({ data: { ...base, eventId: 'bad-address', attendanceKnown: true, attendeeHashes: ['dana@acme.test'] } }), /work_events_attendee_keys_check/);
    await assert.rejects(prisma.workEvent.create({ data: { ...base, eventId: 'bad-unknown', attendanceKnown: false, attendeeHashes: [key('x@y.test')] } }), /work_events_attendee_keys_check/);
    const many = Array.from({ length: 51 }, (_, i) => key(`p${i}@y.test`));
    await assert.rejects(prisma.workEvent.create({ data: { ...base, eventId: 'bad-many', attendanceKnown: true, attendeeHashes: many } }), /work_events_attendee_keys_check/);

    // D1: the read proposes one private suggestion per person, and nothing more on a re-read.
    for (const who of [matt, charlie]) await read(prisma, who);
    await read(prisma, matt, new Date(NOW.getTime() + H));
    const suggestions = new IdentitySuggestionRepository(prisma);
    const [mine] = await suggestions.forOwner(matt);
    const [theirs] = await suggestions.forOwner(charlie);
    assert.equal(mine!.status, 'PROPOSED');
    assert.equal(await prisma.intelligenceHypothesis.count({ where: { organizationId } }), 2, 'one per person, never duplicated');
    const row = await prisma.intelligenceHypothesis.findUniqueOrThrow({ where: { id: mine!.id } });
    assert.equal(JSON.stringify(row).includes('dana@acme.test'), false, 'no address is stored with a suggestion');

    // The unique index makes the same evidence one suggestion, even for a racing writer.
    await assert.rejects(
      prisma.intelligenceHypothesis.create({
        data: { organizationId, privateToUserId: matt.userId, hypothesisType: row.hypothesisType, subjectIdentityId: dana, title: 'dup', generatedBy: 'DETERMINISTIC_RULE', matchKey: row.matchKey, evidenceFingerprint: row.evidenceFingerprint, evidenceRefs: row.evidenceRefs as never },
      }),
      /Unique constraint/,
    );
    // A private suggestion belongs to a member of the same organization.
    await assert.rejects(
      prisma.intelligenceHypothesis.create({
        data: { organizationId, privateToUserId: 'not-a-member', hypothesisType: row.hypothesisType, subjectIdentityId: dana, title: 'x', generatedBy: 'DETERMINISTIC_RULE', matchKey: 'k', evidenceFingerprint: 'f', evidenceRefs: {} },
      }),
      /Foreign key constraint/,
    );
    // No decided suggestion without a person, or a rejection without a reason -- whoever writes it.
    await assert.rejects(prisma.intelligenceHypothesis.update({ where: { id: mine!.id }, data: { status: 'ACCEPTED' } }), /intelligence_hypotheses_suggestion_decision_check/);
    await assert.rejects(prisma.intelligenceHypothesis.update({ where: { id: mine!.id }, data: { status: 'REJECTED', rejectedBy: matt.userId, rejectedAt: NOW } }), /intelligence_hypotheses_suggestion_decision_check/);

    // A person decides, under the identity authority, and only their own.
    const decisions = new IdentitySuggestionService(prisma, { now: () => NOW });
    assert.equal((await decisions.confirm(charlie, mine!.id)).outcome, 'NOT_FOUND');
    assert.equal((await decisions.confirm(matt, mine!.id)).outcome, 'CONFIRMED');
    assert.equal((await decisions.reject(charlie, theirs!.id, 'not the Dana I know')).outcome, 'REJECTED');
    const [item] = await personalIntelligence(prisma, matt, NOW);
    assert.deepEqual(item!.related.filter((r) => r.kind === 'PARTY').map((r) => [r.ref, r.verified]), [[dana, true]]);
    assert.match(item!.remembers.join(' '), /Dana is waiting on your reply, and Dana is in tomorrow's meeting\./);
    assert.match(item!.remembers.join(' '), /You confirmed Dana is Dana Diaz\./);
    // Charlie's rejection holds on his next read.
    const again = await read(prisma, charlie, new Date(NOW.getTime() + 2 * H));
    assert.equal(again.find((r) => r.detector === 'identity-suggestions')!.counts.unchanged, 1);

    // Offboarding: Charlie's attendee keys and every suggestion from his mail go; Matt's stay.
    await new IamRepository(prisma).removeMember(organizationId, charlie.userId, { userId: matt.userId });
    assert.equal(await prisma.workEvent.count({ where: { organizationId, userId: charlie.userId } }), 0);
    assert.equal(await prisma.intelligenceHypothesis.count({ where: { organizationId, privateToUserId: charlie.userId } }), 0);
    assert.equal(await prisma.workEvent.count({ where: { organizationId, userId: matt.userId } }), 1);
    assert.equal(await prisma.intelligenceHypothesis.count({ where: { organizationId, privateToUserId: matt.userId } }), 1);
    assert.equal(await prisma.identityEvidence.count({ where: { organizationId } }), 1, 'the organization’s identifier is not a person’s data');
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { organizationId, action: WORK_STATE_ERASED_AUDIT_ACTION } });
    assert.equal((audit.metadata as Record<string, unknown>).privateSuggestions, 1);
    assert.equal(JSON.stringify(audit).includes('Dana'), false, 'counts only');
  } finally {
    await prisma.intelligenceHypothesis.deleteMany({ where: { organizationId } }).catch(() => undefined);
    await prisma.identityEvidence.deleteMany({ where: { organizationId } }).catch(() => undefined);
    await prisma.cognitiveIdentity.deleteMany({ where: { organizationId } }).catch(() => undefined);
    await prisma.organization.delete({ where: { id: organizationId } }).catch(() => undefined);
    await prisma.$disconnect();
  }
});
