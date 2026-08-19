// Reconciliation — the arithmetic that has to add up before anything is concluded.
//
// The day this file is shaped by: 2026-08-05, where a certified provider read
// returned 974 identities and Loop held 867. Every case below is a way that
// comparison can go wrong, and the property under test is always the same one —
// an unaccounted-for record must never quietly leave the arithmetic.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  RECONCILIATION_SEVERITY,
  RECONCILIATION_STATES,
  countProblems,
  countsCoherent,
  deriveReconciliationState,
  memberFact,
  mostSevereReconciliationState,
  providerOnlySplitTotal,
  reconciliationCertifies,
  type ReconciliationCounts,
  type ReconciliationMemberFact,
} from '../src/index';

function counts(over: Partial<ReconciliationCounts> = {}): ReconciliationCounts {
  return {
    providerUnique: 10,
    providerDuplicateIds: 0,
    localUnique: 10,
    localDuplicateIds: 0,
    intersection: 10,
    providerOnly: 0,
    localOnly: 0,
    providerOnlyExpected: 0,
    providerOnlyNotConfigured: 0,
    providerOnlyExcluded: 0,
    providerOnlyUnknownMember: 0,
    ...over,
  };
}

function member(over: Partial<ReconciliationMemberFact> = {}): ReconciliationMemberFact {
  return {
    dimension: 'CAMPAIGN',
    memberExternalId: 'camp-a',
    providerCount: 10,
    localCount: 10,
    providerOnly: 0,
    expectation: 'EXPECTED',
    ...over,
  };
}

// --- 1. Severity ordering ------------------------------------------------------------

test('severity ascends: reconciled, unreconciled, unknown expectation, inconclusive', () => {
  assert.deepEqual(
    [...RECONCILIATION_STATES].sort((a, b) => RECONCILIATION_SEVERITY[a] - RECONCILIATION_SEVERITY[b]),
    ['RECONCILED', 'UNRECONCILED', 'UNKNOWN_EXPECTATION', 'INCONCLUSIVE'],
  );
});

test('an unbounded question outranks a bounded defect', () => {
  assert.ok(
    RECONCILIATION_SEVERITY.UNKNOWN_EXPECTATION > RECONCILIATION_SEVERITY.UNRECONCILED,
    'we do not yet know how large an undeclared gap is; we do know how large a declared one is',
  );
});

test('the most severe of several days wins, and an empty list objects to nothing', () => {
  assert.equal(mostSevereReconciliationState([]), 'RECONCILED');
  assert.equal(
    mostSevereReconciliationState(['RECONCILED', 'UNRECONCILED', 'UNKNOWN_EXPECTATION']),
    'UNKNOWN_EXPECTATION',
  );
  assert.equal(mostSevereReconciliationState(['INCONCLUSIVE', 'UNKNOWN_EXPECTATION']), 'INCONCLUSIVE');
});

test('only RECONCILED certifies, and the absence of a fact certifies nothing', () => {
  assert.equal(reconciliationCertifies('RECONCILED'), true);
  assert.equal(reconciliationCertifies('UNRECONCILED'), false);
  assert.equal(reconciliationCertifies('UNKNOWN_EXPECTATION'), false);
  assert.equal(reconciliationCertifies('INCONCLUSIVE'), false);
  assert.equal(reconciliationCertifies(null), false);
  assert.equal(reconciliationCertifies(undefined), false);
});

// --- 2. The arithmetic ----------------------------------------------------------------

test('THE INVARIANT: the four-way split must sum to providerOnly', () => {
  const split = counts({
    providerUnique: 974,
    localUnique: 867,
    intersection: 867,
    providerOnly: 107,
    providerOnlyExpected: 1,
    providerOnlyNotConfigured: 9,
    providerOnlyExcluded: 0,
    providerOnlyUnknownMember: 97,
  });
  assert.equal(providerOnlySplitTotal(split), 107);
  assert.deepEqual(countProblems(split), [], 'the August 5 shape adds up exactly');
});

test('a split that loses a record is rejected, not rounded', () => {
  const lossy = counts({
    providerUnique: 974,
    localUnique: 867,
    intersection: 867,
    providerOnly: 107,
    providerOnlyExpected: 1,
    providerOnlyNotConfigured: 9,
    providerOnlyExcluded: 0,
    providerOnlyUnknownMember: 96, // one record has silently left the arithmetic
  });
  assert.equal(countsCoherent(lossy), false);
  assert.ok(countProblems(lossy).some((p) => p.includes('does not sum to providerOnly')));
});

test('both set equations are checked, not just one', () => {
  assert.ok(
    countProblems(counts({ providerUnique: 11, providerOnly: 0, intersection: 10 })).some((p) =>
      p.includes('providerUnique'),
    ),
  );
  assert.ok(
    countProblems(counts({ localUnique: 11, localOnly: 0, intersection: 10 })).some((p) =>
      p.includes('localUnique'),
    ),
  );
});

test('a negative or fractional count is a defect in the counter, not the data', () => {
  assert.equal(countsCoherent(counts({ providerOnly: -1 })), false);
  assert.equal(countsCoherent(counts({ intersection: 1.5 })), false);
});

// --- 3. Deriving the day's verdict -------------------------------------------------------

test('a clean day reconciles', () => {
  assert.equal(deriveReconciliationState(counts(), [member()]), 'RECONCILED');
});

test('incoherent arithmetic is INCONCLUSIVE — nothing may be read from it', () => {
  const broken = counts({ providerOnly: 5, providerOnlyExpected: 4 });
  assert.equal(deriveReconciliationState(broken, [member({ providerOnly: 5 })]), 'INCONCLUSIVE');
});

test('records Loop holds that the provider did not return are INCONCLUSIVE, not a gap', () => {
  // The two populations are not describing the same thing. That impeaches the
  // comparison rather than reporting a hole in it.
  const c = counts({ localUnique: 12, localOnly: 2 });
  assert.equal(deriveReconciliationState(c, [member()]), 'INCONCLUSIVE');
});

test('an absence from an undeclared campaign is UNKNOWN_EXPECTATION', () => {
  const c = counts({ providerUnique: 12, providerOnly: 2, providerOnlyUnknownMember: 2 });
  const m = [member(), member({ memberExternalId: 'camp-x', providerOnly: 2, expectation: 'UNKNOWN' })];
  assert.equal(deriveReconciliationState(c, m), 'UNKNOWN_EXPECTATION');
});

test('an undeclared campaign with NOTHING missing does not block the day', () => {
  // Declaring a campaign matters when something is absent. A campaign that
  // delivered everything it had raises no question to answer.
  const m = [member(), member({ memberExternalId: 'camp-x', providerOnly: 0, expectation: 'UNKNOWN' })];
  assert.equal(deriveReconciliationState(counts(), m), 'RECONCILED');
});

test('an expected absence is UNRECONCILED', () => {
  const c = counts({ providerUnique: 11, providerOnly: 1, providerOnlyExpected: 1 });
  assert.equal(deriveReconciliationState(c, [member({ providerOnly: 1 })]), 'UNRECONCILED');
});

test('a not-configured campaign contributes absences and no defect', () => {
  const c = counts({ providerUnique: 16, providerOnly: 6, providerOnlyNotConfigured: 6 });
  const m = [member(), member({ memberExternalId: 'camp-silent', providerCount: 6, localCount: 0, providerOnly: 6, expectation: 'NOT_CONFIGURED' })];
  assert.equal(deriveReconciliationState(c, m), 'RECONCILED', 'it was never going to deliver them');
});

test('an excluded campaign is counted, never subtracted', () => {
  const c = counts({ providerUnique: 13, providerOnly: 3, providerOnlyExcluded: 3 });
  const m = [member(), member({ memberExternalId: 'camp-test', providerCount: 3, localCount: 0, providerOnly: 3, expectation: 'EXCLUDED' })];
  assert.equal(deriveReconciliationState(c, m), 'RECONCILED');
  assert.equal(providerOnlySplitTotal(c), 3, 'the records remain in the arithmetic');
});

test('THE AUGUST 5 SHAPE: an undeclared campaign outranks a single expected absence', () => {
  const c = counts({
    providerUnique: 974,
    localUnique: 867,
    intersection: 867,
    providerOnly: 107,
    providerOnlyExpected: 1,
    providerOnlyNotConfigured: 9,
    providerOnlyUnknownMember: 97,
  });
  const m = [
    member({ memberExternalId: 'camp-delivering', providerCount: 622, localCount: 621, providerOnly: 1, expectation: 'EXPECTED' }),
    member({ memberExternalId: 'camp-silent-a', providerCount: 6, localCount: 0, providerOnly: 6, expectation: 'NOT_CONFIGURED' }),
    member({ memberExternalId: 'camp-silent-b', providerCount: 3, localCount: 0, providerOnly: 3, expectation: 'NOT_CONFIGURED' }),
    member({ memberExternalId: 'camp-undeclared', providerCount: 97, localCount: 0, providerOnly: 97, expectation: 'UNKNOWN' }),
  ];
  assert.equal(deriveReconciliationState(c, m), 'UNKNOWN_EXPECTATION');
});

// --- 4. Finding a member ------------------------------------------------------------------

test('a member is found by dimension and id, and never by label', () => {
  const day = {
    businessDate: '2026-08-05',
    state: 'RECONCILED' as const,
    counts: counts(),
    members: [member(), member({ memberExternalId: 'camp-b' })],
    ruleVersion: 'provider-reconciliation.v1',
  };
  assert.equal(memberFact(day, 'CAMPAIGN', 'camp-b')?.memberExternalId, 'camp-b');
  assert.equal(memberFact(day, 'CAMPAIGN', 'camp-z'), undefined);
  assert.equal(memberFact(day, 'BUYER', 'camp-b'), undefined);
});
