import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { IamRepository } from '../src/repositories/iam.repository';
import { CreatorHubRepository } from '../src/creator/creator-hub.repository';
import { CreatorRepository } from '../src/creator/creator.repository';
const url = process.env.LOOP_TEST_POSTGRES_URL ?? '',
  local = /^postgres(ql)?:\/\/[^@]*@(localhost|127\.0\.0\.1)(:\d+)?\//.test(url);
test(
  'Postgres: creator-private questions, explicit team sharing and manager-only preferences',
  { skip: local ? false : 'Disposable localhost Postgres required' },
  async () => {
    const db = new PrismaClient({ datasources: { db: { url } } }),
      org = `hub_${randomUUID()}`;
    try {
      await db.organization.create({ data: { id: org, name: 'EMG test', slug: org } });
      const iam = new IamRepository(db);
      async function user(role: 'ADMIN' | 'CREATOR' | 'EMPLOYEE') {
        const u = await iam.createUser({
          organizationId: org,
          email: `${randomUUID()}@example.test`,
          systemRole: role,
        });
        await iam.activateUser(org, u.id);
        return u.id;
      }
      const employee = await user('EMPLOYEE');
      const manager = { organizationId: org, userId: await user('ADMIN'), canActOnAnyStep: true },
        creator = await user('CREATOR'),
        other = await user('CREATOR');
      const profile = await db.creatorProfile.create({
          data: {
            organizationId: org,
            userId: creator,
            partyId: 'hub-party',
            displayName: 'Creator',
          },
        }),
        p = { organizationId: org, userId: creator, creatorProfileId: profile.id },
        repo = new CreatorHubRepository(db);
      const privateDetails = {
        personalEmail: 'personal@example.test', phone: '+12025550123', dateOfBirth: '1996-02-29',
        addressLine1: 'PO Box 123', addressLine2: '', city: 'New York', region: 'NY', postalCode: '10001', country: 'United States',
      };
      assert.equal(await repo.ownContactDetails(p), null);
      assert.equal(await repo.saveContactDetails({ ...p, userId: other }, privateDetails), false);
      assert.equal(await repo.saveContactDetails({ ...p, organizationId: 'another-org' }, privateDetails), false);
      assert.equal(await repo.saveContactDetails(p, { ...privateDetails, dateOfBirth: '1997-02-29' }), false);
      assert.equal(await repo.saveContactDetails(p, privateDetails), true);
      assert.equal((await repo.ownContactDetails(p))?.personalEmail, privateDetails.personalEmail);
      assert.equal(await repo.ownContactDetails({ ...p, userId: other }), null);
      assert.equal(await repo.managerContactDetails({ organizationId: org, userId: employee }, profile.id), null);
      assert.equal(await repo.managerContactDetails(p, profile.id), null);
      assert.equal(await repo.managerContactDetails({ ...manager, organizationId: 'another-org' }, profile.id), null);
      assert.equal((await repo.managerContactDetails(manager, profile.id))?.dateOfBirth, '1996-02-29');
      assert.equal(await repo.saveContactDetails(p, { ...privateDetails, addressLine1: 'PO Box 456' }), true);
      assert.equal((await repo.ownContactDetails(p))?.addressLine1, 'PO Box 456');
      const publicProfile = await new CreatorRepository(db).profileById(org, profile.id);
      assert.ok(publicProfile);
      assert.equal('contactDetails' in publicProfile, false);
      assert.doesNotMatch(JSON.stringify(publicProfile), /personal@example.test|PO Box 456|1996-02-29/);
      assert.equal(await repo.configure(p, profile.id, [manager.userId], {}), false);
      assert.equal(await repo.configure(manager, profile.id, [other], {}), false);
      assert.equal(
        await repo.configure(manager, profile.id, [manager.userId], { ACR: 'ACR Electronics' }),
        true,
      );
      assert.equal((await repo.contacts(p))[0]!.id, manager.userId);
      assert.deepEqual(await repo.contacts({ ...p, userId: other }), []);
      await new CreatorRepository(db).updateProfile(org, profile.id, {
        preferences: { creatorTeam: [other], creatorBrandAliases: { ACR: 'Wrong' } },
      });
      const settings = (await db.creatorProfile.findUniqueOrThrow({ where: { id: profile.id } }))
        .preferences as any;
      assert.deepEqual(settings.creatorTeam, [manager.userId]);
      assert.equal(settings.creatorBrandAliases.ACR, 'ACR Electronics');
      const question = {
        body: 'Can we clarify the deliverables?',
        brandId: null,
        brand: null,
        submission: randomUUID(),
      };
      const id = await repo.ask(p, question);
      assert.ok(id);
      assert.equal(await repo.ask(p, question), id);
      assert.deepEqual(await repo.messages({ ...p, userId: other }), []);
      await db.workComment.create({
        data: {
          workInstanceId: id!,
          userId: manager.userId,
          body: 'Private staff strategy',
          visibility: 'internal',
        },
      });
      assert.equal(
        await repo.reply(manager, profile.id, id!, 'We will clarify the brief with you.', true),
        true,
      );
      assert.equal((await repo.alerts(p)).length, 1);
      const alert = (await repo.alerts(p))[0]!;
      assert.equal(await repo.markReplyRead({ ...p, userId: other }, alert.id), false);
      assert.equal(await repo.markReplyRead(p, alert.id), true);
      assert.equal((await repo.alerts(p)).length, 0);
      const messages = await repo.messages(p);
      assert.equal(messages.length, 1);
      assert.equal(messages[0]!.replies.length, 1);
      assert.equal(messages[0]!.replies[0]!.body, 'We will clarify the brief with you.');
      assert.equal(JSON.stringify(messages).includes('Private staff strategy'), false);
      assert.equal(await repo.configure(manager, profile.id, [employee], {}), true);
      const staff = { organizationId: org, userId: employee, canActOnAnyStep: false };
      assert.equal((await repo.questionForWork(staff, id!))?.id, id);
      assert.equal(await repo.reply(staff, profile.id, id!, 'Shared employee reply', false), true);
      assert.equal(await repo.questionForWork({ ...staff, userId: other }, id!), null);
      assert.equal(await repo.configure(manager, profile.id, [manager.userId], {}), true);
      assert.equal(
        await repo.questionForWork(staff, id!),
        null,
        'removed team membership withdraws reply access',
      );
      await db.permission.create({
        data: {
          organizationId: org,
          userId: manager.userId,
          resource: 'work',
          action: 'update',
          effect: 'DENY',
        },
      });
      assert.equal(await repo.configure(manager, profile.id, [], {}), false);
      assert.equal(await repo.reply(manager, profile.id, id!, 'Denied reply', false), false);
      await db.creatorProfile.update({ where: { id: profile.id }, data: { userId: other } });
      assert.deepEqual(await repo.messages(p), []);
      assert.deepEqual(await repo.messages({ ...p, userId: other }), []);
    } finally {
      await db.organization.delete({ where: { id: org } });
      await db.$disconnect();
    }
  },
);
