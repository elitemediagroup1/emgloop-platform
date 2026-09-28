// The domain kit's backoff after a rejected answer, against the REAL ai_invocations ledger (2026-09-28): the
// query that decides whether Loop pays again for a reading whose last answer it discarded. Scoped by
// organization, principal, task version and template version; reads outcomes only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

import { AiUsageLedgerRepository } from '../src/repositories/ai-usage-ledger.repository';

const LOCAL = (url: string) => /^postgres(ql)?:\/\/[^@]*@(localhost|127\.0\.0\.1)(:\d+)?\//.test(url);
const URL = process.env.LOOP_TEST_POSTGRES_URL ?? '';
const skip = !URL ? 'LOOP_TEST_POSTGRES_URL is not set' : !LOCAL(URL) ? 'refusing a non-local database' : false;

test('rejectedSince: a REJECTED_BY_LOOP answer backs off only its own subject, question and window', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  try {
    const org = `org_backoff_${randomUUID()}`;
    const other = `org_backoff_other_${randomUUID()}`;
    const users = { user_a: `user_a_${randomUUID()}`, user_b: `user_b_${randomUUID()}` };
    for (const id of [org, other]) {
      await prisma.organization.create({ data: { id, name: 'BACKOFF', slug: id } });
      for (const [k, u] of Object.entries(users)) await prisma.user.create({ data: { id: `${u}_${id.slice(-6)}`, organizationId: id, email: `${u}_${id.slice(-6)}@example.test`, name: k, status: 'ACTIVE', metadata: {} } });
    }
    const uid = (organizationId: string, k: keyof typeof users) => `${users[k]}_${organizationId.slice(-6)}`;
    const at = new Date('2026-09-28T12:00:00Z');
    const row = (organizationId: string, patch: Record<string, unknown>) =>
      prisma.aiInvocation.create({
        data: {
          organizationId, invocationId: `inv_${randomUUID()}`, principalUserId: uid(organizationId, 'user_a'), taskId: 'calendar.domain.reading', taskVersion: '1.0.0',
          profile: 'GENERAL_REASONING', providerId: 'anthropic', requestedModelId: 'model-a', routingPolicyVersion: 'routing.pg.0',
          templateId: 'domain-reading', templateVersion: '2', contextManifestHash: 'h', contextSourceCount: 1,
          outcome: 'REJECTED_BY_LOOP', failureClass: 'OUTPUT_INVALID', rejectionCodes: ['UNSUPPORTED_DATE_IN_TEXT'], requestedAt: at, completedAt: at,
          businessDate: new Date('2026-09-28T00:00:00.000Z'),
          ...patch,
        },
      });
    const ledger = new AiUsageLedgerRepository(prisma);
    const q = { taskId: 'calendar.domain.reading', taskVersion: '1.0.0', templateId: 'domain-reading', templateVersion: '2', principalUserId: uid(org, 'user_a'), since: new Date(at.getTime() - 60_000) };

    assert.equal(await ledger.rejectedSince(org, q), false, 'nothing recorded: no backoff');
    await row(other, {});
    assert.equal(await ledger.rejectedSince(org, q), false, "another organization's rejection never counts");
    await row(org, { outcome: 'ANSWERED', failureClass: null, rejectionCodes: [] });
    await row(org, { templateVersion: '1' });
    await row(org, { principalUserId: uid(org, 'user_b') });
    await row(org, { requestedAt: new Date(at.getTime() - 2 * 60_000) });
    assert.equal(await ledger.rejectedSince(org, q), false, 'an answer, an older template, another person, and a row before the window do not count');
    assert.equal(await ledger.rejectedSince(org, { ...q, principalUserId: null }), true, 'an organization reading counts whoever ran it');
    await row(org, {});
    assert.equal(await ledger.rejectedSince(org, q), true);
    assert.equal(await ledger.rejectedSince(org, { ...q, taskVersion: '1.0.1' }), false, 'a new task version is a new question');
  } finally {
    await prisma.$disconnect();
  }
});
