// The CRM Contact Point authority against a REAL Postgres (PD-F-05, Product 2026-10-06).
// OPT-IN AND LOCAL ONLY: LOOP_TEST_POSTGRES_URL.
//
// Proves:
//   - attachment: a point attaches only to an established, current Party of this organization,
//     with a classification that fits its type;
//   - the database CHECKs refuse what the service would never write;
//   - uniqueness: one current point per (Party, kind, value), released by retirement;
//   - grants and visibility: the approved matrix holds for every act and every role; READ_ONLY
//     sees no value and AI_EMPLOYEE nothing;
//   - exact matching: only exact keyed-hash matching inside one organization, every outcome;
//   - atomicity: a refused or failed act leaves no row, event, audit or outbox entry;
//   - concurrency: two racing acts cannot both apply;
//   - privacy: no value or hash reaches an audit row, an outbox payload, an event or the console;
//   - not identity: nothing writes identity evidence or a Party.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { projectCrmContactPointState } from '@emgloop/shared';

import { CrmContactPointService } from '../src/services/crm-contact-point.service';
import { crmContactPointValueHash } from '../src/repositories/crm-contact-point.repository';
import { AuditRepository } from '../src/repositories/audit.repository';

const LOCAL = (url: string) => /^postgres(ql)?:\/\/[^@]*@(localhost|127\.0\.0\.1)(:\d+)?\//.test(url);
const URL = process.env.LOOP_TEST_POSTGRES_URL ?? '';
const skip = !URL ? 'LOOP_TEST_POSTGRES_URL is not set' : !LOCAL(URL) ? 'refusing a non-local database' : false;

const ROLES = ['OWNER', 'ADMIN', 'MANAGER', 'EMPLOYEE', 'READ_ONLY', 'AI_EMPLOYEE'] as const;
type Role = (typeof ROLES)[number];

async function tenant(prisma: PrismaClient, label: string) {
  const organizationId = `0ccp_${label}_${randomUUID()}`;
  await prisma.organization.create({ data: { id: organizationId, name: `CCP ${label}`, slug: organizationId } });
  const users = {} as Record<Role, string>;
  for (const role of ROLES) {
    const id = `user_ccp_${role.toLowerCase()}_${randomUUID()}`;
    await prisma.user.create({ data: { id, organizationId, email: `${id}@example.test`, name: `${role} person`, status: 'ACTIVE', metadata: { systemRole: role } } });
    await prisma.organizationMembership.create({ data: { organizationId, userId: id, systemRole: role, status: 'ACTIVE', effectiveFrom: new Date('2026-01-01T00:00:00Z') } });
    users[role] = id;
  }
  const actor = (role: Role) => ({ organizationId, userId: users[role] });
  return { organizationId, users, actor };
}

async function party(
  prisma: PrismaClient,
  organizationId: string,
  type: 'PERSON' | 'COMPANY',
  opts: { established?: boolean; archived?: boolean; displayName?: string } = {},
): Promise<string> {
  // A governed establishment names the authorized person who made it (OWNER here).
  const owner = await prisma.organizationMembership.findFirstOrThrow({ where: { organizationId, systemRole: 'OWNER' } });
  const row = await prisma.cognitiveIdentity.create({
    data: {
      organizationId,
      entityType: type,
      canonicalKey: `party:${randomUUID()}`,
      displayName: opts.displayName ?? `${type} record`,
      status: opts.archived ? 'ARCHIVED' : 'KNOWN',
      ...(opts.established === false ? {} : { establishedAt: new Date('2026-09-01T00:00:00Z'), establishmentBasis: 'MANUAL', establishedByUserId: owner.userId }),
    },
  });
  return row.id;
}

/** Every text a privacy fence must keep clean, across the tables a value could leak into. */
async function leakSurfaces(prisma: PrismaClient, organizationId: string): Promise<string> {
  const [audit, outbox, events] = await Promise.all([
    prisma.auditLog.findMany({ where: { organizationId } }),
    prisma.stateChangeOutbox.findMany({ where: { organizationId } }),
    prisma.crmContactPointEvent.findMany({ where: { organizationId } }),
  ]);
  return JSON.stringify({ audit, outbox, events }).toLowerCase();
}

test('add: a point attaches to an established Party, normalized, with one event, one audit row, one outbox row -- and nothing identity', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  try {
    const t = await tenant(prisma, 'add');
    const person = await party(prisma, t.organizationId, 'PERSON');
    const identitiesBefore = await prisma.cognitiveIdentity.count({ where: { organizationId: t.organizationId } });
    const service = new CrmContactPointService(prisma);
    const r = await service.add(t.actor('EMPLOYEE'), { partyId: person, kind: 'EMAIL', classification: 'INDIVIDUAL', value: '  Jane.Doe@Brand.COM ', basis: 'OPERATOR_RECORDED' });
    assert.equal(r.outcome, 'RECORDED', JSON.stringify(r));
    const row = await prisma.crmContactPoint.findUniqueOrThrow({ where: { id: (r as { value: { id: string } }).value.id } });
    assert.equal(row.value, 'jane.doe@brand.com');
    assert.equal(row.valueHash, crmContactPointValueHash(t.organizationId, 'EMAIL', 'jane.doe@brand.com'));
    assert.equal(row.partyType, 'PERSON', 'the Party authority supplied the type');
    assert.equal(row.state, 'ACTIVE');
    assert.equal(row.retentionPolicy, 'crm.contact_point.retention.v1');
    assert.equal(row.lastHumanContactAt, null, 'never defaulted');
    const events = await prisma.crmContactPointEvent.findMany({ where: { contactPointId: row.id } });
    assert.deepEqual(events.map((e) => [e.sequence, e.type, e.actorType, e.actorUserId]), [[1, 'CONTACT_POINT_ADDED', 'HUMAN', t.users.EMPLOYEE]]);
    const audit = await prisma.auditLog.findMany({ where: { organizationId: t.organizationId, entityId: row.id } });
    assert.deepEqual(audit.map((a) => a.action), ['contact_point.added']);
    const outbox = await prisma.stateChangeOutbox.findMany({ where: { organizationId: t.organizationId, subjectId: row.id } });
    assert.deepEqual(outbox.map((o) => [o.subjectType, o.eventType, o.domain, o.identityId]), [['CONTACT_POINT', 'ContactPointAdded', 'COMMUNICATION', null]]);
    assert.equal(await prisma.identityEvidence.count({ where: { organizationId: t.organizationId } }), 0, 'a Contact Point is not identity evidence');
    assert.equal(await prisma.cognitiveIdentity.count({ where: { organizationId: t.organizationId } }), identitiesBefore, 'no Party is created');
  } finally {
    await prisma.$disconnect();
  }
});

test('the Party must be referenceable and the classification must fit; a refusal writes nothing at all', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  try {
    const t = await tenant(prisma, 'refuse');
    const other = await tenant(prisma, 'other');
    const canonical = await party(prisma, t.organizationId, 'COMPANY');
    const superseded = await party(prisma, t.organizationId, 'COMPANY');
    await prisma.cognitiveIdentity.update({ where: { id: superseded }, data: { supersededByIdentityId: canonical, supersededAt: new Date() } });
    const unestablished = await party(prisma, t.organizationId, 'COMPANY', { established: false });
    const archived = await party(prisma, t.organizationId, 'COMPANY', { archived: true });
    const foreign = await party(prisma, other.organizationId, 'COMPANY');
    const person = await party(prisma, t.organizationId, 'PERSON');
    const service = new CrmContactPointService(prisma);
    const add = (partyId: string, classification = 'ROLE_INBOX') =>
      service.add(t.actor('OWNER'), { partyId, kind: 'EMAIL', classification, value: 'press@brand.com', basis: 'OPERATOR_RECORDED' });

    assert.deepEqual(await add(superseded), { outcome: 'PARTY_REFUSED', refusal: 'SUPERSEDED', canonicalPartyId: canonical }, 'refused with the canonical id, never swapped');
    assert.deepEqual(await add(unestablished), { outcome: 'PARTY_REFUSED', refusal: 'NOT_ESTABLISHED' });
    assert.equal((await add(archived)).outcome, 'PARTY_REFUSED');
    assert.deepEqual(await add(foreign), { outcome: 'PARTY_REFUSED', refusal: 'NOT_FOUND' }, 'another tenant is not found');
    assert.deepEqual(await add(person), { outcome: 'INVALID', violations: ['CLASSIFICATION_NOT_PERMITTED_FOR_PARTY_TYPE'] }, 'a role inbox is never a Person');
    assert.deepEqual(await add(person, 'UNATTRIBUTED'), { outcome: 'INVALID', violations: ['CLASSIFICATION_NOT_PERMITTED_FOR_PARTY_TYPE'] });
    const company = await party(prisma, t.organizationId, 'COMPANY');
    assert.deepEqual(await add(company, 'INDIVIDUAL'), { outcome: 'INVALID', violations: ['CLASSIFICATION_NOT_PERMITTED_FOR_PARTY_TYPE'] }, 'an unnamed address never manufactures a Person');
    assert.deepEqual(
      await service.add(t.actor('OWNER'), { partyId: company, kind: 'EMAIL', classification: 'ROLE_INBOX', value: 'press@brand.com', basis: 'IMPORTED' }),
      { outcome: 'INVALID', violations: ['SOURCE_REF_REQUIRED'] },
    );
    assert.deepEqual(
      await service.add(t.actor('OWNER'), { partyId: company, kind: 'PHONE', classification: 'ROLE_INBOX', value: '555 010 2030', basis: 'OPERATOR_RECORDED' }),
      { outcome: 'INVALID', violations: ['INVALID_PHONE'] },
      'no country code is guessed',
    );
    for (const table of ['crmContactPoint', 'crmContactPointEvent', 'auditLog', 'stateChangeOutbox'] as const) {
      assert.equal(await (prisma[table] as unknown as { count: (a: unknown) => Promise<number> }).count({ where: { organizationId: t.organizationId } }), 0, `${table} untouched`);
    }
  } finally {
    await prisma.$disconnect();
  }
});

test('the database refuses what the service never writes', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  try {
    const t = await tenant(prisma, 'check');
    const company = await party(prisma, t.organizationId, 'COMPANY');
    const valid = {
      organizationId: t.organizationId,
      partyId: company,
      partyType: 'COMPANY',
      kind: 'EMAIL',
      classification: 'ROLE_INBOX',
      value: 'press@brand.com',
      valueHash: 'a'.repeat(64),
      hashKeyFingerprint: 'f',
      state: 'ACTIVE',
      currentKey: `${company}|EMAIL|${'a'.repeat(64)}`,
      basis: 'OPERATOR_RECORDED',
    };
    const bad: Record<string, Partial<typeof valid> & Record<string, unknown>> = {
      'INDIVIDUAL on a COMPANY': { classification: 'INDIVIDUAL' },
      'an unnormalized email': { value: 'Press@Brand.com' },
      'a phone without a country code': { kind: 'PHONE', value: '5550102030' },
      'an import with no source': { basis: 'IMPORTED' },
      'a source on an operator record': { sourceRef: 'import:x' },
      'a source reference holding an address': { basis: 'IMPORTED', sourceRef: 'row:press@brand.com' },
      'a retired point holding the key': { state: 'RETIRED', retiredAt: new Date() },
      'an active point without the key': { currentKey: null },
      'an erased value still present': { valueErasedAt: new Date() },
      'a legal conclusion as basis': { basis: 'LEGITIMATE_INTERESTS' },
    };
    for (const [label, patch] of Object.entries(bad)) {
      await assert.rejects(prisma.crmContactPoint.create({ data: { ...valid, ...patch } as never }), label);
    }
    const ok = await prisma.crmContactPoint.create({ data: valid });
    const event = { organizationId: t.organizationId, contactPointId: ok.id, occurredAt: new Date(), occurredAtBasis: 'LOOP_CLOCK', actorUserId: t.users.OWNER };
    await assert.rejects(prisma.crmContactPointEvent.create({ data: { ...event, sequence: 1, type: 'CONTACT_POINT_ADDED', actorType: 'SYSTEM', toState: 'ACTIVE' } }), 'a machine actor');
    await assert.rejects(prisma.crmContactPointEvent.create({ data: { ...event, sequence: 2, type: 'CONTACT_POINT_RETIRED', actorType: 'HUMAN', fromState: 'ACTIVE', toState: 'RETIRED', reason: ' ' } }), 'a retirement with no reason');
    await assert.rejects(prisma.crmContactPointEvent.create({ data: { ...event, sequence: 0, type: 'CONTACT_POINT_ADDED', actorType: 'HUMAN', toState: 'ACTIVE' } }), 'a zeroth event');
  } finally {
    await prisma.$disconnect();
  }
});

test('one current point per (Party, kind, value); the same value on another Party is allowed; retirement releases the key', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  try {
    const t = await tenant(prisma, 'unique');
    const a = await party(prisma, t.organizationId, 'COMPANY');
    const b = await party(prisma, t.organizationId, 'COMPANY');
    const service = new CrmContactPointService(prisma);
    const add = (partyId: string, value: string) => service.add(t.actor('EMPLOYEE'), { partyId, kind: 'EMAIL', classification: 'ROLE_INBOX', value, basis: 'OPERATOR_RECORDED' });
    const first = await add(a, 'pr@agency.com');
    assert.equal(first.outcome, 'RECORDED');
    assert.deepEqual(await add(a, '  PR@Agency.com'), { outcome: 'DUPLICATE' }, 'case and spacing do not make a second point');
    assert.equal((await add(b, 'pr@agency.com')).outcome, 'RECORDED', 'an agency inbox may be recorded on two Companies: a conflict for review, not a refusal');
    const firstId = (first as { value: { id: string } }).value.id;
    assert.equal((await service.retire(t.actor('MANAGER'), firstId, { reason: 'Agency no longer represents this brand' })).outcome, 'RECORDED');
    const again = await add(a, 'pr@agency.com');
    assert.equal(again.outcome, 'RECORDED', 'retirement released the key');
    const rows = await prisma.crmContactPoint.findMany({ where: { organizationId: t.organizationId, partyId: a }, orderBy: { addedAt: 'asc' } });
    assert.deepEqual(rows.map((r) => r.state), ['RETIRED', 'ACTIVE'], 'the old row is kept, never rewritten');
  } finally {
    await prisma.$disconnect();
  }
});

test('the approved grant matrix holds for every write act and every role; a refusal records nothing', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  try {
    const t = await tenant(prisma, 'grants');
    const company = await party(prisma, t.organizationId, 'COMPANY');
    const service = new CrmContactPointService(prisma);
    const owner = t.actor('OWNER');
    const expected: Record<string, readonly Role[]> = {
      add: ['OWNER', 'ADMIN', 'MANAGER', 'EMPLOYEE'],
      markUndeliverable: ['OWNER', 'ADMIN', 'MANAGER'],
      retire: ['OWNER', 'ADMIN', 'MANAGER'],
      void: ['OWNER', 'ADMIN'],
    };
    let n = 0;
    const fresh = async () => {
      n += 1;
      const r = await service.add(owner, { partyId: company, kind: 'EMAIL', classification: 'UNATTRIBUTED', value: `person${n}@brand.com`, basis: 'OPERATOR_RECORDED' });
      return (r as { value: { id: string } }).value.id;
    };
    for (const role of ROLES) {
      const auditBefore = await prisma.auditLog.count({ where: { organizationId: t.organizationId } });
      const added = await service.add(t.actor(role), { partyId: company, kind: 'EMAIL', classification: 'UNATTRIBUTED', value: `by.${role.toLowerCase()}@brand.com`, basis: 'OPERATOR_RECORDED' });
      assert.equal(added.outcome === 'RECORDED', expected.add!.includes(role), `add ${role}`);
      if (added.outcome === 'NOT_AUTHORIZED') assert.equal(await prisma.auditLog.count({ where: { organizationId: t.organizationId } }), auditBefore, `no audit for refused add ${role}`);
      for (const act of ['markUndeliverable', 'retire', 'void'] as const) {
        const id = await fresh();
        const r = await service[act](t.actor(role), id, { reason: 'Checked with the brand' });
        assert.equal(r.outcome === 'RECORDED', expected[act]!.includes(role), `${act} ${role}: ${r.outcome}`);
        if (r.outcome === 'NOT_AUTHORIZED') {
          const row = await prisma.crmContactPoint.findUniqueOrThrow({ where: { id } });
          assert.equal(row.state, 'ACTIVE', `${act} ${role} changed nothing`);
          assert.equal(await prisma.crmContactPointEvent.count({ where: { contactPointId: id } }), 1);
        }
      }
    }
    // A Permission row granting more does not widen an act: none is consulted.
    await prisma.permission.create({ data: { organizationId: t.organizationId, systemRole: 'READ_ONLY', resource: 'identityResolution', action: 'manage', effect: 'ALLOW' } as never });
    assert.equal((await service.add(t.actor('READ_ONLY'), { partyId: company, kind: 'EMAIL', classification: 'UNATTRIBUTED', value: 'x@brand.com', basis: 'OPERATOR_RECORDED' })).outcome, 'NOT_AUTHORIZED');
  } finally {
    await prisma.$disconnect();
  }
});

test('visibility: values for EMPLOYEE and above, kind and state only for READ_ONLY, nothing for AI_EMPLOYEE or another tenant', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  try {
    const t = await tenant(prisma, 'view');
    const other = await tenant(prisma, 'view_other');
    const person = await party(prisma, t.organizationId, 'PERSON');
    const service = new CrmContactPointService(prisma);
    await service.add(t.actor('OWNER'), { partyId: person, kind: 'PHONE', classification: 'INDIVIDUAL', value: '+1 (555) 010-2030', basis: 'IMPORTED', sourceRef: 'import:test:row-1' });
    for (const role of ['OWNER', 'ADMIN', 'MANAGER', 'EMPLOYEE'] as const) {
      const r = await service.listForParty(t.actor(role), person);
      assert.equal(r.outcome, 'OK');
      const [v] = (r as { value: { value: string | null; valueWithheld: string | null; verification: string }[] }).value;
      assert.equal(v?.value, '+15550102030', role);
      assert.equal(v?.valueWithheld, null);
      assert.equal(v?.verification, 'UNVERIFIED', 'never verified by being imported');
    }
    const ro = await service.listForParty(t.actor('READ_ONLY'), person);
    assert.equal(ro.outcome, 'OK');
    const [summary] = (ro as { value: Record<string, unknown>[] }).value;
    assert.equal(summary?.value, null);
    assert.equal(summary?.valueWithheld, 'NOT_PERMITTED');
    assert.deepEqual([summary?.kind, summary?.classification, summary?.state], ['PHONE', 'INDIVIDUAL', 'ACTIVE']);
    assert.ok(!JSON.stringify(ro).includes('5550102030'), 'not even a fragment of the value');
    assert.deepEqual(await service.listForParty(t.actor('AI_EMPLOYEE'), person), { outcome: 'NOT_AUTHORIZED' });
    const foreign = await service.listForParty(other.actor('OWNER'), person);
    assert.ok(foreign.outcome === 'NOT_AUTHORIZED' || (foreign.outcome === 'OK' && foreign.value.length === 0), 'another tenant sees nothing');
    assert.deepEqual(await service.listForParty({ organizationId: t.organizationId, userId: other.users.OWNER }, person), { outcome: 'NOT_AUTHORIZED' }, 'a session naming the wrong organization is refused');
    // The coarse Party-record gate is real: a DENY on identityResolution:view removes every act.
    await prisma.permission.create({ data: { organizationId: t.organizationId, userId: t.users.EMPLOYEE, resource: 'identityResolution', action: 'view', effect: 'DENY' } as never });
    assert.deepEqual(await service.listForParty(t.actor('EMPLOYEE'), person), { outcome: 'NOT_AUTHORIZED' }, 'DENY wins');
    assert.deepEqual(await service.match(t.actor('EMPLOYEE'), { kind: 'PHONE', value: '+15550102030', partyType: 'PERSON' }), { outcome: 'NOT_AUTHORIZED' });
  } finally {
    await prisma.$disconnect();
  }
});

test('lifecycle: reasons required and never a contact value; illegal moves refused; the log projects the row', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  try {
    const t = await tenant(prisma, 'life');
    const company = await party(prisma, t.organizationId, 'COMPANY');
    const service = new CrmContactPointService(prisma);
    const added = await service.add(t.actor('EMPLOYEE'), { partyId: company, kind: 'EMAIL', classification: 'ROLE_INBOX', value: 'hello@brand.com', basis: 'OPERATOR_RECORDED' });
    const id = (added as { value: { id: string } }).value.id;
    assert.deepEqual(await service.markUndeliverable(t.actor('MANAGER'), id, { reason: '  ' }), { outcome: 'REASON_REQUIRED' });
    assert.deepEqual(await service.markUndeliverable(t.actor('MANAGER'), id, { reason: 'Bounced; try other.person@brand.com' }), { outcome: 'REASON_CARRIES_CONTACT_VALUE' });
    assert.deepEqual(await service.markUndeliverable(t.actor('MANAGER'), id, { reason: 'Call +44 20 7946 0958 instead' }), { outcome: 'REASON_CARRIES_CONTACT_VALUE' });
    assert.equal(await prisma.crmContactPointEvent.count({ where: { contactPointId: id } }), 1, 'refusals append nothing');
    assert.equal((await service.markUndeliverable(t.actor('MANAGER'), id, { reason: 'Delivery failure on 2026-10-04' })).outcome, 'RECORDED');
    assert.deepEqual(await service.markUndeliverable(t.actor('MANAGER'), id, { reason: 'Again' }), { outcome: 'ILLEGAL_TRANSITION', from: 'UNDELIVERABLE' });
    assert.equal((await service.retire(t.actor('MANAGER'), id, { reason: 'Inbox closed' })).outcome, 'RECORDED');
    assert.equal((await service.void(t.actor('ADMIN'), id, { reason: 'Never belonged to this brand' })).outcome, 'RECORDED');
    assert.deepEqual(await service.retire(t.actor('OWNER'), id, { reason: 'x' }), { outcome: 'ILLEGAL_TRANSITION', from: 'VOIDED' });
    const row = await prisma.crmContactPoint.findUniqueOrThrow({ where: { id } });
    const events = await prisma.crmContactPointEvent.findMany({ where: { contactPointId: id }, orderBy: { sequence: 'asc' } });
    assert.deepEqual(projectCrmContactPointState(events), { ok: true, state: row.state, lastSequence: row.lastSequence });
    assert.equal(row.state, 'VOIDED');
    assert.equal(row.currentKey, null);
    assert.ok(row.undeliverableAt && row.retiredAt && row.voidedAt);
    assert.equal(row.value, 'hello@brand.com', 'voiding keeps the record; nothing is deleted');
    assert.deepEqual(await service.retire(t.actor('OWNER'), 'cp_missing', { reason: 'x' }), { outcome: 'NOT_FOUND' });
  } finally {
    await prisma.$disconnect();
  }
});

test('exact matching: every outcome, organization-bound, names never consulted', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  try {
    const t = await tenant(prisma, 'match');
    const other = await tenant(prisma, 'match_other');
    const service = new CrmContactPointService(prisma);
    const owner = t.actor('OWNER');
    const add = (partyId: string, value: string, classification = 'ROLE_INBOX', actor = owner) =>
      service.add(actor, { partyId, kind: 'EMAIL', classification, value, basis: 'OPERATOR_RECORDED' });
    const match = (value: string, partyType: 'PERSON' | 'COMPANY' = 'COMPANY', actor = owner) => service.match(actor, { kind: 'EMAIL', value, partyType });

    const brand = await party(prisma, t.organizationId, 'COMPANY', { displayName: 'Acme' });
    await add(brand, 'partnerships@acme.com');
    assert.deepEqual(await match('  Partnerships@ACME.com'), { outcome: 'MATCH', partyId: brand });
    assert.deepEqual(await match('partnerships@acme.com', 'PERSON'), { outcome: 'TYPE_MISMATCH' });
    assert.deepEqual(await match('nobody@acme.com'), { outcome: 'NO_MATCH' });

    const twin = await party(prisma, t.organizationId, 'COMPANY', { displayName: 'Acme' });
    assert.deepEqual(await match('info@acme.com'), { outcome: 'NO_MATCH' }, 'an identical name is not a match');
    await add(brand, 'pr@agency.com');
    await add(twin, 'pr@agency.com');
    assert.deepEqual(await match('pr@agency.com'), { outcome: 'CONFLICT' });

    const bounced = await party(prisma, t.organizationId, 'COMPANY');
    const b = await add(bounced, 'old@bounced.com');
    await service.markUndeliverable(owner, (b as { value: { id: string } }).value.id, { reason: 'Bounced' });
    assert.deepEqual(await match('old@bounced.com'), { outcome: 'INACTIVE_MATCH' }, 'a bounce is review, not a new duplicate');

    const merged = await party(prisma, t.organizationId, 'COMPANY');
    await add(merged, 'hello@merged.com');
    await prisma.cognitiveIdentity.update({ where: { id: merged }, data: { supersededByIdentityId: brand, supersededAt: new Date() } });
    assert.deepEqual(await match('hello@merged.com'), { outcome: 'PARTY_NOT_REFERENCEABLE' }, 'a superseded holder is review, never resolved forward silently');

    const foreignBrand = await party(prisma, other.organizationId, 'COMPANY');
    await add(foreignBrand, 'only@elsewhere.com', 'ROLE_INBOX', other.actor('OWNER'));
    assert.deepEqual(await match('only@elsewhere.com'), { outcome: 'NO_MATCH' }, 'no cross-organization matching');
    assert.notEqual(
      crmContactPointValueHash(t.organizationId, 'EMAIL', 'only@elsewhere.com'),
      crmContactPointValueHash(other.organizationId, 'EMAIL', 'only@elsewhere.com'),
      'hashes are organization-salted',
    );

    assert.deepEqual(await match('partnerships@acme.com', 'COMPANY', t.actor('READ_ONLY')), { outcome: 'NOT_AUTHORIZED' });
    assert.deepEqual(await match('partnerships@acme.com', 'COMPANY', t.actor('AI_EMPLOYEE')), { outcome: 'NOT_AUTHORIZED' });
    assert.deepEqual(await match('not an address'), { outcome: 'INVALID', reason: 'INVALID_EMAIL' });
  } finally {
    await prisma.$disconnect();
  }
});

test('atomic: when the audit write fails, the point and its event are not kept', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  try {
    const t = await tenant(prisma, 'atomic');
    const company = await party(prisma, t.organizationId, 'COMPANY');
    const failing = new CrmContactPointService(prisma, { audit: { record: async () => { throw new Error('audit unavailable'); } } });
    await assert.rejects(failing.add(t.actor('OWNER'), { partyId: company, kind: 'EMAIL', classification: 'ROLE_INBOX', value: 'press@brand.com', basis: 'OPERATOR_RECORDED' }), /audit unavailable/);
    assert.equal(await prisma.crmContactPoint.count({ where: { organizationId: t.organizationId } }), 0);
    assert.equal(await prisma.crmContactPointEvent.count({ where: { organizationId: t.organizationId } }), 0);
    assert.equal(await prisma.stateChangeOutbox.count({ where: { organizationId: t.organizationId } }), 0);

    const service = new CrmContactPointService(prisma);
    const added = await service.add(t.actor('OWNER'), { partyId: company, kind: 'EMAIL', classification: 'ROLE_INBOX', value: 'press@brand.com', basis: 'OPERATOR_RECORDED' });
    const id = (added as { value: { id: string } }).value.id;
    await assert.rejects(failing.retire(t.actor('OWNER'), id, { reason: 'Inbox closed' }), /audit unavailable/);
    // The audit row is written INSIDE the act's transaction: written, then a later failure, and it goes too.
    const real = new AuditRepository(prisma);
    const lateFailure = new CrmContactPointService(prisma, {
      audit: { record: async (args, tx) => { await real.record(args, tx); throw new Error('failed after audit'); } },
    });
    await assert.rejects(lateFailure.markUndeliverable(t.actor('OWNER'), id, { reason: 'Bounced' }), /failed after audit/);
    assert.equal(await prisma.auditLog.count({ where: { organizationId: t.organizationId, entityId: id, action: 'contact_point.marked_undeliverable' } }), 0, 'no audit row survives the rollback');
    const row = await prisma.crmContactPoint.findUniqueOrThrow({ where: { id } });
    assert.deepEqual([row.state, row.lastSequence, row.retiredAt], ['ACTIVE', 1, null], 'the retirement rolled back with its audit');
    assert.equal(await prisma.crmContactPointEvent.count({ where: { contactPointId: id } }), 1);
  } finally {
    await prisma.$disconnect();
  }
});

test('concurrency: two racing acts on one point cannot both apply', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  try {
    const t = await tenant(prisma, 'race');
    const company = await party(prisma, t.organizationId, 'COMPANY');
    const service = new CrmContactPointService(prisma);
    const added = await service.add(t.actor('OWNER'), { partyId: company, kind: 'EMAIL', classification: 'ROLE_INBOX', value: 'race@brand.com', basis: 'OPERATOR_RECORDED' });
    const id = (added as { value: { id: string } }).value.id;
    // Eight racers from the same ACTIVE state, so their transactions genuinely overlap.
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) =>
        i % 2 === 0
          ? service.markUndeliverable(t.actor(i % 4 === 0 ? 'OWNER' : 'ADMIN'), id, { reason: `Bounced (${i})` })
          : service.retire(t.actor(i % 4 === 1 ? 'OWNER' : 'MANAGER'), id, { reason: `Closed (${i})` }),
      ),
    );
    // A loser is told RETRY or ILLEGAL_TRANSITION by the sequence guard; it never surfaces as a crashed transaction.
    assert.ok(results.every((r) => r.status === 'fulfilled'), JSON.stringify(results.map((r) => (r.status === 'rejected' ? String(r.reason).slice(0, 120) : r.value.outcome))));
    const recorded = results.filter((r) => r.status === 'fulfilled' && r.value.outcome === 'RECORDED').length;
    const events = await prisma.crmContactPointEvent.findMany({ where: { contactPointId: id }, orderBy: { sequence: 'asc' } });
    const row = await prisma.crmContactPoint.findUniqueOrThrow({ where: { id } });
    assert.deepEqual(projectCrmContactPointState(events), { ok: true, state: row.state, lastSequence: row.lastSequence }, 'the log and the row agree after the race');
    assert.equal(events.length, 1 + recorded, 'every recorded act has exactly one event');
    assert.equal(await prisma.auditLog.count({ where: { organizationId: t.organizationId, entityId: id } }), 1 + recorded, 'and exactly one audit row');
  } finally {
    await prisma.$disconnect();
  }
});

test('privacy: no value and no hash in audit rows, outbox payloads, events or the console', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  const printed: string[] = [];
  const original = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
  try {
    const t = await tenant(prisma, 'privacy');
    const person = await party(prisma, t.organizationId, 'PERSON');
    const company = await party(prisma, t.organizationId, 'COMPANY');
    for (const k of Object.keys(original) as (keyof typeof original)[]) console[k] = (...args: unknown[]) => { printed.push(args.map(String).join(' ')); };
    const service = new CrmContactPointService(prisma);
    const values = [
      { partyId: person, kind: 'EMAIL' as const, classification: 'INDIVIDUAL', value: 'secret.person@brand.com' },
      { partyId: person, kind: 'PHONE' as const, classification: 'INDIVIDUAL', value: '+1 555 010 9876' },
      { partyId: company, kind: 'EMAIL' as const, classification: 'UNATTRIBUTED', value: 'hidden.name@brand.com' },
    ];
    const ids: string[] = [];
    for (const v of values) {
      const r = await service.add(t.actor('EMPLOYEE'), { ...v, basis: 'IMPORTED', sourceRef: 'import:privacy:row-9' });
      ids.push((r as { value: { id: string } }).value.id);
    }
    await service.markUndeliverable(t.actor('MANAGER'), ids[0]!, { reason: 'Bounced' });
    await service.retire(t.actor('MANAGER'), ids[1]!, { reason: 'Number disconnected' });
    await service.void(t.actor('OWNER'), ids[2]!, { reason: 'Wrong brand' });
    await service.match(t.actor('EMPLOYEE'), { kind: 'EMAIL', value: 'secret.person@brand.com', partyType: 'PERSON' });
    await service.listForParty(t.actor('EMPLOYEE'), person);
    await new AuditRepository(prisma).record({ organizationId: t.organizationId, action: 'test.sentinel', metadata: { ok: true } });

    const haystack = await leakSurfaces(prisma, t.organizationId);
    assert.ok(haystack.includes('test.sentinel'), 'the scan reads real rows');
    for (const fragment of ['secret.person', 'brand.com', '5550109876', '555 010', 'hidden.name']) assert.ok(!haystack.includes(fragment), `no "${fragment}" in audit, outbox or events`);
    const rows = await prisma.crmContactPoint.findMany({ where: { organizationId: t.organizationId }, select: { valueHash: true } });
    for (const { valueHash } of rows) assert.ok(!haystack.includes(valueHash), 'no value hash either');
    assert.deepEqual(printed, [], 'the authority prints nothing');
  } finally {
    Object.assign(console, original);
    await prisma.$disconnect();
  }
});
