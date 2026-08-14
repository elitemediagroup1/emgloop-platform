// The Performance Objective contract — Commercial Intelligence Stage 1.
//
// These tests guard the SHAPE of the concept, not its persistence. Two of them
// exist specifically to fail if a later change quietly widens what Stage 1 is:
// the scope vocabulary and the absence of measurement. Both are the kind of
// thing that gets added "while we're in here" and is very hard to remove once a
// column exists and a screen renders it.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PERFORMANCE_OBJECTIVE_CONTRACT_VERSION,
  PERFORMANCE_OBJECTIVE_SCOPES,
  PERFORMANCE_OBJECTIVE_STATUSES,
  PERFORMANCE_OBJECTIVE_REJECTIONS,
  PERFORMANCE_OBJECTIVE_REJECTION_MESSAGES,
  PERFORMANCE_OBJECTIVE_SCOPE_LABELS,
  PERFORMANCE_OBJECTIVE_STATUS_LABELS,
  PERFORMANCE_OBJECTIVE_TITLE_MAX,
  isPerformanceObjectiveScope,
  isPerformanceObjectiveStatus,
  validatePerformanceObjectiveShape,
} from '../src/performance-objective';

const T0 = new Date('2026-08-14T12:00:00.000Z');
const day = (n: number) => new Date(T0.getTime() + n * 86_400_000);

test('the contract is versioned', () => {
  assert.equal(PERFORMANCE_OBJECTIVE_CONTRACT_VERSION, 'performance-objective.v1');
});

// --- The two scope members, and no more --------------------------------------

test('scope has exactly ORGANIZATION and USER', () => {
  // Loop has no Team model, no Division model and no reporting relationship, so
  // a third member would be a scope pointing at an entity that does not exist.
  // Adding one is a platform decision, and this test is where it gets noticed.
  assert.deepEqual([...PERFORMANCE_OBJECTIVE_SCOPES], ['ORGANIZATION', 'USER']);
});

test('no team, division or department scope is accepted', () => {
  for (const fake of ['TEAM', 'DIVISION', 'DEPARTMENT', 'BUSINESS_UNIT', 'GROUP', 'REGION']) {
    assert.equal(isPerformanceObjectiveScope(fake), false, `${fake} must not be a scope`);
    assert.equal(
      validatePerformanceObjectiveShape({ title: 'Something', scope: fake }),
      'SCOPE_INVALID',
    );
  }
});

test('every scope and status has a human label', () => {
  for (const s of PERFORMANCE_OBJECTIVE_SCOPES) {
    assert.equal(typeof PERFORMANCE_OBJECTIVE_SCOPE_LABELS[s], 'string');
  }
  for (const s of PERFORMANCE_OBJECTIVE_STATUSES) {
    assert.equal(typeof PERFORMANCE_OBJECTIVE_STATUS_LABELS[s], 'string');
  }
});

// --- No measurement machinery ------------------------------------------------

test('status carries no achievement or progress state', () => {
  // ACHIEVED, MISSED, ON_TRACK, AT_RISK and OFF_TRACK are all claims about
  // measured performance. Loop measures nothing here, and a status that implied
  // otherwise would be a conclusion the platform cannot support.
  assert.deepEqual([...PERFORMANCE_OBJECTIVE_STATUSES], ['ACTIVE', 'ARCHIVED']);
  for (const banned of ['ACHIEVED', 'MISSED', 'ON_TRACK', 'AT_RISK', 'OFF_TRACK', 'COMPLETED']) {
    assert.equal(isPerformanceObjectiveStatus(banned), false, `${banned} must not be a status`);
  }
});

// --- Shape validation --------------------------------------------------------

test('a title is required and bounded', () => {
  assert.equal(validatePerformanceObjectiveShape({ title: '', scope: 'ORGANIZATION' }), 'TITLE_REQUIRED');
  assert.equal(validatePerformanceObjectiveShape({ title: '   ', scope: 'ORGANIZATION' }), 'TITLE_REQUIRED');
  assert.equal(
    validatePerformanceObjectiveShape({ title: 'x'.repeat(PERFORMANCE_OBJECTIVE_TITLE_MAX + 1), scope: 'ORGANIZATION' }),
    'TITLE_TOO_LONG',
  );
  assert.equal(
    validatePerformanceObjectiveShape({ title: 'x'.repeat(PERFORMANCE_OBJECTIVE_TITLE_MAX), scope: 'ORGANIZATION' }),
    null,
  );
});

test('user scope requires a person and organization scope forbids one', () => {
  assert.equal(
    validatePerformanceObjectiveShape({ title: 'Ship it', scope: 'USER' }),
    'USER_SCOPE_REQUIRES_USER',
  );
  assert.equal(
    validatePerformanceObjectiveShape({ title: 'Ship it', scope: 'USER', scopeUserId: 'user-1' }),
    null,
  );
  assert.equal(
    validatePerformanceObjectiveShape({ title: 'Ship it', scope: 'ORGANIZATION', scopeUserId: 'user-1' }),
    'ORGANIZATION_SCOPE_FORBIDS_USER',
  );
  assert.equal(
    validatePerformanceObjectiveShape({ title: 'Ship it', scope: 'ORGANIZATION' }),
    null,
  );
});

test('an end date must fall after the start date', () => {
  const base = { title: 'Ship it', scope: 'ORGANIZATION' as const };
  assert.equal(validatePerformanceObjectiveShape({ ...base, effectiveFrom: T0, effectiveTo: T0 }), 'EFFECTIVE_RANGE_INVALID');
  assert.equal(validatePerformanceObjectiveShape({ ...base, effectiveFrom: day(5), effectiveTo: day(1) }), 'EFFECTIVE_RANGE_INVALID');
  assert.equal(validatePerformanceObjectiveShape({ ...base, effectiveFrom: T0, effectiveTo: day(1) }), null);
  // Open-ended intent is valid, and is not the same thing as archived.
  assert.equal(validatePerformanceObjectiveShape({ ...base, effectiveFrom: T0, effectiveTo: null }), null);
});

test('the shape check deliberately cannot decide organization membership', () => {
  // It has no query, so it must not pretend to be a complete gate. A user id
  // from any tenant passes here; the repository is what rejects a foreign one.
  assert.equal(
    validatePerformanceObjectiveShape({ title: 'Ship it', scope: 'USER', scopeUserId: 'user-from-another-tenant' }),
    null,
  );
});

// --- Rejection vocabulary ----------------------------------------------------

test('every rejection reason has a message a person can act on', () => {
  for (const reason of PERFORMANCE_OBJECTIVE_REJECTIONS) {
    const msg = PERFORMANCE_OBJECTIVE_REJECTION_MESSAGES[reason];
    assert.equal(typeof msg, 'string', `${reason} has no message`);
    assert.ok(msg.length > 0, `${reason} has an empty message`);
    // No apology, no "oops", no bare "invalid".
    assert.ok(!/sorry|oops|invalid input/i.test(msg), `${reason} message should say what to do: ${msg}`);
  }
});

test('the message map is total over the reason list', () => {
  // A reason added without a message would surface to a person as `undefined`.
  assert.deepEqual(
    Object.keys(PERFORMANCE_OBJECTIVE_REJECTION_MESSAGES).sort(),
    [...PERFORMANCE_OBJECTIVE_REJECTIONS].sort(),
  );
});
