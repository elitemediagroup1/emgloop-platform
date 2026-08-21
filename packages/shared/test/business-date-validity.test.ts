// A business date must name a day that exists — Stage 3.
//
// THE DEFECT
//
// `isBusinessDate` checked the SHAPE and nothing else, so `2026-13-99` passed it.
// It is the gate on every date-taking operation in this repository — certification
// writes a ledger row per date, reconciliation writes a verdict, expectation and
// authority declarations write effective-dated rows a measurement later resolves
// through, and the admin sync route takes one from an HTTP body. An operator typo
// would have been carried all the way to a production write and turned into a
// window derived from a month that does not exist.
//
// A predicate whose job is to fail closed cannot fail open on the one input class
// it exists to reject.
//
// WHY ROUND-TRIPPING RATHER THAN MONTH LENGTHS. `2026-02-31` is not obviously
// wrong to a regex and is not wrong at all to `Date.UTC` — it silently becomes
// 2026-03-03. That coercion is what makes a typo dangerous, so the check is
// exactly whether the coercion happened. Leap years then work without anybody
// writing a leap-year rule down.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { easternBusinessDayWindow, isBusinessDate } from '../src/business-time';

test('a real calendar date is accepted', () => {
  for (const date of [
    '2026-01-01',
    '2026-08-11',
    '2026-12-31',
    '2024-02-29', // a real leap day
    '2026-11-01', // the 25-hour Eastern day
    '2026-03-08', // the 23-hour Eastern day
  ]) {
    assert.equal(isBusinessDate(date), true, `${date} should be accepted`);
  }
});

test('A DATE THAT DOES NOT EXIST IS REFUSED, however well-shaped', () => {
  for (const date of [
    '2026-13-99', // the one that started this
    '2026-13-01', // month 13
    '2026-00-15', // month 0
    '2026-02-31', // silently becomes 2026-03-03
    '2026-04-31', // April has 30 days
    '2026-02-29', // 2026 is not a leap year
    '2026-01-32',
    '2026-01-00',
  ]) {
    assert.equal(isBusinessDate(date), false, `${date} must be refused`);
  }
});

test('the shape is still required, and non-strings still fail closed', () => {
  for (const value of [
    '2026-8-11', // not zero-padded
    '26-08-11',
    '2026/08/11',
    '2026-08-11T00:00:00Z',
    ' 2026-08-11',
    '2026-08-11 ',
    '',
    'yesterday',
    null,
    undefined,
    20260811,
    new Date('2026-08-11'),
    {},
  ]) {
    assert.equal(isBusinessDate(value), false, `${String(value)} must be refused`);
  }
});

test('everything the predicate accepts produces a usable Eastern day window', () => {
  // The property that made the old behaviour dangerous: a date that passed the
  // gate was handed straight to the window helper. Now everything that passes
  // produces a real, ordered, single-day interval.
  for (const date of ['2026-01-01', '2026-02-28', '2024-02-29', '2026-11-01', '2026-03-08', '2026-12-31']) {
    assert.equal(isBusinessDate(date), true);
    const window = easternBusinessDayWindow(date);
    assert.ok(Number.isFinite(window.start.getTime()), `${date} start`);
    assert.ok(Number.isFinite(window.end.getTime()), `${date} end`);
    assert.ok(window.end > window.start, `${date} must be ordered`);
    const hours = (window.end.getTime() - window.start.getTime()) / 3_600_000;
    assert.ok(hours >= 23 && hours <= 25, `${date} spanned ${hours} hours`);
  }
});

test('the impossible dates are refused BEFORE anything derives a window from them', () => {
  // This is the assertion that says why the fix belongs in the predicate rather
  // than in each caller: the coercion is real, and the gate is the only thing
  // standing between an operator typo and a production write keyed on it.
  const coerced = new Date(Date.UTC(2026, 1, 31));
  assert.equal(coerced.toISOString().slice(0, 10), '2026-03-03', 'Date.UTC really does coerce');
  assert.equal(isBusinessDate('2026-02-31'), false, 'and the predicate refuses it');
});

test('a leap day is decided by the calendar, not by a rule written down twice', () => {
  assert.equal(isBusinessDate('2024-02-29'), true, '2024 is a leap year');
  assert.equal(isBusinessDate('2026-02-29'), false, '2026 is not');
  assert.equal(isBusinessDate('2000-02-29'), true, 'divisible by 400');
  assert.equal(isBusinessDate('1900-02-29'), false, 'divisible by 100 but not 400');
});
