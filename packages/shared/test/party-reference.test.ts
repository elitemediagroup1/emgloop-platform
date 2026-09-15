// Party Reference Contract, pure. Identity Slice 2.0b.
//
// The walk has one definition, `partyReferenceStep`: a reference resolves to
// ESTABLISHED, NOT_ESTABLISHED, SUPERSEDED (forward, to the canonical record) or
// NOT_FOUND. Cycles, over-deep chains, changes of Party type and unfollowable
// links fail closed. Only an ESTABLISHED, non-archived Party is writable. A
// capacity is never a Party type.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  PARTY_REFERENCE_STATES,
  PARTY_REFERENCE_MAX_DEPTH,
  PARTY_REFERENCE_NOT_FOUND,
  PARTY_CAPACITIES,
  isPartyReference,
  isPartyCapacity,
  partyReferenceStep,
  partyReferenceWritable,
  type PartyReferenceNode,
  type PartyReferenceResolution,
} from '../src/party-reference';
import { PARTY_TYPES, CONTEXTUAL_ROLE_ENTITY_TYPES } from '../src/party';

function node(id: string, patch: Partial<PartyReferenceNode> = {}): PartyReferenceNode {
  return { id, partyType: 'PERSON', established: true, archived: false, supersededByPartyId: null, ...patch };
}

/** Drives the step function over an in-memory graph, as the repository does over reads. */
function walk(requested: string, graph: Record<string, PartyReferenceNode>): PartyReferenceResolution {
  const walked: PartyReferenceNode[] = [];
  let id = requested;
  for (let guard = 0; guard < 1000; guard++) {
    const n = graph[id] ?? null;
    const step = partyReferenceStep(requested, walked, n);
    if ('resolved' in step) return step.resolved;
    walked.push(n!);
    id = step.next;
  }
  throw new Error('the step function did not terminate');
}

function chain(length: number): Record<string, PartyReferenceNode> {
  const graph: Record<string, PartyReferenceNode> = {};
  for (let i = 0; i <= length; i++) {
    graph[`p${i}`] = node(`p${i}`, { supersededByPartyId: i < length ? `p${i + 1}` : null });
  }
  return graph;
}

test('four states, in the approved vocabulary', () => {
  assert.deepEqual([...PARTY_REFERENCE_STATES], ['ESTABLISHED', 'NOT_ESTABLISHED', 'SUPERSEDED', 'NOT_FOUND']);
  assert.ok(Object.isFrozen(PARTY_REFERENCE_NOT_FOUND));
});

test('a reference is (organizationId, partyId), both non-blank', () => {
  assert.equal(isPartyReference({ organizationId: 'org', partyId: 'p1' }), true);
  for (const bad of [null, {}, { organizationId: 'org' }, { partyId: 'p1' }, { organizationId: ' ', partyId: 'p1' }, { organizationId: 'org', partyId: '' }, { organizationId: 1, partyId: 'p1' }]) {
    assert.equal(isPartyReference(bad), false, JSON.stringify(bad));
  }
});

test('established and unestablished records resolve to themselves', () => {
  assert.deepEqual(walk('p1', { p1: node('p1') }), { state: 'ESTABLISHED', partyId: 'p1', partyType: 'PERSON', archived: false });
  assert.deepEqual(walk('c1', { c1: node('c1', { partyType: 'COMPANY', established: false }) }), {
    state: 'NOT_ESTABLISHED', partyId: 'c1', partyType: 'COMPANY', archived: false,
  });
});

test('a miss of any kind is NOT_FOUND', () => {
  assert.deepEqual(walk('ghost', {}), { state: 'NOT_FOUND' });
  assert.deepEqual(partyReferenceStep('p1', [], node('p2')), { resolved: { state: 'NOT_FOUND' } }, 'a loader that returned the wrong record');
  assert.deepEqual(partyReferenceStep('p1', [], node('')), { resolved: { state: 'NOT_FOUND' } });
});

test('superseded records resolve forward to the canonical record and name both ids', () => {
  const graph = { old: node('old', { supersededByPartyId: 'mid' }), mid: node('mid', { supersededByPartyId: 'canon' }), canon: node('canon', { established: false }) };
  assert.deepEqual(walk('old', graph), {
    state: 'SUPERSEDED', partyId: 'old', canonicalPartyId: 'canon', partyType: 'PERSON', canonicalEstablished: false, canonicalArchived: false,
  });
  assert.equal(walk('canon', graph).state, 'NOT_ESTABLISHED');
});

test('a supersession chain whose target is missing, or another organization\'s, fails closed', () => {
  assert.deepEqual(walk('old', { old: node('old', { supersededByPartyId: 'elsewhere' }) }), { state: 'NOT_FOUND' });
  assert.deepEqual(walk('old', { old: node('old', { supersededByPartyId: '  ' }) }), { state: 'NOT_FOUND' });
});

test('cycles fail closed: a self-loop and a longer loop', () => {
  assert.deepEqual(walk('a', { a: node('a', { supersededByPartyId: 'a' }) }), { state: 'NOT_FOUND' });
  const loop = { a: node('a', { supersededByPartyId: 'b' }), b: node('b', { supersededByPartyId: 'c' }), c: node('c', { supersededByPartyId: 'a' }) };
  for (const start of ['a', 'b', 'c']) assert.deepEqual(walk(start, loop), { state: 'NOT_FOUND' });
});

test('depth: exactly PARTY_REFERENCE_MAX_DEPTH hops resolve; one more fails closed', () => {
  assert.equal(PARTY_REFERENCE_MAX_DEPTH, 8);
  const ok = walk('p0', chain(PARTY_REFERENCE_MAX_DEPTH));
  assert.equal(ok.state, 'SUPERSEDED');
  assert.equal(ok.state === 'SUPERSEDED' && ok.canonicalPartyId, `p${PARTY_REFERENCE_MAX_DEPTH}`);
  assert.deepEqual(walk('p0', chain(PARTY_REFERENCE_MAX_DEPTH + 1)), { state: 'NOT_FOUND' });
});

test('supersession never crosses Party type, in either direction (Product, 2026-09-15)', () => {
  const personToCompany = { person: node('person', { supersededByPartyId: 'company' }), company: node('company', { partyType: 'COMPANY' }) };
  assert.deepEqual(walk('person', personToCompany), { state: 'NOT_FOUND' });
  const companyToPerson = { company: node('company', { partyType: 'COMPANY', supersededByPartyId: 'person' }), person: node('person') };
  assert.deepEqual(walk('company', companyToPerson), { state: 'NOT_FOUND' });
  const crossesLater = {
    a: node('a', { supersededByPartyId: 'b' }),
    b: node('b', { supersededByPartyId: 'c' }),
    c: node('c', { partyType: 'COMPANY' }),
  };
  assert.deepEqual(walk('a', crossesLater), { state: 'NOT_FOUND' }, 'a type change anywhere in the chain');
});

test('a step must follow the link it was given', () => {
  const walked = [node('a', { supersededByPartyId: 'b' })];
  assert.deepEqual(partyReferenceStep('a', walked, node('z')), { resolved: { state: 'NOT_FOUND' } });
});

test('writes reference ESTABLISHED, non-archived Parties only', () => {
  assert.equal(partyReferenceWritable(walk('p1', { p1: node('p1') })), true);
  assert.equal(partyReferenceWritable(walk('p1', { p1: node('p1', { archived: true }) })), false);
  assert.equal(partyReferenceWritable(walk('p1', { p1: node('p1', { established: false }) })), false);
  assert.equal(partyReferenceWritable(walk('p0', chain(1))), false, 'a superseded id is refused, not swapped');
  assert.equal(partyReferenceWritable(PARTY_REFERENCE_NOT_FOUND), false);
});

test('a capacity is never a Party type, and the vocabulary is party.ts\'s own', () => {
  assert.equal(PARTY_CAPACITIES, CONTEXTUAL_ROLE_ENTITY_TYPES);
  assert.deepEqual([...PARTY_CAPACITIES], ['EMPLOYEE', 'CREATOR', 'BUYER', 'VENDOR', 'SOURCE']);
  for (const t of PARTY_TYPES) assert.equal(isPartyCapacity(t), false);
  for (const c of PARTY_CAPACITIES) assert.ok(!(PARTY_TYPES as readonly string[]).includes(c));
  assert.equal(isPartyCapacity('CONTACT'), false);
});

test('fence: the contract is pure, never reads a capacity, and knows no contact values', () => {
  const src = readFileSync(join(__dirname, '..', 'src', 'party-reference.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(src, /Date\.now|new Date\(|Math\.random|process\.env|fetch\(|prisma/i);
  assert.doesNotMatch(src, /email|phone|displayName|canonicalKey|evidence|confidence/i);
  const step = src.slice(src.indexOf('export function partyReferenceStep'), src.indexOf('export function partyReferenceWritable'));
  assert.doesNotMatch(step, /capacit/i);
});
