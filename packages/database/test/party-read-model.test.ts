// Party read models and the governed Party write surface. Identity slice P1.
//
// Drives the real PartyReadModelRepository, PartyRecordService, PartyService,
// CustomerPartyLinkService, IamRepository (membership authority) and
// PartyRepository against the in-memory Prisma double. Proves:
//   - People and Companies list exactly the established, non-superseded,
//     non-archived Parties of their type in the organization, and agree with
//     PartyRepository.findParty on every row;
//   - keyset pages are complete, ordered and duplicate-free, and a forged cursor
//     is refused;
//   - the establishment queue holds only governed, unestablished records;
//   - a record states its reference, posture and linked Intake Records without
//     contact values, and a superseded record names its current record;
//   - reads authorize before looking (AI_EMPLOYEE and other organizations learn
//     nothing) and return server-decided capabilities;
//   - Party audit rows name the acting member, never "System".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PrismaClient } from '@prisma/client';
import { PARTY_LIST_MAX_LIMIT, PARTY_POSTURE_LIMITATIONS } from '@emgloop/shared';

import { makeCognitivePrisma } from './helpers/cognitive-prisma-fake';
import { IamRepository } from '../src/repositories/iam.repository';
import { PartyRepository } from '../src/repositories/cognitive/party.repository';
import { PartyReadModelRepository, PartyListCursorError } from '../src/repositories/party-read-model.repository';
import { PartyRecordService } from '../src/services/party-record.service';
import { PartyService } from '../src/services/party.service';
import { CustomerPartyLinkService } from '../src/services/customer-party-link.service';

const ORG_A = 'org_a';
const ORG_B = 'org_b';

function world() {
  const fake: any = makeCognitivePrisma({ also: ['invitation', 'organizationMembership', 'customer', 'customerPartyLink'] });
  const prisma = fake as PrismaClient;
  const iam = new IamRepository(prisma);
  const parties = new PartyService(prisma);
  const links = new CustomerPartyLinkService(prisma);
  const readModel = new PartyReadModelRepository(prisma);
  const records = new PartyRecordService(prisma);
  const partyRepo = new PartyRepository(prisma);
  let n = 0;
  const hire = async (org: string, role: string, name: string | null = `${role} Person`) => {
    n += 1;
    const u = await iam.createUser({ organizationId: org, email: `${role.toLowerCase()}${n}-${org}@x.io`, systemRole: role, name: name ?? undefined });
    await iam.activateUser(org, u.id);
    return u.id as string;
  };
  const created = async (org: string, actor: string, partyType = 'PERSON', displayName: string | null = null) => {
    const r = await parties.create(org, actor, { partyType, displayName });
    assert.equal(r.outcome, 'RECORDED');
    return r.outcome === 'RECORDED' ? r.party.id : '';
  };
  const established = async (org: string, actor: string, partyType = 'PERSON', displayName: string | null = null) => {
    const id = await created(org, actor, partyType, displayName);
    assert.equal((await parties.establish(org, actor, id, 'MANUAL')).outcome, 'RECORDED');
    return id;
  };
  const row = (id: string) => fake.cognitiveIdentity.__rows.find((r: any) => r.id === id);
  return { fake, prisma, iam, parties, links, readModel, records, partyRepo, hire, created, established, row };
}

async function allPages(read: (cursor: string | null) => Promise<{ items: readonly { partyId: string }[]; nextCursor: string | null }>) {
  const ids: string[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 100; i += 1) {
    const page = await read(cursor);
    ids.push(...page.items.map((x) => x.partyId));
    if (!page.nextCursor) return ids;
    cursor = page.nextCursor;
  }
  throw new Error('pagination did not terminate');
}

test('People lists exactly the established, current PERSON Parties of the organization', async () => {
  const w = world();
  const owner = await w.hire(ORG_A, 'OWNER', 'Olive Owner');
  const ownerB = await w.hire(ORG_B, 'OWNER');
  const person = await w.established(ORG_A, owner, 'PERSON', 'Pat');
  const unestablished = await w.created(ORG_A, owner, 'PERSON', 'Not yet');
  const company = await w.established(ORG_A, owner, 'COMPANY', 'Acme');
  const superseded = await w.established(ORG_A, owner, 'PERSON', 'Old record');
  w.row(superseded).supersededByIdentityId = person;
  const archived = await w.established(ORG_A, owner, 'PERSON', 'Archived');
  Object.assign(w.row(archived), { status: 'ARCHIVED', archivedAt: new Date() });
  const orphaned = await w.established(ORG_A, owner, 'PERSON', 'Actor gone');
  w.row(orphaned).establishedByUserId = null;
  const otherOrg = await w.established(ORG_B, ownerB, 'PERSON', 'Theirs');
  // A row carrying a basis no actor can stand behind never reads as established.
  const authenticated = await w.created(ORG_A, owner, 'PERSON', 'Claimed');
  Object.assign(w.row(authenticated), { establishedAt: new Date(), establishmentBasis: 'AUTHENTICATED', establishedByUserId: owner });

  const people = await w.readModel.listEstablished(ORG_A, 'PERSON');
  assert.deepEqual(people.items.map((i) => i.partyId), [person]);
  assert.equal(people.nextCursor, null);
  assert.deepEqual((await w.readModel.listEstablished(ORG_A, 'COMPANY')).items.map((i) => i.partyId), [company]);
  const item = people.items[0]!;
  assert.equal(item.displayName, 'Pat');
  assert.equal(item.establishment.established, true);
  assert.equal(item.establishment.basis, 'MANUAL');
  assert.deepEqual(item.establishment.establishedBy, { userId: owner, displayName: 'Olive Owner' });
  assert.ok(![unestablished, superseded, archived, orphaned, otherOrg, authenticated].includes(item.partyId));
  assert.deepEqual((await w.readModel.listEstablished('', 'PERSON')).items, []);
  assert.deepEqual((await w.readModel.listEstablished(ORG_A, 'BUYER' as any)).items, []);
});

test('the list agrees with PartyRepository.findParty on every Party-typed row', async () => {
  const w = world();
  const owner = await w.hire(ORG_A, 'OWNER');
  const ids = [
    await w.established(ORG_A, owner, 'PERSON'),
    await w.established(ORG_A, owner, 'COMPANY'),
    await w.created(ORG_A, owner, 'PERSON'),
    await w.created(ORG_A, owner, 'COMPANY'),
    await w.established(ORG_A, owner, 'PERSON'),
  ];
  w.row(ids[4]!).establishedByUserId = null;
  w.row(ids[0]!).establishmentBasis = 'EXPLICIT_LINK';
  for (const type of ['PERSON', 'COMPANY'] as const) {
    const listed = new Set((await w.readModel.listEstablished(ORG_A, type)).items.map((i) => i.partyId));
    for (const id of ids) {
      const view = await w.partyRepo.findParty(ORG_A, id);
      const expected = !!view && view.partyType === type && view.establishment.established && !view.supersededByIdentityId;
      assert.equal(listed.has(id), expected, `${type} ${id}`);
    }
  }
});

test('keyset pages are complete, ordered, duplicate-free and bounded; a forged cursor is refused', async () => {
  const w = world();
  const owner = await w.hire(ORG_A, 'OWNER');
  const same = new Date('2026-09-15T12:00:00Z');
  const ids: string[] = [];
  for (let i = 0; i < 7; i += 1) {
    const id = await w.established(ORG_A, owner);
    if (i < 4) w.row(id).establishedAt = same; // ties broken by id
    else w.row(id).establishedAt = new Date(same.getTime() + i * 1000);
    ids.push(id);
  }
  const full = (await w.readModel.listEstablished(ORG_A, 'PERSON', { limit: 100 })).items.map((i) => i.partyId);
  assert.equal(full.length, 7);
  const paged = await allPages((cursor) => w.readModel.listEstablished(ORG_A, 'PERSON', { cursor, limit: 3 }));
  assert.deepEqual(paged, full);
  assert.equal(new Set(paged).size, 7);
  const times = full.map((id) => w.row(id).establishedAt.getTime());
  assert.deepEqual(times, [...times].sort((a, b) => b - a));

  assert.equal((await w.readModel.listEstablished(ORG_A, 'PERSON', { limit: 0 })).items.length, 1);
  assert.equal((await w.readModel.listEstablished(ORG_A, 'PERSON', { limit: 10_000 })).items.length, Math.min(7, PARTY_LIST_MAX_LIMIT));
  for (const cursor of ['not-a-cursor', Buffer.from('{"a":"x","i":"y"}').toString('base64url'), Buffer.from('{"a":"2026-01-01T00:00:00Z"}').toString('base64url')]) {
    await assert.rejects(() => w.readModel.listEstablished(ORG_A, 'PERSON', { cursor }), PartyListCursorError);
  }
  const viewer = await w.hire(ORG_A, 'READ_ONLY');
  assert.deepEqual(await w.records.listPeople(ORG_A, viewer, { cursor: 'forged' }), { outcome: 'INVALID_CURSOR' });
});

test('the establishment queue holds only governed, unestablished, current records', async () => {
  const w = world();
  const owner = await w.hire(ORG_A, 'OWNER');
  const pending = await w.created(ORG_A, owner, 'PERSON');
  const pendingCompany = await w.created(ORG_A, owner, 'COMPANY');
  const done = await w.established(ORG_A, owner);
  const lapsed = await w.established(ORG_A, owner);
  w.row(lapsed).establishedByUserId = null;
  const archived = await w.created(ORG_A, owner);
  Object.assign(w.row(archived), { status: 'ARCHIVED', archivedAt: new Date() });
  // A cognitive subject the dormant resolver would mint: not a governed record.
  await w.fake.cognitiveIdentity.create({ data: { organizationId: ORG_A, entityType: 'PERSON', canonicalKey: 'session:abc', status: 'ANONYMOUS', metadata: {} } });

  const queue = new Set((await w.readModel.listUnestablished(ORG_A)).items.map((i) => i.partyId));
  assert.deepEqual([...queue].sort(), [pending, pendingCompany, lapsed].sort());
  assert.ok(!queue.has(done) && !queue.has(archived));
  assert.deepEqual((await w.readModel.listUnestablished(ORG_A, { partyType: 'COMPANY' })).items.map((i) => i.partyId), [pendingCompany]);
  const paged = await allPages((cursor) => w.readModel.listUnestablished(ORG_A, { cursor, limit: 1 }));
  assert.equal(paged.length, 3);
});

test('a record states reference, posture and linked Intake Records, with no contact values', async () => {
  const w = world();
  const owner = await w.hire(ORG_A, 'OWNER', 'Olive Owner');
  const canonical = await w.established(ORG_A, owner, 'PERSON', 'Pat');
  const customerId = (await w.fake.customer.create({ data: { organizationId: ORG_A, email: 'pat@example.com', phone: '5550100', firstName: 'Pat' } })).id;
  const oldCustomer = (await w.fake.customer.create({ data: { organizationId: ORG_A, email: 'old@example.com', phone: '5550199', firstName: 'Old' } })).id;
  assert.equal((await w.links.link(ORG_A, owner, { customerId: oldCustomer, partyId: canonical })).outcome, 'LINKED');
  assert.equal((await w.links.reverse(ORG_A, owner, { customerId: oldCustomer, reason: 'wrong person' })).outcome, 'REVERSED');
  assert.equal((await w.links.link(ORG_A, owner, { customerId, partyId: canonical })).outcome, 'LINKED');

  const record = await w.readModel.getRecord(ORG_A, canonical);
  assert.ok(record);
  assert.equal(record.reference.state, 'ESTABLISHED');
  assert.equal(record.reference.canonicalPartyId, null);
  assert.equal(record.archived, false);
  assert.deepEqual(record.posture, {
    establishment: 'ESTABLISHED',
    basis: 'MANUAL',
    sameParty: 'UNRESOLVED',
    evidenceTier: 'NOT_AVAILABLE',
    limitations: [...PARTY_POSTURE_LIMITATIONS],
  });
  assert.deepEqual(record.linkedIntakeRecords.map((l) => [l.customerId, l.state]), [[customerId, 'ACTIVE'], [oldCustomer, 'REVERSED']]);
  assert.equal(record.linkedIntakeRecords[1]!.reversalReason, 'wrong person');
  assert.deepEqual(record.linkedIntakeRecords[0]!.linkedBy, { userId: owner, displayName: 'Olive Owner' });
  const json = JSON.stringify(record);
  assert.doesNotMatch(json, /pat@example\.com|5550100|old@example\.com|"email"|"phone"|confidence/i);

  // A superseded record is shown as asked, naming its current record.
  const old = await w.established(ORG_A, owner, 'PERSON', 'Duplicate');
  w.row(old).supersededByIdentityId = canonical;
  const supersededRecord = await w.readModel.getRecord(ORG_A, old);
  assert.equal(supersededRecord?.partyId, old);
  assert.deepEqual(supersededRecord?.reference, { state: 'SUPERSEDED', canonicalPartyId: canonical });

  // A recorded link, even ungoverned, reads as a possible match, never as confirmed.
  await w.fake.identityResolutionLink.create({ data: { organizationId: ORG_A, sourceIdentityId: old, targetIdentityId: canonical, method: 'MANUAL', status: 'CONFIRMED', evidenceSummary: {}, permittedPurposes: [] } });
  assert.equal((await w.readModel.getRecord(ORG_A, canonical))?.posture.sameParty, 'POSSIBLE_MATCH');

  const pending = await w.created(ORG_A, owner, 'COMPANY');
  const pendingRecord = await w.readModel.getRecord(ORG_A, pending);
  assert.equal(pendingRecord?.reference.state, 'NOT_ESTABLISHED');
  assert.equal(pendingRecord?.establishment.establishedBy, null);

  const ownerB = await w.hire(ORG_B, 'OWNER');
  const theirs = await w.established(ORG_B, ownerB);
  const call = (await w.fake.cognitiveIdentity.create({ data: { organizationId: ORG_A, entityType: 'CALL', canonicalKey: 'call:1', status: 'KNOWN', metadata: {} } })).id;
  for (const id of [theirs, call, 'no_such_party', '']) {
    assert.equal(await w.readModel.getRecord(ORG_A, id), null, id);
  }
});

test('reads authorize before looking and return server-decided capabilities', async () => {
  const w = world();
  const owner = await w.hire(ORG_A, 'OWNER');
  const person = await w.established(ORG_A, owner);
  const expected: Record<string, { createParty: boolean; establishParty: boolean } | null> = {
    OWNER: { createParty: true, establishParty: true },
    ADMIN: { createParty: true, establishParty: true },
    MANAGER: { createParty: true, establishParty: false },
    EMPLOYEE: { createParty: true, establishParty: false },
    READ_ONLY: { createParty: false, establishParty: false },
    AI_EMPLOYEE: null,
  };
  for (const [role, caps] of Object.entries(expected)) {
    const viewer = await w.hire(ORG_A, role);
    for (const read of [
      () => w.records.listPeople(ORG_A, viewer),
      () => w.records.listCompanies(ORG_A, viewer),
      () => w.records.listEstablishmentQueue(ORG_A, viewer),
      () => w.records.getRecord(ORG_A, viewer, person),
    ]) {
      const result = await read();
      if (caps === null) assert.deepEqual(result, { outcome: 'NOT_AUTHORIZED' }, role);
      else {
        assert.equal(result.outcome, 'OK', role);
        if (result.outcome === 'OK') assert.deepEqual(result.capabilities, caps, role);
      }
    }
  }

  // AI_EMPLOYEE with an explicit ALLOW row is still refused, and nothing identity-shaped is read.
  const ai = await w.hire(ORG_A, 'AI_EMPLOYEE');
  await w.fake.permission.create({ data: { organizationId: ORG_A, userId: ai, resource: 'identityResolution', action: 'view', effect: 'ALLOW' } });
  const reads = { n: 0 };
  const spy = new Proxy(w.fake, {
    get(target, prop: string) {
      if (['cognitiveIdentity', 'customerPartyLink', 'identityResolutionLink'].includes(prop)) reads.n += 1;
      return target[prop];
    },
  }) as PrismaClient;
  const guarded = new PartyRecordService(spy);
  assert.deepEqual(await guarded.listPeople(ORG_A, ai), { outcome: 'NOT_AUTHORIZED' });
  assert.deepEqual(await guarded.getRecord(ORG_A, ai, person), { outcome: 'NOT_AUTHORIZED' });
  assert.equal(reads.n, 0);

  // Another organization's member learns nothing about this one.
  const outsider = await w.hire(ORG_B, 'OWNER');
  assert.deepEqual(await w.records.listPeople(ORG_A, outsider), { outcome: 'NOT_AUTHORIZED' });
  assert.deepEqual(await w.records.getRecord(ORG_A, outsider, person), { outcome: 'NOT_AUTHORIZED' });
  const reader = await w.hire(ORG_A, 'READ_ONLY');
  assert.deepEqual(await w.records.getRecord(ORG_A, reader, 'no_such_party'), { outcome: 'NOT_FOUND' });
});

test('Party audit rows name the acting member: the session name, else the member name', async () => {
  const w = world();
  const owner = await w.hire(ORG_A, 'OWNER', 'Olive Owner');
  const admin = await w.hire(ORG_A, 'ADMIN', null);
  const byOwner = await w.created(ORG_A, owner);
  assert.equal((await w.parties.establish(ORG_A, admin, byOwner, 'MANUAL', { actorName: '  Ada Admin  ' })).outcome, 'RECORDED');
  const rows = w.fake.auditLog.__rows.filter((r: any) => String(r.action).startsWith('party.'));
  const byAction = Object.fromEntries(rows.map((r: any) => [r.action, r]));
  assert.equal(byAction['party.created'].metadata.actorName, 'Olive Owner', 'member name when the caller passes none');
  assert.equal(byAction['party.established'].metadata.actorName, 'Ada Admin', 'the session name the caller passed');
  for (const r of rows) assert.notEqual(r.metadata.actorName, 'System');
  // A refused act writes no audit row, named or not.
  const before = w.fake.auditLog.__rows.length;
  const reader = await w.hire(ORG_A, 'READ_ONLY');
  assert.equal((await w.parties.create(ORG_A, reader, { partyType: 'PERSON' }, { actorName: 'Rita' })).outcome, 'NOT_AUTHORIZED');
  assert.equal(w.fake.auditLog.__rows.length, before);
});

test('fence: the read model writes nothing, selects no contact field, and the service authorizes before reading', () => {
  const root = join(__dirname, '..', 'src');
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const repo = strip(readFileSync(join(root, 'repositories', 'party-read-model.repository.ts'), 'utf8'));
  assert.doesNotMatch(repo, /\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\s*(\?\.)?\s*\(|\$executeRaw|\$transaction/);
  assert.doesNotMatch(repo, /email|phone|normalizedValueHash|identityEvidence|contains:|mode:/i);
  const service = strip(readFileSync(join(root, 'services', 'party-record.service.ts'), 'utf8'));
  for (const method of ['getRecord', 'list']) {
    const start = service.indexOf(method === 'list' ? 'private async list(' : 'async getRecord(');
    const body = service.slice(start, service.indexOf('\n  }\n', start));
    assert.ok(body.indexOf('this.access(') >= 0 && body.indexOf('this.access(') < body.search(/readModel\.|read\(\)/), method);
  }
});
