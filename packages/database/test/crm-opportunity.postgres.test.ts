// CRM slice 3 against a REAL Postgres: accountable Opportunity ownership, Opportunity Participants
// on the one participation table, and the PD-F-11 grants. OPT-IN AND LOCAL ONLY: LOOP_TEST_POSTGRES_URL.
//
// Proves:
//   - ownership: an owner must be an ACTIVE, eligible member of THIS organization; createdByUserId
//     is untouched;
//   - ownership is accountability, not access: owning hides nothing and grants nothing;
//   - grants: the PD-F-11 matrix holds for every act and every role, and AI_EMPLOYEE gets nothing
//     even with an ALLOW Permission row;
//   - participants: BRAND is a COMPANY and PRIMARY_CONTACT is a PERSON, enforced by the service
//     AND the database; other roles and sides are refused; Party Reference refusals are kept,
//     across tenants too; history is kept;
//   - compatibility: Relationship reads are unaffected by Opportunity participations;
//   - atomicity: a refused or failed act leaves nothing;
//   - concurrency: racing closes apply once;
//   - privacy: no Party name reaches an audit row.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

import { CrmOpportunityService } from '../src/services/crm-opportunity.service';
import { CrmCommercialRepository } from '../src/creator/crm-commercial.repository';
import { CrmRelationshipRepository } from '../src/repositories/crm-relationship.repository';
import { CrmRelationshipReadModelRepository } from '../src/repositories/crm-relationship-read-model.repository';
import { AuditRepository } from '../src/repositories/audit.repository';
import { IamRepository } from '../src/repositories/iam.repository';

const LOCAL = (url: string) => /^postgres(ql)?:\/\/[^@]*@(localhost|127\.0\.0\.1)(:\d+)?\//.test(url);
const URL = process.env.LOOP_TEST_POSTGRES_URL ?? '';
const skip = !URL ? 'LOOP_TEST_POSTGRES_URL is not set' : !LOCAL(URL) ? 'refusing a non-local database' : false;

const ROLES = ['OWNER', 'ADMIN', 'MANAGER', 'EMPLOYEE', 'READ_ONLY', 'AI_EMPLOYEE', 'CREATOR'] as const;
type Role = (typeof ROLES)[number];

async function tenant(prisma: PrismaClient, label: string) {
  const organizationId = `0opp_${label}_${randomUUID()}`;
  await prisma.organization.create({ data: { id: organizationId, name: `OPP ${label}`, slug: organizationId } });
  const users = {} as Record<Role, string>;
  for (const role of ROLES) {
    const id = `user_opp_${role.toLowerCase()}_${randomUUID()}`;
    await prisma.user.create({ data: { id, organizationId, email: `${id}@example.test`, name: `${role} person`, status: 'ACTIVE', metadata: { systemRole: role } } });
    await prisma.organizationMembership.create({ data: { organizationId, userId: id, systemRole: role, status: 'ACTIVE', effectiveFrom: new Date('2026-01-01T00:00:00Z') } });
    users[role] = id;
  }
  const actor = (role: Role) => ({ organizationId, userId: users[role] });
  return { organizationId, users, actor };
}

async function party(prisma: PrismaClient, organizationId: string, type: 'PERSON' | 'COMPANY', opts: { established?: boolean; archived?: boolean; displayName?: string } = {}) {
  const owner = await prisma.organizationMembership.findFirstOrThrow({ where: { organizationId, systemRole: 'OWNER' } });
  const row = await prisma.cognitiveIdentity.create({
    data: {
      organizationId,
      entityType: type,
      canonicalKey: `party:${randomUUID()}`,
      displayName: opts.displayName ?? `${type} ${randomUUID().slice(0, 6)}`,
      status: opts.archived ? 'ARCHIVED' : 'KNOWN',
      ...(opts.established === false ? {} : { establishedAt: new Date('2026-09-01T00:00:00Z'), establishmentBasis: 'MANUAL', establishedByUserId: owner.userId }),
    },
  });
  return row.id;
}

async function opportunity(prisma: PrismaClient, organizationId: string, createdByUserId: string, title = 'Spring pursuit') {
  const creator = await party(prisma, organizationId, 'PERSON', { displayName: 'Creator person' });
  const row = await new CrmCommercialRepository(prisma).createOpportunity({ organizationId, title, stage: 'Prospecting', creatorPartyId: creator, createdByUserId });
  return row.id;
}

test('ownership: an ACTIVE eligible member of this organization only; createdByUserId stays provenance; every change audited', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  try {
    const t = await tenant(prisma, 'owner');
    const other = await tenant(prisma, 'owner_other');
    const service = new CrmOpportunityService(prisma);
    const opp = await opportunity(prisma, t.organizationId, t.users.ADMIN);

    assert.equal((await service.assignOwner(t.actor('EMPLOYEE'), opp, { ownerUserId: t.users.MANAGER })).outcome, 'RECORDED');
    let row = await prisma.crmOpportunity.findUniqueOrThrow({ where: { id: opp } });
    assert.deepEqual([row.ownerUserId, row.createdByUserId], [t.users.MANAGER, t.users.ADMIN], 'owner set; creation provenance untouched');

    const refusedOwners: Record<string, string> = {
      'another tenant': other.users.OWNER,
      'a READ_ONLY seat': t.users.READ_ONLY,
      'an AI employee': t.users.AI_EMPLOYEE,
      'a creator login': t.users.CREATOR,
      'an unknown id': 'user_does_not_exist',
    };
    const inactive = `user_opp_inactive_${randomUUID()}`;
    await prisma.user.create({ data: { id: inactive, organizationId: t.organizationId, email: `${inactive}@example.test`, name: 'Gone', status: 'DISABLED', metadata: { systemRole: 'EMPLOYEE' } } });
    await prisma.organizationMembership.create({ data: { organizationId: t.organizationId, userId: inactive, systemRole: 'EMPLOYEE', status: 'DISABLED', effectiveFrom: new Date('2026-01-01T00:00:00Z') } });
    refusedOwners['a disabled member'] = inactive;
    for (const [label, ownerUserId] of Object.entries(refusedOwners)) {
      assert.deepEqual(await service.assignOwner(t.actor('OWNER'), opp, { ownerUserId }), { outcome: 'OWNER_NOT_ELIGIBLE' }, label);
    }
    row = await prisma.crmOpportunity.findUniqueOrThrow({ where: { id: opp } });
    assert.equal(row.ownerUserId, t.users.MANAGER, 'never repaired, never substituted');

    assert.deepEqual(await service.assignOwner(t.actor('OWNER'), opp, { ownerUserId: t.users.MANAGER }), { outcome: 'UNCHANGED' });
    assert.deepEqual(await service.assignOwner(t.actor('OWNER'), opp, { ownerUserId: t.users.EMPLOYEE, expectedOwnerUserId: t.users.OWNER }), { outcome: 'RETRY' }, 'a stale view does not overwrite');
    assert.equal((await service.assignOwner(t.actor('OWNER'), opp, { ownerUserId: null })).outcome, 'RECORDED', 'an owner may be cleared');
    assert.equal((await prisma.crmOpportunity.findUniqueOrThrow({ where: { id: opp } })).ownerUserId, null);

    const audit = await prisma.auditLog.findMany({ where: { organizationId: t.organizationId, entityId: opp }, orderBy: { createdAt: 'asc' } });
    assert.deepEqual(
      audit.map((a) => [a.action, (a.metadata as Record<string, unknown>).fromOwnerUserId, (a.metadata as Record<string, unknown>).toOwnerUserId]),
      [['opportunity.owner_changed', null, t.users.MANAGER], ['opportunity.owner_changed', t.users.MANAGER, null]],
      'two recorded changes, two audit rows; refusals and no-ops write none',
    );
    assert.deepEqual(await service.assignOwner(other.actor('OWNER'), opp, { ownerUserId: other.users.EMPLOYEE }), { outcome: 'NOT_FOUND' }, 'another tenant cannot even find it');
  } finally {
    await prisma.$disconnect();
  }
});

test('ownership is accountability, not access: owning hides nothing and grants nothing', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  try {
    const t = await tenant(prisma, 'access');
    const service = new CrmOpportunityService(prisma);
    const opp = await opportunity(prisma, t.organizationId, t.users.OWNER);
    await service.assignOwner(t.actor('OWNER'), opp, { ownerUserId: t.users.MANAGER });
    for (const role of ['OWNER', 'ADMIN', 'MANAGER', 'EMPLOYEE', 'READ_ONLY'] as const) {
      assert.equal((await service.read(t.actor(role), opp)).outcome, 'OK', `${role} still sees an Opportunity it does not own`);
    }
    const brand = await party(prisma, t.organizationId, 'COMPANY');
    assert.equal((await service.addParticipant(t.actor('EMPLOYEE'), { opportunityId: opp, partyId: brand, role: 'BRAND' })).outcome, 'RECORDED', 'a non-owner EMPLOYEE still works it');
    assert.equal((await service.assignOwner(t.actor('EMPLOYEE'), opp, { ownerUserId: t.users.EMPLOYEE })).outcome, 'RECORDED', 'and may reassign it (PD-F-11 CHANGE_OWNER)');
    const contact = await party(prisma, t.organizationId, 'PERSON');
    assert.deepEqual(await service.addParticipant(t.actor('READ_ONLY'), { opportunityId: opp, partyId: contact, role: 'PRIMARY_CONTACT' }), { outcome: 'NOT_AUTHORIZED' }, 'and ownership grants a READ_ONLY seat nothing');
  } finally {
    await prisma.$disconnect();
  }
});

test('PD-F-11 holds for every act and every role; AI_EMPLOYEE gets nothing even with an ALLOW row', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  try {
    const t = await tenant(prisma, 'grants');
    const service = new CrmOpportunityService(prisma);
    const expected: Record<string, readonly Role[]> = {
      read: ['OWNER', 'ADMIN', 'MANAGER', 'EMPLOYEE', 'READ_ONLY'],
      assignOwner: ['OWNER', 'ADMIN', 'MANAGER', 'EMPLOYEE'],
      addParticipant: ['OWNER', 'ADMIN', 'MANAGER', 'EMPLOYEE'],
      endParticipant: ['OWNER', 'ADMIN', 'MANAGER'],
      voidParticipant: ['OWNER', 'ADMIN'],
    };
    const opp = await opportunity(prisma, t.organizationId, t.users.OWNER);
    const freshParticipant = async () => {
      const p = await party(prisma, t.organizationId, 'COMPANY');
      const r = await service.addParticipant(t.actor('OWNER'), { opportunityId: opp, partyId: p, role: 'BRAND' });
      return (r as { value: { id: string } }).value.id;
    };
    for (const role of ROLES) {
      const outcomes = {
        read: (await service.read(t.actor(role), opp)).outcome === 'OK',
        assignOwner: (await service.assignOwner(t.actor(role), opp, { ownerUserId: t.users.ADMIN === (await prisma.crmOpportunity.findUniqueOrThrow({ where: { id: opp } })).ownerUserId ? t.users.OWNER : t.users.ADMIN })).outcome === 'RECORDED',
        addParticipant: (await service.addParticipant(t.actor(role), { opportunityId: opp, partyId: await party(prisma, t.organizationId, 'PERSON'), role: 'PRIMARY_CONTACT' })).outcome === 'RECORDED',
        endParticipant: (await service.endParticipant(t.actor(role), await freshParticipant(), { reason: 'Brand paused the program' })).outcome === 'RECORDED',
        voidParticipant: (await service.voidParticipant(t.actor(role), await freshParticipant(), { reason: 'Recorded on the wrong pursuit' })).outcome === 'RECORDED',
      };
      for (const [act, allowed] of Object.entries(outcomes)) assert.equal(allowed, expected[act]!.includes(role), `${act} ${role}`);
      if (!expected.assignOwner!.includes(role)) {
        // Only the two helper participants (added by OWNER) may have been audited for this role.
        assert.equal(await prisma.auditLog.count({ where: { organizationId: t.organizationId, userId: t.users[role] } }), 0, `nothing audited as ${role}`);
      }
    }
    await prisma.permission.create({ data: { organizationId: t.organizationId, userId: t.users.AI_EMPLOYEE, resource: 'opportunities', action: 'view', effect: 'ALLOW' } as never });
    await prisma.permission.create({ data: { organizationId: t.organizationId, systemRole: 'AI_EMPLOYEE', resource: 'opportunities', action: 'manage', effect: 'ALLOW' } as never });
    assert.deepEqual(await service.read(t.actor('AI_EMPLOYEE'), opp), { outcome: 'NOT_AUTHORIZED' }, 'no Permission row lifts the hard denial');
    assert.equal(await service.permits(t.actor('AI_EMPLOYEE'), 'UPDATE'), false);
    // A page guarded only by requirePermission('opportunities', 'view') relies on these two alone.
    const iam = new IamRepository(prisma);
    assert.equal(await iam.can({ organizationId: t.organizationId, userId: t.users.AI_EMPLOYEE, resource: 'opportunities', action: 'view' }), false, 'can(): no ALLOW row lifts it');
    assert.deepEqual(await iam.canEach(t.organizationId, t.users.AI_EMPLOYEE, [{ resource: 'opportunities', action: 'view' }]), [false], 'canEach(): no ALLOW row lifts it');
    assert.equal(await iam.can({ organizationId: t.organizationId, userId: t.users.READ_ONLY, resource: 'opportunities', action: 'view' }), true, 'while every human role holds view');
    await prisma.permission.create({ data: { organizationId: t.organizationId, userId: t.users.EMPLOYEE, resource: 'opportunities', action: 'view', effect: 'DENY' } as never });
    assert.equal(await service.permits(t.actor('EMPLOYEE'), 'UPDATE'), false, 'a DENY on the coarse gate removes every act');
  } finally {
    await prisma.$disconnect();
  }
});

test('participants: BRAND is a COMPANY and PRIMARY_CONTACT a PERSON; Party Reference refusals hold; history is kept', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  try {
    const t = await tenant(prisma, 'parts');
    const other = await tenant(prisma, 'parts_other');
    const service = new CrmOpportunityService(prisma);
    const owner = t.actor('OWNER');
    const opp = await opportunity(prisma, t.organizationId, t.users.OWNER);
    const opp2 = await opportunity(prisma, t.organizationId, t.users.OWNER, 'Fall pursuit');
    const company = await party(prisma, t.organizationId, 'COMPANY');
    const person = await party(prisma, t.organizationId, 'PERSON');
    const identitiesBefore = await prisma.cognitiveIdentity.count({ where: { organizationId: t.organizationId } });
    const add = (opportunityId: string, partyId: string, role: string) => service.addParticipant(owner, { opportunityId, partyId, role });

    assert.equal((await add(opp, company, 'BRAND')).outcome, 'RECORDED');
    assert.equal((await add(opp, person, 'PRIMARY_CONTACT')).outcome, 'RECORDED');
    assert.deepEqual(await add(opp, person, 'BRAND'), { outcome: 'INVALID', violations: ['PARTY_TYPE_NOT_PERMITTED_FOR_ROLE'] }, 'a Person is never the brand');
    assert.deepEqual(await add(opp, company, 'PRIMARY_CONTACT'), { outcome: 'INVALID', violations: ['PARTY_TYPE_NOT_PERMITTED_FOR_ROLE'] }, 'a Company is never the primary contact');
    assert.deepEqual(await add(opp, person, 'CREATOR'), { outcome: 'INVALID', violations: ['ROLE_NOT_PERMITTED_FOR_SUBJECT'] }, 'the creator is creatorPartyId, not a Participant');
    assert.deepEqual(await add(opp, company, 'AGENCY'), { outcome: 'INVALID', violations: ['ROLE_NOT_PERMITTED_FOR_SUBJECT'] });
    assert.deepEqual(await add(opp, company, 'BRAND'), { outcome: 'DUPLICATE' });
    assert.equal((await add(opp2, company, 'BRAND')).outcome, 'RECORDED', 'one Company may be the brand of many Opportunities');
    assert.equal((await add(opp2, person, 'PRIMARY_CONTACT')).outcome, 'RECORDED', 'one Person may be the contact on many');

    const canonical = await party(prisma, t.organizationId, 'COMPANY');
    const superseded = await party(prisma, t.organizationId, 'COMPANY');
    await prisma.cognitiveIdentity.update({ where: { id: superseded }, data: { supersededByIdentityId: canonical, supersededAt: new Date() } });
    assert.deepEqual(await add(opp, superseded, 'BRAND'), { outcome: 'PARTY_REFUSED', refusal: 'SUPERSEDED', canonicalPartyId: canonical }, 'refused with the canonical id, never swapped');
    assert.deepEqual(await add(opp, await party(prisma, t.organizationId, 'COMPANY', { established: false }), 'BRAND'), { outcome: 'PARTY_REFUSED', refusal: 'NOT_ESTABLISHED' });
    assert.equal((await add(opp, await party(prisma, t.organizationId, 'COMPANY', { archived: true }), 'BRAND')).outcome, 'PARTY_REFUSED');
    assert.deepEqual(await add(opp, await party(prisma, other.organizationId, 'COMPANY'), 'BRAND'), { outcome: 'PARTY_REFUSED', refusal: 'NOT_FOUND' }, 'another tenant’s Party is not found');
    assert.deepEqual(await service.addParticipant(other.actor('OWNER'), { opportunityId: opp, partyId: await party(prisma, other.organizationId, 'COMPANY'), role: 'BRAND' }), { outcome: 'NOT_FOUND' }, 'another tenant’s Opportunity is not found');
    assert.equal(await prisma.cognitiveIdentity.count({ where: { organizationId: t.organizationId } }) - identitiesBefore, 4, 'only the four fixture Parties made in this tenant: the authority creates none');

    const rows = (await service.read(owner, opp)) as { value: { participants: { id: string; partyId: string; role: string }[] } };
    const brandRow = rows.value.participants.find((p) => p.role === 'BRAND')!;
    assert.deepEqual(await service.endParticipant(t.actor('MANAGER'), brandRow.id, { reason: ' ' }), { outcome: 'REASON_REQUIRED' });
    assert.equal((await service.endParticipant(t.actor('MANAGER'), brandRow.id, { reason: 'The brand moved to another agency' })).outcome, 'RECORDED');
    assert.deepEqual(await service.voidParticipant(owner, brandRow.id, { reason: 'x' }), { outcome: 'ILLEGAL_TRANSITION', from: 'ENDED' }, 'closed only from ACTIVE, as on a Relationship');
    assert.equal((await add(opp, company, 'BRAND')).outcome, 'RECORDED', 'ending released the key; the role may be held again');
    const history = await prisma.crmParticipant.findMany({ where: { organizationId: t.organizationId, opportunityId: opp, partyId: company }, orderBy: { addedAt: 'asc' } });
    assert.deepEqual(history.map((h) => h.state), ['ENDED', 'ACTIVE'], 'the ended row is kept, never rewritten');
    assert.equal(history[0]!.endReason, 'The brand moved to another agency');

    const oppRow = await prisma.crmOpportunity.findUniqueOrThrow({ where: { id: opp } });
    assert.deepEqual([oppRow.creatorVisibleState, oppRow.brandVisibleToCreator, oppRow.summaryForCreator], [null, false, null], 'participants change nothing a creator sees');
  } finally {
    await prisma.$disconnect();
  }
});

test('the database refuses an invalid Opportunity Participant whatever the caller', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  try {
    const t = await tenant(prisma, 'check');
    const opp = await opportunity(prisma, t.organizationId, t.users.OWNER);
    const rel = await new CrmRelationshipRepository(prisma).create(t.organizationId, {
      kind: 'CLIENT',
      sides: [{ side: 'COUNTERPARTY', partyId: await party(prisma, t.organizationId, 'COMPANY'), role: 'BRAND' }],
      actorUserId: t.users.OWNER,
      occurredAt: new Date(),
    });
    const relationshipId = (rel as { value: { relationship: { id: string } } }).value.relationship.id;
    const base = { organizationId: t.organizationId, opportunityId: opp, partyId: 'p', partyType: 'COMPANY', role: 'BRAND', roleFamily: 'CAPACITY', state: 'ACTIVE', activeKey: `k_${randomUUID()}` };
    const bad: Record<string, Record<string, unknown>> = {
      'BRAND held by a PERSON': { partyType: 'PERSON' },
      'PRIMARY_CONTACT held by a COMPANY': { role: 'PRIMARY_CONTACT', roleFamily: 'ENGAGEMENT' },
      'another role on an Opportunity': { role: 'AGENCY' },
      'a side on an Opportunity': { side: 'COUNTERPARTY' },
      'two subjects': { relationshipId },
      'no subject': { opportunityId: null },
      'an ended row without a reason': { state: 'ENDED', activeKey: null, endedAt: new Date() },
      'a voided row without a reason': { state: 'VOIDED', activeKey: null, voidedAt: new Date() },
    };
    for (const [label, patch] of Object.entries(bad)) await assert.rejects(prisma.crmParticipant.create({ data: { ...base, ...patch } as never }), label);
    await prisma.crmParticipant.create({ data: base as never });
    await prisma.crmParticipant.create({ data: { ...base, partyType: 'PERSON', role: 'PRIMARY_CONTACT', roleFamily: 'ENGAGEMENT', activeKey: `k_${randomUUID()}` } as never });
  } finally {
    await prisma.$disconnect();
  }
});

test('Relationship reads are unaffected: a brand with many Opportunity participations still lists its Relationship', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  try {
    const t = await tenant(prisma, 'compat');
    const service = new CrmOpportunityService(prisma);
    const brand = await party(prisma, t.organizationId, 'COMPANY');
    const relationships = new CrmRelationshipRepository(prisma);
    await relationships.create(t.organizationId, { kind: 'CLIENT', sides: [{ side: 'COUNTERPARTY', partyId: brand, role: 'BRAND' }], actorUserId: t.users.OWNER, occurredAt: new Date() });
    for (let i = 0; i < 6; i += 1) {
      const opp = await opportunity(prisma, t.organizationId, t.users.OWNER, `Pursuit ${i}`);
      assert.equal((await service.addParticipant(t.actor('OWNER'), { opportunityId: opp, partyId: brand, role: 'BRAND' })).outcome, 'RECORDED');
    }
    const found = await relationships.forParty(t.organizationId, brand);
    assert.deepEqual(found.map((r) => r.kind), ['CLIENT'], 'exactly the Relationship; no Opportunity participation is mistaken for one');

    // The read model scans a capped number of participations (100). A brand pursued for many
    // creators must not push its real Relationship past that cap: 120 Opportunity participations
    // written FIRST, then the Relationship.
    const busy = await party(prisma, t.organizationId, 'COMPANY');
    const creator = await party(prisma, t.organizationId, 'PERSON');
    const oppIds = Array.from({ length: 120 }, () => `opp_${randomUUID()}`);
    await prisma.crmOpportunity.createMany({ data: oppIds.map((id) => ({ id, organizationId: t.organizationId, title: 'Bulk', stage: 'Prospecting', creatorPartyId: creator, createdByUserId: t.users.OWNER })) });
    await prisma.crmParticipant.createMany({
      data: oppIds.map((opportunityId) => ({ organizationId: t.organizationId, opportunityId, partyId: busy, partyType: 'COMPANY', role: 'BRAND', roleFamily: 'CAPACITY', state: 'ACTIVE', activeKey: `OPPORTUNITY:${opportunityId}:${busy}:BRAND`, addedByUserId: t.users.OWNER })),
    });
    await relationships.create(t.organizationId, { kind: 'CLIENT', sides: [{ side: 'COUNTERPARTY', partyId: busy, role: 'BRAND' }], actorUserId: t.users.OWNER, occurredAt: new Date() });
    const page = await new CrmRelationshipReadModelRepository(prisma).forParty(t.organizationId, busy);
    assert.equal(page.items.length, 1, 'the Relationship is still listed beside 120 Opportunity participations');
  } finally {
    await prisma.$disconnect();
  }
});

test('atomic and concurrent: a failed audit keeps nothing; racing closes apply once; no Party name reaches the audit trail', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  try {
    const t = await tenant(prisma, 'atomic');
    const opp = await opportunity(prisma, t.organizationId, t.users.OWNER);
    const brand = await party(prisma, t.organizationId, 'COMPANY', { displayName: 'Secret Brand Name' });
    const contact = await party(prisma, t.organizationId, 'PERSON', { displayName: 'Private Person Name' });

    const real = new AuditRepository(prisma);
    const failing = new CrmOpportunityService(prisma, { audit: { record: async (args, tx) => { await real.record(args, tx); throw new Error('failed after audit'); } } });
    await assert.rejects(failing.addParticipant(t.actor('OWNER'), { opportunityId: opp, partyId: brand, role: 'BRAND' }), /failed after audit/);
    await assert.rejects(failing.assignOwner(t.actor('OWNER'), opp, { ownerUserId: t.users.MANAGER }), /failed after audit/);
    assert.equal(await prisma.crmParticipant.count({ where: { organizationId: t.organizationId } }), 0, 'no participant survives');
    assert.equal((await prisma.crmOpportunity.findUniqueOrThrow({ where: { id: opp } })).ownerUserId, null, 'no owner survives');
    assert.equal(await prisma.auditLog.count({ where: { organizationId: t.organizationId } }), 0, 'and no audit row');

    const service = new CrmOpportunityService(prisma);
    await service.addParticipant(t.actor('OWNER'), { opportunityId: opp, partyId: contact, role: 'PRIMARY_CONTACT' });
    const added = await service.addParticipant(t.actor('OWNER'), { opportunityId: opp, partyId: brand, role: 'BRAND' });
    const id = (added as { value: { id: string } }).value.id;
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) =>
        i % 2 ? service.voidParticipant(t.actor('OWNER'), id, { reason: `Void ${i}` }) : service.endParticipant(t.actor('ADMIN'), id, { reason: `End ${i}` }),
      ),
    );
    assert.ok(results.every((r) => r.status === 'fulfilled'), JSON.stringify(results.map((r) => (r.status === 'rejected' ? String(r.reason).slice(0, 100) : r.value.outcome))));
    assert.equal(results.filter((r) => r.status === 'fulfilled' && r.value.outcome === 'RECORDED').length, 1, 'exactly one close applies');
    assert.equal(await prisma.auditLog.count({ where: { organizationId: t.organizationId, action: { in: ['opportunity.participant_ended', 'opportunity.participant_voided'] } } }), 1);

    const trail = JSON.stringify(await prisma.auditLog.findMany({ where: { organizationId: t.organizationId } }));
    assert.ok(!trail.includes('Secret Brand Name') && !trail.includes('Private Person Name'), 'ids only');
    assert.ok(!/Void \d|End \d/.test(trail), 'a reason’s words stay on the row');
  } finally {
    await prisma.$disconnect();
  }
});
