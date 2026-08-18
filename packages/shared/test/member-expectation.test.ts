// Expectation — the difference between "never connected" and "did not arrive".
//
// The scenario every case here is drawn from: on 2026-08-05 two campaigns held 9
// calls at the provider and none in Loop, because the production webhook had never
// been attached to them. A third campaign held one absence and 621 deliveries.
// From inside Loop all ten look the same — a row that is not there — and the whole
// job of this vocabulary is to keep the first nine from ever being reported as a
// defect while the tenth always is.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MEMBER_EXPECTATION_STATES,
  absenceIsDefect,
  declarationProblems,
  isDeclarationValid,
  resolveExpectation,
  type MemberExpectationDeclaration,
} from '../src/index';

function declaration(
  over: Partial<MemberExpectationDeclaration> = {},
): MemberExpectationDeclaration {
  return {
    dimension: 'CAMPAIGN',
    memberExternalId: 'camp-a',
    state: 'EXPECTED',
    exclusionReason: null,
    basis: 'PROVIDER_CONFIG_VERIFIED',
    effectiveFrom: '2026-08-01',
    effectiveTo: null,
    ...over,
  };
}

// --- 1. What may be declared -------------------------------------------------------

test('an exclusion must name its reason', () => {
  const problems = declarationProblems(declaration({ state: 'EXCLUDED', exclusionReason: null }));
  assert.ok(problems.some((p) => p.includes('EXCLUDED requires a named reason')));
});

test('a reason is meaningless on anything but an exclusion', () => {
  const problems = declarationProblems(
    declaration({ state: 'EXPECTED', exclusionReason: 'TEST_TRAFFIC' }),
  );
  assert.equal(problems.length, 1);
  assert.ok(problems[0]?.includes('only meaningful on EXCLUDED'));
});

test('a declaration keyed on nothing is not identity', () => {
  assert.equal(isDeclarationValid(declaration({ memberExternalId: '  ' })), false);
});

test('an inverted or empty effective range is a defect', () => {
  assert.equal(
    isDeclarationValid(declaration({ effectiveFrom: '2026-08-10', effectiveTo: '2026-08-01' })),
    false,
  );
  assert.equal(
    isDeclarationValid(declaration({ effectiveFrom: '2026-08-10', effectiveTo: '2026-08-10' })),
    false,
    'a range covering no day cannot be in force on any day',
  );
});

test('v1 declares over campaigns only', () => {
  assert.equal(isDeclarationValid(declaration({ dimension: 'BUYER' })), false);
  assert.equal(isDeclarationValid(declaration({ dimension: 'CAMPAIGN' })), true);
});

test('UNKNOWN is not declarable', () => {
  assert.equal(MEMBER_EXPECTATION_STATES.includes('UNKNOWN' as never), false);
});

// --- 2. Resolution fails closed -----------------------------------------------------

test('no declaration resolves UNKNOWN, never a default', () => {
  const r = resolveExpectation([], 'CAMPAIGN', 'camp-a', '2026-08-05');
  assert.equal(r.state, 'UNKNOWN');
  assert.equal(r.matches, 0);
  assert.equal(r.declaration, null);
});

test('two overlapping declarations also resolve UNKNOWN, and say so', () => {
  const r = resolveExpectation(
    [declaration(), declaration({ state: 'NOT_CONFIGURED' })],
    'CAMPAIGN',
    'camp-a',
    '2026-08-05',
  );
  assert.equal(r.state, 'UNKNOWN', 'no tie-break is invented');
  assert.equal(r.matches, 2, 'the operator is told which of the two problems they have');
});

test('a malformed declaration is ignored rather than trusted', () => {
  const r = resolveExpectation(
    [declaration({ state: 'EXCLUDED', exclusionReason: null })],
    'CAMPAIGN',
    'camp-a',
    '2026-08-05',
  );
  assert.equal(r.state, 'UNKNOWN');
});

test('another campaign or another dimension is not this member', () => {
  assert.equal(resolveExpectation([declaration()], 'CAMPAIGN', 'camp-b', '2026-08-05').state, 'UNKNOWN');
  assert.equal(resolveExpectation([declaration()], 'BUYER', 'camp-a', '2026-08-05').state, 'UNKNOWN');
});

// --- 3. History does not move -------------------------------------------------------

test('effective dates are half-open: the start day counts, the end day does not', () => {
  const d = declaration({ effectiveFrom: '2026-08-05', effectiveTo: '2026-08-19' });
  assert.equal(resolveExpectation([d], 'CAMPAIGN', 'camp-a', '2026-08-04').state, 'UNKNOWN');
  assert.equal(resolveExpectation([d], 'CAMPAIGN', 'camp-a', '2026-08-05').state, 'EXPECTED');
  assert.equal(resolveExpectation([d], 'CAMPAIGN', 'camp-a', '2026-08-18').state, 'EXPECTED');
  assert.equal(resolveExpectation([d], 'CAMPAIGN', 'camp-a', '2026-08-19').state, 'UNKNOWN');
});

test('THE REGRESSION: attaching a webhook later never rewrites an earlier day', () => {
  // Spanish FE was not connected on 2026-08-05. Suppose it is connected on the
  // 19th. August 5 must keep resolving NOT_CONFIGURED — its six absences were
  // correct then, and a single current-state flag would convert them into a
  // delivery failure nobody could have prevented.
  const history: MemberExpectationDeclaration[] = [
    declaration({
      memberExternalId: 'camp-silent',
      state: 'NOT_CONFIGURED',
      effectiveFrom: '2026-01-01',
      effectiveTo: '2026-08-19',
    }),
    declaration({
      memberExternalId: 'camp-silent',
      state: 'EXPECTED',
      effectiveFrom: '2026-08-19',
      effectiveTo: null,
    }),
  ];
  assert.equal(resolveExpectation(history, 'CAMPAIGN', 'camp-silent', '2026-08-05').state, 'NOT_CONFIGURED');
  assert.equal(resolveExpectation(history, 'CAMPAIGN', 'camp-silent', '2026-08-19').state, 'EXPECTED');
  assert.equal(resolveExpectation(history, 'CAMPAIGN', 'camp-silent', '2026-08-20').state, 'EXPECTED');
});

// --- 4. What an absence means --------------------------------------------------------

test('only an expected absence is a defect', () => {
  assert.equal(absenceIsDefect('EXPECTED'), true);
  assert.equal(absenceIsDefect('NOT_CONFIGURED'), false);
  assert.equal(absenceIsDefect('EXCLUDED'), false);
  assert.equal(absenceIsDefect('UNKNOWN'), false, 'unknown is handled by its own reason, not folded in');
});
