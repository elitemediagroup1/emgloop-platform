// Identity evidence, pure. Identity Slice 2.0.
//
// One test per row of the approved evidence policy matrix
// (docs/architecture/identity-evidence-resolution.md section 5). Also pinned:
// frequency never raises a tier or earns a suggestion; conflict overrides every
// match; unapproved and unavailable classes grant nothing; no machine
// attribution; the establishment bases available today are exactly what
// PartyService accepts; and nothing here is a confidence number.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  IDENTITY_EVIDENCE_KINDS,
  IDENTITY_ASSERTION_MODES,
  IDENTITY_EVIDENCE_TIERS,
  IDENTIFIER_FLAGS,
  IDENTIFIER_FLAG_STATES,
  IDENTITY_EVIDENCE_CLASS_RULES,
  IDENTITY_ESTABLISHMENT_METHODS_AVAILABLE_NOW,
  identityEvidenceClassRule,
  isIdentityEvidenceClass,
  isAvailableIdentityEvidenceClass,
  identityEvidenceTier,
  identityEvidenceConflict,
  suggestionAllowed,
  machineMayAttribute,
  mayEstablishAlone,
  identityEvidenceEstablishingMethods,
  identifierFlagTransitionAllowed,
  type IdentityEvidenceClass,
  type IdentityEvidenceObservation,
  type IdentityEvidenceTierFacts,
  type IdentitySuggestionFacts,
  type IdentifierFlagFact,
} from '../src/identity-evidence';
import { PARTY_CONFIRMING_METHODS, PARTY_NEVER_CONFIRMING_METHODS } from '../src/party';

const CALLER_ID: IdentityEvidenceClass = { kind: 'PHONE', mode: 'NETWORK_ASSERTED' };
const PHONE_TYPED: IdentityEvidenceClass = { kind: 'PHONE', mode: 'SUBJECT_PROVIDED' };
const PHONE_VERIFIED: IdentityEvidenceClass = { kind: 'PHONE', mode: 'VERIFIED' };
const EMAIL_TYPED: IdentityEvidenceClass = { kind: 'EMAIL', mode: 'SUBJECT_PROVIDED' };
const EMAIL_VERIFIED: IdentityEvidenceClass = { kind: 'EMAIL', mode: 'VERIFIED' };
const NAME_TYPED: IdentityEvidenceClass = { kind: 'NAME', mode: 'SUBJECT_PROVIDED' };
const FORM: IdentityEvidenceClass = { kind: 'FORM_SUBMISSION', mode: 'SUBJECT_PROVIDED' };
const VISITOR: IdentityEvidenceClass = { kind: 'VISITOR', mode: 'CONTINUITY' };
const SESSION: IdentityEvidenceClass = { kind: 'SESSION', mode: 'CONTINUITY' };
const AUTHENTICATED: IdentityEvidenceClass = { kind: 'AUTH_ACCOUNT', mode: 'AUTHENTICATED' };
const OPERATOR: IdentityEvidenceClass = { kind: 'OPERATOR_IDENTIFICATION', mode: 'OPERATOR_RECORDED' };

const CLEAN = { pointsAtParties: 1, flags: [] as IdentifierFlagFact[], partyType: 'PERSON' as const, contradictionRecorded: false };

function tier(observations: IdentityEvidenceObservation[], extra: Partial<IdentityEvidenceTierFacts> = {}) {
  return identityEvidenceTier({ ...CLEAN, observations, ...extra });
}

function suggest(candidate: IdentityEvidenceClass, extra: Partial<IdentitySuggestionFacts> = {}) {
  return suggestionAllowed({
    candidate,
    partiesWithVerifiedMatch: 1,
    flags: [],
    partyType: 'PERSON',
    contradictionRecorded: false,
    ...extra,
  });
}

// --- Vocabulary ------------------------------------------------------------------

test('the vocabularies are exactly the approved ones', () => {
  assert.deepEqual([...IDENTITY_EVIDENCE_KINDS], [
    'PHONE', 'EMAIL', 'NAME', 'VISITOR', 'SESSION', 'AUTH_ACCOUNT', 'FORM_SUBMISSION', 'OPERATOR_IDENTIFICATION',
  ]);
  assert.deepEqual([...IDENTITY_ASSERTION_MODES], [
    'CONTINUITY', 'NETWORK_ASSERTED', 'SUBJECT_PROVIDED', 'OPERATOR_RECORDED', 'VERIFIED', 'AUTHENTICATED',
  ]);
  assert.deepEqual([...IDENTITY_EVIDENCE_TIERS], ['ANONYMOUS', 'WEAK', 'MODERATE', 'STRONG', 'CONFLICTING']);
  assert.deepEqual([...IDENTIFIER_FLAGS], ['SHARED', 'BUSINESS_LINE', 'SUSPECT', 'RECYCLED']);
  assert.deepEqual([...IDENTIFIER_FLAG_STATES], ['PROPOSED', 'ACTIVE', 'DISMISSED', 'REVOKED']);
});

test('the matrix is frozen and names each class once', () => {
  assert.ok(Object.isFrozen(IDENTITY_EVIDENCE_CLASS_RULES));
  const keys = IDENTITY_EVIDENCE_CLASS_RULES.map((r) => `${r.kind}/${r.mode}`);
  assert.equal(new Set(keys).size, keys.length);
  for (const r of IDENTITY_EVIDENCE_CLASS_RULES) {
    assert.ok(Object.isFrozen(r) && Object.isFrozen(r.establishes));
  }
});

// --- One test per matrix row -------------------------------------------------------

test('matrix: caller ID alone is WEAK at any frequency, suggests only against exactly one verified phone, never establishes', () => {
  assert.equal(tier([CALLER_ID]), 'WEAK');
  assert.equal(tier([CALLER_ID], { occurrences: 500 }), 'WEAK');
  assert.equal(suggest(CALLER_ID), true);
  assert.equal(suggest(CALLER_ID, { partiesWithVerifiedMatch: 0 }), false);
  assert.equal(suggest(CALLER_ID, { partiesWithVerifiedMatch: 2 }), false);
  assert.equal(suggest(CALLER_ID, { flags: [{ flag: 'SHARED', state: 'ACTIVE' }] }), false);
  assert.equal(suggest(CALLER_ID, { flags: [{ flag: 'SUSPECT', state: 'ACTIVE' }] }), false);
  assert.equal(mayEstablishAlone(CALLER_ID), false);
  assert.deepEqual([...identityEvidenceEstablishingMethods(CALLER_ID)], []);
});

test('matrix: a subject-provided phone is MODERATE, suggests against exactly one verified phone, never establishes', () => {
  assert.equal(tier([PHONE_TYPED]), 'MODERATE');
  assert.equal(suggest(PHONE_TYPED), true);
  assert.equal(suggest(PHONE_TYPED, { partiesWithVerifiedMatch: 2 }), false);
  assert.equal(mayEstablishAlone(PHONE_TYPED), false);
});

test('matrix: a verified phone is STRONG and VERIFIED_PHONE by rule, and unavailable until verification exists', () => {
  const rule = identityEvidenceClassRule(PHONE_VERIFIED);
  assert.equal(rule?.tier, 'STRONG');
  assert.deepEqual([...(rule?.establishes ?? [])], ['VERIFIED_PHONE']);
  assert.equal(rule?.available, false);
  assert.equal(isAvailableIdentityEvidenceClass(PHONE_VERIFIED), false);
  assert.equal(tier([PHONE_VERIFIED]), 'ANONYMOUS', 'an unavailable class contributes nothing');
  assert.equal(suggest(PHONE_VERIFIED), false);
  assert.equal(mayEstablishAlone(PHONE_VERIFIED), false);
});

test('matrix: a subject-provided email is MODERATE, suggests against exactly one verified email, never establishes', () => {
  assert.equal(tier([EMAIL_TYPED]), 'MODERATE');
  assert.equal(suggest(EMAIL_TYPED), true);
  assert.equal(suggest(EMAIL_TYPED, { partiesWithVerifiedMatch: 0 }), false);
  assert.equal(mayEstablishAlone(EMAIL_TYPED), false);
});

test('matrix: a verified email is STRONG and VERIFIED_EMAIL by rule, and unavailable until verification exists', () => {
  const rule = identityEvidenceClassRule(EMAIL_VERIFIED);
  assert.equal(rule?.tier, 'STRONG');
  assert.deepEqual([...(rule?.establishes ?? [])], ['VERIFIED_EMAIL']);
  assert.equal(rule?.available, false);
  assert.equal(tier([EMAIL_VERIFIED]), 'ANONYMOUS');
  assert.equal(suggest(EMAIL_VERIFIED), false);
  assert.equal(mayEstablishAlone(EMAIL_VERIFIED), false);
});

test('matrix: name plus phone or email is as the contact value; a name never strengthens anything', () => {
  assert.equal(tier([NAME_TYPED, PHONE_TYPED]), 'MODERATE');
  assert.equal(tier([NAME_TYPED, EMAIL_TYPED]), 'MODERATE');
  assert.equal(tier([NAME_TYPED, CALLER_ID]), 'WEAK', 'a name does not lift caller ID');
  assert.equal(tier([NAME_TYPED, NAME_TYPED, NAME_TYPED]), 'WEAK');
  assert.equal(tier([NAME_TYPED]), 'WEAK');
  assert.equal(suggest(NAME_TYPED), false);
  assert.equal(mayEstablishAlone(NAME_TYPED), false);
});

test('matrix: a website form submission is judged per contact field, never on its own', () => {
  assert.equal(tier([FORM]), 'ANONYMOUS');
  assert.equal(tier([FORM, EMAIL_TYPED]), 'MODERATE');
  assert.equal(tier([FORM, NAME_TYPED]), 'WEAK');
  assert.equal(suggest(FORM), false);
  assert.equal(mayEstablishAlone(FORM), false);
});

test('matrix: session and visitor continuity are ANONYMOUS and never suggest a Person', () => {
  for (const c of [VISITOR, SESSION]) {
    assert.equal(tier([c]), 'ANONYMOUS');
    assert.equal(tier([c], { occurrences: 10_000 }), 'ANONYMOUS');
    assert.equal(suggest(c), false);
    assert.equal(suggest(c, { partyType: 'COMPANY' }), false);
    assert.equal(mayEstablishAlone(c), false);
  }
});

test('matrix: an authenticated act is STRONG and AUTHENTICATED by rule, and unavailable without end-customer authentication', () => {
  const rule = identityEvidenceClassRule(AUTHENTICATED);
  assert.equal(rule?.tier, 'STRONG');
  assert.deepEqual([...(rule?.establishes ?? [])], ['AUTHENTICATED']);
  assert.equal(rule?.available, false);
  assert.equal(tier([AUTHENTICATED]), 'ANONYMOUS');
  assert.equal(suggest(AUTHENTICATED), false);
  assert.equal(mayEstablishAlone(AUTHENTICATED), false);
});

test('matrix: explicit human identification is STRONG once confirmed, a MANUAL or EXPLICIT_LINK basis, and never a suggestion', () => {
  assert.equal(tier([OPERATOR]), 'WEAK');
  assert.equal(tier([{ ...OPERATOR, confirmed: false }]), 'WEAK');
  assert.equal(tier([{ ...OPERATOR, confirmed: true }]), 'STRONG');
  assert.equal(suggest(OPERATOR), false);
  assert.equal(mayEstablishAlone(OPERATOR), true);
  assert.deepEqual([...identityEvidenceEstablishingMethods(OPERATOR)], ['MANUAL', 'EXPLICIT_LINK']);
  // `confirmed` means nothing on any other class.
  assert.equal(tier([{ ...PHONE_TYPED, confirmed: true }]), 'MODERATE');
});

test('matrix: conflicting evidence is CONFLICTING and suggests nothing', () => {
  const strong: IdentityEvidenceObservation[] = [{ ...OPERATOR, confirmed: true }, EMAIL_TYPED];
  assert.equal(tier(strong, { pointsAtParties: 2 }), 'CONFLICTING');
  assert.equal(tier(strong, { contradictionRecorded: true }), 'CONFLICTING');
  for (const flag of ['SHARED', 'SUSPECT', 'RECYCLED'] as const) {
    assert.equal(tier(strong, { flags: [{ flag, state: 'ACTIVE' }] }), 'CONFLICTING', flag);
  }
  assert.equal(tier(strong, { flags: [{ flag: 'BUSINESS_LINE', state: 'ACTIVE' }], partyType: 'PERSON' }), 'CONFLICTING');
  assert.equal(identityEvidenceConflict({ ...CLEAN, pointsAtParties: 2 }), 'MULTIPLE_PARTIES');
  assert.equal(identityEvidenceConflict({ ...CLEAN, contradictionRecorded: true }), 'CONTRADICTION_RECORDED');
  assert.equal(identityEvidenceConflict({ ...CLEAN, flags: [{ flag: 'BUSINESS_LINE', state: 'ACTIVE' }] }), 'BUSINESS_LINE_FOR_PERSON');
  assert.equal(suggest(EMAIL_TYPED, { contradictionRecorded: true }), false);
});

// --- Conflict detail -------------------------------------------------------------

test('only ACTIVE flags conflict; a business line is evidence for a Company', () => {
  for (const state of ['PROPOSED', 'DISMISSED', 'REVOKED'] as const) {
    for (const flag of IDENTIFIER_FLAGS) {
      assert.equal(tier([EMAIL_TYPED], { flags: [{ flag, state }] }), 'MODERATE', `${flag} ${state}`);
    }
  }
  assert.equal(tier([PHONE_TYPED], { flags: [{ flag: 'BUSINESS_LINE', state: 'ACTIVE' }], partyType: 'COMPANY' }), 'MODERATE');
  assert.equal(suggest(PHONE_TYPED, { flags: [{ flag: 'BUSINESS_LINE', state: 'ACTIVE' }], partyType: 'COMPANY' }), true);
  assert.equal(suggest(PHONE_TYPED, { flags: [{ flag: 'BUSINESS_LINE', state: 'ACTIVE' }], partyType: 'PERSON' }), false);
});

test('unreadable Party counts fail closed as a conflict', () => {
  for (const pointsAtParties of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(identityEvidenceConflict({ ...CLEAN, pointsAtParties }), 'INVALID_FACTS');
    assert.equal(tier([EMAIL_TYPED], { pointsAtParties }), 'CONFLICTING');
  }
  assert.equal(tier([EMAIL_TYPED], { pointsAtParties: 0 }), 'MODERATE', 'unresolved evidence still has a tier');
});

// --- Mutations -----------------------------------------------------------------

const EVERY_CLASS: IdentityEvidenceClass[] = IDENTITY_EVIDENCE_KINDS.flatMap((kind) =>
  IDENTITY_ASSERTION_MODES.map((mode) => ({ kind, mode })),
);

test('frequency mutation: no count of occurrences changes any tier or earns any suggestion', () => {
  for (const c of EVERY_CLASS) {
    for (const confirmed of [false, true]) {
      const base = tier([{ ...c, confirmed }]);
      const baseSuggest = suggest(c);
      for (const occurrences of [0, 1, 2, 20, 1_000_000]) {
        assert.equal(tier([{ ...c, confirmed }], { occurrences }), base, `${c.kind}/${c.mode} x${occurrences}`);
        assert.equal(tier(Array.from({ length: Math.min(occurrences, 50) + 1 }, () => ({ ...c, confirmed }))), base);
        assert.equal(suggest(c, { occurrences }), baseSuggest);
      }
    }
  }
});

test('conflict mutation: adding any conflict to any evidence makes it CONFLICTING and removes every suggestion', () => {
  const conflicts: Partial<IdentityEvidenceTierFacts>[] = [
    { pointsAtParties: 2 },
    { contradictionRecorded: true },
    { flags: [{ flag: 'SHARED', state: 'ACTIVE' }] },
    { flags: [{ flag: 'SUSPECT', state: 'ACTIVE' }] },
    { flags: [{ flag: 'RECYCLED', state: 'ACTIVE' }] },
    { flags: [{ flag: 'BUSINESS_LINE', state: 'ACTIVE' }], partyType: 'PERSON' },
  ];
  for (const c of EVERY_CLASS) {
    for (const conflict of conflicts) {
      assert.equal(tier([{ ...c, confirmed: true }, EMAIL_TYPED], conflict), 'CONFLICTING');
      const { pointsAtParties, ...rest } = conflict;
      assert.equal(
        suggest(c, { ...rest, partiesWithVerifiedMatch: pointsAtParties ?? 1 }),
        false,
        `${c.kind}/${c.mode} ${JSON.stringify(conflict)}`,
      );
    }
  }
});

// --- Unapproved classes, attribution and establishment ----------------------------

test('a kind and mode outside the matrix is not a class and grants nothing', () => {
  const approved = new Set(IDENTITY_EVIDENCE_CLASS_RULES.map((r) => `${r.kind}/${r.mode}`));
  const unapproved = EVERY_CLASS.filter((c) => !approved.has(`${c.kind}/${c.mode}`));
  assert.ok(unapproved.length > 0);
  for (const c of unapproved) {
    assert.equal(isIdentityEvidenceClass(c), false);
    assert.equal(identityEvidenceClassRule(c), null);
    assert.equal(tier([{ ...c, confirmed: true }]), 'ANONYMOUS');
    assert.equal(suggest(c), false);
    assert.equal(mayEstablishAlone(c), false);
  }
  for (const junk of [null, undefined, 'PHONE', {}, { kind: 'PHONE' }, { kind: 'phone', mode: 'network_asserted' }]) {
    assert.equal(isIdentityEvidenceClass(junk), false);
  }
});

test('no machine identity attribution at launch', () => {
  assert.equal(machineMayAttribute(), false);
});

test('establishment agrees with the Party contract: only confirming methods, and only MANUAL and EXPLICIT_LINK today', () => {
  for (const r of IDENTITY_EVIDENCE_CLASS_RULES) {
    for (const m of r.establishes) {
      assert.ok((PARTY_CONFIRMING_METHODS as readonly string[]).includes(m), m);
      assert.ok(!(PARTY_NEVER_CONFIRMING_METHODS as readonly string[]).includes(m), m);
    }
  }
  assert.deepEqual([...IDENTITY_ESTABLISHMENT_METHODS_AVAILABLE_NOW].sort(), ['EXPLICIT_LINK', 'MANUAL']);
  const establishing = IDENTITY_EVIDENCE_CLASS_RULES.filter((r) => mayEstablishAlone(r)).map((r) => `${r.kind}/${r.mode}`);
  assert.deepEqual(establishing, ['OPERATOR_IDENTIFICATION/OPERATOR_RECORDED']);
});

test('tiers are labels from the vocabulary, never numbers', () => {
  for (const c of EVERY_CLASS) {
    const t = tier([{ ...c, confirmed: true }]);
    assert.equal(typeof t, 'string');
    assert.ok((IDENTITY_EVIDENCE_TIERS as readonly string[]).includes(t));
  }
});

// --- Identifier flags ------------------------------------------------------------

test('identifier flags: proposed or set, then dismissed or revoked, and never back', () => {
  const allowed = new Set(['null>PROPOSED', 'null>ACTIVE', 'PROPOSED>ACTIVE', 'PROPOSED>DISMISSED', 'ACTIVE>REVOKED']);
  for (const from of [null, ...IDENTIFIER_FLAG_STATES]) {
    for (const to of IDENTIFIER_FLAG_STATES) {
      assert.equal(identifierFlagTransitionAllowed(from, to), allowed.has(`${from}>${to}`), `${from} -> ${to}`);
    }
  }
});

// --- Source fence --------------------------------------------------------------

const SLICE_FILES = ['identity-evidence.ts', 'identity-authority.ts', 'evidence-use-policy.ts'];

function code(file: string): string {
  const src = readFileSync(join(__dirname, '..', 'src', file), 'utf8');
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/.*$/gm, '');
}

test('fence: the 2.0 contracts carry no confidence, score, probability or percentage', () => {
  for (const f of SLICE_FILES) {
    assert.doesNotMatch(code(f), /confidence|score|probabilit|percent/i, f);
  }
});

test('fence: the 2.0 contracts are pure -- no clock, randomness, environment, network or persistence', () => {
  for (const f of SLICE_FILES) {
    const c = code(f);
    assert.doesNotMatch(c, /Date\.now|new Date\(|Math\.random|process\.env|fetch\(|prisma|@emgloop\/database/i, f);
    for (const m of c.matchAll(/from '([^']+)'/g)) {
      assert.ok(['./party', './identity-evidence'].includes(m[1] ?? ''), `${f} imports ${m[1]}`);
    }
  }
});
