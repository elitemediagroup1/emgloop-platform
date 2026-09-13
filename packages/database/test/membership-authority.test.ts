// Membership-backed authority. CRM Phase Zero P0.2c.
//
// Drives the REAL IamRepository, AuthRepository and MembershipRepository against
// the in-memory Prisma double. Proves that standing and role now come from the
// ACTIVE membership in the organization; that an inactive membership, a
// membership in another organization, a session naming another organization, or
// any disagreement with the User row denies -- and never widens; that DENY and
// ALLOW rules resolve in the right organization; that identity resolution is its
// own authority, granted to no role; and that nothing about another tenant is
// discoverable from a denial.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { PrismaClient } from '@prisma/client';

import { makeCognitivePrisma } from './helpers/cognitive-prisma-fake';
import { IamRepository, matrixAllows } from '../src/repositories/iam.repository';
import { AuthRepository } from '../src/repositories/auth.repository';
import {
  MEMBERSHIP_AUTHORITY_DENIALS,
  MembershipRepository,
  resolveMembershipAuthority,
} from '../src/repositories/membership.repository';

const ORG_A = 'org_a';
const ORG_B = 'org_b';
const NOW = new Date('2026-09-14T12:00:00Z');
const ROOT = new URL('../../..', import.meta.url);
const code = (p: string) =>
  readFileSync(new URL(p, ROOT), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

function setup() {
  const fake: any = makeCognitivePrisma({ also: ['invitation', 'organizationMembership', 'userSession'] });
  const prisma = fake as PrismaClient;
  return {
    fake,
    iam: new IamRepository(prisma),
    auth: new AuthRepository(prisma),
    memberships: new MembershipRepository(prisma),
  };
}

async function member(s: ReturnType<typeof setup>, org: string, email: string, role: string) {
  const u = await s.iam.createUser({ organizationId: org, email, systemRole: role });
  await s.iam.activateUser(org, u.id);
  return u;
}

async function session(s: ReturnType<typeof setup>, org: string, userId: string, token: string) {
  await s.auth.createSession({ organizationId: org, userId, tokenHash: token, expiresAt: new Date('2099-01-01T00:00:00Z') });
}

const membershipOf = (fake: any, userId: string) =>
  fake.organizationMembership.__rows.find((m: any) => m.userId === userId);

// ---- The pure rule ----------------------------------------------------------

test('resolveMembershipAuthority grants only an in-step ACTIVE membership in the same organization', () => {
  const user = { id: 'u1', organizationId: ORG_A, status: 'ACTIVE', metadata: { systemRole: 'MANAGER' } };
  const membership = {
    id: 'm1', organizationId: ORG_A, userId: 'u1', systemRole: 'MANAGER' as const, status: 'ACTIVE' as const,
    effectiveFrom: new Date('2026-01-01T00:00:00Z'), effectiveTo: null,
  };
  assert.deepEqual(resolveMembershipAuthority({ organizationId: ORG_A, user, membership, now: NOW }), {
    granted: true, systemRole: 'MANAGER', membershipId: 'm1',
  });
  const denied = (args: Partial<Parameters<typeof resolveMembershipAuthority>[0]>) => {
    const r = resolveMembershipAuthority({ organizationId: ORG_A, user, membership, now: NOW, ...args });
    return r.granted ? 'GRANTED' : r.reason;
  };
  assert.equal(denied({ user: null }), 'NO_USER');
  assert.equal(denied({ organizationId: ORG_B }), 'WRONG_ORGANIZATION');
  assert.equal(denied({ membership: null }), 'NO_MEMBERSHIP');
  assert.equal(denied({ membership: { ...membership, organizationId: ORG_B } }), 'NO_MEMBERSHIP');
  assert.equal(denied({ membership: { ...membership, userId: 'u2' } }), 'NO_MEMBERSHIP');
  for (const status of ['INVITED', 'DISABLED', 'REMOVED'] as const) {
    assert.equal(denied({ membership: { ...membership, status } }), 'INACTIVE_MEMBERSHIP', status);
  }
  assert.equal(denied({ membership: { ...membership, effectiveTo: NOW } }), 'INACTIVE_MEMBERSHIP');
  assert.equal(denied({ membership: { ...membership, systemRole: 'OWNER' } }), 'DRIFT', 'a membership can never widen the User row');
  assert.equal(denied({ user: { ...user, metadata: { systemRole: 'OWNER' } } }), 'DRIFT', 'nor narrow it silently');
  assert.equal(denied({ user: { ...user, status: 'DISABLED' } }), 'DRIFT');
  assert.equal(denied({ user: { ...user, metadata: { systemRole: 'SUPERUSER' } } }), 'DRIFT');
  assert.deepEqual([...MEMBERSHIP_AUTHORITY_DENIALS], ['NO_USER', 'WRONG_ORGANIZATION', 'NO_MEMBERSHIP', 'INACTIVE_MEMBERSHIP', 'DRIFT']);
});

// ---- can() -----------------------------------------------------------------

test('an inactive membership fails closed, even when the User row still says ACTIVE', async () => {
  const s = setup();
  const u = await member(s, ORG_A, 'a@x.io', 'OWNER');
  assert.equal(await s.iam.can({ organizationId: ORG_A, userId: u.id, resource: 'customers', action: 'view' }), true);
  for (const status of ['INVITED', 'DISABLED', 'REMOVED']) {
    membershipOf(s.fake, u.id).status = status;
    assert.equal(await s.iam.can({ organizationId: ORG_A, userId: u.id, resource: 'customers', action: 'view' }), false, status);
  }
  membershipOf(s.fake, u.id).status = 'ACTIVE';
  s.fake.organizationMembership.__rows.length = 0;
  assert.equal(await s.iam.can({ organizationId: ORG_A, userId: u.id, resource: 'customers', action: 'view' }), false, 'no membership, no authority');
});

test('a membership that disagrees with its User row denies rather than widening', async () => {
  const s = setup();
  const u = await member(s, ORG_A, 'r@x.io', 'READ_ONLY');
  membershipOf(s.fake, u.id).systemRole = 'OWNER';
  assert.equal(await s.iam.can({ organizationId: ORG_A, userId: u.id, resource: 'users', action: 'delete' }), false);
  assert.equal(await s.iam.can({ organizationId: ORG_A, userId: u.id, resource: 'customers', action: 'view' }), false);
});

test('a membership in another organization fails closed, and so does a login from another organization', async () => {
  const s = setup();
  const u = await member(s, ORG_A, 'a@x.io', 'OWNER');
  // A forged membership in B for A's login grants nothing in B.
  await s.fake.organizationMembership.create({
    data: { organizationId: ORG_B, userId: u.id, systemRole: 'OWNER', status: 'ACTIVE', effectiveFrom: new Date('2026-01-01T00:00:00Z') },
  });
  assert.equal(await s.iam.can({ organizationId: ORG_B, userId: u.id, resource: 'customers', action: 'view' }), false);
  assert.equal((await s.memberships.authority(ORG_B, u.id)).granted, false);
  assert.equal(await s.iam.can({ organizationId: ORG_A, userId: u.id, resource: 'customers', action: 'view' }), true);
});

test('permission rules resolve in the organization being asked about, and DENY still wins', async () => {
  const s = setup();
  const a = await member(s, ORG_A, 'a@x.io', 'OWNER');
  await s.fake.permission.create({ data: { organizationId: ORG_B, userId: a.id, resource: 'customers', action: 'view', effect: 'DENY' } });
  assert.equal(await s.iam.can({ organizationId: ORG_A, userId: a.id, resource: 'customers', action: 'view' }), true, "another org's DENY does not apply");
  await s.fake.permission.create({ data: { organizationId: ORG_A, userId: a.id, resource: 'customers', action: 'view', effect: 'DENY' } });
  assert.equal(await s.iam.can({ organizationId: ORG_A, userId: a.id, resource: 'customers', action: 'view' }), false);
  await s.fake.permission.create({ data: { organizationId: ORG_A, systemRole: 'OWNER', resource: 'users', action: 'view', effect: 'DENY' } });
  assert.equal(await s.iam.can({ organizationId: ORG_A, userId: a.id, resource: 'users', action: 'view' }), false, 'role DENY uses the membership role');
});

// ---- identityResolution ----------------------------------------------------

test('identity resolution is its own authority: no role holds it, customer editing never implies it', async () => {
  const s = setup();
  for (const role of ['OWNER', 'ADMIN', 'MANAGER', 'EMPLOYEE', 'READ_ONLY'] as const) {
    const u = await member(s, ORG_A, `${role}@x.io`, role);
    for (const action of ['view', 'create', 'update', 'delete', 'manage'] as const) {
      assert.equal(matrixAllows(role, 'identityResolution', action), false, `${role} ${action}`);
      assert.equal(await s.iam.can({ organizationId: ORG_A, userId: u.id, resource: 'identityResolution', action }), false);
    }
    if (role !== 'READ_ONLY') {
      assert.equal(await s.iam.can({ organizationId: ORG_A, userId: u.id, resource: 'customers', action: 'update' }), true,
        `${role} can edit customers and still cannot assert identity`);
    }
  }
  // Only an explicit grant confers it -- and only that.
  const granted = await member(s, ORG_A, 'linker@x.io', 'EMPLOYEE');
  await s.fake.permission.create({ data: { organizationId: ORG_A, userId: granted.id, resource: 'identityResolution', action: 'update', effect: 'ALLOW' } });
  assert.equal(await s.iam.can({ organizationId: ORG_A, userId: granted.id, resource: 'identityResolution', action: 'update' }), true);
  assert.equal(await s.iam.can({ organizationId: ORG_A, userId: granted.id, resource: 'identityResolution', action: 'delete' }), false);
});

// ---- Sessions --------------------------------------------------------------

test('a session resolves only through an ACTIVE membership in the organization the session row names', async () => {
  const s = setup();
  const u = await member(s, ORG_A, 's@x.io', 'MANAGER');
  await session(s, ORG_A, u.id, 'tok-a');
  const ok = await s.auth.resolveSession('tok-a');
  assert.equal(ok?.user.id, u.id, 'the same stable User id');
  assert.equal(ok?.session.organizationId, ORG_A);
  assert.equal(ok?.systemRole, 'MANAGER', 'the role the app sees is the membership role');

  membershipOf(s.fake, u.id).status = 'DISABLED';
  assert.equal(await s.auth.resolveSession('tok-a'), null, 'inactive membership');
  membershipOf(s.fake, u.id).status = 'ACTIVE';

  await session(s, ORG_B, u.id, 'tok-b');
  assert.equal(await s.auth.resolveSession('tok-b'), null, 'a session naming another organization resolves to nothing');
});

test("a denial reveals nothing: another tenant's member and a stranger look identical", async () => {
  const s = setup();
  const b = await member(s, ORG_B, 'b@x.io', 'OWNER');
  const asOther = await s.iam.can({ organizationId: ORG_A, userId: b.id, resource: 'customers', action: 'view' });
  const asNobody = await s.iam.can({ organizationId: ORG_A, userId: 'nobody', resource: 'customers', action: 'view' });
  assert.equal(asOther, false);
  assert.equal(asNobody, false);
  await session(s, ORG_A, b.id, 'tok-x');
  assert.equal(await s.auth.resolveSession('tok-x'), null);
  assert.equal(await s.auth.resolveSession('no-such-token'), null);
});

test('the web session takes its organization from the signed session row and its role from membership; login checks membership first', () => {
  const auth = code('apps/web/src/auth/auth.ts');
  assert.match(auth, /toAuthSession\(resolved\.user, resolved\.session\.organizationId, resolved\.systemRole\)/);
  assert.equal(/userSystemRole/.test(auth), false, 'the metadata role is no longer read for the session');
  const authority = auth.indexOf('repositories.memberships.authority(user.organizationId, user.id)');
  const createSession = auth.indexOf('repositories.auth.createSession(');
  assert.ok(authority > 0 && authority < createSession, 'no session is created without membership authority');

  const canBody = code('packages/database/src/repositories/iam.repository.ts').match(/async can\([\s\S]*?\n {2}\}/)?.[0] ?? '';
  assert.match(canBody, /membershipAuthority\(this\.prisma, organizationId, userId\)/);
  assert.equal(/userSystemRole|metadata/.test(canBody), false, 'can() reads no metadata role');
});
