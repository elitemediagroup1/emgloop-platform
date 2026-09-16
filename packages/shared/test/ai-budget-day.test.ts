// The business day an AI invocation is budgeted against.
//
// The organization's own reporting zone decides which day a usage row lands on, and
// that is ALL it decides. These pin the DST edges, the date line, and the fail-closed
// fallback -- a zone string nobody can evaluate must still leave a window a cap can
// be enforced in.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { aiBudgetDate } from '../src/ai/budget-day';

test('the same instant is a different business day in different organizations', () => {
  const instant = new Date('2026-09-16T18:30:00.000Z');
  assert.equal(aiBudgetDate(instant, 'UTC'), '2026-09-16');
  assert.equal(aiBudgetDate(instant, 'America/New_York'), '2026-09-16');
  assert.equal(aiBudgetDate(instant, 'Pacific/Auckland'), '2026-09-17');
  assert.equal(aiBudgetDate(new Date('2026-09-16T02:00:00.000Z'), 'America/Los_Angeles'), '2026-09-15');
});

test('a New York day boundary follows daylight saving, not a fixed offset', () => {
  // EDT (UTC-4) in summer: midnight local is 04:00Z.
  assert.equal(aiBudgetDate(new Date('2026-07-01T03:59:59.999Z'), 'America/New_York'), '2026-06-30');
  assert.equal(aiBudgetDate(new Date('2026-07-01T04:00:00.000Z'), 'America/New_York'), '2026-07-01');
  // EST (UTC-5) in winter: midnight local is 05:00Z.
  assert.equal(aiBudgetDate(new Date('2026-01-15T04:59:59.999Z'), 'America/New_York'), '2026-01-14');
  assert.equal(aiBudgetDate(new Date('2026-01-15T05:00:00.000Z'), 'America/New_York'), '2026-01-15');
});

test('a missing or unusable zone budgets on the UTC day rather than not at all', () => {
  const instant = new Date('2026-09-16T23:30:00.000Z');
  for (const zone of [null, undefined, '', '   ', 'Not/AZone', 'EST+99']) {
    assert.equal(aiBudgetDate(instant, zone), '2026-09-16', `zone ${JSON.stringify(zone)}`);
  }
});

test('the result is a calendar date, never an instant', () => {
  assert.match(aiBudgetDate(new Date('2026-02-03T00:00:00.000Z'), 'UTC'), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(aiBudgetDate(new Date('0999-02-03T12:00:00.000Z'), 'UTC'), '0999-02-03', 'zero-padded');
});
