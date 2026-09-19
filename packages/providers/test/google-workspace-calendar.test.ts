// The Google Calendar sensor: request shapes, normalization, bounds and failure classes,
// against a recording network double. No live call is made, and no token is ever real.
//
// WHAT THESE PROVE
//   - Reads are bounded and correctly parameterised: the primary calendar, expanded instances,
//     an explicit window, Google's page size, and a cursor read that carries no time window
//     because Google forbids one.
//   - Pagination is followed to the end, and a read that stops at the limit says so and hands
//     back the token rather than pretending to be complete.
//   - Every timing shape survives: timed, all-day, cross-midnight, DST, a calendar in another
//     zone, a recurring instance, a moved instance, a cancellation.
//   - Attendance is COUNTED and the organizer and other invitees HASHED (D2); an omitted
//     attendee list is unknown rather than zero and yields no keys, and external attendance is
//     null when nothing said what internal means.
//   - Every failure is its own class, and none of them is an empty calendar.
//   - No token, address, description or provider text reaches a result or a log.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  GOOGLE_CALENDAR_EVENTS_ENDPOINT,
  GOOGLE_CALENDAR_MAX_PAGES,
  GOOGLE_CALENDAR_PAGE_SIZE,
  googleAddressHash,
  googleCalendarAddressHash,
  normalizeGoogleCalendarEvent,
  readGoogleCalendarChanges,
  readGoogleCalendarWindow,
} from '../src/google-workspace/calendar';

const TOKEN = 'ya29.super-secret-access-token';
const OBSERVED = new Date('2026-09-17T09:00:00Z');
const SELF = 'matt@emgloop.test';
const INTERNAL = ['emgloop.test'];
const hash = (v: string) => createHash('sha256').update(v).digest('hex');

type Answer = { status: number; body?: unknown } | 'throw' | 'hang';

function calendar(answers: Answer[]) {
  const calls: { url: URL; headers: Record<string, string>; method: string }[] = [];
  const queue = [...answers];
  const fetchImpl = async (input: string, init: { method: 'GET'; headers: Record<string, string>; signal?: AbortSignal }) => {
    calls.push({ url: new URL(input), headers: init.headers, method: init.method });
    const next = queue.length > 1 ? queue.shift()! : queue[0]!;
    if (next === 'throw') throw new Error(`socket hang up carrying ${TOKEN}`);
    if (next === 'hang') return new Promise<never>((_, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
    return {
      status: next.status,
      json: async () => {
        if (next.body === undefined) throw new SyntaxError('not json');
        return next.body;
      },
    };
  };
  return { calls, fetchImpl, params: (i = 0) => Object.fromEntries(calls[i]!.url.searchParams) };
}

const base = { accessToken: TOKEN, observedAt: OBSERVED, selfAddress: SELF, internalDomains: INTERNAL };
const WINDOW = { timeMin: new Date('2026-09-10T00:00:00Z'), timeMax: new Date('2026-10-17T00:00:00Z') };
const page = (items: unknown[], extra: Record<string, unknown> = {}) => ({ status: 200, body: { items, ...extra } });

const timedEvent = (over: Record<string, unknown> = {}) => ({
  id: 'evt-1',
  status: 'confirmed',
  summary: 'Cashion / Trevon',
  start: { dateTime: '2026-09-17T11:00:00-04:00' },
  end: { dateTime: '2026-09-17T11:30:00-04:00' },
  organizer: { email: SELF, self: true },
  attendees: [
    { email: SELF, self: true, responseStatus: 'accepted' },
    { email: 'ben@cashionrods.com', responseStatus: 'tentative' },
    { email: 'room-3@emgloop.test', resource: true },
  ],
  conferenceData: { conferenceId: 'abc-defg-hij' },
  updated: '2026-09-16T18:04:00.000Z',
  ...over,
});

// --- Request shape ---------------------------------------------------------------------------

test('a window read asks the primary calendar for expanded instances inside an explicit window', async () => {
  const g = calendar([page([timedEvent()], { nextSyncToken: 'sync-1' })]);
  const result = await readGoogleCalendarWindow({ ...base, ...WINDOW, fetchImpl: g.fetchImpl });
  assert.equal(result.ok, true);

  const call = g.calls[0]!;
  assert.equal(`${call.url.origin}${call.url.pathname}`, GOOGLE_CALENDAR_EVENTS_ENDPOINT);
  assert.equal(call.method, 'GET');
  assert.deepEqual(g.params(), {
    singleEvents: 'true',
    maxResults: String(GOOGLE_CALENDAR_PAGE_SIZE),
    timeMin: '2026-09-10T00:00:00.000Z',
    timeMax: '2026-10-17T00:00:00.000Z',
    showDeleted: 'true',
  });
  // The credential travels in the header, never in the URL.
  assert.equal(call.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(call.url.toString().includes(TOKEN), false);
  assert.equal(result.ok && result.page.nextSyncToken, 'sync-1');
});

test('the first window read is sync-token compatible, so the cursor it returns can be stored', async () => {
  // THE DEFECT THIS PINS. Google answers a request it cannot replay incrementally WITHOUT a
  // nextSyncToken, and `orderBy` is on its list of parameters that cannot be combined with a
  // sync token. Sending it cost the cursor silently: every pass then re-read the whole window
  // (production, 2026-09-17 -- two identical WINDOW syncs in a row).
  const g = calendar([page([timedEvent()], { nextSyncToken: 'sync-from-window' })]);
  const result = await readGoogleCalendarWindow({ ...base, ...WINDOW, fetchImpl: g.fetchImpl });

  const params = g.params();
  assert.equal('orderBy' in params, false, 'orderBy suppresses the token Google would otherwise issue');
  // Only parameters a later incremental read can live with, plus the window the sync guide's
  // own sample uses on a full sync.
  assert.deepEqual(Object.keys(params).sort(), ['maxResults', 'showDeleted', 'singleEvents', 'timeMax', 'timeMin']);
  for (const incompatible of ['iCalUID', 'privateExtendedProperty', 'q', 'sharedExtendedProperty', 'updatedMin']) {
    assert.equal(incompatible in params, false, incompatible);
  }

  // And the token survives the read, which is what makes the next pass incremental.
  assert.equal(result.ok && result.page.nextSyncToken, 'sync-from-window');
  assert.equal(result.ok && result.page.truncated, false);
});

test('a paginated window read keeps the token from its last page, and only from there', async () => {
  // Google omits nextSyncToken while more results are available, and sends it on the final
  // page -- so a multi-page window must not conclude "no token" from the first page.
  const g = calendar([
    page([timedEvent({ id: 'a' })], { nextPageToken: 'p2', syncToken: null }),
    page([timedEvent({ id: 'b' })], { nextSyncToken: 'sync-last-page' }),
  ]);
  const result = await readGoogleCalendarWindow({ ...base, ...WINDOW, fetchImpl: g.fetchImpl });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.page.nextSyncToken, 'sync-last-page');
  assert.equal(result.page.truncated, false);
  assert.equal(g.params(1).pageToken, 'p2');
  assert.equal('orderBy' in g.params(1), false, 'every page of the window read stays token-compatible');
});

test('a cursor read carries no time window, because Google forbids one with a syncToken', async () => {
  const g = calendar([page([], { nextSyncToken: 'sync-2' })]);
  const result = await readGoogleCalendarChanges({ ...base, syncToken: 'sync-1', fetchImpl: g.fetchImpl });
  assert.equal(result.ok, true);
  const params = g.params();
  assert.equal(params.syncToken, 'sync-1');
  assert.equal(params.singleEvents, 'true');
  assert.equal(params.showDeleted, 'true', 'the parameter set must match the read that produced the token');
  assert.equal('timeMin' in params, false);
  assert.equal('timeMax' in params, false);
  assert.equal('orderBy' in params, false);
  // An empty calendar is a SUCCESSFUL read with no events -- never a failure.
  assert.deepEqual(result.ok && result.page.events, []);
  assert.equal(result.ok && result.page.nextSyncToken, 'sync-2');
});

test('a window that does not close is refused before anything is asked of Google', async () => {
  const g = calendar([page([])]);
  const result = await readGoogleCalendarWindow({ ...base, timeMin: WINDOW.timeMax, timeMax: WINDOW.timeMin, fetchImpl: g.fetchImpl });
  assert.deepEqual(result, { ok: false, failure: 'MALFORMED' });
  assert.equal(g.calls.length, 0);
});

// --- Pagination -------------------------------------------------------------------------------

test('pages are followed to the end, and the sync token comes from the last one', async () => {
  const g = calendar([
    page([timedEvent({ id: 'a' })], { nextPageToken: 'p2' }),
    page([timedEvent({ id: 'b' })], { nextPageToken: 'p3' }),
    page([timedEvent({ id: 'c' })], { nextSyncToken: 'sync-final' }),
  ]);
  const result = await readGoogleCalendarWindow({ ...base, ...WINDOW, fetchImpl: g.fetchImpl });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.page.events.map((e) => e.eventId), ['a', 'b', 'c']);
  assert.equal(result.page.pagesRead, 3);
  assert.equal(result.page.truncated, false);
  assert.equal(result.page.nextPageToken, null);
  assert.equal(result.page.nextSyncToken, 'sync-final');
  assert.equal(g.params(1).pageToken, 'p2');
  assert.equal(g.params(2).pageToken, 'p3');
  // The window travels on every page, unchanged.
  for (let i = 0; i < 3; i += 1) assert.equal(g.params(i).timeMin, '2026-09-10T00:00:00.000Z');
});

test('a read that reaches its page limit says so and hands back the token, rather than looking complete', async () => {
  const g = calendar([page([timedEvent()], { nextPageToken: 'more' })]);
  const result = await readGoogleCalendarWindow({ ...base, ...WINDOW, fetchImpl: g.fetchImpl, maxPages: 2 });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(g.calls.length, 2);
  assert.equal(result.page.truncated, true);
  assert.equal(result.page.nextPageToken, 'more');
  assert.equal(result.page.pagesRead, 2);

  // And the caller can continue exactly where it stopped.
  const g2 = calendar([page([timedEvent({ id: 'later' })], { nextSyncToken: 's' })]);
  const rest = await readGoogleCalendarWindow({ ...base, ...WINDOW, fetchImpl: g2.fetchImpl, pageToken: 'more' });
  assert.equal(g2.params().pageToken, 'more');
  assert.equal(rest.ok && rest.page.events[0]!.eventId, 'later');

  assert.equal(GOOGLE_CALENDAR_MAX_PAGES, 10, 'the default bound: 10 pages, 2,500 events');
});

// --- Timing shapes -----------------------------------------------------------------------------

test('a timed event is an instant; the zone it was booked in does not change the moment', async () => {
  const g = calendar([page([timedEvent()])]);
  const result = await readGoogleCalendarWindow({ ...base, ...WINDOW, fetchImpl: g.fetchImpl });
  const event = result.ok ? result.page.events[0]! : null;
  assert.ok(event);
  assert.equal(event!.when.allDay, false);
  assert.equal(event!.when.startsAt?.toISOString(), '2026-09-17T15:00:00.000Z');
  assert.equal(event!.when.endsAt?.toISOString(), '2026-09-17T15:30:00.000Z');
  assert.equal(event!.when.startDate, null);
  assert.equal(event!.providerUpdatedAt?.toISOString(), '2026-09-16T18:04:00.000Z');
  assert.equal(event!.observedAt, OBSERVED);
  assert.equal(event!.summary, 'Cashion / Trevon');
});

test('an all-day event keeps dates and its calendar zone, and invents no instant', () => {
  const fact = normalizeGoogleCalendarEvent(
    { id: 'all-day', status: 'confirmed', summary: 'Conference', start: { date: '2026-09-18', timeZone: 'Europe/Zurich' }, end: { date: '2026-09-19' } },
    { ...base, observedAt: OBSERVED },
  );
  assert.ok(fact);
  assert.equal(fact!.when.allDay, true);
  assert.equal(fact!.when.startsAt, null, 'a date is not a moment until somebody says whose day it is');
  assert.equal(fact!.when.endsAt, null);
  assert.equal(fact!.when.startDate, '2026-09-18');
  assert.equal(fact!.when.endDateExclusive, '2026-09-19', "Google's end date is exclusive, and stays that way");
  assert.equal(fact!.when.timeZone, 'Europe/Zurich');
});

test('an event across midnight, across a DST transition, and in another calendar’s zone', () => {
  // Crosses midnight in the reader's zone; the instants say so and nothing needs a calendar.
  const midnight = normalizeGoogleCalendarEvent(
    { id: 'late', status: 'confirmed', start: { dateTime: '2026-09-17T23:30:00-04:00' }, end: { dateTime: '2026-09-18T00:30:00-04:00' } },
    { ...base, observedAt: OBSERVED },
  );
  assert.equal(midnight!.when.startsAt?.toISOString(), '2026-09-18T03:30:00.000Z');
  assert.equal(midnight!.when.endsAt?.toISOString(), '2026-09-18T04:30:00.000Z');

  // A meeting spanning the US autumn transition: 01:30 EDT (-04:00) to 01:30 EST (-05:00) is
  // TWO hours of wall clock. The offsets in the payload already resolve it; nothing here does
  // zone arithmetic of its own.
  const dst = normalizeGoogleCalendarEvent(
    { id: 'dst', status: 'confirmed', start: { dateTime: '2026-11-01T01:30:00-04:00' }, end: { dateTime: '2026-11-01T01:30:00-05:00' } },
    { ...base, observedAt: OBSERVED },
  );
  assert.equal(dst!.when.startsAt?.toISOString(), '2026-11-01T05:30:00.000Z');
  assert.equal(dst!.when.endsAt?.toISOString(), '2026-11-01T06:30:00.000Z');
  assert.equal((dst!.when.endsAt!.getTime() - dst!.when.startsAt!.getTime()) / 60000, 60);

  // A calendar in Tokyo: the zone is reported as a fact, and the instant is still the instant.
  const tokyo = normalizeGoogleCalendarEvent(
    { id: 'tokyo', status: 'confirmed', start: { dateTime: '2026-09-18T09:00:00+09:00', timeZone: 'Asia/Tokyo' }, end: { dateTime: '2026-09-18T10:00:00+09:00' } },
    { ...base, observedAt: OBSERVED },
  );
  assert.equal(tokyo!.when.startsAt?.toISOString(), '2026-09-18T00:00:00.000Z');
  assert.equal(tokyo!.when.timeZone, 'Asia/Tokyo');
});

test('a recurring instance names its series and its original start; a moved one keeps both', () => {
  const instance = normalizeGoogleCalendarEvent(
    {
      id: 'series_20260917T133000Z',
      status: 'confirmed',
      recurringEventId: 'series',
      originalStartTime: { dateTime: '2026-09-17T09:30:00-04:00' },
      start: { dateTime: '2026-09-17T10:00:00-04:00' },
      end: { dateTime: '2026-09-17T10:30:00-04:00' },
    },
    { ...base, observedAt: OBSERVED },
  );
  assert.equal(instance!.isRecurringInstance, true);
  assert.equal(instance!.recurringEventId, 'series');
  assert.equal(instance!.originalStartsAt?.toISOString(), '2026-09-17T13:30:00.000Z');
  assert.equal(instance!.when.startsAt?.toISOString(), '2026-09-17T14:00:00.000Z', 'the instance was moved half an hour');

  const single = normalizeGoogleCalendarEvent(timedEvent(), { ...base, observedAt: OBSERVED });
  assert.equal(single!.isRecurringInstance, false);
  assert.equal(single!.recurringEventId, null);
  assert.equal(single!.originalStartsAt, null);
});

test('a cancelled event survives the boundary, because that is how a meeting leaves the day', () => {
  // A cancelled instance arrives with no start at all.
  const cancelled = normalizeGoogleCalendarEvent({ id: 'series_20260918T133000Z', status: 'cancelled', recurringEventId: 'series' }, { ...base, observedAt: OBSERVED });
  assert.ok(cancelled, 'a cancellation is a fact, not a malformed event');
  assert.equal(cancelled!.status, 'CANCELLED');
  assert.equal(cancelled!.when.startsAt, null);
  assert.equal(cancelled!.recurringEventId, 'series');

  const tentative = normalizeGoogleCalendarEvent(timedEvent({ status: 'tentative' }), { ...base, observedAt: OBSERVED });
  assert.equal(tentative!.status, 'TENTATIVE');
});

test('an entry that is not a meeting says which kind it is, and free time is not a conflict', () => {
  const kinds: [string, string][] = [
    ['outOfOffice', 'OUT_OF_OFFICE'],
    ['focusTime', 'FOCUS_TIME'],
    ['workingLocation', 'WORKING_LOCATION'],
    ['birthday', 'BIRTHDAY'],
    ['fromGmail', 'FROM_GMAIL'],
    ['default', 'DEFAULT'],
    ['somethingGoogleAddedLater', 'OTHER'],
  ];
  for (const [given, expected] of kinds) {
    const fact = normalizeGoogleCalendarEvent(timedEvent({ eventType: given }), { ...base, observedAt: OBSERVED });
    assert.equal(fact!.kind, expected, given);
  }
  assert.equal(normalizeGoogleCalendarEvent(timedEvent(), { ...base, observedAt: OBSERVED })!.blocking, 'BLOCKING');
  assert.equal(normalizeGoogleCalendarEvent(timedEvent({ transparency: 'transparent' }), { ...base, observedAt: OBSERVED })!.blocking, 'FREE');
});

// --- Who is on it -------------------------------------------------------------------------------

test('attendees are counted and the organizer hashed; rooms are not people', () => {
  const fact = normalizeGoogleCalendarEvent(timedEvent(), { ...base, observedAt: OBSERVED })!;
  assert.equal(fact.attendance.known, true);
  assert.equal(fact.attendance.total, 2, 'two people; the room is not one');
  assert.equal(fact.attendance.external, 1, 'ben@cashionrods.com is outside emgloop.test');
  assert.equal(fact.attendance.resources, 1);
  assert.equal(fact.attendance.selfResponse, 'ACCEPTED');
  assert.equal(fact.organizerHash, googleCalendarAddressHash(SELF));
  assert.equal(fact.organizerIsSelf, true);
  assert.deepEqual(fact.attendeeHashes, [googleCalendarAddressHash('ben@cashionrods.com')], 'one key per other person: not the room, not me');
  assert.equal(fact.hasConference, true);

  // The addresses themselves do not cross the boundary.
  const text = JSON.stringify(fact);
  assert.equal(text.includes('ben@cashionrods.com'), false);
  assert.equal(text.includes(SELF), false);
  assert.equal(fact.organizerHash, hash(SELF));
});

test('an omitted attendee list is unknown, not empty; external is unknown without internal domains', () => {
  const omitted = normalizeGoogleCalendarEvent(timedEvent({ attendees: undefined, attendeesOmitted: true }), { ...base, observedAt: OBSERVED })!;
  assert.deepEqual(omitted.attendance, { known: false, total: null, external: null, resources: null, selfResponse: null });
  assert.deepEqual(omitted.attendeeHashes, [], 'no list, no keys');
  const partial = normalizeGoogleCalendarEvent(timedEvent({ attendeesOmitted: true }), { ...base, observedAt: OBSERVED })!;
  assert.deepEqual(partial.attendeeHashes, [], 'a list Google says is incomplete yields no keys either');

  const noAttendees = normalizeGoogleCalendarEvent(timedEvent({ attendees: undefined }), { ...base, observedAt: OBSERVED })!;
  assert.equal(noAttendees.attendance.known, false, 'Google said nothing about attendees: Loop knows nothing');

  // Nothing said which domains are internal, so "external" is unknowable rather than zero.
  const blind = normalizeGoogleCalendarEvent(timedEvent(), { selfAddress: SELF, observedAt: OBSERVED })!;
  assert.equal(blind.attendance.total, 2);
  assert.equal(blind.attendance.external, null);

  // An attendee with no address cannot be placed inside or outside, so neither can the count.
  const anonymous = normalizeGoogleCalendarEvent(
    timedEvent({ attendees: [{ email: SELF, self: true }, { displayName: 'Someone' }] }),
    { ...base, observedAt: OBSERVED },
  )!;
  assert.equal(anonymous.attendance.total, 2);
  assert.equal(anonymous.attendance.external, null);

  // An organizer who is somebody else.
  const theirs = normalizeGoogleCalendarEvent(
    timedEvent({ organizer: { email: 'ben@cashionrods.com' }, attendees: [{ email: SELF, self: true, responseStatus: 'declined' }] }),
    { ...base, observedAt: OBSERVED },
  )!;
  assert.equal(theirs.organizerIsSelf, false);
  assert.equal(theirs.organizerHash, googleCalendarAddressHash('ben@cashionrods.com'));
  assert.equal(theirs.attendance.selfResponse, 'DECLINED');

  // A conference can also be reported as a bare hangout link.
  assert.equal(normalizeGoogleCalendarEvent(timedEvent({ conferenceData: undefined, hangoutLink: 'https://meet.example/x' }), { ...base, observedAt: OBSERVED })!.hasConference, true);
  assert.equal(normalizeGoogleCalendarEvent(timedEvent({ conferenceData: undefined }), { ...base, observedAt: OBSERVED })!.hasConference, false);
});

// --- Failure ---------------------------------------------------------------------------------------

test('every failure is its own class, and none of them is an empty calendar', async () => {
  const cases: [Answer, string][] = [
    [{ status: 401, body: { error: { code: 401, message: 'Invalid Credentials' } } }, 'AUTH'],
    [{ status: 403, body: { error: { errors: [{ reason: 'forbidden' }] } } }, 'FORBIDDEN'],
    [{ status: 403, body: { error: { errors: [{ reason: 'rateLimitExceeded' }] } } }, 'RATE_LIMITED'],
    [{ status: 403, body: { error: { errors: [{ reason: 'userRateLimitExceeded' }] } } }, 'RATE_LIMITED'],
    [{ status: 429, body: { error: { code: 429 } } }, 'RATE_LIMITED'],
    [{ status: 410, body: { error: { code: 410, message: 'Sync token is no longer valid' } } }, 'CURSOR_EXPIRED'],
    [{ status: 500, body: { error: { code: 500 } } }, 'UNAVAILABLE'],
    [{ status: 503 }, 'UNAVAILABLE'],
    [{ status: 404, body: { error: { code: 404 } } }, 'UNAVAILABLE'],
    [{ status: 200 }, 'MALFORMED'],
    [{ status: 200, body: { nothing: true } }, 'MALFORMED'],
    [{ status: 200, body: { items: 'not an array' } }, 'MALFORMED'],
    ['throw', 'NETWORK'],
  ];
  for (const [answer, expected] of cases) {
    const g = calendar([answer]);
    const result = await readGoogleCalendarWindow({ ...base, ...WINDOW, fetchImpl: g.fetchImpl });
    assert.deepEqual(result, { ok: false, failure: expected }, `${JSON.stringify(answer).slice(0, 50)}`);
  }

  // A timeout is not a network failure, and neither is an empty day.
  const slow = calendar(['hang']);
  assert.deepEqual(await readGoogleCalendarWindow({ ...base, ...WINDOW, fetchImpl: slow.fetchImpl, timeoutMs: 20 }), { ok: false, failure: 'TIMEOUT' });

  // A cursor read fails the same way, and 410 is the one that tells a caller to re-read a window.
  const expired = calendar([{ status: 410, body: { error: { code: 410 } } }]);
  assert.deepEqual(await readGoogleCalendarChanges({ ...base, syncToken: 'old', fetchImpl: expired.fetchImpl }), { ok: false, failure: 'CURSOR_EXPIRED' });
});

test('a failure part-way through pagination is a failure, not a partial day', async () => {
  const g = calendar([page([timedEvent({ id: 'a' })], { nextPageToken: 'p2' }), { status: 503 }]);
  const result = await readGoogleCalendarWindow({ ...base, ...WINDOW, fetchImpl: g.fetchImpl });
  assert.deepEqual(result, { ok: false, failure: 'UNAVAILABLE' }, 'half a calendar is not a calendar');
  assert.equal(g.calls.length, 2);
});

test('an unreadable item is skipped; a page of them is still a successful read of nothing', async () => {
  const g = calendar([page([null, 'nonsense', { status: 'confirmed' }, { id: 'no-start', status: 'confirmed' }, timedEvent({ id: 'good' })])]);
  const result = await readGoogleCalendarWindow({ ...base, ...WINDOW, fetchImpl: g.fetchImpl });
  assert.equal(result.ok, true);
  assert.deepEqual(result.ok && result.page.events.map((e) => e.eventId), ['good'], 'an item this contract cannot state is left out, never half-guessed');
});

test('nothing secret reaches a result, an error or a log', async () => {
  const logged: unknown[] = [];
  const original = { error: console.error, warn: console.warn, log: console.log, info: console.info };
  console.error = console.warn = console.log = console.info = (...args: unknown[]) => void logged.push(args);
  try {
    for (const answer of ['throw', { status: 200, body: { items: [timedEvent({ description: 'private notes', location: '221B Baker Street' })] } }] as Answer[]) {
      const g = calendar([answer]);
      const result = await readGoogleCalendarWindow({ ...base, ...WINDOW, fetchImpl: g.fetchImpl });
      const text = JSON.stringify(result);
      for (const secret of [TOKEN, 'ben@cashionrods.com', SELF, 'private notes', '221B Baker Street', 'socket hang up']) {
        assert.equal(text.includes(secret), false, secret);
      }
    }
  } finally {
    Object.assign(console, original);
  }
  assert.deepEqual(logged, [], 'the sensor logs nothing at all');
});

test('the sensor stores nothing, calls no model, and holds no credential of its own', () => {
  const source = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'google-workspace', 'calendar.ts'), 'utf8');
  for (const forbidden of ['prisma', 'PrismaClient', 'work_events', 'workEvent', 'anthropic', 'openai', 'process.env', 'GOOGLE_OAUTH_CLIENT', 'refreshToken']) {
    assert.equal(source.toLowerCase().includes(forbidden.toLowerCase()), false, forbidden);
  }
  // It reads the primary calendar and asks for no other scope's endpoint.
  assert.equal(source.includes('calendars/primary/events'), true);
  for (const elsewhere of ['gmail.googleapis.com', 'www.googleapis.com/drive', 'calendarList', 'freeBusy']) {
    assert.equal(source.includes(elsewhere), false, elsewhere);
  }
});

test('attendee keys: the same key as the mail correspondent, self excluded by flag or address, deduplicated and capped', () => {
  const people = Array.from({ length: 60 }, (_, i) => ({ email: `guest${i}@outside.test` }));
  const fact = normalizeGoogleCalendarEvent(
    timedEvent({
      organizer: { email: 'ben@cashionrods.com' },
      attendees: [{ email: ` ${SELF.toUpperCase()} ` }, { email: 'Ben@CashionRods.com' }, { email: 'ben@cashionrods.com' }, { displayName: 'No address' }, ...people],
    }),
    { ...base, observedAt: OBSERVED },
  )!;
  assert.equal(fact.attendeeHashes[0], googleAddressHash('ben@cashionrods.com'), 'the one hash every Google surface uses');
  assert.equal(fact.attendeeHashes.includes(googleAddressHash(SELF)), false, 'my own address is not an attendee key');
  assert.equal(fact.attendeeHashes.length, 50, 'capped');
  assert.equal(new Set(fact.attendeeHashes).size, 50, 'deduplicated');
  assert.equal(JSON.stringify(fact).includes('outside.test'), false, 'no address crosses the boundary');
});
