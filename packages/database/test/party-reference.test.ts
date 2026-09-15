// Party Reference repository. Identity Slice 2.0b.
//
// Drives the real PartyReferenceRepository over the real PartyRepository against
// the in-memory Prisma double, through a recording proxy that fails the test on
// any write. Proves: cross-organization and missing and non-Party ids are the
// same NOT_FOUND; unestablished, superseded (forward) and established resolve as
// the contract says; cycles and over-deep chains fail closed; only an established
// Party is referenceable; nothing is written; and nothing is looked up by name,
// contact value, canonical key or evidence value.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PrismaClient } from '@prisma/client';
import { PARTY_REFERENCE_MAX_DEPTH } from '@emgloop/shared';

import { makeCognitivePrisma } from './helpers/cognitive-prisma-fake';
import { PartyReferenceRepository } from '../src/repositories/party-reference.repository';

const ORG_A = 'org_a';
const ORG_B = 'org_b';
const READS = new Set(['findFirst', 'findMany', 'findUnique', 'count']);
const FORBIDDEN_WHERE = /email|phone|displayName|canonicalKey|normalizedValueHash|evidenceType|metadata/i;

type Row = Record<string, unknown>;

function world() {
  const fake: any = makeCognitivePrisma();
  const calls: { delegate: string; method: string; args: unknown }[] = [];
  const prisma = new Proxy(fake, {
    get(target, delegate: string) {
      const d = target[delegate];
      if (typeof d !== 'object' || d === null || delegate.startsWith('$')) {
        if (typeof delegate === 'string' && delegate.startsWith('$')) {
          return () => { throw new Error(`party references must not call ${delegate}`); };
        }
        return d;
      }
      return new Proxy(d, {
        get(inner, method: string) {
          const fn = inner[method];
          if (typeof fn !== 'function') return fn;
          return (args: unknown) => {
            calls.push({ delegate, method, args });
            if (!READS.has(method)) throw new Error(`party references must not write: ${delegate}.${method}`);
            return fn.call(inner, args);
          };
        },
      });
    },
  }) as PrismaClient;

  let seq = 0;
  const party = async (org: string, patch: Row = {}) => {
    const id = (patch.id as string) ?? `party_${++seq}`;
    await fake.cognitiveIdentity.create({
      data: {
        id,
        organizationId: org,
        entityType: 'PERSON',
        displayName: 'Private Name',
        canonicalKey: `key_${id}`,
        status: 'KNOWN',
        metadata: {},
        archivedAt: null,
        establishedAt: new Date('2026-09-15T12:00:00Z'),
        establishedByUserId: 'user_owner',
        establishmentBasis: 'MANUAL',
        supersededByIdentityId: null,
        supersededAt: null,
        supersededByUserId: null,
        ...patch,
      },
    });
    return id;
  };
  const rows = () => JSON.stringify(fake.cognitiveIdentity.__rows);
  return { refs: new PartyReferenceRepository(prisma), party, calls, rows };
}

test('an established Party resolves and is referenceable', async () => {
  const w = world();
  const id = await w.party(ORG_A);
  assert.deepEqual(await w.refs.resolve(ORG_A, id), { state: 'ESTABLISHED', partyId: id, partyType: 'PERSON', archived: false });
  assert.deepEqual(await w.refs.requireReferenceable(ORG_A, id), { ok: true, reference: { organizationId: ORG_A, partyId: id }, partyType: 'PERSON' });
  const company = await w.party(ORG_A, { entityType: 'COMPANY' });
  assert.equal((await w.refs.requireReferenceable(ORG_A, company)).ok, true);
});

test('cross-organization, missing and non-Party ids are the same NOT_FOUND', async () => {
  const w = world();
  const theirs = await w.party(ORG_B);
  const call = await w.party(ORG_A, { entityType: 'CALL' });
  const creator = await w.party(ORG_A, { entityType: 'CREATOR' });
  const results = await Promise.all([
    w.refs.resolve(ORG_A, theirs),
    w.refs.resolve(ORG_A, 'no_such_party'),
    w.refs.resolve(ORG_A, call),
    w.refs.resolve(ORG_A, creator),
    w.refs.resolve('', theirs),
    w.refs.resolve(ORG_A, '   '),
  ]);
  for (const r of results) assert.deepEqual(r, { state: 'NOT_FOUND' });
  assert.deepEqual(await w.refs.requireReferenceable(ORG_A, theirs), { ok: false, resolution: { state: 'NOT_FOUND' } });
  assert.deepEqual(await w.refs.resolve(ORG_B, theirs), { state: 'ESTABLISHED', partyId: theirs, partyType: 'PERSON', archived: false });
});

test('a blank reference is refused without reading anything', async () => {
  const w = world();
  await w.refs.resolve('', 'x');
  await w.refs.resolve(ORG_A, '');
  assert.equal(w.calls.length, 0);
});

test('an unestablished Party resolves but is not referenceable', async () => {
  const w = world();
  const id = await w.party(ORG_A, { establishedAt: null, establishedByUserId: null, establishmentBasis: null, status: 'ANONYMOUS' });
  assert.deepEqual(await w.refs.resolve(ORG_A, id), { state: 'NOT_ESTABLISHED', partyId: id, partyType: 'PERSON', archived: false });
  const req = await w.refs.requireReferenceable(ORG_A, id);
  assert.equal(req.ok, false);
  // A MANUAL basis whose actor is gone reads as not established -- PartyRepository's rule, not ours.
  const orphaned = await w.party(ORG_A, { establishedByUserId: null });
  assert.equal((await w.refs.resolve(ORG_A, orphaned)).state, 'NOT_ESTABLISHED');
});

test('a superseded Party resolves forward, is refused for writes with its canonical id, and nothing is rewritten', async () => {
  const w = world();
  const canon = await w.party(ORG_A, { id: 'canon' });
  const mid = await w.party(ORG_A, { id: 'mid', supersededByIdentityId: canon, supersededAt: new Date(), supersededByUserId: 'user_owner' });
  const old = await w.party(ORG_A, { id: 'old', supersededByIdentityId: mid, supersededAt: new Date(), supersededByUserId: 'user_owner' });
  const before = w.rows();
  const expected = { state: 'SUPERSEDED', partyId: old, canonicalPartyId: canon, partyType: 'PERSON', canonicalEstablished: true, canonicalArchived: false };
  assert.deepEqual(await w.refs.resolve(ORG_A, old), expected);
  assert.deepEqual(await w.refs.requireReferenceable(ORG_A, old), { ok: false, resolution: expected });
  assert.equal(w.rows(), before);
});

test('supersession into another organization fails closed', async () => {
  const w = world();
  const theirs = await w.party(ORG_B, { id: 'theirs' });
  const ours = await w.party(ORG_A, { supersededByIdentityId: theirs });
  assert.deepEqual(await w.refs.resolve(ORG_A, ours), { state: 'NOT_FOUND' });
});

test('a supersession chain that crosses PERSON and COMPANY is NOT_FOUND, in either direction', async () => {
  const w = world();
  const company = await w.party(ORG_A, { id: 'company', entityType: 'COMPANY' });
  const person = await w.party(ORG_A, { id: 'person' });
  await w.party(ORG_A, { id: 'person_old', supersededByIdentityId: company });
  await w.party(ORG_A, { id: 'company_old', entityType: 'COMPANY', supersededByIdentityId: person });
  assert.deepEqual(await w.refs.resolve(ORG_A, 'person_old'), { state: 'NOT_FOUND' });
  assert.deepEqual(await w.refs.resolve(ORG_A, 'company_old'), { state: 'NOT_FOUND' });
  assert.deepEqual(await w.refs.requireReferenceable(ORG_A, 'company_old'), { ok: false, resolution: { state: 'NOT_FOUND' } });
});

test('cycles fail closed', async () => {
  const w = world();
  await w.party(ORG_A, { id: 'self', supersededByIdentityId: 'self' });
  await w.party(ORG_A, { id: 'a', supersededByIdentityId: 'b' });
  await w.party(ORG_A, { id: 'b', supersededByIdentityId: 'a' });
  assert.deepEqual(await w.refs.resolve(ORG_A, 'self'), { state: 'NOT_FOUND' });
  assert.deepEqual(await w.refs.resolve(ORG_A, 'a'), { state: 'NOT_FOUND' });
  assert.ok(w.calls.length < 10, 'the walk stopped at the cycle');
});

test('depth: the maximum chain resolves, one hop more fails closed, and the walk is bounded', async () => {
  const w = world();
  const hops = PARTY_REFERENCE_MAX_DEPTH + 1;
  for (let i = hops; i >= 0; i--) {
    await w.party(ORG_A, { id: `p${i}`, supersededByIdentityId: i < hops ? `p${i + 1}` : null });
  }
  const within = await w.refs.resolve(ORG_A, 'p1');
  assert.equal(within.state === 'SUPERSEDED' && within.canonicalPartyId, `p${hops}`);
  const before = w.calls.filter((c) => c.method === 'findFirst').length;
  assert.deepEqual(await w.refs.resolve(ORG_A, 'p0'), { state: 'NOT_FOUND' });
  const reads = w.calls.filter((c) => c.method === 'findFirst').length - before;
  assert.ok(reads <= PARTY_REFERENCE_MAX_DEPTH + 1, `bounded walk, read ${reads}`);
});

test('an archived Party stays readable and takes no new references', async () => {
  const w = world();
  const id = await w.party(ORG_A, { status: 'ARCHIVED', archivedAt: new Date() });
  assert.deepEqual(await w.refs.resolve(ORG_A, id), { state: 'ESTABLISHED', partyId: id, partyType: 'PERSON', archived: true });
  assert.equal((await w.refs.requireReferenceable(ORG_A, id)).ok, false);
});

test('fence: resolution reads only by organization and id, never by name, contact value, key or evidence value, and writes nothing', async () => {
  const w = world();
  const canon = await w.party(ORG_A, { id: 'canon' });
  await w.party(ORG_A, { id: 'old', supersededByIdentityId: canon });
  await w.refs.resolve(ORG_A, 'old');
  await w.refs.requireReferenceable(ORG_A, canon);
  await w.refs.resolve(ORG_B, canon);
  assert.ok(w.calls.length > 0);
  for (const c of w.calls) {
    assert.ok(READS.has(c.method), `${c.delegate}.${c.method}`);
    assert.ok(['cognitiveIdentity', 'identityEvidence'].includes(c.delegate), c.delegate);
    const where = JSON.stringify((c.args as { where?: unknown })?.where ?? {});
    assert.doesNotMatch(where, FORBIDDEN_WHERE, `${c.delegate}.${c.method} ${where}`);
    assert.match(where, /"organizationId"/, 'every read is organization-scoped');
    if (c.delegate === 'cognitiveIdentity') assert.match(where, /"id"/);
    if (c.delegate === 'identityEvidence') assert.match(where, /"identityId"/, 'evidence is read by the Party, never matched by value');
  }
});

test('fence: the repository source writes nothing and names no contact value, and CaseParticipant is documented as unrelated', () => {
  const raw = readFileSync(join(__dirname, '..', 'src', 'repositories', 'party-reference.repository.ts'), 'utf8');
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\s*(\?\.)?\s*\(|\$executeRaw|\$queryRaw|\$transaction/);
  assert.doesNotMatch(code, /email|phone|displayName|canonicalKey|normalizedValueHash|evidence|customer/i);
  assert.doesNotMatch(code, /prisma\.\w+\./, 'reads go through PartyRepository, not Prisma');
  assert.match(raw, /CaseParticipant IS NOT THIS/);
});
