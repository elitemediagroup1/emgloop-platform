// CallGrid parsing — data-integrity regression tests (Sprint 32).
//
// Each test below pins a defect found by the Sprint 32 audit. They are written
// against the real exported parsers, not copies, so they fail if the parser
// regresses rather than if a duplicate drifts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toNumber, pickField, parseDurationSeconds } from '../src/adapters/callgrid-api';

// --- Defect 1.2: unknown money became a measured $0.00 ---------------------

test('an unparseable money string stays unknown, never 0', () => {
  // Before the fix, the strip regex turned each of these into "" and
  // Number("") === 0 passed Number.isFinite, so an unknown revenue was stored
  // as a real $0.00 — and a wrong 0 then permanently blocked reconciliation
  // from ever filling in the correct figure.
  for (const v of ['N/A', 'n/a', 'none', 'pending', 'unknown', '-', '.', '', '   ']) {
    assert.equal(toNumber(v), undefined, `toNumber(${JSON.stringify(v)}) must be undefined, not 0`);
  }
});

test('legitimately formatted money still parses', () => {
  assert.equal(toNumber('24.00'), 24);
  assert.equal(toNumber('$1,234.50'), 1234.5);
  assert.equal(toNumber('24.00 USD'), 24);
  assert.equal(toNumber('-5.25'), -5.25);
});

test('a real zero is preserved as a measurement', () => {
  // Zero is a legitimate business value — a $0 payout is not the same as an
  // unknown payout, and this parser must keep them distinct.
  assert.equal(toNumber('0'), 0);
  assert.equal(toNumber('0.00'), 0);
});

// --- Defect 6.1: JSON booleans were unreadable ------------------------------

test('JSON booleans are readable, so qualified can be derived', () => {
  // CallGrid sends billable/converted/paid as real booleans. Returning
  // undefined for them made the derived `qualified` flag undefined for every
  // such call, silently under-reporting qualified counts and the
  // qualification rate against calls that were unambiguously billable.
  assert.equal(pickField({ billable: true }, ['billable']), 'true');
  assert.equal(pickField({ billable: false }, ['billable']), 'false');
  assert.equal(pickField({ converted: true }, ['converted']), 'true');
});

test('boolean reading does not disturb string or number fields', () => {
  assert.equal(pickField({ revenue: '24.00' }, ['revenue']), '24.00');
  assert.equal(pickField({ revenue: 24 }, ['revenue']), '24');
  assert.equal(pickField({ revenue: '   ' }, ['revenue']), undefined);
  assert.equal(pickField({}, ['revenue']), undefined);
});

test('key precedence is respected when several are present', () => {
  assert.equal(pickField({ Revenue: '2', revenue: '1' }, ['revenue', 'Revenue']), '1');
});

// --- Duration parsing -------------------------------------------------------

test('duration parses both integer seconds and HH:MM:SS', () => {
  assert.equal(parseDurationSeconds('142'), 142);
  assert.equal(parseDurationSeconds('02:15'), 135);
  assert.equal(parseDurationSeconds('01:02:15'), 3735);
});

test('a non-numeric duration is unknown, not zero', () => {
  assert.equal(parseDurationSeconds('N/A'), undefined);
  assert.equal(parseDurationSeconds(undefined), undefined);
});
