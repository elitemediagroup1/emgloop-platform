// Your Day, assembled for one signed-in employee. SERVER ONLY.
//
// Architecture: docs/architecture/daily-loop-employee-intelligence.md §5.2, §8.4 and §22.4 (DL-4).
//
// WHOSE DAY. The principal comes from the signed session and from nowhere else -- no query
// parameter, no route segment, no body, no header. Every read is scoped by organization AND user
// through the DL-1 repositories, so there is no shape of request that shows one person another
// person's calendar, whatever role they hold.
//
// THE DAY IS THE EMPLOYEE'S, NOT UTC'S. "Today" is resolved in the employee's own zone: their
// stored preference when they have set one, otherwise the zone their browser reported, otherwise
// UTC and labelled as such. Timed events are placed by instant; all-day entries are placed by
// civil date and never converted into a midnight (DL-2, DL-3).
//
// A PAGE RENDER IS NOT A REASON TO CALL GOOGLE. A visit refreshes at most once every fifteen
// minutes, and only when the connection is usable; a person asking by hand is honoured once a
// minute. Everything else is served from what DL-3 already stored, and a refusal to refresh never
// changes what is shown -- only how current Loop says it is.

import 'server-only';

import {
  WorkGraphRepository,
  WorkPreferencesRepository,
  WorkSourceRepository,
  prisma,
  type WorkPrincipal,
} from '@emgloop/database';
import {
  CALENDAR_MANUAL_REFRESH_FLOOR_MS,
  calendarFreshness,
  positionInDay,
  resolveDisplayTimeZone,
  scheduleFor,
  shouldRefreshOnVisit,
  startOfZonedDay,
  summarizeDay,
  zonedCalendarDay,
  type CalendarFreshness,
  type DayBounds,
  type DayEvent,
  type DayPosition,
  type DaySchedule,
  type DaySummary,
  type DisplayTimeZone,
} from '@emgloop/shared';

import { googleWorkspace } from '../google/google-runtime';
import { syncEmployeeCalendar } from './calendar-runtime';
import { TIME_ZONE_COOKIE, decodeTimeZoneCookie } from '../time/time-zone-cookie';
import { cookies } from 'next/headers';

export interface YourDayView {
  readonly zone: DisplayTimeZone;
  readonly now: Date;
  readonly today: DayBounds;
  readonly tomorrow: DayBounds;
  readonly todaySchedule: DaySchedule;
  readonly tomorrowSchedule: DaySchedule;
  readonly summary: DaySummary;
  readonly tomorrowSummary: DaySummary;
  readonly position: DayPosition;
  readonly freshness: CalendarFreshness;
  /** When Loop last completed a successful read. Null when it never has. */
  readonly lastSyncedAt: Date | null;
  /** True when this render spent a Google call. */
  readonly refreshed: boolean;
}

const DAY_MS = 86_400_000;

/** The employee's own zone: their preference, then their browser, then UTC -- labelled either way. */
function readerZone(preference: string | null): DisplayTimeZone {
  let device: string | null = null;
  try {
    device = decodeTimeZoneCookie(cookies().get(TIME_ZONE_COOKIE)?.value);
  } catch {
    device = null;
  }
  return resolveDisplayTimeZone({ preference, device });
}

/** One local day, as the instants it spans and the civil date it is. */
function boundsFor(anchor: Date, timeZone: string): DayBounds {
  const startsAt = startOfZonedDay(anchor, timeZone);
  // The next day's start, resolved the same way, so a 23- or 25-hour day is the length it really is.
  const endsAt = startOfZonedDay(new Date(startsAt.getTime() + DAY_MS + DAY_MS / 2), timeZone);
  return { civilDate: zonedCalendarDay(startsAt, timeZone), startsAt, endsAt };
}

/** `YYYY-MM-DD` as a UTC-midnight Date, which is how a DATE column compares. */
const civilDateValue = (civilDate: string): Date => new Date(`${civilDate}T00:00:00.000Z`);

const dayEventOf = (row: any): DayEvent => ({
  eventId: row.eventId,
  summary: row.summary,
  startsAt: row.startsAt,
  endsAt: row.endsAt,
  allDay: row.allDay,
  startDate: row.startDate ? new Date(row.startDate).toISOString().slice(0, 10) : null,
  endDateExclusive: row.endDateExclusive ? new Date(row.endDateExclusive).toISOString().slice(0, 10) : null,
  status: row.status,
  blocking: row.blocking,
  kind: row.kind,
  selfResponse: row.selfResponse,
  hasConference: row.hasConference,
  organizerIsSelf: row.organizerIsSelf,
  attendanceKnown: row.attendanceKnown,
  attendeeCount: row.attendeeCount,
  externalAttendeeCount: row.externalAttendeeCount,
  recurringEventId: row.recurringEventId,
});

/**
 * Everything Your Day needs for one person, refreshing first only when that is justified.
 *
 * `allowRefresh` is false on a manual re-render (a server action has already decided), so one
 * interaction can never turn into two Google calls.
 */
export async function loadYourDay(principal: WorkPrincipal, options: { readonly allowRefresh?: boolean } = {}): Promise<YourDayView | null> {
  const status = await googleWorkspace().status(principal);
  // An AI Employee holds no Google connection and no calendar; there is nothing to render.
  if (!status.permitted) return null;

  const preferences = new WorkPreferencesRepository(prisma);
  const sources = new WorkSourceRepository(prisma);
  const graph = new WorkGraphRepository(prisma);

  const stored = await preferences.get(principal);
  const zone = readerZone(stored.timeZone === 'UTC' ? null : stored.timeZone);

  const beforeCursor = await sources.cursor(principal, 'CALENDAR');
  const beforeRuns = await sources.recentRuns(principal, 1);
  const state = {
    configured: status.configured,
    capability: status.capabilities.calendar as 'CONNECTED' | 'NOT_CONNECTED' | 'INSUFFICIENT_SCOPE' | 'EXPIRED',
    lastSyncCompletedAt: beforeCursor?.lastSyncCompletedAt ?? null,
    lastRunOutcome: beforeRuns[0]?.outcome ?? null,
  };

  let freshness = calendarFreshness(state, new Date());
  let refreshed = false;
  if ((options.allowRefresh ?? true) && shouldRefreshOnVisit(freshness, state.lastSyncCompletedAt, new Date())) {
    try {
      await syncEmployeeCalendar(principal);
      refreshed = true;
    } catch {
      // A refresh that could not happen changes how current Loop says it is, never what it shows.
    }
  }

  const cursor = refreshed ? await sources.cursor(principal, 'CALENDAR') : beforeCursor;
  const runs = refreshed ? await sources.recentRuns(principal, 1) : beforeRuns;
  const now = new Date();
  freshness = calendarFreshness(
    { ...state, lastSyncCompletedAt: cursor?.lastSyncCompletedAt ?? null, lastRunOutcome: runs[0]?.outcome ?? null },
    now,
  );

  const today = boundsFor(now, zone.timeZone);
  const tomorrow = boundsFor(new Date(today.endsAt.getTime() + DAY_MS / 2), zone.timeZone);

  const rows = await graph.eventsForDays(principal, {
    fromInstant: today.startsAt,
    toInstant: tomorrow.endsAt,
    fromDate: civilDateValue(today.civilDate),
    toDate: civilDateValue(tomorrow.civilDate),
  });
  const events = rows.map(dayEventOf);

  const todaySchedule = scheduleFor(events, today);
  const tomorrowSchedule = scheduleFor(events, tomorrow);

  return {
    zone,
    now,
    today,
    tomorrow,
    todaySchedule,
    tomorrowSchedule,
    summary: summarizeDay(todaySchedule, today, now),
    tomorrowSummary: summarizeDay(tomorrowSchedule, tomorrow, tomorrow.startsAt),
    position: positionInDay(todaySchedule, now),
    freshness,
    lastSyncedAt: cursor?.lastSyncCompletedAt ?? null,
    refreshed,
  };
}

/**
 * A person asking for a fresh read by hand. Honoured once a minute, for their own calendar only.
 *
 * The floor is not rate limiting for its own sake: a refresh spends this employee's Google quota,
 * and two clicks in a second cannot make the calendar newer than one.
 */
export async function refreshYourDay(principal: WorkPrincipal): Promise<void> {
  const sources = new WorkSourceRepository(prisma);
  const cursor = await sources.cursor(principal, 'CALENDAR');
  const last = cursor?.lastSyncStartedAt ?? null;
  if (last && Date.now() - last.getTime() < CALENDAR_MANUAL_REFRESH_FLOOR_MS) return;

  const status = await googleWorkspace().status(principal);
  if (!status.permitted || status.capabilities.calendar !== 'CONNECTED') return;
  try {
    await syncEmployeeCalendar(principal);
  } catch {
    // The state the surface reads already records what happened; nothing is thrown at a person.
  }
}
