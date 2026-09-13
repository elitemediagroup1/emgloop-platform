// Party reads over CognitiveIdentity. CRM Phase Zero P0.2a.
//
// Drives the real cognitive repositories and the real (dormant) identity
// resolver against the in-memory cognitive Prisma double. Proves that a Party is
// a reading of existing identity rows rather than a second store; that the
// dormant resolver's session, pseudonymous, anonymous and caller-"verified"
// paths create cognitive subjects without ever establishing a Party; that
// recorded rows without governed provenance establish nothing and are not
// reclassified; that confidence is inert; and that no Party read can tell one
// organization anything about another.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { CognitiveEntityType, type PrismaClient } from '@prisma/client';

import { makeCognitivePrisma } from './helpers/cognitive-prisma-fake';
import {
  createCognitiveRepositories,
  hashIdentifier,
} from '../src/repositories/cognitive';
import { resolveIdentity } from '../src/services/cognitive/identity-resolution';

const ORG_A = 'org_a';
const ORG_B = 'org_b';

function setup() {
  const fake = makeCognitivePrisma();
  const prisma = fake as unknown as PrismaClient;
  return { fake: fake as any, prisma, repos: createCognitiveRepositories(prisma) };
}

test('only PERSON and COMPANY identity rows read as Parties -- every other entity type is null', async () => {
  const { repos } = setup();
  const types = Object.values(CognitiveEntityType);
  assert.equal(types.length, 20, 'the enum this test covers exhaustively');
  const readable: string[] = [];
  for (const entityType of types) {
    const row = await repos.identities.create(ORG_A, { entityType, canonicalKey: `k-${entityType}` });
    const party = await repos.parties.findParty(ORG_A, row.id);
    if (party) {
      readable.push(entityType);
      assert.equal(party.partyType, entityType);
      assert.equal(party.id, row.id, 'a Party is the identity row itself, not a copy');
    }
  }
  assert.deepEqual(readable, ['PERSON', 'COMPANY']);
});

test('a Party read in another organization fails closed, indistinguishable from unknown', async () => {
  const { repos } = setup();
  const a = await repos.identities.create(ORG_A, { entityType: 'PERSON', canonicalKey: 'shared-key' });
  const b = await repos.identities.create(ORG_B, { entityType: 'PERSON', canonicalKey: 'shared-key' });
  assert.notEqual(a.id, b.id, 'the same key in two tenants is two rows');

  assert.equal(await repos.parties.findParty(ORG_B, a.id), null);
  assert.equal(await repos.parties.findParty(ORG_B, 'no-such-id'), null);
  assert.equal(await repos.parties.samePartyPosture(ORG_A, a.id, b.id), null);
  assert.equal(await repos.parties.samePartyPosture(ORG_B, a.id, b.id), null);
});

test('session continuity cannot establish a Party', async () => {
  const { fake, repos } = setup();
  const first = await resolveIdentity(ORG_A, { entityType: 'PERSON', sessionId: 'sess-1' }, repos, 'evt-1');
  const again = await resolveIdentity(ORG_A, { entityType: 'PERSON', sessionId: 'sess-1' }, repos, 'evt-2');
  assert.equal(again.method, 'SESSION_CONTINUITY');
  assert.equal(again.identityId, first.identityId);

  const party = await repos.parties.findParty(ORG_A, again.identityId);
  assert.ok(party, 'the subject exists and is party-typed');
  assert.deepEqual(party.establishment, { partyTyped: true, established: false, basis: null });
  assert.equal(fake.identityResolutionLink.__rows.length, 0, 'resolution writes no link');
});

test('a pseudonymous or anonymous identity cannot establish a Party', async () => {
  const { repos } = setup();
  const pseudo = await resolveIdentity(ORG_A, { entityType: 'COMPANY', canonicalKey: 'acme' }, repos, 'evt-1');
  assert.equal(pseudo.method, 'PSEUDONYMOUS');
  const anon = await resolveIdentity(ORG_A, { entityType: 'PERSON' }, repos, 'anon:website:evt-2');

  for (const r of [pseudo, anon]) {
    const party = await repos.parties.findParty(ORG_A, r.identityId);
    assert.ok(party);
    assert.equal(party.establishment.established, false);
  }
  assert.equal(await repos.parties.samePartyPosture(ORG_A, pseudo.identityId, anon.identityId), 'UNRESOLVED',
    'resolution links nothing, so two subjects stay two records');
});

test('an unverified email or phone -- or a caller merely claiming "verified" -- cannot establish a Party', async () => {
  const { repos } = setup();
  const seeded = await resolveIdentity(
    ORG_A,
    { entityType: 'PERSON', canonicalKey: 'p-1', evidence: [{ evidenceType: 'EMAIL', rawValue: 'pat@example.com' }] },
    repos,
    'evt-1',
  );

  // Unverified: skipped by resolution entirely, so a second subject is minted.
  const unverified = await resolveIdentity(
    ORG_A,
    { entityType: 'PERSON', evidence: [{ evidenceType: 'EMAIL', rawValue: 'pat@example.com', verified: false }] },
    repos,
    'evt-2',
  );
  assert.notEqual(unverified.identityId, seeded.identityId, 'an unverified email does not resolve an identity');

  // Caller-claimed verification resolves the cognitive subject, and that is all it does.
  const claimed = await resolveIdentity(
    ORG_A,
    { entityType: 'PERSON', evidence: [{ evidenceType: 'PHONE', rawValue: '555-0100', verified: true }] },
    repos,
    'evt-3',
  );
  const phoneOwner = await resolveIdentity(
    ORG_A,
    { entityType: 'PERSON', evidence: [{ evidenceType: 'PHONE', rawValue: '(555) 0100', verified: true }] },
    repos,
    'evt-4',
  );
  assert.equal(phoneOwner.method, 'VERIFIED_PHONE');
  assert.equal(phoneOwner.identityId, claimed.identityId);

  for (const id of [seeded.identityId, unverified.identityId, claimed.identityId]) {
    assert.equal((await repos.parties.findParty(ORG_A, id))?.establishment.established, false);
  }
  assert.equal(await repos.parties.samePartyPosture(ORG_A, seeded.identityId, unverified.identityId), 'UNRESOLVED');
});

test('numeric confidence cannot establish a Party -- not the resolver\'s 1.0, not a stored 0.99', async () => {
  const { repos } = setup();
  const row = await repos.identities.create(ORG_A, { entityType: 'PERSON', canonicalKey: 'auth-1', status: 'ACTIVE' });
  const authed = await resolveIdentity(
    ORG_A,
    { entityType: 'PERSON', authenticatedIdentityId: row.id },
    repos,
    'evt-1',
  );
  assert.equal(authed.method, 'AUTHENTICATED');
  assert.equal(authed.confidence, 1.0, 'the dormant resolver still reports it');
  assert.equal((await repos.parties.findParty(ORG_A, row.id))?.establishment.established, false,
    'a caller-supplied authenticated id is not the Party\'s own authenticated act');

  const other = await repos.identities.create(ORG_A, { entityType: 'PERSON', canonicalKey: 'auth-2' });
  const link = await repos.identityResolutionLinks.propose(ORG_A, {
    sourceIdentityId: row.id,
    targetIdentityId: other.id,
    method: 'MANUAL',
    confidence: 0.99,
    establishedBy: 'someone',
  });
  await repos.identityResolutionLinks.confirm(ORG_A, link.id);
  assert.equal(await repos.parties.samePartyPosture(ORG_A, row.id, other.id), 'POSSIBLE_MATCH');
});

test('recorded rows without governed provenance establish nothing -- and are not reclassified', async () => {
  const { fake, repos } = setup();
  const p = await repos.identities.create(ORG_A, { entityType: 'COMPANY', canonicalKey: 'c-1' });
  const q = await repos.identities.create(ORG_A, { entityType: 'COMPANY', canonicalKey: 'c-2' });
  await repos.identityEvidence.record(ORG_A, { identityId: p.id, evidenceType: 'AUTHENTICATED_ACCOUNT', rawValue: 'acct-9' });
  await repos.identityEvidence.record(ORG_A, { identityId: p.id, evidenceType: 'EXPLICIT_LINK', rawValue: 'link-9' });
  assert.equal((await repos.parties.findParty(ORG_A, p.id))?.establishment.established, false);

  assert.equal(await repos.parties.samePartyPosture(ORG_A, p.id, q.id), 'UNRESOLVED', 'no links');
  const link = await repos.identityResolutionLinks.propose(ORG_A, {
    sourceIdentityId: q.id, targetIdentityId: p.id, method: 'EXPLICIT_LINK', establishedBy: 'user_1',
  });
  assert.equal(await repos.parties.samePartyPosture(ORG_A, p.id, q.id), 'POSSIBLE_MATCH', 'proposed');
  await repos.identityResolutionLinks.confirm(ORG_A, link.id);
  assert.equal(await repos.parties.samePartyPosture(ORG_A, p.id, q.id), 'POSSIBLE_MATCH',
    'a confirmed link with free-text establishedBy is not a governed confirmation');
  await repos.identityResolutionLinks.reverse(ORG_A, link.id, { reversedBy: 'user_1', reason: 'wrong company' });
  assert.equal(await repos.parties.samePartyPosture(ORG_A, p.id, q.id), 'UNRESOLVED', 'reversed');

  const stored = fake.identityResolutionLink.__rows.find((r: any) => r.id === link.id);
  assert.equal(stored.status, 'REVERSED', 'the stored status keeps its own meaning');
  assert.equal(stored.reversalReason, 'wrong company');
});

test('Party reads write nothing', async () => {
  const { fake, repos } = setup();
  const p = await repos.identities.create(ORG_A, { entityType: 'PERSON', canonicalKey: 'w-1' });
  const q = await repos.identities.create(ORG_A, { entityType: 'PERSON', canonicalKey: 'w-2' });
  const counts = () => ['cognitiveIdentity', 'identityEvidence', 'identityResolutionLink', 'identityRole']
    .map((d) => fake[d].__rows.length);
  const before = counts();
  await repos.parties.findParty(ORG_A, p.id);
  await repos.parties.samePartyPosture(ORG_A, p.id, q.id);
  await repos.parties.findParty(ORG_B, p.id);
  assert.deepEqual(counts(), before);
});

test('identity evidence stays organization-salted: the same email hashes differently per tenant and never resolves across', async () => {
  const { repos } = setup();
  assert.notEqual(
    hashIdentifier(ORG_A, 'EMAIL', 'pat@example.com'),
    hashIdentifier(ORG_B, 'EMAIL', 'pat@example.com'),
  );
  const a = await repos.identities.create(ORG_A, { entityType: 'PERSON', canonicalKey: 'salt-a' });
  await repos.identityEvidence.record(ORG_A, { identityId: a.id, evidenceType: 'EMAIL', rawValue: 'pat@example.com' });
  assert.equal(await repos.identityEvidence.findIdentityIdByValue(ORG_A, 'EMAIL', 'PAT@example.com '), a.id);
  assert.equal(await repos.identityEvidence.findIdentityIdByValue(ORG_B, 'EMAIL', 'pat@example.com'), null);
});

test('no global Party existence probe: the Party surface is two org-first reads by id, and every query is org-scoped', () => {
  const src = readFileSync(new URL('../src/repositories/cognitive/party.repository.ts', import.meta.url), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

  const publicMethods = [...code.matchAll(/^ {2}(?!private\b)(?:async\s+)?([a-zA-Z]+)\(([^)]*)/gm)]
    .filter(([, name]) => name !== 'constructor')
    .map(([, name, params]) => ({ name: name!, first: params!.split(',')[0]!.trim() }));
  assert.deepEqual(publicMethods.map((m) => m.name), ['findParty', 'samePartyPosture']);
  for (const m of publicMethods) {
    assert.equal(m.first, 'organizationId: string', `${m.name} takes organizationId first`);
  }
  assert.equal(/\b(email|phone|name|canonicalKey|rawValue|search|listAll)\b/i.test(
    publicMethods.map((m) => m.name).join(' ')), false);

  const queries = [...code.matchAll(/\.(findFirst|findMany|findUnique|count|aggregate|groupBy)\(\{([\s\S]*?)\}\);/g)];
  assert.ok(queries.length >= 3);
  for (const [, op, body] of queries) {
    assert.match(body!, /organizationId/, `${op} is scoped to the organization`);
  }
  assert.equal(/\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/.test(code), false,
    'the Party surface writes nothing');
  assert.equal(/confidence/i.test(code), false, 'no confidence is read');
});

test('name similarity links nothing: two subjects named alike stay two unresolved Party records', async () => {
  const { repos } = setup();
  const one = await resolveIdentity(ORG_A, { entityType: 'PERSON', canonicalKey: 'k-a', displayName: 'Jordan Lee' }, repos, 'e1');
  const two = await resolveIdentity(ORG_A, { entityType: 'PERSON', canonicalKey: 'k-b', displayName: 'Jordan Lee' }, repos, 'e2');
  assert.notEqual(one.identityId, two.identityId);
  assert.equal(await repos.parties.samePartyPosture(ORG_A, one.identityId, two.identityId), 'UNRESOLVED');
});

test('no ingestion or CRM path reaches identity resolution or Party reads -- Customer matching cannot create a Party', () => {
  const root = new URL('../../..', import.meta.url).pathname;
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      if (f === 'node_modules' || f === '.next') return [];
      return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(f) ? [p] : [];
    });
  const surfaces = [
    join(root, 'packages/database/src/services/ingestion.service.ts'),
    join(root, 'packages/database/src/repositories/crm.repository.ts'),
    join(root, 'packages/database/src/repositories/conversations.repository.ts'),
    ...walk(join(root, 'apps/web/src')),
  ];
  const reach = /\b(resolveIdentity|PartyRepository|findParty|samePartyPosture|cognitiveIdentity|identityResolutionLink)\b|\.parties\./;
  for (const file of surfaces) {
    const code = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
    assert.equal(reach.test(code), false, `${file.slice(root.length)} must not reach identity resolution`);
  }
});
