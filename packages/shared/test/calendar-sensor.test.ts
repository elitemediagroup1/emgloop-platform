// The calendar sensor contract: the vocabularies, and the two mappings that stop each caller
// inventing its own words for the same failure.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  CALENDAR_EVENT_KINDS,
  CALENDAR_EVENT_STATUSES,
  CALENDAR_READ_FAILURES,
  CALENDAR_RESPONSES,
  CALENDAR_TIME_BLOCKING,
  WORK_SYNC_FAILURE_CLASSES,
  calendarFailureForConnectionState,
  workSyncFailureForCalendarFailure,
} from '../src/index';

test('the vocabularies are closed, and say only what a calendar API states', () => {
  assert.deepEqual([...CALENDAR_EVENT_STATUSES], ['CONFIRMED', 'TENTATIVE', 'CANCELLED']);
  assert.deepEqual([...CALENDAR_TIME_BLOCKING], ['BLOCKING', 'FREE']);
  assert.deepEqual([...CALENDAR_RESPONSES], ['ACCEPTED', 'DECLINED', 'TENTATIVE', 'NEEDS_ACTION']);
  // A kind Loop has not met is OTHER -- never quietly DEFAULT.
  assert.equal(CALENDAR_EVENT_KINDS.includes('OTHER'), true);
  assert.equal(CALENDAR_EVENT_KINDS.includes('OUT_OF_OFFICE'), true, 'an absence is not a meeting');
});

test('an unreadable calendar is never an empty one: every failure has its own word', () => {
  for (const required of ['NOT_CONNECTED', 'CAPABILITY_NOT_GRANTED', 'AUTHORIZATION_EXPIRED', 'AUTH', 'FORBIDDEN', 'RATE_LIMITED', 'CURSOR_EXPIRED', 'NETWORK', 'TIMEOUT', 'MALFORMED', 'UNAVAILABLE']) {
    assert.equal(CALENDAR_READ_FAILURES.includes(required as never), true, required);
  }
  for (const absent of ['EMPTY', 'NO_EVENTS', 'NOTHING_SCHEDULED', 'OK']) {
    assert.equal((CALENDAR_READ_FAILURES as readonly string[]).includes(absent), false, absent);
  }
});

test('the three failures an adapter cannot observe come from the connection, in one place', () => {
  assert.equal(calendarFailureForConnectionState('NOT_CONNECTED'), 'NOT_CONNECTED');
  assert.equal(calendarFailureForConnectionState('NOT_CONFIGURED'), 'NOT_CONNECTED');
  assert.equal(calendarFailureForConnectionState('NOT_PERMITTED'), 'NOT_CONNECTED');
  assert.equal(calendarFailureForConnectionState('INSUFFICIENT_SCOPE'), 'CAPABILITY_NOT_GRANTED', 'Calendar was not among the capabilities granted');
  assert.equal(calendarFailureForConnectionState('EXPIRED'), 'AUTHORIZATION_EXPIRED', 'the person must reconnect');
  assert.equal(calendarFailureForConnectionState('UNAVAILABLE'), 'UNAVAILABLE');
});

test('a read failure records a sync failure class the DL-1 schema already knows', () => {
  const mapped = CALENDAR_READ_FAILURES.map((f) => workSyncFailureForCalendarFailure(f));
  for (const value of mapped) {
    assert.equal(WORK_SYNC_FAILURE_CLASSES.includes(value), true, value);
  }
  // Authorization problems of every kind are one operational fact: the pass could not authenticate.
  assert.equal(workSyncFailureForCalendarFailure('NOT_CONNECTED'), 'AUTH');
  assert.equal(workSyncFailureForCalendarFailure('CAPABILITY_NOT_GRANTED'), 'AUTH');
  assert.equal(workSyncFailureForCalendarFailure('AUTHORIZATION_EXPIRED'), 'AUTH');
  assert.equal(workSyncFailureForCalendarFailure('FORBIDDEN'), 'AUTH');
  // And the ones a runner acts on differently keep their own identity.
  assert.equal(workSyncFailureForCalendarFailure('RATE_LIMITED'), 'RATE_LIMITED');
  assert.equal(workSyncFailureForCalendarFailure('CURSOR_EXPIRED'), 'CURSOR_EXPIRED');
  assert.equal(workSyncFailureForCalendarFailure('TIMEOUT'), 'TIMEOUT');
});

test('the contract is provider-neutral and carries no Google field names', () => {
  const source = readFileSync(join(__dirname, '..', 'src', 'calendar-sensor.ts'), 'utf8');
  const code = source.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const google of ['dateTime', 'hangoutLink', 'conferenceData', 'attendeesOmitted', 'singleEvents', 'syncToken', 'eventType', 'transparency']) {
    assert.equal(code.includes(google), false, `${google} is Google's word, not Loop's`);
  }
  // `recurringEventId` is the one name kept deliberately: it is what the architecture record
  // (§17.1) and DL-1's `work_events` column already call the series a row belongs to, and a
  // second name for one thing would cost more than the neutrality is worth here.
  assert.equal(code.includes('recurringEventId'), true);
  // And it stores nothing and reaches nowhere.
  for (const forbidden of ['prisma', 'fetch(', 'crypto', 'process.env']) {
    assert.equal(code.includes(forbidden), false, forbidden);
  }
});
