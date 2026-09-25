// Loop Intelligence Phase D (2026-09-26): Mail content consent against a REAL Postgres.
// OPT-IN AND LOCAL ONLY (LOOP_TEST_POSTGRES_URL).
//
//   - While the counterparty-consent decision is not recorded, a person cannot even grant Mail content
//     consent: nothing is written.
//   - With the decision recorded and a Gmail read grant, the consent is the SAME kind of row as Telegram's
//     (source_content_authorizations, provider GMAIL), and a MAIL digest rests on it (CONTENT_AUTHORIZATION).
//   - Revoke race: a producer that finishes after the revoke lands nothing (CONSENT_NOT_IN_FORCE).
//   - Revoking deletes the person's MAIL digests in the same transaction; a colleague's stay.
//   - The Telegram worker never discovers a GMAIL row; offboarding revokes it like any other.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

import { IamRepository } from '../src/repositories/iam.repository';
import { IntelligenceDigestRepository, type IntelligenceDigestInput } from '../src/repositories/intelligence/intelligence-digest.repository';
import { SourceContentAuthorizationRepository } from '../src/repositories/source-content-authorization.repository';
import { GoogleTokenSealer } from '../src/services/google/google-token-sealer';

const URL = process.env.LOOP_TEST_POSTGRES_URL ?? '';
const LOCAL = /^postgres(ql)?:\/\/[^@]*@(localhost|127\.0\.0\.1)(:\d+)?\//.test(URL);
const skip = !URL ? 'LOOP_TEST_POSTGRES_URL is not set' : !LOCAL ? 'refusing a non-local database' : false;

const NOW = new Date('2026-09-26T12:00:00Z');
const GMAIL = 'https://www.googleapis.com/auth/gmail.readonly';
const DECIDED = 'counterparty-consent:2026-10-15:legal/mail-consent-v1';
const sealer = new GoogleTokenSealer(randomBytes(32));

async function tenant(prisma: PrismaClient) {
  const organizationId = `org_mail_${randomUUID()}`;
  await prisma.organization.create({ data: { id: organizationId, name: 'Mail', slug: organizationId } });
  const users: string[] = [];
  for (const [i, role] of (['OWNER', 'EMPLOYEE'] as const).entries()) {
    const userId = `user_mail_${i}_${randomUUID()}`;
    await prisma.user.create({ data: { id: userId, organizationId, email: `${userId}@example.test`, name: 'M', status: 'ACTIVE', metadata: { systemRole: role, passwordHash: 'kept' } } });
    await prisma.organizationMembership.create({ data: { organizationId, userId, systemRole: role, status: 'ACTIVE', effectiveFrom: new Date('2026-01-01T00:00:00Z') } });
    const sub = `sub_${randomUUID().slice(0, 12)}`;
    const sealed = sealer.seal({ organizationId, userId, googleSubject: sub }, `1//refresh-${sub}`);
    await prisma.googleConnection.create({
      data: { organizationId, userId, googleSubject: sub, activeGoogleSubject: sub, emailAtLink: `${userId}@example.test`, status: 'CONNECTED', grantedScopes: [GMAIL], requestedScopes: [GMAIL], refreshTokenSealed: Buffer.from(sealed.sealed), sealVersion: sealed.sealVersion, keyRef: sealed.keyRef, connectedAt: NOW },
    });
    users.push(userId);
  }
  return { organizationId, users };
}

const mailDigest = (patch: Partial<IntelligenceDigestInput> = {}): IntelligenceDigestInput => ({
  domain: 'MAIL', subjectKind: 'THREAD', subjectRef: 'work_thread:th_1', provider: 'GMAIL', consentBasis: 'CONTENT_AUTHORIZATION',
  content: { synthesis: 'Premier is waiting on the revised allocation.' }, coverage: 'CONNECTED_SUFFICIENT',
  windowStart: new Date(NOW.getTime() - 86_400_000), windowEnd: NOW, evidenceCount: 3, lastEvidenceAt: NOW,
  provenance: { sourceRefs: ['work_thread:th_1'], producerVersion: 'mail.thread@1', producerKind: 'MODEL' }, aiInvocationId: 'inv_1', fingerprint: 'mail-fp-1', generatedAt: NOW, ...patch,
});

test('Mail content consent: refused until the governance decision is recorded; then the same consent row and the same revoke', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  const { organizationId, users: [owner, alice] } = await tenant(prisma);
  try {
    const consent = new SourceContentAuthorizationRepository(prisma);
    const actor = { userId: alice!, name: null };
    for (const decision of [null, '', 'yes', 'approved']) {
      assert.deepEqual(await consent.authorizeMailContent(organizationId, alice!, { now: NOW, actor, governanceDecision: decision }), { outcome: 'GOVERNANCE_UNDECIDED' });
    }
    assert.equal(await prisma.sourceContentAuthorization.count({ where: { organizationId } }), 0, 'nothing written while undecided');
    // A MAIL digest drawn from content cannot be written without the consent.
    const digests = new IntelligenceDigestRepository(prisma);
    assert.deepEqual(await digests.upsert({ organizationId, userId: alice! }, mailDigest()), { outcome: 'REFUSED', refusal: 'CONSENT_NOT_IN_FORCE' });
    assert.deepEqual(await digests.upsert({ organizationId, userId: alice! }, mailDigest({ consentBasis: 'SOURCE_CONNECTION_GRANT' })), { outcome: 'REFUSED', refusal: 'CONSENT_BASIS_MISMATCH' }, 'a mailbox grant is not mail-content consent');

    const granted = await consent.authorizeMailContent(organizationId, alice!, { now: NOW, actor, governanceDecision: DECIDED });
    assert.equal(granted.outcome, 'AUTHORIZED');
    assert.equal((await consent.get(organizationId, alice!, 'GMAIL'))?.revokedAt, null);
    assert.equal((await consent.authorizeMailContent(organizationId, owner!, { now: NOW, actor: { userId: owner!, name: null }, governanceDecision: DECIDED })).outcome, 'AUTHORIZED');
    assert.equal((await digests.upsert({ organizationId, userId: alice! }, mailDigest())).outcome, 'WRITTEN');
    assert.equal((await digests.upsert({ organizationId, userId: owner! }, mailDigest())).outcome, 'WRITTEN');

    // The Telegram worker's discovery never sweeps a GMAIL row.
    assert.equal((await consent.dueForContent(2000)).some((d) => d.organizationId === organizationId), false);

    // Revoke: Alice's MAIL digests go in the same transaction; the owner's stay; a late write lands nothing.
    assert.equal((await consent.revokeMailContent(organizationId, alice!, { now: NOW, actor })).outcome, 'REVOKED');
    assert.equal(await prisma.intelligenceDigest.count({ where: { organizationId, userId: alice! } }), 0);
    assert.equal(await prisma.intelligenceDigest.count({ where: { organizationId, userId: owner! } }), 1);
    assert.deepEqual(await digests.upsert({ organizationId, userId: alice! }, mailDigest({ fingerprint: 'late' })), { outcome: 'REFUSED', refusal: 'CONSENT_NOT_IN_FORCE' });
    assert.equal((await consent.revokeMailContent(organizationId, alice!, { now: NOW, actor })).outcome, 'NOTHING_TO_DO');

    // Without a Gmail read grant there is nothing to consent to.
    await prisma.googleConnection.updateMany({ where: { organizationId, userId: alice! }, data: { grantedScopes: [] } });
    assert.equal((await consent.authorizeMailContent(organizationId, alice!, { now: NOW, actor, governanceDecision: DECIDED })).outcome, 'NO_CONNECTION');

    // Offboarding revokes the GMAIL consent like any other and takes the digests with it.
    assert.equal((await new IamRepository(prisma).removeMember(organizationId, owner!, { userId: alice! })).changed, true);
    const row = await prisma.sourceContentAuthorization.findFirst({ where: { organizationId, userId: owner!, provider: 'GMAIL' } });
    assert.ok(row?.revokedAt, 'revoked at offboarding');
    assert.equal(await prisma.intelligenceDigest.count({ where: { organizationId, userId: owner! } }), 0);
  } finally {
    await prisma.organization.delete({ where: { id: organizationId } }).catch(() => undefined);
    await prisma.$disconnect();
  }
});
