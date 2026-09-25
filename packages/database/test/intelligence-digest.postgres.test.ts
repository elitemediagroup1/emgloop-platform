// Domain intelligence digests and G2 provider policies against a REAL Postgres (2026-09-24).
// OPT-IN AND LOCAL ONLY (LOOP_TEST_POSTGRES_URL, localhost).
//
// WHAT IT PROVES, THAT AN IN-MEMORY DOUBLE CANNOT
//   - The CHECK constraints: a PRINCIPAL digest names its user; an ORGANIZATION row is never a private
//     (Chats) row (PR 2); content may not carry body/text/quote/message; vocabularies are closed;
//     the composite FK refuses a user who is not a member of that organization.
//   - The repository round trip on the real schema: isolation, fingerprint versioning, expiry purge.
//   - A consent revoke deletes the provider's digests in the same transaction; offboarding erases
//     them; a disconnect past grace deletes them.
//   - ai_controls: a provider policy's ceiling is required when ACTIVE, and no other control may
//     carry one; the key namespace is its own.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { WORK_DISCONNECT_GRACE_DAYS } from '@emgloop/shared';

import { AiControlRepository } from '../src/repositories/brain/ai-control.repository';
import { IamRepository } from '../src/repositories/iam.repository';
import { IntelligenceDigestRepository, type IntelligenceDigestInput } from '../src/repositories/intelligence/intelligence-digest.repository';
import { SourceConnectionRepository } from '../src/repositories/source-connection.repository';
import { SourceContentAuthorizationRepository } from '../src/repositories/source-content-authorization.repository';

const URL = process.env.LOOP_TEST_POSTGRES_URL ?? '';
const LOCAL = /^postgres(ql)?:\/\/[^@]*@(localhost|127\.0\.0\.1)(:\d+)?\//.test(URL);
const skip = !URL ? 'LOOP_TEST_POSTGRES_URL is not set' : !LOCAL ? 'refusing a non-local database' : false;

const NOW = new Date('2026-09-24T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const at = (days: number) => new Date(NOW.getTime() + days * DAY);

async function tenant(prisma: PrismaClient, label: string, people = 2) {
  const organizationId = `org_id_${label}_${randomUUID()}`;
  await prisma.organization.create({ data: { id: organizationId, name: `ID ${label}`, slug: organizationId } });
  const users: string[] = [];
  for (let i = 0; i < people; i += 1) {
    const userId = `user_id_${label}_${i}_${randomUUID()}`;
    await prisma.user.create({ data: { id: userId, organizationId, email: `${userId}@example.test`, name: 'ID', status: 'ACTIVE', metadata: { systemRole: i === 0 ? 'OWNER' : 'EMPLOYEE', passwordHash: 'kept' } } });
    await prisma.organizationMembership.create({ data: { organizationId, userId, systemRole: i === 0 ? 'OWNER' : 'EMPLOYEE', status: 'ACTIVE', effectiveFrom: new Date('2026-01-01T00:00:00Z') } });
    users.push(userId);
  }
  return { organizationId, users };
}

function row(organizationId: string, userId: string | null, patch: Record<string, unknown> = {}) {
  return {
    organizationId, scope: 'PRINCIPAL', userId, domain: 'CHATS', subjectKind: 'CONVERSATION', subjectRef: `telegram_conversation:${randomUUID()}`,
    provider: 'TELEGRAM', content: { synthesis: 'x' }, coverage: 'CONNECTED_SUFFICIENT', windowStart: at(-7), windowEnd: at(0), evidenceCount: 1,
    lastEvidenceAt: at(-1), provenance: { producerVersion: 't' }, fingerprint: 'fp', status: 'CURRENT', generatedAt: NOW, expiresAt: at(29),
    ...patch,
  };
}

function digest(patch: Partial<IntelligenceDigestInput> = {}): IntelligenceDigestInput {
  return {
    domain: 'CHATS', subjectKind: 'CONVERSATION', subjectRef: 'telegram_conversation:ck_1', provider: 'TELEGRAM', consentBasis: 'CONTENT_AUTHORIZATION',
    content: { relevance: 'BUSINESS', synthesis: 'A renewal negotiation waiting on your quote.' }, coverage: 'CONNECTED_PARTIAL',
    windowStart: at(-7), windowEnd: at(0), evidenceCount: 3, lastEvidenceAt: at(-1),
    provenance: { sourceRefs: ['telegram_conversation:ck_1'], aiInvocationId: 'inv_1', taskId: 'telegram.content.triage', taskVersion: '2.1.0', producerVersion: 'test.1' },
    aiInvocationId: 'inv_1', fingerprint: 'fp-1', generatedAt: NOW, ...patch,
  };
}

test('the database refuses what the contract forbids, even without the repository', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  const { organizationId, users: [owner, alice] } = await tenant(prisma, 'checks');
  const other = await tenant(prisma, 'checks_other', 1);
  try {
    const create = (data: Record<string, unknown>) => prisma.intelligenceDigest.create({ data: data as never });
    await create(row(organizationId, alice!)); // the baseline passes
    await assert.rejects(() => create(row(organizationId, null)), /intelligence_digests_scope_check/, 'a PRINCIPAL digest names its user');
    // PR 2: ORGANIZATION rows exist, but only over Loop records -- the full rules are proved in
    // intelligence-fabric.postgres.test.ts. A Chats row (private, provider TELEGRAM) can never be one.
    await assert.rejects(() => create(row(organizationId, null, { scope: 'ORGANIZATION' })), /intelligence_digests_scope_check/, 'a private-domain row is never ORGANIZATION');
    await assert.rejects(() => create(row(organizationId, alice!, { scope: 'ORGANIZATION' })), /intelligence_digests_scope_check/);
    for (const key of ['body', 'text', 'quote', 'message']) {
      await assert.rejects(() => create(row(organizationId, alice!, { content: { [key]: 'the words' } })), /intelligence_digests_content_check/, key);
    }
    await assert.rejects(() => create(row(organizationId, alice!, { content: ['not', 'an', 'object'] })), /intelligence_digests_content_check/);
    await assert.rejects(() => create(row(organizationId, alice!, { content: { synthesis: 'x'.repeat(40_000) } })), /intelligence_digests_content_check/, 'bounded');
    await assert.rejects(() => create(row(organizationId, alice!, { domain: 'every thing' })), /intelligence_digests_shape_check/);
    await assert.rejects(() => create(row(organizationId, alice!, { coverage: 'GREAT' })), /intelligence_digests_shape_check/);
    await assert.rejects(() => create(row(organizationId, alice!, { subjectKind: 'DOMAIN', subjectRef: 'other' })), /intelligence_digests_shape_check/);
    await assert.rejects(() => create(row(organizationId, alice!, { evidenceCount: 2, lastEvidenceAt: null })), /intelligence_digests_shape_check/);
    await assert.rejects(() => create(row(organizationId, alice!, { provider: 'telegram raw' })), /intelligence_digests_shape_check/);
    // Someone who is not a member of THIS organization cannot own a row in it.
    await assert.rejects(() => create(row(organizationId, other.users[0]!)), /Foreign key constraint/i);
    // One current row per (person, domain, subject).
    const ref = 'telegram_conversation:dup';
    await create(row(organizationId, owner!, { subjectRef: ref }));
    await assert.rejects(() => create(row(organizationId, owner!, { subjectRef: ref })), /Unique constraint/i);
  } finally {
    await prisma.organization.delete({ where: { id: organizationId } }).catch(() => undefined);
    await prisma.organization.delete({ where: { id: other.organizationId } }).catch(() => undefined);
    await prisma.$disconnect();
  }
});

test('the repository on the real schema: isolation, versioning, expiry purge', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  const { organizationId, users: [owner, alice] } = await tenant(prisma, 'repo');
  try {
    const repo = new IntelligenceDigestRepository(prisma);
    const A = { organizationId, userId: alice! };
    await prisma.sourceContentAuthorization.create({ data: { organizationId, userId: alice!, provider: 'TELEGRAM', authorizedAt: at(-3) } });
    const first = await repo.upsert(A, digest());
    assert.equal(first.outcome, 'WRITTEN');
    assert.equal((await repo.upsert(A, digest())).outcome, 'UNCHANGED');
    const second = await repo.upsert(A, digest({ fingerprint: 'fp-2', content: { synthesis: 'Quote sent.' } }));
    assert.equal(second.outcome === 'WRITTEN' && second.digest.version, 2);
    assert.equal(await prisma.intelligenceDigest.count({ where: { organizationId } }), 1);
    assert.deepEqual(await repo.forDomain({ organizationId, userId: owner! }, 'CHATS', { now: NOW }), [], 'the OWNER reads only their own');
    assert.equal((await repo.forDomain(A, 'CHATS', { now: NOW })).length, 1);
    assert.deepEqual(await repo.upsert(A, digest({ scope: 'ORGANIZATION' })), { outcome: 'REFUSED', refusal: 'ORGANIZATION_SCOPE_RESERVED' });
    // The two metadata reads, on the real schema: metadata only, and counts with no identity.
    const meta = await repo.metadataFor(A, { now: NOW });
    assert.deepEqual(meta.map((m) => [m.domain, m.subjectKind, m.coverage, m.status, m.version]), [['CHATS', 'CONVERSATION', 'CONNECTED_PARTIAL', 'CURRENT', 2]]);
    assert.deepEqual(await repo.metadataFor({ organizationId, userId: owner! }, { now: NOW }), []);
    assert.deepEqual(await repo.organizationCounts(organizationId, { now: NOW }), [{ scope: 'PRINCIPAL', domain: 'CHATS', status: 'CURRENT', coverage: 'CONNECTED_PARTIAL', count: 1 }]);
    assert.deepEqual(await repo.organizationCounts(organizationId, { now: at(30) }), [], 'expired digests are not counted');
    // Expiry: stamped at write, purged by time.
    const purged = await repo.purgeExpired(at(28));
    assert.equal(await prisma.intelligenceDigest.count({ where: { organizationId } }), 1, 'not yet');
    assert.ok(purged.purged >= 0);
    await repo.purgeExpired(at(30));
    assert.equal(await prisma.intelligenceDigest.count({ where: { organizationId } }), 0);
  } finally {
    await prisma.organization.delete({ where: { id: organizationId } }).catch(() => undefined);
    await prisma.$disconnect();
  }
});

test('revoke, offboarding and a disconnect past grace each remove the digests they govern', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  const { organizationId, users: [owner, alice, bob, carol] } = await tenant(prisma, 'lifecycle', 4);
  try {
    const repo = new IntelligenceDigestRepository(prisma);
    for (const u of [alice!, bob!, carol!]) {
      await prisma.sourceConnection.create({ data: { organizationId, userId: u, provider: 'TELEGRAM', state: 'READY', backgroundObservation: 'UNAVAILABLE', connectedAt: at(-90) } });
      await prisma.sourceContentAuthorization.create({ data: { organizationId, userId: u, provider: 'TELEGRAM', authorizedAt: at(-60) } });
      assert.equal((await repo.upsert({ organizationId, userId: u }, digest())).outcome, 'WRITTEN');
      assert.equal((await repo.upsert({ organizationId, userId: u }, digest({ domain: 'CALENDAR', subjectKind: 'EVENT', subjectRef: 'calendar_event:k', provider: 'GOOGLE_CALENDAR', consentBasis: 'SOURCE_CONNECTION_GRANT' }))).outcome, 'WRITTEN');
    }
    const count = (u: string, provider?: string) => prisma.intelligenceDigest.count({ where: { organizationId, userId: u, ...(provider ? { provider } : {}) } });

    // REVOKE: Alice's Telegram digest goes with the consent, in the same transaction; Gmail stays.
    assert.equal((await new SourceContentAuthorizationRepository(prisma).revoke(organizationId, alice!, 'TELEGRAM', { now: NOW, actor: { userId: alice! } })).outcome, 'REVOKED');
    assert.equal(await count(alice!, 'TELEGRAM'), 0);
    assert.equal(await count(alice!, 'GOOGLE_CALENDAR'), 1);
    assert.equal(await count(bob!, 'TELEGRAM'), 1, 'a colleague is untouched');
    // A producer still in flight cannot land a digest after the revoke.
    assert.deepEqual(await repo.upsert({ organizationId, userId: alice! }, digest({ fingerprint: 'late' })), { outcome: 'REFUSED', refusal: 'CONSENT_NOT_IN_FORCE' });

    // OFFBOARDING: every digest Bob holds is erased with his work state.
    assert.equal((await new IamRepository(prisma).removeMember(organizationId, bob!, { userId: owner! })).changed, true);
    assert.equal(await count(bob!), 0);
    const erased = await prisma.auditLog.findFirst({ where: { organizationId, action: 'work_state.erased' } });
    assert.equal(((erased!.metadata as any).erased as Record<string, number>).intelligence_digests, 1, 'Telegram went with the consent revoke; Calendar with the erasure');

    // DISCONNECT PAST GRACE: Carol's Telegram digest is deleted with her derived work; Gmail stays.
    await prisma.sourceConnection.updateMany({ where: { organizationId, userId: carol! }, data: { state: 'DISCONNECTED', disconnectedAt: at(-(WORK_DISCONNECT_GRACE_DAYS + 1)) } });
    const expired = await new SourceConnectionRepository(prisma).expireDerivedWork(organizationId, carol!, 'TELEGRAM', { now: NOW });
    assert.deepEqual(expired, { outcome: 'EXPIRED', items: 0, observations: 0, digests: 1 });
    assert.equal(await count(carol!, 'TELEGRAM'), 0);
    assert.equal(await count(carol!, 'GOOGLE_CALENDAR'), 1);
  } finally {
    await prisma.organization.delete({ where: { id: organizationId } }).catch(() => undefined);
    await prisma.$disconnect();
  }
});

test('ai_controls: a provider policy needs a ceiling when ACTIVE, and nothing else may carry one', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  const provider = `test-provider-${randomUUID().slice(0, 8)}`;
  try {
    const repo = new AiControlRepository(prisma);
    const recorded = await repo.recordProviderPolicy({ providerId: provider, state: 'ACTIVE', ceiling: 'COMMUNICATION_CONTENT', reason: 'Terms reviewed.', expectedVersion: 0, actor: { kind: 'OPERATIONS', reference: 'test' } });
    assert.equal(recorded.ok, true);
    assert.ok((await repo.providerPolicies()).some((p) => p.providerId === provider && p.ceiling === 'COMMUNICATION_CONTENT' && p.state === 'ACTIVE'));
    const killed = await repo.recordProviderPolicy({ providerId: provider, state: 'KILLED', ceiling: null, reason: 'Stop.', expectedVersion: 1, actor: { kind: 'OPERATIONS', reference: 'test' } });
    assert.equal(killed.ok && killed.entry.version, 2);

    const raw = (data: Record<string, unknown>) =>
      prisma.aiControl.create({ data: { version: 1, reason: 'r', actorKind: 'OPERATIONS', actorReference: 'x', recordedAt: NOW, organizationId: null, ...data } as never });
    await assert.rejects(() => raw({ controlKey: `PROVIDER_POLICY|-|${provider}-b`, scope: 'PROVIDER_POLICY', value: `${provider}-b`, state: 'ACTIVE', ceiling: null }), /ai_controls_shape/, 'ACTIVE needs a ceiling');
    await assert.rejects(() => raw({ controlKey: `PROVIDER_POLICY|-|${provider}-c`, scope: 'PROVIDER_POLICY', value: `${provider}-c`, state: 'ACTIVE', ceiling: 'EVERYTHING' }), /ai_controls_shape/);
    await assert.rejects(() => raw({ controlKey: `PROVIDER|-|${provider}-d`, scope: 'PROVIDER', value: `${provider}-d`, state: 'ACTIVE', ceiling: 'OPERATIONAL' }), /ai_controls_shape/, 'a switch carries no ceiling');
    await assert.rejects(() => raw({ controlKey: `PROVIDER_POLICY|x|${provider}-e`, scope: 'PROVIDER_POLICY', value: `${provider}-e`, state: 'ACTIVE', ceiling: 'OPERATIONAL', organizationId: 'x' }), /ai_controls_shape|Foreign key/);
  } finally {
    await prisma.aiControlCurrent.deleteMany({ where: { value: { startsWith: provider } } });
    await prisma.aiControl.deleteMany({ where: { value: { startsWith: provider } } });
    await prisma.$disconnect();
  }
});
