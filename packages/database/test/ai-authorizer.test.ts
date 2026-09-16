// Who may invoke an AI task. Slice AI-1.
//
// Invoking a model spends the organization's money and sends its evidence to a third
// party. These pin the four conditions: an active membership, a human, a listed
// invoker role, and every required permission through the ENFORCING `can()` -- where
// a Permission DENY wins. Any error is a refusal.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PrismaClient } from '@prisma/client';
import { AI_TASK_CASE_EXPLANATION, type AiTaskDefinition } from '@emgloop/shared';

import { makeCognitivePrisma } from './helpers/cognitive-prisma-fake';
import { IamRepository } from '../src/repositories/iam.repository';
import { iamAiAuthorizer, AI_INVOKER_FORBIDDEN_ROLES } from '../src/services/ai-runtime/authorizer';

const ORG = 'org_ai';

async function world() {
  const fake: any = makeCognitivePrisma({ also: ['invitation', 'organizationMembership'] });
  const prisma = fake as PrismaClient;
  const iam = new IamRepository(prisma);
  const hire = async (role: string, org = ORG) => {
    const u = await iam.createUser({ organizationId: org, email: `${role}-${Math.random()}@x.io`, systemRole: role, name: role });
    await iam.activateUser(org, u.id);
    return u.id;
  };
  return { fake, prisma, iam, hire, authorize: iamAiAuthorizer(prisma) };
}

test('only an active OWNER or ADMIN may invoke Case Explanation', async () => {
  const w = await world();
  const expected: Record<string, boolean> = {
    OWNER: true,
    ADMIN: true,
    MANAGER: false,
    EMPLOYEE: false,
    READ_ONLY: false,
    AI_EMPLOYEE: false,
    INTERN: false,
  };
  for (const [role, allowed] of Object.entries(expected)) {
    const userId = await w.hire(role);
    assert.equal(await w.authorize({ organizationId: ORG, userId }, AI_TASK_CASE_EXPLANATION), allowed, role);
  }
});

test('AI_EMPLOYEE is refused even by a task that lists it', async () => {
  const w = await world();
  const machine = await w.hire('AI_EMPLOYEE');
  const permissive: AiTaskDefinition = { ...AI_TASK_CASE_EXPLANATION, invokerRoles: ['AI_EMPLOYEE', 'OWNER'] };
  assert.equal(await w.authorize({ organizationId: ORG, userId: machine }, permissive), false);
  assert.deepEqual([...AI_INVOKER_FORBIDDEN_ROLES], ['AI_EMPLOYEE']);
});

test('a disabled member, another organization, or a missing principal is refused', async () => {
  const w = await world();
  const owner = await w.hire('OWNER');
  await w.iam.disableUser(ORG, owner);
  assert.equal(await w.authorize({ organizationId: ORG, userId: owner }, AI_TASK_CASE_EXPLANATION), false);

  const elsewhere = await w.hire('OWNER', 'org_other');
  assert.equal(await w.authorize({ organizationId: ORG, userId: elsewhere }, AI_TASK_CASE_EXPLANATION), false, 'membership is per organization');
  assert.equal(await w.authorize({ organizationId: '', userId: 'x' }, AI_TASK_CASE_EXPLANATION), false);
  assert.equal(await w.authorize({ organizationId: ORG, userId: '  ' }, AI_TASK_CASE_EXPLANATION), false);
});

test('a Permission DENY on a required grant wins over the role', async () => {
  const w = await world();
  const admin = await w.hire('ADMIN');
  w.fake.permission.__rows.push({
    id: 'perm_deny',
    organizationId: ORG,
    userId: admin,
    systemRole: null,
    resource: 'commercialIntelligence',
    action: 'view',
    effect: 'DENY',
  });
  assert.equal(await w.authorize({ organizationId: ORG, userId: admin }, AI_TASK_CASE_EXPLANATION), false);
});

test('a task that lists nobody, or requires nothing, admits nobody; and an error is a refusal', async () => {
  const w = await world();
  const owner = await w.hire('OWNER');
  const principal = { organizationId: ORG, userId: owner };
  assert.equal(await w.authorize(principal, { ...AI_TASK_CASE_EXPLANATION, invokerRoles: [] }), false);
  assert.equal(await w.authorize(principal, { ...AI_TASK_CASE_EXPLANATION, requires: [] }), false, 'an unguarded task is a mistake, not an open door');

  const exploding = iamAiAuthorizer(w.prisma, { can: async () => { throw new Error('iam unavailable'); } });
  assert.equal(await exploding(principal, AI_TASK_CASE_EXPLANATION), false);
});
