// Mutable provider fact convergence — the rule, tested purely.
//
// Every case here was chosen against a specific way of losing money or
// manufacturing a fact. The table in the MONOTONIC_AMOUNT branch of the rule is
// reproduced case by case, because it is the one that decides revenue.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CALLGRID_FACT_KINDS,
  FACT_CONVERGENCE_DECISIONS,
  convergeFact,
  isCallGridFact,
} from '../src/provider-fact-convergence';

const amount = (existing: number | null, incoming: number | null) =>
  convergeFact<number>({ kind: 'MONOTONIC_AMOUNT', existing, incoming });
const assertion = (existing: boolean | null, incoming: boolean | null) =>
  convergeFact<boolean>({ kind: 'MONOTONIC_ASSERTION', existing, incoming });

// --- The vocabulary and the classification -----------------------------------------

test('the decision vocabulary is closed and every member is distinct', () => {
  assert.deepEqual(
    [...FACT_CONVERGENCE_DECISIONS],
    ['KEEP_EXISTING', 'UPDATE', 'REMAIN_UNKNOWN', 'CONFLICT'],
  );
});

test('only facts with provider evidence are classified — descriptive fields are absent', () => {
  assert.equal(CALLGRID_FACT_KINDS.revenue, 'MONOTONIC_AMOUNT');
  assert.equal(CALLGRID_FACT_KINDS.billable, 'MONOTONIC_ASSERTION');
  assert.equal(CALLGRID_FACT_KINDS.occurredAt, 'IMMUTABLE');
  // Deliberately unclassified: labels, geography, status and duration may
  // legitimately change and there is no established downstream reason to refresh
  // them. `cost` is absent too — no evidence says telco cost settles upward, and
  // money must not inherit a monotonic rule by symmetry with revenue.
  for (const absent of ['cost', 'callerZip', 'callerState', 'status', 'durationSeconds', 'campaign']) {
    assert.equal(isCallGridFact(absent), false, `${absent} must not be converged`);
  }
});

// --- CASE A: unknown strengthened by a provider positive ----------------------------

test('CASE A. unknown → provider positive STRENGTHENS', () => {
  const money = amount(null, 1700);
  assert.equal(money.decision, 'UPDATE');
  assert.equal(money.value, 1700);

  const flag = assertion(null, true);
  assert.equal(flag.decision, 'UPDATE');
  assert.equal(flag.value, true);
});

// --- CASE B: known positive survives an ambiguous later zero ------------------------

test('CASE B. a settled $17 SURVIVES a later postback-pending zero', () => {
  const r = amount(1700, 0);
  assert.equal(r.decision, 'KEEP_EXISTING');
  assert.equal(r.value, undefined, 'nothing is written');
  assert.match(r.reason, /may not erase a settled amount/);
});

test('CASE B2. an asserted TRUE survives a later ambiguous false', () => {
  const r = assertion(true, false);
  assert.equal(r.decision, 'KEEP_EXISTING');
  assert.match(r.reason, /may not erase an asserted true/);
});

// --- CASE C: ambiguity never manufactures a negative --------------------------------

test('CASE C. unknown + ambiguous zero/false stays UNKNOWN, never becomes a decided no', () => {
  const money = amount(null, 0);
  assert.equal(money.decision, 'REMAIN_UNKNOWN');
  assert.equal(money.value, undefined);

  const flag = assertion(null, false);
  assert.equal(flag.decision, 'REMAIN_UNKNOWN');
  assert.equal(flag.value, undefined);
  assert.match(flag.reason, /indistinguishable/);
});

// --- CASE D: a real final zero is still representable --------------------------------

test('CASE D/F. a genuine final zero and false remain representable', () => {
  // This rule governs RE-OBSERVATION only. The first observation writes what the
  // provider said, zero included — there is nothing to protect and no reason to
  // disbelieve it. So a settled zero lives in the column perfectly well; what
  // this rule refuses is MANUFACTURING one from a later ambiguous look.
  assert.equal(amount(0, 0).decision, 'KEEP_EXISTING', 'a stored zero is left alone');
  assert.equal(assertion(false, false).decision, 'KEEP_EXISTING', 'a stored false is left alone');
  // And a stored zero is still strengthenable when the postback lands.
  const settled = amount(0, 2500);
  assert.equal(settled.decision, 'UPDATE');
  assert.equal(settled.value, 2500);
  assert.match(settled.reason, /settled a pending zero/);
});

// --- CASE E, F: silence changes nothing -----------------------------------------------

test('CASE E. an identical observation writes nothing', () => {
  assert.equal(amount(1700, 1700).decision, 'KEEP_EXISTING');
  assert.equal(assertion(true, true).decision, 'KEEP_EXISTING');
});

test('CASE F. a fact the new observation OMITS never clears the existing one', () => {
  assert.equal(amount(1700, null).decision, 'KEEP_EXISTING');
  assert.equal(assertion(true, null).decision, 'KEEP_EXISTING');
  assert.equal(
    convergeFact({ kind: 'IMMUTABLE', existing: 'abc', incoming: undefined }).decision,
    'KEEP_EXISTING',
  );
});

// --- CASE G: the postback path end to end ---------------------------------------------

test('CASE G. the postback sequence strengthens exactly once and then holds', () => {
  // unknown -> pending zero -> settled positive -> another pending zero.
  let value: number | null = null;
  for (const incoming of [0, 0, 1700, 0, 0]) {
    const step = amount(value, incoming);
    if (step.decision === 'UPDATE') value = step.value ?? value;
  }
  assert.equal(value, 1700, 'settles up once, and never back down');
});

// --- CASE H: two settled values are a conflict, not a correction ------------------------

test('CASE H. two different settled amounts are a CONFLICT and neither is written', () => {
  const r = amount(1700, 1500);
  assert.equal(r.decision, 'CONFLICT');
  assert.equal(r.value, undefined, 'silence beats guessing which is right');
  assert.match(r.reason, /correction and a defect are indistinguishable/);
  // And it is symmetric — a larger later value is no more trustworthy.
  assert.equal(amount(1500, 1700).decision, 'CONFLICT');
});

test('an immutable fact observed differently is a CONFLICT, never a correction', () => {
  const r = convergeFact({ kind: 'IMMUTABLE', existing: 'call-a', incoming: 'call-b' });
  assert.equal(r.decision, 'CONFLICT');
  assert.match(r.reason, /defect, not a correction/);
  assert.equal(convergeFact({ kind: 'IMMUTABLE', existing: null, incoming: 'call-a' }).decision, 'UPDATE');
});

// --- The properties that matter more than any single case --------------------------------

test('NO DECISION EVER LOWERS A KNOWN VALUE', () => {
  // Exhaustive over the shapes money takes. If any pair produced an UPDATE to
  // something smaller than a known positive, this fails.
  const values: Array<number | null> = [null, 0, 1, 1500, 1700];
  for (const existing of values) {
    for (const incoming of values) {
      const r = amount(existing, incoming);
      if (r.decision !== 'UPDATE') continue;
      assert.ok(r.value !== undefined);
      if (existing !== null && existing > 0) {
        assert.fail(`a known ${existing} must never be updated (to ${r.value})`);
      }
      assert.ok(r.value! > 0, 'an UPDATE never writes a zero');
    }
  }
});

test('NO DECISION EVER TURNS A KNOWN TRUE INTO FALSE, OR AN UNKNOWN INTO FALSE', () => {
  for (const existing of [null, true, false] as Array<boolean | null>) {
    for (const incoming of [null, true, false] as Array<boolean | null>) {
      const r = assertion(existing, incoming);
      if (r.decision === 'UPDATE') {
        assert.equal(r.value, true, 'the only value this rule ever writes is true');
      }
    }
  }
});

test('the rule is deterministic and pure', () => {
  const once = amount(0, 1700);
  const twice = amount(0, 1700);
  assert.deepEqual(once, twice);
});
