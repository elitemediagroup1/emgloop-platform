// CRM slice 5 (decisions A and B) against a REAL Postgres: the governed Opportunity create writer,
// and the caller-transaction variants of the governed writers. OPT-IN AND LOCAL ONLY.
//
// Proves:
//   - create is PD-F-11 CREATE: EMPLOYEE and above; READ_ONLY, AI_EMPLOYEE (even with an ALLOW
//     row) and CREATOR refused; an inactive membership refused;
//   - the creator is an established, current, non-archived PERSON of this organization, checked by
//     the Party Reference contract: a COMPANY, an unestablished, archived or superseded Party, or
//     another tenant's, is refused (superseded with its canonical id, never swapped);
//   - a Relationship is optional; another tenant's or a voided one is refused; none is created;
//   - the creator stays creatorPartyId and is never a Participant; no owner; createdByUserId is the
//     actor; the first transition has no note and is not creator-visible; nothing creator-visible;
//   - the row, its transition and its audit row are one transaction; the audit carries no title;
//   - inside a caller's transaction, Party create + establish + Contact Point add + Opportunity
//     create + addParticipant compose, see each other's writes, and roll back together.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

import { CrmOpportunityService } from '../src/services/crm-opportunity.service';
import { CrmContactPointService } from '../src/services/crm-contact-point.service';
import { PartyService } from '../src/services/party.service';

const LOCAL = (url: string) => /^postgres(ql)?:\/\/[^@]*@(localhost|127\.0\.0\.1)(:\d+)?\//.test(url);
const URL = process.env.LOOP_TEST_POSTGRES_URL ?? '';
const skip = !URL ? 'LOOP_TEST_POSTGRES_URL is not set' : !LOCAL(URL) ? 'refusing a non-local database' : false;

const ROLES = ['OWNER', 'ADMIN', 'MANAGER', 'EMPLOYEE', 'READ_ONLY', 'AI_EMPLOYEE', 'CREATOR'] as const;
type Role = (typeof ROLES)[number];

async function tenant(prisma: PrismaClient, label: string) {
  const organizationId = `0oc_${label}_${randomUUID()}`;
  await prisma.organization.create({ data: { id: organizationId, name: `OC ${label}`, slug: organizationId } });
  const users = {} as Record<Role, string>;
  for (const role of ROLES) {
    const id = `user_oc_${role.toLowerCase()}_${randomUUID()}`;
    await prisma.user.create({ data: { id, organizationId, email: `${id}@example.test`, name: `${role} person`, status: 'ACTIVE', metadata: { systemRole: role } } });
    await prisma.organizationMembership.create({ data: { organizationId, userId: id, systemRole: role, status: 'ACTIVE', effectiveFrom: new Date('2026-01-01T00:00:00Z') } });
    users[role] = id;
  }
  const party = async (type: 'PERSON' | 'COMPANY', opts: { established?: boolean; archived?: boolean } = {}) =>
    (
      await prisma.cognitiveIdentity.create({
        data: {
          organizationId,
          entityType: type,
          canonicalKey: `party:${randomUUID()}`,
          displayName: `${type} ${randomUUID().slice(0, 4)}`,
          status: opts.archived ? 'ARCHIVED' : 'KNOWN',
          ...(opts.established === false ? {} : { establishedAt: new Date('2026-09-01T00:00:00Z'), establishmentBasis: 'MANUAL', establishedByUserId: users.OWNER }),
        },
      })
    ).id;
  return { organizationId, users, actor: (role: Role) => ({ organizationId, userId: users[role] }), party };
}

const shape = (creatorPartyId: string) => ({ title: 'Trevon Hill × Lund Boats', category: 'OPEN', stage: 'Imported', creatorPartyId });

test('create: PD-F-11 CREATE for EMPLOYEE and above; everyone else refused', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  try {
    const t = await tenant(prisma, 'grant');
    const service = new CrmOpportunityService(prisma);
    const creator = await t.party('PERSON');
    for (const role of ['OWNER', 'ADMIN', 'MANAGER', 'EMPLOYEE'] as const) {
      assert.equal((await service.create(t.actor(role), shape(creator))).outcome, 'RECORDED', role);
    }
    await prisma.permission.create({ data: { organizationId: t.organizationId, userId: t.users.AI_EMPLOYEE, resource: 'opportunities', action: 'view', effect: 'ALLOW' } });
    for (const role of ['READ_ONLY', 'AI_EMPLOYEE', 'CREATOR'] as const) {
      assert.deepEqual(await service.create(t.actor(role), shape(creator)), { outcome: 'NOT_AUTHORIZED' }, role);
    }
    await prisma.organizationMembership.updateMany({ where: { organizationId: t.organizationId, userId: t.users.EMPLOYEE }, data: { status: 'DISABLED' } });
    assert.deepEqual(await service.create(t.actor('EMPLOYEE'), shape(creator)), { outcome: 'NOT_AUTHORIZED' });
    assert.equal(await prisma.crmOpportunity.count({ where: { organizationId: t.organizationId } }), 4, 'no refusal wrote anything');
  } finally {
    await prisma.$disconnect();
  }
});

test('create: the creator is a referenceable PERSON of this organization; a Relationship is optional and must be valid', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  try {
    const t = await tenant(prisma, 'refs');
    const other = await tenant(prisma, 'refs_other');
    const service = new CrmOpportunityService(prisma);
    const a = t.actor('EMPLOYEE');
    const person = await t.party('PERSON');
    const merged = await t.party('PERSON');
    await prisma.cognitiveIdentity.update({ where: { id: merged }, data: { supersededByIdentityId: person } });

    assert.deepEqual(await service.create(a, shape(await t.party('COMPANY'))), { outcome: 'INVALID', violations: ['CREATOR_NOT_A_PERSON'] });
    assert.deepEqual(await service.create(a, shape(await t.party('PERSON', { established: false }))), { outcome: 'PARTY_REFUSED', refusal: 'NOT_ESTABLISHED' });
    assert.deepEqual(await service.create(a, shape(await t.party('PERSON', { archived: true }))), { outcome: 'PARTY_REFUSED', refusal: 'ARCHIVED' });
    assert.deepEqual(await service.create(a, shape(merged)), { outcome: 'PARTY_REFUSED', refusal: 'SUPERSEDED', canonicalPartyId: person }, 'refused with the canonical id, never swapped');
    assert.deepEqual(await service.create(a, shape(await other.party('PERSON'))), { outcome: 'PARTY_REFUSED', refusal: 'NOT_FOUND' }, 'another tenant\'s creator is not found');
    assert.deepEqual(await service.create(a, { ...shape(person), title: ' ', stage: '', category: 'MAYBE' }), { outcome: 'INVALID', violations: ['TITLE_REQUIRED', 'UNKNOWN_CATEGORY', 'STAGE_REQUIRED'] });

    const foreignRelationship = await prisma.crmRelationship.create({
      data: { organizationId: other.organizationId, kind: 'TALENT_REPRESENTATION', structure: 'OWN', state: 'ACTIVE', nonVoidedNaturalKey: `nk-${randomUUID()}`, createdByUserId: other.users.OWNER },
    });
    assert.deepEqual(await service.create(a, { ...shape(person), relationshipId: foreignRelationship.id }), { outcome: 'RELATIONSHIP_REFUSED' }, 'another tenant\'s Relationship');
    const voided = await prisma.crmRelationship.create({
      data: { organizationId: t.organizationId, kind: 'TALENT_REPRESENTATION', structure: 'OWN', state: 'VOIDED', createdAt: new Date('2026-09-01T00:00:00Z'), voidedAt: new Date('2026-09-02T00:00:00Z'), createdByUserId: t.users.OWNER },
    });
    assert.deepEqual(await service.create(a, { ...shape(person), relationshipId: voided.id }), { outcome: 'RELATIONSHIP_REFUSED' }, 'a voided Relationship');
    const live = await prisma.crmRelationship.create({
      data: { organizationId: t.organizationId, kind: 'TALENT_REPRESENTATION', structure: 'OWN', state: 'ACTIVE', nonVoidedNaturalKey: `nk-${randomUUID()}`, createdByUserId: t.users.OWNER },
    });
    const linked = await service.create(a, { ...shape(person), relationshipId: live.id });
    assert.ok(linked.outcome === 'RECORDED', 'a valid Relationship of this organization may be named');
    assert.equal((await prisma.crmOpportunity.findUniqueOrThrow({ where: { id: linked.value.id } })).relationshipId, live.id);
    await prisma.crmOpportunity.delete({ where: { id: linked.value.id } });
    assert.deepEqual(await service.create(a, { ...shape(person), relationshipId: 'no-such-relationship' }), { outcome: 'RELATIONSHIP_REFUSED' });
    assert.equal(await prisma.crmRelationship.count({ where: { organizationId: t.organizationId } }), 2, 'only the two this test made: create never makes one');
    assert.equal(await prisma.crmOpportunity.count({ where: { organizationId: t.organizationId } }), 0);
  } finally {
    await prisma.$disconnect();
  }
});

test('create: the row, its lifecycle-only first transition and its audit row; the creator is never a Participant', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  try {
    const t = await tenant(prisma, 'row');
    const service = new CrmOpportunityService(prisma);
    const creator = await t.party('PERSON');
    const r = await service.create(t.actor('MANAGER'), { title: '  Trevon Hill × Lund Boats ', category: 'CLOSED_WON', stage: ' Won ', creatorPartyId: creator });
    assert.ok(r.outcome === 'RECORDED');
    const row = await prisma.crmOpportunity.findUniqueOrThrow({ where: { id: r.value.id }, include: { transitions: true, participants: true } });
    assert.deepEqual(
      [row.title, row.category, row.stage, row.creatorPartyId, row.ownerUserId, row.createdByUserId, row.relationshipId, row.creatorVisibleState, row.brandVisibleToCreator, row.internalNotes],
      ['Trevon Hill × Lund Boats', 'CLOSED_WON', 'Won', creator, null, t.users.MANAGER, null, null, false, null],
    );
    assert.deepEqual(row.transitions.map((x) => [x.sequence, x.fromCategory, x.fromStage, x.toCategory, x.toStage, x.actorUserId, x.note, x.creatorVisible]), [[1, null, null, 'CLOSED_WON', 'Won', t.users.MANAGER, null, false]], 'no invented "Opened" note');
    assert.deepEqual(row.participants, [], 'the creator is creatorPartyId, not a Participant');
    const audit = await prisma.auditLog.findMany({ where: { organizationId: t.organizationId, entityId: row.id } });
    assert.deepEqual(audit.map((x) => [x.action, x.userId]), [['opportunity.created', t.users.MANAGER]]);
    assert.ok(!JSON.stringify(audit).includes('Lund'), 'the audit row carries no title');
    assert.equal(await prisma.stateChangeOutbox.count({ where: { organizationId: t.organizationId } }), 0, 'no Opportunity outbox subject exists, so none is invented');
  } finally {
    await prisma.$disconnect();
  }
});

test('caller transactions: the governed writers compose, see each other, and roll back together', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  try {
    const t = await tenant(prisma, 'tx');
    const parties = new PartyService(prisma);
    const points = new CrmContactPointService(prisma);
    const opportunities = new CrmOpportunityService(prisma);
    const owner = t.actor('OWNER');
    const creator = await t.party('PERSON');
    const counts = async () =>
      Promise.all([
        prisma.cognitiveIdentity.count({ where: { organizationId: t.organizationId } }),
        prisma.crmContactPoint.count({ where: { organizationId: t.organizationId } }),
        prisma.crmOpportunity.count({ where: { organizationId: t.organizationId } }),
        prisma.crmParticipant.count({ where: { organizationId: t.organizationId } }),
        prisma.auditLog.count({ where: { organizationId: t.organizationId } }),
        prisma.stateChangeOutbox.count({ where: { organizationId: t.organizationId } }),
      ]);
    const unit = (fail: boolean) =>
      prisma.$transaction(async (tx) => {
        const company = await parties.create(t.organizationId, owner.userId, { partyType: 'COMPANY', displayName: 'Composed Co' }, { tx });
        assert.ok(company.outcome === 'RECORDED');
        // Established inside the same transaction, so the next writers' Party Reference checks see it.
        assert.equal((await parties.establish(t.organizationId, owner.userId, company.party.id, 'MANUAL', { tx })).outcome, 'RECORDED');
        assert.equal((await points.add(owner, { partyId: company.party.id, kind: 'EMAIL', value: `team-${fail}@composed.example.test`, classification: 'ROLE_INBOX', basis: 'IMPORTED', sourceRef: 'test:row-1' }, { tx })).outcome, 'RECORDED');
        const opp = await opportunities.create(owner, shape(creator), { tx });
        assert.ok(opp.outcome === 'RECORDED');
        assert.equal((await opportunities.addParticipant(owner, { opportunityId: opp.value.id, partyId: company.party.id, role: 'BRAND' }, { tx })).outcome, 'RECORDED');
        // A repeat inside the unit is DUPLICATE, answered without a failed statement -- so the
        // caller's transaction stays usable (a failed insert would abort it in Postgres).
        assert.equal((await points.add(owner, { partyId: company.party.id, kind: 'EMAIL', value: `team-${fail}@composed.example.test`, classification: 'ROLE_INBOX', basis: 'IMPORTED', sourceRef: 'test:row-1' }, { tx })).outcome, 'DUPLICATE');
        assert.equal((await opportunities.addParticipant(owner, { opportunityId: opp.value.id, partyId: company.party.id, role: 'BRAND' }, { tx })).outcome, 'DUPLICATE');
        assert.equal(await tx.crmParticipant.count({ where: { opportunityId: opp.value.id } }), 1, 'the transaction is still usable after both');
        if (fail) throw new Error('a later step of the unit failed');
      });

    const before = await counts();
    await assert.rejects(unit(true), /a later step/);
    assert.deepEqual(await counts(), before, 'Party, establishment, Contact Point, its outbox, Opportunity, Participant and every audit row rolled back');
    await unit(false);
    const after = await counts();
    assert.deepEqual(after.map((n, i) => n - before[i]!), [1, 1, 1, 1, 5, 1], 'one Party, one Contact Point, one Opportunity, one Participant; five audit rows; one Contact Point outbox event');
  } finally {
    await prisma.$disconnect();
  }
});
