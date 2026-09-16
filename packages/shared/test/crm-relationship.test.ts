// CRM Relationship, pure contract. Slice R1.
//
// WHAT THESE PROVE, against docs/architecture/relationship-participant.md and the
// Product decisions of 2026-09-15 (PD-F-01 to PD-F-04). Each test names the
// invariant (section 11) it holds.
//
// A RELATIONSHIP IS A HUMAN ASSERTION. No machine actor and no AI role can perform
// any act, whatever a grant says (invariant 9).
//
// THE TENANT IS NEVER A PARTY. An OWN kind has exactly one Party side; the owning
// side is the workspace itself and has no Party, no id and no seat in this contract
// (invariant 14, PD-F-01).
//
// A KIND NEVER DECIDES A PARTY TYPE. A side may CONSTRAIN which Party types may
// fill it. A wrong type is a refusal, never a correction (invariant 1).
//
// STATE IS A PROJECTION of an append-only log. Nothing is deleted: removal is END
// (it was true) or VOID (it never was), and VOIDED is final (invariant 5). There is
// no PROSPECTIVE state, because no Relationship is ever created to satisfy another
// record (invariant 15, PD-F-02).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

import {
  CRM_RELATIONSHIP_ACTS,
  CRM_RELATIONSHIP_ACT_ROLES,
  CRM_RELATIONSHIP_ACTOR_TYPES,
  CRM_RELATIONSHIP_ACTOR_TYPES_PERMITTED,
  CRM_RELATIONSHIP_CONTRACT_VERSION,
  CRM_RELATIONSHIP_EDITABLE_FIELDS,
  CRM_RELATIONSHIP_EVENT_TYPES,
  CRM_RELATIONSHIP_FORBIDDEN_ROLES,
  CRM_RELATIONSHIP_IMMUTABLE_FIELDS,
  CRM_RELATIONSHIP_KINDS,
  CRM_RELATIONSHIP_KIND_DEFINITIONS,
  CRM_RELATIONSHIP_REASON_REQUIRED,
  CRM_RELATIONSHIP_SIDES,
  CRM_RELATIONSHIP_STATES,
  CRM_RELATIONSHIP_STRUCTURES,
  crmRelationshipActPermitted,
  crmRelationshipEventRequiresReason,
  crmRelationshipFieldEditable,
  crmRelationshipKind,
  crmRelationshipNaturalKey,
  crmRelationshipRolePermits,
  crmRelationshipTransition,
  projectCrmRelationshipState,
  validateCrmRelationshipSides,
  type CrmRelationshipEventFact,
  type CrmRelationshipSideAssignment,
  type CrmRelationshipState,
} from '../src/crm-relationship';
import { IDENTITY_ACTOR_TYPES } from '../src/identity-authority';
import { PARTY_TYPES } from '../src/party';

const PERSON = (side: 'COUNTERPARTY' | 'A' | 'B', partyId: string): CrmRelationshipSideAssignment =>
  ({ side, partyId, partyType: 'PERSON' });
const COMPANY = (side: 'COUNTERPARTY' | 'A' | 'B', partyId: string): CrmRelationshipSideAssignment =>
  ({ side, partyId, partyType: 'COMPANY' });

function log(...types: string[]): CrmRelationshipEventFact[] {
  return types.map((type, i) => ({ sequence: i + 1, type }));
}

// --- 1. The approved vocabulary, exactly -------------------------------------------

test('the kinds are Product\'s approved list, with the sides and Party types they approved (PD-F-03)', () => {
  // The architecture record's section 9 table, transcribed. If this test and that
  // table ever disagree, one of them is a Product decision nobody made.
  const approved: [string, string, string[], Record<string, string[]>][] = [
    ['CLIENT', 'OWN', ['COUNTERPARTY'], { COUNTERPARTY: ['PERSON', 'COMPANY'] }],
    ['SUPPLIER', 'OWN', ['COUNTERPARTY'], { COUNTERPARTY: ['PERSON', 'COMPANY'] }],
    ['TALENT_REPRESENTATION', 'OWN', ['COUNTERPARTY'], { COUNTERPARTY: ['PERSON'] }],
    ['PARTNER', 'OWN', ['COUNTERPARTY'], { COUNTERPARTY: ['PERSON', 'COMPANY'] }],
    ['REPRESENTATION', 'THIRD_PARTY', ['A', 'B'], { A: ['PERSON', 'COMPANY'], B: ['PERSON', 'COMPANY'] }],
    ['SUPPLY', 'THIRD_PARTY', ['A', 'B'], { A: ['PERSON', 'COMPANY'], B: ['PERSON', 'COMPANY'] }],
    ['AFFILIATION', 'THIRD_PARTY', ['A', 'B'], { A: ['PERSON'], B: ['COMPANY'] }],
    ['PARTNERSHIP', 'THIRD_PARTY', ['A', 'B'], { A: ['PERSON', 'COMPANY'], B: ['PERSON', 'COMPANY'] }],
  ];
  assert.deepEqual([...CRM_RELATIONSHIP_KINDS], approved.map(([kind]) => kind));
  for (const [kind, structure, sides, types] of approved) {
    const def = crmRelationshipKind(kind);
    assert.ok(def, `${kind} is defined`);
    assert.equal(def.structure, structure, kind);
    assert.deepEqual(def.sides.map((s) => s.side), sides, kind);
    for (const side of def.sides) {
      assert.deepEqual([...side.partyTypes], types[side.side], `${kind}.${side.side}`);
      assert.ok(side.label.trim().length > 0, `${kind}.${side.side} reads as something`);
    }
  }
  assert.equal(CRM_RELATIONSHIP_KINDS.length, 8);
  assert.deepEqual([...CRM_RELATIONSHIP_STRUCTURES], ['OWN', 'THIRD_PARTY']);
  assert.equal(CRM_RELATIONSHIP_CONTRACT_VERSION, 'crm-relationship.v1');
  assert.equal(crmRelationshipKind('NOT_A_KIND'), null);
  assert.equal(crmRelationshipKind(null), null);
});

test('the vocabulary is frozen: a kind cannot be added or edited at runtime', () => {
  assert.ok(Object.isFrozen(CRM_RELATIONSHIP_KIND_DEFINITIONS));
  const [first] = CRM_RELATIONSHIP_KIND_DEFINITIONS;
  assert.ok(first && Object.isFrozen(first) && Object.isFrozen(first.sides));
  assert.throws(() => {
    (CRM_RELATIONSHIP_KIND_DEFINITIONS as unknown as { push: (x: unknown) => void }).push({ kind: 'SMUGGLED' });
  });
});

// --- 2. The tenant is never a Party (invariant 14, PD-F-01) -------------------------

test('invariant 14: an OWN kind has exactly one Party side, and the tenant is not it', () => {
  for (const def of CRM_RELATIONSHIP_KIND_DEFINITIONS) {
    if (def.structure !== 'OWN') continue;
    assert.equal(def.sides.length, 1, `${def.kind} carries one Party side only`);
    assert.equal(def.sides[0]?.side, 'COUNTERPARTY', def.kind);
  }
  // No side value names the workspace, so no Relationship can be given a tenant
  // Party even by a caller that wanted one.
  assert.deepEqual([...CRM_RELATIONSHIP_SIDES], ['COUNTERPARTY', 'A', 'B']);
  // Supplying a second side to an OWN kind is refused, not absorbed.
  assert.deepEqual(validateCrmRelationshipSides('CLIENT', [PERSON('COUNTERPARTY', 'p1'), COMPANY('A', 'tenant')]), [
    'SIDES_DO_NOT_MATCH_KIND',
  ]);
});

// --- 3. A kind never decides a Party type (invariant 1) -----------------------------

test('invariant 1: a kind is not a Party type, and a side constrains types without assigning one', () => {
  for (const kind of CRM_RELATIONSHIP_KINDS) {
    assert.ok(!(PARTY_TYPES as readonly string[]).includes(kind), `${kind} is not a Party type`);
  }
  for (const def of CRM_RELATIONSHIP_KIND_DEFINITIONS) {
    for (const side of def.sides) {
      assert.ok(side.partyTypes.length > 0, `${def.kind}.${side.side} permits something`);
      for (const t of side.partyTypes) {
        assert.ok((PARTY_TYPES as readonly string[]).includes(t), `${def.kind}.${side.side} permits only Party types`);
      }
    }
  }
  // A COMPANY on TALENT_REPRESENTATION is refused. The contract never answers with
  // a corrected Party type, and never reports the Party as a PERSON because the
  // kind says so -- Party type belongs to the Party authority.
  const given = COMPANY('COUNTERPARTY', 'c1');
  const violations = validateCrmRelationshipSides('TALENT_REPRESENTATION', [given]);
  assert.deepEqual(violations, ['PARTY_TYPE_NOT_PERMITTED_FOR_SIDE']);
  assert.deepEqual(given, { side: 'COUNTERPARTY', partyId: 'c1', partyType: 'COMPANY' }, 'the input is untouched');
});

test('sides are validated for shape only: unknown kind, wrong sides, blank id, one Party twice', () => {
  assert.deepEqual(validateCrmRelationshipSides('NOPE', [PERSON('A', 'p1')]), ['UNKNOWN_KIND']);
  assert.deepEqual(validateCrmRelationshipSides('REPRESENTATION', [PERSON('A', 'p1')]), ['SIDES_DO_NOT_MATCH_KIND']);
  assert.deepEqual(validateCrmRelationshipSides('REPRESENTATION', [PERSON('A', 'p1'), PERSON('COUNTERPARTY', 'p2')]), [
    'SIDES_DO_NOT_MATCH_KIND',
  ]);
  assert.deepEqual(validateCrmRelationshipSides('REPRESENTATION', [PERSON('A', '  '), PERSON('B', 'p2')]), ['MISSING_PARTY_ID']);
  assert.deepEqual(validateCrmRelationshipSides('PARTNERSHIP', [PERSON('A', 'p1'), PERSON('B', 'p1')]), ['SAME_PARTY_ON_BOTH_SIDES']);
  assert.deepEqual(validateCrmRelationshipSides('AFFILIATION', [PERSON('A', 'p1'), COMPANY('B', 'c1')]), []);
  assert.deepEqual(validateCrmRelationshipSides('AFFILIATION', [COMPANY('A', 'c1'), PERSON('B', 'p1')]), [
    'PARTY_TYPE_NOT_PERMITTED_FOR_SIDE',
  ]);
  assert.deepEqual(validateCrmRelationshipSides('CLIENT', [COMPANY('COUNTERPARTY', 'c1')]), []);
});

// --- 4. The natural key (invariant 4) ------------------------------------------------

test('the natural key is the kind and its stored Party ids -- directed or order-free', () => {
  const a = crmRelationshipNaturalKey('REPRESENTATION', [PERSON('A', 'p1'), COMPANY('B', 'c1')]);
  const swapped = crmRelationshipNaturalKey('REPRESENTATION', [COMPANY('B', 'c1'), PERSON('A', 'p1')]);
  assert.equal(a, swapped, 'the order the sides arrive in is not information');
  const reversed = crmRelationshipNaturalKey('REPRESENTATION', [PERSON('B', 'p1'), COMPANY('A', 'c1')]);
  assert.notEqual(a, reversed, 'who represents whom is information');
  const partnership = crmRelationshipNaturalKey('PARTNERSHIP', [PERSON('A', 'p1'), COMPANY('B', 'c1')]);
  assert.equal(partnership, crmRelationshipNaturalKey('PARTNERSHIP', [COMPANY('A', 'c1'), PERSON('B', 'p1')]), 'symmetric');
  assert.notEqual(a, crmRelationshipNaturalKey('SUPPLY', [PERSON('A', 'p1'), COMPANY('B', 'c1')]), 'the kind is part of the key');
  // Invariant 4: the key is built from the ids it was given. A superseded id keeps
  // its own key; nothing here shortens a chain or rewrites a stored reference.
  assert.ok(a.includes('p1') && a.includes('c1'));
});

// --- 5. Lifecycle (invariants 5 and 15) ---------------------------------------------

test('invariant 15: three states, and none of them is a placeholder (PD-F-02)', () => {
  assert.deepEqual([...CRM_RELATIONSHIP_STATES], ['ACTIVE', 'ENDED', 'VOIDED']);
  for (const absent of ['PROSPECTIVE', 'DRAFT', 'PLACEHOLDER', 'PENDING', 'INFERRED']) {
    assert.ok(!(CRM_RELATIONSHIP_STATES as readonly string[]).includes(absent), absent);
  }
  // A Relationship is only ever created as a live commercial fact.
  assert.equal(crmRelationshipTransition(null, 'ACTIVE'), 'RELATIONSHIP_CREATED');
  assert.equal(crmRelationshipTransition(null, 'ENDED'), null);
  assert.equal(crmRelationshipTransition(null, 'VOIDED'), null);
});

test('every transition, and only the approved ones', () => {
  const expected: Record<string, string | null> = {
    'ACTIVE>ENDED': 'RELATIONSHIP_ENDED',
    'ACTIVE>VOIDED': 'RELATIONSHIP_VOIDED',
    'ACTIVE>ACTIVE': null,
    'ENDED>ACTIVE': 'RELATIONSHIP_REACTIVATED',
    'ENDED>VOIDED': 'RELATIONSHIP_VOIDED',
    'ENDED>ENDED': null,
    'VOIDED>ACTIVE': null,
    'VOIDED>ENDED': null,
    'VOIDED>VOIDED': null,
  };
  for (const from of CRM_RELATIONSHIP_STATES) {
    for (const to of CRM_RELATIONSHIP_STATES) {
      assert.equal(crmRelationshipTransition(from, to), expected[`${from}>${to}`] ?? null, `${from} -> ${to}`);
    }
  }
  assert.equal(crmRelationshipTransition('ACTIVE', 'NONSENSE' as CrmRelationshipState), null);
});

test('invariant 5: state is a projection of the log, and detail events do not move it', () => {
  assert.deepEqual(projectCrmRelationshipState(log('RELATIONSHIP_CREATED')), { ok: true, state: 'ACTIVE', lastSequence: 1 });
  assert.deepEqual(
    projectCrmRelationshipState(log('RELATIONSHIP_CREATED', 'PARTICIPANT_ADDED', 'RELATIONSHIP_DETAILS_CHANGED', 'RELATIONSHIP_OWNER_CHANGED')),
    { ok: true, state: 'ACTIVE', lastSequence: 4 },
  );
  assert.deepEqual(projectCrmRelationshipState(log('RELATIONSHIP_CREATED', 'RELATIONSHIP_ENDED')), {
    ok: true, state: 'ENDED', lastSequence: 2,
  });
  assert.deepEqual(projectCrmRelationshipState(log('RELATIONSHIP_CREATED', 'RELATIONSHIP_ENDED', 'RELATIONSHIP_REACTIVATED')), {
    ok: true, state: 'ACTIVE', lastSequence: 3,
  });
  // Order of arrival is not order of history.
  assert.deepEqual(
    projectCrmRelationshipState([
      { sequence: 2, type: 'RELATIONSHIP_ENDED' },
      { sequence: 1, type: 'RELATIONSHIP_CREATED' },
    ]),
    { ok: true, state: 'ENDED', lastSequence: 2 },
  );
});

test('invariant 5: VOIDED is final, and a log that is not a history is refused, never repaired', () => {
  assert.deepEqual(projectCrmRelationshipState(log('RELATIONSHIP_CREATED', 'RELATIONSHIP_VOIDED')), {
    ok: true, state: 'VOIDED', lastSequence: 2,
  });
  for (const after of ['RELATIONSHIP_REACTIVATED', 'RELATIONSHIP_ENDED', 'RELATIONSHIP_DETAILS_CHANGED', 'PARTICIPANT_ADDED']) {
    assert.deepEqual(projectCrmRelationshipState(log('RELATIONSHIP_CREATED', 'RELATIONSHIP_VOIDED', after)), {
      ok: false, reason: 'ILLEGAL_TRANSITION',
    }, after);
  }
  assert.deepEqual(projectCrmRelationshipState([]), { ok: false, reason: 'EMPTY_LOG' });
  assert.deepEqual(projectCrmRelationshipState(log('RELATIONSHIP_ENDED')), { ok: false, reason: 'NOT_CREATED_FIRST' });
  assert.deepEqual(projectCrmRelationshipState(log('RELATIONSHIP_CREATED', 'RELATIONSHIP_CREATED')), {
    ok: false, reason: 'ILLEGAL_TRANSITION',
  });
  assert.deepEqual(projectCrmRelationshipState(log('RELATIONSHIP_CREATED', 'RELATIONSHIP_REACTIVATED')), {
    ok: false, reason: 'ILLEGAL_TRANSITION',
  });
  assert.deepEqual(projectCrmRelationshipState(log('RELATIONSHIP_CREATED', 'RELATIONSHIP_DELETED')), {
    ok: false, reason: 'UNKNOWN_EVENT',
  });
  assert.deepEqual(
    projectCrmRelationshipState([
      { sequence: 1, type: 'RELATIONSHIP_CREATED' },
      { sequence: 3, type: 'RELATIONSHIP_ENDED' },
    ]),
    { ok: false, reason: 'SEQUENCE_GAP' },
  );
  assert.deepEqual(
    projectCrmRelationshipState([
      { sequence: 1, type: 'RELATIONSHIP_CREATED' },
      { sequence: 1, type: 'RELATIONSHIP_ENDED' },
    ]),
    { ok: false, reason: 'SEQUENCE_GAP' },
  );
});

test('invariant 5: nothing is deleted -- removal is END or VOID, and both keep a reason', () => {
  for (const type of CRM_RELATIONSHIP_EVENT_TYPES) {
    assert.doesNotMatch(type, /DELETE|REMOVE|PURGE|MERGE/, type);
  }
  assert.deepEqual([...CRM_RELATIONSHIP_REASON_REQUIRED], [
    'RELATIONSHIP_ENDED', 'RELATIONSHIP_VOIDED', 'PARTICIPANT_ENDED', 'PARTICIPANT_VOIDED',
  ]);
  for (const type of CRM_RELATIONSHIP_REASON_REQUIRED) assert.equal(crmRelationshipEventRequiresReason(type), true, type);
  assert.equal(crmRelationshipEventRequiresReason('RELATIONSHIP_CREATED'), false);
  assert.equal(crmRelationshipEventRequiresReason('RELATIONSHIP_REACTIVATED'), false);
  // Fails closed: an event nobody has classified is treated as consequential.
  assert.equal(crmRelationshipEventRequiresReason('SOMETHING_NEW'), true);
});

test('what may change after creation, and what may not (section 3.3)', () => {
  for (const field of ['organizationId', 'kind', 'sides', 'createdByUserId', 'createdAt']) {
    assert.ok((CRM_RELATIONSHIP_IMMUTABLE_FIELDS as readonly string[]).includes(field), field);
    assert.equal(crmRelationshipFieldEditable(field), false, field);
  }
  for (const field of CRM_RELATIONSHIP_EDITABLE_FIELDS) {
    assert.equal(crmRelationshipFieldEditable(field), true, field);
    assert.ok(!(CRM_RELATIONSHIP_IMMUTABLE_FIELDS as readonly string[]).includes(field), field);
  }
  assert.equal(crmRelationshipFieldEditable('partyId'), false, 'a field nobody named is not editable');
  assert.equal(crmRelationshipFieldEditable('health'), false);
});

// --- 6. Authority (PD-F-04, invariant 9) --------------------------------------------

test('PD-F-04: the grants Product approved, role by role', () => {
  const HUMAN = ['OWNER', 'ADMIN', 'MANAGER', 'EMPLOYEE', 'READ_ONLY'];
  const approved: Record<string, string[]> = {
    VIEW: HUMAN,
    CREATE: ['OWNER', 'ADMIN', 'MANAGER', 'EMPLOYEE'],
    UPDATE_DETAILS: ['OWNER', 'ADMIN', 'MANAGER', 'EMPLOYEE'],
    CHANGE_OWNER: ['OWNER', 'ADMIN', 'MANAGER', 'EMPLOYEE'],
    ADD_PARTICIPANT: ['OWNER', 'ADMIN', 'MANAGER', 'EMPLOYEE'],
    CHANGE_PARTICIPANT: ['OWNER', 'ADMIN', 'MANAGER', 'EMPLOYEE'],
    END_RELATIONSHIP: ['OWNER', 'ADMIN', 'MANAGER'],
    REACTIVATE_RELATIONSHIP: ['OWNER', 'ADMIN', 'MANAGER'],
    END_PARTICIPANT: ['OWNER', 'ADMIN', 'MANAGER'],
    VOID_RELATIONSHIP: ['OWNER', 'ADMIN'],
    VOID_PARTICIPANT: ['OWNER', 'ADMIN'],
  };
  assert.deepEqual([...CRM_RELATIONSHIP_ACTS].sort(), Object.keys(approved).sort(), 'every act is granted or refused deliberately');
  for (const [act, roles] of Object.entries(approved)) {
    assert.deepEqual([...(CRM_RELATIONSHIP_ACT_ROLES as Record<string, readonly string[]>)[act]!], roles, act);
    for (const role of HUMAN) {
      assert.equal(crmRelationshipRolePermits(act, role), roles.includes(role), `${role} ${act}`);
    }
  }
  // The recorded reading: reactivation follows the end grant exactly, because it is
  // the inverse act and Product named only "end".
  assert.deepEqual(
    [...(CRM_RELATIONSHIP_ACT_ROLES.REACTIVATE_RELATIONSHIP)],
    [...(CRM_RELATIONSHIP_ACT_ROLES.END_RELATIONSHIP)],
  );
  assert.equal(crmRelationshipRolePermits('NOT_AN_ACT', 'OWNER'), false);
  assert.equal(crmRelationshipRolePermits('VIEW', 'NOT_A_ROLE'), false);
  assert.ok(Object.isFrozen(CRM_RELATIONSHIP_ACT_ROLES));
});

test('invariant 9: no machine performs a Relationship act, whatever role it is given', () => {
  // One actor vocabulary, the platform's own, so "machine" means the same thing in
  // identity and in CRM.
  assert.equal(CRM_RELATIONSHIP_ACTOR_TYPES, IDENTITY_ACTOR_TYPES);
  assert.deepEqual([...CRM_RELATIONSHIP_ACTOR_TYPES_PERMITTED], ['HUMAN']);
  for (const act of CRM_RELATIONSHIP_ACTS) {
    for (const actorType of ['MACHINE', 'AI']) {
      assert.equal(crmRelationshipActPermitted({ act, role: 'OWNER', actorType }), false, `${actorType} ${act}`);
    }
    assert.equal(crmRelationshipActPermitted({ act, role: 'OWNER', actorType: 'HUMAN' }), CRM_RELATIONSHIP_ACT_ROLES[act].includes('OWNER'), act);
    // An unknown actor type is not a person.
    assert.equal(crmRelationshipActPermitted({ act, role: 'OWNER', actorType: 'SYSTEM_PROCESS' }), false, act);
    assert.equal(crmRelationshipActPermitted({ act, role: 'OWNER', actorType: '' }), false, act);
  }
});

test('invariant 9: AI_EMPLOYEE holds no act, not even view, and cannot be granted one', () => {
  assert.deepEqual([...CRM_RELATIONSHIP_FORBIDDEN_ROLES], ['AI_EMPLOYEE']);
  for (const act of CRM_RELATIONSHIP_ACTS) {
    assert.equal(crmRelationshipRolePermits(act, 'AI_EMPLOYEE'), false, act);
    // Belt and braces: even if the table above were edited to list AI_EMPLOYEE, the
    // hard denial still refuses, as `identityResolution` does.
    assert.equal(crmRelationshipActPermitted({ act, role: 'AI_EMPLOYEE', actorType: 'HUMAN' }), false, act);
    assert.ok(!(CRM_RELATIONSHIP_ACT_ROLES as Record<string, readonly string[]>)[act]!.includes('AI_EMPLOYEE'), act);
  }
});

// --- 7. Fences ------------------------------------------------------------------------

const REPO = join(__dirname, '..', '..', '..');

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', '.next', 'dist', '.turbo', 'test', 'e2e', 'coverage'].includes(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
    }
  };
  for (const root of ['packages', 'apps']) walk(join(REPO, root));
  return out;
}

test('fence: the contract is pure, carries no contact value, and interprets nothing', () => {
  for (const file of ['crm-relationship.ts', 'crm-participant.ts']) {
    const src = stripComments(readFileSync(join(__dirname, '..', 'src', file), 'utf8'));
    assert.doesNotMatch(src, /Date\.now|new Date\(|Math\.random|process\.env|fetch\(|prisma|@prisma/i, file);
    // Invariant 6: no names or contact values, here or in anything derived from here.
    assert.doesNotMatch(src, /email|phone|displayName|canonicalKey|firstName|lastName|address/i, file);
    // Invariant 8: interpretation belongs to Commercial Intelligence, never to the
    // record of what is true. C-05: identity posture is never a number.
    assert.doesNotMatch(src, /health|sentiment|confidence|score|revenue|forecast|probability/i, file);
    // Invariant 9 and the Constitution: nothing here infers a commercial relationship.
    assert.doesNotMatch(src, /\binfer|\bpredict|autoLink|automatic/i, file);
    // Invariant 11: Relationships are never merged, automatically or otherwise.
    assert.doesNotMatch(src, /\bmerge/i, file);
  }
});

test('fence (invariant 12): CRM Relationship and Participant code never touches IdentityRelationship or IdentityRole', () => {
  const scanned: string[] = [];
  const offenders: string[] = [];
  for (const file of sourceFiles()) {
    const src = stripComments(readFileSync(file, 'utf8'));
    if (!/CRM_RELATIONSHIP_|CRM_PARTICIPANT_|crmRelationship|crmParticipant|CrmRelationship|CrmParticipant/.test(src)) continue;
    scanned.push(relative(REPO, file));
    if (/\b(identityRelationship|IdentityRelationship|identityRole|IdentityRole)\b/.test(src)) offenders.push(relative(REPO, file));
  }
  assert.deepEqual(offenders, [], 'the dormant identity tables stay confined');
  // A fence that scans nothing proves nothing.
  assert.ok(scanned.some((f) => f.endsWith('crm-relationship.ts')), 'the relationship contract was scanned');
  assert.ok(scanned.some((f) => f.endsWith('crm-participant.ts')), 'the participant contract was scanned');
});
