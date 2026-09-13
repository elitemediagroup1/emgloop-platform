// Governed Customer -> Party links. CRM Phase Zero P0.2e.
//
// Drives the REAL CustomerPartyLinkService, PartyService, IamRepository with
// membership authority, PartyRepository and AuditRepository against the in-memory
// Prisma double (which enforces the one-active-link uniqueness the way Postgres
// does). Proves each locked Product rule: approve for link and reversal; an
// established target; no implicit establishment; no authority from legacy Customer
// data; history kept with no silent relinking; cross-organization links fail
// closed; no automatic linking; and no side effects anywhere else.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { PrismaClient } from '@prisma/client';

import { makeCognitivePrisma } from './helpers/cognitive-prisma-fake';
import { IamRepository } from '../src/repositories/iam.repository';
import { PartyService } from '../src/services/party.service';
import { CustomerPartyLinkService } from '../src/services/customer-party-link.service';

const ORG_A = 'org_a';
const ORG_B = 'org_b';
const ROOT = new URL('../../..', import.meta.url);
const ROOT_PATH = ROOT.pathname;
const code = (p: string) =>
  readFileSync(new URL(p, ROOT), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

async function world() {
  const fake: any = makeCognitivePrisma({ also: ['invitation', 'organizationMembership', 'customer', 'customerPartyLink'] });
  const prisma = fake as PrismaClient;
  const iam = new IamRepository(prisma);
  const parties = new PartyService(prisma);
  const links = new CustomerPartyLinkService(prisma);
  const hire = async (org: string, role: string) => {
    const u = await iam.createUser({ organizationId: org, email: `${role.toLowerCase()}-${org}@x.io`, systemRole: role });
    await iam.activateUser(org, u.id);
    return u.id;
  };
  const owner = await hire(ORG_A, 'OWNER');
  const established = async (org = ORG_A, actor = owner) => {
    const c = await parties.create(org, actor, { partyType: 'PERSON' });
    assert.equal(c.outcome, 'RECORDED');
    const id = c.outcome === 'RECORDED' ? c.party.id : '';
    assert.equal((await parties.establish(org, actor, id, 'MANUAL')).outcome, 'RECORDED');
    return id;
  };
  const customer = async (org = ORG_A, fields: Record<string, unknown> = {}) =>
    (await fake.customer.create({ data: { organizationId: org, email: 'pat@example.com', phone: '5550100', firstName: 'Pat', ...fields } })).id as string;
  return { fake, prisma, iam, parties, links, hire, owner, established, customer };
}

const snapshot = (fake: any) =>
  JSON.stringify([fake.customerPartyLink.__rows, fake.cognitiveIdentity.__rows, fake.auditLog.__rows, fake.customer.__rows]);

// ---- Rules 1-2: approve ------------------------------------------------------------

test('a governed link succeeds for identityResolution:approve and records its provenance', async () => {
  const w = await world();
  const partyId = await w.established();
  const customerId = await w.customer();
  const admin = await w.hire(ORG_A, 'ADMIN');
  const r = await w.links.link(ORG_A, admin, { customerId, partyId });
  assert.equal(r.outcome, 'LINKED');
  const row = w.fake.customerPartyLink.__rows[0];
  assert.deepEqual(
    [row.organizationId, row.customerId, row.partyId, row.basis, row.linkedByUserId, row.activeCustomerId, row.reversedAt],
    [ORG_A, customerId, partyId, 'MANUAL', admin, customerId, null],
  );
  assert.ok(row.linkedAt instanceof Date);
  const audit = w.fake.auditLog.__rows.filter((e: any) => e.action === 'customer.party_linked');
  assert.equal(audit.length, 1);
  assert.deepEqual([audit[0].userId, audit[0].entityId, audit[0].metadata.partyId], [admin, customerId, partyId]);
});

test('link and reversal both refuse every role without approve -- and cannot be used to probe', async () => {
  const w = await world();
  const partyId = await w.established();
  const customerId = await w.customer();
  assert.equal((await w.links.link(ORG_A, w.owner, { customerId, partyId })).outcome, 'LINKED');
  for (const role of ['MANAGER', 'EMPLOYEE', 'READ_ONLY', 'AI_EMPLOYEE']) {
    const actor = await w.hire(ORG_A, role);
    const before = snapshot(w.fake);
    assert.equal((await w.links.link(ORG_A, actor, { customerId, partyId })).outcome, 'NOT_AUTHORIZED', role);
    assert.equal((await w.links.link(ORG_A, actor, { customerId: 'ghost', partyId: 'ghost' })).outcome, 'NOT_AUTHORIZED', `${role}: identical for unknown ids`);
    assert.equal((await w.links.reverse(ORG_A, actor, { customerId, reason: 'no' })).outcome, 'NOT_AUTHORIZED', role);
    assert.equal(await w.links.history(ORG_A, actor, customerId) === null, role === 'AI_EMPLOYEE', `${role} view per grants`);
    assert.equal(snapshot(w.fake), before);
  }
});

// ---- Rules 3-4: established target, never implicit establishment --------------------

test('the target Party must already be established, and linking never establishes it', async () => {
  const w = await world();
  const created = await w.parties.create(ORG_A, w.owner, { partyType: 'COMPANY' });
  const partyId = created.outcome === 'RECORDED' ? created.party.id : '';
  const customerId = await w.customer();
  const before = snapshot(w.fake);
  assert.equal((await w.links.link(ORG_A, w.owner, { customerId, partyId })).outcome, 'PARTY_NOT_ESTABLISHED');
  assert.equal(snapshot(w.fake), before, 'no link, no establishment, no audit');

  const partyRow = w.fake.cognitiveIdentity.__rows.find((x: any) => x.id === partyId);
  assert.equal(partyRow.establishedAt ?? null, null);

  // A non-Party identity row is not a target at all.
  const call = await w.fake.cognitiveIdentity.create({ data: { organizationId: ORG_A, entityType: 'CALL', canonicalKey: 'c1' } });
  assert.equal((await w.links.link(ORG_A, w.owner, { customerId, partyId: call.id })).outcome, 'NOT_FOUND');
});

test('linking to an established Party writes nothing to the Party', async () => {
  const w = await world();
  const partyId = await w.established();
  const customerId = await w.customer();
  const partyBefore = JSON.stringify(w.fake.cognitiveIdentity.__rows);
  await w.links.link(ORG_A, w.owner, { customerId, partyId });
  assert.equal(JSON.stringify(w.fake.cognitiveIdentity.__rows), partyBefore);
});

test('superseded Parties and merged-away Customers are refused', async () => {
  const w = await world();
  const partyId = await w.established();
  const customerId = await w.customer();
  w.fake.cognitiveIdentity.__rows.find((x: any) => x.id === partyId).supersededByIdentityId = 'someone-else';
  assert.equal((await w.links.link(ORG_A, w.owner, { customerId, partyId })).outcome, 'PARTY_SUPERSEDED');
  const live = await w.established();
  const merged = await w.customer(ORG_A, { metadata: { mergedInto: customerId } });
  assert.equal((await w.links.link(ORG_A, w.owner, { customerId: merged, partyId: live })).outcome, 'CUSTOMER_MERGED');
  assert.equal(w.fake.customerPartyLink.__rows.length, 0);
});

// ---- Rules 5 & 8: no authority from Customer data, no automatic linking ------------

test('same email, same phone or same name alone links nothing -- there is no automatic path at all', async () => {
  const w = await world();
  await w.established();
  const c1 = await w.customer(ORG_A, { email: 'pat@example.com', phone: '5550100', firstName: 'Pat' });
  const c2 = await w.customer(ORG_A, { email: 'pat@example.com', phone: '5550100', firstName: 'Pat' });
  void c1; void c2;
  assert.equal(w.fake.customerPartyLink.__rows.length, 0, 'creating matching records links nothing');

  for (const file of [
    'packages/database/src/services/customer-party-link.service.ts',
    'packages/database/src/repositories/customer-party-link.repository.ts',
  ]) {
    const src = code(file);
    assert.equal(/\b(email|phone|firstName|lastName|externalId|displayName|hashIdentifier|findIdentityIdByValue|resolveIdentity|resolveOrCreate|confidence|similar)/i.test(src), false, `${file} reads no identity-like Customer data`);
  }
  const repo = code('packages/database/src/repositories/customer-party-link.repository.ts');
  assert.match(repo, /select: \{ id: true, metadata: true \}/, 'the Customer read is the id and the merge marker only');
});

test('ingestion, webhook and sync routes cannot reach linking', () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      if (f === 'node_modules' || f === '.next') return [];
      return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(f) ? [p] : [];
    });
  const surfaces = [
    join(ROOT_PATH, 'packages/database/src/services/ingestion.service.ts'),
    ...walk(join(ROOT_PATH, 'apps/web/src/app/api')),
    ...walk(join(ROOT_PATH, 'apps/web/src')),
  ];
  for (const file of surfaces) {
    const src = readFileSync(file, 'utf8');
    assert.equal(/CustomerPartyLink|customerPartyLink|\.link\(\s*ORG|party_linked/.test(src), false, `${file.slice(ROOT_PATH.length)} must not reach linking`);
  }
});

// ---- Rule 6: history, no silent relinking ------------------------------------------

test('no silent relinking: a different Party is refused while a link is active; the same one is idempotent', async () => {
  const w = await world();
  const p1 = await w.established();
  const p2 = await w.established();
  const customerId = await w.customer();
  assert.equal((await w.links.link(ORG_A, w.owner, { customerId, partyId: p1 })).outcome, 'LINKED');
  const before = snapshot(w.fake);
  assert.equal((await w.links.link(ORG_A, w.owner, { customerId, partyId: p2 })).outcome, 'CONFLICTING_ACTIVE_LINK');
  assert.equal((await w.links.link(ORG_A, w.owner, { customerId, partyId: p1 })).outcome, 'ALREADY_LINKED');
  assert.equal(snapshot(w.fake), before, 'nothing overwritten, nothing audited');
});

test('reversal keeps the row with who and why; relinking writes a new row; the history reads in order', async () => {
  const w = await world();
  const p1 = await w.established();
  const p2 = await w.established();
  const customerId = await w.customer();
  const admin = await w.hire(ORG_A, 'ADMIN');
  await w.links.link(ORG_A, w.owner, { customerId, partyId: p1 });

  assert.deepEqual(await w.links.reverse(ORG_A, admin, { customerId, reason: '   ' }), { outcome: 'INVALID', reason: 'REASON_REQUIRED' });
  const reversed = await w.links.reverse(ORG_A, admin, { customerId, reason: 'Linked to the wrong person' });
  assert.equal(reversed.outcome, 'REVERSED');
  assert.equal((await w.links.reverse(ORG_A, admin, { customerId, reason: 'again' })).outcome, 'NO_ACTIVE_LINK');

  assert.equal((await w.links.link(ORG_A, admin, { customerId, partyId: p2 })).outcome, 'LINKED');
  const history = await w.links.history(ORG_A, admin, customerId);
  assert.equal(history?.length, 2);
  const [first, second] = history!;
  assert.deepEqual(
    [first!.partyId, first!.linkedByUserId, first!.reversedByUserId, first!.reversalReason, first!.activeCustomerId],
    [p1, w.owner, admin, 'Linked to the wrong person', null],
  );
  assert.ok(first!.reversedAt instanceof Date);
  assert.deepEqual([second!.partyId, second!.reversedAt, second!.activeCustomerId], [p2, null, customerId]);
  assert.deepEqual(
    w.fake.auditLog.__rows.filter((e: any) => e.entityId === customerId).map((e: any) => e.action),
    ['customer.party_linked', 'customer.party_link_reversed', 'customer.party_linked'],
  );
  assert.equal(/\.(delete|deleteMany|upsert)\(/.test(code('packages/database/src/repositories/customer-party-link.repository.ts')), false,
    'the link repository can only append and stamp');
});

test('a concurrent second link loses to the unique active link and overwrites nothing', async () => {
  const w = await world();
  const p1 = await w.established();
  const p2 = await w.established();
  const customerId = await w.customer();
  // Simulate the race: another writer's active link appears after this service's read.
  const racing = new CustomerPartyLinkService(w.prisma, {
    links: Object.assign(Object.create(Object.getPrototypeOf((w.links as any).links)), (w.links as any).links, {
      findActive: (() => {
        let calls = 0;
        return async (org: string, cid: string) => {
          calls += 1;
          if (calls === 1) {
            await w.fake.customerPartyLink.create({
              data: { organizationId: ORG_A, customerId: cid, partyId: p2, basis: 'MANUAL', linkedByUserId: w.owner, linkedAt: new Date(), activeCustomerId: cid },
            });
            return null;
          }
          return w.fake.customerPartyLink.__rows.find((r: any) => r.organizationId === org && r.customerId === cid && r.reversedAt === null) ?? null;
        };
      })(),
    }),
  });
  const r = await racing.link(ORG_A, w.owner, { customerId, partyId: p1 });
  assert.equal(r.outcome, 'CONFLICTING_ACTIVE_LINK');
  assert.equal(w.fake.customerPartyLink.__rows.length, 1);
  assert.equal(w.fake.customerPartyLink.__rows[0].partyId, p2);
  assert.equal(w.fake.auditLog.__rows.filter((e: any) => e.action === 'customer.party_linked').length, 0);
});

// ---- Rule 7: cross-organization ------------------------------------------------

test('cross-organization links fail closed, indistinguishably from a miss', async () => {
  const w = await world();
  const ownerB = await w.hire(ORG_B, 'OWNER');
  const partyA = await w.established();
  const partyB = await w.established(ORG_B, ownerB);
  const customerA = await w.customer(ORG_A);
  const customerB = await w.customer(ORG_B);
  const before = snapshot(w.fake);
  assert.equal((await w.links.link(ORG_A, w.owner, { customerId: customerA, partyId: partyB })).outcome, 'NOT_FOUND');
  assert.equal((await w.links.link(ORG_A, w.owner, { customerId: customerB, partyId: partyA })).outcome, 'NOT_FOUND');
  assert.equal((await w.links.link(ORG_B, w.owner, { customerId: customerA, partyId: partyA })).outcome, 'NOT_AUTHORIZED', 'no authority in another tenant');
  assert.equal((await w.links.link(ORG_A, w.owner, { customerId: 'ghost', partyId: partyA })).outcome, 'NOT_FOUND');
  assert.equal(await w.links.history(ORG_A, w.owner, customerB), null);
  assert.equal(snapshot(w.fake), before);
});

// ---- Governed bases, and no side effects ---------------------------------------------

test('only a governed human basis can be recorded', async () => {
  const w = await world();
  const partyId = await w.established();
  const customerId = await w.customer();
  for (const basis of ['AUTHENTICATED', 'VERIFIED_EMAIL', 'SESSION_CONTINUITY', 'PSEUDONYMOUS', 'OTHER', '']) {
    assert.deepEqual(await w.links.link(ORG_A, w.owner, { customerId, partyId, basis }), { outcome: 'INVALID', reason: 'NOT_A_GOVERNED_BASIS' }, basis);
  }
  assert.equal((await w.links.link(ORG_A, w.owner, { customerId, partyId, basis: 'EXPLICIT_LINK' })).outcome, 'LINKED');
});

test('a link has no side effects: no Opportunity, Case, Headline, Finding, Work or cognitive write', async () => {
  const w = await world();
  const partyId = await w.established();
  const customerId = await w.customer();
  const others = ['operationalPriority', 'operationalObservation', 'decisionEvidence', 'headline', 'caseParticipant',
    'identityRole', 'identityEvidence', 'identityResolutionLink', 'memoryEvent', 'knowledgeAssertion', 'stateChangeOutbox']
    .filter((d) => w.fake[d]);
  const counts = () => others.map((d) => w.fake[d].__rows.length);
  const before = counts();
  await w.links.link(ORG_A, w.owner, { customerId, partyId });
  await w.links.reverse(ORG_A, w.owner, { customerId, reason: 'test' });
  assert.deepEqual(counts(), before);
  const svc = code('packages/database/src/services/customer-party-link.service.ts');
  assert.equal(/Opportunity|DecisionEngine|Headline|Finding|WorkInstance|work\.repository|outbox|CaseParticipant/i.test(svc), false);
});

test('the migration is additive, ASCII, and enforces a consistent, governed, append-only link', () => {
  const sql = readFileSync(
    new URL('packages/database/prisma/migrations/20260916000000_crm_p0_2e_customer_party_link/migration.sql', ROOT),
    'utf8',
  );
  assert.equal(/[^\x00-\x7F]/.test(sql), false);
  const body = sql.replace(/^\s*--.*$/gm, ' ').replace(/ON (UPDATE|DELETE) (CASCADE|SET NULL)/g, ' ');
  assert.equal(/\b(DROP|DELETE|TRUNCATE|UPDATE|RENAME|INSERT)\b/i.test(body), false, 'no change to existing data');
  assert.equal(/ALTER TABLE "customers"/.test(body), false, 'Customer itself is untouched');
  assert.match(body, /CREATE UNIQUE INDEX "customer_party_links_activeCustomerId_key"/);
  assert.match(body, /\("reversedAt" IS NULL\) = \("activeCustomerId" IS NOT NULL\)/);
  assert.match(body, /"basis" IN \('MANUAL', 'EXPLICIT_LINK'\)/);
});
