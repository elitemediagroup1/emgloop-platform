// The CRM Contact Point contract (PD-F-05, Product 2026-10-06; docs/architecture/crm-contact-points.md).
// Pure: normalization, classification fit, provenance, lifecycle, grants, exact matching, retention.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CRM_CONTACT_POINT_ACTS,
  CRM_CONTACT_POINT_ACT_ROLES,
  crmContactPointActPermitted,
  crmContactPointCurrentKey,
  crmContactPointHashNamespace,
  crmContactPointReasonCarriesContactValue,
  crmContactPointRetainUntil,
  crmContactPointSourceRefValid,
  crmContactPointTransition,
  decideCrmContactPointMatch,
  normalizeCrmContactPointValue,
  projectCrmContactPointState,
  validateCrmContactPointAdd,
  type PartyReferenceResolution,
} from '../src';

test('emails normalize to one lower-cased form; malformed addresses are refused', () => {
  assert.deepEqual(normalizeCrmContactPointValue('EMAIL', '  Jane.Doe@Brand.COM '), { ok: true, value: 'jane.doe@brand.com' });
  for (const bad of ['', '   ', 'jane', 'jane@', '@brand.com', 'jane@brand', 'a@b@c.com', 'jane doe@brand.com', 'Jane <jane@brand.com>']) {
    assert.equal(normalizeCrmContactPointValue('EMAIL', bad).ok, false, bad);
  }
  assert.equal(normalizeCrmContactPointValue('EMAIL', `${'a'.repeat(250)}@b.com`).ok, false, 'over 254 characters');
  assert.deepEqual(normalizeCrmContactPointValue('FAX', 'x'), { ok: false, reason: 'UNKNOWN_KIND' });
  assert.deepEqual(normalizeCrmContactPointValue('EMAIL', 42), { ok: false, reason: 'EMPTY' });
});

test('phones must be international; Loop never guesses a country code', () => {
  assert.deepEqual(normalizeCrmContactPointValue('PHONE', '+1 (555) 010-2030'), { ok: true, value: '+15550102030' });
  assert.deepEqual(normalizeCrmContactPointValue('PHONE', '+44 20 7946 0958'), { ok: true, value: '+442079460958' });
  for (const bad of ['555-010-2030', '15550102030', '+0 555 010', '+1 555', '+1234567890123456', 'call me']) {
    assert.deepEqual(normalizeCrmContactPointValue('PHONE', bad), { ok: false, reason: 'INVALID_PHONE' }, bad);
  }
});

test('classification must fit the Party type: an unnamed address can never become a Person', () => {
  const base = { kind: 'EMAIL', purpose: 'BUSINESS_CONTACT', basis: 'OPERATOR_RECORDED', sourceRef: null } as const;
  assert.deepEqual(validateCrmContactPointAdd({ ...base, classification: 'INDIVIDUAL', partyType: 'PERSON' }), []);
  assert.deepEqual(validateCrmContactPointAdd({ ...base, classification: 'ROLE_INBOX', partyType: 'COMPANY' }), []);
  assert.deepEqual(validateCrmContactPointAdd({ ...base, classification: 'UNATTRIBUTED', partyType: 'COMPANY' }), []);
  assert.deepEqual(validateCrmContactPointAdd({ ...base, classification: 'INDIVIDUAL', partyType: 'COMPANY' }), ['CLASSIFICATION_NOT_PERMITTED_FOR_PARTY_TYPE']);
  assert.deepEqual(validateCrmContactPointAdd({ ...base, classification: 'ROLE_INBOX', partyType: 'PERSON' }), ['CLASSIFICATION_NOT_PERMITTED_FOR_PARTY_TYPE']);
  assert.deepEqual(validateCrmContactPointAdd({ ...base, classification: 'UNATTRIBUTED', partyType: 'PERSON' }), ['CLASSIFICATION_NOT_PERMITTED_FOR_PARTY_TYPE']);
  assert.deepEqual(validateCrmContactPointAdd({ ...base, classification: 'PRIMARY', partyType: 'PERSON' }), ['UNKNOWN_CLASSIFICATION']);
  assert.deepEqual(validateCrmContactPointAdd({ ...base, kind: 'FAX', classification: 'INDIVIDUAL', partyType: 'PERSON' }), ['UNKNOWN_KIND']);
  assert.deepEqual(validateCrmContactPointAdd({ ...base, purpose: 'MARKETING', classification: 'INDIVIDUAL', partyType: 'PERSON' }), ['UNKNOWN_PURPOSE']);
});

test('provenance: an import must name its source; nothing else may; a reference can never carry a value', () => {
  const base = { kind: 'EMAIL', classification: 'ROLE_INBOX', partyType: 'COMPANY', purpose: 'BUSINESS_CONTACT' } as const;
  assert.deepEqual(validateCrmContactPointAdd({ ...base, basis: 'IMPORTED', sourceRef: 'import:batch-1:row-12' }), []);
  assert.deepEqual(validateCrmContactPointAdd({ ...base, basis: 'IMPORTED', sourceRef: null }), ['SOURCE_REF_REQUIRED']);
  assert.deepEqual(validateCrmContactPointAdd({ ...base, basis: 'IMPORTED', sourceRef: 'row:jane@brand.com' }), ['SOURCE_REF_INVALID']);
  assert.deepEqual(validateCrmContactPointAdd({ ...base, basis: 'IMPORTED', sourceRef: 'row:5550102030' }), ['SOURCE_REF_INVALID']);
  assert.deepEqual(validateCrmContactPointAdd({ ...base, basis: 'OPERATOR_RECORDED', sourceRef: 'import:x' }), ['SOURCE_REF_NOT_PERMITTED']);
  assert.deepEqual(validateCrmContactPointAdd({ ...base, basis: 'LEGITIMATE_INTERESTS', sourceRef: null }), ['UNKNOWN_BASIS'], 'no legal conclusion is a basis');
  assert.equal(crmContactPointSourceRefValid('import:2026-10-06:row-1076'), true, 'dates and row numbers are not contact values');
});

test('a reason that carries a contact value is detected; an ordinary reason is not', () => {
  assert.equal(crmContactPointReasonCarriesContactValue('Bounced; use jane.doe@brand.com instead'), true);
  assert.equal(crmContactPointReasonCarriesContactValue('New number (555) 010-2030'), true);
  assert.equal(crmContactPointReasonCarriesContactValue('+44 20 7946 0958'), true);
  assert.equal(crmContactPointReasonCarriesContactValue('Left the company in October 2026'), false);
  assert.equal(crmContactPointReasonCarriesContactValue('Delivery failure on 2026-10-04'), false);
});

test('the lifecycle: add, mark undeliverable, retire, void -- no reactivation, nothing after VOIDED', () => {
  assert.equal(crmContactPointTransition(null, 'ACTIVE'), 'CONTACT_POINT_ADDED');
  assert.equal(crmContactPointTransition(null, 'RETIRED'), null);
  assert.equal(crmContactPointTransition('ACTIVE', 'UNDELIVERABLE'), 'CONTACT_POINT_MARKED_UNDELIVERABLE');
  assert.equal(crmContactPointTransition('ACTIVE', 'RETIRED'), 'CONTACT_POINT_RETIRED');
  assert.equal(crmContactPointTransition('UNDELIVERABLE', 'RETIRED'), 'CONTACT_POINT_RETIRED');
  assert.equal(crmContactPointTransition('RETIRED', 'VOIDED'), 'CONTACT_POINT_VOIDED');
  assert.equal(crmContactPointTransition('UNDELIVERABLE', 'ACTIVE'), null, 'no reactivation was approved');
  assert.equal(crmContactPointTransition('RETIRED', 'ACTIVE'), null);
  assert.equal(crmContactPointTransition('RETIRED', 'UNDELIVERABLE'), null);
  for (const to of ['ACTIVE', 'UNDELIVERABLE', 'RETIRED', 'VOIDED'] as const) assert.equal(crmContactPointTransition('VOIDED', to), null);
});

test('state is the projection of the log; an invalid history is refused, never repaired', () => {
  assert.deepEqual(projectCrmContactPointState([{ sequence: 1, type: 'CONTACT_POINT_ADDED' }, { sequence: 2, type: 'CONTACT_POINT_MARKED_UNDELIVERABLE' }, { sequence: 3, type: 'CONTACT_POINT_RETIRED' }]), { ok: true, state: 'RETIRED', lastSequence: 3 });
  assert.deepEqual(projectCrmContactPointState([]), { ok: false, reason: 'EMPTY_LOG' });
  assert.deepEqual(projectCrmContactPointState([{ sequence: 1, type: 'CONTACT_POINT_ADDED' }, { sequence: 3, type: 'CONTACT_POINT_RETIRED' }]), { ok: false, reason: 'SEQUENCE_GAP' });
  assert.deepEqual(projectCrmContactPointState([{ sequence: 1, type: 'CONTACT_POINT_RETIRED' }]), { ok: false, reason: 'ILLEGAL_TRANSITION' });
  assert.deepEqual(projectCrmContactPointState([{ sequence: 1, type: 'CONTACT_POINT_ADDED' }, { sequence: 2, type: 'CONTACT_POINT_REACTIVATED' }]), { ok: false, reason: 'UNKNOWN_EVENT' });
});

test('the approved grant matrix, exactly; AI_EMPLOYEE and machines hold nothing', () => {
  const expected: Record<string, readonly string[]> = {
    VIEW_SUMMARY: ['OWNER', 'ADMIN', 'MANAGER', 'EMPLOYEE', 'READ_ONLY'],
    VIEW_VALUE: ['OWNER', 'ADMIN', 'MANAGER', 'EMPLOYEE'],
    ADD: ['OWNER', 'ADMIN', 'MANAGER', 'EMPLOYEE'],
    MARK_UNDELIVERABLE: ['OWNER', 'ADMIN', 'MANAGER'],
    RETIRE: ['OWNER', 'ADMIN', 'MANAGER'],
    VOID: ['OWNER', 'ADMIN'],
    MATCH: ['OWNER', 'ADMIN', 'MANAGER', 'EMPLOYEE'],
  };
  assert.deepEqual(Object.keys(CRM_CONTACT_POINT_ACT_ROLES).sort(), [...CRM_CONTACT_POINT_ACTS].sort());
  for (const act of CRM_CONTACT_POINT_ACTS) {
    for (const role of ['OWNER', 'ADMIN', 'MANAGER', 'EMPLOYEE', 'READ_ONLY', 'AI_EMPLOYEE', 'CREATOR', 'UNKNOWN']) {
      assert.equal(crmContactPointActPermitted({ act, role, actorType: 'HUMAN' }), expected[act]!.includes(role), `${act} ${role}`);
      assert.equal(crmContactPointActPermitted({ act, role, actorType: 'SYSTEM' }), false, `machine ${act} ${role}`);
    }
  }
  assert.equal(crmContactPointActPermitted({ act: 'READ_NOTES', role: 'OWNER', actorType: 'HUMAN' }), false, 'an unknown act fails closed');
});

const established = (partyId: string, partyType: 'PERSON' | 'COMPANY'): PartyReferenceResolution => ({ state: 'ESTABLISHED', partyId, partyType, archived: false });

test('exact matching: exactly one ACTIVE point on one established Party of the right type, or a review outcome', () => {
  assert.deepEqual(decideCrmContactPointMatch([], null, 'COMPANY'), { outcome: 'NO_MATCH' });
  assert.deepEqual(decideCrmContactPointMatch([{ partyId: 'p1', state: 'ACTIVE' }], established('p1', 'COMPANY'), 'COMPANY'), { outcome: 'MATCH', partyId: 'p1' });
  assert.deepEqual(decideCrmContactPointMatch([{ partyId: 'p1', state: 'ACTIVE' }, { partyId: 'p2', state: 'ACTIVE' }], null, 'COMPANY'), { outcome: 'CONFLICT' });
  assert.deepEqual(decideCrmContactPointMatch([{ partyId: 'p1', state: 'ACTIVE' }, { partyId: 'p2', state: 'UNDELIVERABLE' }], null, 'COMPANY'), { outcome: 'CONFLICT' }, 'an undeliverable holder still conflicts');
  assert.deepEqual(decideCrmContactPointMatch([{ partyId: 'p1', state: 'UNDELIVERABLE' }], established('p1', 'COMPANY'), 'COMPANY'), { outcome: 'INACTIVE_MATCH' });
  assert.deepEqual(decideCrmContactPointMatch([{ partyId: 'p1', state: 'ACTIVE' }], established('p1', 'PERSON'), 'COMPANY'), { outcome: 'TYPE_MISMATCH' });
  assert.deepEqual(decideCrmContactPointMatch([{ partyId: 'p1', state: 'ACTIVE' }], { state: 'SUPERSEDED', partyId: 'p1', canonicalPartyId: 'p9', partyType: 'COMPANY' } as PartyReferenceResolution, 'COMPANY'), { outcome: 'PARTY_NOT_REFERENCEABLE' });
  assert.deepEqual(decideCrmContactPointMatch([{ partyId: 'p1', state: 'ACTIVE' }], { ...established('p1', 'COMPANY'), archived: true }, 'COMPANY'), { outcome: 'PARTY_NOT_REFERENCEABLE' });
  assert.deepEqual(decideCrmContactPointMatch([{ partyId: 'p1', state: 'ACTIVE' }], { state: 'NOT_ESTABLISHED', partyId: 'p1', partyType: 'COMPANY', archived: false }, 'COMPANY'), { outcome: 'PARTY_NOT_REFERENCEABLE' });
  assert.deepEqual(decideCrmContactPointMatch([{ partyId: 'p1', state: 'ACTIVE' }], null, 'COMPANY'), { outcome: 'PARTY_NOT_REFERENCEABLE' }, 'an unresolved holder is never assumed');
  assert.deepEqual(decideCrmContactPointMatch([{ partyId: 'p1', state: 'RETIRED' }], null, 'COMPANY'), { outcome: 'NO_MATCH' }, 'history is not a holder');
});

test('keys and hash namespaces never carry a value and never collide with identity evidence', () => {
  assert.equal(crmContactPointCurrentKey('p1', 'EMAIL', 'abc'), 'p1|EMAIL|abc');
  assert.equal(crmContactPointHashNamespace('EMAIL'), 'crm.contact_point.EMAIL');
  assert.notEqual(crmContactPointHashNamespace('EMAIL'), 'EMAIL', 'evidence hashes EMAIL under the bare kind');
});

test('retention: 36 months after the latest human contact, else after adding; unknown policy keeps the value', () => {
  const addedAt = new Date('2026-10-06T13:00:00Z');
  assert.equal(crmContactPointRetainUntil({ retentionPolicy: 'crm.contact_point.retention.v1', lastHumanContactAt: null, addedAt })?.toISOString(), '2029-10-06T13:00:00.000Z');
  assert.equal(
    crmContactPointRetainUntil({ retentionPolicy: 'crm.contact_point.retention.v1', lastHumanContactAt: new Date('2027-01-31T00:00:00Z'), addedAt })?.toISOString(),
    '2030-01-31T00:00:00.000Z',
  );
  assert.equal(crmContactPointRetainUntil({ retentionPolicy: 'org.custom.v9', lastHumanContactAt: null, addedAt }), null);
});
