// Daily / Weekly / Monthly: each period resolves through the one window contract,
// so an in-progress period is compared at the same elapsed point and a finished one
// against the finished period before it. `now` is injected; every assertion is fixed.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  callGridPeriodLabel,
  callGridPeriodNav,
  callGridPeriodWindow,
  easternYmd,
  readCallGridSelection,
  resolveCallGridWindow,
  selectCallGridPeriod,
} from '../src/index';

// Fri Sep 18, 2026, 2:30 PM EDT.
const NOW = new Date('2026-09-18T18:30:00.000Z');
const ymd = (d: Date) => {
  const y = easternYmd(d);
  return `${y.year}-${String(y.month).padStart(2, '0')}-${String(y.day).padStart(2, '0')}`;
};

test('today, Daily: the live preset — compared with yesterday to the same time, never all of yesterday', () => {
  const sel = selectCallGridPeriod({}, NOW);
  assert.equal(sel.period, 'daily');
  assert.equal(sel.current, true);
  const w = callGridPeriodWindow(sel, NOW);
  assert.deepEqual(w, resolveCallGridWindow({ preset: 'today' }, NOW));
  assert.equal(w.comparisonBasis, 'elapsed_matched');
  assert.equal(w.comparisonEnd!.toISOString(), '2026-09-17T18:30:00.000Z');
  assert.equal(w.isCompleted, false, 'an in-progress day is never represented as complete');
});

test('this week and this month are in progress too, and compare at the same elapsed point', () => {
  const week = callGridPeriodWindow(selectCallGridPeriod({ period: 'weekly' }, NOW), NOW);
  assert.equal(ymd(week.start), '2026-09-14', 'CallGrid weeks start on Monday');
  assert.equal(week.end.getTime(), NOW.getTime());
  assert.equal(week.comparisonBasis, 'elapsed_matched');
  assert.equal(week.comparisonEnd!.toISOString(), '2026-09-11T18:30:00.000Z', 'last Friday at 2:30 PM');

  const month = callGridPeriodWindow(selectCallGridPeriod({ period: 'monthly' }, NOW), NOW);
  assert.equal(ymd(month.start), '2026-09-01');
  assert.equal(month.comparisonBasis, 'elapsed_matched');
  assert.equal(month.comparisonEnd!.toISOString(), '2026-08-18T18:30:00.000Z');
  assert.equal(month.isCompleted, false);
});

test('a finished day, week or month compares with the finished period of the same kind before it', () => {
  const day = callGridPeriodWindow(selectCallGridPeriod({ period: 'daily', date: '2026-09-10' }, NOW), NOW);
  assert.equal(ymd(day.start), '2026-09-10');
  assert.equal(ymd(day.end), '2026-09-11');
  assert.equal(ymd(day.comparisonStart!), '2026-09-09');
  assert.equal(day.comparisonBasis, 'complete_period');
  assert.equal(day.isCompleted, true);

  // Any date inside a week selects that Mon–Sun week.
  const week = callGridPeriodWindow(selectCallGridPeriod({ period: 'weekly', date: '2026-09-02' }, NOW), NOW);
  assert.equal(ymd(week.start), '2026-08-31');
  assert.equal(ymd(week.end), '2026-09-07');
  assert.equal(ymd(week.comparisonStart!), '2026-08-24');
  assert.equal(ymd(week.comparisonEnd!), '2026-08-31');

  // A past 31-day month is compared with the prior CALENDAR month, not "the preceding 31 days".
  const july = callGridPeriodWindow(selectCallGridPeriod({ period: 'monthly', date: '2026-07-15' }, NOW), NOW);
  assert.equal(ymd(july.start), '2026-07-01');
  assert.equal(ymd(july.end), '2026-08-01');
  assert.equal(ymd(july.comparisonStart!), '2026-06-01');
  assert.equal(ymd(july.comparisonEnd!), '2026-07-01');
  assert.equal(july.comparisonLabel, 'The prior month');
  // Last month keeps its own preset.
  const aug = callGridPeriodWindow(selectCallGridPeriod({ period: 'monthly', date: '2026-08-31' }, NOW), NOW);
  assert.equal(aug.preset, 'last_month');
});

test('a future or malformed date is the current period; an unknown period is Daily', () => {
  assert.equal(selectCallGridPeriod({ period: 'daily', date: '2026-12-25' }, NOW).current, true);
  assert.equal(selectCallGridPeriod({ period: 'daily', date: '2026-02-30' }, NOW).current, true);
  assert.equal(selectCallGridPeriod({ period: 'hourly' }, NOW).period, 'daily');
});

test('navigation steps one period, stops at the current one, and switching keeps the place', () => {
  const today = callGridPeriodNav(selectCallGridPeriod({}, NOW), NOW);
  assert.equal(today.prevQuery, 'period=daily&date=2026-09-17');
  assert.equal(today.nextQuery, null, 'nothing after today');
  assert.equal(today.currentQuery, null);

  const past = callGridPeriodNav(selectCallGridPeriod({ period: 'daily', date: '2026-09-17' }, NOW), NOW);
  assert.equal(past.nextQuery, 'period=daily', 'the day after yesterday is today, and carries no date');
  assert.equal(past.currentQuery, 'period=daily');
  assert.equal(past.switchQuery.weekly, 'period=weekly', 'Sep 17 is in the current week');
  assert.equal(past.switchQuery.monthly, 'period=monthly');

  const week = callGridPeriodNav(selectCallGridPeriod({ period: 'weekly', date: '2026-09-02' }, NOW), NOW);
  assert.equal(week.prevQuery, 'period=weekly&date=2026-08-24');
  assert.equal(week.nextQuery, 'period=weekly&date=2026-09-07');
  assert.equal(week.switchQuery.daily, 'period=daily&date=2026-08-31');

  const month = callGridPeriodNav(selectCallGridPeriod({ period: 'monthly', date: '2026-01-10' }, NOW), NOW);
  assert.equal(month.prevQuery, 'period=monthly&date=2025-12-01');
});

test('labels name the period the way a reader would', () => {
  assert.equal(callGridPeriodLabel(selectCallGridPeriod({}, NOW)), 'Fri, Sep 18, 2026');
  assert.equal(callGridPeriodLabel(selectCallGridPeriod({ period: 'weekly' }, NOW)), 'Sep 14 – 20, 2026');
  assert.equal(callGridPeriodLabel(selectCallGridPeriod({ period: 'weekly', date: '2026-09-02' }, NOW)), 'Aug 31 – Sep 6, 2026');
  assert.equal(callGridPeriodLabel(selectCallGridPeriod({ period: 'monthly' }, NOW)), 'September 2026');
});

test('every CallGrid URL reads through one reader: a period wins, a legacy range still resolves as before', () => {
  const bare = readCallGridSelection(undefined, NOW);
  assert.equal(bare.query, 'period=daily');
  assert.equal(bare.period?.current, true);

  const weekly = readCallGridSelection({ period: 'weekly', date: '2026-09-02' }, NOW);
  assert.equal(weekly.query, 'period=weekly&date=2026-08-31');
  assert.equal(ymd(weekly.window.start), '2026-08-31');

  const legacy = readCallGridSelection({ range: 'last_7_days' }, NOW);
  assert.equal(legacy.period, null);
  assert.equal(legacy.query, 'range=last_7_days');
  assert.deepEqual(legacy.window, resolveCallGridWindow({ preset: 'last_7_days' }, NOW));

  const custom = readCallGridSelection({ range: 'custom', s: '2026-09-01', e: '2026-09-05' }, NOW);
  assert.equal(custom.query, 'range=custom&s=2026-09-01&e=2026-09-05');

  // Both present: the period wins.
  assert.equal(readCallGridSelection({ period: 'monthly', range: 'today' }, NOW).window.preset, 'this_month');
});
