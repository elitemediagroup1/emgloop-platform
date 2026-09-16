// Reading Relationships. Slice R3-A3.
//
// WHAT THESE PROVE
//
// A READ RESOLVES FORWARD AND SAYS SO; A WRITE REFUSES. The same Party Reference
// authority answers both, and a superseded side shows BOTH ids -- the one the record
// was written with and the canonical one. Nothing is rewritten, and a test snapshots
// the stored rows before and after to prove it.
//
// A BROKEN CHAIN IS UNAVAILABLE, NOT ABSENT. A cycle, an over-deep chain, a change of
// Party type or another organization's record make one side UNAVAILABLE, and the
// Relationship stays readable. A record does not disappear because a reference broke.
//
// A DUPLICATE IS A DIAGNOSTIC. Two Relationships of one kind resolving to the same
// canonical sides are reported, with nothing merged, nothing hidden and nothing
// changed -- and a side nobody can resolve is never treated as evidence of sameness.
//
// AUTHORIZATION COMES FIRST AND CAPABILITIES COME BACK. A viewer without the grant
// learns nothing at all; one with it is told exactly what they may do, decided by the
// server from the approved act table.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PrismaClient } from '@prisma/client';
import {
  CRM_RELATIONSHIP_LIST_LIMIT_DEFAULT,
  CRM_RELATIONSHIP_LIST_LIMIT_MAX,
  crmRelationshipListLimit,
  crmRelationshipsResolveAlike,
} from '@emgloop/shared';

import { makeCognitivePrisma } from './helpers/cognitive-prisma-fake';
import { CrmRelationshipReadModelRepository } from '../src/repositories/crm-relationship-read-model.repository';
import { CrmRelationshipRepository } from '../src/repositories/crm-relationship.repository';
import { CrmRelationshipReadService } from '../src/services/crm-relationship-read.service';
import { CrmRelationshipService } from '../src/services/crm-relationship.service';
import { PartyService } from '../src/services/party.service';
import { IamRepository } from '../src/repositories/iam.repository';

const ORG_A = 'org_a';
const ORG_B = 'org_b';
const AT = new Date('2026-09-16T10:00:00.000Z');

async function world() {
  const fake: any = makeCognitivePrisma({
    also: ['invitation', 'organizationMembership', 'crmRelationship', 'crmRelationshipEvent', 'crmParticipant'],
  });
  const prisma = fake as PrismaClient;
  const iam = new IamRepository(prisma);
  const parties = new PartyService(prisma);
  const writes = new CrmRelationshipService(prisma);
  const reads = new CrmRelationshipReadService(prisma);
  const readModel = new CrmRelationshipReadModelRepository(prisma);
  const repository = new CrmRelationshipRepository(prisma);

  const hire = async (role: string, org = ORG_A) => {
    const u = await iam.createUser({ organizationId: org, email: `${role.toLowerCase()}-${org}-${Math.random()}@x.io`, systemRole: role, name: role });
    await iam.activateUser(org, u.id);
    return u.id;
  };
  const owner = await hire('OWNER');
  const ownerB = await hire('OWNER', ORG_B);
  const party = async (partyType: 'PERSON' | 'COMPANY' = 'COMPANY', org = ORG_A, actor = org === ORG_A ? owner : ownerB) => {
    const c = await parties.create(org, actor, { partyType });
    const id = c.outcome === 'RECORDED' ? c.party.id : '';
    await parties.establish(org, actor, id, 'MANUAL');
    return id;
  };
  const actorOf = (userId: string, org = ORG_A) => ({ organizationId: org, userId, actorName: 'Session' });
  const relate = async (kind = 'REPRESENTATION', a?: string, b?: string) => {
    const sideA = a ?? (await party('COMPANY'));
    const sideB = b ?? (await party('COMPANY'));
    const r = await writes.create(actorOf(owner), {
      kind,
      sides: [{ side: 'A', partyId: sideA, role: 'AGENCY' }, { side: 'B', partyId: sideB, role: 'BRAND' }],
      occurredAt: AT,
    });
    assert.equal(r.outcome, 'RECORDED');
    return { id: r.outcome === 'RECORDED' ? r.value.relationship.id : '', sideA, sideB };
  };
  const snapshot = () => JSON.stringify([fake.crmRelationship.__rows, fake.crmParticipant.__rows]);

  return { fake, prisma, iam, parties, writes, reads, readModel, repository, hire, owner, ownerB, party, actorOf, relate, snapshot };
}

// --- 1. The record -------------------------------------------------------------------

test('a record carries its kind, sides, participants, history and counts', async () => {
  const w = await world();
  const { id, sideA } = await w.relate();
  const person = await w.party('PERSON');
  // Through the merged R2 repository: A3 reads what R2 persists and does not depend
  // on the A2 service, so it is cut from fresh main rather than stacked on it.
  await w.repository.addParticipant(ORG_A, {
    relationshipId: id, partyId: person, role: 'PRIMARY_CONTACT' as never, actsForSide: 'B', actorUserId: w.owner, occurredAt: AT,
  });

  const record = await w.readModel.getRecord(ORG_A, id);
  assert.ok(record);
  assert.equal(record!.kind, 'REPRESENTATION');
  assert.equal(record!.kindLabel, 'Representation');
  assert.equal(record!.structure, 'THIRD_PARTY');
  assert.equal(record!.state, 'ACTIVE');
  assert.equal(record!.activeParticipantCount, 3);

  assert.deepEqual(record!.sides.map((s) => s.side), ['A', 'B']);
  assert.equal(record!.sides[0]!.label, 'represents', 'how the side reads comes from the governed kind');
  assert.deepEqual(record!.sides[0]!.party, { state: 'ESTABLISHED', partyId: sideA, partyType: 'COMPANY', archived: false });
  assert.equal(record!.sides[0]!.role, 'AGENCY');

  const contact = record!.participants.find((p) => p.role === 'PRIMARY_CONTACT');
  assert.equal(contact!.roleFamily, 'ENGAGEMENT');
  assert.equal(contact!.actsForSide, 'B');
  assert.equal(contact!.state, 'ACTIVE');

  assert.deepEqual(record!.history.map((h) => [h.sequence, h.type]), [[1, 'RELATIONSHIP_CREATED'], [2, 'PARTICIPANT_ADDED']]);
  assert.equal(record!.history[0]!.actorUserId, w.owner);
  assert.deepEqual(record!.duplicates, []);
});

test('the history records that a reason was given, never the words', async () => {
  const w = await world();
  const { id } = await w.relate();
  await w.writes.end(w.actorOf(w.owner), id, { reason: 'Dana at dana@example.com asked, on 555-0101', occurredAt: AT });

  const record = await w.readModel.getRecord(ORG_A, id);
  const ended = record!.history.find((h) => h.type === 'RELATIONSHIP_ENDED')!;
  assert.equal(ended.reasonRecorded, true);
  assert.deepEqual([ended.fromState, ended.toState], ['ACTIVE', 'ENDED']);
  assert.doesNotMatch(JSON.stringify(record), /Dana|dana@example\.com|555-0101/, 'the words stay on the event row');
});

// --- 2. Party references ----------------------------------------------------------------

test('a superseded side shows both ids, and the stored id is never rewritten', async () => {
  const w = await world();
  const canonical = await w.party('COMPANY');
  const superseded = await w.party('COMPANY');
  const { id } = await w.relate('REPRESENTATION', superseded, await w.party('COMPANY'));
  const before = w.snapshot();

  // The Party is superseded AFTER the Relationship recorded it -- which is the whole
  // situation this behaviour exists for.
  await w.fake.cognitiveIdentity.update({
    where: { id: superseded },
    data: { supersededByIdentityId: canonical, supersededAt: AT, supersededByUserId: w.owner },
  });

  const record = await w.readModel.getRecord(ORG_A, id);
  const side = record!.sides.find((s) => s.side === 'A')!;
  assert.equal(side.party.state, 'SUPERSEDED');
  if (side.party.state === 'SUPERSEDED') {
    assert.equal(side.party.partyId, superseded, 'the id the record was written with');
    assert.equal(side.party.canonicalPartyId, canonical, 'and the one it resolves to');
  }
  assert.equal(w.snapshot(), before, 'reading rewrote nothing');
});

test('a chain that cannot be followed is UNAVAILABLE, and the Relationship stays readable', async () => {
  const w = await world();
  const person = await w.party('PERSON');
  const company = await w.party('COMPANY');
  const { id } = await w.relate('REPRESENTATION', company, await w.party('COMPANY'));

  // A supersession that changes Party type is refused by the contract: NOT_FOUND.
  await w.fake.cognitiveIdentity.update({
    where: { id: company },
    data: { supersededByIdentityId: person, supersededAt: AT, supersededByUserId: w.owner },
  });

  const record = await w.readModel.getRecord(ORG_A, id);
  assert.ok(record, 'the Relationship is still readable');
  const side = record!.sides.find((s) => s.side === 'A')!;
  assert.deepEqual(side.party, { state: 'UNAVAILABLE', partyId: company });
  assert.equal(record!.state, 'ACTIVE');
  // And the other side is unaffected.
  assert.equal(record!.sides.find((s) => s.side === 'B')!.party.state, 'ESTABLISHED');
});

test('an archived Party stays historically readable', async () => {
  const w = await world();
  const { id, sideA } = await w.relate();
  await w.fake.cognitiveIdentity.update({ where: { id: sideA }, data: { status: 'ARCHIVED', archivedAt: AT } });

  const record = await w.readModel.getRecord(ORG_A, id);
  const side = record!.sides.find((s) => s.side === 'A')!;
  assert.equal(side.party.state, 'ESTABLISHED');
  if (side.party.state === 'ESTABLISHED') assert.equal(side.party.archived, true, 'readable, and marked');
});

// --- 3. Duplicates -----------------------------------------------------------------------

test('two Relationships resolving to the same canonical sides are reported, never merged', async () => {
  const w = await world();
  const canonical = await w.party('COMPANY');
  const superseded = await w.party('COMPANY');
  const brand = await w.party('COMPANY');

  const first = await w.relate('REPRESENTATION', superseded, brand);
  const second = await w.relate('REPRESENTATION', canonical, brand);
  const before = w.snapshot();

  await w.fake.cognitiveIdentity.update({
    where: { id: superseded },
    data: { supersededByIdentityId: canonical, supersededAt: AT, supersededByUserId: w.owner },
  });

  const record = await w.readModel.getRecord(ORG_A, first.id);
  assert.deepEqual(record!.duplicates, [{ relationshipId: second.id, state: 'ACTIVE', reason: 'SAME_CANONICAL_SIDES' }]);
  // Reported, and that is ALL that happened.
  assert.equal(w.snapshot(), before, 'no merge, no edit, no hiding');
  const other = await w.readModel.getRecord(ORG_A, second.id);
  assert.equal(other!.state, 'ACTIVE', 'both still stand; a person decides');
});

test('a side nobody can resolve is never treated as evidence of sameness', () => {
  const unresolved = { kind: 'REPRESENTATION', sides: [
    { side: 'A' as const, label: 'represents', role: 'AGENCY' as never, party: { state: 'UNAVAILABLE' as const, partyId: 'p1' } },
    { side: 'B' as const, label: 'is represented by', role: 'BRAND' as never, party: { state: 'ESTABLISHED' as const, partyId: 'p2', partyType: 'COMPANY' as const, archived: false } },
  ] };
  assert.equal(crmRelationshipsResolveAlike(unresolved, unresolved), false, 'two unknowns are not a match');
  const resolved = { kind: 'REPRESENTATION', sides: [
    { side: 'A' as const, label: 'represents', role: 'AGENCY' as never, party: { state: 'ESTABLISHED' as const, partyId: 'p1', partyType: 'COMPANY' as const, archived: false } },
    { side: 'B' as const, label: 'is represented by', role: 'BRAND' as never, party: { state: 'ESTABLISHED' as const, partyId: 'p2', partyType: 'COMPANY' as const, archived: false } },
  ] };
  assert.equal(crmRelationshipsResolveAlike(resolved, resolved), true);
  assert.equal(crmRelationshipsResolveAlike(resolved, { ...resolved, kind: 'SUPPLY' }), false, 'a different kind is a different fact');
});

// --- 4. Lists ------------------------------------------------------------------------------

test('a list is newest first, excludes voided by default, and pages without repeating', async () => {
  const w = await world();
  const made: string[] = [];
  for (let i = 0; i < 5; i += 1) made.push((await w.relate()).id);
  const voided = await w.relate();
  await w.writes.void(w.actorOf(w.owner), voided.id, { reason: 'entered in error', occurredAt: AT });

  const whole = await w.readModel.list(ORG_A, { limit: 50 });
  assert.equal(whole.items.length, 5, 'the voided record is not in the working list');
  assert.equal(whole.items.some((i) => i.relationshipId === voided.id), false);

  const withVoided = await w.readModel.list(ORG_A, { limit: 50, includeVoided: true });
  assert.equal(withVoided.items.length, 6, 'and is still readable when asked for');

  const walked: string[] = [];
  let cursor: string | null = null;
  for (let guard = 0; guard < 20; guard += 1) {
    const page: Awaited<ReturnType<typeof w.readModel.list>> = await w.readModel.list(ORG_A, { limit: 2, cursor });
    walked.push(...page.items.map((i) => i.relationshipId));
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  assert.deepEqual(walked, whole.items.map((i) => i.relationshipId));
  assert.equal(new Set(walked).size, walked.length, 'nothing repeated');
});

test('a cursor this repository did not produce is refused', async () => {
  const w = await world();
  await w.relate();
  for (const bad of ['nonsense', Buffer.from('{}').toString('base64url')]) {
    await assert.rejects(() => w.readModel.list(ORG_A, { cursor: bad }), /Invalid relationship list cursor/);
  }
});

test('a Party\'s Relationships are found, and only in its own organization', async () => {
  const w = await world();
  const { id, sideA } = await w.relate();
  const mine = await w.readModel.forParty(ORG_A, sideA);
  assert.deepEqual(mine.items.map((i) => i.relationshipId), [id]);
  assert.deepEqual((await w.readModel.forParty(ORG_B, sideA)).items, [], 'not across tenants');
  assert.deepEqual((await w.readModel.forParty(ORG_A, 'party_unknown')).items, []);
});

test('another tenant reads nothing, and a missing id is not found', async () => {
  const w = await world();
  const { id } = await w.relate();
  assert.equal(await w.readModel.getRecord(ORG_B, id), null);
  assert.equal(await w.readModel.getRecord(ORG_A, 'relationship_missing'), null);
  assert.deepEqual((await w.readModel.list(ORG_B)).items, []);
  assert.equal(await w.readModel.getRecord('', id), null);
});

test('a duplicate needs the same kind, a resolvable pair of sides, and a record that still stands', async () => {
  const w = await world();
  const canonical = await w.party('COMPANY');
  const superseded = await w.party('COMPANY');
  const brand = await w.party('COMPANY');
  const first = await w.relate('REPRESENTATION', superseded, brand);
  const second = await w.relate('REPRESENTATION', canonical, brand);
  // A different KIND between the same Parties is a different fact, never a duplicate.
  await w.writes.create(w.actorOf(w.owner), {
    kind: 'SUPPLY',
    sides: [{ side: 'A', partyId: canonical, role: 'VENDOR' }, { side: 'B', partyId: brand, role: 'BUYER' }],
    occurredAt: AT,
  });
  await w.fake.cognitiveIdentity.update({
    where: { id: superseded },
    data: { supersededByIdentityId: canonical, supersededAt: AT, supersededByUserId: w.owner },
  });

  const record = await w.readModel.getRecord(ORG_A, first.id);
  assert.deepEqual(record!.duplicates.map((d) => d.relationshipId), [second.id], 'only the same kind');

  // A voided record is not a duplicate of anything: it has already been resolved.
  await w.writes.void(w.actorOf(w.owner), second.id, { reason: 'the duplicate, resolved', occurredAt: AT });
  assert.deepEqual((await w.readModel.getRecord(ORG_A, first.id))!.duplicates, []);
  // And a voided record reports none of its own.
  assert.deepEqual((await w.readModel.getRecord(ORG_A, second.id))!.duplicates, []);
});

test('a Relationship whose side cannot be resolved reports no duplicates at all', async () => {
  const w = await world();
  const person = await w.party('PERSON');
  const company = await w.party('COMPANY');
  const brand = await w.party('COMPANY');
  const first = await w.relate('REPRESENTATION', company, brand);
  await w.relate('REPRESENTATION', await w.party('COMPANY'), brand);

  // A supersession that crosses Party type cannot be followed: the side is UNAVAILABLE.
  await w.fake.cognitiveIdentity.update({
    where: { id: company },
    data: { supersededByIdentityId: person, supersededAt: AT, supersededByUserId: w.owner },
  });
  const record = await w.readModel.getRecord(ORG_A, first.id);
  assert.equal(record!.sides.find((s) => s.side === 'A')!.party.state, 'UNAVAILABLE');
  assert.deepEqual(record!.duplicates, [], 'an unknown side is not evidence of sameness');
});

test('a participant view records that a reason exists, never the words', async () => {
  const w = await world();
  const { id } = await w.relate();
  const person = await w.party('PERSON');
  const added = await w.repository.addParticipant(ORG_A, {
    relationshipId: id, partyId: person, role: 'PRIMARY_CONTACT' as never, actsForSide: 'B', actorUserId: w.owner, occurredAt: AT,
  });
  const participantId = added.outcome === 'RECORDED' ? added.value.id : '';
  await w.repository.closeParticipant(ORG_A, participantId, {
    to: 'ENDED', actorUserId: w.owner, occurredAt: AT, reason: 'Dana at dana@example.com left, call 555-0101',
  });

  const record = await w.readModel.getRecord(ORG_A, id);
  const ended = record!.participants.find((p) => p.participantId === participantId)!;
  assert.equal(ended.state, 'ENDED');
  assert.equal(ended.reasonRecorded, true);
  assert.doesNotMatch(JSON.stringify(record), /Dana|dana@example\.com|555-0101/, 'the words stay on the row, read under its own authority');
});

test('a page is bounded however much is asked for', async () => {
  const w = await world();
  for (let i = 0; i < 3; i += 1) await w.relate();
  assert.equal(crmRelationshipListLimit(2), 2);
  assert.equal(crmRelationshipListLimit(1_000_000), CRM_RELATIONSHIP_LIST_LIMIT_MAX, 'a limit is a limit');
  for (const bad of [null, undefined, 0, -1, 2.5, Number.NaN]) {
    assert.equal(crmRelationshipListLimit(bad as number), CRM_RELATIONSHIP_LIST_LIMIT_DEFAULT, String(bad));
  }
  const page = await w.readModel.list(ORG_A, { limit: 1_000_000 });
  assert.ok(page.items.length <= CRM_RELATIONSHIP_LIST_LIMIT_MAX);
});

test('every query a read issues names an organization', async () => {
  const w = await world();
  const { id, sideA } = await w.relate();
  const seen: { delegate: string; where: any }[] = [];
  const watched = new Proxy(w.fake, {
    get(target: any, delegate: string) {
      const d = target[delegate];
      if (typeof delegate !== 'string' || !delegate.startsWith('crm') || typeof d !== 'object' || d === null) return d;
      return new Proxy(d, {
        get(inner: any, method: string) {
          const fn = inner[method];
          if (typeof fn !== 'function') return fn;
          return (args: any) => {
            if (/^find|^count/.test(method)) seen.push({ delegate, where: args?.where });
            return fn.call(inner, args);
          };
        },
      });
    },
  }) as PrismaClient;
  const readModel = new CrmRelationshipReadModelRepository(watched);
  await readModel.list(ORG_A, { limit: 5 });
  await readModel.getRecord(ORG_A, id);
  await readModel.forParty(ORG_A, sideA);

  assert.ok(seen.length >= 6, `queries were observed (${seen.length})`);
  for (const { delegate, where } of seen) {
    assert.equal(where?.organizationId, ORG_A, `${delegate} read without an organization: ${JSON.stringify(where)}`);
  }
});

// --- 5. Authorization ---------------------------------------------------------------------

test('a viewer without the grant learns nothing, and one with it is told what they may do', async () => {
  const w = await world();
  const { id } = await w.relate();

  const expected: Record<string, { read: boolean; create: boolean; end: boolean; void: boolean }> = {
    OWNER: { read: true, create: true, end: true, void: true },
    ADMIN: { read: true, create: true, end: true, void: true },
    MANAGER: { read: true, create: true, end: true, void: false },
    EMPLOYEE: { read: true, create: true, end: false, void: false },
    READ_ONLY: { read: true, create: false, end: false, void: false },
    // Not a human workspace role: PD-F-04's recorded reading denies it view.
    AI_EMPLOYEE: { read: false, create: false, end: false, void: false },
  };
  for (const [role, may] of Object.entries(expected)) {
    const userId = await w.hire(role);
    const viewer = { organizationId: ORG_A, userId };
    const listed = await w.reads.list(viewer);
    assert.equal(listed.outcome === 'OK', may.read, `${role} list`);
    const record = await w.reads.getRecord(viewer, id);
    assert.equal(record.outcome === 'OK', may.read, `${role} record`);
    if (record.outcome === 'OK') {
      assert.equal(record.capabilities.create, may.create, `${role} create capability`);
      assert.equal(record.capabilities.endRelationship, may.end, `${role} end capability`);
      assert.equal(record.capabilities.voidRelationship, may.void, `${role} void capability`);
    }
  }
});

test('an unauthorized viewer cannot tell a real id from an invented one', async () => {
  const w = await world();
  const { id } = await w.relate();
  const ai = await w.hire('AI_EMPLOYEE');
  const real = await w.reads.getRecord({ organizationId: ORG_A, userId: ai }, id);
  const invented = await w.reads.getRecord({ organizationId: ORG_A, userId: ai }, 'relationship_nope');
  assert.equal(real.outcome, 'NOT_AUTHORIZED');
  assert.deepEqual(real, invented, 'the same answer either way');
});

test('a disabled member, a blank viewer and a bad cursor each answer honestly', async () => {
  const w = await world();
  await w.relate();
  const gone = await w.hire('OWNER');
  await w.iam.disableUser(ORG_A, gone);
  assert.equal((await w.reads.list({ organizationId: ORG_A, userId: gone })).outcome, 'NOT_AUTHORIZED');
  assert.equal((await w.reads.list({ organizationId: '', userId: 'u' })).outcome, 'NOT_AUTHORIZED');
  assert.equal((await w.reads.list({ organizationId: ORG_A, userId: w.owner }, { cursor: 'nonsense' })).outcome, 'INVALID_CURSOR');
});
