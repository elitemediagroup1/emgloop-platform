// CRM slice 4 against a REAL Postgres: the organization-wide staff read of Opportunities.
// OPT-IN AND LOCAL ONLY: LOOP_TEST_POSTGRES_URL.
//
// Proves:
//   - access: PD-F-11 VIEW for every human role; AI_EMPLOYEE (even with an ALLOW row) and CREATOR
//     refused; another tenant's Opportunity is NOT_FOUND;
//   - projection: creator, owner (never createdByUserId), missing owner, BRANDs, PRIMARY_CONTACTs,
//     none, several, and ENDED / VOIDED never shown as current; superseded Parties keep their id;
//   - names follow the Party gate; no role receives note text (only THAT one was recorded), and the
//     source notes are untouched; contact values only through the Contact Point authority;
//   - tenant safety: another tenant's Party, User and Opportunity never resolve;
//   - search and filters: deterministic, organization-scoped, no name search without the gate;
//   - pagination: stable keyset order, no duplicates or gaps, a forged cursor refused;
//   - bounded queries: a page of 3 and a page of 30 cost the same number of queries;
//   - `resolveMany` answers exactly as `resolve` does, chain by chain.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

import { CrmOpportunityReadService } from '../src/services/crm-opportunity-read.service';
import { CrmOpportunityService } from '../src/services/crm-opportunity.service';
import { CrmCommercialRepository } from '../src/creator/crm-commercial.repository';
import { CrmContactPointService } from '../src/services/crm-contact-point.service';
import { PartyReferenceRepository } from '../src/repositories/party-reference.repository';

const LOCAL = (url: string) => /^postgres(ql)?:\/\/[^@]*@(localhost|127\.0\.0\.1)(:\d+)?\//.test(url);
const URL = process.env.LOOP_TEST_POSTGRES_URL ?? '';
const skip = !URL ? 'LOOP_TEST_POSTGRES_URL is not set' : !LOCAL(URL) ? 'refusing a non-local database' : false;

const ROLES = ['OWNER', 'ADMIN', 'MANAGER', 'EMPLOYEE', 'READ_ONLY', 'AI_EMPLOYEE', 'CREATOR'] as const;
type Role = (typeof ROLES)[number];

async function tenant(prisma: PrismaClient, label: string) {
  const organizationId = `0oppr_${label}_${randomUUID()}`;
  await prisma.organization.create({ data: { id: organizationId, name: `OPPR ${label}`, slug: organizationId } });
  const users = {} as Record<Role, string>;
  for (const role of ROLES) {
    const id = `user_oppr_${role.toLowerCase()}_${randomUUID()}`;
    await prisma.user.create({ data: { id, organizationId, email: `${id}@example.test`, name: `${role} person`, status: 'ACTIVE', metadata: { systemRole: role } } });
    await prisma.organizationMembership.create({ data: { organizationId, userId: id, systemRole: role, status: 'ACTIVE', effectiveFrom: new Date('2026-01-01T00:00:00Z') } });
    users[role] = id;
  }
  const actor = (role: Role) => ({ organizationId, userId: users[role] });
  return { organizationId, users, actor };
}

async function party(prisma: PrismaClient, organizationId: string, type: 'PERSON' | 'COMPANY', displayName: string) {
  const owner = await prisma.organizationMembership.findFirstOrThrow({ where: { organizationId, systemRole: 'OWNER' } });
  const row = await prisma.cognitiveIdentity.create({
    data: {
      organizationId,
      entityType: type,
      canonicalKey: `party:${randomUUID()}`,
      displayName,
      status: 'KNOWN',
      establishedAt: new Date('2026-09-01T00:00:00Z'),
      establishmentBasis: 'MANUAL',
      establishedByUserId: owner.userId,
    },
  });
  return row.id;
}

async function opportunity(
  prisma: PrismaClient,
  organizationId: string,
  createdByUserId: string,
  opts: { title?: string; stage?: string; creatorPartyId?: string; createdAt?: Date } = {},
) {
  const creatorPartyId = opts.creatorPartyId ?? (await party(prisma, organizationId, 'PERSON', `Creator ${randomUUID().slice(0, 6)}`));
  const row = await new CrmCommercialRepository(prisma).createOpportunity({
    organizationId,
    title: opts.title ?? 'Spring pursuit',
    stage: opts.stage ?? 'Prospecting',
    creatorPartyId,
    createdByUserId,
  });
  if (opts.createdAt) await prisma.crmOpportunity.update({ where: { id: row.id }, data: { createdAt: opts.createdAt } });
  return row.id;
}

test('access: every human role reads; AI_EMPLOYEE (even with an ALLOW row) and CREATOR are refused; another tenant is NOT_FOUND', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  try {
    const t = await tenant(prisma, 'access');
    const other = await tenant(prisma, 'access_other');
    const reads = new CrmOpportunityReadService(prisma);
    const opp = await opportunity(prisma, t.organizationId, t.users.ADMIN);
    const foreign = await opportunity(prisma, other.organizationId, other.users.ADMIN);

    for (const role of ['OWNER', 'ADMIN', 'MANAGER', 'EMPLOYEE', 'READ_ONLY'] as const) {
      const list = await reads.list(t.actor(role));
      assert.equal(list.outcome, 'OK', role);
      if (list.outcome === 'OK') assert.deepEqual(list.value.items.map((i) => i.opportunityId), [opp], `${role} sees exactly its organization's`);
      assert.equal((await reads.getRecord(t.actor(role), opp)).outcome, 'OK', role);
      assert.deepEqual(await reads.getRecord(t.actor(role), foreign), { outcome: 'NOT_FOUND' }, `${role}: another tenant's id is not found`);
    }

    await prisma.permission.create({ data: { organizationId: t.organizationId, userId: t.users.AI_EMPLOYEE, resource: 'opportunities', action: 'view', effect: 'ALLOW' } });
    for (const role of ['AI_EMPLOYEE', 'CREATOR'] as const) {
      assert.deepEqual(await reads.list(t.actor(role)), { outcome: 'NOT_AUTHORIZED' }, role);
      assert.deepEqual(await reads.getRecord(t.actor(role), opp), { outcome: 'NOT_AUTHORIZED' }, role);
    }
    assert.deepEqual(await reads.list({ organizationId: t.organizationId, userId: other.users.OWNER }), { outcome: 'NOT_AUTHORIZED' }, 'no membership here');
    assert.deepEqual(await reads.list({ organizationId: '', userId: t.users.OWNER }), { outcome: 'NOT_AUTHORIZED' });

    // Each refusal holds on its own. A CREATOR given an ALLOW row passes the coarse gate and is
    // still refused by the PD-F-11 act table; a DENY row refuses a role the act table allows.
    await prisma.permission.create({ data: { organizationId: t.organizationId, userId: t.users.CREATOR, resource: 'opportunities', action: 'view', effect: 'ALLOW' } });
    assert.deepEqual(await reads.list(t.actor('CREATOR')), { outcome: 'NOT_AUTHORIZED' }, 'CREATOR with an ALLOW row: the act table refuses');
    await prisma.permission.create({ data: { organizationId: t.organizationId, userId: t.users.MANAGER, resource: 'opportunities', action: 'view', effect: 'DENY' } });
    assert.deepEqual(await reads.list(t.actor('MANAGER')), { outcome: 'NOT_AUTHORIZED' }, 'a DENY row: the coarse gate refuses');
    // An IAM that would allow anything still cannot admit an inactive membership.
    const permissive = new CrmOpportunityReadService(prisma, { iam: { canEach: async (_o: string, _u: string, checks: readonly unknown[]) => checks.map(() => true) } as never });
    await prisma.organizationMembership.updateMany({ where: { organizationId: t.organizationId, userId: t.users.EMPLOYEE }, data: { status: 'DISABLED' } });
    assert.deepEqual(await permissive.list(t.actor('EMPLOYEE')), { outcome: 'NOT_AUTHORIZED' }, 'membership refuses on its own');
    assert.deepEqual(await reads.list(t.actor('EMPLOYEE')), { outcome: 'NOT_AUTHORIZED' }, 'an inactive membership reads nothing');

    const owner = await reads.list(t.actor('OWNER'));
    const readOnly = await reads.list(t.actor('READ_ONLY'));
    assert.ok(owner.outcome === 'OK' && readOnly.outcome === 'OK');
    assert.deepEqual(owner.capabilities, { changeOwner: true, addParticipant: true, endParticipant: true, voidParticipant: true, update: true });
    assert.deepEqual(readOnly.capabilities, { changeOwner: false, addParticipant: false, endParticipant: false, voidParticipant: false, update: false });
  } finally {
    await prisma.$disconnect();
  }
});

test('projection: creator, owner, BRANDs, PRIMARY_CONTACTs -- none, several, ended and voided; superseded keeps its id', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  try {
    const t = await tenant(prisma, 'proj');
    const reads = new CrmOpportunityReadService(prisma);
    const writes = new CrmOpportunityService(prisma);
    const creator = await party(prisma, t.organizationId, 'PERSON', 'Ava Creator');
    const bare = await opportunity(prisma, t.organizationId, t.users.ADMIN, { title: 'Bare', creatorPartyId: creator, createdAt: new Date('2026-09-01T00:00:00Z') });
    const full = await opportunity(prisma, t.organizationId, t.users.ADMIN, { title: 'Full', creatorPartyId: creator, createdAt: new Date('2026-09-02T00:00:00Z') });

    const acme = await party(prisma, t.organizationId, 'COMPANY', 'Acme Drinks');
    const zen = await party(prisma, t.organizationId, 'COMPANY', 'Zen Foods');
    const gone = await party(prisma, t.organizationId, 'COMPANY', 'Gone Brand');
    const wrong = await party(prisma, t.organizationId, 'COMPANY', 'Wrong Brand');
    const pat = await party(prisma, t.organizationId, 'PERSON', 'Pat Contact');
    const sam = await party(prisma, t.organizationId, 'PERSON', 'Sam Contact');
    for (const [partyId, role] of [[acme, 'BRAND'], [zen, 'BRAND'], [gone, 'BRAND'], [wrong, 'BRAND'], [pat, 'PRIMARY_CONTACT'], [sam, 'PRIMARY_CONTACT']] as const) {
      assert.equal((await writes.addParticipant(t.actor('OWNER'), { opportunityId: full, partyId, role })).outcome, 'RECORDED');
    }
    const participants = await prisma.crmParticipant.findMany({ where: { opportunityId: full } });
    const pid = (partyId: string) => participants.find((p) => p.partyId === partyId)!.id;
    assert.equal((await writes.endParticipant(t.actor('OWNER'), pid(gone), { reason: 'Brand team changed' })).outcome, 'RECORDED');
    assert.equal((await writes.voidParticipant(t.actor('OWNER'), pid(wrong), { reason: 'Entered on the wrong pursuit' })).outcome, 'RECORDED');
    assert.equal((await writes.assignOwner(t.actor('OWNER'), full, { ownerUserId: t.users.MANAGER })).outcome, 'RECORDED');

    // Sam is merged into a newer record: the Opportunity keeps Sam's id and shows the canonical one.
    const samNow = await party(prisma, t.organizationId, 'PERSON', 'Samantha Contact');
    await prisma.cognitiveIdentity.update({ where: { id: sam }, data: { supersededByIdentityId: samNow, supersededAt: new Date('2026-09-20T00:00:00Z') } });

    const page = await reads.list(t.actor('EMPLOYEE'));
    assert.ok(page.outcome === 'OK');
    assert.equal(page.value.namesReadable, true);
    assert.deepEqual(page.value.items.map((i) => i.title), ['Full', 'Bare'], 'newest first');
    const [f, b] = page.value.items;

    assert.deepEqual(f!.creator, { state: 'ESTABLISHED', partyId: creator, partyType: 'PERSON', archived: false, name: 'Ava Creator' });
    assert.deepEqual(f!.owner, { state: 'MEMBER', userId: t.users.MANAGER, displayName: 'MANAGER person' }, 'the owner, never the creator of the row');
    assert.deepEqual(f!.brands.map((x) => x.name).sort(), ['Acme Drinks', 'Zen Foods'], 'both current brands; none silently picked; ended and voided absent');
    assert.deepEqual(
      f!.primaryContacts.map((x) => [x.state, x.partyId, x.state === 'SUPERSEDED' ? x.canonicalPartyId : null, x.name]),
      [['ESTABLISHED', pat, null, 'Pat Contact'], ['SUPERSEDED', sam, samNow, 'Samantha Contact']],
    );
    assert.deepEqual(f!.gaps, []);

    assert.equal(b!.owner, null, 'no owner is null -- never createdByUserId, never defaulted');
    assert.deepEqual([b!.brands, b!.primaryContacts], [[], []]);
    assert.deepEqual(b!.gaps, ['NO_OWNER', 'NO_BRAND', 'NO_PRIMARY_CONTACT']);
    assert.equal((await prisma.crmOpportunity.findUniqueOrThrow({ where: { id: bare } })).ownerUserId, null, 'reading never auto-assigns');

    const record = await reads.getRecord(t.actor('EMPLOYEE'), full);
    assert.ok(record.outcome === 'OK');
    assert.deepEqual(record.value.createdBy, { state: 'MEMBER', userId: t.users.ADMIN, displayName: 'ADMIN person' });
    assert.deepEqual(
      record.value.participants.map((p) => [p.party.name, p.role, p.state, p.reasonRecorded]),
      [
        ['Acme Drinks', 'BRAND', 'ACTIVE', false],
        ['Zen Foods', 'BRAND', 'ACTIVE', false],
        ['Pat Contact', 'PRIMARY_CONTACT', 'ACTIVE', false],
        ['Samantha Contact', 'PRIMARY_CONTACT', 'ACTIVE', false],
        ['Gone Brand', 'BRAND', 'ENDED', true],
        ['Wrong Brand', 'BRAND', 'VOIDED', true],
      ],
      'current first, history kept as recorded',
    );
    assert.ok(!JSON.stringify(record.value).includes('Brand team changed'), 'a reason is THAT it was recorded, never its words');
    assert.deepEqual(record.value.brands.map((x) => x.name).sort(), ['Acme Drinks', 'Zen Foods']);
  } finally {
    await prisma.$disconnect();
  }
});

test('names follow the Party gate; no role receives note text; contact values only through the Contact Point authority', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  try {
    const t = await tenant(prisma, 'privacy');
    const reads = new CrmOpportunityReadService(prisma);
    const writes = new CrmOpportunityService(prisma);
    const opp = await opportunity(prisma, t.organizationId, t.users.ADMIN, { title: 'Private pursuit' });
    const pat = await party(prisma, t.organizationId, 'PERSON', 'Pat Contact');
    await writes.addParticipant(t.actor('OWNER'), { opportunityId: opp, partyId: pat, role: 'PRIMARY_CONTACT' });
    await prisma.crmOpportunity.update({ where: { id: opp }, data: { internalNotes: 'Call pat.private@example.test or +1 415 555 0100' } });
    await prisma.crmOpportunityTransition.updateMany({ where: { opportunityId: opp }, data: { note: 'Reached on +1 415 555 0100' } });

    const points = new CrmContactPointService(prisma);
    const added = await points.add(t.actor('OWNER'), { partyId: pat, kind: 'EMAIL', value: 'pat.private@example.test', classification: 'INDIVIDUAL', basis: 'OPERATOR_RECORDED' });
    assert.equal(added.outcome, 'RECORDED');

    // No Opportunity-note authority exists, so NO role receives note text -- not even OWNER.
    for (const role of ['OWNER', 'ADMIN', 'MANAGER', 'EMPLOYEE', 'READ_ONLY'] as const) {
      const rec = await reads.getRecord(t.actor(role), opp);
      assert.ok(rec.outcome === 'OK', role);
      assert.deepEqual(rec.value.notes, { state: 'RECORDED' }, `${role}: THAT an internal note exists`);
      assert.equal(rec.value.transitions[0]?.noteRecorded, true, `${role}: THAT a transition note exists`);
      const json = JSON.stringify(rec.value);
      assert.ok(!json.includes('Call pat') && !json.includes('Reached on'), `${role}: no note text`);
      assert.ok(!json.includes('example.test') && !json.includes('555'), `${role}: no contact value in the read model`);
    }
    const ro = await reads.getRecord(t.actor('READ_ONLY'), opp);
    assert.ok(ro.outcome === 'OK');
    assert.equal(ro.value.primaryContacts[0]?.name, 'Pat Contact', 'READ_ONLY holds identityResolution:view, so names show');
    // The source rows are only read, never rewritten.
    assert.equal((await prisma.crmOpportunity.findUniqueOrThrow({ where: { id: opp } })).internalNotes, 'Call pat.private@example.test or +1 415 555 0100');
    assert.equal((await prisma.crmOpportunityTransition.findFirstOrThrow({ where: { opportunityId: opp } })).note, 'Reached on +1 415 555 0100');
    const blank = await opportunity(prisma, t.organizationId, t.users.ADMIN, { title: 'No notes' });
    // The writer records 'Opened' on the first transition; clear it to prove an absent note reads as absent.
    await prisma.crmOpportunityTransition.updateMany({ where: { opportunityId: blank }, data: { note: null } });
    const blankRec = await reads.getRecord(t.actor('OWNER'), blank);
    assert.ok(blankRec.outcome === 'OK');
    assert.deepEqual([blankRec.value.notes, blankRec.value.transitions[0]?.noteRecorded], [{ state: 'EMPTY' }, false]);

    // Actual Contact Points keep their own authority, unchanged: the record page asks it per contact.
    const cpEmp = await points.listForParty(t.actor('EMPLOYEE'), pat);
    const cpRo = await points.listForParty(t.actor('READ_ONLY'), pat);
    assert.ok(cpEmp.outcome === 'OK' && cpRo.outcome === 'OK');
    assert.equal(cpEmp.value[0]?.value, 'pat.private@example.test', 'EMPLOYEE+ receives the value through the Contact Point authority');
    assert.deepEqual([cpRo.value[0]?.value, cpRo.value[0]?.valueWithheld, cpRo.value[0]?.kind], [null, 'NOT_PERMITTED', 'EMAIL'], 'READ_ONLY: summary only');
    assert.deepEqual(await points.listForParty(t.actor('AI_EMPLOYEE'), pat), { outcome: 'NOT_AUTHORIZED' });

    for (const role of ['OWNER', 'EMPLOYEE', 'READ_ONLY'] as const) {
      const list = await reads.list(t.actor(role));
      assert.ok(list.outcome === 'OK');
      const json = JSON.stringify(list.value);
      assert.ok(!json.includes('example.test') && !json.includes('555'), `${role}: the list payload never carries a contact value or note`);
    }

    // A Permission DENY on Party records removes names and name search, not the Opportunity.
    await prisma.permission.create({ data: { organizationId: t.organizationId, userId: t.users.EMPLOYEE, resource: 'identityResolution', action: 'view', effect: 'DENY' } });
    const denied = await reads.list(t.actor('EMPLOYEE'), { filters: { q: 'Pat' } });
    assert.ok(denied.outcome === 'OK');
    assert.equal(denied.value.namesReadable, false);
    assert.deepEqual(denied.value.items, [], 'no name search without the Party gate');
    const all = await reads.list(t.actor('EMPLOYEE'));
    assert.ok(all.outcome === 'OK');
    const privateItem = all.value.items.find((i) => i.opportunityId === opp);
    assert.equal(privateItem?.primaryContacts[0]?.name, null);
    assert.equal(privateItem?.creator.name, null);
  } finally {
    await prisma.$disconnect();
  }
});

test('tenant safety: another tenant\'s Party, User and Opportunity never resolve', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  try {
    const t = await tenant(prisma, 'tenancy');
    const other = await tenant(prisma, 'tenancy_other');
    const reads = new CrmOpportunityReadService(prisma);
    const foreignParty = await party(prisma, other.organizationId, 'PERSON', 'Foreign Person');
    const foreignBrand = await party(prisma, other.organizationId, 'COMPANY', 'Foreign Brand');
    await prisma.user.update({ where: { id: other.users.MANAGER }, data: { name: 'Foreign Manager' } });
    // Rows forged past the service (the service refuses them): a foreign creator, owner and brand.
    const opp = await opportunity(prisma, t.organizationId, t.users.ADMIN, { title: 'Forged', creatorPartyId: foreignParty });
    await prisma.crmOpportunity.update({ where: { id: opp }, data: { ownerUserId: other.users.MANAGER } });
    await prisma.crmParticipant.create({
      data: { organizationId: t.organizationId, opportunityId: opp, partyId: foreignBrand, partyType: 'COMPANY', role: 'BRAND', roleFamily: 'CAPACITY', state: 'ACTIVE', activeKey: `forged:${randomUUID()}` },
    });
    await opportunity(prisma, other.organizationId, other.users.ADMIN, { title: 'Foreign pursuit', creatorPartyId: foreignParty });

    const page = await reads.list(t.actor('OWNER'));
    assert.ok(page.outcome === 'OK');
    assert.deepEqual(page.value.items.map((i) => i.title), ['Forged']);
    const [item] = page.value.items;
    assert.deepEqual(item!.creator, { state: 'UNAVAILABLE', partyId: foreignParty, name: null });
    assert.deepEqual(item!.owner, { state: 'UNAVAILABLE', userId: other.users.MANAGER, displayName: null });
    assert.deepEqual(item!.brands, [{ state: 'UNAVAILABLE', partyId: foreignBrand, name: null }]);
    assert.ok(!JSON.stringify(page.value).includes('Foreign'), 'no foreign name leaks');
    assert.ok(!page.value.ownerOptions.some((o) => o.userId === other.users.MANAGER), 'a foreign owner is not offered as a filter');

    for (const q of ['Foreign', other.users.MANAGER]) {
      const search = await reads.list(t.actor('OWNER'), { filters: { q } });
      assert.ok(search.outcome === 'OK');
      assert.deepEqual(search.value.items, [], `search "${q}" never crosses tenants`);
    }
  } finally {
    await prisma.$disconnect();
  }
});

test('search and filters: deterministic governed fields, organization-scoped', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  try {
    const t = await tenant(prisma, 'filter');
    const other = await tenant(prisma, 'filter_other');
    const reads = new CrmOpportunityReadService(prisma);
    const writes = new CrmOpportunityService(prisma);
    const ava = await party(prisma, t.organizationId, 'PERSON', 'Ava Creator');
    const ben = await party(prisma, t.organizationId, 'PERSON', 'Ben Creator');
    const acme = await party(prisma, t.organizationId, 'COMPANY', 'Acme Drinks');
    const pat = await party(prisma, t.organizationId, 'PERSON', 'Pat Contact');

    const a = await opportunity(prisma, t.organizationId, t.users.ADMIN, { title: 'Alpha summer', stage: 'Pitching', creatorPartyId: ava, createdAt: new Date('2026-09-01T00:00:00Z') });
    const b = await opportunity(prisma, t.organizationId, t.users.ADMIN, { title: 'Beta launch', stage: 'Negotiating', creatorPartyId: ben, createdAt: new Date('2026-09-02T00:00:00Z') });
    const c = await opportunity(prisma, t.organizationId, t.users.ADMIN, { title: 'Gamma', stage: 'Pitching', creatorPartyId: ava, createdAt: new Date('2026-09-03T00:00:00Z') });
    await writes.addParticipant(t.actor('OWNER'), { opportunityId: a, partyId: acme, role: 'BRAND' });
    await writes.addParticipant(t.actor('OWNER'), { opportunityId: b, partyId: pat, role: 'PRIMARY_CONTACT' });
    await writes.assignOwner(t.actor('OWNER'), a, { ownerUserId: t.users.EMPLOYEE });
    await writes.assignOwner(t.actor('OWNER'), b, { ownerUserId: t.users.MANAGER });
    await prisma.crmOpportunity.update({ where: { id: c }, data: { category: 'CLOSED_WON' } });
    // A same-named foreign Opportunity must never appear.
    await opportunity(prisma, other.organizationId, other.users.ADMIN, { title: 'Alpha summer' });

    const ids = async (filters: Record<string, unknown>, role: Role = 'EMPLOYEE') => {
      const r = await reads.list(t.actor(role), { filters });
      assert.ok(r.outcome === 'OK', JSON.stringify(filters));
      return r.value.items.map((i) => i.opportunityId);
    };
    assert.deepEqual(await ids({}), [c, b, a]);
    assert.deepEqual(await ids({ q: 'alpha' }), [a], 'title, case-insensitive');
    assert.deepEqual(await ids({ q: b }), [b], 'exact id');
    assert.deepEqual(await ids({ q: 'Ava' }), [c, a], 'creator name');
    assert.deepEqual(await ids({ q: 'acme' }), [a], 'brand name');
    assert.deepEqual(await ids({ q: 'Pat Contact' }), [b], 'contact name');
    assert.deepEqual(await ids({ q: 'MANAGER person' }), [b], 'owner name');
    assert.deepEqual(await ids({ q: 'negotiat' }), [b], 'stage');
    assert.deepEqual(await ids({ q: 'closed_won' }), [c], 'category');
    assert.deepEqual(await ids({ q: 'example.test' }), [], 'never a contact value or email');
    assert.deepEqual(await ids({ owner: 'ME' }), [a], 'owner = me is the signed-in viewer');
    assert.deepEqual(await ids({ owner: 'ME' }, 'MANAGER'), [b]);
    assert.deepEqual(await ids({ owner: 'NONE' }), [c]);
    assert.deepEqual(await ids({ owner: t.users.MANAGER }), [b]);
    assert.deepEqual(await ids({ owner: other.users.MANAGER }), []);
    assert.deepEqual(await ids({ category: 'CLOSED_WON' }), [c]);
    assert.deepEqual(await ids({ stage: 'Pitching' }), [c, a], 'stage exactly as recorded');
    assert.deepEqual(await ids({ creatorPartyId: ava }), [c, a]);
    assert.deepEqual(await ids({ brand: 'PRESENT' }), [a]);
    assert.deepEqual(await ids({ brand: 'MISSING' }), [c, b]);
    assert.deepEqual(await ids({ primaryContact: 'PRESENT' }), [b]);
    assert.deepEqual(await ids({ primaryContact: 'MISSING', stage: 'Pitching' }), [c, a], 'filters combine');

    const page = await reads.list(t.actor('EMPLOYEE'));
    assert.ok(page.outcome === 'OK');
    assert.deepEqual(page.value.stageOptions, ['Negotiating', 'Pitching']);
    assert.deepEqual(page.value.ownerOptions.map((o) => o.userId).sort(), [t.users.EMPLOYEE, t.users.MANAGER].sort());
  } finally {
    await prisma.$disconnect();
  }
});

test('pagination: stable keyset order with no duplicates or gaps; a forged cursor is refused', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  try {
    const t = await tenant(prisma, 'page');
    const reads = new CrmOpportunityReadService(prisma);
    const creator = await party(prisma, t.organizationId, 'PERSON', 'Ava Creator');
    const same = new Date('2026-09-05T00:00:00Z');
    const made: string[] = [];
    // Seven rows share one createdAt: the id breaks the tie, deterministically.
    for (let i = 0; i < 12; i += 1) {
      made.push(await opportunity(prisma, t.organizationId, t.users.ADMIN, { title: `P${i}`, creatorPartyId: creator, createdAt: i < 7 ? same : new Date(Date.UTC(2026, 8, 10 + i)) }));
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 10; guard += 1) {
      const r = await reads.list(t.actor('READ_ONLY'), { cursor, limit: 5 });
      assert.ok(r.outcome === 'OK');
      seen.push(...r.value.items.map((i) => i.opportunityId));
      cursor = r.value.nextCursor;
      if (!cursor) break;
    }
    assert.equal(seen.length, 12);
    assert.equal(new Set(seen).size, 12, 'no duplicates');
    const expected = await prisma.crmOpportunity.findMany({ where: { organizationId: t.organizationId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { id: true } });
    assert.deepEqual(seen, expected.map((e) => e.id), 'exactly (createdAt desc, id desc)');

    assert.deepEqual(await reads.list(t.actor('OWNER'), { cursor: 'not-a-cursor' }), { outcome: 'INVALID_CURSOR' });
    const forged = Buffer.from(JSON.stringify({ a: 'yesterday', i: 'x' })).toString('base64url');
    assert.deepEqual(await reads.list(t.actor('OWNER'), { cursor: forged }), { outcome: 'INVALID_CURSOR' });
    const huge = await reads.list(t.actor('OWNER'), { limit: 10_000 });
    assert.ok(huge.outcome === 'OK' && huge.value.items.length === 12, 'limit is clamped, not trusted');
  } finally {
    await prisma.$disconnect();
  }
});

test('bounded queries: a page of 3 and a page of 30 cost the same number of queries', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } }, log: [{ emit: 'event', level: 'query' }] });
  let count = 0;
  prisma.$on('query', () => {
    count += 1;
  });
  try {
    const t = await tenant(prisma, 'bounded');
    const reads = new CrmOpportunityReadService(prisma);
    const writes = new CrmOpportunityService(prisma);
    for (let i = 0; i < 30; i += 1) {
      const opp = await opportunity(prisma, t.organizationId, t.users.ADMIN, { title: `B${i}` });
      await writes.addParticipant(t.actor('OWNER'), { opportunityId: opp, partyId: await party(prisma, t.organizationId, 'COMPANY', `Brand ${i}`), role: 'BRAND' });
      await writes.addParticipant(t.actor('OWNER'), { opportunityId: opp, partyId: await party(prisma, t.organizationId, 'PERSON', `Contact ${i}`), role: 'PRIMARY_CONTACT' });
      await writes.assignOwner(t.actor('OWNER'), opp, { ownerUserId: i % 2 ? t.users.EMPLOYEE : t.users.MANAGER });
    }
    const cost = async (limit: number, filters = {}) => {
      count = 0;
      const r = await reads.list(t.actor('EMPLOYEE'), { limit, filters });
      assert.ok(r.outcome === 'OK' && r.value.items.length === limit);
      assert.ok(r.value.items.every((i) => i.brands.length === 1 && i.primaryContacts.length === 1 && i.owner?.state === 'MEMBER'));
      return count;
    };
    const small = await cost(3);
    const large = await cost(30);
    assert.equal(large, small, `page cost is independent of page size (3 rows: ${small}, 30 rows: ${large})`);
    assert.ok(large <= 15, `a page is a fixed handful of queries, got ${large}`);
    assert.equal(await cost(30, { q: 'Brand' }), await cost(3, { q: 'Brand' }), 'search too');
  } finally {
    await prisma.$disconnect();
  }
});

test('resolveMany answers exactly as resolve does, chain by chain', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  try {
    const t = await tenant(prisma, 'resolve');
    const other = await tenant(prisma, 'resolve_other');
    const refs = new PartyReferenceRepository(prisma);
    const plain = await party(prisma, t.organizationId, 'PERSON', 'Plain');
    const a = await party(prisma, t.organizationId, 'PERSON', 'A');
    const b = await party(prisma, t.organizationId, 'PERSON', 'B');
    const c = await party(prisma, t.organizationId, 'PERSON', 'C');
    await prisma.cognitiveIdentity.update({ where: { id: a }, data: { supersededByIdentityId: b } });
    await prisma.cognitiveIdentity.update({ where: { id: b }, data: { supersededByIdentityId: c } });
    const typeJump = await party(prisma, t.organizationId, 'PERSON', 'Jumps type');
    const company = await party(prisma, t.organizationId, 'COMPANY', 'Co');
    await prisma.cognitiveIdentity.update({ where: { id: typeJump }, data: { supersededByIdentityId: company } });
    const unestablished = (await prisma.cognitiveIdentity.create({ data: { organizationId: t.organizationId, entityType: 'PERSON', canonicalKey: `party:${randomUUID()}`, displayName: 'Unest', status: 'KNOWN' } })).id;
    const foreign = await party(prisma, other.organizationId, 'PERSON', 'Foreign');

    const ids = [plain, a, b, c, typeJump, unestablished, foreign, 'missing-id', '', plain];
    const many = await refs.resolveMany(t.organizationId, ids);
    for (const id of ids) {
      assert.deepEqual(many.get(id), await refs.resolve(t.organizationId, id), `same answer for ${id || '(empty)'}`);
    }
    assert.equal(many.get(a)?.state, 'SUPERSEDED');
    assert.equal(many.get(foreign)?.state, 'NOT_FOUND');
  } finally {
    await prisma.$disconnect();
  }
});
