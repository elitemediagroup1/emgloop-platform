// Production commissioning check (2026-09-28): the REAL authorizer admits the principals the domain model
// stages run as -- the person for Calendar, the named acting operator for every organization domain.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { AI_INTELLIGENCE_TASKS } from '@emgloop/shared';

import { iamAiAuthorizer } from '../src/services/ai-runtime/authorizer';
import { DomainFactsRepository } from '../src/repositories/intelligence/domain-facts.repository';

const LOCAL = (url: string) => /^postgres(ql)?:\/\/[^@]*@(localhost|127\.0\.0\.1)(:\d+)?\//.test(url);
const URL = process.env.LOOP_TEST_POSTGRES_URL ?? '';
const skip = !URL ? 'LOOP_TEST_POSTGRES_URL is not set' : !LOCAL(URL) ? 'refusing a non-local database' : false;

test('the real authorizer admits the Calendar person and the acting operator for every domain reading it will run', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  try {
    const organizationId = `org_auth_${randomUUID()}`;
    await prisma.organization.create({ data: { id: organizationId, name: 'AUTH', slug: organizationId } });
    const ids: Record<string, string> = {};
    for (const role of ['OWNER', 'ADMIN', 'EMPLOYEE'] as const) {
      const userId = `user_auth_${role}_${randomUUID()}`;
      await prisma.user.create({ data: { id: userId, organizationId, email: `${userId}@example.test`, name: role, status: 'ACTIVE', metadata: { systemRole: role } } });
      await prisma.organizationMembership.create({ data: { organizationId, userId, systemRole: role, status: 'ACTIVE', effectiveFrom: new Date('2026-01-01T00:00:00Z') } });
      ids[role] = userId;
    }
    const authorize = iamAiAuthorizer(prisma);
    const orgTasks = AI_INTELLIGENCE_TASKS.filter((t) => t.resultOwner.subjectType === 'ORGANIZATION_DOMAIN');
    assert.ok(orgTasks.length >= 7);
    for (const role of ['OWNER', 'ADMIN'] as const) {
      // The acting operator is resolved exactly as production resolves it.
      const acting = await new DomainFactsRepository(prisma).actingOperator(organizationId, ids[role]!, new Date());
      assert.ok(acting, `${role} qualifies as the acting operator`);
      for (const task of orgTasks) {
        assert.equal(await authorize({ organizationId, userId: ids[role]! }, task), true, `${role} may run ${task.taskId}`);
      }
    }
    const calendar = AI_INTELLIGENCE_TASKS.find((t) => t.taskId === 'calendar.domain.reading')!;
    for (const role of ['OWNER', 'ADMIN', 'EMPLOYEE'] as const) assert.equal(await authorize({ organizationId, userId: ids[role]! }, calendar), true, `${role} may read their own day`);
    // An employee is never an acting operator, and may not run an organization reading.
    assert.equal(await new DomainFactsRepository(prisma).actingOperator(organizationId, ids.EMPLOYEE!, new Date()), null);
    assert.equal(await authorize({ organizationId, userId: ids.EMPLOYEE! }, orgTasks.find((t) => t.taskId === 'callgrid.domain.reading')!), false);
  } finally {
    await prisma.$disconnect();
  }
});
