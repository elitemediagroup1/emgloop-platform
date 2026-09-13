// A removed member cannot be reactivated by a status flip.
//
// The legacy demo bootstrap called `activateUser` on members an administrator
// had removed, leaving them ACTIVE, hidden from the Team page and able to sign in.
// `activateUser` now refuses any row carrying the removal marker and reports that
// it wrote nothing, so neither the Team page toggle nor a stale invitation link can
// recreate that state. Removal is undone only by re-inviting.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { PrismaClient } from '@prisma/client';

import { makeCognitivePrisma } from './helpers/cognitive-prisma-fake';
import { IamRepository } from '../src/repositories/iam.repository';
import { MembershipRepository } from '../src/repositories/membership.repository';

const ORG = 'org_a';
const ROOT = new URL('../../..', import.meta.url);
const code = (p: string) =>
  readFileSync(new URL(p, ROOT), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

function setup() {
  const fake: any = makeCognitivePrisma({ also: ['invitation', 'organizationMembership'] });
  const prisma = fake as PrismaClient;
  return { fake, iam: new IamRepository(prisma), memberships: new MembershipRepository(prisma) };
}

test('activateUser refuses a removed member, writes nothing, and the membership stays REMOVED', async () => {
  const { fake, iam, memberships } = setup();
  const u = await iam.createUser({ organizationId: ORG, email: 'm@x.io', systemRole: 'MANAGER' });
  assert.equal(await iam.activateUser(ORG, u.id), true);
  await iam.softRemoveUser(ORG, u.id);
  const before = JSON.stringify([fake.user.__rows, fake.organizationMembership.__rows]);

  assert.equal(await iam.activateUser(ORG, u.id), false);
  assert.equal(JSON.stringify([fake.user.__rows, fake.organizationMembership.__rows]), before);
  assert.equal((await memberships.findMembership(ORG, u.id))?.status, 'REMOVED');
});

test('a disabled (not removed) member still reactivates, and a re-invited member activates normally', async () => {
  const { iam, memberships } = setup();
  const u = await iam.createUser({ organizationId: ORG, email: 'd@x.io', systemRole: 'EMPLOYEE' });
  await iam.activateUser(ORG, u.id);
  assert.equal(await iam.disableUser(ORG, u.id), true);
  assert.equal(await iam.activateUser(ORG, u.id), true, 'suspension is liftable');

  await iam.softRemoveUser(ORG, u.id);
  assert.equal(await iam.activateUser(ORG, u.id), false);
  const outcome = await iam.prepareInvitation({ organizationId: ORG, email: 'd@x.io', systemRole: 'EMPLOYEE', invitedByUserId: 'owner' });
  assert.ok(outcome.ok);
  assert.equal(await iam.activateUser(ORG, u.id), true, 're-inviting is the way back');
  assert.equal((await memberships.findMembership(ORG, u.id))?.status, 'ACTIVE');
});

test('status writes in another organization, or on an unknown id, report that nothing happened', async () => {
  const { iam } = setup();
  const u = await iam.createUser({ organizationId: ORG, email: 'x@x.io' });
  assert.equal(await iam.activateUser('org_b', u.id), false);
  assert.equal(await iam.disableUser('org_b', u.id), false);
  assert.equal(await iam.activateUser(ORG, 'nobody'), false);
});

test('both callers honour a refusal: no audit on the Team page, no password or acceptance on a stale link', () => {
  const actions = code('apps/web/src/crm/admin-actions.ts');
  const setStatus = actions.match(/export async function setUserStatusAction[\s\S]*?\n\}/)?.[0] ?? '';
  assert.ok(setStatus.length > 0);
  const refusal = setStatus.indexOf('if (!changed)');
  assert.ok(refusal > 0 && refusal < setStatus.indexOf('audit.record('), 'the refusal returns before any audit entry');

  const accept = code('apps/web/src/auth/actions.ts');
  const activate = accept.indexOf('const activated = await iam.activateUser(invitation.organizationId, existing.id)');
  const refused = accept.indexOf('if (!activated)');
  const setPassword = accept.indexOf('await auth.setPasswordHash(existing.id, passwordHash)');
  const acceptInvite = accept.indexOf('await iam.acceptInvitation(invitation.id)');
  assert.ok(activate > 0 && activate < refused && refused < setPassword && setPassword < acceptInvite,
    'activation is checked before a password is set or the invitation is consumed');
});
