// The Party contract, pure. CRM Phase Zero P0.2a.
//
// Pins what makes a record a Party, what establishes one, and what Loop may say
// about two records being the same Party -- and, just as deliberately, the long
// list of things that never do: session continuity, pseudonymous and anonymous
// keys, household inference, unverified contact values, a method name without
// provenance, and a confidence number.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  PARTY_TYPES,
  PARTY_RESOLUTION_POSTURES,
  PARTY_CONFIRMING_METHODS,
  PARTY_NEVER_CONFIRMING_METHODS,
  CONTEXTUAL_ROLE_ENTITY_TYPES,
  DEFERRED_PARTY_TYPES,
  NO_GOVERNED_PROVENANCE,
  isPartyType,
  isGovernedPartyBasis,
  partyEstablishment,
  partyLinkPosture,
  type PartyBasisProvenance,
} from '../src/party';

const ACTOR: PartyBasisProvenance = { ...NO_GOVERNED_PROVENANCE, authorizedActorUserId: 'user_1' };
const SELF: PartyBasisProvenance = { ...NO_GOVERNED_PROVENANCE, subjectAuthenticated: true };
const VERIFIED: PartyBasisProvenance = { ...NO_GOVERNED_PROVENANCE, verificationRecorded: true };
const EVERYTHING: PartyBasisProvenance = {
  subjectAuthenticated: true,
  authorizedActorUserId: 'user_1',
  verificationRecorded: true,
};

// The full CognitiveEntityType enum, as the schema declares it. The database
// suite binds the real Prisma enum; this copy lets the pure contract be tested
// against every member without importing a database client.
const ENTITY_TYPES = [
  'PERSON', 'COMPANY', 'HOUSEHOLD', 'EMPLOYEE', 'CREATOR', 'BUYER', 'VENDOR', 'SOURCE',
  'CAMPAIGN', 'PRODUCT', 'SERVICE', 'PROPERTY', 'LOCATION', 'OPPORTUNITY', 'DOCUMENT',
  'CALL', 'EMAIL', 'MEETING', 'WORK_ITEM', 'OTHER',
];

test('PERSON and COMPANY are the only Party types', () => {
  assert.deepEqual([...PARTY_TYPES], ['PERSON', 'COMPANY']);
  assert.equal(isPartyType('PERSON'), true);
  assert.equal(isPartyType('COMPANY'), true);
  const qualifying = ENTITY_TYPES.filter(isPartyType);
  assert.deepEqual(qualifying, ['PERSON', 'COMPANY']);
});

test('role-like entity types are not Party types', () => {
  for (const role of [...CONTEXTUAL_ROLE_ENTITY_TYPES, 'BRAND', 'AGENCY', 'PUBLISHER', 'PARTNER']) {
    assert.equal(isPartyType(role), false, `${role} is a contextual role, not a Party type`);
  }
});

test('every other type fails closed, including deferred HOUSEHOLD and malformed input', () => {
  for (const t of ENTITY_TYPES.filter((t) => t !== 'PERSON' && t !== 'COMPANY')) {
    assert.equal(isPartyType(t), false, t);
  }
  assert.deepEqual([...DEFERRED_PARTY_TYPES], ['HOUSEHOLD']);
  for (const bad of ['person', ' PERSON', 'PERSON ', '', null, undefined, 1, {}, ['PERSON']]) {
    assert.equal(isPartyType(bad), false, JSON.stringify(bad));
  }
});

test('the posture vocabulary is exactly the three Product states', () => {
  assert.deepEqual([...PARTY_RESOLUTION_POSTURES], ['CONFIRMED_SAME_PARTY', 'POSSIBLE_MATCH', 'UNRESOLVED']);
});

test('session continuity, pseudonymous, household and OTHER never establish a Party, whatever the provenance', () => {
  for (const method of PARTY_NEVER_CONFIRMING_METHODS) {
    assert.equal(isGovernedPartyBasis({ method, provenance: EVERYTHING }), false, method);
    const e = partyEstablishment({ entityType: 'PERSON', bases: [{ method, provenance: EVERYTHING }] });
    assert.equal(e.established, false, method);
  }
  assert.equal((PARTY_CONFIRMING_METHODS as readonly string[]).some((m) =>
    (PARTY_NEVER_CONFIRMING_METHODS as readonly string[]).includes(m)), false);
});

test('an anonymous or name-similarity basis is not a method at all and fails closed', () => {
  for (const method of ['ANONYMOUS', 'NAME_SIMILARITY', 'LAST_SEVEN_DIGITS', 'FUZZY', 'LLM', '']) {
    assert.equal(isGovernedPartyBasis({ method, provenance: EVERYTHING }), false, method);
  }
});

test('a method name without provenance establishes nothing', () => {
  for (const method of PARTY_CONFIRMING_METHODS) {
    assert.equal(isGovernedPartyBasis({ method, provenance: NO_GOVERNED_PROVENANCE }), false, method);
  }
  const e = partyEstablishment({
    entityType: 'PERSON',
    bases: PARTY_CONFIRMING_METHODS.map((method) => ({ method, provenance: NO_GOVERNED_PROVENANCE })),
  });
  assert.deepEqual(e, { partyTyped: true, established: false, basis: null });
});

test('unverified email or phone cannot establish a Party; recorded verification can', () => {
  for (const method of ['VERIFIED_EMAIL', 'VERIFIED_PHONE'] as const) {
    // An authorized actor or a self-authentication does not stand in for verification.
    assert.equal(isGovernedPartyBasis({ method, provenance: ACTOR }), false);
    assert.equal(isGovernedPartyBasis({ method, provenance: SELF }), false);
    assert.equal(isGovernedPartyBasis({ method, provenance: VERIFIED }), true);
  }
  // Raw evidence types are not resolution methods.
  assert.equal(isGovernedPartyBasis({ method: 'EMAIL', provenance: EVERYTHING }), false);
  assert.equal(isGovernedPartyBasis({ method: 'PHONE', provenance: EVERYTHING }), false);
});

test('AUTHENTICATED requires the Party\'s own authenticated act; EXPLICIT_LINK and MANUAL require an authorized actor', () => {
  assert.equal(isGovernedPartyBasis({ method: 'AUTHENTICATED', provenance: ACTOR }), false);
  assert.equal(isGovernedPartyBasis({ method: 'AUTHENTICATED', provenance: SELF }), true);
  for (const method of ['EXPLICIT_LINK', 'MANUAL'] as const) {
    assert.equal(isGovernedPartyBasis({ method, provenance: SELF }), false);
    assert.equal(isGovernedPartyBasis({ method, provenance: ACTOR }), true);
    assert.equal(
      isGovernedPartyBasis({ method, provenance: { ...NO_GOVERNED_PROVENANCE, authorizedActorUserId: '   ' } }),
      false,
      'a blank actor is no actor',
    );
  }
});

test('establishment is only ever for a Party type', () => {
  const governed = [{ method: 'MANUAL', provenance: ACTOR }];
  assert.deepEqual(partyEstablishment({ entityType: 'COMPANY', bases: governed }), {
    partyTyped: true, established: true, basis: 'MANUAL',
  });
  for (const t of ['BUYER', 'CREATOR', 'HOUSEHOLD', 'CALL', 'OTHER']) {
    assert.deepEqual(partyEstablishment({ entityType: t, bases: governed }), {
      partyTyped: false, established: false, basis: null,
    }, t);
  }
});

test('numeric confidence cannot establish a Party or confirm sameness', () => {
  const withConfidence = (confidence: number) =>
    ({ method: 'PSEUDONYMOUS', provenance: NO_GOVERNED_PROVENANCE, confidence }) as never;
  for (const c of [1, 0.99, 100]) {
    assert.equal(isGovernedPartyBasis(withConfidence(c)), false);
    assert.equal(partyEstablishment({ entityType: 'PERSON', bases: [withConfidence(c)] }).established, false);
    const link = { status: 'CONFIRMED', method: 'SESSION_CONTINUITY', provenance: NO_GOVERNED_PROVENANCE, confidence: c };
    assert.notEqual(partyLinkPosture([link as never]), 'CONFIRMED_SAME_PARTY');
  }
  // And nothing in the contract names confidence in code.
  const code = readFileSync(new URL('../src/party.ts', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ');
  assert.equal(/confidence/i.test(code), false);
});

test('posture: no links is UNRESOLVED', () => {
  assert.equal(partyLinkPosture([]), 'UNRESOLVED');
});

test('posture: a governed CONFIRMED link is CONFIRMED_SAME_PARTY', () => {
  assert.equal(partyLinkPosture([{ status: 'CONFIRMED', method: 'EXPLICIT_LINK', provenance: ACTOR }]), 'CONFIRMED_SAME_PARTY');
  assert.equal(partyLinkPosture([{ status: 'CONFIRMED', method: 'AUTHENTICATED', provenance: SELF }]), 'CONFIRMED_SAME_PARTY');
});

test('posture: an ungoverned CONFIRMED link is a POSSIBLE_MATCH, never confirmation', () => {
  assert.equal(partyLinkPosture([{ status: 'CONFIRMED', method: 'MANUAL', provenance: NO_GOVERNED_PROVENANCE }]), 'POSSIBLE_MATCH');
  assert.equal(partyLinkPosture([{ status: 'CONFIRMED', method: 'SESSION_CONTINUITY', provenance: EVERYTHING }]), 'POSSIBLE_MATCH');
  assert.equal(partyLinkPosture([{ status: 'CONFIRMED', method: 'HOUSEHOLD', provenance: EVERYTHING }]), 'POSSIBLE_MATCH');
});

test('posture: PROPOSED is a POSSIBLE_MATCH even with governed provenance', () => {
  assert.equal(partyLinkPosture([{ status: 'PROPOSED', method: 'MANUAL', provenance: ACTOR }]), 'POSSIBLE_MATCH');
});

test('posture: REJECTED and REVERSED keep their meaning and contribute nothing toward sameness', () => {
  assert.equal(partyLinkPosture([{ status: 'REJECTED', method: 'MANUAL', provenance: ACTOR }]), 'UNRESOLVED');
  assert.equal(partyLinkPosture([{ status: 'REVERSED', method: 'EXPLICIT_LINK', provenance: ACTOR }]), 'UNRESOLVED');
  assert.equal(
    partyLinkPosture([
      { status: 'REVERSED', method: 'EXPLICIT_LINK', provenance: ACTOR },
      { status: 'PROPOSED', method: 'MANUAL', provenance: NO_GOVERNED_PROVENANCE },
    ]),
    'POSSIBLE_MATCH',
  );
});

test('NO_GOVERNED_PROVENANCE is frozen', () => {
  assert.equal(Object.isFrozen(NO_GOVERNED_PROVENANCE), true);
  assert.deepEqual({ ...NO_GOVERNED_PROVENANCE }, {
    subjectAuthenticated: false, authorizedActorUserId: null, verificationRecorded: false,
  });
});
