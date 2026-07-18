// Truth States — platform contract tests.
//
// Run: npm run -w @emgloop/shared test
//
// These are the tests that decide whether the framework is real. The headline
// requirement is negative — "unknown must never render zero" — so most of what
// follows is written adversarially: it tries to make the framework emit a
// number it has not measured, and asserts that it cannot.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  // constructors
  success,
  empty,
  partial,
  unknown,
  unavailable,
  failed,
  measuredCount,
  measuredList,
  measuredBounded,
  measure,
  errorFromException,
  weakestState,
  // guards
  isSuccess,
  isEmpty,
  isPartial,
  isUnknown,
  isUnavailable,
  isError,
  hasValue,
  isComplete,
  mayRenderZero,
  reasonOf,
  foldTruth,
  mapTruth,
  // render
  describeTruth,
  renderTruth,
  assertZeroRule,
  UNKNOWN_DISPLAY,
  // serialize
  serializeTruth,
  parseTruth,
  parseNumericTruth,
  type Coverage,
  type Reason,
  type Truth,
} from '../src/truth';

const AT = '2026-07-18T12:00:00.000Z';
const meta = { measuredAt: AT };

const REASON: Reason = {
  code: 'no-calls-ingested',
  summary: 'No calls have been ingested in this window.',
  unblockedBy: 'Ingest at least one marketplace call.',
  provider: 'CallGrid',
};

const COVERAGE: Coverage = {
  observed: 2000,
  total: 12_500,
  reason: { code: 'customer-scan-capped', summary: 'The customer scan was capped at 2,000 rows.' },
};

/** Every state, so each test can sweep all six rather than sampling. */
const allStates = (): Truth<number>[] => [
  success(42, meta),
  empty(0, meta),
  partial(2000, COVERAGE, meta),
  unknown<number>(REASON, meta),
  unavailable<number>(REASON, meta),
  failed<number>({ code: 'db-unavailable', summary: 'unreachable', retryable: true }, meta),
];

const money = (n: number) => '$' + n.toLocaleString('en-US');

// --- THE ZERO RULE ---------------------------------------------------------

test('only SUCCESS and EMPTY may render a numeric zero', () => {
  for (const t of allStates()) {
    const permitted = t.state === 'success' || t.state === 'empty';
    assert.equal(mayRenderZero(t), permitted, `mayRenderZero wrong for ${t.state}`);
  }
});

test('UNKNOWN never renders zero — it renders the unknown glyph', () => {
  const d = renderTruth(unknown<number>(REASON, meta), money);
  assert.equal(d.text, UNKNOWN_DISPLAY);
  assert.notEqual(d.text, '0');
  assert.notEqual(d.text, '$0');
  assert.equal(d.trustworthy, false);
  assert.ok(d.note && d.note.length > 0, 'UNKNOWN must explain itself');
});

test('UNAVAILABLE never renders zero', () => {
  const d = renderTruth(unavailable<number>(REASON, meta), money);
  assert.equal(d.text, UNKNOWN_DISPLAY);
  assert.equal(d.trustworthy, false);
  assert.ok(d.note);
});

test('ERROR never renders zero', () => {
  const d = renderTruth(
    failed<number>({ code: 'db-unavailable', summary: 'The database was unreachable.', retryable: true }, meta),
    money,
  );
  assert.equal(d.text, UNKNOWN_DISPLAY);
  assert.equal(d.tone, 'critical');
  assert.equal(d.trustworthy, false);
});

test('no non-measured state can produce digits, whatever the formatter does', () => {
  // An adversarial formatter that always returns "0". It must never be reached
  // for a state without a value.
  const sabotage = () => '0';
  for (const t of allStates()) {
    const d = describeTruth(t, sabotage);
    if (t.state === 'success' || t.state === 'empty' || t.state === 'partial') {
      assert.equal(d.text, '0', `${t.state} should have invoked the formatter`);
    } else {
      assert.equal(d.text, UNKNOWN_DISPLAY, `${t.state} must not invoke the formatter`);
    }
  }
});

test('assertZeroRule throws when a non-measured state somehow shows zero', () => {
  // Simulates a consumer hand-building a display and getting it wrong.
  assert.throws(
    () => assertZeroRule({ text: '0', tone: 'neutral', qualifier: null, note: null, unblockedBy: null, trustworthy: false, state: 'unknown' }),
    /zero rule violated/i,
  );
  assert.throws(
    () => assertZeroRule({ text: '$0', tone: 'critical', qualifier: null, note: null, unblockedBy: null, trustworthy: false, state: 'error' }),
    /zero rule violated/i,
  );
  // And permits the honest zero.
  assert.doesNotThrow(() =>
    assertZeroRule({ text: '$0', tone: 'neutral', qualifier: null, note: null, unblockedBy: null, trustworthy: true, state: 'empty' }),
  );
});

test('EMPTY is the one state where zero is the truth, and it says so', () => {
  const d = renderTruth(empty(0, meta), money);
  assert.equal(d.text, '$0');
  assert.equal(d.trustworthy, true);
  assert.match(d.note ?? '', /genuinely zero/i);
});

// --- EMPTY vs UNKNOWN ------------------------------------------------------

test('EMPTY and UNKNOWN are different facts and never collapse', () => {
  const e = empty(0, meta);
  const u = unknown<number>(REASON, meta);
  assert.notEqual(e.state, u.state);
  assert.equal(hasValue(e), true);
  assert.equal(hasValue(u), false);
  assert.equal(isComplete(e), true);
  assert.equal(isComplete(u), false);
  assert.notEqual(renderTruth(e, money).text, renderTruth(u, money).text);
});

test('measuredCount classifies a real zero as EMPTY, never UNKNOWN', () => {
  assert.equal(measuredCount(0, meta).state, 'empty');
  assert.equal(measuredCount(7, meta).state, 'success');
});

test('measuredList classifies an empty list as EMPTY', () => {
  assert.equal(measuredList([], meta).state, 'empty');
  assert.equal(measuredList(['a'], meta).state, 'success');
});

// --- PARTIAL ---------------------------------------------------------------

test('PARTIAL always exposes coverage', () => {
  const p = partial(2000, COVERAGE, meta);
  assert.ok(isPartial(p));
  if (isPartial(p)) {
    assert.equal(p.coverage.observed, 2000);
    assert.equal(p.coverage.total, 12_500);
    assert.ok(p.coverage.reason.summary);
  }
});

test('PARTIAL is never presented as complete, and states it is a lower bound', () => {
  const p = partial(2000, COVERAGE, meta);
  assert.equal(isComplete(p), false);
  assert.equal(mayRenderZero(p), false);
  const d = renderTruth(p, money);
  assert.equal(d.trustworthy, false);
  assert.equal(d.qualifier, 'lower bound');
  assert.match(d.note ?? '', /lower bound/i);
  assert.match(d.note ?? '', /2,000/);
  assert.match(d.note ?? '', /12,500/);
});

test('PARTIAL with an unknown denominator says so rather than faking one', () => {
  const p = partial(500, { observed: 500, total: null, reason: { code: 'pagination-incomplete', summary: 'Provider pagination did not report a total.' } }, meta);
  const d = renderTruth(p, money);
  assert.match(d.note ?? '', /unknown total/i);
  assert.doesNotMatch(d.note ?? '', /of 500\./, 'must not present observed as the denominator');
});

test('measuredBounded routes a capped read to PARTIAL and an uncapped one to SUCCESS/EMPTY', () => {
  assert.equal(measuredBounded(2000, { capBound: true, coverage: COVERAGE, isZero: false }, meta).state, 'partial');
  assert.equal(measuredBounded(42, { capBound: false, coverage: COVERAGE, isZero: false }, meta).state, 'success');
  assert.equal(measuredBounded(0, { capBound: false, coverage: COVERAGE, isZero: true }, meta).state, 'empty');
});

// --- Guards and access -----------------------------------------------------

test('guards identify exactly one state each', () => {
  const [s, e, p, u, un, err] = allStates();
  assert.ok(isSuccess(s!) && !isSuccess(e!));
  assert.ok(isEmpty(e!) && !isEmpty(s!));
  assert.ok(isPartial(p!) && !isPartial(s!));
  assert.ok(isUnknown(u!) && !isUnknown(un!));
  assert.ok(isUnavailable(un!) && !isUnavailable(u!));
  assert.ok(isError(err!) && !isError(s!));
});

test('hasValue narrows to exactly the three value-bearing states', () => {
  for (const t of allStates()) {
    const expected = t.state === 'success' || t.state === 'empty' || t.state === 'partial';
    assert.equal(hasValue(t), expected, `hasValue wrong for ${t.state}`);
  }
});

test('reasonOf surfaces an explanation for every non-complete state', () => {
  assert.equal(reasonOf(success(1, meta)), null);
  assert.equal(reasonOf(empty(0, meta)), null);
  assert.equal(reasonOf(partial(1, COVERAGE, meta))?.code, 'customer-scan-capped');
  assert.equal(reasonOf(unknown<number>(REASON, meta))?.code, 'no-calls-ingested');
  assert.equal(reasonOf(unavailable<number>(REASON, meta))?.code, 'no-calls-ingested');
});

test('every non-complete state carries an operator-facing explanation', () => {
  for (const t of allStates()) {
    const d = renderTruth(t, money);
    if (t.state === 'success') continue;
    assert.ok(d.note && d.note.length > 0, `${t.state} must explain itself`);
  }
});

// --- fold and map ----------------------------------------------------------

test('foldTruth handles all six states', () => {
  const seen = allStates().map((t) =>
    foldTruth(t, {
      success: () => 'success',
      empty: () => 'empty',
      partial: () => 'partial',
      unknown: () => 'unknown',
      unavailable: () => 'unavailable',
      error: () => 'error',
    }),
  );
  assert.deepEqual(seen, ['success', 'empty', 'partial', 'unknown', 'unavailable', 'error']);
});

test('mapTruth transforms values but cannot invent one', () => {
  assert.equal((mapTruth(success(2, meta), (n) => n * 10) as { value: number }).value, 20);
  assert.equal((mapTruth(empty(0, meta), (n) => n * 10) as { value: number }).value, 0);
  // Non-value states pass through with state intact and still no value.
  const u = mapTruth(unknown<number>(REASON, meta), (n) => n * 10);
  assert.equal(u.state, 'unknown');
  assert.equal((u as Record<string, unknown>).value, undefined);
});

test('mapTruth preserves provenance', () => {
  const mapped = mapTruth(partial(5, COVERAGE, { measuredAt: AT, subject: 'revenue' }), (n) => n + 1);
  assert.equal(mapped.measuredAt, AT);
  assert.equal(mapped.subject, 'revenue');
  assert.equal(mapped.state, 'partial');
});

// --- Repository helpers ----------------------------------------------------

test('measure converts a thrown exception into ERROR, never an empty result', async () => {
  const t = await measure<number>(
    async () => {
      throw new Error('connection terminated unexpectedly');
    },
    measuredCount,
    meta,
  );
  assert.equal(t.state, 'error');
  assert.equal(hasValue(t), false);
  if (isError(t)) {
    assert.equal(t.error.code, 'db-unavailable');
    assert.equal(t.error.retryable, true);
  }
});

test('measure classifies a successful read normally', async () => {
  assert.equal((await measure<number>(async () => 0, measuredCount, meta)).state, 'empty');
  assert.equal((await measure<number>(async () => 9, measuredCount, meta)).state, 'success');
});

test('errorFromException distinguishes transient from structural failures', () => {
  assert.equal(errorFromException(new Error('ETIMEDOUT')).code, 'provider-timeout');
  assert.equal(errorFromException(new Error('ETIMEDOUT')).retryable, true);
  assert.equal(errorFromException(new Error('permission denied')).code, 'provider-auth-failed');
  assert.equal(errorFromException(new Error('permission denied')).retryable, false);
  assert.equal(errorFromException('weird').code, 'repository-exception');
});

test('weakestState reports the worst posture, so one bad read compromises the whole', () => {
  assert.equal(weakestState([success(1, meta), success(2, meta)]), 'success');
  assert.equal(weakestState([success(1, meta), empty(0, meta)]), 'empty');
  assert.equal(weakestState([success(1, meta), partial(2, COVERAGE, meta)]), 'partial');
  assert.equal(weakestState([success(1, meta), unknown<number>(REASON, meta)]), 'unknown');
  assert.equal(weakestState([partial(2, COVERAGE, meta), unavailable<number>(REASON, meta)]), 'unavailable');
  assert.equal(
    weakestState([success(1, meta), unknown<number>(REASON, meta), failed<number>({ code: 'db-unavailable', summary: 'x', retryable: true }, meta)]),
    'error',
  );
});

// --- Serialization ---------------------------------------------------------

test('every state round-trips through serialization with its state intact', () => {
  for (const t of allStates()) {
    const round = parseNumericTruth(JSON.parse(JSON.stringify(serializeTruth(t))));
    assert.equal(round.state, t.state, `state lost for ${t.state}`);
    assert.equal(round.measuredAt, AT);
    if (hasValue(t) && hasValue(round)) assert.equal(round.value, t.value);
  }
});

test('serialization preserves coverage and reason detail', () => {
  const round = parseNumericTruth(JSON.parse(JSON.stringify(serializeTruth(partial(2000, COVERAGE, meta)))));
  assert.ok(isPartial(round));
  if (isPartial(round)) {
    assert.equal(round.coverage.observed, 2000);
    assert.equal(round.coverage.total, 12_500);
    assert.equal(round.coverage.reason.code, 'customer-scan-capped');
  }
});

test('a null coverage denominator survives serialization as null, not 0', () => {
  const p = partial(5, { observed: 5, total: null, reason: { code: 'x', summary: 'y' } }, meta);
  const round = parseNumericTruth(JSON.parse(JSON.stringify(serializeTruth(p))));
  assert.ok(isPartial(round));
  if (isPartial(round)) assert.equal(round.coverage.total, null);
});

test('parseTruth rejects malformed payloads rather than degrading to a renderable object', () => {
  assert.throws(() => parseNumericTruth({ state: 'success', measuredAt: AT }), /value must be a finite number/);
  assert.throws(() => parseNumericTruth({ state: 'nonsense', measuredAt: AT }), /unrecognized state/);
  assert.throws(() => parseNumericTruth({ state: 'success', value: 1 }), /measuredAt/);
  assert.throws(() => parseNumericTruth({ state: 'unknown', measuredAt: AT }), /reason/);
  assert.throws(() => parseNumericTruth({ state: 'partial', measuredAt: AT, value: 1 }), /coverage/);
  assert.throws(() => parseNumericTruth(null), /must be an object/);
});

test('a value that arrives as NaN is rejected, never coerced to zero', () => {
  assert.throws(() => parseNumericTruth({ state: 'success', measuredAt: AT, value: Number.NaN }), /finite number/);
  assert.throws(() => parseTruth<number>({ state: 'success', measuredAt: AT, value: '0' }, (v) => {
    if (typeof v !== 'number') throw new Error('value must be a finite number');
    return v;
  }), /finite number/);
});

test('evidence survives the round trip', () => {
  const t = success(5, { measuredAt: AT, evidence: [{ kind: 'call', description: 'Interaction row', ref: 'int_1' }] });
  const round = parseNumericTruth(JSON.parse(JSON.stringify(serializeTruth(t))));
  assert.equal(round.evidence.length, 1);
  assert.equal(round.evidence[0]?.ref, 'int_1');
});

test('a Truth always carries when it was measured', () => {
  for (const t of allStates()) {
    assert.equal(t.measuredAt, AT, `${t.state} lost its timestamp`);
    assert.ok(Array.isArray(t.evidence), `${t.state} must carry an evidence array`);
  }
});
