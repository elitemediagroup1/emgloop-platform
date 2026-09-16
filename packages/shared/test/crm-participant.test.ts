// CRM Participant, pure contract. Slice R1.
//
// WHAT THESE PROVE, against docs/architecture/relationship-participant.md sections
// 5-6 and PD-F-03 / PD-F-04 (2026-09-15).
//
// A ROLE IS A CAPACITY, NOT A CLASSIFICATION. A role may say which Party types may
// hold it; it never says what a Party IS. AGENCY does not make a record a Company,
// and a Company is not an Agency until somebody says so, in one subject, for a time
// (invariant 1).
//
// ONE PARTY, SEVERAL ROLES. The same Party may be BRAND and BILLING_CONTACT in the
// same Relationship; each is its own row and its own history (invariant 7).
//
// A PARTICIPANT IS NEVER A CREDENTIAL. Nothing here grants access, and nothing here
// can be mistaken for an authorization input (invariant 10).
//
// ONLY SUBJECTS THAT EXIST. RELATIONSHIP is available; OPPORTUNITY and CAMPAIGN are
// named for the future and refused today, because their authorities are not built
// (PD-F-02: no placeholder is created to satisfy a reference).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  CRM_PARTICIPANT_ENGAGEMENT_ROLES,
  CRM_PARTICIPANT_RESERVED_SUBJECT_KINDS,
  CRM_PARTICIPANT_ROLES,
  CRM_PARTICIPANT_ROLE_DEFINITIONS,
  CRM_PARTICIPANT_SIDE_FORBIDDEN_ACTS,
  CRM_PARTICIPANT_STATES,
  CRM_PARTICIPANT_SUBJECT_KINDS,
  CRM_PARTICIPANT_VIOLATIONS,
  crmParticipantActiveKey,
  crmParticipantRole,
  crmParticipantSideActAllowed,
  validateCrmParticipant,
  type CrmParticipantAssertion,
} from '../src/crm-participant';
import { CRM_RELATIONSHIP_ACTS } from '../src/crm-relationship';
import { PARTY_CAPACITIES } from '../src/party-reference';
import { PARTY_TYPES, type PartyType } from '../src/party';

function assertion(patch: Partial<CrmParticipantAssertion> = {}): CrmParticipantAssertion {
  return {
    subjectKind: 'RELATIONSHIP',
    relationshipKind: 'REPRESENTATION',
    role: 'AGENCY',
    partyType: 'COMPANY',
    side: 'A',
    actsForSide: null,
    ...patch,
  };
}

// --- 1. The approved vocabulary, exactly -------------------------------------------

test('the roles are Product\'s approved list, with the Party types they approved (PD-F-03)', () => {
  // The architecture record's section 9 table, transcribed.
  const approved: Record<string, { family: string; partyTypes: PartyType[] }> = {
    CREATOR: { family: 'CAPACITY', partyTypes: ['PERSON'] },
    EMPLOYEE: { family: 'CAPACITY', partyTypes: ['PERSON'] },
    BRAND: { family: 'CAPACITY', partyTypes: ['PERSON', 'COMPANY'] },
    AGENCY: { family: 'CAPACITY', partyTypes: ['PERSON', 'COMPANY'] },
    PUBLISHER: { family: 'CAPACITY', partyTypes: ['PERSON', 'COMPANY'] },
    BUYER: { family: 'CAPACITY', partyTypes: ['PERSON', 'COMPANY'] },
    VENDOR: { family: 'CAPACITY', partyTypes: ['PERSON', 'COMPANY'] },
    SOURCE: { family: 'CAPACITY', partyTypes: ['PERSON', 'COMPANY'] },
    PARTNER: { family: 'CAPACITY', partyTypes: ['PERSON', 'COMPANY'] },
    PRIMARY_CONTACT: { family: 'ENGAGEMENT', partyTypes: ['PERSON'] },
    DECISION_MAKER: { family: 'ENGAGEMENT', partyTypes: ['PERSON'] },
    BILLING_CONTACT: { family: 'ENGAGEMENT', partyTypes: ['PERSON'] },
  };
  assert.deepEqual([...CRM_PARTICIPANT_ROLES], Object.keys(approved));
  for (const [role, expected] of Object.entries(approved)) {
    const def = crmParticipantRole(role);
    assert.ok(def, `${role} is defined`);
    assert.equal(def.family, expected.family, role);
    assert.deepEqual([...def.partyTypes], expected.partyTypes, role);
  }
  // The capacity family IS the Party capacity vocabulary -- one list, not a copy.
  assert.deepEqual(CRM_PARTICIPANT_ROLE_DEFINITIONS.filter((r) => r.family === 'CAPACITY').map((r) => r.role), [...PARTY_CAPACITIES]);
  assert.deepEqual([...CRM_PARTICIPANT_ENGAGEMENT_ROLES], ['PRIMARY_CONTACT', 'DECISION_MAKER', 'BILLING_CONTACT']);
  assert.equal(crmParticipantRole('OWNER'), null);
  assert.equal(crmParticipantRole(undefined), null);
  assert.ok(Object.isFrozen(CRM_PARTICIPANT_ROLE_DEFINITIONS));
  assert.deepEqual([...CRM_PARTICIPANT_STATES], ['ACTIVE', 'ENDED', 'VOIDED']);
});

// --- 2. A role never decides a Party type (invariant 1) -----------------------------

test('invariant 1: a role is not a Party type, and constrains without classifying', () => {
  for (const role of CRM_PARTICIPANT_ROLES) {
    assert.ok(!(PARTY_TYPES as readonly string[]).includes(role), `${role} is not a Party type`);
  }
  for (const def of CRM_PARTICIPANT_ROLE_DEFINITIONS) {
    assert.ok(def.partyTypes.length > 0, `${def.role} permits something`);
    for (const t of def.partyTypes) {
      assert.ok((PARTY_TYPES as readonly string[]).includes(t), `${def.role} permits only Party types`);
    }
  }
  // A COMPANY offered as CREATOR is refused. The contract does not answer "then it
  // is a PERSON", and does not record a corrected type: Party type is the Party
  // authority's, and only a governed identity act changes it.
  const given = assertion({ role: 'CREATOR', partyType: 'COMPANY', relationshipKind: 'TALENT_REPRESENTATION', side: 'COUNTERPARTY' });
  assert.deepEqual(validateCrmParticipant(given), ['PARTY_TYPE_NOT_PERMITTED_FOR_ROLE', 'PARTY_TYPE_NOT_PERMITTED_FOR_SIDE']);
  assert.equal(given.partyType, 'COMPANY', 'the input is untouched');
  // The same Party type is fine in a role that permits it.
  assert.deepEqual(validateCrmParticipant(assertion({ role: 'AGENCY', partyType: 'COMPANY' })), []);
});

test('invariant 7: one Party may hold several roles in one subject, each its own row', () => {
  const brand = crmParticipantActiveKey('RELATIONSHIP', 'rel_1', 'party_1', 'BRAND', 'ACTIVE');
  const billing = crmParticipantActiveKey('RELATIONSHIP', 'rel_1', 'party_1', 'BILLING_CONTACT', 'ACTIVE');
  assert.notEqual(brand, billing, 'two roles, two active rows');
  assert.equal(brand, crmParticipantActiveKey('RELATIONSHIP', 'rel_1', 'party_1', 'BRAND', 'ACTIVE'), 'one active row per role');
  assert.notEqual(brand, crmParticipantActiveKey('RELATIONSHIP', 'rel_2', 'party_1', 'BRAND', 'ACTIVE'), 'per subject');
  assert.notEqual(brand, crmParticipantActiveKey('RELATIONSHIP', 'rel_1', 'party_2', 'BRAND', 'ACTIVE'), 'per Party');
  // History never competes for the key: an ended or voided row releases it, so the
  // same Party can hold the same role again later in a NEW row.
  assert.equal(crmParticipantActiveKey('RELATIONSHIP', 'rel_1', 'party_1', 'BRAND', 'ENDED'), null);
  assert.equal(crmParticipantActiveKey('RELATIONSHIP', 'rel_1', 'party_1', 'BRAND', 'VOIDED'), null);
});

// --- 3. Subjects that exist -----------------------------------------------------------

test('only RELATIONSHIP is an available subject; Opportunity and Campaign are refused until they exist', () => {
  assert.deepEqual([...CRM_PARTICIPANT_SUBJECT_KINDS], ['RELATIONSHIP']);
  assert.deepEqual([...CRM_PARTICIPANT_RESERVED_SUBJECT_KINDS], ['OPPORTUNITY', 'CAMPAIGN']);
  for (const reserved of CRM_PARTICIPANT_RESERVED_SUBJECT_KINDS) {
    assert.ok(!(CRM_PARTICIPANT_SUBJECT_KINDS as readonly string[]).includes(reserved), reserved);
    assert.deepEqual(validateCrmParticipant(assertion({ subjectKind: reserved })), ['SUBJECT_KIND_NOT_AVAILABLE'], reserved);
  }
  assert.deepEqual(validateCrmParticipant(assertion({ subjectKind: 'CUSTOMER' })), ['SUBJECT_KIND_NOT_AVAILABLE']);
  // An unavailable subject stops the check: nothing downstream is evaluated against
  // a subject the platform has no authority for.
  assert.equal(validateCrmParticipant(assertion({ subjectKind: 'OPPORTUNITY', role: 'NONSENSE' })).length, 1);
});

// --- 4. Sides (sections 3.1 and 6) ----------------------------------------------------

test('a Participant either fills a side or acts for one, never both and never neither', () => {
  assert.deepEqual(validateCrmParticipant(assertion({ side: 'A', actsForSide: 'B' })), ['BOTH_SIDE_AND_ACTS_FOR']);
  assert.deepEqual(validateCrmParticipant(assertion({ side: null, actsForSide: null })), ['MUST_BE_OR_ACT_FOR_A_SIDE']);
  assert.deepEqual(validateCrmParticipant(assertion({ side: null, actsForSide: 'B', role: 'PRIMARY_CONTACT', partyType: 'PERSON' })), []);
});

test('a side must belong to the kind, and must accept the Party type', () => {
  // COUNTERPARTY exists on OWN kinds only; A and B on THIRD_PARTY kinds only.
  assert.deepEqual(validateCrmParticipant(assertion({ side: 'COUNTERPARTY' })), ['SIDE_NOT_IN_KIND']);
  assert.deepEqual(
    validateCrmParticipant(assertion({ relationshipKind: 'CLIENT', side: 'A' })),
    ['SIDE_NOT_IN_KIND'],
  );
  assert.deepEqual(validateCrmParticipant(assertion({ relationshipKind: 'CLIENT', side: 'COUNTERPARTY' })), []);
  // AFFILIATION side A is PERSON-only; the role AGENCY would permit a Company, the
  // side does not, and the stricter of the two wins.
  assert.deepEqual(
    validateCrmParticipant(assertion({ relationshipKind: 'AFFILIATION', side: 'A', role: 'AGENCY', partyType: 'COMPANY' })),
    ['PARTY_TYPE_NOT_PERMITTED_FOR_SIDE'],
  );
  assert.deepEqual(validateCrmParticipant(assertion({ relationshipKind: 'NOT_A_KIND' })), ['UNKNOWN_RELATIONSHIP_KIND']);
  assert.deepEqual(validateCrmParticipant(assertion({ relationshipKind: null })), ['UNKNOWN_RELATIONSHIP_KIND']);
  assert.deepEqual(validateCrmParticipant(assertion({ role: 'NOT_A_ROLE' })), ['UNKNOWN_ROLE']);
  assert.deepEqual(
    validateCrmParticipant(assertion({ role: 'NOT_A_ROLE', relationshipKind: 'NOT_A_KIND' })),
    ['UNKNOWN_ROLE', 'UNKNOWN_RELATIONSHIP_KIND'],
  );
});

test('an engagement role acts for a side and never fills one', () => {
  for (const role of CRM_PARTICIPANT_ENGAGEMENT_ROLES) {
    assert.deepEqual(
      validateCrmParticipant(assertion({ role, partyType: 'PERSON', side: 'A', actsForSide: null })),
      ['ENGAGEMENT_ROLE_CANNOT_BE_A_SIDE'],
      role,
    );
    assert.deepEqual(validateCrmParticipant(assertion({ role, partyType: 'PERSON', side: null, actsForSide: 'A' })), [], role);
    // Engagement roles are PERSON-only: a company is not somebody's contact.
    assert.deepEqual(
      validateCrmParticipant(assertion({ role, partyType: 'COMPANY', side: null, actsForSide: 'A' })),
      ['PARTY_TYPE_NOT_PERMITTED_FOR_ROLE'],
      role,
    );
  }
  assert.deepEqual([...CRM_PARTICIPANT_VIOLATIONS].sort().filter((v, i, a) => a.indexOf(v) !== i), [], 'no duplicate violation names');
});

test('a Participant that fills a side is not ended or voided on its own (section 6)', () => {
  assert.deepEqual([...CRM_PARTICIPANT_SIDE_FORBIDDEN_ACTS], ['END_PARTICIPANT', 'VOID_PARTICIPANT']);
  for (const act of CRM_PARTICIPANT_SIDE_FORBIDDEN_ACTS) {
    assert.equal(crmParticipantSideActAllowed(act), false, act);
    assert.ok((CRM_RELATIONSHIP_ACTS as readonly string[]).includes(act), `${act} is a real act`);
  }
  assert.equal(crmParticipantSideActAllowed('ADD_PARTICIPANT'), true);
  assert.equal(crmParticipantSideActAllowed('CHANGE_PARTICIPANT'), true);
  assert.equal(crmParticipantSideActAllowed('VOID_RELATIONSHIP'), true, 'voiding the whole record is how a wrong side is corrected');
  assert.equal(crmParticipantSideActAllowed('DELETE_PARTICIPANT'), false, 'an act nobody named is not available');
});

// --- 5. Fences -------------------------------------------------------------------------

test('fence (invariant 10): a Participant grants nothing and is no authorization input', () => {
  const src = readFileSync(join(__dirname, '..', 'src', 'crm-participant.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(src, /permission|authoriz|canAccess|isAllowed|grant(s|ed)?\b/i);
  // It does not decide who may act either: that is the Relationship contract's act
  // table, bound to the evaluator in R3.
  assert.doesNotMatch(src, /SystemRole|OWNER|ADMIN|MANAGER|READ_ONLY/);
  // It never reaches for a User: Users are not Parties.
  assert.doesNotMatch(src, /userId|session|membership/i);
});
