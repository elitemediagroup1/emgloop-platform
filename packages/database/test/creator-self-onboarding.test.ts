import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PrismaClient } from '@prisma/client';
import { IamRepository } from '../src/repositories/iam.repository';
import { issueCreatorInvitation } from '../src/creator/creator-invitation.service';
import { PartyService } from '../src/services/party.service';
import { makeCognitivePrisma } from './helpers/cognitive-prisma-fake';
async function world() {
  const db = makeCognitivePrisma({ also: ['creatorProfile', 'organizationMembership', 'invitation'] }) as unknown as PrismaClient;
  const iam = new IamRepository(db);
  const owner = await iam.createUser({ organizationId: 'a', email: 'owner@example.test', systemRole: 'OWNER' });
  await iam.activateUser('a', owner.id);
  const parties = new PartyService(db);
  const created = await parties.create('a', owner.id, { partyType: 'PERSON', displayName: 'Test Creator' });
  if (created.outcome !== 'RECORDED') throw Error('fixture');
  const partyId = created.party.id;
  await parties.establish('a', owner.id, partyId, 'MANUAL');
  const prepared = await iam.prepareInvitation({ organizationId: 'a', email: 'creator@example.test', systemRole: 'CREATOR', invitedByUserId: owner.id });
  if (!prepared.ok) throw Error('fixture');
  const userId = prepared.userId;
  const invitation = await iam.createInvitation({ organizationId: 'a', inviterId: owner.id, email: 'creator@example.test', systemRole: 'CREATOR', creatorPartyId: partyId, tokenHash: 'hashed-token' });
  const input = { name: 'Creator Own Name', passwordHash: 'already-hashed-password', now: new Date() };
  return { db, iam, owner, partyId, userId, invitation, input };
}
test('acceptance creates and binds the intended profile without manual staff setup or identity creation', async () => {
  const w = await world();
  assert.equal(await w.db.creatorProfile.count(), 0);
  assert.deepEqual(await w.iam.acceptCreatorInvitation('hashed-token', w.input), { email: 'creator@example.test' });
  const p = await w.db.creatorProfile.findFirst({ where: { organizationId: 'a', userId: w.userId } });
  assert.equal(p?.partyId, w.partyId); assert.equal(p?.displayName, w.input.name);
  const u = await w.iam.getUser('a', w.userId); assert.equal(u?.status, 'ACTIVE');
  assert.equal((u?.metadata as Record<string, unknown>).passwordHash, w.input.passwordHash);
  assert.equal(await w.iam.can({ organizationId: 'a', userId: w.userId, resource: 'users', action: 'create' }), false);
  assert.equal(await w.db.auditLog.count({ where: { action: 'creator.onboarding.started' } }), 1);
  assert.equal(await w.iam.acceptCreatorInvitation('hashed-token', { ...w.input, passwordHash: 'takeover' }), null);
  assert.equal(await w.db.creatorProfile.count(), 1);
});
test('expired, revoked and forged invitation tokens cannot activate a login or create a profile', async () => {
  for (const status of ['expired', 'revoked', 'forged']) {
    const w = await world();
    if (status === 'expired') await w.db.invitation.update({ where: { id: w.invitation.id }, data: { expiresAt: new Date(0) } });
    if (status === 'revoked') await w.iam.revokeInvitation('a', w.invitation.id);
    assert.equal(await w.iam.acceptCreatorInvitation(status === 'forged' ? 'wrong' : 'hashed-token', w.input), null);
    assert.equal(await w.db.creatorProfile.count(), 0);
    assert.equal((await w.iam.getUser('a', w.userId))?.status, 'INVITED');
  }
});
test('a removed marker, changed user role or inactive inviter stops acceptance', async () => {
  for (const change of ['removed', 'role', 'inviter']) {
    const w = await world();
    if (change === 'removed') await w.db.user.update({ where: { id: w.userId }, data: { metadata: { systemRole: 'CREATOR', removedAt: new Date().toISOString() } } });
    if (change === 'role') await w.iam.updateUserRole('a', w.userId, 'ADMIN');
    if (change === 'inviter') await w.db.user.update({ where: { id: w.owner.id }, data: { status: 'DISABLED' } });
    assert.equal(await w.iam.acceptCreatorInvitation('hashed-token', w.input), null);
    assert.equal(await w.db.creatorProfile.count(), 0);
  }
});
test('another tenant, archived Person and withdrawn inviter permission cannot be used as the target', async () => {
  for (const change of ['foreign', 'archived', 'denied']) {
    const w = await world();
    if (change === 'foreign') await w.db.cognitiveIdentity.update({ where: { id: w.partyId }, data: { organizationId: 'b' } });
    if (change === 'archived') await w.db.cognitiveIdentity.update({ where: { id: w.partyId }, data: { archivedAt: new Date() } });
    if (change === 'denied') await w.db.permission.create({ data: { organizationId: 'a', userId: w.owner.id, resource: 'users', action: 'create', effect: 'DENY' } });
    assert.equal(await w.iam.acceptCreatorInvitation('hashed-token', w.input), null);
    assert.equal((await w.db.invitation.findFirst({ where: { id: w.invitation.id } }))?.status, 'PENDING');
  }
});
test('existing manually prepared test profile is preserved and cannot be stolen from another login', async () => {
  for (const occupied of [false, true]) {
    const w = await world();
    const existing = await w.db.creatorProfile.create({ data: { organizationId: 'a', partyId: w.partyId, displayName: 'Manual test creator', bio: 'Preserve me', userId: occupied ? 'another-user' : null } });
    const result = await w.iam.acceptCreatorInvitation('hashed-token', w.input);
    const p = await w.db.creatorProfile.findFirst({ where: { id: existing.id } });
    assert.equal(result !== null, !occupied); assert.equal(p?.bio, 'Preserve me');
    assert.equal(p?.userId, occupied ? 'another-user' : w.userId); assert.equal(await w.db.creatorProfile.count(), 1);
  }
});
test('creator invitations require an explicitly authorized existing Person; resend retains that scope', async () => {
  const w = await world();
  await assert.rejects(w.iam.createInvitation({ organizationId: 'a', inviterId: w.owner.id, email: 'other@example.test', systemRole: 'CREATOR', tokenHash: 'not-scoped' }), /CREATOR_TARGET_REQUIRED/);
  const listed = await w.iam.listInvitations('a'); assert.equal(listed[0]?.creatorPartyId, w.partyId);
  assert.equal(await w.iam.creatorInvitationTarget('b', w.owner.id, w.partyId), false);
});

test('an authorized creator invitation automatically prepares a new Person, then the creator creates their own profile', async () => {
  const w = await world();
  await w.iam.prepareInvitation({ organizationId: 'a', email: 'self@example.test', name: 'Self Signup', systemRole: 'CREATOR', invitedByUserId: w.owner.id });
  const inv = await issueCreatorInvitation(w.db, 'a', w.owner.id, { email: 'self@example.test', name: 'Self Signup', partyId: '__new__', tokenHash: 'self-token', expiresAt: new Date(Date.now() + 60_000) });
  const partyId = (inv.metadata as Record<string, unknown>).creatorPartyId;
  assert.equal(typeof partyId, 'string'); assert.notEqual(partyId, w.partyId);
  assert.equal(await w.db.creatorProfile.count(), 0);
  assert.ok(await w.iam.acceptCreatorInvitation('self-token', { ...w.input, name: 'Self Name' }));
  assert.equal((await w.db.creatorProfile.findFirst({ where: { partyId: partyId as string } }))?.displayName, 'Self Name');
});
test('automatic Person creation requires the inviter identity approval permission; no inferred matches', async () => {
  const w = await world();
  await w.iam.prepareInvitation({ organizationId: 'a', email: 'self@example.test', systemRole: 'CREATOR', invitedByUserId: w.owner.id });
  await w.db.permission.create({ data: { organizationId: 'a', userId: w.owner.id, resource: 'identityResolution', action: 'approve', effect: 'DENY' } });
  const before = await w.db.cognitiveIdentity.count();
  await assert.rejects(issueCreatorInvitation(w.db, 'a', w.owner.id, { email: 'self@example.test', name: 'Self', partyId: '__new__', tokenHash: 'self-token', expiresAt: new Date(Date.now() + 60_000) }), /NOT_ALLOWED/);
  assert.equal(await w.db.cognitiveIdentity.count(), before);
  assert.equal(await w.iam.findInvitationByToken('self-token'), null);
});
