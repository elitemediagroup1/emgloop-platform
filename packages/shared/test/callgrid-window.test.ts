// CallGrid date-window contract — deterministic, Eastern (America/New_York).
// `now` is injected so every assertion is reproducible. These cover the spec's
// preset definitions and comparison rules (Phase 17 date tests).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveCallGridWindow, parseCallGridRange, easternYmd } from '../src/index';

// A fixed reference instant: Wed Jul 22, 2026, 14:30 ET (EDT, -4) = 18:30Z.
const NOW = new Date('2026-07-22T18:30:00.000Z');
function ymd(d: Date) {
  const y = easternYmd(d);
  return `${y.year}-${String(y.month).padStart(2, '0')}-${String(y.day).padStart(2, '0')}`;
}

test('Today uses Eastern calendar boundaries and ends at now', () => {
  const w = resolveCallGridWindow({ preset: 'today' }, NOW);
  assert.equal(ymd(w.start), '2026-07-22');
  assert.equal(w.end.getTime(), NOW.getTime());
  assert.equal(w.timezone, 'America/New_York');
  // Comparison = full yesterday.
  assert.equal(ymd(w.comparisonStart!), '2026-07-21');
  assert.equal(ymd(w.comparisonEnd!), '2026-07-22'); // exclusive boundary is today's start
});

test('Yesterday is the previous complete Eastern day; compares with the day before', () => {
  const w = resolveCallGridWindow({ preset: 'yesterday' }, NOW);
  assert.equal(ymd(w.start), '2026-07-21');
  assert.equal(ymd(w.end), '2026-07-22');
  assert.equal(ymd(w.comparisonStart!), '2026-07-20');
});

test('Last 7 Days is seven inclusive calendar days ending today', () => {
  const w = resolveCallGridWindow({ preset: 'last_7_days' }, NOW);
  assert.equal(ymd(w.start), '2026-07-16'); // 22 back to 16 = 7 days inclusive
  assert.equal(w.end.getTime(), NOW.getTime());
  // Comparison: the immediately preceding seven-day period.
  assert.equal(ymd(w.comparisonStart!), '2026-07-09');
  assert.equal(ymd(w.comparisonEnd!), '2026-07-16');
});

test('Last Week is the prior Monday through Sunday', () => {
  // Jul 22, 2026 is a Wednesday. This week's Monday = Jul 20. Last week = Jul 13–19.
  const w = resolveCallGridWindow({ preset: 'last_week' }, NOW);
  assert.equal(ymd(w.start), '2026-07-13');
  assert.equal(ymd(w.end), '2026-07-20'); // exclusive → last included day is Jul 19 (Sun)
  assert.equal(ymd(new Date(w.end.getTime() - 1)), '2026-07-19');
  // Comparison = the complete week before.
  assert.equal(ymd(w.comparisonStart!), '2026-07-06');
  assert.equal(ymd(w.comparisonEnd!), '2026-07-13');
});

test('Last 2 Weeks is the two complete weeks before this week', () => {
  const w = resolveCallGridWindow({ preset: 'last_2_weeks' }, NOW);
  assert.equal(ymd(w.start), '2026-07-06');
  assert.equal(ymd(w.end), '2026-07-20');
});

test('This Month begins on the first Eastern calendar day; ends now', () => {
  const w = resolveCallGridWindow({ preset: 'this_month' }, NOW);
  assert.equal(ymd(w.start), '2026-07-01');
  assert.equal(w.end.getTime(), NOW.getTime());
  // Comparison starts at the first of last month.
  assert.equal(ymd(w.comparisonStart!), '2026-06-01');
});

test('Last Month is the prior complete calendar month', () => {
  const w = resolveCallGridWindow({ preset: 'last_month' }, NOW);
  assert.equal(ymd(w.start), '2026-06-01');
  assert.equal(ymd(w.end), '2026-07-01');
  assert.equal(ymd(w.comparisonStart!), '2026-05-01');
});

test('Year to Date starts January 1 Eastern; compares to the same span last year', () => {
  const w = resolveCallGridWindow({ preset: 'year_to_date' }, NOW);
  assert.equal(ymd(w.start), '2026-01-01');
  assert.equal(w.end.getTime(), NOW.getTime());
  assert.equal(ymd(w.comparisonStart!), '2025-01-01');
});

test('Custom range is inclusive of both endpoints and order-tolerant', () => {
  const w = resolveCallGridWindow({ preset: 'custom', start: '2026-07-10', end: '2026-07-12' }, NOW);
  assert.equal(ymd(w.start), '2026-07-10');
  assert.equal(ymd(w.end), '2026-07-13'); // exclusive → Jul 12 included
  assert.equal(ymd(new Date(w.end.getTime() - 1)), '2026-07-12');
  // Reversed inputs resolve to the same window.
  const rev = resolveCallGridWindow({ preset: 'custom', start: '2026-07-12', end: '2026-07-10' }, NOW);
  assert.equal(rev.start.getTime(), w.start.getTime());
  assert.equal(rev.end.getTime(), w.end.getTime());
  // Comparison = the immediately preceding period of equal length (3 days).
  assert.equal(ymd(w.comparisonStart!), '2026-07-07');
  assert.equal(ymd(w.comparisonEnd!), '2026-07-10');
});

test('a January "now" wraps Year to Date comparison to the prior calendar year', () => {
  const jan = new Date('2026-01-05T17:00:00.000Z'); // Jan 5, 2026 12:00 ET
  const w = resolveCallGridWindow({ preset: 'year_to_date' }, jan);
  assert.equal(ymd(w.start), '2026-01-01');
  assert.equal(ymd(w.comparisonStart!), '2025-01-01');
});

test('parseCallGridRange defaults to today and rejects unknown presets', () => {
  assert.equal(parseCallGridRange({ range: null }).preset, 'today');
  assert.equal(parseCallGridRange({ range: 'nonsense' }).preset, 'today');
  assert.equal(parseCallGridRange({ range: 'last_30_days' }).preset, 'last_30_days');
  const custom = parseCallGridRange({ range: 'custom', s: '2026-07-01', e: '2026-07-05' });
  assert.equal(custom.preset, 'custom');
  assert.equal(custom.start, '2026-07-01');
});

test('an invalid custom range falls back to today rather than throwing', () => {
  const w = resolveCallGridWindow({ preset: 'custom', start: 'bad', end: '2026-07-05' }, NOW);
  assert.equal(w.preset, 'today');
});
