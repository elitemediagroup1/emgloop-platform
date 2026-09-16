// Governed Participant acts. Slice R3-A2.
//
// A Participant is a governed assertion that an ESTABLISHED Party holds a contextual
// role in a Relationship, for a time. These acts are the only way one is created,
// corrected or closed, and the properties below are what stop that record drifting
// into something it is not.
//
// WHAT THESE PROVE
//
// A ROLE IS CONTEXTUAL, NEVER A CLASSIFICATION. A COMPANY offered as a
// PRIMARY_CONTACT is refused, and the Party's own type is untouched by the refusal.
// Nothing here can change what kind of Party something is.
//
// HISTORY IS ADDED TO, NEVER REWRITTEN. Ending a Participant keeps the row, its
// reason and its actor, and releases only its active key -- so holding the same role
// again later is a SECOND row. Two facts, not one overwritten one. Nothing is ever
// deleted.
//
// CORRECTION HAS A NARROW BAND. The side a Participant acts for and its business
// dates can be corrected. The Party cannot -- that is somebody else. The role cannot
// -- that is a different fact, recorded by ending and adding. A side Participant
// cannot be corrected or closed at all: a side is structural.
//
// AND THE PARTY AUTHORITY STILL DECIDES. Unestablished, archived, superseded and
// cross-organization references are refused here exactly as they are everywhere,
// with the canonical id returned rather than silently substituted.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PrismaClient } from '@prisma/client';

import { makeCognitivePrisma } from './helpers/cognitive-prisma-fake';
import { CrmRelationshipService } from '../src/services/crm-relationship.service';
import { PartyService } from '../src/services/party.service';
import { IamRepository } from '../src/repositories/iam.repository';

const ORG_A = 'org_a';
const ORG_B = 'org_b';
const AT = new Date('2026-09-16T10:00:00.000Z');
const REASON = 'Dana at dana@example.com left, reachable on 555-0101';

async function world() {
  const fake: any = makeCognitivePrisma({
    also: ['invitation', 'organizationMembership', 'crmRelationship', 'crmRelationshipEvent', 'crmParticipant'],
  });
  const prisma = fake as PrismaClient;
  const iam = new IamRepository(prisma);
  const parties = new PartyService(prisma);
  const service = new CrmRelationshipService(prisma);

  const hire = async (role: string, org = ORG_A) => {
    const u = await iam.createUser({ organizationId: org, email: `${role.toLowerCase()}-${org}-${Math.random()}@x.io`, systemRole: role, name: `${role} Person` });
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
  const actorOf = (userId: string, org = ORG_A) => ({ organizationId: org, userId, actorName: 'Session Name' });
  const counts = () => ({
    participants: fake.crmParticipant.__rows.length,
    events: fake.crmRelationshipEvent.__rows.length,
    audit: fake.auditLog.__rows.filter((r: any) => r.entityType === 'crm_relationship').length,
    outbox: fake.stateChangeOutbox.__rows.length,
  });

  const agency = await party('COMPANY');
  const brand = await party('COMPANY');
  const created = await service.create(actorOf(owner), {
    kind: 'REPRESENTATION',
    sides: [{ side: 'A', partyId: agency, role: 'AGENCY' }, { side: 'B', partyId: brand, role: 'BRAND' }],
    occurredAt: AT,
  });
  assert.equal(created.outcome, 'RECORDED');
  const relationship = created.outcome === 'RECORDED' ? created.value.relationship : null;
  const sideParticipants = created.outcome === 'RECORDED' ? created.value.participants : [];

  return { fake, prisma, iam, parties, service, hire, owner, ownerB, party, actorOf, counts, relationshipId: relationship!.id, agency, brand, sideParticipants };
}

const add = (w: Awaited<ReturnType<typeof world>>, partyId: string, role = 'PRIMARY_CONTACT', userId?: string) =>
  w.service.addParticipant(w.actorOf(userId ?? w.owner), {
    relationshipId: w.relationshipId,
    partyId,
    role: role as never,
    actsForSide: 'B',
    occurredAt: AT,
  });

// --- 1. Adding ---------------------------------------------------------------------

test('adding a Participant writes the row, its event, its audit entry and its outbox row', async () => {
  const w = await world();
  const person = await w.party('PERSON');
  const before = w.counts();
  const result = await add(w, person);

  assert.equal(result.outcome, 'RECORDED');
  if (result.outcome !== 'RECORDED') return;
  assert.equal(result.value.partyType, 'PERSON', 'the Party authority supplied the type');
  assert.equal(result.value.roleFamily, 'ENGAGEMENT');
  assert.equal(result.value.actsForSide, 'B');
  assert.equal(result.value.side, null);

  const after = w.counts();
  assert.deepEqual(
    [after.participants - before.participants, after.events - before.events, after.audit - before.audit, after.outbox - before.outbox],
    [1, 1, 1, 1],
  );
  const audit = w.fake.auditLog.__rows.at(-1);
  assert.equal(audit.action, 'relationship.participant_added');
  assert.equal(audit.metadata.participantId, result.value.id);
  assert.equal(audit.metadata.role, 'PRIMARY_CONTACT');
  assert.equal(audit.userId, w.owner);
  const outbox = w.fake.stateChangeOutbox.__rows.at(-1);
  assert.equal(outbox.eventType, 'RelationshipParticipantAdded');
  assert.equal(outbox.subjectId, w.relationshipId, 'the Relationship is the subject a subscriber follows');
  assert.equal(outbox.payload.participantId, result.value.id);
});

test('one Party may hold several roles; the same role twice while active is refused', async () => {
  const w = await world();
  const person = await w.party('PERSON');
  assert.equal((await add(w, person, 'PRIMARY_CONTACT')).outcome, 'RECORDED');
  assert.equal((await add(w, person, 'DECISION_MAKER')).outcome, 'RECORDED', 'a second role is a second fact');
  const before = w.counts();
  assert.equal((await add(w, person, 'PRIMARY_CONTACT')).outcome, 'DUPLICATE');
  assert.deepEqual(w.counts(), before, 'the refusal wrote nothing');
});

test('a role never decides a Party type, and a refusal changes nothing about the Party', async () => {
  const w = await world();
  const company = await w.party('COMPANY');
  const before = w.counts();
  const result = await add(w, company, 'BILLING_CONTACT');
  assert.equal(result.outcome, 'INVALID');
  if (result.outcome === 'INVALID') assert.deepEqual(result.violations, ['PARTY_TYPE_NOT_PERMITTED_FOR_ROLE']);
  assert.equal(w.fake.cognitiveIdentity.__rows.find((p: any) => p.id === company).entityType, 'COMPANY', 'untouched');
  assert.deepEqual(w.counts(), before);
});

test('the Party authority refuses unestablished, archived, superseded and other tenants\' references', async () => {
  const w = await world();
  const before = w.counts();

  const pending = await w.parties.create(ORG_A, w.owner, { partyType: 'PERSON' });
  const pendingId = pending.outcome === 'RECORDED' ? pending.party.id : '';
  const notEstablished = await add(w, pendingId);
  assert.equal(notEstablished.outcome, 'PARTY_REFUSED');
  if (notEstablished.outcome === 'PARTY_REFUSED') assert.equal(notEstablished.refusals[0]!.refusal, 'NOT_ESTABLISHED');

  const archived = await w.party('PERSON');
  await w.fake.cognitiveIdentity.update({ where: { id: archived }, data: { status: 'ARCHIVED', archivedAt: AT } });
  const archivedResult = await add(w, archived);
  assert.equal(archivedResult.outcome, 'PARTY_REFUSED');
  if (archivedResult.outcome === 'PARTY_REFUSED') assert.equal(archivedResult.refusals[0]!.refusal, 'ARCHIVED');

  const canonical = await w.party('PERSON');
  const superseded = await w.party('PERSON');
  await w.fake.cognitiveIdentity.update({
    where: { id: superseded },
    data: { supersededByIdentityId: canonical, supersededAt: AT, supersededByUserId: w.owner },
  });
  const supersededResult = await add(w, superseded);
  assert.equal(supersededResult.outcome, 'PARTY_REFUSED');
  if (supersededResult.outcome === 'PARTY_REFUSED') {
    // Refused WITH the canonical id, so the writer retries deliberately. Never swapped.
    assert.deepEqual(supersededResult.refusals, [{ partyId: superseded, refusal: 'SUPERSEDED', canonicalPartyId: canonical }]);
  }

  const theirs = await w.party('PERSON', ORG_B);
  const crossOrg = await add(w, theirs);
  assert.equal(crossOrg.outcome, 'PARTY_REFUSED');
  if (crossOrg.outcome === 'PARTY_REFUSED') assert.equal(crossOrg.refusals[0]!.refusal, 'NOT_FOUND', 'indistinguishable from missing');

  assert.deepEqual(w.counts(), before, 'four refusals, nothing written');
});

// --- 2. Correcting ------------------------------------------------------------------

test('a correction changes the side acted for and the dates, and nothing else', async () => {
  const w = await world();
  const person = await w.party('PERSON');
  const added = await add(w, person);
  const id = added.outcome === 'RECORDED' ? added.value.id : '';

  const changed = await w.service.changeParticipant(w.actorOf(w.owner), id, { actsForSide: 'A', occurredAt: AT });
  assert.equal(changed.outcome, 'RECORDED');
  if (changed.outcome === 'RECORDED') {
    assert.equal(changed.value.actsForSide, 'A');
    assert.equal(changed.value.partyId, person, 'the Party is not what changed');
    assert.equal(changed.value.role, 'PRIMARY_CONTACT', 'nor the role');
    assert.equal(changed.value.state, 'ACTIVE');
  }
  assert.equal(w.fake.crmRelationshipEvent.__rows.at(-1).type, 'PARTICIPANT_CHANGED');
  assert.equal(w.fake.auditLog.__rows.at(-1).action, 'relationship.participant_changed');
});

test('a side Participant is structural: it cannot be corrected, ended or voided alone', async () => {
  const w = await world();
  const sideId = w.sideParticipants[0]!.id;
  const before = w.counts();

  const changed = await w.service.changeParticipant(w.actorOf(w.owner), sideId, { actsForSide: 'B', occurredAt: AT });
  assert.equal(changed.outcome, 'INVALID');
  if (changed.outcome === 'INVALID') assert.deepEqual(changed.violations, ['SIDE_PARTICIPANT_IS_STRUCTURAL']);

  const ended = await w.service.endParticipant(w.actorOf(w.owner), sideId, { reason: 'wrong agency', occurredAt: AT });
  assert.equal(ended.outcome, 'INVALID');
  const voided = await w.service.voidParticipant(w.actorOf(w.owner), sideId, { reason: 'wrong agency', occurredAt: AT });
  assert.equal(voided.outcome, 'INVALID');

  assert.deepEqual(w.counts(), before);
  assert.equal(w.fake.crmParticipant.__rows.find((p: any) => p.id === sideId).state, 'ACTIVE');
});

// --- 3. Ending, voiding, and history ------------------------------------------------

test('ending keeps the row and its reason, releases the key, and holding the role again is new history', async () => {
  const w = await world();
  const person = await w.party('PERSON');
  const first = await add(w, person);
  const firstId = first.outcome === 'RECORDED' ? first.value.id : '';

  assert.equal((await w.service.endParticipant(w.actorOf(w.owner), firstId, { reason: '  ', occurredAt: AT })).outcome, 'REASON_REQUIRED');
  const ended = await w.service.endParticipant(w.actorOf(w.owner), firstId, { reason: REASON, occurredAt: AT });
  assert.equal(ended.outcome, 'RECORDED');
  if (ended.outcome === 'RECORDED') {
    assert.equal(ended.value.state, 'ENDED');
    assert.equal(ended.value.activeKey, null);
    assert.equal(ended.value.endReason, REASON, 'the row keeps why');
    assert.equal(ended.value.endedByUserId, w.owner, 'and who');
  }

  assert.equal((await add(w, person)).outcome, 'RECORDED', 'the role can be held again');
  const rows = w.fake.crmParticipant.__rows.filter((p: any) => p.partyId === person && p.role === 'PRIMARY_CONTACT');
  assert.equal(rows.length, 2, 'two rows: the history and the present');
  assert.deepEqual(rows.map((r: any) => r.state).sort(), ['ACTIVE', 'ENDED']);
  // Nothing was deleted, at any point.
  assert.equal(w.fake.crmParticipant.__rows.filter((p: any) => p.state === 'ENDED').length, 1);
});

test('a reason lives on the event; audit and outbox never carry the words', async () => {
  const w = await world();
  const person = await w.party('PERSON');
  const added = await add(w, person);
  const id = added.outcome === 'RECORDED' ? added.value.id : '';
  await w.service.endParticipant(w.actorOf(w.owner), id, { reason: REASON, occurredAt: AT });

  const event = w.fake.crmRelationshipEvent.__rows.find((e: any) => e.type === 'PARTICIPANT_ENDED');
  assert.equal(event.reason, REASON);
  // The audit row records THAT a reason was given -- an act that says no, recorded
  // as one -- while the words stay on the event.
  const audit = w.fake.auditLog.__rows.find((r: any) => r.action === 'relationship.participant_ended');
  assert.equal(audit.metadata.reasonRecorded, true);
  const addedAudit = w.fake.auditLog.__rows.find((r: any) => r.action === 'relationship.participant_added');
  assert.equal(addedAudit.metadata.reasonRecorded, false, 'adding is not an act that says no');
  const written = JSON.stringify([w.fake.auditLog.__rows, w.fake.stateChangeOutbox.__rows]);
  assert.doesNotMatch(written, /Dana|dana@example\.com|555-0101/);
});

test('an ended Participant cannot be ended again, and a missing one is not found', async () => {
  const w = await world();
  const person = await w.party('PERSON');
  const added = await add(w, person);
  const id = added.outcome === 'RECORDED' ? added.value.id : '';
  await w.service.endParticipant(w.actorOf(w.owner), id, { reason: 'left', occurredAt: AT });
  const before = w.counts();

  assert.equal((await w.service.endParticipant(w.actorOf(w.owner), id, { reason: 'again', occurredAt: AT })).outcome, 'ILLEGAL_TRANSITION');
  assert.equal((await w.service.voidParticipant(w.actorOf(w.owner), id, { reason: 'again', occurredAt: AT })).outcome, 'ILLEGAL_TRANSITION');
  assert.equal((await w.service.changeParticipant(w.actorOf(w.owner), id, { actsForSide: 'A', occurredAt: AT })).outcome, 'ILLEGAL_TRANSITION');
  assert.equal((await w.service.endParticipant(w.actorOf(w.owner), 'participant_missing', { reason: 'x', occurredAt: AT })).outcome, 'NOT_FOUND');
  assert.deepEqual(w.counts(), before);
});

test('a correction is re-validated as a whole, not waved through because it is a correction', async () => {
  const w = await world();
  const person = await w.party('PERSON');
  const added = await add(w, person);
  const id = added.outcome === 'RECORDED' ? added.value.id : '';
  const before = w.counts();

  // COUNTERPARTY belongs to OWN kinds; this Relationship is REPRESENTATION (A/B).
  const result = await w.service.changeParticipant(w.actorOf(w.owner), id, { actsForSide: 'COUNTERPARTY', occurredAt: AT });
  assert.equal(result.outcome, 'INVALID');
  if (result.outcome === 'INVALID') assert.ok(result.violations.includes('SIDE_NOT_IN_KIND'));
  assert.deepEqual(w.counts(), before, 'a refused correction writes nothing');
  assert.equal(w.fake.crmParticipant.__rows.find((p: any) => p.id === id).actsForSide, 'B', 'and changes nothing');
});

test('every participant act is organization-scoped at the data layer, not only at the outcome', async () => {
  const w = await world();
  const person = await w.party('PERSON');
  const added = await add(w, person);
  const id = added.outcome === 'RECORDED' ? added.value.id : '';

  // Tenancy that depends on a later query filtering correctly is tenancy waiting for
  // the day somebody reads the earlier one. Every query must name the organization.
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
  const service = new CrmRelationshipService(watched);

  await service.changeParticipant(w.actorOf(w.owner), id, { actsForSide: 'A', occurredAt: AT });
  await service.endParticipant(w.actorOf(w.owner), id, { reason: 'left', occurredAt: AT });
  await service.addParticipant(w.actorOf(w.owner), { relationshipId: w.relationshipId, partyId: person, role: 'DECISION_MAKER' as never, actsForSide: 'B', occurredAt: AT });

  assert.ok(seen.length >= 5, `queries were observed (${seen.length})`);
  for (const { delegate, where } of seen) {
    assert.equal(where?.organizationId, ORG_A, `${delegate} query without an organization: ${JSON.stringify(where)}`);
  }
});

test('another tenant cannot correct, end or void a Participant it cannot see', async () => {
  const w = await world();
  const person = await w.party('PERSON');
  const added = await add(w, person);
  const id = added.outcome === 'RECORDED' ? added.value.id : '';
  const before = w.counts();
  const theirs = { organizationId: ORG_B, userId: w.ownerB };

  assert.equal((await w.service.changeParticipant(theirs, id, { actsForSide: 'A', occurredAt: AT })).outcome, 'NOT_FOUND');
  assert.equal((await w.service.endParticipant(theirs, id, { reason: 'r', occurredAt: AT })).outcome, 'NOT_FOUND');
  assert.equal((await w.service.voidParticipant(theirs, id, { reason: 'r', occurredAt: AT })).outcome, 'NOT_FOUND');
  assert.deepEqual(w.counts(), before);
  assert.equal(w.fake.crmParticipant.__rows.find((p: any) => p.id === id).actsForSide, 'B', 'untouched');
});

// --- 4. Authorization ----------------------------------------------------------------

test('every role gets exactly the Participant acts Product approved', async () => {
  const w = await world();
  const expected: Record<string, { add: boolean; change: boolean; end: boolean; void: boolean }> = {
    OWNER: { add: true, change: true, end: true, void: true },
    ADMIN: { add: true, change: true, end: true, void: true },
    MANAGER: { add: true, change: true, end: true, void: false },
    EMPLOYEE: { add: true, change: true, end: false, void: false },
    READ_ONLY: { add: false, change: false, end: false, void: false },
    AI_EMPLOYEE: { add: false, change: false, end: false, void: false },
  };
  // One live Participant for the change/end/void attempts.
  const subject = await w.party('PERSON');
  const seeded = await add(w, subject, 'DECISION_MAKER');
  const seededId = seeded.outcome === 'RECORDED' ? seeded.value.id : '';

  for (const [role, may] of Object.entries(expected)) {
    const userId = await w.hire(role);
    const actor = w.actorOf(userId);
    const person = await w.party('PERSON');

    const added = await w.service.addParticipant(actor, { relationshipId: w.relationshipId, partyId: person, role: 'PRIMARY_CONTACT' as never, actsForSide: 'B', occurredAt: AT });
    assert.equal(added.outcome === 'NOT_AUTHORIZED', !may.add, `${role} add`);
    if (added.outcome === 'RECORDED') {
      await w.service.endParticipant(w.actorOf(w.owner), added.value.id, { reason: 'cleanup', occurredAt: AT });
    }
    assert.equal((await w.service.changeParticipant(actor, seededId, { actsForSide: 'B', occurredAt: AT })).outcome === 'NOT_AUTHORIZED', !may.change, `${role} change`);
    assert.equal((await w.service.endParticipant(actor, seededId, { reason: 'r', occurredAt: AT })).outcome === 'NOT_AUTHORIZED', !may.end, `${role} end`);
    assert.equal((await w.service.voidParticipant(actor, seededId, { reason: 'r', occurredAt: AT })).outcome === 'NOT_AUTHORIZED', !may.void, `${role} void`);
  }
});

test('AI_EMPLOYEE performs no Participant act, and nothing it tried is written', async () => {
  const w = await world();
  const ai = await w.hire('AI_EMPLOYEE');
  const person = await w.party('PERSON');
  const seeded = await add(w, person, 'DECISION_MAKER');
  const seededId = seeded.outcome === 'RECORDED' ? seeded.value.id : '';
  const before = w.counts();

  const other = await w.party('PERSON');
  assert.equal((await w.service.addParticipant(w.actorOf(ai), { relationshipId: w.relationshipId, partyId: other, role: 'PRIMARY_CONTACT' as never, actsForSide: 'B', occurredAt: AT })).outcome, 'NOT_AUTHORIZED');
  assert.equal((await w.service.changeParticipant(w.actorOf(ai), seededId, { actsForSide: 'A', occurredAt: AT })).outcome, 'NOT_AUTHORIZED');
  assert.equal((await w.service.endParticipant(w.actorOf(ai), seededId, { reason: 'r', occurredAt: AT })).outcome, 'NOT_AUTHORIZED');
  assert.equal((await w.service.voidParticipant(w.actorOf(ai), seededId, { reason: 'r', occurredAt: AT })).outcome, 'NOT_AUTHORIZED');
  assert.deepEqual(w.counts(), before);
});

test('another organization reaches nothing, and a disabled member performs nothing', async () => {
  const w = await world();
  const person = await w.party('PERSON');
  const added = await add(w, person);
  const id = added.outcome === 'RECORDED' ? added.value.id : '';
  const before = w.counts();

  assert.equal((await w.service.endParticipant({ organizationId: ORG_B, userId: w.ownerB }, id, { reason: 'r', occurredAt: AT })).outcome, 'NOT_FOUND');
  assert.equal(
    (await w.service.addParticipant({ organizationId: ORG_B, userId: w.ownerB }, { relationshipId: w.relationshipId, partyId: person, role: 'PRIMARY_CONTACT' as never, actsForSide: 'B', occurredAt: AT })).outcome,
    'NOT_FOUND',
  );
  const gone = await w.hire('OWNER');
  await w.iam.disableUser(ORG_A, gone);
  assert.equal((await w.service.endParticipant(w.actorOf(gone), id, { reason: 'r', occurredAt: AT })).outcome, 'NOT_AUTHORIZED');
  assert.deepEqual(w.counts(), before);
});
