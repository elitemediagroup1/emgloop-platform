// Loop Time Authority — the pure core (src/loop-time.ts).
//
// The verified defect this exists to end: at 8:37 PM Eastern on 2026-09-14, CRM
// dates read "Sep 15" because the server formatted in UTC, while "8m ago" beside
// them was right. One instant, one zone, one set of formatters -- so the absolute
// date and the relative time come from the same place and cannot disagree.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CANONICAL_TIME_ZONE,
  calendarDaysBetween,
  createTimeView,
  easternYmd,
  formatCalendarDate,
  formatInstant,
  parseTimeZone,
  relativeTime,
  resolveDisplayTimeZone,
  startOfZonedDay,
  timeOfDayGreeting,
  toInstant,
  zoneOffsetMinutes,
  zonedCalendarDay,
  zonedParts,
  zonedWallTimeToUtc,
} from '../src';

const BOUNDARY = new Date('2026-09-15T00:37:00Z');

test('the midnight boundary: one instant, five readers, each sees their own calendar day', () => {
  const expected: [string, string, string, string][] = [
    ['UTC', 'Sep 15, 2026', 'Sep 15, 2026, 12:37 AM', 'Sep 15, 2026, 12:37:00 AM UTC'],
    ['America/New_York', 'Sep 14, 2026', 'Sep 14, 2026, 8:37 PM', 'Sep 14, 2026, 8:37:00 PM EDT'],
    ['America/Chicago', 'Sep 14, 2026', 'Sep 14, 2026, 7:37 PM', 'Sep 14, 2026, 7:37:00 PM CDT'],
    ['America/Denver', 'Sep 14, 2026', 'Sep 14, 2026, 6:37 PM', 'Sep 14, 2026, 6:37:00 PM MDT'],
    ['America/Los_Angeles', 'Sep 14, 2026', 'Sep 14, 2026, 5:37 PM', 'Sep 14, 2026, 5:37:00 PM PDT'],
  ];
  for (const [zone, date, dateTime, full] of expected) {
    assert.equal(formatInstant(BOUNDARY, zone, 'date'), date, zone);
    assert.equal(formatInstant(BOUNDARY, zone, 'dateTime'), dateTime, zone);
    assert.equal(formatInstant(BOUNDARY, zone, 'full'), full, zone);
    assert.equal(zonedCalendarDay(BOUNDARY, zone), zone === 'UTC' ? '2026-09-15' : '2026-09-14', zone);
  }
  // Every reader is looking at the same immutable instant.
  assert.equal(BOUNDARY.toISOString(), '2026-09-15T00:37:00.000Z');
});

test('daylight saving comes from IANA rules: offsets, wall clocks and day lengths change on the right instant', () => {
  // Spring forward, New York, 2026-03-08 02:00 local.
  assert.equal(formatInstant('2026-03-08T06:59:00Z', 'America/New_York', 'full'), 'Mar 8, 2026, 1:59:00 AM EST');
  assert.equal(formatInstant('2026-03-08T07:00:00Z', 'America/New_York', 'full'), 'Mar 8, 2026, 3:00:00 AM EDT');
  assert.equal(zoneOffsetMinutes(new Date('2026-03-08T06:59:00Z'), 'America/New_York'), -300);
  assert.equal(zoneOffsetMinutes(new Date('2026-03-08T07:00:00Z'), 'America/New_York'), -240);
  // Fall back, New York, 2026-11-01: 1:30 AM happens twice, once in each offset.
  assert.equal(formatInstant('2026-11-01T05:30:00Z', 'America/New_York', 'full'), 'Nov 1, 2026, 1:30:00 AM EDT');
  assert.equal(formatInstant('2026-11-01T06:30:00Z', 'America/New_York', 'full'), 'Nov 1, 2026, 1:30:00 AM EST');
  // Los Angeles springs forward three hours of UTC later than New York.
  assert.equal(formatInstant('2026-03-08T09:59:00Z', 'America/Los_Angeles', 'full'), 'Mar 8, 2026, 1:59:00 AM PST');
  assert.equal(formatInstant('2026-03-08T10:00:00Z', 'America/Los_Angeles', 'full'), 'Mar 8, 2026, 3:00:00 AM PDT');
  // Calendar days are 23 and 25 hours long on transition days, never 24 by arithmetic.
  const march8 = startOfZonedDay(new Date('2026-03-08T12:00:00Z'), 'America/New_York');
  const march9 = startOfZonedDay(new Date('2026-03-09T12:00:00Z'), 'America/New_York');
  assert.equal(march8.toISOString(), '2026-03-08T05:00:00.000Z');
  assert.equal((march9.getTime() - march8.getTime()) / 3_600_000, 23);
  const nov1 = startOfZonedDay(new Date('2026-11-01T12:00:00Z'), 'America/New_York');
  const nov2 = startOfZonedDay(new Date('2026-11-02T12:00:00Z'), 'America/New_York');
  assert.equal((nov2.getTime() - nov1.getTime()) / 3_600_000, 25);
  // Wall time to instant, including the gap and the overlap: deterministic, and
  // always an instant that exists.
  assert.equal(zonedWallTimeToUtc('America/New_York', 2026, 3, 8, 3, 30).toISOString(), '2026-03-08T07:30:00.000Z');
  assert.equal(zonedWallTimeToUtc('America/New_York', 2026, 3, 8, 2, 30).toISOString(), '2026-03-08T06:30:00.000Z');
  assert.equal(zonedWallTimeToUtc('America/New_York', 2026, 11, 1, 1, 30).toISOString(), '2026-11-01T05:30:00.000Z');
});

test('the Eastern reporting calendar is the same math with its own zone applied', () => {
  for (const iso of ['2026-09-15T00:37:00Z', '2026-03-08T06:59:00Z', '2026-03-08T07:00:00Z', '2026-11-01T05:30:00Z', '2026-12-31T23:59:59Z']) {
    const { year, month, day } = zonedParts(new Date(iso), 'America/New_York');
    assert.deepEqual(easternYmd(new Date(iso)), { year, month, day }, iso);
  }
});

test('a timezone is an IANA name the platform knows; everything else fails closed', () => {
  const valid: [unknown, string][] = [
    ['America/New_York', 'America/New_York'],
    ['america/new_york', 'America/New_York'],
    ['America/Los_Angeles', 'America/Los_Angeles'],
    ['UTC', 'UTC'],
    ['Etc/UTC', 'UTC'],
    ['America/Port-au-Prince', 'America/Port-au-Prince'],
    ['  America/Chicago  ', 'America/Chicago'],
  ];
  for (const [input, canonical] of valid) assert.equal(parseTimeZone(input), canonical, String(input));

  const invalid: unknown[] = [
    undefined, null, 42, {}, [], '', '   ',
    '+05:00', '-0400', 'UTC+5', 'GMT-4', 'utc-04:00', // offsets carry no DST rules
    'Not/AZone', 'America/New York', 'America/New_York; Path=/', 'America/New_York\nSet-Cookie: x=1',
    '<script>alert(1)</script>', '../../etc/passwd', 'America//New_York', 'a'.repeat(65),
  ];
  for (const input of invalid) assert.equal(parseTimeZone(input), null, JSON.stringify(input));
});

test('resolution order: preference, then device, then UTC -- never an organization or EMG zone', () => {
  assert.deepEqual(resolveDisplayTimeZone({}), { timeZone: CANONICAL_TIME_ZONE, source: 'fallback' });
  assert.deepEqual(resolveDisplayTimeZone({ device: undefined }), { timeZone: 'UTC', source: 'fallback' });
  assert.deepEqual(resolveDisplayTimeZone({ device: '+05:00' }), { timeZone: 'UTC', source: 'fallback' });
  assert.deepEqual(resolveDisplayTimeZone({ device: 'America/Denver' }), { timeZone: 'America/Denver', source: 'device' });
  assert.deepEqual(resolveDisplayTimeZone({ preference: 'America/Chicago', device: 'America/Denver' }), { timeZone: 'America/Chicago', source: 'preference' });
  assert.deepEqual(resolveDisplayTimeZone({ preference: 'nonsense', device: 'America/Denver' }), { timeZone: 'America/Denver', source: 'device' });
  assert.notEqual(resolveDisplayTimeZone({}).timeZone, 'America/New_York', 'no silent Eastern fallback');
});

test('the UTC fallback names its zone on every absolute time, so it is never mistaken for local', () => {
  const fallback = createTimeView({ timeZone: 'UTC', source: 'fallback' }, BOUNDARY);
  assert.equal(fallback.date(BOUNDARY), 'Sep 15, 2026, UTC');
  assert.equal(fallback.dateTime(BOUNDARY), 'Sep 15, 2026, 12:37 AM UTC');
  assert.equal(fallback.monthDayTime(BOUNDARY), 'Sep 15, 12:37 AM UTC');
  const device = createTimeView({ timeZone: 'America/New_York', source: 'device' }, BOUNDARY);
  assert.equal(device.date(BOUNDARY), 'Sep 14, 2026');
  assert.equal(device.dateTime(BOUNDARY), 'Sep 14, 2026, 8:37 PM');
  assert.equal(device.full(BOUNDARY), 'Sep 14, 2026, 8:37:00 PM EDT');
});

test('missing or unparseable instants render as nothing, for the caller to label', () => {
  const view = createTimeView({ timeZone: 'America/New_York', source: 'device' }, BOUNDARY);
  for (const v of [null, undefined, '', 'not a date', Number.NaN]) {
    assert.equal(view.date(v), '');
    assert.equal(view.relative(v), '');
    assert.equal(view.iso(v), '');
  }
});

test('relative time agrees with the absolute date beside it, in every zone', () => {
  const now = BOUNDARY; // Sep 14, 8:37 PM in New York; Sep 15, 12:37 AM in UTC
  assert.equal(relativeTime('2026-09-15T00:29:00Z', now, 'America/New_York'), '8m ago');
  assert.equal(relativeTime('2026-09-15T00:36:30Z', now, 'America/New_York'), 'just now');
  assert.equal(relativeTime('2026-09-14T03:00:00Z', now, 'America/New_York'), '21h ago');
  // 36 hours earlier: the previous calendar day in New York, two days back in UTC.
  assert.equal(relativeTime('2026-09-13T12:00:00Z', now, 'America/New_York'), 'yesterday');
  assert.equal(relativeTime('2026-09-13T12:00:00Z', now, 'UTC'), '2d ago');
  assert.equal(relativeTime('2026-09-13T12:00:00Z', now, 'America/New_York', { style: 'long' }), 'yesterday');
  assert.equal(relativeTime('2026-07-01T12:00:00Z', now, 'America/New_York', { style: 'long' }), '2 months ago');
  assert.equal(relativeTime('2026-09-15T02:37:00Z', now, 'America/New_York'), 'in 2h');

  // Property: whenever the relative time names days, it is exactly the calendar
  // distance between the dates a reader in that zone sees.
  let seed = 20260915;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let i = 0; i < 2000; i++) {
    const zone = ['UTC', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles'][i % 5]!;
    const nowI = new Date(Date.UTC(2026, 0, 1) + Math.floor(rand() * 365 * 86_400_000));
    const then = new Date(nowI.getTime() - Math.floor(rand() * 20 * 86_400_000));
    const words = relativeTime(then, nowI, zone);
    const days = calendarDaysBetween(then, nowI, zone);
    if (words === 'yesterday') assert.equal(days, 1, `${zone} ${then.toISOString()} → ${nowI.toISOString()}`);
    const m = /^(\d+)d ago$/.exec(words);
    if (m) assert.equal(Number(m[1]), days, `${zone} ${then.toISOString()} → ${nowI.toISOString()}`);
  }
});

test('presenting a time never changes the instant', () => {
  const stored = new Date('2026-09-15T00:37:00Z');
  const before = stored.getTime();
  for (const zone of ['UTC', 'America/New_York', 'America/Los_Angeles']) {
    const view = createTimeView({ timeZone: zone, source: 'device' }, new Date('2026-09-15T01:00:00Z'));
    view.date(stored); view.dateTime(stored); view.full(stored); view.relative(stored); view.startOfDay(stored);
    formatInstant(stored, zone, 'weekdayDate');
  }
  assert.equal(stored.getTime(), before);
  assert.notEqual(toInstant(stored), stored, 'a copy, never the caller\'s Date');
  // The canonical form every reader shares is unaffected by who is reading.
  assert.equal(createTimeView({ timeZone: 'America/Los_Angeles', source: 'device' }, BOUNDARY).iso(stored), '2026-09-15T00:37:00.000Z');
  assert.equal(createTimeView({ timeZone: 'America/New_York', source: 'device' }, BOUNDARY).iso(stored), '2026-09-15T00:37:00.000Z');
});

test('greetings and "today" follow the reader, not the server', () => {
  assert.equal(timeOfDayGreeting(BOUNDARY, 'UTC'), 'Good morning');
  assert.equal(timeOfDayGreeting(BOUNDARY, 'America/New_York'), 'Good evening');
  assert.equal(timeOfDayGreeting(BOUNDARY, 'America/Los_Angeles'), 'Good afternoon'); // 5:37 PM
  assert.equal(createTimeView({ timeZone: 'America/New_York', source: 'device' }, BOUNDARY).startOfDay().toISOString(), '2026-09-14T04:00:00.000Z');
  assert.equal(createTimeView({ timeZone: 'UTC', source: 'fallback' }, BOUNDARY).startOfDay().toISOString(), '2026-09-15T00:00:00.000Z');
});

test('a calendar date picked in a date input is the same day for every reader', () => {
  // `new Date('2026-09-15')` is that day's UTC midnight -- converting it to New
  // York would show September 14.
  assert.equal(formatCalendarDate(new Date('2026-09-15')), 'Sep 15, 2026');
  assert.equal(formatCalendarDate('2026-09-15T00:00:00.000Z', 'monthDay'), 'Sep 15');
  assert.equal(formatInstant(new Date('2026-09-15'), 'America/New_York', 'date'), 'Sep 14, 2026', 'why it must not be converted');
});
