// Loop Intelligence PR 2 (the fabric), 2026-09-26, against a REAL Postgres.
// OPT-IN AND LOCAL ONLY: LOOP_TEST_POSTGRES_URL (migrated through 20261006000002) and, for the
// pre-migration proof, LOOP_TEST_PRE_FABRIC_POSTGRES_URL (a database migrated only to 20261005000000,
// i.e. production as of d70f737).
//
// WHAT IT PROVES, THAT A DOUBLE CANNOT
//   - Partial uniqueness per scope on the real indexes (NULL userId made the PR A index useless for org
//     rows), and that a principal row and an organization row for the same subject coexist.
//   - ORGANIZATION digests are written and read through their own door; principal reads never return
//     them, organization reads never return principal rows, and nothing crosses users or organizations.
//   - An organization digest cannot rest on private communication: the repository refuses it AND the
//     database refuses it when the repository is bypassed.
//   - entity_links: explicit, scoped, provenance required, never MODEL, reversal is a stamp.
//   - intelligence_refresh_queue: coalescing under concurrency, compare-and-set claims, retry, hold, lease
//     recovery, and principal/org requests never collapsing.
//   - The producer loop skips unchanged input BEFORE its read (no model call) on the real schema.
//   - Offboarding erases the person's links and requests and leaves the organization's.
//   - Before the migration: Chats digests still write and read, organization writes and the new tables
//     answer NOT_MIGRATED/empty, and offboarding still completes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

import { IamRepository } from '../src/repositories/iam.repository';
import { EntityLinkRepository } from '../src/repositories/intelligence/entity-link.repository';
import { forgetIntelligenceFabricPresence } from '../src/repositories/intelligence/intelligence-fabric-presence';
import { IntelligenceDigestRepository, type IntelligenceDigestInput } from '../src/repositories/intelligence/intelligence-digest.repository';
import { IntelligenceRefreshQueueRepository, type IntelligenceRefreshTarget } from '../src/repositories/intelligence/intelligence-refresh-queue.repository';
import { IntelligenceProducerRegistry, type IntelligenceProducer } from '../src/services/intelligence-fabric/producer';
import { runIntelligenceProducerCycle } from '../src/services/intelligence-fabric/producer-loop';

const LOCAL = (url: string) => /^postgres(ql)?:\/\/[^@]*@(localhost|127\.0\.0\.1)(:\d+)?\//.test(url);
const URL = process.env.LOOP_TEST_POSTGRES_URL ?? '';
const PRE_URL = process.env.LOOP_TEST_PRE_FABRIC_POSTGRES_URL ?? '';
const skip = !URL ? 'LOOP_TEST_POSTGRES_URL is not set' : !LOCAL(URL) ? 'refusing a non-local database' : false;
const skipPre = !PRE_URL ? 'LOOP_TEST_PRE_FABRIC_POSTGRES_URL is not set' : !LOCAL(PRE_URL) ? 'refusing a non-local database' : false;

const NOW = new Date('2026-09-26T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const at = (days: number) => new Date(NOW.getTime() + days * DAY);
const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

async function tenant(prisma: PrismaClient, label: string, people = 3) {
  const organizationId = `org_fab_${label}_${randomUUID()}`;
  await prisma.organization.create({ data: { id: organizationId, name: `FAB ${label}`, slug: organizationId } });
  const users: string[] = [];
  for (let i = 0; i < people; i += 1) {
    const userId = `user_fab_${label}_${i}_${randomUUID()}`;
    const role = i === 0 ? 'OWNER' : 'EMPLOYEE';
    await prisma.user.create({ data: { id: userId, organizationId, email: `${userId}@example.test`, name: 'FAB', status: 'ACTIVE', metadata: { systemRole: role, passwordHash: 'kept' } } });
    await prisma.organizationMembership.create({ data: { organizationId, userId, systemRole: role, status: 'ACTIVE', effectiveFrom: new Date('2026-01-01T00:00:00Z') } });
    users.push(userId);
  }
  return { organizationId, users };
}

const orgDigest = (patch: Partial<IntelligenceDigestInput> = {}): IntelligenceDigestInput => ({
  domain: 'CALLGRID',
  subjectKind: 'DOMAIN',
  provider: null,
  consentBasis: 'LOOP_RECORDS',
  content: {
    reading: { statement: 'Conversion is slipping on one campaign.', status: 'WATCH', confidence: 'MEDIUM' },
    signals: [
      {
        key: 'conversion-slip',
        kind: 'RISK',
        knowledge: 'MEASURED',
        statement: 'Conversion fell from 18 to 12 percent week over week.',
        entities: ['campaign:c1'],
        evidenceRefs: ['callgrid_campaign:c1'],
        severity: 'HIGH',
        metric: { name: 'conversion_rate', value: 12, unit: 'percent', baseline: 18 },
      },
    ],
  },
  coverage: 'CONNECTED_SUFFICIENT',
  windowStart: at(-7),
  windowEnd: at(0),
  evidenceCount: 40,
  lastEvidenceAt: at(-0.1),
  provenance: { sourceRefs: ['callgrid_campaign:c1'], producerVersion: 'callgrid.domain@1', producerKind: 'RULE', sources: [{ sourceId: 'CALLGRID', asOf: iso(at(-0.1)), coverage: 'CONNECTED_SUFFICIENT' }] },
  aiInvocationId: null,
  entityRefs: ['campaign:c1', 'provider_member:callgrid:buyer:B1'],
  fingerprint: 'callgrid:v1',
  generatedAt: NOW,
  ...patch,
});

const chatsDigest = (patch: Partial<IntelligenceDigestInput> = {}): IntelligenceDigestInput => ({
  domain: 'CHATS',
  subjectKind: 'CONVERSATION',
  subjectRef: 'telegram_conversation:ck_fabric',
  provider: 'TELEGRAM',
  consentBasis: 'CONTENT_AUTHORIZATION',
  content: { relevance: 'BUSINESS', synthesis: 'A renewal waiting on your quote.' },
  coverage: 'CONNECTED_PARTIAL',
  windowStart: at(-7),
  windowEnd: at(0),
  evidenceCount: 3,
  lastEvidenceAt: at(-1),
  provenance: { sourceRefs: ['telegram_conversation:ck_fabric'], taskId: 'telegram.content.triage', taskVersion: '3.0.0', producerVersion: 'test.1' },
  aiInvocationId: 'inv_1',
  fingerprint: 'chats-fp-1',
  generatedAt: NOW,
  ...patch,
});

async function authorizeTelegram(prisma: PrismaClient, organizationId: string, userId: string) {
  await prisma.sourceConnection.create({ data: { organizationId, userId, provider: 'TELEGRAM', state: 'READY', backgroundObservation: 'UNAVAILABLE', connectedAt: at(-90) } });
  await prisma.sourceContentAuthorization.create({ data: { organizationId, userId, provider: 'TELEGRAM', authorizedAt: at(-60) } });
}

// --- Digests: scope, uniqueness, isolation -------------------------------------------------------

test('partial uniqueness on real Postgres: one org row per (org, domain, subject); one principal row per (org, user, domain, subject); the two coexist', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  const { organizationId, users: [owner, alice] } = await tenant(prisma, 'unique');
  try {
    const base = {
      organizationId, domain: 'WORK', subjectKind: 'DOMAIN', subjectRef: 'domain', content: { synthesis: 'x' }, coverage: 'CONNECTED_SUFFICIENT',
      windowStart: at(-7), windowEnd: at(0), evidenceCount: 0, lastEvidenceAt: null, fingerprint: 'fp', status: 'CURRENT', generatedAt: NOW, expiresAt: at(29),
    };
    const org = { ...base, scope: 'ORGANIZATION', userId: null, provider: null, provenance: { consentBasis: 'LOOP_RECORDS', producerVersion: 't' } };
    const mine = (userId: string) => ({ ...base, scope: 'PRINCIPAL', userId, provider: null, provenance: { consentBasis: 'LOOP_RECORDS', producerVersion: 't' } });
    await prisma.intelligenceDigest.create({ data: org as never });
    await assert.rejects(() => prisma.intelligenceDigest.create({ data: org as never }), /Unique constraint/i, 'NULL userId no longer lets two org rows coexist');
    await prisma.intelligenceDigest.create({ data: mine(owner!) as never });
    await prisma.intelligenceDigest.create({ data: mine(alice!) as never });
    await assert.rejects(() => prisma.intelligenceDigest.create({ data: mine(alice!) as never }), /Unique constraint/i);
    assert.equal(await prisma.intelligenceDigest.count({ where: { organizationId } }), 3, 'org + two principals for the same subject');
    const indexes = await prisma.$queryRawUnsafe<{ indexname: string; indexdef: string }[]>(
      `SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'intelligence_digests' AND indexdef LIKE 'CREATE UNIQUE%'`,
    );
    const byName = Object.fromEntries(indexes.map((i) => [i.indexname, i.indexdef]));
    assert.match(byName.intelligence_digests_principal_subject_key ?? '', /WHERE \(scope = 'PRINCIPAL'::text\)/);
    assert.match(byName.intelligence_digests_organization_subject_key ?? '', /WHERE \(scope = 'ORGANIZATION'::text\)/);
    assert.equal(byName.intelligence_digests_organizationId_userId_domain_subjectKi_key, undefined, 'the PR A unique index is gone');
  } finally {
    await prisma.organization.delete({ where: { id: organizationId } }).catch(() => undefined);
    await prisma.$disconnect();
  }
});

test('the database refuses an organization row over private evidence, even without the repository', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  const { organizationId, users: [owner] } = await tenant(prisma, 'orgcheck', 1);
  try {
    const row = (patch: Record<string, unknown>) => ({
      organizationId, scope: 'ORGANIZATION', userId: null, domain: 'CALLGRID', subjectKind: 'DOMAIN', subjectRef: `domain`, provider: null,
      content: { synthesis: 'x' }, coverage: 'CONNECTED_SUFFICIENT', windowStart: at(-7), windowEnd: at(0), evidenceCount: 0, lastEvidenceAt: null,
      provenance: { consentBasis: 'LOOP_RECORDS', producerVersion: 't' }, fingerprint: 'fp', status: 'CURRENT', generatedAt: NOW, expiresAt: at(29), ...patch,
    });
    const create = (patch: Record<string, unknown>) => prisma.intelligenceDigest.create({ data: row(patch) as never });
    for (const domain of ['CHATS', 'MAIL', 'CALENDAR']) await assert.rejects(() => create({ domain }), /intelligence_digests_scope_check/, domain);
    await assert.rejects(() => create({ provider: 'TELEGRAM' }), /intelligence_digests_scope_check/, 'a consent provider is never org evidence');
    await assert.rejects(() => create({ provenance: { consentBasis: 'CONTENT_AUTHORIZATION' } }), /intelligence_digests_scope_check/);
    await assert.rejects(() => create({ provenance: { producerVersion: 't' } }), /intelligence_digests_scope_check/, 'the basis must be stated');
    await assert.rejects(() => create({ userId: owner }), /intelligence_digests_scope_check/, 'an org row names nobody');
    await assert.rejects(() => create({ entityRefs: Array.from({ length: 33 }, (_, i) => `party:p${i}`) }), /intelligence_digests_shape_check/);
    await create({}); // the baseline passes
  } finally {
    await prisma.organization.delete({ where: { id: organizationId } }).catch(() => undefined);
    await prisma.$disconnect();
  }
});

test('organization digests: written and read through their own door; principal and organization reads never cross', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  const a = await tenant(prisma, 'orgA');
  const b = await tenant(prisma, 'orgB', 1);
  const [owner, alice, bob] = a.users;
  try {
    const repo = new IntelligenceDigestRepository(prisma);
    const written = await repo.upsertOrganization(a.organizationId, orgDigest());
    assert.equal(written.outcome, 'WRITTEN');
    if (written.outcome !== 'WRITTEN') return;
    assert.equal(written.digest.scope, 'ORGANIZATION');
    assert.equal(written.digest.userId, null);
    assert.deepEqual(written.digest.entityRefs, ['campaign:c1', 'provider_member:callgrid:buyer:B1']);
    assert.equal((written.digest.provenance as any).producerKind, 'RULE');
    assert.equal((written.digest.provenance as any).contractVersion, 'intelligence-contract.v1');
    // Same fingerprint: nothing written. New fingerprint: version + 1.
    assert.equal((await repo.upsertOrganization(a.organizationId, orgDigest())).outcome, 'UNCHANGED');
    const v2 = await repo.upsertOrganization(a.organizationId, orgDigest({ fingerprint: 'callgrid:v2' }));
    assert.equal(v2.outcome === 'WRITTEN' && v2.digest.version, 2);

    // Org reads: found; another organization finds nothing.
    assert.equal((await repo.organizationCurrent(a.organizationId, 'CALLGRID', { now: NOW }))?.version, 2);
    assert.equal(await repo.organizationCurrent(b.organizationId, 'CALLGRID', { now: NOW }), null);
    assert.equal((await repo.organizationForDomain(a.organizationId, 'CALLGRID', { now: NOW })).length, 1);

    // A principal digest for the same person and domain family, and principal reads never see the org row.
    await authorizeTelegram(prisma, a.organizationId, alice!);
    assert.equal((await repo.upsert({ organizationId: a.organizationId, userId: alice! }, chatsDigest())).outcome, 'WRITTEN');
    assert.equal(await repo.current({ organizationId: a.organizationId, userId: owner! }, 'CALLGRID', { now: NOW }), null, 'the OWNER reads no org row through a principal read');
    assert.deepEqual(await repo.forDomain({ organizationId: a.organizationId, userId: owner! }, 'CALLGRID', { now: NOW }), []);
    // A principal WORK rollup and the organization WORK rollup are different rows, each through its own door.
    const workOrg = await repo.upsertOrganization(a.organizationId, orgDigest({ domain: 'WORK', fingerprint: 'work:org', content: { synthesis: 'Three items overdue across the team.' }, entityRefs: [], provenance: { sourceRefs: ['work:org'], producerVersion: 'work@1', producerKind: 'RULE', sources: [{ sourceId: 'LOOP_WORK', asOf: iso(NOW), coverage: 'CONNECTED_SUFFICIENT' }] } }));
    assert.equal(workOrg.outcome, 'WRITTEN');
    const workMine = await repo.upsert({ organizationId: a.organizationId, userId: bob! }, orgDigest({ domain: 'WORK', fingerprint: 'work:bob', content: { synthesis: 'One of yours is overdue.' }, entityRefs: [], provenance: { sourceRefs: ['work:bob'], producerVersion: 'work@1', producerKind: 'RULE', sources: [{ sourceId: 'LOOP_WORK', asOf: iso(NOW), coverage: 'CONNECTED_SUFFICIENT' }] } }));
    assert.equal(workMine.outcome, 'WRITTEN');
    assert.equal((await repo.current({ organizationId: a.organizationId, userId: bob! }, 'WORK', { now: NOW }))?.content.synthesis, 'One of yours is overdue.');
    assert.equal((await repo.organizationCurrent(a.organizationId, 'WORK', { now: NOW }))?.content.synthesis, 'Three items overdue across the team.');
    assert.equal(await repo.current({ organizationId: a.organizationId, userId: alice! }, 'WORK', { now: NOW }), null, 'nobody reads Bob\'s own WORK reading');
    // Organization reads never return a principal row, and never read a private domain at all.
    assert.equal(await repo.organizationCurrent(a.organizationId, 'CHATS', { subjectKind: 'CONVERSATION', subjectRef: 'telegram_conversation:ck_fabric', now: NOW }), null);
    assert.deepEqual(await repo.organizationForDomain(a.organizationId, 'CHATS', { now: NOW }), []);
    assert.equal((await repo.organizationForDomain(a.organizationId, 'WORK', { now: NOW })).every((d) => d.scope === 'ORGANIZATION' && d.userId === null), true);
    // No cross-user principal read: Bob reads nothing of Alice's.
    assert.equal(await repo.current({ organizationId: a.organizationId, userId: bob! }, 'CHATS', { subjectKind: 'CONVERSATION', subjectRef: 'telegram_conversation:ck_fabric', now: NOW }), null);
    assert.deepEqual(await repo.forDomain({ organizationId: a.organizationId, userId: bob! }, 'CHATS', { now: NOW }), []);
    // The fingerprint lookup is scoped the same way.
    assert.equal((await repo.storedFingerprint({ scope: 'ORGANIZATION', organizationId: a.organizationId }, { domain: 'WORK', subjectKind: 'DOMAIN', subjectRef: 'domain' }))?.fingerprint, 'work:org');
    assert.equal((await repo.storedFingerprint({ scope: 'PRINCIPAL', principal: { organizationId: a.organizationId, userId: bob! } }, { domain: 'WORK', subjectKind: 'DOMAIN', subjectRef: 'domain' }))?.fingerprint, 'work:bob');
    assert.equal(await repo.storedFingerprint({ scope: 'PRINCIPAL', principal: { organizationId: a.organizationId, userId: alice! } }, { domain: 'WORK', subjectKind: 'DOMAIN', subjectRef: 'domain' }), null);
    // Existing Chats rows stay readable with empty references.
    assert.deepEqual((await repo.current({ organizationId: a.organizationId, userId: alice! }, 'CHATS', { subjectKind: 'CONVERSATION', subjectRef: 'telegram_conversation:ck_fabric', now: NOW }))?.entityRefs, []);
    // Counts carry the scope and nothing that names anyone.
    const counts = await repo.organizationCounts(a.organizationId, { now: NOW });
    assert.deepEqual(counts.map((c) => `${c.scope}/${c.domain}`).sort(), ['ORGANIZATION/CALLGRID', 'ORGANIZATION/WORK', 'PRINCIPAL/CHATS', 'PRINCIPAL/WORK']);
  } finally {
    for (const t of [a, b]) await prisma.organization.delete({ where: { id: t.organizationId } }).catch(() => undefined);
    await prisma.$disconnect();
  }
});

test('an organization digest can never rest on private communication: the repository refuses every route in', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  const { organizationId } = await tenant(prisma, 'private', 1);
  try {
    const repo = new IntelligenceDigestRepository(prisma);
    const refused = async (patch: Partial<IntelligenceDigestInput>, refusal: string, why: string) =>
      assert.equal(((await repo.upsertOrganization(organizationId, orgDigest(patch))) as { refusal?: string }).refusal, refusal, why);
    for (const domain of ['CHATS', 'MAIL', 'CALENDAR'] as const) await refused({ domain }, 'SCOPE_NOT_ALLOWED_FOR_DOMAIN', domain);
    await refused({ provider: 'TELEGRAM', consentBasis: 'CONTENT_AUTHORIZATION' }, 'PRIVATE_EVIDENCE', 'a consent-bound provider');
    await refused({ provider: 'GMAIL', consentBasis: 'SOURCE_CONNECTION_GRANT' }, 'PRIVATE_EVIDENCE', 'a mailbox grant');
    await refused({ consentBasis: 'CONTENT_AUTHORIZATION' }, 'PRIVATE_EVIDENCE', 'a content consent basis');
    for (const sourceId of ['TELEGRAM', 'GMAIL', 'GOOGLE_CALENDAR']) {
      await refused({ provenance: { sourceRefs: ['x:1'], producerVersion: 'p@1', producerKind: 'RULE', sources: [{ sourceId, asOf: iso(NOW), coverage: 'CONNECTED_SUFFICIENT' }] } }, 'PRIVATE_EVIDENCE', sourceId);
    }
    await refused({ entityRefs: ['telegram_conversation:' + 'a'.repeat(32)] }, 'PRIVATE_EVIDENCE', 'a private conversation reference');
    await refused({ entityRefs: ['correspondent:' + 'f'.repeat(64)] }, 'PRIVATE_EVIDENCE', 'a mail correspondent');
    await refused({ provenance: { sourceRefs: ['x:1'], producerVersion: 'p@1', producerKind: 'RULE' } }, 'INVALID_INPUT', 'no sources named');
    await refused({ provenance: { sourceRefs: ['x:1'], producerVersion: 'p@1', sources: [{ sourceId: 'CALLGRID', asOf: iso(NOW), coverage: 'CONNECTED_SUFFICIENT' }] } }, 'INVALID_INPUT', 'no producer kind');
    await refused(
      { content: { signals: [{ key: 's', kind: 'OBLIGATION', knowledge: 'INFERRED', statement: 'x', evidenceRefs: ['r:1'], entities: ['work_thread:t1'] }] } },
      'INVALID_CONTENT',
      'a signal pointing at a private thread',
    );
    await refused({ provenance: { ...orgDigest().provenance, producerKind: 'MODEL' } }, 'INVALID_CONTENT', 'a MODEL producer cannot state MEASURED');
    // `upsert` (the principal door) refuses ORGANIZATION outright, and the org door refuses PRINCIPAL.
    assert.equal(((await repo.upsert({ organizationId, userId: 'nobody' }, orgDigest({ scope: 'ORGANIZATION' }))) as { refusal?: string }).refusal, 'ORGANIZATION_SCOPE_RESERVED');
    await refused({ scope: 'PRINCIPAL' }, 'WRONG_SCOPE', 'the org door writes org rows only');
    assert.equal(await prisma.intelligenceDigest.count({ where: { organizationId } }), 0, 'nothing was written by any refusal');
  } finally {
    await prisma.organization.delete({ where: { id: organizationId } }).catch(() => undefined);
    await prisma.$disconnect();
  }
});

// --- Entity links ---------------------------------------------------------------------------------

test('entity links: explicit, scoped and provenanced; never MODEL; a private reference never enters an org link; reversal is a stamp', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  const a = await tenant(prisma, 'links');
  const b = await tenant(prisma, 'linksB', 1);
  const [owner, alice, bob] = a.users;
  try {
    const links = new EntityLinkRepository(prisma);
    const org = { scope: 'ORGANIZATION', organizationId: a.organizationId } as const;
    const aliceOwner = { scope: 'PRINCIPAL', principal: { organizationId: a.organizationId, userId: alice! } } as const;
    const bobOwner = { scope: 'PRINCIPAL', principal: { organizationId: a.organizationId, userId: bob! } } as const;
    const decl = (patch: Record<string, unknown> = {}) => ({
      fromRef: 'provider_member:callgrid:buyer:B1', toRef: 'party:premier', relation: 'SAME_AS' as const, basis: 'HUMAN_DECLARED' as const,
      source: 'crm-identity', declaredByUserId: owner!, effectiveFrom: NOW, ...patch,
    });
    const linked = await links.declare(org, decl());
    assert.equal(linked.outcome, 'LINKED');
    assert.deepEqual(await links.declare(org, decl()), { outcome: 'REFUSED', refusal: 'ALREADY_LINKED' });
    assert.deepEqual(await links.declare(org, decl({ declaredByUserId: null })), { outcome: 'REFUSED', refusal: 'INVALID_INPUT' }, 'a human declaration names its human');
    assert.deepEqual(await links.declare(org, decl({ basis: 'MODEL' })), { outcome: 'REFUSED', refusal: 'INVALID_INPUT' }, 'no MODEL basis');
    assert.deepEqual(await links.declare(org, decl({ toRef: 'telegram_conversation:' + 'a'.repeat(32) })), { outcome: 'REFUSED', refusal: 'PRIVATE_REF_IN_ORGANIZATION' });
    assert.deepEqual(await links.declare(org, decl({ toRef: 'provider_member:callgrid:buyer:B1' })), { outcome: 'REFUSED', refusal: 'SELF_LINK' });
    assert.deepEqual(await links.declare(org, decl({ source: 'bad source!' })), { outcome: 'REFUSED', refusal: 'INVALID_INPUT' });
    // The database refuses the same, bypassing the repository.
    await assert.rejects(
      () => prisma.entityLink.create({ data: { organizationId: a.organizationId, scope: 'ORGANIZATION', fromRef: 'party:a', toRef: 'work_thread:t1', relation: 'SAME_AS', basis: 'RULE', source: 'r', effectiveFrom: NOW } }),
      /entity_links_scope_check/,
    );
    await assert.rejects(
      () => prisma.entityLink.create({ data: { organizationId: a.organizationId, scope: 'ORGANIZATION', fromRef: 'party:a', toRef: 'party:b', relation: 'SAME_AS', basis: 'MODEL', source: 'r', effectiveFrom: NOW } }),
      /entity_links_shape_check/,
    );
    // A principal link may name that person's own private evidence.
    const mine = await links.declare(aliceOwner, decl({ fromRef: 'telegram_conversation:' + 'a'.repeat(32), toRef: 'party:premier', declaredByUserId: alice!, source: 'chats' }));
    assert.equal(mine.outcome, 'LINKED');
    // Visibility: Alice sees her own and the org's; Bob sees only the org's; the org sees only its own.
    const refs = ['party:premier'];
    assert.equal((await links.linksFor(aliceOwner, refs)).length, 2);
    assert.deepEqual((await links.linksFor(bobOwner, refs)).map((l) => l.scope), ['ORGANIZATION']);
    assert.deepEqual((await links.linksFor(org, refs)).map((l) => l.scope), ['ORGANIZATION']);
    assert.deepEqual(await links.linksFor({ scope: 'ORGANIZATION', organizationId: b.organizationId }, refs), [], 'another organization reads nothing');
    // Bob cannot reverse Alice's link; the org cannot reverse it either. Alice can; the row stays.
    if (mine.outcome !== 'LINKED') return;
    assert.deepEqual(await links.reverse(bobOwner, mine.link.id, { userId: bob!, at: NOW }), { outcome: 'REFUSED', refusal: 'NOT_FOUND' });
    assert.deepEqual(await links.reverse(org, mine.link.id, { userId: owner!, at: NOW }), { outcome: 'REFUSED', refusal: 'NOT_FOUND' });
    const reversed = await links.reverse(aliceOwner, mine.link.id, { userId: alice!, at: at(1) });
    assert.equal(reversed.outcome, 'REVERSED');
    assert.equal((await links.linksFor(aliceOwner, refs)).length, 1, 'a reversed link is no longer active');
    assert.equal(await prisma.entityLink.count({ where: { organizationId: a.organizationId, userId: alice! } }), 1, 'but the row remains');
    assert.equal((await links.declare(aliceOwner, decl({ fromRef: 'telegram_conversation:' + 'a'.repeat(32), toRef: 'party:premier', declaredByUserId: alice!, source: 'chats' }))).outcome, 'LINKED', 'the triple can be declared again');
  } finally {
    for (const t of [a, b]) await prisma.organization.delete({ where: { id: t.organizationId } }).catch(() => undefined);
    await prisma.$disconnect();
  }
});

// --- The refresh queue ---------------------------------------------------------------------------

test('refresh queue: coalescing under concurrency, principal and org never collapse, compare-and-set claims', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  const { organizationId, users: [owner, alice] } = await tenant(prisma, 'queue');
  try {
    const queue = new IntelligenceRefreshQueueRepository(prisma);
    const org: IntelligenceRefreshTarget = { scope: 'ORGANIZATION', organizationId, domain: 'WORK', subjectKind: 'DOMAIN', subjectRef: 'domain' };
    const mine: IntelligenceRefreshTarget = { scope: 'PRINCIPAL', organizationId, userId: alice!, domain: 'WORK', subjectKind: 'DOMAIN', subjectRef: 'domain' };
    // Ten concurrent requests for one target: one PENDING row, count 10.
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => queue.enqueue(org, { reason: 'EVIDENCE_CHANGED', sourceRevision: `r${i}` }, NOW)));
    assert.ok(results.every((r) => r.outcome === 'ENQUEUED' || r.outcome === 'COALESCED'));
    const pending = await prisma.intelligenceRefreshRequest.findMany({ where: { organizationId, scope: 'ORGANIZATION', state: 'PENDING' } });
    assert.equal(pending.length, 1);
    assert.equal(pending[0]!.requestCount, 10);
    // The principal request for the same domain is its own row.
    assert.equal((await queue.enqueue(mine, { reason: 'EVIDENCE_CHANGED' }, NOW)).outcome, 'ENQUEUED');
    assert.equal(await prisma.intelligenceRefreshRequest.count({ where: { organizationId, state: 'PENDING' } }), 2);
    // Fail closed on scope: an org request in a private domain, a principal without a user, a bad reason.
    assert.deepEqual(await queue.enqueue({ scope: 'ORGANIZATION', organizationId, domain: 'MAIL', subjectKind: 'DOMAIN', subjectRef: 'domain' }, { reason: 'X_Y' }, NOW), { outcome: 'REFUSED', refusal: 'SCOPE_NOT_ALLOWED_FOR_DOMAIN' });
    assert.deepEqual(await queue.enqueue({ scope: 'ORGANIZATION', organizationId, domain: 'CALLGRID', subjectKind: 'DOMAIN', subjectRef: 'other' }, { reason: 'X_Y' }, NOW), { outcome: 'REFUSED', refusal: 'INVALID_TARGET' });
    assert.deepEqual(await queue.enqueue({ scope: 'PRINCIPAL', organizationId, userId: '', domain: 'MAIL', subjectKind: 'DOMAIN', subjectRef: 'domain' }, { reason: 'X_Y' }, NOW), { outcome: 'REFUSED', refusal: 'INVALID_TARGET' });
    assert.deepEqual(await queue.enqueue(org, { reason: 'free text reason' }, NOW), { outcome: 'REFUSED', refusal: 'INVALID_REQUEST' });
    // The database refuses an org row in a private domain directly.
    await assert.rejects(
      () => prisma.intelligenceRefreshRequest.create({ data: { organizationId, scope: 'ORGANIZATION', domain: 'CHATS', subjectKind: 'DOMAIN', subjectRef: 'domain', reason: 'X_Y', firstRequestedAt: NOW, lastRequestedAt: NOW, notBefore: NOW, state: 'PENDING' } }),
      /intelligence_refresh_queue_shape_check/,
    );
    // Two claimers at once: each request is owned by exactly one.
    const [c1, c2] = await Promise.all([
      queue.claim({ leaseOwner: 'w1', now: NOW, leaseMs: 60_000, limit: 5 }),
      queue.claim({ leaseOwner: 'w2', now: NOW, leaseMs: 60_000, limit: 5 }),
    ]);
    const ids = [...c1!, ...c2!].map((c) => c.id);
    assert.equal(ids.length, 2);
    assert.equal(new Set(ids).size, 2, 'no request claimed twice');
    // Claims restricted to domains: nothing else is claimed; an empty list claims nothing.
    assert.deepEqual(await queue.claim({ leaseOwner: 'w3', now: NOW, leaseMs: 60_000, limit: 5, domains: [] }), []);
    // A new request while claimed: a new PENDING row beside the CLAIMED one.
    assert.equal((await queue.enqueue(org, { reason: 'EVIDENCE_CHANGED' }, NOW)).outcome, 'ENQUEUED');
    // Only the lease holder completes.
    const claimedOrg = [...c1!, ...c2!].find((c) => c.target.scope === 'ORGANIZATION')!;
    assert.equal(await queue.complete({ id: claimedOrg.id, leaseOwner: 'somebody-else' }), false);
    // Retry while a newer PENDING exists: folded into it (count carried), never two PENDING rows.
    assert.equal(await queue.retry(claimedOrg, { outcome: 'GATHER_UNAVAILABLE', retryAt: at(0.01), maxAttempts: 3 }), 'RETRYING');
    const orgRows = await prisma.intelligenceRefreshRequest.findMany({ where: { organizationId, scope: 'ORGANIZATION' } });
    assert.equal(orgRows.length, 1);
    assert.equal(orgRows[0]!.requestCount, 11);
    // The principal claim: retry puts it back PENDING with a backoff; out of attempts it is HELD.
    const claimedMine = [...c1!, ...c2!].find((c) => c.target.scope === 'PRINCIPAL')!;
    assert.equal(claimedMine.target.scope === 'PRINCIPAL' && claimedMine.target.userId, alice);
    assert.equal(await queue.retry(claimedMine, { outcome: 'GATHER_UNAVAILABLE', retryAt: at(1), maxAttempts: 3 }), 'RETRYING');
    assert.deepEqual(await queue.claim({ leaseOwner: 'w1', now: NOW, leaseMs: 60_000, limit: 5, domains: ['WORK'] }).then((c) => c.filter((x) => x.target.scope === 'PRINCIPAL')), [], 'not before its backoff');
    const again = (await queue.claim({ leaseOwner: 'w1', now: at(1), leaseMs: 60_000, limit: 5, domains: ['WORK'] })).find((c) => c.target.scope === 'PRINCIPAL')!;
    assert.equal(again.attempts, 2);
    assert.equal(await queue.retry({ ...again, attempts: 3 }, { outcome: 'GATHER_UNAVAILABLE', retryAt: at(2), maxAttempts: 3 }), 'HELD');
    const held = await prisma.intelligenceRefreshRequest.findFirst({ where: { organizationId, scope: 'PRINCIPAL' } });
    assert.equal(held!.state, 'HELD');
    assert.equal(held!.lastOutcome, 'GATHER_UNAVAILABLE');
    // Counts: per (scope, domain, state), no user and no subject.
    const counts = await queue.organizationCounts(organizationId);
    for (const c of counts) assert.deepEqual(Object.keys(c).sort(), ['count', 'domain', 'oldestRequestedAt', 'scope', 'state']);
    assert.ok(counts.some((c) => c.scope === 'PRINCIPAL' && c.state === 'HELD' && c.count === 1));
    void owner;
  } finally {
    await prisma.organization.delete({ where: { id: organizationId } }).catch(() => undefined);
    await prisma.$disconnect();
  }
});

test('refresh queue: an expired lease is recovered by the next claimer', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  const { organizationId } = await tenant(prisma, 'lease', 1);
  try {
    const queue = new IntelligenceRefreshQueueRepository(prisma);
    const org: IntelligenceRefreshTarget = { scope: 'ORGANIZATION', organizationId, domain: 'CREATORS', subjectKind: 'DOMAIN', subjectRef: 'domain' };
    await queue.enqueue(org, { reason: 'SCHEDULED' }, NOW);
    const [first] = await queue.claim({ leaseOwner: 'crashed', now: NOW, leaseMs: 1_000, limit: 1, domains: ['CREATORS'] });
    assert.ok(first);
    assert.deepEqual(await queue.claim({ leaseOwner: 'w2', now: new Date(NOW.getTime() + 500), leaseMs: 60_000, limit: 1, domains: ['CREATORS'] }), [], 'the lease still holds');
    const [second] = await queue.claim({ leaseOwner: 'w2', now: new Date(NOW.getTime() + 5_000), leaseMs: 60_000, limit: 1, domains: ['CREATORS'] });
    assert.equal(second?.id, first!.id, 'recovered and reclaimed');
    assert.equal(second?.attempts, 2);
    assert.equal(await queue.complete(first!), false, 'the crashed worker no longer owns it');
    assert.equal(await queue.complete(second!), true);
    assert.equal(await prisma.intelligenceRefreshRequest.count({ where: { organizationId } }), 0);
  } finally {
    await prisma.organization.delete({ where: { id: organizationId } }).catch(() => undefined);
    await prisma.$disconnect();
  }
});

// --- The producer loop on the real schema --------------------------------------------------------

test('the producer loop writes once, then skips unchanged input BEFORE its read -- no second read, no model call', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  const { organizationId } = await tenant(prisma, 'loop', 1);
  try {
    const queue = new IntelligenceRefreshQueueRepository(prisma);
    const digests = new IntelligenceDigestRepository(prisma);
    let reads = 0;
    let fingerprint = 'callgrid:ctx-1';
    const producer: IntelligenceProducer<{ n: number }> = {
      id: 'test.callgrid@1', domain: 'CALLGRID', scope: 'ORGANIZATION', subjectKinds: ['DOMAIN'], kind: 'RULE', taskId: null,
      async gather() { return { status: 'READY', context: { n: 1 }, fingerprint }; },
      async read(_t, _c, fp) { reads += 1; return { status: 'READ', digest: orgDigest({ fingerprint: fp }) }; },
    };
    const registry = new IntelligenceProducerRegistry([producer], ['test.callgrid@1']);
    const run = () => runIntelligenceProducerCycle({ queue, digests, registry, leaseOwner: 'loop', now: () => NOW }, { limit: 5, leaseMs: 60_000, maxAttempts: 3 });
    const target: IntelligenceRefreshTarget = { scope: 'ORGANIZATION', organizationId, domain: 'CALLGRID', subjectKind: 'DOMAIN', subjectRef: 'domain' };
    await queue.enqueue(target, { reason: 'EVIDENCE_CHANGED' }, NOW);
    const first = await run();
    assert.equal(first.written, 1);
    assert.equal(reads, 1);
    await queue.enqueue(target, { reason: 'EVIDENCE_CHANGED' }, NOW);
    const second = await run();
    assert.equal(second.skippedUnchangedBeforeRead, 1);
    assert.equal(reads, 1, 'unchanged input: the producer was never asked to read');
    fingerprint = 'callgrid:ctx-2';
    await queue.enqueue(target, { reason: 'EVIDENCE_CHANGED' }, NOW);
    const third = await run();
    assert.equal(third.written, 1);
    assert.equal(reads, 2);
    assert.equal((await digests.organizationCurrent(organizationId, 'CALLGRID', { now: NOW }))?.version, 2);
    assert.equal(await prisma.intelligenceRefreshRequest.count({ where: { organizationId } }), 0, 'every request completed');
  } finally {
    await prisma.organization.delete({ where: { id: organizationId } }).catch(() => undefined);
    await prisma.$disconnect();
  }
});

// --- Offboarding ----------------------------------------------------------------------------------

test('offboarding erases the person\'s own links and refresh requests, and leaves the organization\'s', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  const { organizationId, users: [owner, alice] } = await tenant(prisma, 'erase');
  try {
    const links = new EntityLinkRepository(prisma);
    const queue = new IntelligenceRefreshQueueRepository(prisma);
    await links.declare({ scope: 'PRINCIPAL', principal: { organizationId, userId: alice! } }, { fromRef: 'work_thread:t1', toRef: 'party:p1', relation: 'SAME_AS', basis: 'HUMAN_DECLARED', source: 'mail', declaredByUserId: alice!, effectiveFrom: NOW });
    await links.declare({ scope: 'ORGANIZATION', organizationId }, { fromRef: 'party:p1', toRef: 'market:us-fl', relation: 'LOCATED_IN', basis: 'RULE', source: 'crm-address', effectiveFrom: NOW });
    await queue.enqueue({ scope: 'PRINCIPAL', organizationId, userId: alice!, domain: 'MAIL', subjectKind: 'DOMAIN', subjectRef: 'domain' }, { reason: 'EVIDENCE_CHANGED' }, NOW);
    await queue.enqueue({ scope: 'ORGANIZATION', organizationId, domain: 'CRM', subjectKind: 'DOMAIN', subjectRef: 'domain' }, { reason: 'EVIDENCE_CHANGED' }, NOW);
    assert.equal((await new IamRepository(prisma).removeMember(organizationId, alice!, { userId: owner! })).changed, true);
    assert.equal(await prisma.entityLink.count({ where: { organizationId, userId: alice! } }), 0);
    assert.equal(await prisma.intelligenceRefreshRequest.count({ where: { organizationId, userId: alice! } }), 0);
    assert.equal(await prisma.entityLink.count({ where: { organizationId, scope: 'ORGANIZATION' } }), 1, 'the organization keeps its links');
    assert.equal(await prisma.intelligenceRefreshRequest.count({ where: { organizationId, scope: 'ORGANIZATION' } }), 1);
    const erased = await prisma.auditLog.findFirst({ where: { organizationId, action: 'work_state.erased' } });
    const counts = (erased!.metadata as any).erased as Record<string, number>;
    assert.equal(counts.entity_links, 1);
    assert.equal(counts.intelligence_refresh_queue, 1);
  } finally {
    await prisma.organization.delete({ where: { id: organizationId } }).catch(() => undefined);
    await prisma.$disconnect();
  }
});

// --- Before the migration ---------------------------------------------------------------------------

test('PRE-MIGRATION (production at d70f737): Chats digests write and read as before; everything new is NOT_MIGRATED or empty; offboarding completes', { skip: skipPre }, async () => {
  forgetIntelligenceFabricPresence();
  const prisma = new PrismaClient({ datasources: { db: { url: PRE_URL } } });
  const { organizationId, users: [owner, alice, bob] } = await tenant(prisma, 'premig');
  try {
    const columns = await prisma.$queryRawUnsafe<{ column_name: string }[]>(`SELECT column_name FROM information_schema.columns WHERE table_name = 'intelligence_digests' AND column_name = 'entityRefs'`);
    assert.equal(columns.length, 0, 'this database really is before the fabric migration');
    const repo = new IntelligenceDigestRepository(prisma);
    await authorizeTelegram(prisma, organizationId, alice!);
    // The Chats producer's write, exactly as the live worker makes it (no entity references).
    const written = await repo.upsert({ organizationId, userId: alice! }, chatsDigest());
    assert.equal(written.outcome, 'WRITTEN');
    assert.equal((await repo.upsert({ organizationId, userId: alice! }, chatsDigest())).outcome, 'UNCHANGED');
    assert.equal((await repo.upsert({ organizationId, userId: alice! }, chatsDigest({ fingerprint: 'chats-fp-2' }))).outcome, 'WRITTEN');
    // A producer that already names references still writes (they are simply not kept yet).
    assert.equal((await repo.upsert({ organizationId, userId: alice! }, chatsDigest({ subjectRef: 'telegram_conversation:ck_two', entityRefs: ['party:p1'] }))).outcome, 'WRITTEN');
    const read = await repo.forDomain({ organizationId, userId: alice! }, 'CHATS', { now: NOW });
    assert.equal(read.length, 2);
    assert.ok(read.every((d) => d.entityRefs.length === 0 && d.scope === 'PRINCIPAL'));
    assert.equal((await repo.current({ organizationId, userId: alice! }, 'CHATS', { subjectKind: 'CONVERSATION', subjectRef: 'telegram_conversation:ck_fabric', now: NOW }))?.version, 2);
    assert.equal((await repo.metadataFor({ organizationId, userId: alice! }, { now: NOW })).length, 2);
    assert.equal((await repo.organizationCounts(organizationId, { now: NOW })).length, 1);
    // Everything the migration adds answers honestly.
    assert.deepEqual(await repo.upsertOrganization(organizationId, orgDigest()), { outcome: 'REFUSED', refusal: 'NOT_MIGRATED' });
    assert.equal(await repo.organizationCurrent(organizationId, 'CALLGRID', { now: NOW }), null);
    assert.deepEqual(await repo.organizationForDomain(organizationId, 'CALLGRID', { now: NOW }), []);
    assert.deepEqual(
      await new EntityLinkRepository(prisma).declare({ scope: 'ORGANIZATION', organizationId }, { fromRef: 'party:a', toRef: 'party:b', relation: 'SAME_AS', basis: 'RULE', source: 'r', effectiveFrom: NOW }),
      { outcome: 'REFUSED', refusal: 'NOT_MIGRATED' },
    );
    assert.deepEqual(await new EntityLinkRepository(prisma).linksFor({ scope: 'ORGANIZATION', organizationId }, ['party:a']), []);
    const queue = new IntelligenceRefreshQueueRepository(prisma);
    assert.deepEqual(await queue.enqueue({ scope: 'ORGANIZATION', organizationId, domain: 'WORK', subjectKind: 'DOMAIN', subjectRef: 'domain' }, { reason: 'SCHEDULED' }, NOW), { outcome: 'REFUSED', refusal: 'NOT_MIGRATED' });
    assert.deepEqual(await queue.claim({ leaseOwner: 'w', now: NOW, leaseMs: 1000, limit: 5 }), []);
    assert.deepEqual(await queue.organizationCounts(organizationId), []);
    // Offboarding still completes, erasing the digests and skipping the tables that do not exist.
    assert.equal((await new IamRepository(prisma).removeMember(organizationId, alice!, { userId: owner! })).changed, true);
    assert.equal(await prisma.intelligenceDigest.count({ where: { organizationId, userId: alice! } }), 0);
    assert.equal((await new IamRepository(prisma).disableMember(organizationId, bob!, { userId: owner! })).changed, true);
  } finally {
    await prisma.organization.delete({ where: { id: organizationId } }).catch(() => undefined);
    await prisma.$disconnect();
  }
});
