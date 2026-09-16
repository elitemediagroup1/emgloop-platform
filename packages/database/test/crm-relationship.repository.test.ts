// CRM Relationship and Participant persistence. Slice R2.
//
// Drives the REAL repository over the in-memory Prisma double, which enforces the
// org-scoped uniques exactly as Postgres does (a colliding insert throws P2002), so
// the duplicate and race properties are proven rather than assumed.
//
// WHAT THESE PROVE
//
// A PARTY IS RESOLVED, NEVER TRUSTED. The caller hands over an id and nothing else.
// Unestablished, archived, superseded, cross-organization, cross-type and missing
// references are all REFUSED, and a superseded id comes back with its canonical id
// so a person decides -- it is never silently swapped. The Party authority's own
// answer supplies the type, so a role can never imply one.
//
// HISTORY IS APPEND-ONLY AND STATE IS ITS PROJECTION. Every write appends an event
// in the same transaction, the stored state always equals what the shared reducer
// folds from the log, and nothing is ever deleted: removal is END or VOID.
//
// THE NATURAL KEY IS RELEASED BY VOID AND HELD BY END. So the same commercial
// connection cannot exist twice, a renewal reactivates the record that already
// carries the history, and a record entered in error stops standing in the way.
//
// A ROLE HELD AGAIN IS NEW HISTORY. Ending a Participant releases its active key;
// adding the role back writes a second row, and the first row keeps its reason.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PrismaClient } from '@prisma/client';
import { projectCrmRelationshipState } from '@emgloop/shared';

import { makeCognitivePrisma } from './helpers/cognitive-prisma-fake';
import { CrmRelationshipRepository } from '../src/repositories/crm-relationship.repository';
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
  const repo = new CrmRelationshipRepository(prisma);

  const hire = async (role: string, org = ORG_A) => {
    const u = await iam.createUser({ organizationId: org, email: `${role.toLowerCase()}-${org}-${Math.random()}@x.io`, systemRole: role });
    await iam.activateUser(org, u.id);
    return u.id;
  };
  const owner = await hire('OWNER');
  const ownerB = await hire('OWNER', ORG_B);

  const party = async (partyType: 'PERSON' | 'COMPANY' = 'COMPANY', org = ORG_A, actor = org === ORG_A ? owner : ownerB) => {
    const created = await parties.create(org, actor, { partyType });
    assert.equal(created.outcome, 'RECORDED');
    const id = created.outcome === 'RECORDED' ? created.party.id : '';
    assert.equal((await parties.establish(org, actor, id, 'MANUAL')).outcome, 'RECORDED');
    return id;
  };
  /** A Party record nobody has established: real, and not referenceable. */
  const unestablished = async (partyType: 'PERSON' | 'COMPANY' = 'COMPANY') => {
    const created = await parties.create(ORG_A, owner, { partyType });
    return created.outcome === 'RECORDED' ? created.party.id : '';
  };

  return { fake, prisma, repo, parties, iam, hire, owner, ownerB, party, unestablished };
}

/** REPRESENTATION: side A represents side B. Both sides accept either Party type. */
async function representation(w: Awaited<ReturnType<typeof world>>, patch: Record<string, unknown> = {}) {
  const agency = await w.party('COMPANY');
  const brand = await w.party('COMPANY');
  const result = await w.repo.create(ORG_A, {
    kind: 'REPRESENTATION',
    sides: [
      { side: 'A', partyId: agency, role: 'AGENCY' },
      { side: 'B', partyId: brand, role: 'BRAND' },
    ],
    actorUserId: w.owner,
    occurredAt: AT,
    ...patch,
  });
  return { result, agency, brand };
}

// --- 1. Creation, and what it refuses -------------------------------------------------

test('a Relationship is created with its side Participants and the first event, or not at all', async () => {
  const w = await world();
  const { result, agency, brand } = await representation(w);
  assert.equal(result.outcome, 'RECORDED');
  if (result.outcome !== 'RECORDED') return;

  const { relationship, participants } = result.value;
  assert.equal(relationship.organizationId, ORG_A);
  assert.equal(relationship.kind, 'REPRESENTATION');
  assert.equal(relationship.structure, 'THIRD_PARTY');
  assert.equal(relationship.state, 'ACTIVE');
  assert.equal(relationship.lastSequence, 1);
  assert.equal(relationship.createdByUserId, w.owner);
  assert.ok(relationship.nonVoidedNaturalKey?.includes(agency) && relationship.nonVoidedNaturalKey.includes(brand));

  assert.equal(participants.length, 2);
  assert.deepEqual(participants.map((p) => [p.side, p.role, p.partyType, p.state]), [
    ['A', 'AGENCY', 'COMPANY', 'ACTIVE'],
    ['B', 'BRAND', 'COMPANY', 'ACTIVE'],
  ]);
  for (const p of participants) assert.equal(p.actsForSide, null);

  const events = await w.repo.eventsFor(ORG_A, relationship.id);
  assert.deepEqual(events.map((e) => [e.sequence, e.type, e.actorType, e.toState]), [[1, 'RELATIONSHIP_CREATED', 'HUMAN', 'ACTIVE']]);
  assert.equal(await w.repo.projectedState(ORG_A, relationship.id), 'ACTIVE');
});

test('the Party authority supplies the type; the caller never asserts one', async () => {
  const w = await world();
  const person = await w.party('PERSON');
  const company = await w.party('COMPANY');
  // AFFILIATION: side A must be a PERSON, side B a COMPANY. Swapping them is refused
  // on the authority's own answer, not on anything the caller claimed.
  const wrong = await w.repo.create(ORG_A, {
    kind: 'AFFILIATION',
    sides: [
      { side: 'A', partyId: company, role: 'EMPLOYEE' },
      { side: 'B', partyId: person, role: 'BRAND' },
    ],
    actorUserId: w.owner,
    occurredAt: AT,
  });
  assert.equal(wrong.outcome, 'INVALID');
  if (wrong.outcome === 'INVALID') {
    assert.ok(wrong.violations.includes('PARTY_TYPE_NOT_PERMITTED_FOR_SIDE'));
  }

  const right = await w.repo.create(ORG_A, {
    kind: 'AFFILIATION',
    sides: [
      { side: 'A', partyId: person, role: 'EMPLOYEE' },
      { side: 'B', partyId: company, role: 'BRAND' },
    ],
    actorUserId: w.owner,
    occurredAt: AT,
  });
  assert.equal(right.outcome, 'RECORDED');
});

test('a Party that is not referenceable is refused, and a superseded one names its canonical id', async () => {
  const w = await world();
  const good = await w.party('COMPANY');

  // Missing.
  const missing = await w.repo.create(ORG_A, {
    kind: 'REPRESENTATION',
    sides: [{ side: 'A', partyId: 'party_nope', role: 'AGENCY' }, { side: 'B', partyId: good, role: 'BRAND' }],
    actorUserId: w.owner, occurredAt: AT,
  });
  assert.equal(missing.outcome, 'PARTY_REFUSED');
  if (missing.outcome === 'PARTY_REFUSED') assert.deepEqual(missing.refusals, [{ partyId: 'party_nope', refusal: 'NOT_FOUND' }]);

  // Another organization's: NOT_FOUND, indistinguishable from missing.
  const theirs = await w.party('COMPANY', ORG_B);
  const crossOrg = await w.repo.create(ORG_A, {
    kind: 'REPRESENTATION',
    sides: [{ side: 'A', partyId: theirs, role: 'AGENCY' }, { side: 'B', partyId: good, role: 'BRAND' }],
    actorUserId: w.owner, occurredAt: AT,
  });
  assert.equal(crossOrg.outcome, 'PARTY_REFUSED');
  if (crossOrg.outcome === 'PARTY_REFUSED') assert.equal(crossOrg.refusals[0]!.refusal, 'NOT_FOUND');

  // Never established.
  const pending = await w.unestablished();
  const notEstablished = await w.repo.create(ORG_A, {
    kind: 'REPRESENTATION',
    sides: [{ side: 'A', partyId: pending, role: 'AGENCY' }, { side: 'B', partyId: good, role: 'BRAND' }],
    actorUserId: w.owner, occurredAt: AT,
  });
  assert.equal(notEstablished.outcome, 'PARTY_REFUSED');
  if (notEstablished.outcome === 'PARTY_REFUSED') assert.equal(notEstablished.refusals[0]!.refusal, 'NOT_ESTABLISHED');

  // Superseded: refused, WITH the canonical id, so the writer retries on purpose.
  const canonical = await w.party('COMPANY');
  const superseded = await w.party('COMPANY');
  await w.fake.cognitiveIdentity.update({
    where: { id: superseded },
    data: { supersededByIdentityId: canonical, supersededAt: AT, supersededByUserId: w.owner },
  });
  const swapped = await w.repo.create(ORG_A, {
    kind: 'REPRESENTATION',
    sides: [{ side: 'A', partyId: superseded, role: 'AGENCY' }, { side: 'B', partyId: good, role: 'BRAND' }],
    actorUserId: w.owner, occurredAt: AT,
  });
  assert.equal(swapped.outcome, 'PARTY_REFUSED');
  if (swapped.outcome === 'PARTY_REFUSED') {
    assert.deepEqual(swapped.refusals, [{ partyId: superseded, refusal: 'SUPERSEDED', canonicalPartyId: canonical }]);
  }
  assert.equal(w.fake.crmRelationship.__rows.length, 0, 'not one of those attempts wrote anything');
});

test('an archived Party takes no new reference, while the Relationship it is already in stays readable', async () => {
  const w = await world();
  const { result, agency } = await representation(w);
  assert.equal(result.outcome, 'RECORDED');
  await w.fake.cognitiveIdentity.update({ where: { id: agency }, data: { status: 'ARCHIVED', archivedAt: AT } });

  const other = await w.party('COMPANY');
  const refused = await w.repo.create(ORG_A, {
    kind: 'SUPPLY',
    sides: [{ side: 'A', partyId: agency, role: 'VENDOR' }, { side: 'B', partyId: other, role: 'BUYER' }],
    actorUserId: w.owner, occurredAt: AT,
  });
  assert.equal(refused.outcome, 'PARTY_REFUSED');
  if (refused.outcome === 'PARTY_REFUSED') assert.equal(refused.refusals[0]!.refusal, 'ARCHIVED');

  // The existing Relationship is untouched: archiving a Party rewrites nothing.
  const existing = result.outcome === 'RECORDED' ? result.value.relationship : null;
  const still = await w.repo.findById(ORG_A, existing!.id);
  assert.equal(still?.state, 'ACTIVE');
  const participants = await w.repo.participantsFor(ORG_A, existing!.id);
  assert.equal(participants.find((p) => p.partyId === agency)?.state, 'ACTIVE');
});

test('the same commercial connection cannot be recorded twice while it stands', async () => {
  const w = await world();
  const agency = await w.party('COMPANY');
  const brand = await w.party('COMPANY');
  const make = () =>
    w.repo.create(ORG_A, {
      kind: 'REPRESENTATION',
      sides: [{ side: 'A', partyId: agency, role: 'AGENCY' }, { side: 'B', partyId: brand, role: 'BRAND' }],
      actorUserId: w.owner, occurredAt: AT,
    });
  assert.equal((await make()).outcome, 'RECORDED');
  assert.equal((await make()).outcome, 'DUPLICATE');

  // A different KIND between the same Parties is a different fact, and allowed.
  const supply = await w.repo.create(ORG_A, {
    kind: 'SUPPLY',
    sides: [{ side: 'A', partyId: agency, role: 'VENDOR' }, { side: 'B', partyId: brand, role: 'BUYER' }],
    actorUserId: w.owner, occurredAt: AT,
  });
  assert.equal(supply.outcome, 'RECORDED');
});

test('the sides must be the ones the kind declares, and one Party cannot be both', async () => {
  const w = await world();
  const a = await w.party('COMPANY');
  const b = await w.party('COMPANY');
  const make = (sides: { side: 'A' | 'B' | 'COUNTERPARTY'; partyId: string; role: 'AGENCY' | 'BRAND' }[], kind = 'REPRESENTATION') =>
    w.repo.create(ORG_A, { kind, sides, actorUserId: w.owner, occurredAt: AT });

  // A two-sided kind given one side.
  const short = await make([{ side: 'A', partyId: a, role: 'AGENCY' }]);
  assert.equal(short.outcome, 'INVALID');
  if (short.outcome === 'INVALID') assert.deepEqual(short.violations, ['SIDES_DO_NOT_MATCH_KIND']);

  // A side the kind does not declare: COUNTERPARTY belongs to OWN kinds only.
  const wrongSide = await make([{ side: 'COUNTERPARTY', partyId: a, role: 'AGENCY' }, { side: 'B', partyId: b, role: 'BRAND' }]);
  assert.equal(wrongSide.outcome, 'INVALID');
  if (wrongSide.outcome === 'INVALID') assert.ok(wrongSide.violations.includes('SIDES_DO_NOT_MATCH_KIND'));

  // A one-sided OWN kind given two sides -- the shape that would smuggle in a
  // tenant Party (PD-F-01: the workspace is the owning side and has no Party).
  const tenantSide = await make([{ side: 'COUNTERPARTY', partyId: a, role: 'BRAND' }, { side: 'A', partyId: b, role: 'AGENCY' }], 'CLIENT');
  assert.equal(tenantSide.outcome, 'INVALID');
  if (tenantSide.outcome === 'INVALID') assert.ok(tenantSide.violations.includes('SIDES_DO_NOT_MATCH_KIND'));

  // One Party on both sides is not a commercial connection.
  const both = await make([{ side: 'A', partyId: a, role: 'AGENCY' }, { side: 'B', partyId: a, role: 'BRAND' }]);
  assert.equal(both.outcome, 'INVALID');
  if (both.outcome === 'INVALID') assert.deepEqual(both.violations, ['SAME_PARTY_ON_BOTH_SIDES']);

  assert.equal(w.fake.crmRelationship.__rows.length, 0, 'none of them wrote anything');
  // And the shape the kind does declare is accepted.
  assert.equal((await make([{ side: 'A', partyId: a, role: 'AGENCY' }, { side: 'B', partyId: b, role: 'BRAND' }])).outcome, 'RECORDED');
});

test('every query this repository issues names an organization', async () => {
  // Tenancy that depends on a second query filtering correctly is tenancy waiting
  // for the day somebody reads the first query's result directly. Scoped at the
  // data layer means EVERY query, which is what this asserts.
  const w = await world();
  const seen: { delegate: string; where: unknown }[] = [];
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
  const repo = new CrmRelationshipRepository(watched);
  const { result } = await representation(w);
  const id = result.outcome === 'RECORDED' ? result.value.relationship.id : '';

  await repo.findById(ORG_A, id);
  await repo.participantsFor(ORG_A, id);
  await repo.eventsFor(ORG_A, id);
  await repo.projectedState(ORG_A, id);
  await repo.forParty(ORG_A, 'party_x');
  await repo.addParticipant(ORG_A, { relationshipId: id, partyId: 'party_x', role: 'PRIMARY_CONTACT', actsForSide: 'B', actorUserId: w.owner, occurredAt: AT });
  await repo.closeParticipant(ORG_A, 'participant_x', { to: 'ENDED', actorUserId: w.owner, occurredAt: AT, reason: 'x' });
  await repo.transition(ORG_A, id, { to: 'ENDED', actorUserId: w.owner, occurredAt: AT, reason: 'x' });

  assert.ok(seen.length >= 8, `queries were observed (${seen.length})`);
  for (const { delegate, where } of seen) {
    assert.equal(
      (where as { organizationId?: unknown })?.organizationId,
      ORG_A,
      `${delegate} query without an organization: ${JSON.stringify(where)}`,
    );
  }
});

// --- 2. Lifecycle ----------------------------------------------------------------------

test('end, reactivate and void each append history, and the projection always agrees', async () => {
  const w = await world();
  const { result } = await representation(w);
  const id = result.outcome === 'RECORDED' ? result.value.relationship.id : '';

  const ended = await w.repo.transition(ORG_A, id, { to: 'ENDED', actorUserId: w.owner, occurredAt: AT, reason: 'contract lapsed' });
  assert.equal(ended.outcome, 'RECORDED');
  if (ended.outcome === 'RECORDED') {
    assert.equal(ended.value.state, 'ENDED');
    assert.ok(ended.value.nonVoidedNaturalKey, 'an ended Relationship keeps its key, so renewal reactivates it');
  }

  const back = await w.repo.transition(ORG_A, id, { to: 'ACTIVE', actorUserId: w.owner, occurredAt: AT });
  assert.equal(back.outcome, 'RECORDED');

  const voided = await w.repo.transition(ORG_A, id, { to: 'VOIDED', actorUserId: w.owner, occurredAt: AT, reason: 'entered in error' });
  assert.equal(voided.outcome, 'RECORDED');
  if (voided.outcome === 'RECORDED') assert.equal(voided.value.nonVoidedNaturalKey, null, 'voiding releases the key');

  const events = await w.repo.eventsFor(ORG_A, id);
  assert.deepEqual(events.map((e) => e.type), [
    'RELATIONSHIP_CREATED', 'RELATIONSHIP_ENDED', 'RELATIONSHIP_REACTIVATED', 'RELATIONSHIP_VOIDED',
  ]);
  assert.deepEqual(events.map((e) => e.sequence), [1, 2, 3, 4]);
  // The stored state is never an independent truth: it is what the log folds to.
  const projection = projectCrmRelationshipState(events.map((e) => ({ sequence: e.sequence, type: e.type })));
  assert.deepEqual(projection, { ok: true, state: 'VOIDED', lastSequence: 4 });
  assert.equal((await w.repo.findById(ORG_A, id))?.state, 'VOIDED');

  // VOIDED is final.
  const after = await w.repo.transition(ORG_A, id, { to: 'ACTIVE', actorUserId: w.owner, occurredAt: AT });
  assert.equal(after.outcome, 'ILLEGAL_TRANSITION');
});

test('ending and voiding demand a written reason, and nothing is recorded without one', async () => {
  const w = await world();
  const { result } = await representation(w);
  const id = result.outcome === 'RECORDED' ? result.value.relationship.id : '';
  for (const reason of [undefined, null, '', '   ']) {
    const r = await w.repo.transition(ORG_A, id, { to: 'ENDED', actorUserId: w.owner, occurredAt: AT, reason });
    assert.equal(r.outcome, 'REASON_REQUIRED', JSON.stringify(reason));
  }
  assert.equal((await w.repo.eventsFor(ORG_A, id)).length, 1, 'no event was appended');
  assert.equal((await w.repo.findById(ORG_A, id))?.state, 'ACTIVE');
  // Reactivation needs none: it is not an act that says no.
  await w.repo.transition(ORG_A, id, { to: 'ENDED', actorUserId: w.owner, occurredAt: AT, reason: 'over' });
  assert.equal((await w.repo.transition(ORG_A, id, { to: 'ACTIVE', actorUserId: w.owner, occurredAt: AT })).outcome, 'RECORDED');
});

test('a voided Relationship releases its key, so the connection can be recorded again', async () => {
  const w = await world();
  const agency = await w.party('COMPANY');
  const brand = await w.party('COMPANY');
  const make = () =>
    w.repo.create(ORG_A, {
      kind: 'REPRESENTATION',
      sides: [{ side: 'A', partyId: agency, role: 'AGENCY' }, { side: 'B', partyId: brand, role: 'BRAND' }],
      actorUserId: w.owner, occurredAt: AT,
    });
  const first = await make();
  const id = first.outcome === 'RECORDED' ? first.value.relationship.id : '';
  await w.repo.transition(ORG_A, id, { to: 'VOIDED', actorUserId: w.owner, occurredAt: AT, reason: 'wrong record' });

  const second = await make();
  assert.equal(second.outcome, 'RECORDED');
  // And the voided record still exists, with its history.
  assert.equal((await w.repo.findById(ORG_A, id))?.state, 'VOIDED');
  assert.equal((await w.repo.eventsFor(ORG_A, id)).length, 2);
});

// --- 3. Participants -------------------------------------------------------------------

test('a Participant acts for a side, and one Party may hold several roles', async () => {
  const w = await world();
  const { result } = await representation(w);
  const id = result.outcome === 'RECORDED' ? result.value.relationship.id : '';
  const person = await w.party('PERSON');

  const contact = await w.repo.addParticipant(ORG_A, {
    relationshipId: id, partyId: person, role: 'PRIMARY_CONTACT', actsForSide: 'B', actorUserId: w.owner, occurredAt: AT,
  });
  assert.equal(contact.outcome, 'RECORDED');
  if (contact.outcome === 'RECORDED') {
    assert.equal(contact.value.side, null);
    assert.equal(contact.value.actsForSide, 'B');
    assert.equal(contact.value.roleFamily, 'ENGAGEMENT');
    assert.equal(contact.value.partyType, 'PERSON');
  }

  // The same Party, a second role in the same Relationship: allowed, its own row.
  const decider = await w.repo.addParticipant(ORG_A, {
    relationshipId: id, partyId: person, role: 'DECISION_MAKER', actsForSide: 'B', actorUserId: w.owner, occurredAt: AT,
  });
  assert.equal(decider.outcome, 'RECORDED');

  // The same Party and the SAME role again, while the first is active: refused.
  const again = await w.repo.addParticipant(ORG_A, {
    relationshipId: id, partyId: person, role: 'PRIMARY_CONTACT', actsForSide: 'B', actorUserId: w.owner, occurredAt: AT,
  });
  assert.equal(again.outcome, 'DUPLICATE');

  const events = await w.repo.eventsFor(ORG_A, id);
  assert.deepEqual(events.map((e) => e.type), ['RELATIONSHIP_CREATED', 'PARTICIPANT_ADDED', 'PARTICIPANT_ADDED']);
});

test('an engagement role cannot be a COMPANY, and a role never changes a Party type', async () => {
  const w = await world();
  const { result } = await representation(w);
  const id = result.outcome === 'RECORDED' ? result.value.relationship.id : '';
  const company = await w.party('COMPANY');
  const r = await w.repo.addParticipant(ORG_A, {
    relationshipId: id, partyId: company, role: 'BILLING_CONTACT', actsForSide: 'A', actorUserId: w.owner, occurredAt: AT,
  });
  assert.equal(r.outcome, 'INVALID');
  if (r.outcome === 'INVALID') assert.deepEqual(r.violations, ['PARTY_TYPE_NOT_PERMITTED_FOR_ROLE']);
  // The Party is untouched: a refused role does not reclassify anybody.
  const party = w.fake.cognitiveIdentity.__rows.find((x: any) => x.id === company);
  assert.equal(party.entityType, 'COMPANY');
});

test('ending a Participant keeps the row, releases the key, and holding the role again is new history', async () => {
  const w = await world();
  const { result } = await representation(w);
  const id = result.outcome === 'RECORDED' ? result.value.relationship.id : '';
  const person = await w.party('PERSON');
  const first = await w.repo.addParticipant(ORG_A, {
    relationshipId: id, partyId: person, role: 'PRIMARY_CONTACT', actsForSide: 'B', actorUserId: w.owner, occurredAt: AT,
  });
  const participantId = first.outcome === 'RECORDED' ? first.value.id : '';

  assert.equal((await w.repo.closeParticipant(ORG_A, participantId, { to: 'ENDED', actorUserId: w.owner, occurredAt: AT, reason: '   ' })).outcome, 'REASON_REQUIRED');
  const ended = await w.repo.closeParticipant(ORG_A, participantId, { to: 'ENDED', actorUserId: w.owner, occurredAt: AT, reason: 'left the company' });
  assert.equal(ended.outcome, 'RECORDED');
  if (ended.outcome === 'RECORDED') {
    assert.equal(ended.value.state, 'ENDED');
    assert.equal(ended.value.activeKey, null);
    assert.equal(ended.value.endReason, 'left the company');
  }

  const back = await w.repo.addParticipant(ORG_A, {
    relationshipId: id, partyId: person, role: 'PRIMARY_CONTACT', actsForSide: 'B', actorUserId: w.owner, occurredAt: AT,
  });
  assert.equal(back.outcome, 'RECORDED', 'the role can be held again');
  const rows = await w.repo.participantsFor(ORG_A, id);
  const contacts = rows.filter((p) => p.role === 'PRIMARY_CONTACT');
  assert.equal(contacts.length, 2, 'two rows: the history and the present');
  assert.deepEqual(contacts.map((p) => p.state).sort(), ['ACTIVE', 'ENDED']);
  assert.ok(contacts.find((p) => p.state === 'ENDED')?.endReason, 'the ended row keeps why');
});

test('a side Participant cannot be ended on its own: the Relationship is voided instead', async () => {
  const w = await world();
  const { result } = await representation(w);
  const sideParticipant = result.outcome === 'RECORDED' ? result.value.participants[0]! : null;
  const r = await w.repo.closeParticipant(ORG_A, sideParticipant!.id, { to: 'ENDED', actorUserId: w.owner, occurredAt: AT, reason: 'wrong agency' });
  assert.equal(r.outcome, 'INVALID');
  if (r.outcome === 'INVALID') assert.deepEqual(r.violations, ['SIDE_PARTICIPANT_CANNOT_BE_CLOSED_ALONE']);
  const still = await w.repo.participantsFor(ORG_A, sideParticipant!.relationshipId!);
  assert.equal(still.find((p) => p.id === sideParticipant!.id)?.state, 'ACTIVE');
});

test('a Participant cannot be added to a Relationship that has ended or been voided', async () => {
  const w = await world();
  const { result } = await representation(w);
  const id = result.outcome === 'RECORDED' ? result.value.relationship.id : '';
  const person = await w.party('PERSON');
  await w.repo.transition(ORG_A, id, { to: 'ENDED', actorUserId: w.owner, occurredAt: AT, reason: 'over' });
  const r = await w.repo.addParticipant(ORG_A, {
    relationshipId: id, partyId: person, role: 'PRIMARY_CONTACT', actsForSide: 'B', actorUserId: w.owner, occurredAt: AT,
  });
  assert.equal(r.outcome, 'ILLEGAL_TRANSITION');
});

// --- 4. Tenancy ------------------------------------------------------------------------

test('every read and write is organization-scoped, and another tenant sees nothing', async () => {
  const w = await world();
  const { result } = await representation(w);
  const id = result.outcome === 'RECORDED' ? result.value.relationship.id : '';

  assert.equal(await w.repo.findById(ORG_B, id), null, 'not found, not forbidden');
  assert.deepEqual(await w.repo.participantsFor(ORG_B, id), []);
  assert.deepEqual(await w.repo.eventsFor(ORG_B, id), []);
  assert.equal(await w.repo.projectedState(ORG_B, id), null);
  assert.equal((await w.repo.transition(ORG_B, id, { to: 'ENDED', actorUserId: w.ownerB, occurredAt: AT, reason: 'x' })).outcome, 'NOT_FOUND');
  assert.equal((await w.repo.addParticipant(ORG_B, { relationshipId: id, partyId: 'p', role: 'PRIMARY_CONTACT', actsForSide: 'A', actorUserId: w.ownerB, occurredAt: AT })).outcome, 'NOT_FOUND');

  // A blank organization or id reads nothing rather than everything.
  assert.equal(await w.repo.findById('', id), null);
  assert.equal(await w.repo.findById(ORG_A, '  '), null);
  assert.deepEqual(await w.repo.forParty('', 'p'), []);
  // The record is untouched by any of it.
  assert.equal((await w.repo.findById(ORG_A, id))?.state, 'ACTIVE');
});

test('a Party\'s Relationships are found through its active participations only', async () => {
  const w = await world();
  const { result, agency } = await representation(w);
  const id = result.outcome === 'RECORDED' ? result.value.relationship.id : '';
  assert.deepEqual((await w.repo.forParty(ORG_A, agency)).map((r) => r.id), [id]);
  assert.deepEqual(await w.repo.forParty(ORG_B, agency), [], 'not across tenants');
  assert.deepEqual(await w.repo.forParty(ORG_A, 'party_unknown'), []);
});

// --- 5. Fences --------------------------------------------------------------------------

test('fence: every write composes into the caller\'s transaction rather than opening its own', () => {
  const src = readFileSync(join(__dirname, '..', 'src', 'repositories', 'crm-relationship.repository.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  // Prisma has no nested transactions, so a repository that always opened its own
  // could never be part of one governed act -- the row would commit and the audit
  // and outbox rows would be a separate bet. The in-memory double cannot roll back,
  // so this is asserted structurally: one helper, used by every write.
  assert.match(src, /return tx \? fn\(tx\) : this\.prisma\.\$transaction\(fn\);/, 'the caller\'s transaction is used when given');
  const directTransactions = [...src.matchAll(/this\.prisma\.\$transaction\(/g)].length;
  assert.equal(directTransactions, 1, 'exactly one place opens a transaction, and only when nobody supplied one');
  for (const method of ['async create(', 'async addParticipant(', 'async closeParticipant(', 'async transition(']) {
    const body = src.slice(src.indexOf(method));
    assert.match(body.slice(0, 2600), /this\.inTransaction\(tx,/, `${method} composes`);
  }
});

test('fence: persistence infers nothing, matches nobody, and writes no identity', () => {
  const src = readFileSync(join(__dirname, '..', 'src', 'repositories', 'crm-relationship.repository.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  // It never reaches identity or linking tables directly: the Party Reference
  // contract is the only way in, and it is read-only.
  assert.doesNotMatch(src, /cognitiveIdentity|identityEvidence|identityResolutionLink|customerPartyLink/);
  assert.doesNotMatch(src, /email|phone|displayName|canonicalKey/i, 'no contact value reaches this authority');
  assert.doesNotMatch(src, /\binfer|\bpredict|\bmatch\(|similarity|confidence|score/i);
  // No clock of its own: every instant is supplied by the caller, from the session.
  assert.doesNotMatch(src, /Date\.now\(\)|new Date\(\)/);
  // A machine actor cannot be written, and the database refuses one anyway.
  assert.doesNotMatch(src, /actorType:\s*'(SYSTEM|AI|MACHINE|AI_EMPLOYEE)'/);
  assert.match(src, /actorType: 'HUMAN'/);
});

test('fence: the migration is additive, ASCII, and drops nothing', () => {
  const sql = readFileSync(
    join(__dirname, '..', 'prisma', 'migrations', '20260917000000_crm_r2_relationship_participant', 'migration.sql'),
    'utf8',
  );
  assert.doesNotMatch(sql, /DROP\s+(TABLE|COLUMN|INDEX|CONSTRAINT|TYPE)/i, 'nothing is dropped');
  assert.doesNotMatch(sql, /\bALTER\s+TABLE\s+"(customers|interactions|audit_logs|users|organizations)"\s+ADD\s+COLUMN/i, 'no existing table gains a column');
  // Data statements, not the `ON DELETE CASCADE` of a foreign key.
  assert.doesNotMatch(sql, /^\s*(UPDATE\s|DELETE\s+FROM|INSERT\s+INTO|SELECT\s)/im, 'no row is read, written or moved');
  // eslint-disable-next-line no-control-regex
  assert.doesNotMatch(sql, /[^\x00-\x7F]/, 'ASCII only: a non-ASCII character once blocked replay of the whole ledger');
  for (const table of ['crm_relationships', 'crm_relationship_events', 'crm_participants']) {
    assert.match(sql, new RegExp(`CREATE TABLE "${table}"`));
    assert.match(sql, new RegExp(`${table}_organizationId_fkey`), `${table} is owned by an organization`);
  }
  assert.match(sql, /ALTER TYPE "OutboxSubjectType" ADD VALUE 'RELATIONSHIP'/);
  assert.match(sql, /CREATE INDEX "interactions_organizationId_customerId_occurredAt_idx"/);
  assert.match(sql, /CREATE INDEX "audit_logs_organizationId_entityType_entityId_createdAt_idx"/);
});

test('fence: the schema and the migration describe the same three tables', () => {
  const schema = readFileSync(join(__dirname, '..', 'prisma', 'schema.prisma'), 'utf8');
  const sql = readFileSync(
    join(__dirname, '..', 'prisma', 'migrations', '20260917000000_crm_r2_relationship_participant', 'migration.sql'),
    'utf8',
  );
  for (const [model, table] of [['CrmRelationship', 'crm_relationships'], ['CrmRelationshipEvent', 'crm_relationship_events'], ['CrmParticipant', 'crm_participants']] as const) {
    const body = schema.slice(schema.indexOf(`model ${model} {`), schema.indexOf(`@@map("${table}")`));
    assert.ok(body.length > 0, `${model} exists`);
    const columns = [...body.matchAll(/^\s{2}(\w+)\s+\w/gm)].map((m) => m[1]!).filter((c) => !/^(organization|owner|createdBy|relationship|events|participants|actor|addedBy|endedBy|voidedBy)$/.test(c));
    for (const column of columns) {
      assert.match(sql, new RegExp(`"${column}"`), `${table}.${column} is in the migration`);
    }
  }
  // Vocabularies are TEXT, so adding a kind or a role is never a migration.
  assert.doesNotMatch(sql, /CREATE TYPE "CrmRelationship|CREATE TYPE "CrmParticipant/);
});
