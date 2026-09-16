// The operator surface, tested as seven roles.
//
// HIDDEN BUTTONS ARE NOT AUTHORIZATION. The surface renders its forms from the
// capabilities the server returns, but a form is a suggestion -- anybody can post to
// a server action without ever seeing one. So every act here is SUBMITTED ANYWAY, by
// every role, and the refusal has to come from the authority. A page that merely
// hides a button would pass a screenshot review and fail this file.
//
// AND A REFUSED ACT LEAVES NOTHING. Each refusal is checked against the row counts:
// no Relationship, no event, no Participant, no AuditLog row, no outbox row. An
// audit entry for a write that did not happen is worse than no audit entry.
//
// THE GRANTS ARE NOT RESTATED HERE, THEY ARE EXERCISED. The table below is what
// Product approved (PD-F-04 and IDENTITY_RESOLUTION_GRANTS), written out role by
// role so a future edit to either grant table shows up as a failing expectation
// rather than as a quietly wider surface.
//
// TWO AUTHORITIES, NOT ONE. Reading a Relationship is the coarse `relationships:view`
// matrix gate; DOING anything is the approved act table. That is why an unknown role
// can open the list and perform nothing -- it inherits READ_ONLY's read and matches
// no act. AI_EMPLOYEE is hard-denied at both, and holds no identityResolution action
// at all.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PrismaClient } from '@prisma/client';

import { makeCognitivePrisma } from './helpers/cognitive-prisma-fake';
import { CrmRelationshipService } from '../src/services/crm-relationship.service';
import { CrmRelationshipReadService } from '../src/services/crm-relationship-read.service';
import { PartyService } from '../src/services/party.service';
import { PartyRecordService } from '../src/services/party-record.service';
import { IamRepository } from '../src/repositories/iam.repository';

const ORG = 'org_operator';
const AT = new Date('2026-09-16T12:00:00.000Z');

/** Every workflow the operator surface offers, and who Product approved for it. */
interface Expected {
  readonly viewParty: boolean;
  readonly createParty: boolean;
  readonly establishParty: boolean;
  readonly viewRelationship: boolean;
  readonly createRelationship: boolean;
  readonly addParticipant: boolean;
  readonly changeParticipant: boolean;
  readonly endParticipant: boolean;
  readonly endRelationship: boolean;
  readonly reactivateRelationship: boolean;
  readonly voidRelationship: boolean;
  readonly voidParticipant: boolean;
}

const T = true;
const F = false;
const MATRIX: Readonly<Record<string, Expected>> = {
  //            viewP  createP  establishP  viewR  createR  addPt  changePt  endPt  endR  reactR  voidR  voidPt
  OWNER:       { viewParty: T, createParty: T, establishParty: T, viewRelationship: T, createRelationship: T, addParticipant: T, changeParticipant: T, endParticipant: T, endRelationship: T, reactivateRelationship: T, voidRelationship: T, voidParticipant: T },
  ADMIN:       { viewParty: T, createParty: T, establishParty: T, viewRelationship: T, createRelationship: T, addParticipant: T, changeParticipant: T, endParticipant: T, endRelationship: T, reactivateRelationship: T, voidRelationship: T, voidParticipant: T },
  // A manager runs the day; they do not decide who is canonically who, and they do
  // not erase a record that was never true.
  MANAGER:     { viewParty: T, createParty: T, establishParty: F, viewRelationship: T, createRelationship: T, addParticipant: T, changeParticipant: T, endParticipant: T, endRelationship: T, reactivateRelationship: T, voidRelationship: F, voidParticipant: F },
  // An employee records what happened. Ending a commercial connection is a
  // supervisory act, so it stops here.
  EMPLOYEE:    { viewParty: T, createParty: T, establishParty: F, viewRelationship: T, createRelationship: T, addParticipant: T, changeParticipant: T, endParticipant: F, endRelationship: F, reactivateRelationship: F, voidRelationship: F, voidParticipant: F },
  // Hard-denied at both authorities. A machine does not decide who someone is, and
  // no Permission row can grant it that.
  AI_EMPLOYEE: { viewParty: F, createParty: F, establishParty: F, viewRelationship: F, createRelationship: F, addParticipant: F, changeParticipant: F, endParticipant: F, endRelationship: F, reactivateRelationship: F, voidRelationship: F, voidParticipant: F },
  READ_ONLY:   { viewParty: T, createParty: F, establishParty: F, viewRelationship: T, createRelationship: F, addParticipant: F, changeParticipant: F, endParticipant: F, endRelationship: F, reactivateRelationship: F, voidRelationship: F, voidParticipant: F },
  // Unknown role. It is refused EVERYTHING, and by two different mechanisms worth
  // knowing apart. The Party surface has no READ_ONLY fallback, so it holds no
  // identityResolution action. The Relationship surface does fall back to READ_ONLY
  // in the matrix -- but a role that is not a role derives NO MEMBERSHIP, and the
  // read service requires a granted membership before it consults the matrix at all.
  // So the nav will offer this person a Relationships link (nav visibility is not
  // authorization) and the page itself refuses them. That is the right way round.
  INTERN:      { viewParty: F, createParty: F, establishParty: F, viewRelationship: F, createRelationship: F, addParticipant: F, changeParticipant: F, endParticipant: F, endRelationship: F, reactivateRelationship: F, voidRelationship: F, voidParticipant: F },
};

async function world(role: string) {
  const fake: any = makeCognitivePrisma({
    also: [
      'invitation', 'organizationMembership', 'customer', 'customerPartyLink',
      'crmRelationship', 'crmRelationshipEvent', 'crmParticipant',
    ],
  });
  const prisma = fake as PrismaClient;
  const iam = new IamRepository(prisma);
  const parties = new PartyService(prisma);
  const partyReads = new PartyRecordService(prisma);
  const relationships = new CrmRelationshipService(prisma);
  const relationshipReads = new CrmRelationshipReadService(prisma);

  const hire = async (r: string) => {
    const u = await iam.createUser({ organizationId: ORG, email: `${r}-${Math.random()}@x.io`, systemRole: r, name: `${r} Person` });
    await iam.activateUser(ORG, u.id);
    return u.id;
  };
  // The world is seeded by an OWNER, so every refusal below is a refusal of the
  // ACT and never of a missing target.
  const owner = await hire('OWNER');
  const subject = await hire(role);

  const establish = async (partyType: 'PERSON' | 'COMPANY') => {
    const created = await parties.create(ORG, owner, { partyType });
    assert.equal(created.outcome, 'RECORDED');
    const id = created.outcome === 'RECORDED' ? created.party.id : '';
    assert.equal((await parties.establish(ORG, owner, id, 'MANUAL')).outcome, 'RECORDED');
    return id;
  };
  const client = await establish('COMPANY');
  // A Party record that exists and is NOT canonical identity. Creating is not
  // establishing, and the queue is where the difference is visible.
  const madeOnly = await parties.create(ORG, owner, { partyType: 'COMPANY' });
  const unestablished = madeOnly.outcome === 'RECORDED' ? madeOnly.party.id : '';
  const [contactA, contactB, spare] = [await establish('PERSON'), await establish('PERSON'), await establish('PERSON')];

  const ownerActor = { organizationId: ORG, userId: owner, actorName: 'Owner' };
  const created = await relationships.create(ownerActor, {
    kind: 'CLIENT',
    // The side's role is a Party CAPACITY -- what this Party does here. 'CLIENT'
    // is the kind of connection, not a capacity anybody holds.
    sides: [{ side: 'COUNTERPARTY', partyId: client, role: 'BUYER' }],
    occurredAt: AT,
  });
  assert.equal(created.outcome, 'RECORDED', 'an OWNER can record a governed Relationship');
  const relationshipId = created.outcome === 'RECORDED' ? created.value.relationship.id : '';

  const addFor = async (partyId: string, r: 'PRIMARY_CONTACT' | 'DECISION_MAKER') => {
    const res = await relationships.addParticipant(ownerActor, {
      relationshipId, partyId, role: r, actsForSide: 'COUNTERPARTY', occurredAt: AT,
    });
    assert.equal(res.outcome, 'RECORDED', `an OWNER can add a ${r}`);
    return res.outcome === 'RECORDED' ? res.value.id : '';
  };
  const participantA = await addFor(contactA, 'PRIMARY_CONTACT');
  const participantB = await addFor(contactB, 'DECISION_MAKER');

  const counts = () => ({
    identities: fake.cognitiveIdentity.__rows.length,
    relationships: fake.crmRelationship.__rows.length,
    events: fake.crmRelationshipEvent.__rows.length,
    participants: fake.crmParticipant.__rows.length,
    audit: fake.auditLog.__rows.length,
    outbox: fake.stateChangeOutbox.__rows.length,
  });

  return {
    prisma, parties, partyReads, relationships, relationshipReads,
    subject, client, spare, unestablished, relationshipId, participantA, participantB, counts,
    actor: { organizationId: ORG, userId: subject, actorName: `${role} Person` },
    viewer: { organizationId: ORG, userId: subject },
  };
}

for (const [role, expected] of Object.entries(MATRIX)) {
  test(`operator surface as ${role}: the server decides, not the form`, async () => {
    const w = await world(role);
    const before = w.counts();

    // --- Reading (workflows 3, 4, 7, 8, 9) --------------------------------------
    const people = await w.partyReads.listPeople(ORG, w.subject);
    const companies = await w.partyReads.listCompanies(ORG, w.subject);
    const queue = await w.partyReads.listEstablishmentQueue(ORG, w.subject);
    const record = await w.partyReads.getRecord(ORG, w.subject, w.client);
    for (const [name, r] of [['listPeople', people], ['listCompanies', companies], ['queue', queue], ['record', record]] as const) {
      assert.equal(r.outcome === 'OK', expected.viewParty, `${role} ${name}`);
    }
    if (people.outcome === 'OK') {
      // The page renders its forms from THESE, not from a role check of its own.
      assert.equal(people.capabilities.createParty, expected.createParty, `${role} createParty capability`);
      assert.equal(people.capabilities.establishParty, expected.establishParty, `${role} establishParty capability`);
    }

    const list = await w.relationshipReads.list(w.viewer);
    const detail = await w.relationshipReads.getRecord(w.viewer, w.relationshipId);
    const forParty = await w.relationshipReads.forParty(w.viewer, w.client);
    for (const [name, r] of [['list', list], ['detail', detail], ['forParty', forParty]] as const) {
      assert.equal(r.outcome === 'OK', expected.viewRelationship, `${role} relationship ${name}`);
    }
    if (detail.outcome === 'OK') {
      const c = detail.capabilities;
      assert.equal(c.create, expected.createRelationship, `${role} create capability`);
      assert.equal(c.addParticipant, expected.addParticipant, `${role} addParticipant capability`);
      assert.equal(c.changeParticipant, expected.changeParticipant, `${role} changeParticipant capability`);
      assert.equal(c.endParticipant, expected.endParticipant, `${role} endParticipant capability`);
      assert.equal(c.endRelationship, expected.endRelationship, `${role} endRelationship capability`);
      assert.equal(c.reactivateRelationship, expected.reactivateRelationship, `${role} reactivate capability`);
      assert.equal(c.voidRelationship, expected.voidRelationship, `${role} voidRelationship capability`);
      assert.equal(c.voidParticipant, expected.voidParticipant, `${role} voidParticipant capability`);
      // A Relationship a viewer may read still says what they may not do, rather
      // than the surface deciding to hide it.
      assert.equal(detail.value.relationshipId, w.relationshipId);
    }

    // History is part of the record, on the same authority as the record (workflow 9).
    if (detail.outcome === 'OK') {
      assert.ok(Array.isArray(detail.value.history), `${role} sees the append-only history`);
      assert.ok(detail.value.history.length >= 3, 'creation and both Participant additions are on it');
    }

    // --- Acting: submitted anyway, by every role (workflows 1, 2, 5, 6, 10) -----
    const attempts: Array<readonly [string, boolean, () => Promise<{ outcome: string }>]> = [
      ['createParty', expected.createParty, () => w.parties.create(ORG, w.subject, { partyType: 'PERSON' })],
      // The target is seeded, so this attempt is a pure establish: nothing this role
      // is allowed to do happens first and muddies the "left nothing behind" check.
      ['establishParty', expected.establishParty, () => w.parties.establish(ORG, w.subject, w.unestablished, 'MANUAL')],
      ['createRelationship', expected.createRelationship, () => w.relationships.create(w.actor, {
        kind: 'SUPPLIER', sides: [{ side: 'COUNTERPARTY', partyId: w.client, role: 'VENDOR' }], occurredAt: AT,
      })],
      ['addParticipant', expected.addParticipant, () => w.relationships.addParticipant(w.actor, {
        relationshipId: w.relationshipId, partyId: w.spare, role: 'BILLING_CONTACT', actsForSide: 'COUNTERPARTY', occurredAt: AT,
      })],
      ['changeParticipant', expected.changeParticipant, () => w.relationships.changeParticipant(w.actor, w.participantA, {
        effectiveFrom: AT, occurredAt: AT,
      })],
      ['endParticipant', expected.endParticipant, () => w.relationships.endParticipant(w.actor, w.participantA, {
        reason: 'Left the company', occurredAt: AT,
      })],
      ['voidParticipant', expected.voidParticipant, () => w.relationships.voidParticipant(w.actor, w.participantB, {
        reason: 'Entered in error', occurredAt: AT,
      })],
      ['endRelationship', expected.endRelationship, () => w.relationships.end(w.actor, w.relationshipId, {
        reason: 'Contract finished', occurredAt: AT,
      })],
      ['reactivateRelationship', expected.reactivateRelationship, () => w.relationships.reactivate(w.actor, w.relationshipId, { occurredAt: AT })],
      ['voidRelationship', expected.voidRelationship, () => w.relationships.void(w.actor, w.relationshipId, {
        reason: 'Never happened', occurredAt: AT,
      })],
    ];

    let refusedCounts = before;
    for (const [name, permitted, run] of attempts) {
      const snapshot = w.counts();
      const result = await run();
      if (permitted) {
        // The act reached the rules. Whether those rules then allowed it (state,
        // duplicates, Party references) is a different file's job.
        assert.notEqual(result.outcome, 'NOT_AUTHORIZED', `${role} must be permitted to ${name}`);
      } else {
        assert.equal(result.outcome, 'NOT_AUTHORIZED', `${role} must be refused ${name} by the server`);
        assert.deepEqual(w.counts(), snapshot, `${role}'s refused ${name} must leave nothing behind`);
        refusedCounts = snapshot;
      }
    }
    void refusedCounts;
  });
}

test('a disabled member is refused everything, whatever role they still carry', async () => {
  // The membership is the authority, not the role string. Somebody who was an OWNER
  // yesterday and is disabled today reads nothing and performs nothing -- and the
  // check is the membership grant, before any role is consulted.
  const w = await world('OWNER');
  const iam = new IamRepository(w.prisma);
  assert.equal(await iam.disableUser(ORG, w.subject), true);

  assert.equal((await w.partyReads.listPeople(ORG, w.subject)).outcome, 'NOT_AUTHORIZED');
  assert.equal((await w.relationshipReads.list(w.viewer)).outcome, 'NOT_AUTHORIZED');
  assert.equal((await w.relationshipReads.getRecord(w.viewer, w.relationshipId)).outcome, 'NOT_AUTHORIZED');

  const before = w.counts();
  assert.equal((await w.parties.create(ORG, w.subject, { partyType: 'PERSON' })).outcome, 'NOT_AUTHORIZED');
  assert.equal((await w.parties.establish(ORG, w.subject, w.unestablished, 'MANUAL')).outcome, 'NOT_AUTHORIZED');
  assert.equal((await w.relationships.create(w.actor, {
    kind: 'SUPPLIER', sides: [{ side: 'COUNTERPARTY', partyId: w.client, role: 'VENDOR' }], occurredAt: AT,
  })).outcome, 'NOT_AUTHORIZED');
  assert.equal((await w.relationships.addParticipant(w.actor, {
    relationshipId: w.relationshipId, partyId: w.spare, role: 'BILLING_CONTACT', actsForSide: 'COUNTERPARTY', occurredAt: AT,
  })).outcome, 'NOT_AUTHORIZED');
  assert.equal((await w.relationships.end(w.actor, w.relationshipId, { reason: 'x', occurredAt: AT })).outcome, 'NOT_AUTHORIZED');
  assert.equal((await w.relationships.void(w.actor, w.relationshipId, { reason: 'x', occurredAt: AT })).outcome, 'NOT_AUTHORIZED');
  assert.deepEqual(w.counts(), before, 'a disabled member leaves no row, no event, no audit entry');
});

test('a role that may read learns nothing it may not act on, and a role that may not read learns nothing at all', async () => {
  const w = await world('AI_EMPLOYEE');
  // Not "forbidden" with a hint that something is there, and not a different answer
  // for a Party that exists than for one that does not.
  const real = await w.partyReads.getRecord(ORG, w.subject, w.client);
  const imaginary = await w.partyReads.getRecord(ORG, w.subject, 'party_that_never_existed');
  assert.equal(real.outcome, 'NOT_AUTHORIZED');
  assert.equal(imaginary.outcome, 'NOT_AUTHORIZED');
  assert.deepEqual(real, imaginary, 'a denied reader cannot probe for a Party');

  const relReal = await w.relationshipReads.getRecord(w.viewer, w.relationshipId);
  const relImaginary = await w.relationshipReads.getRecord(w.viewer, 'rel_that_never_existed');
  assert.deepEqual(relReal, relImaginary, 'nor for a Relationship');
});

test('an authorized human can complete the whole loop: establish two Parties, relate them, staff it, end it', async () => {
  // The acceptance test, at the authority the surface calls. No fixture, no seeded
  // Relationship, no automatic identity resolution anywhere in it.
  const w = await world('OWNER');
  const made = await w.parties.create(ORG, w.subject, { partyType: 'PERSON', displayName: 'A Named Person' });
  assert.equal(made.outcome, 'RECORDED');
  const personId = made.outcome === 'RECORDED' ? made.party.id : '';
  assert.equal(made.outcome === 'RECORDED' && made.party.establishment.established, false, 'creating is not establishing');

  const establishedResult = await w.parties.establish(ORG, w.subject, personId, 'MANUAL');
  assert.equal(establishedResult.outcome, 'RECORDED');
  assert.equal(establishedResult.outcome === 'RECORDED' && establishedResult.party.establishment.established, true);

  const company = await w.parties.create(ORG, w.subject, { partyType: 'COMPANY', displayName: 'A Named Company' });
  const companyId = company.outcome === 'RECORDED' ? company.party.id : '';
  assert.equal((await w.parties.establish(ORG, w.subject, companyId, 'EXPLICIT_LINK')).outcome, 'RECORDED');

  const rel = await w.relationships.create(w.actor, {
    kind: 'AFFILIATION',
    sides: [{ side: 'A', partyId: personId, role: 'EMPLOYEE' }, { side: 'B', partyId: companyId, role: 'PARTNER' }],
    occurredAt: AT,
  });
  assert.equal(rel.outcome, 'RECORDED', 'a governed Relationship between two established Parties');
  const id = rel.outcome === 'RECORDED' ? rel.value.relationship.id : '';
  assert.equal(rel.outcome === 'RECORDED' && rel.value.participants.length, 2, 'both sides recorded as Participants');

  const staffed = await w.relationships.addParticipant(w.actor, {
    relationshipId: id, partyId: personId, role: 'BILLING_CONTACT', actsForSide: 'B', occurredAt: AT,
  });
  assert.equal(staffed.outcome, 'RECORDED');

  assert.equal((await w.relationships.end(w.actor, id, { reason: 'Affiliation ended', occurredAt: AT })).outcome, 'RECORDED');
  assert.equal((await w.relationships.reactivate(w.actor, id, { occurredAt: AT })).outcome, 'RECORDED');

  // And the surface can then read back exactly what happened, in order.
  const readBack = await w.relationshipReads.getRecord(w.viewer, id);
  assert.equal(readBack.outcome, 'OK');
  if (readBack.outcome === 'OK') {
    // The history names what HAPPENED, not which act was invoked. Both readings
    // exist in this system and they are not the same vocabulary.
    const happened = readBack.value.history.map((h) => h.type);
    assert.deepEqual(happened.slice(0, 4), [
      'RELATIONSHIP_CREATED', 'PARTICIPANT_ADDED', 'RELATIONSHIP_ENDED', 'RELATIONSHIP_REACTIVATED',
    ]);
    // Append-only: ending and reactivating added entries, they replaced nothing.
    assert.equal(new Set(readBack.value.history.map((h) => h.sequence)).size, readBack.value.history.length);
    assert.equal(readBack.value.state, 'ACTIVE');
  }
});
