// Your Day's projection: what can be said about a day, and what cannot.
//
// Pure: every boundary and `now` is passed in, so a day in Chicago and a day in Tokyo are the
// same code with different arguments, and a 23-hour day is just a shorter pair of instants.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CALENDAR_REFRESH_AFTER_MS,
  CALENDAR_STALE_AFTER_MS,
  FRESHNESS_ADMITS_EMPTY,
  calendarFreshness,
  positionInDay,
  scheduleFor,
  shouldRefreshOnVisit,
  summarizeDay,
  startOfZonedDay,
  zonedCalendarDay,
  type DayBounds,
  type DayEvent,
} from '../src/index';

const NY = 'America/New_York';
const at = (iso: string) => new Date(iso);

function dayIn(zone: string, anchorIso: string): DayBounds {
  const startsAt = startOfZonedDay(at(anchorIso), zone);
  const endsAt = startOfZonedDay(new Date(startsAt.getTime() + 86_400_000 + 43_200_000), zone);
  return { civilDate: zonedCalendarDay(startsAt, zone), startsAt, endsAt };
}

function event(over: Partial<DayEvent> = {}): DayEvent {
  return {
    eventId: 'e1',
    summary: 'Team Daily',
    startsAt: at('2026-09-18T13:30:00Z'),
    endsAt: at('2026-09-18T14:00:00Z'),
    allDay: false,
    startDate: null,
    endDateExclusive: null,
    status: 'CONFIRMED',
    blocking: 'BLOCKING',
    kind: 'DEFAULT',
    selfResponse: 'ACCEPTED',
    hasConference: false,
    organizerIsSelf: true,
    attendanceKnown: true,
    attendeeCount: 6,
    externalAttendeeCount: 0,
    recurringEventId: null,
    ...over,
  };
}

test('a day is the employee’s local day: a timed event belongs to the day it starts in', () => {
  const day = dayIn(NY, '2026-09-18T12:00:00Z'); // 18 September in New York
  assert.equal(day.civilDate, '2026-09-18');

  const schedule = scheduleFor(
    [
      event({ eventId: 'early', startsAt: at('2026-09-18T04:30:00Z'), endsAt: at('2026-09-18T05:00:00Z') }), // 00:30 local
      event({ eventId: 'late', startsAt: at('2026-09-19T03:30:00Z'), endsAt: at('2026-09-19T04:30:00Z') }), // 23:30 local, crossing midnight
      event({ eventId: 'yesterday', startsAt: at('2026-09-17T18:00:00Z') }),
      event({ eventId: 'tomorrow', startsAt: at('2026-09-19T14:00:00Z') }),
    ],
    day,
  );
  assert.deepEqual(schedule.timed.map((e) => e.eventId), ['early', 'late'], 'a meeting that runs past midnight sits on the day it began');
});

test('an all-day entry is placed by civil date, and Google’s exclusive end is respected', () => {
  const day = dayIn(NY, '2026-09-18T12:00:00Z');
  const conference = event({ eventId: 'conf', allDay: true, startsAt: null, endsAt: null, startDate: '2026-09-17', endDateExclusive: '2026-09-19', summary: 'Conference' });
  const oneDay = event({ eventId: 'one', allDay: true, startsAt: null, endsAt: null, startDate: '2026-09-18', endDateExclusive: '2026-09-19' });
  const ended = event({ eventId: 'ended', allDay: true, startsAt: null, endsAt: null, startDate: '2026-09-16', endDateExclusive: '2026-09-18' });
  const noEnd = event({ eventId: 'no-end', allDay: true, startsAt: null, endsAt: null, startDate: '2026-09-18', endDateExclusive: null });

  const schedule = scheduleFor([conference, oneDay, ended, noEnd], day);
  assert.deepEqual(schedule.allDay.map((e) => e.eventId).sort(), ['conf', 'no-end', 'one']);
  assert.equal(schedule.allDay.some((e) => e.eventId === 'ended'), false, 'an exclusive end means the 18th is not covered');
});

test('cancelled and declined entries leave the schedule, and are counted rather than hidden', () => {
  const day = dayIn(NY, '2026-09-18T12:00:00Z');
  const schedule = scheduleFor(
    [
      event({ eventId: 'ok' }),
      event({ eventId: 'gone', status: 'CANCELLED' }),
      event({ eventId: 'declined', selfResponse: 'DECLINED' }),
    ],
    day,
  );
  assert.deepEqual(schedule.timed.map((e) => e.eventId), ['ok']);
  assert.deepEqual(schedule.excluded.map((e) => `${e.event.eventId}:${e.reason}`).sort(), ['declined:DECLINED', 'gone:CANCELLED']);

  const summary = summarizeDay(schedule, day, at('2026-09-18T12:00:00Z'));
  assert.equal(summary.cancelledCount, 1);
  assert.equal(summary.declinedCount, 1);
  assert.equal(summary.total, 1, 'the day is what remains');
});

test('what is happening now, what is next, and how long until it', () => {
  const day = dayIn(NY, '2026-09-18T12:00:00Z');
  const schedule = scheduleFor(
    [
      event({ eventId: 'standup', startsAt: at('2026-09-18T13:30:00Z'), endsAt: at('2026-09-18T14:00:00Z') }),
      event({ eventId: 'cashion', startsAt: at('2026-09-18T15:00:00Z'), endsAt: at('2026-09-18T15:30:00Z') }),
    ],
    day,
  );

  const during = positionInDay(schedule, at('2026-09-18T13:40:00Z'));
  assert.equal(during.inProgress?.eventId, 'standup');
  assert.equal(during.next?.eventId, 'cashion');
  assert.equal(during.minutesUntilNext, 80);
  assert.equal(during.remaining, 2);

  const after = positionInDay(schedule, at('2026-09-18T16:00:00Z'));
  assert.equal(after.inProgress, null);
  assert.equal(after.next, null);
  assert.equal(after.minutesUntilNext, null);
  assert.equal(after.remaining, 0, 'nothing left today');
});

test('the summary states only what the rows support', () => {
  const day = dayIn(NY, '2026-09-18T12:00:00Z');
  const morningOnly = scheduleFor(
    [
      event({ eventId: 'a', startsAt: at('2026-09-18T13:30:00Z'), endsAt: at('2026-09-18T14:00:00Z') }), // 09:30 local
      event({ eventId: 'b', startsAt: at('2026-09-18T14:30:00Z'), endsAt: at('2026-09-18T15:00:00Z') }), // 10:30 local
    ],
    day,
  );
  const summary = summarizeDay(morningOnly, day, at('2026-09-18T12:00:00Z'));
  assert.equal(summary.timedCount, 2);
  assert.equal(summary.firstStart?.toISOString(), '2026-09-18T13:30:00.000Z');
  assert.equal(summary.lastEnd?.toISOString(), '2026-09-18T15:00:00.000Z');
  assert.equal(summary.afternoonClear, true, 'nothing blocking between 12:00 and 17:00 local');
  assert.equal(summary.morningClear, false);

  // An event that does not block time does not make the afternoon busy.
  const transparent = scheduleFor([event({ eventId: 'free', startsAt: at('2026-09-18T18:00:00Z'), endsAt: at('2026-09-18T19:00:00Z'), blocking: 'FREE' })], day);
  assert.equal(summarizeDay(transparent, day, at('2026-09-18T12:00:00Z')).afternoonClear, true);

  // An empty day says nothing about its afternoon: there is nothing to characterise.
  const empty = scheduleFor([], day);
  const emptySummary = summarizeDay(empty, day, at('2026-09-18T12:00:00Z'));
  assert.equal(emptySummary.afternoonClear, null);
  assert.equal(emptySummary.total, 0);
});

test('a day that gains or loses an hour is still one local day', () => {
  // US autumn transition: 1 November 2026 has 25 hours in New York.
  const longDay = dayIn(NY, '2026-11-01T12:00:00Z');
  assert.equal(longDay.civilDate, '2026-11-01');
  assert.equal((longDay.endsAt.getTime() - longDay.startsAt.getTime()) / 3_600_000, 25);

  // An event at 23:30 local on the long day belongs to it, not to the next.
  const schedule = scheduleFor([event({ eventId: 'late', startsAt: at('2026-11-02T03:30:00Z'), endsAt: at('2026-11-02T04:00:00Z') })], longDay);
  assert.deepEqual(schedule.timed.map((e) => e.eventId), ['late']);

  // Spring forward: 8 March 2026 has 23 hours.
  const shortDay = dayIn(NY, '2026-03-08T18:00:00Z');
  assert.equal((shortDay.endsAt.getTime() - shortDay.startsAt.getTime()) / 3_600_000, 23);
});

test('the same instant is a different day in a different zone', () => {
  const instant = '2026-09-18T02:00:00Z'; // 22:00 on the 17th in New York; 11:00 on the 18th in Tokyo
  assert.equal(dayIn(NY, instant).civilDate, '2026-09-17');
  assert.equal(dayIn('Asia/Tokyo', instant).civilDate, '2026-09-18');
});

test('an unreadable calendar is never an empty one', () => {
  const now = at('2026-09-18T12:00:00Z');
  const base = { configured: true, capability: 'CONNECTED' as const, lastSyncCompletedAt: now, lastRunOutcome: 'SUCCEEDED' as const };

  assert.equal(calendarFreshness(base, now), 'CURRENT');
  assert.equal(calendarFreshness({ ...base, lastSyncCompletedAt: new Date(now.getTime() - CALENDAR_STALE_AFTER_MS - 1) }, now), 'STALE');
  assert.equal(calendarFreshness({ ...base, lastSyncCompletedAt: null, lastRunOutcome: null }, now), 'NEVER_SYNCED');
  assert.equal(calendarFreshness({ ...base, lastRunOutcome: 'FAILED' }, now), 'SYNC_FAILED');
  assert.equal(calendarFreshness({ ...base, capability: 'EXPIRED' }, now), 'AUTHORIZATION_EXPIRED');
  assert.equal(calendarFreshness({ ...base, capability: 'INSUFFICIENT_SCOPE' }, now), 'CAPABILITY_NOT_GRANTED');
  assert.equal(calendarFreshness({ ...base, capability: 'NOT_CONNECTED' }, now), 'NOT_CONNECTED');
  assert.equal(calendarFreshness({ ...base, configured: false }, now), 'NOT_CONFIGURED');

  // Only two states may render an empty day as "nothing scheduled".
  assert.deepEqual([...FRESHNESS_ADMITS_EMPTY], ['CURRENT', 'STALE']);
  for (const unknown of ['NEVER_SYNCED', 'SYNC_FAILED', 'NOT_CONNECTED', 'CAPABILITY_NOT_GRANTED', 'AUTHORIZATION_EXPIRED', 'NOT_CONFIGURED'] as const) {
    assert.equal(FRESHNESS_ADMITS_EMPTY.includes(unknown), false, unknown);
  }
});

test('a page render is not a reason to call Google', () => {
  const now = at('2026-09-18T12:00:00Z');
  const justRead = new Date(now.getTime() - 60_000);
  const old = new Date(now.getTime() - CALENDAR_REFRESH_AFTER_MS - 1);

  assert.equal(shouldRefreshOnVisit('CURRENT', justRead, now), false, 'a minute-old read is current enough');
  assert.equal(shouldRefreshOnVisit('CURRENT', old, now), true);
  assert.equal(shouldRefreshOnVisit('NEVER_SYNCED', null, now), true, 'the first visit earns one read');
  assert.equal(shouldRefreshOnVisit('STALE', old, now), true);
  assert.equal(shouldRefreshOnVisit('SYNC_FAILED', old, now), true, 'a failure may be transient; a bounded retry is fair');

  // Nothing to refresh with: never spend a call.
  for (const state of ['NOT_CONNECTED', 'NOT_CONFIGURED', 'CAPABILITY_NOT_GRANTED', 'AUTHORIZATION_EXPIRED'] as const) {
    assert.equal(shouldRefreshOnVisit(state, null, now), false, state);
  }
});
