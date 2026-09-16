// The governed Relationship authority. Slice R3-A1.
//
// WHAT THESE PROVE
//
// FOUR WRITES OR NONE. Every consequential act puts the Relationship row, its event,
// its AuditLog row and its StateChangeOutbox row in ONE transaction. A refused act
// -- unauthorized, duplicate, refused Party, illegal transition -- leaves NOTHING
// behind: no event, no audit entry, no outbox row. An audited act that did not
// happen is a lie in the one record you go to when you need the truth.
//
// THE APPROVED GRANTS, AND NO SECOND VOCABULARY. Authorization binds the merged
// `CRM_RELATIONSHIP_ACT_ROLES` that Product approved act by act. A Permission row
// granting `relationships:manage` grants no act at all, because acts are not matrix
// actions -- a test says so, because the day somebody adds one expecting it to work
// is the day the two vocabularies start drifting.
//
// AI_EMPLOYEE PERFORMS NOTHING, and is denied before the table is consulted.
//
// THE AUDIT RECORDS THE ACT; THE LOG HOLDS THE WORDS. A reason can name a person, so
// it lives on the event and the audit row records only that one was given. No name,
// email or phone reaches audit metadata or an outbox payload.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PrismaClient } from '@prisma/client';

import { makeCognitivePrisma } from './helpers/cognitive-prisma-fake';
import { CrmRelationshipService } from '../src/services/crm-relationship.service';
import { PartyService } from '../src/services/party.service';
import { IamRepository } from '../src/repositories/iam.repository';

const ORG_A = 'org_a';
const ORG_B = 'org_b';
const AT = new Date('2026-09-16T10:00:00.000Z');
/** Planted where a person's words go. It must never reach audit or outbox. */
const REASON = 'Dana at dana@example.com asked us to stop on 555-0101';

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
  const party = async (partyType: 'PERSON' | 'COMPANY' = 'COMPANY', org = ORG_A, actor = owner) => {
    const c = await parties.create(org, actor, { partyType });
    const id = c.outcome === 'RECORDED' ? c.party.id : '';
    await parties.establish(org, actor, id, 'MANUAL');
    return id;
  };
  const counts = () => ({
    relationships: fake.crmRelationship.__rows.length,
    events: fake.crmRelationshipEvent.__rows.length,
    participants: fake.crmParticipant.__rows.length,
    relationshipAudit: fake.auditLog.__rows.filter((r: any) => r.entityType === 'crm_relationship').length,
    outbox: fake.stateChangeOutbox.__rows.length,
  });
  const actorOf = (userId: string, org = ORG_A) => ({ organizationId: org, userId, actorName: 'Session Name' });

  return { fake, prisma, iam, parties, service, hire, owner, party, counts, actorOf };
}

async function representation(w: Awaited<ReturnType<typeof world>>, userId?: string) {
  const agency = await w.party('COMPANY');
  const brand = await w.party('COMPANY');
  const result = await w.service.create(w.actorOf(userId ?? w.owner), {
    kind: 'REPRESENTATION',
    sides: [
      { side: 'A', partyId: agency, role: 'AGENCY' },
      { side: 'B', partyId: brand, role: 'BRAND' },
    ],
    occurredAt: AT,
  });
  return { result, agency, brand };
}

// --- 1. The act, and its four writes ------------------------------------------------

test('creating a Relationship writes the row, its event, its audit entry and its outbox row', async () => {
  const w = await world();
  const { result } = await representation(w);
  assert.equal(result.outcome, 'RECORDED');
  const c = w.counts();
  assert.deepEqual([c.relationships, c.events, c.participants, c.relationshipAudit, c.outbox], [1, 1, 2, 1, 1]);

  const audit = w.fake.auditLog.__rows.find((r: any) => r.entityType === 'crm_relationship');
  assert.equal(audit.action, 'relationship.created');
  assert.equal(audit.userId, w.owner, 'the actual human actor');
  assert.equal(audit.metadata.actorName, 'Session Name');
  assert.equal(audit.metadata.kind, 'REPRESENTATION');
  assert.equal(audit.metadata.toState, 'ACTIVE');
  assert.equal(audit.metadata.sequence, 1);

  const outbox = w.fake.stateChangeOutbox.__rows[0];
  assert.equal(outbox.subjectType, 'RELATIONSHIP');
  assert.equal(outbox.domain, 'RELATIONSHIP');
  assert.equal(outbox.eventType, 'RelationshipCreated');
  assert.equal(outbox.changeType, 'CREATED');
  assert.equal(outbox.status, 'PENDING');
  assert.equal(outbox.identityId, null, 'a Relationship is not an identity');
  assert.match(outbox.stateKey, /^relationship\./);
});

test('end, reactivate and void each write all four, and the state follows the log', async () => {
  const w = await world();
  const { result } = await representation(w);
  const id = result.outcome === 'RECORDED' ? result.value.relationship.id : '';
  const actor = w.actorOf(w.owner);

  assert.equal((await w.service.end(actor, id, { reason: REASON, occurredAt: AT })).outcome, 'RECORDED');
  assert.equal((await w.service.reactivate(actor, id, { occurredAt: AT })).outcome, 'RECORDED');
  assert.equal((await w.service.void(actor, id, { reason: REASON, occurredAt: AT })).outcome, 'RECORDED');

  const c = w.counts();
  assert.deepEqual([c.events, c.relationshipAudit, c.outbox], [4, 4, 4], 'one event, one audit row and one outbox row per act');
  assert.deepEqual(
    w.fake.auditLog.__rows.filter((r: any) => r.entityType === 'crm_relationship').map((r: any) => r.action),
    ['relationship.created', 'relationship.ended', 'relationship.reactivated', 'relationship.voided'],
  );
  assert.deepEqual(
    w.fake.stateChangeOutbox.__rows.map((r: any) => r.eventType),
    ['RelationshipCreated', 'RelationshipEnded', 'RelationshipReactivated', 'RelationshipVoided'],
  );
  const ended = w.fake.auditLog.__rows.find((r: any) => r.action === 'relationship.ended');
  assert.deepEqual([ended.metadata.fromState, ended.metadata.toState], ['ACTIVE', 'ENDED']);
  assert.equal(ended.metadata.reasonRecorded, true);
  const reactivated = w.fake.auditLog.__rows.find((r: any) => r.action === 'relationship.reactivated');
  assert.equal(reactivated.metadata.reasonRecorded, false, 'resuming is not an act that says no');
});

test('a reason lives on the event; the audit row and the outbox payload never carry the words', async () => {
  const w = await world();
  const { result } = await representation(w);
  const id = result.outcome === 'RECORDED' ? result.value.relationship.id : '';
  await w.service.end(w.actorOf(w.owner), id, { reason: REASON, occurredAt: AT });

  const event = w.fake.crmRelationshipEvent.__rows.find((e: any) => e.type === 'RELATIONSHIP_ENDED');
  assert.equal(event.reason, REASON, 'the authority for the words keeps them');

  const written = JSON.stringify([
    w.fake.auditLog.__rows.filter((r: any) => r.entityType === 'crm_relationship'),
    w.fake.stateChangeOutbox.__rows,
  ]);
  assert.doesNotMatch(written, /Dana|dana@example\.com|555-0101/, 'no person, email or number reaches audit or outbox');
  assert.doesNotMatch(written, /asked us to stop/);
});

test('the outbox payload carries ids, kinds and states -- and nothing else', async () => {
  const w = await world();
  const agency = await w.party('COMPANY');
  const brand = await w.party('COMPANY');
  // A label and a description are free text somebody typed. They belong to the
  // record; a published change is read by subscribers who were never authorized for
  // them, so the payload is an allow-list, not "whatever the row had".
  const created = await w.service.create(w.actorOf(w.owner), {
    kind: 'REPRESENTATION',
    sides: [{ side: 'A', partyId: agency, role: 'AGENCY' }, { side: 'B', partyId: brand, role: 'BRAND' }],
    occurredAt: AT,
    label: 'Dana at dana@example.com',
    description: 'reachable on 555-0101',
  });
  assert.equal(created.outcome, 'RECORDED');

  const payload = w.fake.stateChangeOutbox.__rows[0].payload;
  assert.deepEqual(Object.keys(payload).sort(), ['fromState', 'kind', 'relationshipId', 'sequence', 'toState']);
  const published = JSON.stringify(w.fake.stateChangeOutbox.__rows);
  assert.doesNotMatch(published, /Dana|dana@example\.com|555-0101|reachable/);
  const audited = JSON.stringify(w.fake.auditLog.__rows.filter((r: any) => r.entityType === 'crm_relationship'));
  assert.doesNotMatch(audited, /Dana|dana@example\.com|555-0101|reachable/);
});

test('the four writes share one transaction: the service hands its client to the repository', async () => {
  const w = await world();
  const agency = await w.party('COMPANY');
  const brand = await w.party('COMPANY');
  // The in-memory double cannot roll back, so atomicity is proven structurally:
  // if the repository opened its own transaction, the relationship row and its
  // audit/outbox rows would commit independently, and a crash between them would
  // leave exactly the half-written state this discipline exists to prevent.
  const seen: { create: unknown; transition: unknown }[] = [];
  const real = w.service as unknown as { relationships: any };
  const inner = real.relationships;
  real.relationships = {
    ...inner,
    findById: inner.findById.bind(inner),
    create: (org: string, input: unknown, tx: unknown) => { seen.push({ create: tx, transition: undefined }); return inner.create(org, input, tx); },
    transition: (org: string, id: string, input: unknown, tx: unknown) => { seen.push({ create: undefined, transition: tx }); return inner.transition(org, id, input, tx); },
  };

  const created = await w.service.create(w.actorOf(w.owner), {
    kind: 'REPRESENTATION',
    sides: [{ side: 'A', partyId: agency, role: 'AGENCY' }, { side: 'B', partyId: brand, role: 'BRAND' }],
    occurredAt: AT,
  });
  assert.equal(created.outcome, 'RECORDED');
  const id = created.outcome === 'RECORDED' ? created.value.relationship.id : '';
  await w.service.end(w.actorOf(w.owner), id, { reason: 'over', occurredAt: AT });

  assert.equal(seen.length, 2);
  assert.notEqual(seen[0]!.create, undefined, 'create was given the transaction');
  assert.notEqual(seen[1]!.transition, undefined, 'the transition was given the transaction');
});

// --- 2. Nothing is left behind by a refused act ----------------------------------------

test('an unauthorized act writes nothing at all', async () => {
  const w = await world();
  const { result } = await representation(w);
  const id = result.outcome === 'RECORDED' ? result.value.relationship.id : '';
  const before = w.counts();

  const readOnly = await w.hire('READ_ONLY');
  const employee = await w.hire('EMPLOYEE');
  assert.equal((await w.service.end(w.actorOf(readOnly), id, { reason: 'x', occurredAt: AT })).outcome, 'NOT_AUTHORIZED');
  // EMPLOYEE may create and update, but ending is MANAGER and above.
  assert.equal((await w.service.end(w.actorOf(employee), id, { reason: 'x', occurredAt: AT })).outcome, 'NOT_AUTHORIZED');
  // And voiding is OWNER/ADMIN only.
  const manager = await w.hire('MANAGER');
  assert.equal((await w.service.void(w.actorOf(manager), id, { reason: 'x', occurredAt: AT })).outcome, 'NOT_AUTHORIZED');

  assert.deepEqual(w.counts(), before, 'no event, no audit row, no outbox row');
});

test('a duplicate, a refused Party and an illegal transition each leave nothing behind', async () => {
  const w = await world();
  const { result, agency, brand } = await representation(w);
  const id = result.outcome === 'RECORDED' ? result.value.relationship.id : '';
  const actor = w.actorOf(w.owner);
  const before = w.counts();

  // The same connection, again.
  const duplicate = await w.service.create(actor, {
    kind: 'REPRESENTATION',
    sides: [{ side: 'A', partyId: agency, role: 'AGENCY' }, { side: 'B', partyId: brand, role: 'BRAND' }],
    occurredAt: AT,
  });
  assert.equal(duplicate.outcome, 'DUPLICATE');

  // A Party nobody established.
  const pending = await w.parties.create(ORG_A, w.owner, { partyType: 'COMPANY' });
  const pendingId = pending.outcome === 'RECORDED' ? pending.party.id : '';
  const refused = await w.service.create(actor, {
    kind: 'SUPPLY',
    sides: [{ side: 'A', partyId: pendingId, role: 'VENDOR' }, { side: 'B', partyId: brand, role: 'BUYER' }],
    occurredAt: AT,
  });
  assert.equal(refused.outcome, 'PARTY_REFUSED');

  // Reactivating something that is already active.
  assert.equal((await w.service.reactivate(actor, id, { occurredAt: AT })).outcome, 'ILLEGAL_TRANSITION');
  // Ending with no reason.
  assert.equal((await w.service.end(actor, id, { reason: '   ', occurredAt: AT })).outcome, 'REASON_REQUIRED');

  assert.deepEqual(w.counts(), before, 'four refusals, nothing written by any of them');
});

test('a superseded Party is refused with its canonical id, and nothing is written', async () => {
  const w = await world();
  const canonical = await w.party('COMPANY');
  const superseded = await w.party('COMPANY');
  const other = await w.party('COMPANY');
  await w.fake.cognitiveIdentity.update({
    where: { id: superseded },
    data: { supersededByIdentityId: canonical, supersededAt: AT, supersededByUserId: w.owner },
  });
  const before = w.counts();

  const result = await w.service.create(w.actorOf(w.owner), {
    kind: 'REPRESENTATION',
    sides: [{ side: 'A', partyId: superseded, role: 'AGENCY' }, { side: 'B', partyId: other, role: 'BRAND' }],
    occurredAt: AT,
  });
  assert.equal(result.outcome, 'PARTY_REFUSED');
  if (result.outcome === 'PARTY_REFUSED') {
    assert.deepEqual(result.refusals, [{ partyId: superseded, refusal: 'SUPERSEDED', canonicalPartyId: canonical }]);
  }
  assert.deepEqual(w.counts(), before);
});

// --- 3. Authorization ------------------------------------------------------------------

test('every role gets exactly the acts Product approved, and no others', async () => {
  const w = await world();
  const { result } = await representation(w);
  const id = result.outcome === 'RECORDED' ? result.value.relationship.id : '';
  const agency = await w.party('COMPANY');
  const brand = await w.party('COMPANY');

  const expected: Record<string, { create: boolean; end: boolean; void: boolean }> = {
    OWNER: { create: true, end: true, void: true },
    ADMIN: { create: true, end: true, void: true },
    MANAGER: { create: true, end: true, void: false },
    EMPLOYEE: { create: true, end: false, void: false },
    READ_ONLY: { create: false, end: false, void: false },
    AI_EMPLOYEE: { create: false, end: false, void: false },
  };
  for (const [role, may] of Object.entries(expected)) {
    const userId = await w.hire(role);
    const actor = w.actorOf(userId);
    const created = await w.service.create(actor, {
      kind: 'SUPPLY',
      sides: [{ side: 'A', partyId: agency, role: 'VENDOR' }, { side: 'B', partyId: brand, role: 'BUYER' }],
      occurredAt: AT,
    });
    assert.equal(created.outcome === 'NOT_AUTHORIZED', !may.create, `${role} create`);
    // Clean up so the next role meets the same starting point.
    if (created.outcome === 'RECORDED') {
      await w.service.void(w.actorOf(w.owner), created.value.relationship.id, { reason: 'test cleanup', occurredAt: AT });
    }
    assert.equal((await w.service.end(actor, id, { reason: 'r', occurredAt: AT })).outcome === 'NOT_AUTHORIZED', !may.end, `${role} end`);
    assert.equal((await w.service.void(actor, id, { reason: 'r', occurredAt: AT })).outcome === 'NOT_AUTHORIZED', !may.void, `${role} void`);
  }
});

test('a Permission row cannot grant a Relationship act, because acts are not matrix actions', async () => {
  const w = await world();
  const { result } = await representation(w);
  const id = result.outcome === 'RECORDED' ? result.value.relationship.id : '';
  const employee = await w.hire('EMPLOYEE');
  // Every matrix action somebody might reach for, granted explicitly.
  for (const action of ['view', 'create', 'update', 'delete', 'manage']) {
    await w.fake.permission.create({
      data: { id: `p_${action}`, organizationId: ORG_A, userId: employee, resource: 'relationships', action, effect: 'ALLOW' },
    });
  }
  const before = w.counts();
  assert.equal((await w.service.end(w.actorOf(employee), id, { reason: 'r', occurredAt: AT })).outcome, 'NOT_AUTHORIZED');
  assert.equal((await w.service.void(w.actorOf(employee), id, { reason: 'r', occurredAt: AT })).outcome, 'NOT_AUTHORIZED');
  assert.deepEqual(w.counts(), before);
});

test('denying the coarse view gate closes every act', async () => {
  const w = await world();
  const manager = await w.hire('MANAGER');
  await w.fake.permission.create({
    data: { id: 'p_deny', organizationId: ORG_A, userId: manager, resource: 'relationships', action: 'view', effect: 'DENY' },
  });
  const agency = await w.party('COMPANY');
  const brand = await w.party('COMPANY');
  const created = await w.service.create(w.actorOf(manager), {
    kind: 'REPRESENTATION',
    sides: [{ side: 'A', partyId: agency, role: 'AGENCY' }, { side: 'B', partyId: brand, role: 'BRAND' }],
    occurredAt: AT,
  });
  assert.equal(created.outcome, 'NOT_AUTHORIZED');
});

test('a disabled member and a member of another organization perform nothing', async () => {
  const w = await world();
  const { result } = await representation(w);
  const id = result.outcome === 'RECORDED' ? result.value.relationship.id : '';
  const before = w.counts();

  const gone = await w.hire('OWNER');
  await w.iam.disableUser(ORG_A, gone);
  assert.equal((await w.service.end(w.actorOf(gone), id, { reason: 'r', occurredAt: AT })).outcome, 'NOT_AUTHORIZED');

  const theirs = await w.hire('OWNER', ORG_B);
  assert.equal((await w.service.end({ organizationId: ORG_B, userId: theirs }, id, { reason: 'r', occurredAt: AT })).outcome, 'NOT_FOUND');
  // And a blank actor.
  for (const actor of [{ organizationId: '', userId: 'u' }, { organizationId: ORG_A, userId: '  ' }]) {
    assert.equal((await w.service.end(actor, id, { reason: 'r', occurredAt: AT })).outcome, 'NOT_AUTHORIZED');
  }
  assert.deepEqual(w.counts(), before);
});

// --- 4. Fences ---------------------------------------------------------------------------

test('fence: the service infers nothing, invents no actor, and keeps no second grant table', () => {
  const src = readFileSync(join(__dirname, '..', 'src', 'services', 'crm-relationship.service.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  // The approved table is bound, never restated.
  assert.match(src, /crmRelationshipActPermitted/);
  assert.doesNotMatch(src, /OWNER'\s*,\s*'ADMIN|\bMANAGER_AND_ABOVE\b|ROLE_GRANTS/, 'no second grant vocabulary');
  assert.doesNotMatch(src, /actorType: 'SYSTEM'|actorType: 'AI/, 'no machine actor');
  assert.doesNotMatch(src, /\binfer|\bpredict|similarity|confidence|score/i);
  assert.doesNotMatch(src, /email|phone|displayName/i, 'no contact value is named, let alone written');
  // The clock and the actor come from the caller's session, never from here.
  assert.doesNotMatch(src, /Date\.now\(\)|new Date\(\)/);
});
