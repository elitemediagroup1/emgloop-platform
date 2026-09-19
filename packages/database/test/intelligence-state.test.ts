// The Read Intelligence State reader, over the real services' rows: ids, states, times and counts
// come back; titles, names, entities, addresses, keys and messages never do; and nothing is written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { makeCognitivePrisma } from './helpers/cognitive-prisma-fake';
import { IamRepository } from '../src/repositories/iam.repository';
import { WorkGraphRepository } from '../src/repositories/work-state';
import { IntelligenceStateRepository, CALLGRID_CASE_PRODUCER } from '../src/repositories/intelligence-state.repository';
import { readOnlyClient } from '../src/repositories/read-only-client';
import { DecisionEngine } from '../src/services/decision/decision-engine';
import { PartyService } from '../src/services/party.service';
import { CrmRelationshipService } from '../src/services/crm-relationship.service';
import { StateChangePublisher } from '../src/services/cognitive';
import { declareIntelligenceSubscriptions } from '../src/services/intelligence';

const key = (address: string) => createHash('sha256').update(address).digest('hex');
const SENSITIVE = ['Acme Insurance Group', 'Buyer Acme', 'dana@acme.test', 'Dana Diaz', 'Glow Cosmetics', 'Renewal terms', 'Please call me', key('dana@acme.test'), 'buyer-7781'];

async function world() {
  const fake: any = makeCognitivePrisma({
    also: ['organization', 'invitation', 'organizationMembership', 'customer', 'customerPartyLink', 'crmRelationship', 'crmRelationshipEvent', 'crmParticipant'],
  });
  const prisma = fake as PrismaClient;
  await fake.organization.create({ data: { id: 'org_a', name: 'A', slug: 'org-a' } });
  await fake.organization.create({ data: { id: 'org_b', name: 'B', slug: 'org-b' } });
  const iam = new IamRepository(prisma);
  const member = async (org: string, name: string) => {
    const u = await iam.createUser({ organizationId: org, email: `${name}@loop.test`, name, systemRole: 'OWNER' });
    await iam.activateUser(org, u.id);
    return { organizationId: org, userId: u.id };
  };
  return { fake, prisma, iam, member, engine: new DecisionEngine(prisma), graph: new WorkGraphRepository(prisma) };
}

const situation = (recurrenceKey: string, title: string, detectionKey: string, at: Date, entity: { entityType: string; entityId?: string; entityName: string }) => ({
  producer: CALLGRID_CASE_PRODUCER,
  recurrenceKey,
  detectionKey,
  detectedAt: at,
  title,
  summary: `${entity.entityName} fell sharply`,
  severity: 'HIGH' as const,
  sourceReference: entity.entityId ?? null,
  evidence: [{ source: 'summary-report', metricKey: 'billableCalls', window: 'day', ruleId: recurrenceKey.split('::')[0], ruleVersion: 'v1', observedAt: at, ...entity }],
});

test('it reports the CallGrid Cases and their sightings as ids, rules, states, times and counts', async () => {
  const w = await world();
  const matt = await w.member('org_a', 'matt');
  // One Case keyed by a provider id, one keyed by a NAME (the scoring fallback), each seen once.
  const byId = await w.engine.create('org_a', situation('volume-drop::buyer-7781', 'Buyer Acme volume fell 40%', 'daily:2026-09-19', new Date('2026-09-19T18:25:10Z'), { entityType: 'buyer', entityId: 'buyer-7781', entityName: 'Buyer Acme' }));
  const byName = await w.engine.create('org_a', situation('revenue-concentration::Acme Insurance Group', 'Acme Insurance Group is 60% of revenue', 'daily:2026-09-19', new Date('2026-09-19T18:25:11Z'), { entityType: 'buyer', entityName: 'Acme Insurance Group' }));
  // The same situation again on the same day records nothing; an assignment is a human act.
  await w.engine.create('org_a', situation('volume-drop::buyer-7781', 'Buyer Acme volume fell 41%', 'daily:2026-09-19', new Date('2026-09-19T18:40:00Z'), { entityType: 'buyer', entityId: 'buyer-7781', entityName: 'Buyer Acme' }));
  await w.engine.assign('org_a', byId.decision.id, { assigneeUserId: matt.userId, note: 'Please call me about this', actor: { type: 'HUMAN', userId: matt.userId, source: 'test' } } as never);
  // Another organization's Case never appears.
  await w.engine.create('org_b', situation('volume-drop::buyer-9', 'Org B buyer', 'daily:2026-09-19', new Date('2026-09-19T18:25:12Z'), { entityType: 'buyer', entityId: 'buyer-9', entityName: 'Org B Buyer' }));

  const before = JSON.stringify(Object.fromEntries(Object.entries(w.fake).filter(([k]) => !k.startsWith('$')).map(([k, v]: [string, any]) => [k, v.__rows])));
  const state = await new IntelligenceStateRepository(readOnlyClient(w.prisma)).read('org_a', new Date('2025-12-31T00:00:00Z'));
  const after = JSON.stringify(Object.fromEntries(Object.entries(w.fake).filter(([k]) => !k.startsWith('$')).map(([k, v]: [string, any]) => [k, v.__rows])));
  assert.equal(after, before, 'the read changed no row in any table');

  assert.deepEqual(state.cases.rows.map((c) => [c.id, c.rule, c.entityType, c.state, c.severity, c.timesSeen, c.humanActs]), [
    [byId.decision.id, 'volume-drop', 'buyer', 'ASSIGNED', 'HIGH', 1, 1],
    [byName.decision.id, 'revenue-concentration', 'buyer', 'NEEDS_REVIEW', 'HIGH', 1, 0],
  ]);
  assert.ok(state.cases.rows.every((c) => c.organizationId === 'org_a'));
  assert.deepEqual(state.cases.rows[0]!.sightings.map((s) => [s.type, s.actorType, s.detectionKey]), [['SITUATION_DETECTED', 'SYSTEM', 'daily:2026-09-19'], ['ASSIGNED', 'HUMAN', null]]);
  assert.deepEqual(
    [...state.caseLogSince].sort((a, b) => a.type.localeCompare(b.type)).map((g) => [g.type, g.actorType, g.count]),
    [['ASSIGNED', 'HUMAN', 1], ['SITUATION_DETECTED', 'SYSTEM', 2]],
  );
  assert.deepEqual(state.duplicates.groups, [], 'no two Cases share a rule and entity');
  assert.equal(state.writesSince.casesCreated, 2);
  assert.equal(state.writesSince.draftsSent, 0);

  // Nothing that could carry a name, an entity, an address, a key or a message leaves the reader.
  const text = JSON.stringify(state);
  for (const secret of SENSITIVE) assert.equal(text.includes(secret), false, `${secret} must not leave the reader`);
});

test('duplicates are found by rule and entity, both ways, and reported by Case id only', async () => {
  const w = await world();
  const at = new Date('2026-09-19T18:25:00Z');
  // The same buyer keyed once by id and once by name: different keys, the same provider entity.
  const a = await w.engine.create('org_a', situation('volume-drop::buyer-7781', 't1', 'daily:2026-09-19', at, { entityType: 'buyer', entityId: 'buyer-7781', entityName: 'Buyer Acme' }));
  const b = await w.engine.create('org_a', { ...situation('volume-drop::Buyer Acme', 't2', 'daily:2026-09-19', at, { entityType: 'buyer', entityName: 'Buyer Acme' }), sourceReference: 'buyer-7781' });
  const state = await new IntelligenceStateRepository(readOnlyClient(w.prisma)).read('org_a', new Date('2025-12-31T00:00:00Z'));
  assert.deepEqual(state.duplicates.groups, [{ basis: 'RULE_AND_ENTITY_REFERENCE', rule: 'volume-drop', caseIds: [a.decision.id, b.decision.id] }]);
  assert.equal(JSON.stringify(state).includes('Buyer Acme'), false);
});

test('outbox, creator eligibility, deliveries and subscriptions are counted, and a qualifying event is recognised', async () => {
  const w = await world();
  const matt = await w.member('org_a', 'matt');
  const parties = new PartyService(w.prisma);
  const relationships = new CrmRelationshipService(w.prisma);
  const establish = async (type: 'PERSON' | 'COMPANY', name: string) => {
    const made = await parties.create('org_a', matt.userId, { partyType: type, displayName: name });
    const id = made.outcome === 'RECORDED' ? made.party.id : '';
    await parties.establish('org_a', matt.userId, id, 'MANUAL');
    return id;
  };
  const actor = { organizationId: 'org_a', userId: matt.userId, actorName: 'Matt' };
  const brand = await establish('COMPANY', 'Glow Cosmetics');
  await relationships.create(actor, { kind: 'CLIENT', sides: [{ side: 'COUNTERPARTY', partyId: brand, role: 'BRAND' }], occurredAt: new Date('2026-09-01T00:00:00Z') } as never);
  const creator = await establish('PERSON', 'Dana Diaz');
  await relationships.create(actor, { kind: 'TALENT_REPRESENTATION', sides: [{ side: 'COUNTERPARTY', partyId: creator, role: 'CREATOR' }], occurredAt: new Date('2026-09-02T00:00:00Z') } as never);
  await declareIntelligenceSubscriptions(w.prisma, 'org_a', { apply: true });

  const reader = new IntelligenceStateRepository(readOnlyClient(w.prisma));
  const waiting = await reader.read('org_a', new Date('2025-12-31T00:00:00Z'));
  assert.equal(waiting.creator.relationshipEvents, 2);
  assert.equal(waiting.creator.qualifying, 1, 'the representation becoming ACTIVE is what the review acts on');
  assert.deepEqual(waiting.creator.qualifyingByStatus, { PENDING: 1 });
  assert.deepEqual([...waiting.creator.crmRelationships].map((r) => [r.kind, r.state, r.count]).sort(), [['CLIENT', 'ACTIVE', 1], ['TALENT_REPRESENTATION', 'ACTIVE', 1]]);
  assert.deepEqual(waiting.subscriptions.map((s) => [s.subscriberKey, s.handler, s.domain, s.stateKeyPattern, s.status]), [
    ['creator-onboarding-review:relationships', 'creator-onboarding-review', 'RELATIONSHIP', 'relationship.*', 'ACTIVE'],
    ['creator-onboarding-review:creator-hub', 'creator-onboarding-review', 'CREATOR', 'creator.*', 'ACTIVE'],
  ]);
  assert.ok(waiting.outbox.oldestPending, 'events are waiting');

  await new StateChangePublisher(w.prisma, {}).run('org_a', { now: new Date('2026-09-20T00:00:00Z') } as never);
  const drained = await reader.read('org_a', new Date('2025-12-31T00:00:00Z'));
  assert.deepEqual(drained.creator.qualifyingByStatus, { PUBLISHED: 1 });
  assert.deepEqual(drained.deliveries.map((d) => [d.subscriberKey, d.status, d.count]), [['creator-onboarding-review', 'SUCCEEDED', 2]]);
  assert.equal(drained.creator.reviewCases, 1, 'the review recorded its Case');
  // The review's own new Case is an event too, waiting for the next pass; the relationship events are done.
  assert.deepEqual(
    drained.outbox.groups.filter((g) => g.status !== 'PUBLISHED').map((g) => [g.domain, g.status]),
    [['OPERATIONAL', 'PENDING']],
  );
  for (const secret of ['Glow Cosmetics', 'Dana Diaz']) assert.equal(JSON.stringify(drained).includes(secret), false);
});

test('per member: attendee-key coverage and identity suggestions are counts, and keys never leave the reader', async () => {
  const w = await world();
  const matt = await w.member('org_a', 'matt');
  const charlie = await w.member('org_a', 'charlie');
  const at = new Date('2026-09-19T18:00:00Z');
  const event = (eventId: string, over: Record<string, unknown>) =>
    ({ provider: 'GOOGLE', eventId, startsAt: at, endsAt: at, status: 'CONFIRMED', attendanceKnown: true, attendeeCount: 2, observedAt: at, ...over }) as never;
  await w.graph.upsertEvent(matt, event('e1', { attendeeHashes: [key('dana@acme.test'), key('lee@x.test')] }));
  await w.graph.upsertEvent(matt, event('e2', { attendeeHashes: [] }));
  await w.graph.upsertEvent(matt, event('e3', { attendanceKnown: false }));
  await w.graph.upsertEvent(charlie, event('e4', { attendeeHashes: [key('kim@y.test')] }));
  await w.fake.intelligenceHypothesis.create({ data: { organizationId: 'org_a', privateToUserId: matt.userId, hypothesisType: 'IDENTITY_MATCH', title: 'x', status: 'REJECTED', generatedBy: 'DETERMINISTIC_RULE' } });

  const state = await new IntelligenceStateRepository(readOnlyClient(w.prisma)).read('org_a', new Date('2025-12-31T00:00:00Z'));
  const byUser = new Map(state.employees.map((e) => [e.userId, e]));
  assert.deepEqual(
    [matt, charlie].map((p) => {
      const e = byUser.get(p.userId)!;
      return [e.events, e.eventsAttendanceKnown, e.eventsWithAttendeeKeys, e.attendeeKeys, e.suggestions.REJECTED];
    }),
    [
      [3, 2, 1, 2, 1],
      [1, 1, 1, 1, 0],
    ],
  );
  const text = JSON.stringify(state);
  for (const k of [key('dana@acme.test'), key('lee@x.test'), key('kim@y.test')]) assert.equal(text.includes(k), false, 'an attendee key never leaves the reader');
});
