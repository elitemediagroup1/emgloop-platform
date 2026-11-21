import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { QualificationIntakeRepository } from '../src/intake/qualification-intake.repository';
import { IamRepository } from '../src/repositories/iam.repository';
import { intakeTemplate, readIntakeTemplate, type IntakeContent } from '@emgloop/shared';
const url = process.env.LOOP_TEST_POSTGRES_URL ?? '';
const local = /^postgres(ql)?:\/\/[^@]*@(localhost|127\.0\.0\.1)(:\d+)?\//.test(url);
test(
  'intakes preserve identity, versioned questions and immutable revisions under retries, concurrent edits and tenant boundaries',
  { skip: local ? false : 'Disposable localhost Postgres required' },
  async () => {
    const db = new PrismaClient({ datasources: { db: { url } } });
    const org = `intake_${randomUUID()}`,
      foreign = `intake_${randomUUID()}`;
    try {
      for (const id of [org, foreign])
        await db.organization.create({ data: { id, name: 'Intake test', slug: id } });
      const iam = new IamRepository(db);
      async function member(
        organizationId: string,
        systemRole: 'ADMIN' | 'EMPLOYEE' | 'READ_ONLY' | 'CREATOR',
      ) {
        const u = await iam.createUser({
          organizationId,
          email: `${randomUUID()}@example.test`,
          systemRole,
        });
        await iam.activateUser(organizationId, u.id);
        return u.id;
      }
      const admin = await member(org, 'ADMIN'),
        employee = await member(org, 'EMPLOYEE'),
        readonly = await member(org, 'READ_ONLY'),
        creator = await member(org, 'CREATOR'),
        otherAdmin = await member(foreign, 'ADMIN');
      async function party(
        organizationId: string,
        entityType: 'PERSON' | 'COMPANY',
        establishedByUserId: string,
      ) {
        return db.cognitiveIdentity.create({
          data: {
            organizationId,
            entityType,
            canonicalKey: randomUUID(),
            displayName: 'Existing CRM identity',
            status: 'KNOWN',
            establishedAt: new Date(),
            establishedByUserId,
            establishmentBasis: 'MANUAL',
          },
        });
      }
      const company = await party(org, 'COMPANY', admin),
        person = await party(org, 'PERSON', admin),
        other = await party(foreign, 'COMPANY', otherAdmin);
      const repo = new QualificationIntakeRepository(db),
        template = intakeTemplate('CREATOR_ACTIVATION', 'CAMPAIGN')!;
      const content: IntakeContent = {
        opportunityId: null,
        title: 'Activation intake',
        relationshipRoles: ['BRAND_CLIENT', 'MEDIA_BUYER'],
        answers: {},
        sourceNotes: 'Conversation notes',
        decisionMakerPartyId: null,
        unresolvedIssues: '',
        nextActionOwnerUserId: null,
        nextStep: '',
        dueDate: '',
        checkpoint: '',
      };
      const input = {
        partyId: company.id,
        opportunityId: null,
        templateKey: template.key,
        subtype: template.subtype,
        requestKey: randomUUID(),
        content,
      };
      assert.equal((await repo.create(org, creator, input)).ok, false);
      assert.equal((await repo.create(org, readonly, input)).ok, false);
      assert.equal((await repo.create(org, employee, { ...input, partyId: other.id })).ok, false);
      assert.equal(
        (
          await repo.create(org, employee, {
            ...input,
            opportunityId: 'foreign',
            content: { ...content, opportunityId: 'foreign' },
          })
        ).ok,
        false,
      );
      const created = await repo.create(org, employee, input);
      assert.ok(created.ok);
      const id = created.id;
      const retry = await repo.create(org, employee, input);
      assert.deepEqual(retry, created);
      assert.equal(await db.qualificationIntake.count({ where: { organizationId: org } }), 1);
      assert.equal(await repo.read(foreign, otherAdmin, id), null);
      assert.equal(await repo.read(org, creator, id), null);
      const first = await repo.read(org, admin, id);
      assert.equal(
        readIntakeTemplate(first!.templateSnapshot)!.fields[0]!.label,
        template.fields[0]!.label,
      );
      const original = JSON.stringify(first!.revisions[0]!.content);
      const ready: IntakeContent = {
        ...content,
        answers: Object.fromEntries(template.fields.map((f) => [f.id, 'Agreed requirements'])),
        decisionMakerPartyId: person.id,
        nextActionOwnerUserId: employee,
        unresolvedIssues: 'None',
        nextStep: 'Approve the brief',
        dueDate: '2026-11-24',
        checkpoint: 'Review on November 24',
      };
      assert.equal((await repo.revise(org, employee, id, 1, 'QUALIFIED', ready)).ok, false);
      assert.equal(
        (
          await repo.revise(org, employee, id, 1, 'SUBMITTED', {
            ...ready,
            nextActionOwnerUserId: otherAdmin,
          })
        ).ok,
        false,
      );
      assert.equal((await repo.revise(org, employee, id, 1, 'SUBMITTED', content)).ok, false);
      const concurrent = await Promise.all([
        repo.revise(org, employee, id, 1, 'SUBMITTED', ready),
        repo.revise(org, employee, id, 1, 'SUBMITTED', ready),
      ]);
      assert.equal(concurrent.filter((r) => r.ok).length, 1);
      assert.equal((await repo.revise(org, admin, id, 2, 'QUALIFIED', ready)).ok, true);
      const final = await repo.read(org, admin, id);
      assert.equal(final!.state, 'QUALIFIED');
      assert.equal(final!.revisions.length, 3);
      assert.equal(JSON.stringify(final!.revisions[2]!.content), original);
      assert.deepEqual(final!.templateSnapshot, first!.templateSnapshot);
      const second = await repo.create(org, admin, {
        ...input,
        requestKey: randomUUID(),
        templateKey: 'PERFORMANCE_MEDIA',
        subtype: 'PAY_PER_CALL_BUYER',
        content: { ...content, title: 'Performance intake' },
      });
      assert.ok(second.ok);
      const opportunity = await db.crmOpportunity.create({
        data: {
          organizationId: org,
          title: 'Existing campaign opportunity',
          creatorPartyId: person.id,
          stage: 'Discovery',
          createdByUserId: admin,
        },
      });
      await db.crmParticipant.create({
        data: {
          organizationId: org,
          opportunityId: opportunity.id,
          partyId: company.id,
          partyType: 'COMPANY',
          role: 'BRAND',
          roleFamily: 'CAPACITY',
          side: null,
          actsForSide: null,
          state: 'ACTIVE',
          activeKey: randomUUID(),
        },
      });
      assert.equal(
        (
          await repo.revise(org, admin, second.id, 1, 'DRAFT', {
            ...content,
            opportunityId: opportunity.id,
          })
        ).ok,
        true,
      );
      assert.equal((await repo.read(org, admin, second.id))!.opportunityId, opportunity.id);
      assert.equal(await db.crmOpportunity.count({ where: { organizationId: org } }), 1);
      assert.equal(await db.workInstance.count({ where: { organizationId: org } }), 0);

      assert.equal((await repo.list(org, admin, { partyId: company.id }))!.count, 2);
      assert.equal(await db.cognitiveIdentity.count({ where: { organizationId: org } }), 2);
      await db.permission.create({
        data: {
          organizationId: org,
          userId: employee,
          resource: 'intakes',
          action: 'update',
          effect: 'DENY',
        },
      });
      assert.equal(
        (await repo.revise(org, employee, id, 3, 'NEEDS_CLARIFICATION', ready)).ok,
        false,
      );
    } finally {
      for (const organizationId of [org, foreign]) {
        await db.qualificationIntake.deleteMany({ where: { organizationId } });
        await db.crmOpportunity.deleteMany({ where: { organizationId } });
        await db.cognitiveIdentity.deleteMany({ where: { organizationId } });
        await db.organization.deleteMany({ where: { id: organizationId } });
      }
      await db.$disconnect();
    }
  },
);
