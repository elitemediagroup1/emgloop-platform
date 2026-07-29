// CallGrid date-window contract — deterministic, Eastern (America/New_York).
// `now` is injected so every assertion is reproducible. These cover the spec's
// preset definitions and comparison rules (Phase 17 date tests).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveCallGridWindow, parseCallGridRange, easternYmd,
  describeCallGridWindow, callGridDayNav, callGridRangeQuery,
} from '../src/index';

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
  // Comparison = yesterday cut at the SAME wall-clock time, not all of yesterday.
  assert.equal(w.comparisonBasis, 'elapsed_matched');
  assert.equal(ymd(w.comparisonStart!), '2026-07-21');
  assert.equal(ymd(w.comparisonEnd!), '2026-07-21');
  assert.equal(w.comparisonEnd!.toISOString(), '2026-07-21T18:30:00.000Z'); // 2:30 PM ET
  assert.equal(w.includesLiveData, true);
  assert.equal(w.isCompleted, false);
  assert.equal(w.isSingleDay, true);
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
  // Comparison: the preceding seven-day period, cut at the same elapsed point —
  // six complete days plus the same part of the seventh, mirroring the selection.
  assert.equal(w.comparisonBasis, 'elapsed_matched');
  assert.equal(ymd(w.comparisonStart!), '2026-07-09');
  assert.equal(ymd(w.comparisonEnd!), '2026-07-15');
  assert.equal(w.comparisonEnd!.toISOString(), '2026-07-15T18:30:00.000Z');
  // Both periods cover the same elapsed duration.
  assert.equal(
    w.comparisonEnd!.getTime() - w.comparisonStart!.getTime(),
    w.end.getTime() - w.start.getTime(),
  );
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
  assert.equal(w.comparisonBasis, 'complete_period');
  assert.equal(w.isCompleted, true);
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

test('an invalid custom range falls back to today and reports itself invalid', () => {
  const w = resolveCallGridWindow({ preset: 'custom', start: 'bad', end: '2026-07-05' }, NOW);
  assert.equal(w.preset, 'today');
  assert.equal(w.isValid, false);
});

// --- Live / completed presentation (describeCallGridWindow) ------------------

test('Today resolves in Eastern and is described as Live', () => {
  const d = describeCallGridWindow(resolveCallGridWindow({ preset: 'today' }, NOW), NOW);
  assert.equal(d.live, true);
  assert.equal(d.statusWord, 'Live');
  assert.equal(d.headerLine, 'Today · Live · Jul 22, 2026 · Eastern Time');
  assert.equal(d.periodTitle, 'Today · Live');
  assert.equal(d.comparisonTitle, 'Yesterday · through 2:30 PM');
  assert.match(d.comparisonNote!, /only up to 2:30 PM Eastern Time/);
});

test('Yesterday is described as Completed', () => {
  const d = describeCallGridWindow(resolveCallGridWindow({ preset: 'yesterday' }, NOW), NOW);
  assert.equal(d.live, false);
  assert.equal(d.statusWord, 'Completed');
  assert.equal(d.headerLine, 'Yesterday · Completed · Jul 21, 2026 · Eastern Time');
  assert.equal(d.comparisonTitle, 'Previous Day');
});

test('a historical custom single day is Completed with a Previous Day comparison', () => {
  const w = resolveCallGridWindow({ preset: 'custom', start: '2026-07-15', end: '2026-07-15' }, NOW);
  const d = describeCallGridWindow(w, NOW);
  assert.equal(d.isSingleDay, true);
  assert.equal(d.live, false);
  assert.equal(d.headerLine, 'Completed · Jul 15, 2026 · Eastern Time');
  assert.equal(d.periodTitle, 'Jul 15, 2026 · Completed');
  assert.equal(d.comparisonTitle, 'Previous Day');
});

test('a completed multi-day range is labeled Completed', () => {
  const w = resolveCallGridWindow({ preset: 'custom', start: '2026-07-15', end: '2026-07-19' }, NOW);
  const d = describeCallGridWindow(w, NOW);
  assert.equal(d.isSingleDay, false);
  assert.equal(d.live, false);
  assert.equal(d.statusWord, 'Completed');
  assert.match(d.headerLine, /· Completed · Eastern Time$/);
});

test('a range containing Today is labeled Includes Live Data', () => {
  const d = describeCallGridWindow(resolveCallGridWindow({ preset: 'last_7_days' }, NOW), NOW);
  assert.equal(d.live, true);
  assert.equal(d.statusWord, 'Includes Live Data');
  assert.match(d.headerLine, /· Includes Live Data · Eastern Time$/);
  assert.equal(d.periodTitle, 'Last 7 Days');
  assert.equal(d.comparisonTitle, 'Previous 7 Days · through 2:30 PM');
});

// --- Previous / next day navigation (callGridDayNav) -------------------------

test('Next Day is disabled on Today; Previous Day steps back one Eastern day', () => {
  const nav = callGridDayNav(resolveCallGridWindow({ preset: 'today' }, NOW), NOW);
  assert.ok(nav);
  assert.equal(nav!.nextQuery, null); // disabled on Today
  assert.equal(nav!.prevQuery, 'range=custom&s=2026-07-21&e=2026-07-21');
});

test('stepping forward from yesterday returns to Today (as the today preset)', () => {
  const nav = callGridDayNav(resolveCallGridWindow({ preset: 'yesterday' }, NOW), NOW);
  assert.ok(nav);
  assert.equal(nav!.nextQuery, 'range=today');
  assert.equal(nav!.prevQuery, 'range=custom&s=2026-07-20&e=2026-07-20');
});

test('a historical day steps to adjacent custom days', () => {
  const w = resolveCallGridWindow({ preset: 'custom', start: '2026-07-15', end: '2026-07-15' }, NOW);
  const nav = callGridDayNav(w, NOW);
  assert.ok(nav);
  assert.equal(nav!.prevQuery, 'range=custom&s=2026-07-14&e=2026-07-14');
  assert.equal(nav!.nextQuery, 'range=custom&s=2026-07-16&e=2026-07-16');
});

test('multi-day ranges have no single-day navigation', () => {
  assert.equal(callGridDayNav(resolveCallGridWindow({ preset: 'last_7_days' }, NOW), NOW), null);
});

test('every preset serializes an explicit range (Today is not a bare URL)', () => {
  assert.equal(callGridRangeQuery('today'), 'range=today');
  assert.equal(callGridRangeQuery('last_7_days'), 'range=last_7_days');
  assert.equal(callGridRangeQuery('custom', { start: '2026-07-01', end: '2026-07-05' }), 'range=custom&s=2026-07-01&e=2026-07-05');
});

// --- Elapsed-matched comparisons ---------------------------------------------
// The defect this contract exists to prevent: comparing an in-progress window
// against a COMPLETE prior period. At 9am that reports a ~-85% revenue collapse
// every morning, which is really just the clock. Every live preset must compare
// like-for-like; every completed preset must compare whole period to whole period.

const LIVE_PRESETS = ['today', 'last_2_days', 'last_7_days', 'last_14_days', 'last_30_days', 'this_week', 'this_month', 'year_to_date'] as const;
const COMPLETED_PRESETS = ['yesterday', 'last_week', 'last_2_weeks', 'last_month'] as const;

test('every in-progress preset compares against an equal elapsed duration', () => {
  for (const preset of LIVE_PRESETS) {
    const w = resolveCallGridWindow({ preset }, NOW);
    assert.equal(w.comparisonBasis, 'elapsed_matched', preset);
    assert.equal(w.includesLiveData, true, preset);
    assert.equal(w.isCompleted, false, preset);
    const selected = w.end.getTime() - w.start.getTime();
    const compared = w.comparisonEnd!.getTime() - w.comparisonStart!.getTime();
    // Month/year windows differ in calendar length; allow a whole-day tolerance
    // there, but the comparison may never run to a full period beyond the selection.
    const tolerance = preset === 'this_month' || preset === 'year_to_date' ? 3 * 24 * 3600 * 1000 : 1000;
    assert.ok(
      Math.abs(selected - compared) <= tolerance,
      `${preset}: selected ${selected}ms vs compared ${compared}ms`,
    );
  }
});

test('an in-progress comparison never extends past the point the selection reached', () => {
  // 6:00 AM ET — the case that produced fake collapses: a 6-hour window must not
  // be measured against a 24-hour one.
  const morning = new Date('2026-07-22T10:00:00.000Z');
  const w = resolveCallGridWindow({ preset: 'today' }, morning);
  assert.equal(w.comparisonEnd!.toISOString(), '2026-07-21T10:00:00.000Z');
  assert.equal(
    w.comparisonEnd!.getTime() - w.comparisonStart!.getTime(),
    w.end.getTime() - w.start.getTime(),
  );
});

test('every completed preset compares whole period against whole prior period', () => {
  for (const preset of COMPLETED_PRESETS) {
    const w = resolveCallGridWindow({ preset }, NOW);
    assert.equal(w.comparisonBasis, 'complete_period', preset);
    assert.equal(w.isCompleted, true, preset);
    assert.equal(w.includesLiveData, false, preset);
    // A completed window's comparison ends exactly where the selection begins.
    assert.equal(w.comparisonEnd!.getTime(), w.start.getTime(), preset);
  }
});

test('the comparison cut is wall-clock, not elapsed milliseconds, across a DST change', () => {
  // Sun Nov 1, 2026 is the EDT→EST fall-back: that Eastern day is 25 hours long.
  // Nov 2 at 10:00 ET compares against Nov 1 at 10:00 ET (wall clock) — matching
  // raw elapsed time would land at 09:00 and silently drop an hour of yesterday.
  const now = new Date('2026-11-02T15:00:00.000Z'); // 10:00 EST
  const w = resolveCallGridWindow({ preset: 'today' }, now);
  const cut = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit',
  }).format(w.comparisonEnd!);
  assert.equal(cut, '10:00 AM');
  assert.equal(ymd(w.comparisonEnd!), '2026-11-01');
});

test('This Month compares to the same day-of-month and time last month', () => {
  const w = resolveCallGridWindow({ preset: 'this_month' }, NOW); // Jul 22, 2:30 PM
  assert.equal(ymd(w.comparisonStart!), '2026-06-01');
  assert.equal(ymd(w.comparisonEnd!), '2026-06-22');
});

test('This Month clamps to the last day of a shorter previous month', () => {
  const mar31 = new Date('2026-03-31T16:30:00.000Z'); // Mar 31, 2026, 12:30 ET
  const w = resolveCallGridWindow({ preset: 'this_month' }, mar31);
  assert.equal(ymd(w.comparisonStart!), '2026-02-01');
  assert.equal(ymd(w.comparisonEnd!), '2026-02-28'); // no Feb 31
});

test('Year to Date compares to the same calendar point last year', () => {
  const w = resolveCallGridWindow({ preset: 'year_to_date' }, NOW);
  assert.equal(ymd(w.comparisonStart!), '2025-01-01');
  assert.equal(ymd(w.comparisonEnd!), '2025-07-22');
});

test('a custom range ending today ends at now, not at a future midnight', () => {
  const w = resolveCallGridWindow({ preset: 'custom', start: '2026-07-20', end: '2026-07-22' }, NOW);
  assert.equal(w.end.getTime(), NOW.getTime()); // never reports past the current instant
  assert.equal(w.includesLiveData, true);
  assert.equal(w.comparisonBasis, 'elapsed_matched');
  // Three selected days → the three days before, cut at the same time.
  assert.equal(ymd(w.comparisonStart!), '2026-07-17');
  assert.equal(ymd(w.comparisonEnd!), '2026-07-19');
});

test('a custom range extending into the future is clamped to today', () => {
  const w = resolveCallGridWindow({ preset: 'custom', start: '2026-07-20', end: '2026-08-30' }, NOW);
  assert.equal(w.end.getTime(), NOW.getTime());
  assert.equal(ymd(new Date(w.end.getTime() - 1)), '2026-07-22');
});

test('a custom range entirely in the future is invalid and falls back to today', () => {
  const w = resolveCallGridWindow({ preset: 'custom', start: '2026-08-01', end: '2026-08-05' }, NOW);
  assert.equal(w.preset, 'today');
  assert.equal(w.isValid, false);
});

test('a completed window states its comparison is directly comparable', () => {
  const d = describeCallGridWindow(resolveCallGridWindow({ preset: 'yesterday' }, NOW), NOW);
  assert.match(d.comparisonNote!, /complete period of the same length/);
});
