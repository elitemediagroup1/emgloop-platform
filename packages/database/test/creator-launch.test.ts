import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PrismaClient } from '@prisma/client';
import { CreatorRepository } from '../src/creator/creator.repository';
import { sumReportedCreatorMetrics } from '../src/creator/creator-record.service';
import { IamRepository } from '../src/repositories/iam.repository';
import { PartyService } from '../src/services/party.service';
import { makeCognitivePrisma } from './helpers/cognitive-prisma-fake';

test('Hub onboarding adds only canonical people, stays scoped, is idempotent and creates no access', async () => {
  const fake = makeCognitivePrisma({ also: ['creatorProfile', 'organizationMembership', 'invitation'] });
  const db = fake as unknown as PrismaClient;
  const iam = new IamRepository(db);
  const parties = new PartyService(db);
  const hub = new CreatorRepository(db);
  async function member(role: 'OWNER' | 'EMPLOYEE', org: string) {
    const user = await iam.createUser({ organizationId: org, email: `${role}-${org}@example.test`, systemRole: role });
    await iam.activateUser(org, user.id);
    return user.id;
  }
  const owner = await member('OWNER', 'a');
  const employee = await member('EMPLOYEE', 'a');
  const other = await member('OWNER', 'b');
  const created = await parties.create('a', owner, { partyType: 'PERSON', displayName: 'Real Creator' });
  assert.equal(created.outcome, 'RECORDED');
  if (created.outcome !== 'RECORDED') throw new Error('fixture');
  const id = created.party.id;
  assert.deepEqual(await hub.addManagedPerson('a', owner, id), { outcome: 'NOT_FOUND' }, 'unestablished');
  await parties.establish('a', owner, id, 'MANUAL');
  assert.deepEqual(await hub.addManagedPerson('a', employee, id), { outcome: 'NOT_ALLOWED' });
  assert.deepEqual(await hub.addManagedPerson('b', other, id), { outcome: 'NOT_FOUND' });
  const result = await hub.addManagedPerson('a', owner, id);
  assert.equal(result.outcome, 'CREATED');
  if (!('profileId' in result)) throw new Error('fixture');
  assert.deepEqual(await hub.addManagedPerson('a', owner, id), { outcome: 'EXISTS', profileId: result.profileId });
  const profile = await hub.profileByParty('a', id);
  assert.equal(profile?.displayName, 'Real Creator');
  assert.equal(profile?.userId, null);
  const logs = await db.auditLog.findMany({ where: { action: 'creator.profile.created' } });
  assert.equal(logs.length, 1);
  assert.equal(JSON.stringify(logs).includes('Real Creator'), false);
  assert.equal(await db.user.count(), 3, 'no new login');
  await db.cognitiveIdentity.update({ where: { id }, data: { archivedAt: new Date() } });
  assert.deepEqual(await hub.addManagedPerson('a', owner, id), { outcome: 'NOT_FOUND' });
});

test('Analytics distinguishes reported zero, partial coverage and absent metrics', () => {
  const sum = (metrics: Record<string, number>[], keys = ['views']) => sumReportedCreatorMetrics(metrics.map(metrics => ({ metrics })), keys);
  assert.equal(sum([]), null);
  assert.equal(sum([{}]), null);
  assert.equal(sum([{ views: 0 }]), 0);
  assert.equal(sum([{ views: 12 }, {}]), null);
  assert.equal(sum([{ views: 12 }, { views: 3 }]), 15);
  assert.equal(sum([{ views: NaN }]), null);
  assert.equal(sum([{ views: -1 }]), null);
  assert.equal(sum([{ likes: 1, comments: 0, saves: 0, shares: 3 }], ['likes', 'comments', 'saves', 'shares']), 4);
  assert.equal(sum([{ likes: 1 }], ['likes', 'comments', 'saves', 'shares']), null);
});
