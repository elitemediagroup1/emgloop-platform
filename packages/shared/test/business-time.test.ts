import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BUSINESS_TIME_ZONE,
  startOfEasternDay,
  endOfEasternDay,
  startOfPreviousEasternDay,
  easternYmd,
  easternWallTimeToUtc,
  easternYesterdayWindow,
  easternTodayWindow,
} from '../src/business-time';

test('BUSINESS_TIME_ZONE is the IANA identifier, not a fixed offset', () => {
  assert.equal(BUSINESS_TIME_ZONE, 'America/New_York');
});

test('start of Eastern day during EST (UTC-5)', () => {
  // 2025-01-15 12:00 UTC is 07:00 ET; the Eastern day starts at 00:00 EST = 05:00 UTC.
  assert.equal(startOfEasternDay(new Date('2025-01-15T12:00:00Z')).toISOString(), '2025-01-15T05:00:00.000Z');
});

test('start of Eastern day during EDT (UTC-4)', () => {
  // 2025-07-15 12:00 UTC → 00:00 EDT = 04:00 UTC.
  assert.equal(startOfEasternDay(new Date('2025-07-15T12:00:00Z')).toISOString(), '2025-07-15T04:00:00.000Z');
});

test('a UTC instant after UTC-midnight but before Eastern-midnight belongs to the previous Eastern day', () => {
  // 2025-01-16 02:00 UTC = 2025-01-15 21:00 ET → the 15th.
  assert.deepEqual(easternYmd(new Date('2025-01-16T02:00:00Z')), { year: 2025, month: 1, day: 15 });
  // 2025-01-16 06:00 UTC = 2025-01-16 01:00 ET → the 16th.
  assert.deepEqual(easternYmd(new Date('2025-01-16T06:00:00Z')), { year: 2025, month: 1, day: 16 });
});

test('spring-forward day: starts EST, ends entering EDT — a 23-hour day', () => {
  const anyInstant = new Date('2025-03-09T15:00:00Z'); // mid-day Mar 9 ET (DST begins 02:00 EST → 03:00 EDT)
  const start = startOfEasternDay(anyInstant);
  const end = endOfEasternDay(anyInstant);
  assert.equal(start.toISOString(), '2025-03-09T05:00:00.000Z'); // 00:00 EST
  assert.equal(end.toISOString(), '2025-03-10T03:59:59.999Z'); // just before 00:00 EDT
  assert.equal((end.getTime() + 1 - start.getTime()) / 3600000, 23);
});

test('fall-back day: starts EDT, ends entering EST — a 25-hour day', () => {
  const anyInstant = new Date('2025-11-02T15:00:00Z'); // DST ends 02:00 EDT → 01:00 EST
  const start = startOfEasternDay(anyInstant);
  const end = endOfEasternDay(anyInstant);
  assert.equal(start.toISOString(), '2025-11-02T04:00:00.000Z'); // 00:00 EDT
  assert.equal(end.toISOString(), '2025-11-03T04:59:59.999Z'); // just before 00:00 EST
  assert.equal((end.getTime() + 1 - start.getTime()) / 3600000, 25);
});

test('easternWallTimeToUtc handles the spring-forward gap correctly', () => {
  // 01:30 ET on Mar 9 is EST (before the jump) → 06:30 UTC.
  assert.equal(easternWallTimeToUtc(2025, 3, 9, 1, 30).toISOString(), '2025-03-09T06:30:00.000Z');
  // 03:30 ET is EDT (after the jump) → 07:30 UTC.
  assert.equal(easternWallTimeToUtc(2025, 3, 9, 3, 30).toISOString(), '2025-03-09T07:30:00.000Z');
});

test('yesterday window is the previous COMPLETED Eastern day; today window is LIVE and ends now', () => {
  const now = new Date('2025-07-15T18:30:00Z'); // 14:30 ET
  const y = easternYesterdayWindow(now);
  const t = easternTodayWindow(now);
  assert.equal(y.start.toISOString(), '2025-07-14T04:00:00.000Z');
  assert.equal(y.end.toISOString(), '2025-07-15T04:00:00.000Z');
  assert.equal(t.start.toISOString(), '2025-07-15T04:00:00.000Z');
  assert.equal(t.end.getTime(), now.getTime());
});

test('previous Eastern day floor', () => {
  assert.equal(startOfPreviousEasternDay(new Date('2025-07-15T12:00:00Z')).toISOString(), '2025-07-14T04:00:00.000Z');
});
