// IamRepository.canEach — many permission questions, answered exactly as can().
//
// canEach exists so the navigation can ask a dozen questions without a dozen
// rounds of queries. It must never answer differently from can(), which every
// page and action still uses to enforce. This test pins the two together over
// every role, membership state and Permission-row combination that can() reads:
// user DENY, role DENY, user ALLOW, and rows that must NOT apply (another
// organization, another user, another role, a role ALLOW that can() ignores).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PrismaClient } from '@prisma/client';
import { makeCognitivePrisma } from './helpers/cognitive-prisma-fake';
import { IamRepository } from '../src/repositories/iam.repository';
import type { Resource, Action } from '../src/repositories/iam.repository';

const ORG_A = 'org_a';
const ORG_B = 'org_b';
const ROLES = ['OWNER', 'ADMIN', 'MANAGER', 'EMPLOYEE', 'AI_EMPLOYEE', 'READ_ONLY'] as const;
const RESOURCES: Resource[] = ['customers', 'users', 'audit', 'identityResolution', 'commercialIntelligence'];
const ACTIONS: Action[] = ['view', 'update', 'approve'];
const CHECKS = RESOURCES.flatMap((resource) => ACTIONS.map((action) => ({ resource, action })));

function setup() {
  const fake: any = makeCognitivePrisma({ also: ['invitation', 'organizationMembership', 'userSession'] });
  return { fake, iam: new IamRepository(fake as PrismaClient) };
}

async function member(s: ReturnType<typeof setup>, org: string, email: string, role: string) {
  const u = await s.iam.createUser({ organizationId: org, email, systemRole: role });
  await s.iam.activateUser(org, u.id);
  return u;
}

// Deterministic, so a failure reproduces.
function rng(seed: number) {
  return () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
}

async function expectSameAsCan(s: ReturnType<typeof setup>, org: string, userId: string, label: string) {
  const each = await s.iam.canEach(org, userId, CHECKS);
  for (const [i, check] of CHECKS.entries()) {
    const one = await s.iam.can({ organizationId: org, userId, ...check });
    assert.equal(each[i], one, `${label}: ${check.resource}:${check.action}`);
  }
}

test('canEach answers every question exactly as can() does, across roles and Permission rows', async () => {
  const random = rng(20260914);
  for (let scenario = 0; scenario < 40; scenario++) {
    const s = setup();
    const role = ROLES[scenario % ROLES.length]!;
    const otherRole = ROLES[(scenario + 1) % ROLES.length]!;
    const subject = await member(s, ORG_A, `subject${scenario}@x.io`, role);
    const colleague = await member(s, ORG_A, `colleague${scenario}@x.io`, otherRole);

    for (const { resource, action } of CHECKS) {
      const add = (data: Record<string, unknown>) =>
        random() < 0.18 ? s.fake.permission.create({ data: { resource, action, ...data } }) : null;
      await add({ organizationId: ORG_A, userId: subject.id, effect: 'DENY' });
      await add({ organizationId: ORG_A, userId: subject.id, effect: 'ALLOW' });
      await add({ organizationId: ORG_A, systemRole: role, effect: 'DENY' });
      await add({ organizationId: ORG_A, systemRole: role, effect: 'ALLOW' });
      await add({ organizationId: ORG_A, systemRole: otherRole, effect: 'DENY' });
      await add({ organizationId: ORG_A, userId: colleague.id, effect: 'DENY' });
      await add({ organizationId: ORG_A, userId: colleague.id, effect: 'ALLOW' });
      await add({ organizationId: ORG_B, userId: subject.id, effect: 'DENY' });
      await add({ organizationId: ORG_B, userId: subject.id, effect: 'ALLOW' });
      await add({ organizationId: ORG_A, userId: colleague.id, systemRole: role, effect: 'DENY' });
      await add({ organizationId: ORG_A, userId: subject.id, systemRole: otherRole, effect: 'ALLOW' });
    }

    await expectSameAsCan(s, ORG_A, subject.id, `scenario ${scenario} ${role}`);
    await expectSameAsCan(s, ORG_A, colleague.id, `scenario ${scenario} colleague ${otherRole}`);
  }
});

test('without an ACTIVE membership in the organization asked about, every answer is no', async () => {
  const s = setup();
  const u = await member(s, ORG_A, 'owner@x.io', 'OWNER');
  await s.fake.permission.create({ data: { organizationId: ORG_B, userId: u.id, resource: 'customers', action: 'view', effect: 'ALLOW' } });
  assert.deepEqual(await s.iam.canEach(ORG_B, u.id, CHECKS), CHECKS.map(() => false), 'another organization');
  await expectSameAsCan(s, ORG_B, u.id, 'another organization');

  await s.iam.disableUser(ORG_A, u.id);
  assert.deepEqual(await s.iam.canEach(ORG_A, u.id, CHECKS), CHECKS.map(() => false), 'disabled');
  await expectSameAsCan(s, ORG_A, u.id, 'disabled');

  assert.deepEqual(await s.iam.canEach(ORG_A, 'no-such-user', CHECKS), CHECKS.map(() => false), 'not a member');
});

test('reads the membership and the Permission rows once, however many questions are asked', async () => {
  const s = setup();
  const u = await member(s, ORG_A, 'manager@x.io', 'MANAGER');
  let permissionReads = 0;
  let membershipReads = 0;
  const findPermissions = s.fake.permission.findMany.bind(s.fake.permission);
  const findMembership = s.fake.organizationMembership.findFirst.bind(s.fake.organizationMembership);
  s.fake.permission.findMany = (args: unknown) => { permissionReads++; return findPermissions(args); };
  s.fake.organizationMembership.findFirst = (args: unknown) => { membershipReads++; return findMembership(args); };

  await s.iam.canEach(ORG_A, u.id, CHECKS);
  assert.equal(permissionReads, 1);
  assert.equal(membershipReads, 1);
  assert.deepEqual(await s.iam.canEach(ORG_A, u.id, []), []);
});
