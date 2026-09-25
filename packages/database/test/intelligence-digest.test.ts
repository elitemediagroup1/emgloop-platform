// Domain intelligence digests (Loop Intelligence PR A, 2026-09-24): the repository, in memory.
// The same rules against a real Postgres, including the CHECK constraints, are in
// intelligence-digest.postgres.test.ts.
//
// WHAT THESE PROVE
//   - PRINCIPAL-PRIVATE: every read and write is one person's; another person in the same
//     organization, or anyone in another, finds nothing -- and there is no organization-wide read
//     and no role bypass (an OWNER reads their own and nobody else's). A source scan pins it.
//   - MINIMIZED: content with a body/text/quote/message key, an unknown key or an oversize field
//     is refused and nothing is written; ORGANIZATION scope is refused.
//   - A PROJECTION: the same fingerprint writes nothing; a changed one overwrites, version + 1.
//   - CONSENT: a TELEGRAM digest is written only while the content authorization is in force,
//     re-checked inside the write; the basis must match the provider.
//   - REVOCATION AND RETENTION: a content revoke deletes that provider's digests in its own
//     transaction; offboarding erases them; a disconnect past grace deletes them; expiry purges.
//   - DEPLOYMENT WINDOW: before the migration reaches the database, offboarding still completes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Prisma, type PrismaClient } from '@prisma/client';
import { WORK_DISCONNECT_GRACE_DAYS } from '@emgloop/shared';

import { IamRepository } from '../src/repositories/iam.repository';
import {
  IntelligenceDigestRepository,
  intelligenceDigestsPresent,
  type IntelligenceDigestInput,
} from '../src/repositories/intelligence/intelligence-digest.repository';
import { SourceConnectionRepository } from '../src/repositories/source-connection.repository';
import { SourceContentAuthorizationRepository } from '../src/repositories/source-content-authorization.repository';
import { makeCognitivePrisma } from './helpers/cognitive-prisma-fake';

const ORG_A = 'org_a';
const ORG_B = 'org_b';
const NOW = new Date('2026-09-24T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const at = (days: number) => new Date(NOW.getTime() + days * DAY);

async function world() {
  const fake: any = makeCognitivePrisma({ also: ['organizationMembership', 'invitation'] });
  const prisma = fake as PrismaClient;
  const iam = new IamRepository(prisma);
  const hire = async (role: string, org = ORG_A) => {
    const u = await iam.createUser({ organizationId: org, email: `${role.toLowerCase()}-${Math.random()}@x.io`, systemRole: role });
    await iam.activateUser(org, u.id);
    return u.id;
  };
  return { fake, prisma, iam, hire, digests: new IntelligenceDigestRepository(prisma) };
}

function mail(patch: Partial<IntelligenceDigestInput> = {}): IntelligenceDigestInput {
  return {
    domain: 'CALENDAR',
    subjectKind: 'EVENT',
    subjectRef: 'calendar_event:k_1',
    provider: 'GOOGLE_CALENDAR',
    consentBasis: 'SOURCE_CONNECTION_GRANT',
    content: { relevance: 'BUSINESS', topics: ['Renewal pricing'], synthesis: 'Waiting on your quote.', limitations: [] },
    coverage: 'CONNECTED_SUFFICIENT',
    windowStart: at(-7),
    windowEnd: at(0),
    evidenceCount: 4,
    lastEvidenceAt: at(-1),
    provenance: { sourceRefs: ['calendar_event:k_1'], anchorEventIds: ['calendar_attendee:k_9'], producerVersion: 'test.1' },
    aiInvocationId: null,
    fingerprint: 'fp-1',
    generatedAt: NOW,
    ...patch,
  };
}

function telegram(patch: Partial<IntelligenceDigestInput> = {}): IntelligenceDigestInput {
  return mail({
    domain: 'CHATS',
    subjectKind: 'CONVERSATION',
    subjectRef: 'telegram_conversation:ck_1',
    provider: 'TELEGRAM',
    consentBasis: 'CONTENT_AUTHORIZATION',
    provenance: { sourceRefs: ['telegram_conversation:ck_1'], aiInvocationId: 'inv_1', taskId: 'telegram.content.triage', taskVersion: '2.1.0', schemaId: 'x.v1', producerVersion: 'test.1' },
    ...patch,
  });
}

// --- Principal-private --------------------------------------------------------------------------

test('principal A cannot read principal B; another organization reads nothing; an OWNER reads only their own', async () => {
  const w = await world();
  const alice = await w.hire('EMPLOYEE');
  const owner = await w.hire('OWNER');
  const outsider = await w.hire('OWNER', ORG_B);
  const A = { organizationId: ORG_A, userId: alice };
  assert.equal((await w.digests.upsert(A, mail())).outcome, 'WRITTEN');

  assert.ok(await w.digests.current(A, 'CALENDAR', { subjectKind: 'EVENT', subjectRef: 'calendar_event:k_1', now: NOW }));
  assert.equal((await w.digests.forDomain(A, 'CALENDAR', { now: NOW })).length, 1);

  // Same organization, higher role: not found. There is no argument that widens the read.
  assert.equal(await w.digests.current({ organizationId: ORG_A, userId: owner }, 'CALENDAR', { subjectKind: 'EVENT', subjectRef: 'calendar_event:k_1', now: NOW }), null);
  assert.deepEqual(await w.digests.forDomain({ organizationId: ORG_A, userId: owner }, 'CALENDAR', { now: NOW }), []);
  // Another organization, even naming the right user id: not found.
  assert.deepEqual(await w.digests.forDomain({ organizationId: ORG_B, userId: alice }, 'CALENDAR', { now: NOW }), []);
  assert.deepEqual(await w.digests.forDomain({ organizationId: ORG_B, userId: outsider }, 'CALENDAR', { now: NOW }), []);
  // And a write through someone else's principal cannot touch Alice's row.
  assert.equal(await w.digests.markStale({ organizationId: ORG_A, userId: owner }, { domain: 'CALENDAR' }), 0);
  assert.deepEqual(await w.digests.withdrawForProvider({ organizationId: ORG_A, userId: owner }, 'GOOGLE_CALENDAR'), { deleted: 0 });
  assert.equal(w.fake.intelligenceDigest.__rows.length, 1);
  // A half-built principal is an error, never an unscoped query.
  await assert.rejects(() => w.digests.forDomain({ organizationId: ORG_A, userId: '' }, 'CALENDAR'), /requires both/);
});

test('the repository has no organization-wide read of digests and no role bypass (source scan)', () => {
  const src = readFileSync(join(__dirname, '..', 'src', 'repositories', 'intelligence', 'intelligence-digest.repository.ts'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
  const methods = [...code.matchAll(/^  async (\w+)\(/gm)].map((m) => m[1]);
  const principalMethods = ['current', 'deleteForPrincipal', 'forDomain', 'markStale', 'metadataFor', 'upsert', 'withdrawForProvider'];
  const organizationMethods = ['organizationCurrent', 'organizationForDomain', 'upsertOrganization'];
  assert.deepEqual(methods.sort(), [...principalMethods, ...organizationMethods, 'organizationCounts', 'purgeExpired', 'storedFingerprint'].sort());
  const bodyOf = (name: string) => code.slice(code.indexOf(`  async ${name}(`), code.indexOf('\n  }\n', code.indexOf(`  async ${name}(`)));
  // Every PRINCIPAL method resolves its scope from the principal, and every one that reads or writes
  // rows beyond a delete names scope PRINCIPAL, so it can never touch an organization row.
  for (const name of principalMethods) {
    const body = bodyOf(name);
    assert.match(body, /workScope\(principal\)/, `${name} scopes by the principal`);
    assert.match(body, /^  async \w+\(\s*principal: IntelligencePrincipal,/, `${name} takes a principal first`);
    assert.doesNotMatch(body, /'ORGANIZATION'\s*[,}]/, `${name} never names organization scope as a filter`);
  }
  for (const name of ['current', 'forDomain', 'metadataFor', 'markStale', 'upsert']) assert.match(bodyOf(name), /scope: 'PRINCIPAL'/, `${name} names PRINCIPAL scope`);
  // Every ORGANIZATION method takes the organization first, names scope ORGANIZATION with userId null,
  // and refuses a private domain before the database is asked.
  for (const name of organizationMethods) {
    const body = bodyOf(name);
    assert.match(body, /^  async \w+\(\s*organizationId: string,/, `${name} takes the organization first`);
    assert.match(body, /scope: 'ORGANIZATION', userId: null/, `${name} is confined to ORGANIZATION rows`);
    assert.match(body, /PRIVATE_INTELLIGENCE_DOMAINS\.includes/, `${name} refuses a private domain`);
    assert.doesNotMatch(body, /workScope|principal/, `${name} never reads a principal`);
  }
  // The organization reads are per domain: there is no method without a domain parameter that reads rows.
  assert.match(bodyOf('organizationForDomain'), /domain: IntelligenceDomain/);
  assert.doesNotMatch(code, /role|OWNER|ADMIN|SUPER|systemRole|can\(/, 'no role enters this repository');
  assert.doesNotMatch(code, /forOrganization|listForOrganization|countByOrganization|allFor/i);
  const purge = code.slice(code.indexOf('  async purgeExpired('));
  assert.match(purge, /return \{ purged: count \}/, 'the cross-tenant sweep returns a count, nothing else');
  // The one organization-wide read groups by four vocabularies and counts; it selects nothing else.
  const counts = bodyOf('organizationCounts');
  assert.match(counts, /groupBy\(\{\s*by: \['scope', 'domain', 'status', 'coverage'\]/);
  assert.doesNotMatch(counts, /userId|content|subjectRef|provenance|findMany|findFirst|select:/, 'no identity, no content, no row read');
  // The fingerprint lookup selects three columns and nothing else.
  assert.match(bodyOf('storedFingerprint'), /select: \{ fingerprint: true, status: true, version: true \}/);
  // Merge-safe: no read or write in this file returns a whole row.
  for (const call of code.matchAll(/intelligenceDigest\.(findFirst|findMany|create|update)\(\{[\s\S]*?\}\);/g)) {
    assert.match(call[0], /select/, `${call[1]} names its columns`);
  }
});

// --- The two metadata reads (for the web surfaces) --------------------------------------------------

function tracing(rows: Record<string, unknown>[] = []) {
  const calls: { method: string; args: any }[] = [];
  const delegate = {
    async findMany(args: any) { calls.push({ method: 'findMany', args }); return rows; },
    async groupBy(args: any) { calls.push({ method: 'groupBy', args }); return rows; },
  };
  return { calls, repo: new IntelligenceDigestRepository({ intelligenceDigest: delegate } as unknown as PrismaClient) };
}

test('metadataFor selects ONLY the metadata columns -- never content, subject or provenance -- for one principal', async () => {
  const { calls, repo } = tracing([{ domain: 'CHATS', subjectKind: 'CONVERSATION', coverage: 'CONNECTED_PARTIAL', status: 'CURRENT', generatedAt: NOW, windowEnd: NOW, evidenceCount: 3, version: 2, expiresAt: at(20) }]);
  const out = await repo.metadataFor({ organizationId: ORG_A, userId: 'user_1' }, { now: NOW });
  assert.equal(calls.length, 1);
  const { args } = calls[0]!;
  assert.deepEqual(Object.keys(args.select).sort(), ['coverage', 'domain', 'evidenceCount', 'expiresAt', 'generatedAt', 'status', 'subjectKind', 'version', 'windowEnd']);
  assert.ok(Object.values(args.select).every((v) => v === true));
  assert.equal(args.where.organizationId, ORG_A);
  assert.equal(args.where.userId, 'user_1', 'scoped to the principal');
  assert.deepEqual(args.where.expiresAt, { gt: NOW }, 'expired digests are not reported');
  assert.deepEqual(Object.keys(out[0]!).sort(), Object.keys(args.select).sort(), 'and returns nothing else');
  await assert.rejects(() => repo.metadataFor({ organizationId: ORG_A, userId: '' }, { now: NOW }), /requires both/);
});

test('metadataFor, against rows: this person\'s live digests across domains, nobody else\'s', async () => {
  const w = await world();
  const alice = await w.hire('EMPLOYEE');
  const bob = await w.hire('EMPLOYEE');
  await w.digests.upsert({ organizationId: ORG_A, userId: alice }, mail());
  await w.digests.upsert({ organizationId: ORG_A, userId: alice }, mail({ domain: 'WORK', subjectRef: 'work:k', provider: null, consentBasis: 'LOOP_RECORDS' }));
  await w.digests.upsert({ organizationId: ORG_A, userId: bob }, mail());
  const mine = await w.digests.metadataFor({ organizationId: ORG_A, userId: alice }, { now: NOW });
  assert.deepEqual(mine.map((m) => m.domain).sort(), ['CALENDAR', 'WORK']);
  assert.equal(JSON.stringify(mine).includes('Waiting on your quote'), false, 'no content');
  assert.equal(JSON.stringify(mine).includes('mail_thread'), false, 'no subject reference');
});

test('organizationCounts: counts per (scope, domain, status, coverage) for ONE organization, and no user id in the output', async () => {
  const { calls, repo } = tracing([
    { scope: 'PRINCIPAL', domain: 'CHATS', status: 'CURRENT', coverage: 'CONNECTED_PARTIAL', _count: { _all: 3 } },
    { scope: 'PRINCIPAL', domain: 'CALENDAR', status: 'STALE', coverage: 'CONNECTED_SUFFICIENT', _count: { _all: 1 } },
  ]);
  const out = await repo.organizationCounts(ORG_A, { now: NOW });
  assert.deepEqual(out, [
    { scope: 'PRINCIPAL', domain: 'CHATS', status: 'CURRENT', coverage: 'CONNECTED_PARTIAL', count: 3 },
    { scope: 'PRINCIPAL', domain: 'CALENDAR', status: 'STALE', coverage: 'CONNECTED_SUFFICIENT', count: 1 },
  ]);
  const { method, args } = calls[0]!;
  assert.equal(method, 'groupBy');
  assert.deepEqual(args.by, ['scope', 'domain', 'status', 'coverage']);
  assert.deepEqual(args._count, { _all: true });
  assert.equal(args.select, undefined);
  assert.deepEqual(Object.keys(args.where).sort(), ['expiresAt', 'organizationId', 'status'], 'the organization, and nothing that names a person');
  assert.equal(args.where.organizationId, ORG_A);
  for (const row of out) assert.deepEqual(Object.keys(row).sort(), ['count', 'coverage', 'domain', 'scope', 'status']);
  assert.deepEqual(await repo.organizationCounts('', { now: NOW }), [], 'no organization, no read');
  assert.equal(calls.length, 1);
});

// --- Minimized ------------------------------------------------------------------------------------

test('ORGANIZATION scope is refused, and so is content that carries evidence or breaks its bounds', async () => {
  const w = await world();
  const P = { organizationId: ORG_A, userId: await w.hire('EMPLOYEE') };
  assert.deepEqual(await w.digests.upsert(P, mail({ scope: 'ORGANIZATION' })), { outcome: 'REFUSED', refusal: 'ORGANIZATION_SCOPE_RESERVED' });
  for (const key of ['body', 'text', 'quote', 'message']) {
    const r = await w.digests.upsert(P, mail({ content: { synthesis: 'x', [key]: 'the actual words' } as never }));
    assert.deepEqual(r, { outcome: 'REFUSED', refusal: 'INVALID_CONTENT', contentRefusals: ['FORBIDDEN_KEY'] }, key);
  }
  assert.deepEqual(await w.digests.upsert(P, mail({ content: { synthesis: 'x'.repeat(281) } })), { outcome: 'REFUSED', refusal: 'INVALID_CONTENT', contentRefusals: ['STRING_TOO_LONG'] });
  assert.deepEqual(await w.digests.upsert(P, mail({ content: { topics: Array.from({ length: 9 }, (_, i) => `t${i}`) } })), { outcome: 'REFUSED', refusal: 'INVALID_CONTENT', contentRefusals: ['LIST_TOO_LONG'] });
  // A raw-looking subject, a coverage decided at read time, a domain rollup under another ref: refused.
  assert.equal((await w.digests.upsert(P, mail({ subjectRef: 'has spaces' }))).outcome, 'REFUSED');
  assert.equal((await w.digests.upsert(P, mail({ coverage: 'STALE' as never }))).outcome, 'REFUSED');
  assert.equal((await w.digests.upsert(P, mail({ subjectKind: 'DOMAIN', subjectRef: 'calendar_event:k_1' }))).outcome, 'REFUSED');
  assert.equal((await w.digests.upsert(P, mail({ evidenceCount: 3, lastEvidenceAt: null }))).outcome, 'REFUSED');
  assert.equal(w.fake.intelligenceDigest.__rows.length, 0, 'nothing was written');
});

test('provenance keeps only its allowlisted keys, and the stored content only the contract\'s', async () => {
  const w = await world();
  const P = { organizationId: ORG_A, userId: await w.hire('EMPLOYEE') };
  await w.digests.upsert(P, mail({ provenance: { sourceRefs: ['calendar_event:k_1'], producerVersion: 't', smuggled: 'the words' } as never }));
  const row = w.fake.intelligenceDigest.__rows[0];
  assert.deepEqual(Object.keys(row.provenance).sort(), ['aiInvocationId', 'anchorEventIds', 'consentBasis', 'producerVersion', 'schemaId', 'sourceRefs', 'taskId', 'taskVersion']);
  assert.equal(JSON.stringify(row).includes('the words'), false);
});

// --- A projection ---------------------------------------------------------------------------------

test('the same fingerprint writes nothing; a changed one overwrites the one row, version + 1', async () => {
  const w = await world();
  const P = { organizationId: ORG_A, userId: await w.hire('EMPLOYEE') };
  const first = await w.digests.upsert(P, mail());
  assert.equal(first.outcome === 'WRITTEN' && first.digest.version, 1);
  const updatedAt = w.fake.intelligenceDigest.__rows[0].updatedAt;

  const same = await w.digests.upsert(P, mail({ content: { synthesis: 'different words, same fingerprint' }, generatedAt: at(0.1) }));
  assert.equal(same.outcome, 'UNCHANGED');
  assert.equal(w.fake.intelligenceDigest.__rows[0].updatedAt, updatedAt, 'no write at all');
  assert.equal(w.fake.intelligenceDigest.__rows[0].content.synthesis, 'Waiting on your quote.');

  const changed = await w.digests.upsert(P, mail({ fingerprint: 'fp-2', content: { synthesis: 'Quote sent; waiting on them.' }, generatedAt: at(0.2) }));
  assert.equal(changed.outcome, 'WRITTEN');
  assert.equal(changed.outcome === 'WRITTEN' && changed.digest.version, 2);
  assert.equal(w.fake.intelligenceDigest.__rows.length, 1, 'one current row per subject');
  assert.equal(w.fake.intelligenceDigest.__rows[0].status, 'CURRENT');

  // Marked stale, then re-affirmed with the same meaning: CURRENT again, the version unmoved.
  assert.equal(await w.digests.markStale(P, { domain: 'CALENDAR' }), 1);
  assert.equal((await w.digests.current(P, 'CALENDAR', { subjectKind: 'EVENT', subjectRef: 'calendar_event:k_1', now: NOW }))!.status, 'STALE');
  const reaffirmed = await w.digests.upsert(P, mail({ fingerprint: 'fp-2' }));
  assert.equal(reaffirmed.outcome, 'UNCHANGED');
  assert.equal(reaffirmed.digest.status, 'CURRENT');
  assert.equal(reaffirmed.digest.version, 2);
});

test('expiry is stamped at write (30 days after the newest evidence), an expired digest is not served, and one expired at birth is refused', async () => {
  const w = await world();
  const P = { organizationId: ORG_A, userId: await w.hire('EMPLOYEE') };
  const r = await w.digests.upsert(P, mail({ lastEvidenceAt: at(-1) }));
  assert.deepEqual(r.outcome === 'WRITTEN' && r.digest.expiresAt, at(29));
  assert.equal(await w.digests.current(P, 'CALENDAR', { subjectKind: 'EVENT', subjectRef: 'calendar_event:k_1', now: at(29) }), null, 'not served once expired');
  assert.deepEqual(await w.digests.upsert(P, mail({ subjectRef: 'calendar_event:old', lastEvidenceAt: at(-40), windowStart: at(-45), windowEnd: at(-35) })), { outcome: 'REFUSED', refusal: 'EXPIRED_AT_WRITE' });
});

test('purgeExpired deletes every expired digest across tenants and returns only a count', async () => {
  const w = await world();
  const a = { organizationId: ORG_A, userId: await w.hire('EMPLOYEE') };
  const b = { organizationId: ORG_B, userId: await w.hire('EMPLOYEE', ORG_B) };
  await w.digests.upsert(a, mail({ lastEvidenceAt: at(-20) }));
  await w.digests.upsert(b, mail({ lastEvidenceAt: at(-25) }));
  await w.digests.upsert(a, mail({ subjectRef: 'calendar_event:fresh', lastEvidenceAt: at(0) }));
  assert.deepEqual(await w.digests.purgeExpired(at(9)), { purged: 1 });
  assert.deepEqual(await w.digests.purgeExpired(at(10)), { purged: 1 });
  assert.equal(w.fake.intelligenceDigest.__rows.length, 1);
});

// --- Consent --------------------------------------------------------------------------------------

test('a TELEGRAM digest is written only while the content authorization is in force, checked inside the write', async () => {
  const w = await world();
  const userId = await w.hire('EMPLOYEE');
  const P = { organizationId: ORG_A, userId };
  assert.deepEqual(await w.digests.upsert(P, telegram()), { outcome: 'REFUSED', refusal: 'CONSENT_NOT_IN_FORCE' }, 'no authorization at all');
  await w.fake.sourceContentAuthorization.create({ data: { organizationId: ORG_A, userId, provider: 'TELEGRAM', authorizedAt: at(-3), revokedAt: null } });
  assert.equal((await w.digests.upsert(P, telegram())).outcome, 'WRITTEN');
  w.fake.sourceContentAuthorization.__rows[0].revokedAt = at(-0.1);
  assert.deepEqual(await w.digests.upsert(P, telegram({ fingerprint: 'fp-9' })), { outcome: 'REFUSED', refusal: 'CONSENT_NOT_IN_FORCE' }, 'a revoke that landed first wins');
  // The basis must match the provider: nobody may write Telegram content "under the connection grant".
  assert.deepEqual(await w.digests.upsert(P, telegram({ consentBasis: 'SOURCE_CONNECTION_GRANT' })), { outcome: 'REFUSED', refusal: 'CONSENT_BASIS_MISMATCH' });
  assert.deepEqual(await w.digests.upsert(P, mail({ consentBasis: 'CONTENT_AUTHORIZATION' })), { outcome: 'REFUSED', refusal: 'CONSENT_BASIS_MISMATCH' });
  assert.deepEqual(await w.digests.upsert(P, mail({ provider: null, consentBasis: 'SOURCE_CONNECTION_GRANT' })), { outcome: 'REFUSED', refusal: 'CONSENT_BASIS_MISMATCH' });
  assert.equal((await w.digests.upsert(P, mail({ domain: 'WORK', provider: null, consentBasis: 'LOOP_RECORDS' }))).outcome, 'WRITTEN');
});

test('a person who is not an active member cannot be written for', async () => {
  const w = await world();
  const userId = await w.hire('EMPLOYEE');
  await w.iam.disableUser(ORG_A, userId);
  assert.deepEqual(await w.digests.upsert({ organizationId: ORG_A, userId }, mail()), { outcome: 'REFUSED', refusal: 'NOT_AN_ACTIVE_MEMBER' });
});

// --- Revocation, offboarding, disconnect ----------------------------------------------------------

test('revoking Telegram content consent deletes that provider\'s digests in the revoke\'s own transaction, and nothing else', async () => {
  const w = await world();
  const userId = await w.hire('EMPLOYEE');
  const colleague = await w.hire('EMPLOYEE');
  const P = { organizationId: ORG_A, userId };
  for (const u of [userId, colleague]) {
    await w.fake.sourceConnection.create({ data: { organizationId: ORG_A, userId: u, provider: 'TELEGRAM', state: 'READY' } });
    await w.fake.sourceContentAuthorization.create({ data: { organizationId: ORG_A, userId: u, provider: 'TELEGRAM', authorizedAt: at(-3), revokedAt: null } });
    await w.digests.upsert({ organizationId: ORG_A, userId: u }, telegram());
  }
  await w.digests.upsert(P, mail());

  let inTransaction = 0;
  const tx = w.fake.$transaction.bind(w.fake);
  w.fake.$transaction = async (fn: any, o?: any) => { inTransaction += 1; try { return await tx(fn, o); } finally { inTransaction -= 1; } };
  const del = w.fake.intelligenceDigest.deleteMany.bind(w.fake.intelligenceDigest);
  const deletes: number[] = [];
  w.fake.intelligenceDigest.deleteMany = async (a: any) => { deletes.push(inTransaction); return del(a); };

  const out = await new SourceContentAuthorizationRepository(w.prisma).revoke(ORG_A, userId, 'TELEGRAM', { now: NOW, actor: { userId } });
  assert.equal(out.outcome, 'REVOKED');
  assert.deepEqual(deletes, [1], 'deleted inside the revoke transaction');
  assert.deepEqual(w.fake.intelligenceDigest.__rows.map((r: any) => [r.userId, r.provider]).sort(), [[colleague, 'TELEGRAM'], [userId, 'GOOGLE_CALENDAR']].sort());
  const audit = w.fake.auditLog.__rows.find((r: any) => r.action === 'source_connection.content.revoked');
  assert.equal(audit.metadata.digestsDeleted, 1, 'counts only');
});

test('offboarding erases every digest the person holds, in the same transaction; a colleague keeps theirs', async () => {
  for (const act of ['disableMember', 'removeMember'] as const) {
    const w = await world();
    const leaver = await w.hire('EMPLOYEE');
    const colleague = await w.hire('EMPLOYEE');
    await w.digests.upsert({ organizationId: ORG_A, userId: leaver }, mail());
    await w.digests.upsert({ organizationId: ORG_A, userId: leaver }, mail({ domain: 'WORK', subjectRef: 'work:k', provider: null, consentBasis: 'LOOP_RECORDS' }));
    await w.digests.upsert({ organizationId: ORG_A, userId: colleague }, mail());
    const result = await w.iam[act](ORG_A, leaver, { userId: null });
    assert.equal(result.changed, true);
    assert.deepEqual(w.fake.intelligenceDigest.__rows.map((r: any) => r.userId), [colleague], act);
    const erased = w.fake.auditLog.__rows.find((r: any) => r.action === 'work_state.erased');
    assert.equal(erased.metadata.erased.intelligence_digests, 2, `${act} records the count`);
  }
});

test('before the migration reaches the database, offboarding still completes and a revoke still revokes', async () => {
  const w = await world();
  const leaver = await w.hire('EMPLOYEE');
  const notMigrated = () => {
    throw new Prisma.PrismaClientKnownRequestError('The table `public.intelligence_digests` does not exist in the current database.', { code: 'P2021', clientVersion: 'test' });
  };
  let touchedInTx = 0;
  w.fake.intelligenceDigest.count = async () => notMigrated();
  w.fake.intelligenceDigest.deleteMany = async () => { touchedInTx += 1; return notMigrated(); };
  assert.equal(await intelligenceDigestsPresent(w.prisma, { organizationId: ORG_A, userId: leaver }), false);
  await w.fake.sourceConnection.create({ data: { organizationId: ORG_A, userId: leaver, provider: 'TELEGRAM', state: 'READY' } });
  await w.fake.sourceContentAuthorization.create({ data: { organizationId: ORG_A, userId: leaver, provider: 'TELEGRAM', authorizedAt: at(-3), revokedAt: null } });
  assert.equal((await new SourceContentAuthorizationRepository(w.prisma).revoke(ORG_A, leaver, 'TELEGRAM', { now: NOW, actor: { userId: leaver } })).outcome, 'REVOKED');
  assert.equal((await w.iam.disableMember(ORG_A, leaver)).changed, true);
  assert.equal(touchedInTx, 0, 'the transaction never touched the missing table');
  // Any other failure still fails closed.
  w.fake.intelligenceDigest.count = async () => {
    throw new Prisma.PrismaClientKnownRequestError('Server has closed the connection.', { code: 'P1017', clientVersion: 'test' });
  };
  await assert.rejects(() => intelligenceDigestsPresent(w.prisma), (e: unknown) => (e as { code?: string }).code === 'P1017');
});

test('a disconnect past the grace window deletes that provider\'s digests for that person; a live or recent one keeps them', async () => {
  const w = await world();
  const gone = await w.hire('EMPLOYEE');
  const recent = await w.hire('EMPLOYEE');
  const back = await w.hire('EMPLOYEE');
  const disconnected = (userId: string, disconnectedAt: Date, state = 'DISCONNECTED') =>
    w.fake.sourceConnection.create({ data: { organizationId: ORG_A, userId, provider: 'TELEGRAM', state, disconnectedAt } });
  await disconnected(gone, at(-(WORK_DISCONNECT_GRACE_DAYS + 1)));
  await disconnected(recent, at(-(WORK_DISCONNECT_GRACE_DAYS - 1)));
  await disconnected(back, at(-40), 'READY');
  for (const u of [gone, recent, back]) {
    await w.fake.sourceContentAuthorization.create({ data: { organizationId: ORG_A, userId: u, provider: 'TELEGRAM', authorizedAt: at(-60), revokedAt: null } });
    await w.digests.upsert({ organizationId: ORG_A, userId: u }, telegram());
    await w.digests.upsert({ organizationId: ORG_A, userId: u }, mail());
  }
  const connections = new SourceConnectionRepository(w.prisma);
  assert.deepEqual(await connections.expireDerivedWork(ORG_A, gone, 'TELEGRAM', { now: NOW }), { outcome: 'EXPIRED', items: 0, observations: 0, digests: 1 });
  assert.deepEqual(await connections.expireDerivedWork(ORG_A, recent, 'TELEGRAM', { now: NOW }), { outcome: 'NOTHING_TO_DO' });
  assert.deepEqual(await connections.expireDerivedWork(ORG_A, back, 'TELEGRAM', { now: NOW }), { outcome: 'NOTHING_TO_DO' });
  const left = w.fake.intelligenceDigest.__rows.map((r: any) => `${r.userId === gone ? 'gone' : r.userId === recent ? 'recent' : 'back'}:${r.provider}`).sort();
  assert.deepEqual(left, ['back:GOOGLE_CALENDAR', 'back:TELEGRAM', 'gone:GOOGLE_CALENDAR', 'recent:GOOGLE_CALENDAR', 'recent:TELEGRAM']);
  const audit = w.fake.auditLog.__rows.find((r: any) => r.action === 'source_connection.derived.expired');
  assert.equal(audit.metadata.digestsDeleted, 1);
});
