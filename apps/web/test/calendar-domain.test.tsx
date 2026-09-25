// CALENDAR as a domain (2026-09-24): the viewer's own day, over the same `loadYourDay` read Home and
// Mail use. Source-level for the guard and the principal; rendered with fixtures for everything the
// page says -- including what it must never say: a join link, a location, an attendee's name, or a
// clear morning/afternoon the day's summary does not state.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  createTimeView,
  positionInDay,
  scheduleFor,
  summarizeDay,
  type CalendarFreshness,
  type DayBounds,
  type DayEvent,
} from '@emgloop/shared';

import { CalendarView, calendarEventFacts } from '../src/app/app/calendar/_calendar/calendar-view';
import type { YourDayView } from '../src/daily-loop/your-day';

const ZONE = { timeZone: 'America/New_York', source: 'device' as const };
// 11:00 in New York.
const NOW = new Date('2026-09-24T15:00:00Z');
const time = createTimeView(ZONE, NOW);
const TODAY: DayBounds = { civilDate: '2026-09-24', startsAt: new Date('2026-09-24T04:00:00Z'), endsAt: new Date('2026-09-25T04:00:00Z') };
const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const code = (s: string) =>
  s.replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
const render = (el: unknown) => renderToStaticMarkup(el as never);

function event(over: Partial<DayEvent> & { eventId: string }): DayEvent {
  return {
    summary: 'Pipeline review',
    startsAt: null,
    endsAt: null,
    allDay: false,
    startDate: null,
    endDateExclusive: null,
    status: 'CONFIRMED',
    blocking: 'BUSY',
    kind: 'DEFAULT',
    selfResponse: 'ACCEPTED',
    hasConference: false,
    organizerIsSelf: false,
    attendanceKnown: true,
    attendeeCount: 1,
    externalAttendeeCount: 0,
    recurringEventId: null,
    ...over,
  };
}

function day(events: DayEvent[], freshness: CalendarFreshness = 'CURRENT', lastSyncedAt: Date | null = new Date(NOW.getTime() - 5 * 60_000)): YourDayView {
  const todaySchedule = scheduleFor(events, TODAY);
  return {
    zone: ZONE,
    now: NOW,
    today: TODAY,
    todaySchedule,
    summary: summarizeDay(todaySchedule, TODAY, NOW),
    position: positionInDay(todaySchedule, NOW),
    freshness,
    lastSyncedAt,
    refreshed: false,
  };
}

// 10:30–11:30 (on now), 14:00–15:00 with a video call and 4 people, and an all-day entry.
const BUSY_DAY = [
  event({ eventId: 'e1', summary: 'Standup', startsAt: new Date('2026-09-24T14:30:00Z'), endsAt: new Date('2026-09-24T15:30:00Z') }),
  event({ eventId: 'e2', summary: 'Buyer call', startsAt: new Date('2026-09-24T18:00:00Z'), endsAt: new Date('2026-09-24T19:00:00Z'), hasConference: true, attendeeCount: 4, externalAttendeeCount: 2 }),
  event({ eventId: 'a1', summary: 'Company offsite', allDay: true, startDate: '2026-09-24', endDateExclusive: '2026-09-25' }),
  event({ eventId: 'x1', summary: 'Cancelled sync', startsAt: new Date('2026-09-24T20:00:00Z'), endsAt: new Date('2026-09-24T20:30:00Z'), status: 'CANCELLED' }),
];

describe('the Calendar page', () => {
  const PAGE = code(read('../src/app/app/calendar/page.tsx'));
  const VIEW = code(read('../src/app/app/calendar/_calendar/calendar-view.tsx'));

  it('guards itself with Mail\'s gate before any read, and reads the day for the session principal only', () => {
    const body = PAGE.slice(PAGE.indexOf('export default async function CalendarPage'));
    assert.match(body, /if \(!session\) redirect\(loginPathFor\('\/app\/calendar'\)\);/);
    const guard = body.indexOf("await requirePermission('employeeIntelligence', 'view')");
    assert.ok(guard > 0);
    assert.ok(guard < body.indexOf('loadYourDay('), 'guard before the read');
    assert.match(body, /const principal = \{ organizationId: session\.organizationId, userId: session\.userId \};/);
    assert.match(body, /loadYourDay\(principal\)/);
    assert.equal(/searchParams|params|formData|headers\(/.test(body), false, 'nothing from the request names a person');
    assert.match(read('../src/app/app/mail/page.tsx'), /requirePermission\('employeeIntelligence', 'view'\)/);
    assert.match(PAGE, /export const dynamic = 'force-dynamic'/);
  });

  it('reuses the Refresh control rather than copying it, and the action refreshes this page too', () => {
    assert.match(VIEW, /import \{ RefreshCalendar \} from '\.\.\/\.\.\/_home\/refresh-calendar';/);
    assert.equal(/refreshCalendarAction/.test(VIEW), false);
    assert.match(code(read('../src/daily-loop/actions.ts')), /revalidatePath\('\/app\/calendar'\)/);
  });

  it('invents no join link, location or attendee name: the view reads no such field and links nowhere but Connections', () => {
    assert.equal(/location|hangoutLink|conferenceUri|joinUrl|attendees\b|\.email|displayName/i.test(VIEW), false);
    assert.equal(/https?:/.test(VIEW), false);
    const hrefs = [...VIEW.matchAll(/href[=:]\s*\{?([A-Z_]+|'[^']*')/g)].map((m) => m[1]);
    for (const h of hrefs) assert.equal(h, 'CONNECTIONS_HREF');
  });
});

describe('the Calendar view, rendered', () => {
  it('draws today in the reader\'s zone: now, next, the all-day entry, the schedule and what was not shown', () => {
    const html = render(<CalendarView day={day(BUSY_DAY)} time={time} />);
    assert.match(html, /On now: Standup, until 11:30/);
    assert.match(html, /Next: Buyer call at 2:00/);
    assert.match(html, /All day<\/span><span class="loop-cal__title">Company offsite/);
    assert.match(html, /10:30/);
    assert.match(html, /4 people, 2 external · Video call/);
    assert.match(html, /Not shown: 1 event was cancelled\./);
    assert.match(html, /2 meetings · 1 all-day event/);
    assert.match(html, /href="\/app\/connections"[^>]*>Manage connection</);
    assert.match(html, /Read my calendar again/);
    assert.match(html, /America\/New_York/);
  });

  it('says a stretch is clear only when the summary says true', () => {
    // BUSY_DAY blocks the morning (10:30) and the afternoon (14:00): neither is clear.
    const busy = day(BUSY_DAY);
    assert.equal(busy.summary.morningClear, false);
    assert.equal(busy.summary.afternoonClear, false);
    const html = render(<CalendarView day={busy} time={time} />);
    assert.equal(/morning is clear|afternoon is clear/.test(html), false);
    // One late-morning meeting: the afternoon is clear, the morning is not.
    const late = day([event({ eventId: 'm', summary: 'Sync', startsAt: new Date('2026-09-24T15:30:00Z'), endsAt: new Date('2026-09-24T16:00:00Z') })]);
    assert.equal(late.summary.afternoonClear, true);
    const lateHtml = render(<CalendarView day={late} time={time} />);
    assert.match(lateHtml, /Your afternoon is clear\./);
    assert.equal(lateHtml.includes('Your morning is clear'), false);
    // An empty day: the summary says null, so neither is said -- only that nothing is on.
    const empty = render(<CalendarView day={day([])} time={time} />);
    assert.equal(/is clear/.test(empty), false);
    assert.match(empty, /Nothing is on your calendar today\./);
  });

  it('a stale read says so; a failed sync shows the last read and never claims an empty day as current', () => {
    const stale = render(<CalendarView day={day(BUSY_DAY, 'STALE', new Date(NOW.getTime() - 3 * 3_600_000))} time={time} />);
    assert.match(stale, /As Loop last read it, 3 hours ago\./);
    const failed = render(<CalendarView day={day([], 'SYNC_FAILED', new Date(NOW.getTime() - 3 * 3_600_000))} time={time} />);
    assert.match(failed, /Loop could not reach Google just now\. As Loop last read it/);
    assert.match(failed, /Nothing was on your calendar today when Loop last read it\./);
  });

  it('not connected: the primary action is connecting in Connections, and no schedule or refresh is drawn', () => {
    const html = render(<CalendarView day={day([], 'NOT_CONNECTED', null)} time={time} />);
    assert.match(html, /Your calendar is not connected/);
    assert.match(html, /class="loop-btn loop-btn--primary" href="\/app\/connections">Connect Google Calendar</);
    assert.equal(html.includes('Nothing is on your calendar'), false);
    assert.equal(html.includes('Read my calendar again'), false);
  });

  it('every other non-read state says what it is', () => {
    assert.match(render(<CalendarView day={day([], 'CAPABILITY_NOT_GRANTED', null)} time={time} />), /Allow calendar access/);
    assert.match(render(<CalendarView day={day([], 'AUTHORIZATION_EXPIRED', null)} time={time} />), /Reconnect Google/);
    const never = render(<CalendarView day={day([], 'NEVER_SYNCED', null)} time={time} />);
    assert.match(never, /Loop has not read your calendar yet/);
    assert.match(never, /Read my calendar again/);
    assert.match(render(<CalendarView day={day([], 'NOT_CONFIGURED', null)} time={time} />), /Calendar is not available yet/);
    assert.match(render(<CalendarView day="UNAVAILABLE" time={time} />), /Loop could not open your calendar just now/);
    assert.match(render(<CalendarView day={null} time={time} />), /No calendar/);
  });

  it('event facts are stored columns only: counts, never names', () => {
    assert.deepEqual(calendarEventFacts(event({ eventId: 'f', attendeeCount: 3, externalAttendeeCount: 0, hasConference: true, organizerIsSelf: true })), ['3 people', 'Video call', 'You organize it']);
    assert.deepEqual(calendarEventFacts(event({ eventId: 'g', attendanceKnown: false, attendeeCount: 9 })), []);
  });
});
