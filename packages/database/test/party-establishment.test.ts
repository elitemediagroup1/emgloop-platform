// Governed Party creation and establishment. CRM Phase Zero P0.2d.
//
// Drives the REAL PartyService, IamRepository, membership authority,
// CognitiveIdentityRepository, PartyRepository and AuditRepository against the
// in-memory Prisma double. Proves the Product grant table exactly; that `approve`
// alone establishes; that AI_EMPLOYEE can never hold identity authority; that
// Party keys are minted, never derived; that authorization comes before lookup
// so nothing can be probed; that provenance is persisted, attributable,
// idempotent and fail-closed; and that no confidence, contact value or dormant
// resolution path can establish a Party.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { PrismaClient } from '@prisma/client';

import { makeCognitivePrisma } from './helpers/cognitive-prisma-fake';
import { IamRepository, matrixAllows, IDENTITY_RESOLUTION_GRANTS } from '../src/repositories/iam.repository';
import { createCognitiveRepositories } from '../src/repositories/cognitive';
import { PartyService } from '../src/services/party.service';
import { resolveIdentity } from '../src/services/cognitive/identity-resolution';

const ORG_A = 'org_a';
const ORG_B = 'org_b';
const ROOT = new URL('../../..', import.meta.url);
const code = (p: string) =>
  readFileSync(new URL(p, ROOT), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

const ACTIONS = ['view', 'create', 'update', 'delete', 'manage', 'approve'] as const;

function world() {
  const fake: any = makeCognitivePrisma({ also: ['invitation', 'organizationMembership'] });
  const prisma = fake as PrismaClient;
  const iam = new IamRepository(prisma);
  const parties = new PartyService(prisma);
  const repos = createCognitiveRepositories(prisma);
  const people: Record<string, string> = {};
  const hire = async (org: string, role: string) => {
    const u = await iam.createUser({ organizationId: org, email: `${role.toLowerCase()}-${org}@x.io`, systemRole: role });
    await iam.activateUser(org, u.id);
    return u.id;
  };
  return { fake, prisma, iam, parties, repos, people, hire };
}

const writes = (fake: any) => JSON.stringify([fake.cognitiveIdentity.__rows, fake.auditLog.__rows]);

// ---- The grant table --------------------------------------------------------

test('identityResolution grants are exactly the Product table, and nothing falls back to READ_ONLY', () => {
  const expected: Record<string, readonly string[]> = {
    OWNER: ['view', 'create', 'update', 'approve'],
    ADMIN: ['view', 'create', 'update', 'approve'],
    MANAGER: ['view', 'create', 'update'],
    EMPLOYEE: ['view', 'create'],
    READ_ONLY: ['view'],
    AI_EMPLOYEE: [],
  };
  assert.deepEqual({ ...IDENTITY_RESOLUTION_GRANTS }, expected);
  for (const [role, granted] of Object.entries(expected)) {
    for (const action of ACTIONS) {
      assert.equal(matrixAllows(role, 'identityResolution', action), granted.includes(action), `${role} ${action}`);
    }
  }
  assert.equal(matrixAllows('SOME_FUTURE_ROLE', 'identityResolution', 'view'), false, 'an unlisted role is denied, not READ_ONLY');
  assert.equal(matrixAllows('AI_EMPLOYEE', 'customers', 'view'), true, 'AI_EMPLOYEE keeps its existing fallback elsewhere');
});

test('AI_EMPLOYEE is denied identity authority even with an explicit Permission ALLOW row', async () => {
  const w = world();
  const ai = await w.hire(ORG_A, 'AI_EMPLOYEE');
  for (const action of ACTIONS) {
    await w.fake.permission.create({ data: { organizationId: ORG_A, userId: ai, resource: 'identityResolution', action, effect: 'ALLOW' } });
    assert.equal(await w.iam.can({ organizationId: ORG_A, userId: ai, resource: 'identityResolution', action }), false, action);
  }
  const before = writes(w.fake);
  assert.equal((await w.parties.create(ORG_A, ai, { partyType: 'PERSON' })).outcome, 'NOT_AUTHORIZED');
  assert.equal(writes(w.fake), before);
});

// ---- create -------------------------------------------------------------------

test('create: roles with identityResolution:create make an unestablished Party record; others write nothing', async () => {
  const w = world();
  for (const role of ['OWNER', 'ADMIN', 'MANAGER', 'EMPLOYEE']) {
    const actor = await w.hire(ORG_A, role);
    const r = await w.parties.create(ORG_A, actor, { partyType: role === 'MANAGER' ? 'COMPANY' : 'PERSON', displayName: '  Pat Doe  ' });
    assert.equal(r.outcome, 'RECORDED', role);
    if (r.outcome !== 'RECORDED') continue;
    assert.equal(r.party.establishment.established, false, `${role}: creating never establishes`);
    const row = w.fake.cognitiveIdentity.__rows.find((x: any) => x.id === r.party.id);
    assert.equal(row.displayName, 'Pat Doe');
    assert.equal(row.establishedAt ?? null, null);
  }
  const reader = await w.hire(ORG_A, 'READ_ONLY');
  const before = writes(w.fake);
  assert.equal((await w.parties.create(ORG_A, reader, { partyType: 'PERSON' })).outcome, 'NOT_AUTHORIZED');
  assert.equal(writes(w.fake), before);
});

test('create: only PERSON and COMPANY, refused before anything is written', async () => {
  const w = world();
  const owner = await w.hire(ORG_A, 'OWNER');
  const before = writes(w.fake);
  for (const partyType of ['BUYER', 'CREATOR', 'HOUSEHOLD', 'CALL', 'person', '']) {
    assert.deepEqual(await w.parties.create(ORG_A, owner, { partyType }), { outcome: 'INVALID', reason: 'NOT_A_PARTY_TYPE' }, partyType);
  }
  assert.equal(writes(w.fake), before);
});

test('the key is minted, never derived: opaque, unique, and no input can shape it', async () => {
  const w = world();
  const owner = await w.hire(ORG_A, 'OWNER');
  const keys = new Set<string>();
  for (let i = 0; i < 5; i += 1) {
    const r = await w.parties.create(ORG_A, owner, { partyType: 'PERSON', displayName: 'pat@example.com' });
    assert.equal(r.outcome, 'RECORDED');
    const key = w.fake.cognitiveIdentity.__rows.at(-1).canonicalKey as string;
    assert.match(key, /^party:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.equal(key.includes('pat'), false);
    keys.add(key);
  }
  assert.equal(keys.size, 5);
  const svc = code('packages/database/src/services/party.service.ts');
  assert.match(svc, /canonicalKey: `party:\$\{randomUUID\(\)\}`/);
  assert.equal(/resolveOrCreate|findIdentityIdByValue|hashIdentifier|email|phone/i.test(svc), false, 'no contact-value path');
});

// ---- establish ----------------------------------------------------------------

test('establish: only identityResolution:approve establishes, and authorization comes before lookup', async () => {
  const w = world();
  const owner = await w.hire(ORG_A, 'OWNER');
  const created = await w.parties.create(ORG_A, owner, { partyType: 'COMPANY' });
  assert.equal(created.outcome, 'RECORDED');
  const id = created.outcome === 'RECORDED' ? created.party.id : '';

  for (const role of ['MANAGER', 'EMPLOYEE', 'READ_ONLY', 'AI_EMPLOYEE']) {
    const actor = await w.hire(ORG_A, role);
    const before = writes(w.fake);
    assert.equal((await w.parties.establish(ORG_A, actor, id, 'MANUAL')).outcome, 'NOT_AUTHORIZED', role);
    assert.equal((await w.parties.establish(ORG_A, actor, 'no-such-party', 'MANUAL')).outcome, 'NOT_AUTHORIZED',
      `${role}: an unknown id looks identical -- nothing to probe`);
    assert.equal(writes(w.fake), before);
  }

  const admin = await w.hire(ORG_A, 'ADMIN');
  const r = await w.parties.establish(ORG_A, admin, id, 'MANUAL');
  assert.equal(r.outcome, 'RECORDED');
  if (r.outcome === 'RECORDED') assert.deepEqual(r.party.establishment, { partyTyped: true, established: true, basis: 'MANUAL' });
  const row = w.fake.cognitiveIdentity.__rows.find((x: any) => x.id === id);
  assert.deepEqual([row.establishedByUserId, row.establishmentBasis], [admin, 'MANUAL']);
  assert.ok(row.establishedAt instanceof Date);
  const audits = w.fake.auditLog.__rows.filter((e: any) => e.action === 'party.established' && e.entityId === id);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].userId, admin);
});

test('establish is idempotent and first-writer-wins: no second record, no second audit entry', async () => {
  const w = world();
  const owner = await w.hire(ORG_A, 'OWNER');
  const admin = await w.hire(ORG_A, 'ADMIN');
  const created = await w.parties.create(ORG_A, owner, { partyType: 'PERSON' });
  const id = created.outcome === 'RECORDED' ? created.party.id : '';
  assert.equal((await w.parties.establish(ORG_A, owner, id, 'EXPLICIT_LINK')).outcome, 'RECORDED');
  const before = writes(w.fake);
  const again = await w.parties.establish(ORG_A, admin, id, 'MANUAL');
  assert.equal(again.outcome, 'ALREADY_ESTABLISHED');
  assert.equal(writes(w.fake), before);
  assert.equal(w.fake.cognitiveIdentity.__rows.find((x: any) => x.id === id).establishedByUserId, owner);
  // The conditional write itself refuses a second establishment.
  assert.equal(await w.repos.identities.recordEstablishment(ORG_A, id, { establishedByUserId: admin, basis: 'MANUAL', at: new Date() }), null);
});

test('establish refuses ungoverned bases, other organizations, non-Party records and archived records', async () => {
  const w = world();
  const owner = await w.hire(ORG_A, 'OWNER');
  const ownerB = await w.hire(ORG_B, 'OWNER');
  const created = await w.parties.create(ORG_A, owner, { partyType: 'PERSON' });
  const id = created.outcome === 'RECORDED' ? created.party.id : '';
  const call = await w.repos.identities.create(ORG_A, { entityType: 'CALL', canonicalKey: 'call-1' });
  const before = writes(w.fake);
  for (const basis of ['AUTHENTICATED', 'VERIFIED_EMAIL', 'VERIFIED_PHONE', 'SESSION_CONTINUITY', 'PSEUDONYMOUS', 'HOUSEHOLD', 'OTHER', '']) {
    assert.deepEqual(await w.parties.establish(ORG_A, owner, id, basis), { outcome: 'INVALID', reason: 'NOT_A_GOVERNED_BASIS' }, basis);
  }
  assert.equal((await w.parties.establish(ORG_B, ownerB, id, 'MANUAL')).outcome, 'NOT_FOUND', 'another tenant sees nothing');
  assert.equal((await w.parties.establish(ORG_A, owner, call.id, 'MANUAL')).outcome, 'NOT_FOUND');
  assert.equal(writes(w.fake), before);

  await w.repos.identities.archive(ORG_A, id);
  assert.deepEqual(await w.parties.establish(ORG_A, owner, id, 'MANUAL'), { outcome: 'INVALID', reason: 'ARCHIVED' });
});

test('if the establishing User row is deleted, the Party reads as not established -- never an invented actor', async () => {
  const w = world();
  const owner = await w.hire(ORG_A, 'OWNER');
  const created = await w.parties.create(ORG_A, owner, { partyType: 'PERSON' });
  const id = created.outcome === 'RECORDED' ? created.party.id : '';
  await w.parties.establish(ORG_A, owner, id, 'MANUAL');
  assert.equal((await w.repos.parties.findParty(ORG_A, id))?.establishment.established, true);
  w.fake.cognitiveIdentity.__rows.find((x: any) => x.id === id).establishedByUserId = null; // ON DELETE SET NULL
  assert.equal((await w.repos.parties.findParty(ORG_A, id))?.establishment.established, false);
});

test('the dormant resolver still establishes nothing; only an approver can establish a subject it created', async () => {
  const w = world();
  const owner = await w.hire(ORG_A, 'OWNER');
  const subject = await resolveIdentity(ORG_A, { entityType: 'PERSON', sessionId: 'sess-9' }, w.repos, 'evt-9');
  assert.equal((await w.repos.parties.findParty(ORG_A, subject.identityId))?.establishment.established, false);
  const r = await w.parties.establish(ORG_A, owner, subject.identityId, 'MANUAL');
  assert.equal(r.outcome, 'RECORDED', 'a governed human act, not the session, establishes it');
});

// ---- Boundaries in source ---------------------------------------------------------

test('one writer of establishment provenance, one caller of it, and no writer of supersession yet', () => {
  const files = [
    'packages/database/src/repositories/cognitive/identity.repository.ts',
    'packages/database/src/repositories/cognitive/party.repository.ts',
    'packages/database/src/repositories/cognitive/index.ts',
    'packages/database/src/services/party.service.ts',
    'packages/database/src/services/cognitive/identity-resolution.ts',
    'packages/database/src/services/cognitive/cognitive-event-processor.ts',
    'packages/database/src/repositories/iam.repository.ts',
    'packages/database/src/repositories/membership.repository.ts',
  ];
  const writersOfEstablished = files.filter((f) => /establishedAt:\s*input\.at|establishmentBasis:\s*input\.basis/.test(code(f)));
  assert.deepEqual(writersOfEstablished, ['packages/database/src/repositories/cognitive/identity.repository.ts']);
  const callers = files.filter((f) => /\.recordEstablishment\(/.test(code(f)));
  assert.deepEqual(callers, ['packages/database/src/services/party.service.ts']);
  for (const f of files) {
    // A write is a Prisma `data` payload naming a supersession column.
    assert.equal(/data:\s*\{[^}]*superseded(ByIdentityId|At|ByUserId)/.test(code(f)), false, `${f} writes no supersession`);
  }
  const svc = code('packages/database/src/services/party.service.ts');
  assert.equal(/confidence/i.test(svc), false);
  const establishBody = svc.match(/async establish\([\s\S]*?\n {2}\}/)?.[0] ?? '';
  assert.ok(establishBody.indexOf('canEstablish') < establishBody.indexOf('findParty'), 'authorize before lookup');
});

test('the migration is additive, ASCII, and constrains establishment to a governed, all-or-nothing Party fact', () => {
  const sql = readFileSync(
    new URL('packages/database/prisma/migrations/20260915000000_crm_p0_2d_party_provenance/migration.sql', ROOT),
    'utf8',
  );
  assert.equal(/[^\x00-\x7F]/.test(sql), false);
  const body = sql.replace(/^\s*--.*$/gm, ' ').replace(/ON (UPDATE|DELETE) (CASCADE|SET NULL)/g, ' ');
  assert.equal(/\b(DROP|DELETE|TRUNCATE|UPDATE|RENAME)\b/i.test(body), false);
  assert.equal(/CREATE UNIQUE INDEX/i.test(body), false, 'no new uniqueness (Option D)');
  assert.match(body, /"establishedAt" IS NULL\) = \("establishmentBasis" IS NULL\)/);
  assert.match(body, /"entityType" IN \('PERSON', 'COMPANY'\)/);
});
