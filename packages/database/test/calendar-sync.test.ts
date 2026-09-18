// Calendar ingestion (DL-3): one employee's calendar into their own work state.
//
// Drives the REAL CalendarSyncService, WorkSourceRepository and WorkGraphRepository against the
// in-memory Prisma double, with Google replaced by a recording sensor double. No network, no
// database, no token.
//
// WHAT THESE PROVE
//   - A sync belongs to exactly one principal: a colleague, an OWNER, an ADMIN and another
//     organization each get their own (empty) calendar and never touch this employee's.
//   - The first pass is a BOUNDED window; later passes are incremental; an expired cursor
//     causes ONE bounded re-baseline and never a crawl.
//   - Replaying a pass changes nothing; an updated event updates in place; a cancelled event is
//     kept as cancelled rather than deleted.
//   - An all-day event keeps dates and never acquires an invented instant; a timed event keeps
//     its instants through DST and across midnight.
//   - The title is persisted; the description, location, attendee addresses and joining link are
//     not, because they never reach this layer at all.
//   - A failed read is never an empty calendar: the class survives onto the run and the cursor,
//     and the stored events are untouched.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { CalendarEventFact, CalendarReadResult } from '@emgloop/shared';

import { makeCognitivePrisma } from './helpers/cognitive-prisma-fake';
import { IamRepository } from '../src/repositories/iam.repository';
import { WorkGraphRepository, WorkSourceRepository, type WorkPrincipal } from '../src/repositories/work-state';
import { CalendarSyncService, eventFactsFor, type CalendarConnectionState, type CalendarSensorPort } from '../src/services/work-state/calendar-sync.service';

const ORG_A = 'org_a';
const ORG_B = 'org_b';
const NOW = new Date('2026-09-17T09:00:00Z');
const hash = (v: string) => createHash('sha256').update(v).digest('hex');

const WORK_DELEGATES = ['workSourceCursor', 'workSyncRun', 'workCorrespondent', 'workThread', 'workMessage', 'workEvent', 'workDocument', 'workItem', 'workItemObservation', 'workBrief', 'workFeedback', 'employeeWorkPreferences', 'workRetentionOverride'];

function fact(over: Partial<CalendarEventFact> = {}): CalendarEventFact {
  return {
    provider: 'GOOGLE',
    eventId: 'evt-1',
    recurringEventId: null,
    isRecurringInstance: false,
    originalStartsAt: null,
    status: 'CONFIRMED',
    kind: 'DEFAULT',
    blocking: 'BLOCKING',
    when: { allDay: false, startsAt: new Date('2026-09-17T15:00:00Z'), endsAt: new Date('2026-09-17T15:30:00Z'), startDate: null, endDateExclusive: null, timeZone: null },
    summary: 'Cashion / Trevon',
    organizerHash: hash('matt@emgloop.test'),
    organizerIsSelf: true,
    attendance: { known: true, total: 2, external: 1, resources: 1, selfResponse: 'ACCEPTED' },
    hasConference: true,
    providerUpdatedAt: new Date('2026-09-16T18:04:00Z'),
    observedAt: NOW,
    ...over,
  };
}

const okPage = (events: CalendarEventFact[], over: { syncToken?: string | null; truncated?: boolean; nextPageToken?: string | null } = {}): CalendarReadResult => ({
  ok: true,
  page: {
    events,
    nextPageToken: over.nextPageToken ?? null,
    nextSyncToken: over.syncToken === undefined ? 'sync-1' : over.syncToken,
    truncated: over.truncated ?? false,
    pagesRead: 1,
  },
});

/** A recording sensor: what it was asked, and what it answers. No network anywhere. */
function sensorDouble() {
  const windowCalls: { timeMin: Date; timeMax: Date; accessToken: string; internalDomains: readonly string[] }[] = [];
  const changeCalls: { syncToken: string; accessToken: string }[] = [];
  let windowAnswer: CalendarReadResult = okPage([]);
  let changesAnswer: CalendarReadResult = okPage([]);
  const port: CalendarSensorPort = {
    readWindow: async (request) => {
      windowCalls.push({ timeMin: request.timeMin, timeMax: request.timeMax, accessToken: request.accessToken, internalDomains: request.internalDomains });
      return windowAnswer;
    },
    readChanges: async (request) => {
      changeCalls.push({ syncToken: request.syncToken, accessToken: request.accessToken });
      return changesAnswer;
    },
  };
  return {
    port,
    windowCalls,
    changeCalls,
    onWindow(answer: CalendarReadResult) {
      windowAnswer = answer;
    },
    onChanges(answer: CalendarReadResult) {
      changesAnswer = answer;
    },
  };
}

function world(options: { connection?: CalendarConnectionState | 'OK' } = {}) {
  const fake: any = makeCognitivePrisma({ also: ['organization', 'invitation', 'organizationMembership', ...WORK_DELEGATES] });
  const prisma = fake as PrismaClient;
  const sensor = sensorDouble();
  const tokenRequests: WorkPrincipal[] = [];
  let connectionState: CalendarConnectionState | 'OK' = options.connection ?? 'OK';
  // A movable clock, so successive runs are ordered rather than sharing one instant. It only
  // moves when a test says so, which keeps the window assertions exact.
  let clock = NOW;
  const service = new CalendarSyncService({
    sources: new WorkSourceRepository(prisma),
    graph: new WorkGraphRepository(prisma),
    sensor: sensor.port,
    now: () => clock,
    access: {
      accessToken: async (principal) => {
        tokenRequests.push(principal);
        return connectionState === 'OK' ? { ok: true, accessToken: `token-for-${principal.userId}` } : { ok: false, state: connectionState };
      },
      identity: async () => ({ selfAddress: 'matt@emgloop.test', internalDomains: ['emgloop.test'] }),
    },
  });
  return {
    fake,
    prisma,
    sensor,
    service,
    tokenRequests,
    iam: new IamRepository(prisma),
    sources: new WorkSourceRepository(prisma),
    graph: new WorkGraphRepository(prisma),
    connection(state: CalendarConnectionState | 'OK') {
      connectionState = state;
    },
    advance(ms: number) {
      clock = new Date(clock.getTime() + ms);
    },
  };
}
type World = ReturnType<typeof world>;

let people = 0;
async function person(w: World, organizationId: string, systemRole = 'EMPLOYEE'): Promise<WorkPrincipal> {
  people += 1;
  const user = await w.iam.createUser({ organizationId, email: `cal${people}@loop.test`, name: `Cal ${people}`, systemRole });
  await w.iam.activateUser(organizationId, user.id);
  return { organizationId, userId: user.id };
}

const events = (w: World, principal: WorkPrincipal) =>
  w.fake.workEvent.__rows.filter((r: any) => r.organizationId === principal.organizationId && r.userId === principal.userId);

// --- Isolation -----------------------------------------------------------------------------------

test('a sync belongs to one principal: nobody else can start it, and nobody else sees the rows', async () => {
  const w = world();
  const alice = await person(w, ORG_A);
  const bob = await person(w, ORG_A);
  const owner = await person(w, ORG_A, 'OWNER');
  const admin = await person(w, ORG_A, 'ADMIN');
  const elsewhere = await person(w, ORG_B, 'OWNER');

  w.sensor.onWindow(okPage([fact()]));
  const result = await w.service.syncCalendar(alice);
  assert.equal(result.outcome, 'SUCCEEDED');
  assert.equal(events(w, alice).length, 1);

  // The token was requested for Alice, and for nobody else.
  assert.deepEqual(w.tokenRequests, [alice]);

  // Everybody else syncing gets THEIR OWN calendar (empty here) and cannot reach hers.
  w.sensor.onWindow(okPage([]));
  for (const [label, principal] of [['a colleague', bob], ['OWNER', owner], ['ADMIN', admin], ['another organization', elsewhere]] as const) {
    const theirs = await w.service.syncCalendar(principal);
    assert.equal(theirs.written, 0, label);
    assert.deepEqual(events(w, principal), [], label);
    assert.deepEqual(await w.graph.events(principal, { from: new Date('2026-01-01'), to: new Date('2027-01-01') }), [], label);
  }
  // And Alice's row is still hers, untouched.
  assert.equal(events(w, alice).length, 1);
  assert.equal(events(w, alice)[0]!.summary, 'Cashion / Trevon');

  // Every token request named the principal that asked -- never a substituted one.
  assert.deepEqual(w.tokenRequests, [alice, bob, owner, admin, elsewhere]);
});

// --- The first pass, and the passes after it --------------------------------------------------------

test('the first pass is a bounded window; the next is incremental from the stored cursor', async () => {
  const w = world();
  const alice = await person(w, ORG_A);

  w.sensor.onWindow(okPage([fact()], { syncToken: 'sync-1' }));
  const first = await w.service.syncCalendar(alice);
  assert.equal(first.mode, 'WINDOW');
  assert.equal(first.cursorAdvanced, true);
  assert.equal(w.sensor.windowCalls.length, 1);

  // A week behind and a month ahead: explicit, deterministic, and the same every time.
  const asked = w.sensor.windowCalls[0]!;
  assert.equal(asked.timeMin.toISOString(), '2026-09-10T09:00:00.000Z');
  assert.equal(asked.timeMax.toISOString(), '2026-10-17T09:00:00.000Z');
  assert.equal(asked.accessToken, `token-for-${alice.userId}`);
  assert.deepEqual([...asked.internalDomains], ['emgloop.test']);

  const cursor = await w.sources.cursor(alice, 'CALENDAR');
  assert.equal(cursor?.cursor, 'sync-1');
  assert.equal(cursor?.cursorKind, 'CALENDAR_SYNC_TOKEN');
  assert.equal(cursor?.lastFailureClass, null);

  // The second pass asks for CHANGES, not the window again.
  w.sensor.onChanges(okPage([], { syncToken: 'sync-2' }));
  const second = await w.service.syncCalendar(alice);
  assert.equal(second.mode, 'INCREMENTAL');
  assert.equal(w.sensor.windowCalls.length, 1, 'the window is not re-read');
  assert.deepEqual(w.sensor.changeCalls.map((c) => c.syncToken), ['sync-1']);
  assert.equal((await w.sources.cursor(alice, 'CALENDAR'))?.cursor, 'sync-2');
});

test('an expired cursor causes one bounded re-baseline, never a crawl', async () => {
  const w = world();
  const alice = await person(w, ORG_A);
  w.sensor.onWindow(okPage([fact()], { syncToken: 'sync-1' }));
  await w.service.syncCalendar(alice);

  // Google forgot the token.
  w.sensor.onChanges({ ok: false, failure: 'CURSOR_EXPIRED' });
  w.sensor.onWindow(okPage([fact({ eventId: 'evt-2' })], { syncToken: 'sync-fresh' }));
  const rebaselined = await w.service.syncCalendar(alice);

  assert.equal(rebaselined.mode, 'REBASELINE');
  assert.equal(rebaselined.outcome, 'SUCCEEDED');
  assert.equal(w.sensor.windowCalls.length, 2, 'exactly one more window read');
  // The SAME bounded window as the first pass: a re-baseline cannot widen into a history crawl.
  assert.deepEqual(w.sensor.windowCalls[1]!.timeMin, w.sensor.windowCalls[0]!.timeMin);
  assert.deepEqual(w.sensor.windowCalls[1]!.timeMax, w.sensor.windowCalls[0]!.timeMax);
  assert.equal((await w.sources.cursor(alice, 'CALENDAR'))?.cursor, 'sync-fresh');
  assert.equal(events(w, alice).length, 2, 'the earlier event is still there');
});

test('a truncated read stores what it read, keeps the old cursor, and says it was truncated', async () => {
  const w = world();
  const alice = await person(w, ORG_A);
  w.sensor.onWindow(okPage([fact()], { truncated: true, nextPageToken: 'more', syncToken: null }));

  const result = await w.service.syncCalendar(alice);
  assert.equal(result.outcome, 'TRUNCATED');
  assert.equal(result.written, 1, 'what was read is kept');
  assert.equal(result.cursorAdvanced, false, 'a partial read produces no cursor to trust');
  assert.equal((await w.sources.cursor(alice, 'CALENDAR'))?.cursor, null);

  const runs = await w.sources.recentRuns(alice);
  assert.equal(runs[0]!.outcome, 'TRUNCATED');
  assert.equal(runs[0]!.failureClass, null, 'truncation is not a failure');
});

// --- Idempotency and change ---------------------------------------------------------------------------

test('replaying a pass changes nothing; an update updates in place; a cancellation is kept', async () => {
  const w = world();
  const alice = await person(w, ORG_A);

  w.sensor.onWindow(okPage([fact()], { syncToken: 'sync-1' }));
  await w.service.syncCalendar(alice);
  w.sensor.onChanges(okPage([fact()], { syncToken: 'sync-1' }));
  await w.service.syncCalendar(alice);
  assert.equal(events(w, alice).length, 1, 'the same observation is the same row');

  // The meeting moves half an hour and gains a person.
  w.sensor.onChanges(
    okPage([fact({ when: { allDay: false, startsAt: new Date('2026-09-17T15:30:00Z'), endsAt: new Date('2026-09-17T16:00:00Z'), startDate: null, endDateExclusive: null, timeZone: null }, attendance: { known: true, total: 3, external: 2, resources: 0, selfResponse: 'ACCEPTED' } })], { syncToken: 'sync-2' }),
  );
  await w.service.syncCalendar(alice);
  const updated = events(w, alice);
  assert.equal(updated.length, 1, 'still one row');
  assert.equal(updated[0]!.startsAt.toISOString(), '2026-09-17T15:30:00.000Z');
  assert.equal(updated[0]!.attendeeCount, 3);
  assert.equal(updated[0]!.externalAttendeeCount, 2);

  // It is called off. The row stays, and says so: deleting it would make the history ambiguous.
  w.sensor.onChanges(okPage([fact({ status: 'CANCELLED' })], { syncToken: 'sync-3' }));
  await w.service.syncCalendar(alice);
  const cancelled = events(w, alice);
  assert.equal(cancelled.length, 1);
  assert.equal(cancelled[0]!.status, 'CANCELLED');
});

test('a recurring instance is its own row, keeps its series, and survives being moved', async () => {
  const w = world();
  const alice = await person(w, ORG_A);
  const instance = (id: string, startsAt: string, originalStartsAt: string) =>
    fact({
      eventId: id,
      recurringEventId: 'series',
      isRecurringInstance: true,
      originalStartsAt: new Date(originalStartsAt),
      when: { allDay: false, startsAt: new Date(startsAt), endsAt: new Date(startsAt), startDate: null, endDateExclusive: null, timeZone: null },
    });

  w.sensor.onWindow(
    okPage([instance('series_20260917T133000Z', '2026-09-17T13:30:00Z', '2026-09-17T13:30:00Z'), instance('series_20260924T133000Z', '2026-09-24T13:30:00Z', '2026-09-24T13:30:00Z')], { syncToken: 's1' }),
  );
  await w.service.syncCalendar(alice);
  const stored = events(w, alice);
  assert.equal(stored.length, 2, 'two instances, two rows -- the identity is the instance, not the series');
  assert.deepEqual([...new Set(stored.map((r: any) => r.recurringEventId))], ['series']);

  // One instance moves: same id, new time, no duplicate.
  w.sensor.onChanges(okPage([instance('series_20260924T133000Z', '2026-09-24T15:00:00Z', '2026-09-24T13:30:00Z')], { syncToken: 's2' }));
  await w.service.syncCalendar(alice);
  const moved = events(w, alice).find((r: any) => r.eventId === 'series_20260924T133000Z');
  assert.equal(events(w, alice).length, 2);
  assert.equal(moved.startsAt.toISOString(), '2026-09-24T15:00:00.000Z');
  assert.equal(moved.originalStartsAt.toISOString(), '2026-09-24T13:30:00.000Z', 'where the series said it would be');
});

// --- Timing -------------------------------------------------------------------------------------------

test('an all-day event is stored as dates and never acquires an invented instant', async () => {
  const w = world();
  const alice = await person(w, ORG_A);
  w.sensor.onWindow(
    okPage([fact({ eventId: 'all-day', summary: 'Conference', when: { allDay: true, startsAt: null, endsAt: null, startDate: '2026-09-18', endDateExclusive: '2026-09-19', timeZone: 'Europe/Zurich' } })], { syncToken: 's' }),
  );
  await w.service.syncCalendar(alice);

  const row = events(w, alice)[0]!;
  assert.equal(row.allDay, true);
  assert.equal(row.startsAt, null, 'no UTC midnight is invented for somebody else’s day');
  assert.equal(row.endsAt, null);
  assert.equal(row.startDate.toISOString().slice(0, 10), '2026-09-18');
  assert.equal(row.endDateExclusive.toISOString().slice(0, 10), '2026-09-19', "Google's exclusive end stays exclusive");
  assert.equal(row.eventTimeZone, 'Europe/Zurich');
});

test('timed events keep their instants across midnight and across a DST transition', async () => {
  const w = world();
  const alice = await person(w, ORG_A);
  w.sensor.onWindow(
    okPage(
      [
        fact({ eventId: 'midnight', when: { allDay: false, startsAt: new Date('2026-09-18T03:30:00Z'), endsAt: new Date('2026-09-18T04:30:00Z'), startDate: null, endDateExclusive: null, timeZone: 'America/New_York' } }),
        fact({ eventId: 'dst', when: { allDay: false, startsAt: new Date('2026-11-01T05:30:00Z'), endsAt: new Date('2026-11-01T06:30:00Z'), startDate: null, endDateExclusive: null, timeZone: 'America/New_York' } }),
      ],
      { syncToken: 's' },
    ),
  );
  await w.service.syncCalendar(alice);

  const byId = Object.fromEntries(events(w, alice).map((r: any) => [r.eventId, r]));
  assert.equal(byId.midnight.startsAt.toISOString(), '2026-09-18T03:30:00.000Z');
  assert.equal(byId.midnight.startDate, null, 'a timed event carries no dates');
  // 01:30 EDT to 01:30 EST is one hour of real time, and the stored instants say so.
  assert.equal((byId.dst.endsAt.getTime() - byId.dst.startsAt.getTime()) / 60000, 60);
  assert.equal(byId.dst.eventTimeZone, 'America/New_York');
});

// --- What is persisted, and what never arrives -----------------------------------------------------------

test('the title is persisted; description, location, addresses and joining links are not', async () => {
  const w = world();
  const alice = await person(w, ORG_A);
  w.sensor.onWindow(okPage([fact()], { syncToken: 's' }));
  await w.service.syncCalendar(alice);

  const row = events(w, alice)[0]!;
  assert.equal(row.summary, 'Cashion / Trevon', 'a day of times with no names is not a day view');
  assert.equal(row.kind, 'DEFAULT');
  assert.equal(row.blocking, 'BLOCKING');
  assert.equal(row.status, 'CONFIRMED');
  assert.equal(row.hasConference, true, 'that a conference exists');
  assert.equal(row.organizerIsSelf, true);
  assert.equal(row.organizerHash, hash('matt@emgloop.test'));
  assert.equal(row.attendanceKnown, true);
  assert.equal(row.attendeeCount, 2);
  assert.equal(row.externalAttendeeCount, 1);
  assert.equal(row.selfResponse, 'ACCEPTED');
  assert.equal(row.providerUpdatedAt.toISOString(), '2026-09-16T18:04:00.000Z');
  assert.equal(row.observedAt.toISOString(), NOW.toISOString());

  // The columns that would hold content do not exist, so the row cannot carry it.
  const text = JSON.stringify(row);
  for (const absent of ['description', 'location', 'matt@emgloop.test', 'ben@cashionrods.com', 'hangoutLink', 'meet.google', 'attachment']) {
    assert.equal(text.includes(absent), false, absent);
  }
  for (const column of ['description', 'location', 'attendees', 'conferenceUrl', 'hangoutLink']) {
    assert.equal(column in row, false, column);
  }

  // Unknown attendance stays unknown rather than becoming zero.
  w.sensor.onChanges(okPage([fact({ attendance: { known: false, total: null, external: null, resources: null, selfResponse: null } })], { syncToken: 's2' }));
  await w.service.syncCalendar(alice);
  const unknown = events(w, alice)[0]!;
  assert.equal(unknown.attendanceKnown, false);
  assert.equal(unknown.attendeeCount, null, '"I could not count" is not "nobody is invited"');
});

// --- Failure ---------------------------------------------------------------------------------------------

test('a failed read is never an empty calendar, and never disturbs what was stored', async () => {
  const w = world();
  const alice = await person(w, ORG_A);
  w.sensor.onWindow(okPage([fact()], { syncToken: 'sync-1' }));
  await w.service.syncCalendar(alice);
  assert.equal(events(w, alice).length, 1);

  for (const [failure, expectedClass] of [
    ['AUTH', 'AUTH'],
    ['FORBIDDEN', 'AUTH'],
    ['RATE_LIMITED', 'RATE_LIMITED'],
    ['NETWORK', 'NETWORK'],
    ['TIMEOUT', 'TIMEOUT'],
    ['MALFORMED', 'MALFORMED'],
    ['UNAVAILABLE', 'UNAVAILABLE'],
  ] as const) {
    w.advance(60_000);
    w.sensor.onChanges({ ok: false, failure });
    const result = await w.service.syncCalendar(alice);
    assert.equal(result.outcome, 'FAILED', failure);
    assert.equal(result.failure, failure, failure);
    assert.equal(result.written, 0, failure);
    // The stored calendar is exactly as it was: a failure erases nothing.
    assert.equal(events(w, alice).length, 1, failure);
    // And the run and the cursor both remember why.
    const runs = await w.sources.recentRuns(alice);
    assert.equal(runs[0]!.outcome, 'FAILED', failure);
    assert.equal(runs[0]!.failureClass, expectedClass, failure);
    assert.equal((await w.sources.cursor(alice, 'CALENDAR'))?.lastFailureClass, expectedClass, failure);
    // The cursor itself is never thrown away by a failure.
    assert.equal((await w.sources.cursor(alice, 'CALENDAR'))?.cursor, 'sync-1', failure);
  }
});

test('a connection that cannot be used says which way, and reads nothing', async () => {
  const w = world();
  const alice = await person(w, ORG_A);

  // The state a connection reports, the failure a caller sees, and the class the run records.
  // An authorization problem of any kind is one operational fact; a provider outage is not.
  for (const [state, expected, recorded] of [
    ['NOT_CONNECTED', 'NOT_CONNECTED', 'AUTH'],
    ['NOT_CONFIGURED', 'NOT_CONNECTED', 'AUTH'],
    ['NOT_PERMITTED', 'NOT_CONNECTED', 'AUTH'],
    ['INSUFFICIENT_SCOPE', 'CAPABILITY_NOT_GRANTED', 'AUTH'],
    ['EXPIRED', 'AUTHORIZATION_EXPIRED', 'AUTH'],
    ['UNAVAILABLE', 'UNAVAILABLE', 'UNAVAILABLE'],
  ] as const) {
    w.advance(60_000);
    w.connection(state);
    const result = await w.service.syncCalendar(alice);
    assert.equal(result.outcome, 'FAILED', state);
    assert.equal(result.failure, expected, state);
    assert.equal(w.sensor.windowCalls.length, 0, 'no calendar is read without a usable connection');
    const runs = await w.sources.recentRuns(alice);
    assert.equal(runs[0]!.failureClass, recorded, state);
  }
  assert.deepEqual(events(w, alice), []);
});

test('the service reaches no network, no model and no other employee', () => {
  const source = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'services', 'work-state', 'calendar-sync.service.ts'), 'utf8');
  for (const forbidden of ['fetch(', 'googleapis.com', 'anthropic', 'openai', 'AiRuntimeGateway', 'console.', 'process.env', 'findMany({ where: { organizationId }']) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
  // Every seam is injected, and the principal is the only scope it knows. The options a caller
  // may pass say HOW to read, never WHOSE calendar: there is exactly one, and it is a boolean.
  assert.equal(source.includes('WorkPrincipal'), true);
  assert.equal(/syncCalendar\(principal: WorkPrincipal, options: CalendarSyncOptions = \{\}\)/.test(source), true);
  const options = source.slice(source.indexOf('export interface CalendarSyncOptions'));
  assert.match(options.slice(0, options.indexOf('}')), /^[^}]*readonly baseline\?: boolean;[^}]*$/);
  for (const forbidden of ['userId?', 'organizationId?', 'principal?']) {
    assert.equal(options.slice(0, options.indexOf('}')).includes(forbidden), false, forbidden);
  }
});

test('the fact-to-row mapping carries every approved field and invents none', () => {
  const row = eventFactsFor(fact({ when: { allDay: true, startsAt: null, endsAt: null, startDate: '2026-09-18', endDateExclusive: '2026-09-19', timeZone: 'UTC' } }));
  assert.equal(row.allDay, true);
  assert.equal(row.startsAt, null);
  assert.equal(row.startDate?.toISOString(), '2026-09-18T00:00:00.000Z', 'a DATE column, not a moment in somebody’s zone');
  assert.equal(row.summary, 'Cashion / Trevon');
  assert.equal(row.attendanceKnown, true);
  assert.equal(row.observedAt, NOW);
  // Nothing the sensor refused to expose appears in the row at all.
  for (const key of Object.keys(row)) {
    assert.equal(['description', 'location', 'attendees', 'conferenceUrl', 'organizerEmail'].includes(key), false, key);
  }
});

// --- The periodic re-baseline (DL-5) ---------------------------------------------------------
//
// A Google sync token inherits the window that minted it. A cursor kept alive for months keeps
// reporting against a horizon months in the past, so a meeting booked beyond it never arrives --
// the follow-up #292 recorded and assigned here. These prove the correction, and prove that it
// cannot cost an employee the cursor they already had.

const DAY = 86_400_000;

test('a requested baseline re-reads the ROLLING window although a live cursor exists', async () => {
  const w = world();
  const alice = await person(w, ORG_A);

  w.sensor.onWindow(okPage([fact()], { syncToken: 'sync-first' }));
  const first = await w.service.syncCalendar(alice);
  assert.equal(first.mode, 'WINDOW');
  const firstWindow = w.sensor.windowCalls[0]!;

  // Six weeks later, the stored token's horizon is six weeks in the past.
  w.advance(42 * DAY);
  w.sensor.onWindow(okPage([fact({ eventId: 'far-future' })], { syncToken: 'sync-second' }));
  const baseline = await w.service.syncCalendar(alice, { baseline: true });

  assert.equal(baseline.mode, 'REBASELINE', 'a window read with a cursor in hand is a re-baseline');
  assert.equal(w.sensor.changeCalls.length, 0, 'the stored token was not used for this pass');
  const secondWindow = w.sensor.windowCalls[1]!;
  assert.equal(secondWindow.timeMax.getTime() - firstWindow.timeMax.getTime(), 42 * DAY, 'the horizon moved with the clock');
  assert.ok(secondWindow.timeMin > firstWindow.timeMin);

  // The cursor is replaced, so the next ordinary pass is incremental against the NEW token.
  const cursor = await w.sources.cursor(alice, 'CALENDAR');
  assert.equal(cursor?.cursor, 'sync-second');
  w.sensor.onChanges(okPage([], { syncToken: 'sync-third' }));
  const after = await w.service.syncCalendar(alice);
  assert.equal(after.mode, 'INCREMENTAL');
  assert.deepEqual(w.sensor.changeCalls.map((c) => c.syncToken), ['sync-second']);
});

test('a failed baseline leaves the employee exactly where they were', async () => {
  const w = world();
  const alice = await person(w, ORG_A);
  w.sensor.onWindow(okPage([fact()], { syncToken: 'sync-first' }));
  await w.service.syncCalendar(alice);
  const before = events(w, alice).length;

  w.advance(7 * DAY);
  w.sensor.onWindow({ ok: false, failure: 'UNAVAILABLE' });
  const failed = await w.service.syncCalendar(alice, { baseline: true });

  assert.equal(failed.outcome, 'FAILED');
  assert.equal(failed.mode, 'REBASELINE');
  assert.equal(failed.cursorAdvanced, false);
  const cursor = await w.sources.cursor(alice, 'CALENDAR');
  assert.equal(cursor?.cursor, 'sync-first', 'the cursor a failure found is the cursor it leaves');
  assert.equal(cursor?.lastFailureClass, 'UNAVAILABLE');
  assert.equal(events(w, alice).length, before, 'and nothing stored was touched');

  // The next ordinary pass carries on incrementally, so a failed correction costs nothing.
  w.sensor.onChanges(okPage([]));
  assert.equal((await w.service.syncCalendar(alice)).mode, 'INCREMENTAL');
});

test('a truncated baseline keeps the old cursor rather than storing half a picture', async () => {
  const w = world();
  const alice = await person(w, ORG_A);
  w.sensor.onWindow(okPage([fact()], { syncToken: 'sync-first' }));
  await w.service.syncCalendar(alice);

  w.advance(7 * DAY);
  w.sensor.onWindow(okPage([fact({ eventId: 'partial' })], { syncToken: null, truncated: true }));
  const truncated = await w.service.syncCalendar(alice, { baseline: true });

  assert.equal(truncated.outcome, 'TRUNCATED');
  assert.equal(truncated.cursorAdvanced, false);
  assert.equal((await w.sources.cursor(alice, 'CALENDAR'))?.cursor, 'sync-first');
  // What it did read is still stored: an upsert on the provider key is safe to repeat.
  assert.ok(events(w, alice).some((r: any) => r.eventId === 'partial'));
});

test('a baseline asked for before there is any cursor is simply the first window', async () => {
  const w = world();
  const alice = await person(w, ORG_A);
  w.sensor.onWindow(okPage([fact()], { syncToken: 'sync-first' }));
  const result = await w.service.syncCalendar(alice, { baseline: true });
  assert.equal(result.mode, 'WINDOW');
  assert.equal(result.cursorAdvanced, true);
});

test('a baseline is still one employee, and still bounded', async () => {
  const w = world();
  const alice = await person(w, ORG_A);
  const bob = await person(w, ORG_A);
  w.sensor.onWindow(okPage([fact()], { syncToken: 'sync-first' }));
  await w.service.syncCalendar(alice, { baseline: true });
  await w.service.syncCalendar(bob, { baseline: true });

  assert.deepEqual(w.tokenRequests, [alice, bob], 'each pass asked for its own principal’s token');
  for (const call of w.sensor.windowCalls) {
    const span = call.timeMax.getTime() - call.timeMin.getTime();
    assert.equal(span, 37 * DAY, 'the same bounded window as the first pass -- never a crawl');
  }
});
