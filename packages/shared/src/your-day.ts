// Your Day: one employee's calendar, projected into the day they are actually having.
//
// Architecture: docs/architecture/daily-loop-employee-intelligence.md §5.2 and §8.4, slice DL-4.
//
// EVERY SENTENCE THIS PRODUCES CAN BE PROVEN FROM A STORED ROW. There is no model here, no
// scoring, and no claim about what a meeting is for: the facts are the ones DL-3 persisted from
// Google (times, all-day, status, blocking, the person's own response, conference presence,
// attendance counts where the provider stated them), and nothing else is inferred from them.
// "Your afternoon is clear" is a statement about blocking events between two wall-clock hours;
// "preparation recommended" is not a statement this file can make, so it does not.
//
// A DATE IS NOT AN INSTANT, AND THIS FILE NEVER CONFUSES THEM. A timed event is an instant and
// is placed by comparing instants. An all-day event is a civil date and is placed by comparing
// civil dates -- never by inventing a midnight for it. The caller computes the day's boundaries
// with the Loop Time Authority and hands them in; this file does no zone arithmetic and knows no
// zone.
//
// PURE. No clock, no I/O, no environment, no formatting: `now` and every boundary are arguments,
// and times come back as instants for the presentation layer to render in the reader's zone.

// --- What a day is made of --------------------------------------------------------------------

/** The stored facts Your Day reads. A subset of `work_events`, and deliberately no more. */
export interface DayEvent {
  readonly eventId: string;
  readonly summary: string | null;
  /** Instants, for a timed event. */
  readonly startsAt: Date | null;
  readonly endsAt: Date | null;
  readonly allDay: boolean;
  /** `YYYY-MM-DD`, for an all-day event. `endDate` is EXCLUSIVE, as the provider reports it. */
  readonly startDate: string | null;
  readonly endDateExclusive: string | null;
  readonly status: string | null;
  readonly blocking: string | null;
  readonly kind: string | null;
  readonly selfResponse: string | null;
  readonly hasConference: boolean;
  readonly organizerIsSelf: boolean;
  readonly attendanceKnown: boolean;
  readonly attendeeCount: number | null;
  readonly externalAttendeeCount: number | null;
  readonly recurringEventId: string | null;
}

/** One local day, as instants and as a civil date. The caller resolves these in the reader's zone. */
export interface DayBounds {
  /** `YYYY-MM-DD` in the employee's zone. */
  readonly civilDate: string;
  /** The instant the day begins, and the instant the next day begins. */
  readonly startsAt: Date;
  readonly endsAt: Date;
}

/**
 * Why an event is not part of the day's schedule.
 *
 * Both are facts the provider stated, not judgments: a cancelled event was called off, and a
 * declined one is a meeting this person said they would not attend. They are counted and named
 * rather than hidden, because a day that quietly loses a meeting is a day the employee cannot
 * trust.
 */
import {
  CALENDAR_FRESHNESS_POLICY,
  WORK_FRESHNESS_ADMITS_EMPTY,
  WORK_SOURCE_FRESHNESS,
  shouldRefreshWorkSourceOnVisit,
  workSourceFreshness,
  type WorkSourceFreshness,
  type WorkSourceStateInput,
} from './work-freshness';

export const DAY_EXCLUSIONS = ['CANCELLED', 'DECLINED'] as const;
export type DayExclusion = (typeof DAY_EXCLUSIONS)[number];

export interface DaySchedule {
  /** All-day entries first: they frame the day rather than sitting in it. */
  readonly allDay: readonly DayEvent[];
  /** Timed entries in start order, earliest first. */
  readonly timed: readonly DayEvent[];
  /** Called off or declined, kept so the day can say so. */
  readonly excluded: readonly { readonly event: DayEvent; readonly reason: DayExclusion }[];
}

function exclusionOf(event: DayEvent): DayExclusion | null {
  if (event.status === 'CANCELLED') return 'CANCELLED';
  if (event.selfResponse === 'DECLINED') return 'DECLINED';
  return null;
}

/** Whether an all-day entry covers this civil date: `startDate <= date < endDateExclusive`. */
function coversDate(event: DayEvent, civilDate: string): boolean {
  if (!event.startDate) return false;
  if (event.startDate > civilDate) return false;
  // A provider that gave no end means one day, which is the start date itself.
  const end = event.endDateExclusive ?? event.startDate;
  return civilDate < end || event.startDate === civilDate;
}

/**
 * The events that belong to one local day.
 *
 * A timed event belongs to the day its START falls in, so a meeting running past midnight sits
 * once, on the day it began, rather than appearing twice or vanishing from both.
 */
export function scheduleFor(events: readonly DayEvent[], day: DayBounds): DaySchedule {
  const allDay: DayEvent[] = [];
  const timed: DayEvent[] = [];
  const excluded: { event: DayEvent; reason: DayExclusion }[] = [];

  for (const event of events) {
    const onThisDay = event.allDay
      ? coversDate(event, day.civilDate)
      : event.startsAt !== null && event.startsAt >= day.startsAt && event.startsAt < day.endsAt;
    if (!onThisDay) continue;

    const reason = exclusionOf(event);
    if (reason) {
      excluded.push({ event, reason });
      continue;
    }
    if (event.allDay) allDay.push(event);
    else timed.push(event);
  }

  timed.sort((a, b) => (a.startsAt!.getTime() - b.startsAt!.getTime()) || a.eventId.localeCompare(b.eventId));
  allDay.sort((a, b) => (a.startDate ?? '').localeCompare(b.startDate ?? '') || a.eventId.localeCompare(b.eventId));
  return { allDay, timed, excluded };
}

// --- What is happening now, and next -----------------------------------------------------------

export interface DayPosition {
  /** The timed event covering `now`, when there is one. */
  readonly inProgress: DayEvent | null;
  /** The next timed event to start after `now`, today. */
  readonly next: DayEvent | null;
  /** Whole minutes until `next` starts. Null when there is no next event. */
  readonly minutesUntilNext: number | null;
  /** Timed events still to come, including the one in progress. */
  readonly remaining: number;
}

/** Where the person is in their day. Facts only: what is running, what is next, how long until. */
export function positionInDay(schedule: DaySchedule, now: Date): DayPosition {
  const inProgress =
    schedule.timed.find((e) => e.startsAt !== null && e.startsAt <= now && (e.endsAt === null || e.endsAt > now)) ?? null;
  const next = schedule.timed.find((e) => e.startsAt !== null && e.startsAt > now) ?? null;
  const remaining = schedule.timed.filter((e) => (e.endsAt ?? e.startsAt)! > now).length;
  return {
    inProgress,
    next,
    minutesUntilNext: next?.startsAt ? Math.max(0, Math.round((next.startsAt.getTime() - now.getTime()) / 60_000)) : null,
    remaining,
  };
}

// --- What can truthfully be said about the day ---------------------------------------------------

/**
 * The shape of a day, as facts a sentence can be built from. No strings: the presentation layer
 * renders times in the reader's zone, and this file never formats one.
 */
export interface DaySummary {
  readonly total: number;
  readonly allDayCount: number;
  readonly timedCount: number;
  readonly cancelledCount: number;
  readonly declinedCount: number;
  /** The first start and the last end among timed events, when there are any. */
  readonly firstStart: Date | null;
  readonly lastEnd: Date | null;
  /** How many timed events have not finished yet. */
  readonly remaining: number;
  /**
   * Whether a named stretch of the day holds no blocking event. Null when the day has no events
   * at all -- "your afternoon is clear" is worth saying about a busy day and meaningless about an
   * empty one.
   */
  readonly afternoonClear: boolean | null;
  readonly morningClear: boolean | null;
}

/** The wall-clock stretches the summary can speak about, as minutes from local midnight. */
export const DAY_MORNING = Object.freeze({ fromMinutes: 8 * 60, toMinutes: 12 * 60 });
export const DAY_AFTERNOON = Object.freeze({ fromMinutes: 12 * 60, toMinutes: 17 * 60 });

function overlapsStretch(event: DayEvent, day: DayBounds, stretch: { fromMinutes: number; toMinutes: number }): boolean {
  if (event.startsAt === null) return false;
  const from = new Date(day.startsAt.getTime() + stretch.fromMinutes * 60_000);
  const to = new Date(day.startsAt.getTime() + stretch.toMinutes * 60_000);
  const end = event.endsAt ?? event.startsAt;
  return event.startsAt < to && end > from;
}

/**
 * What is true about this day.
 *
 * A stretch counts as clear only when no BLOCKING event overlaps it: an event the provider marked
 * transparent is on the calendar and does not take the time, and saying otherwise would be a
 * claim the data does not support.
 */
export function summarizeDay(schedule: DaySchedule, day: DayBounds, now: Date): DaySummary {
  const blocking = schedule.timed.filter((e) => e.blocking !== 'FREE');
  const starts = schedule.timed.map((e) => e.startsAt!).filter(Boolean);
  const ends = schedule.timed.map((e) => e.endsAt ?? e.startsAt!).filter(Boolean);
  const hasEvents = schedule.timed.length + schedule.allDay.length > 0;

  return {
    total: schedule.timed.length + schedule.allDay.length,
    allDayCount: schedule.allDay.length,
    timedCount: schedule.timed.length,
    cancelledCount: schedule.excluded.filter((e) => e.reason === 'CANCELLED').length,
    declinedCount: schedule.excluded.filter((e) => e.reason === 'DECLINED').length,
    firstStart: starts.length > 0 ? new Date(Math.min(...starts.map((d) => d.getTime()))) : null,
    lastEnd: ends.length > 0 ? new Date(Math.max(...ends.map((d) => d.getTime()))) : null,
    remaining: positionInDay(schedule, now).remaining,
    morningClear: hasEvents ? !blocking.some((e) => overlapsStretch(e, day, DAY_MORNING)) : null,
    afternoonClear: hasEvents ? !blocking.some((e) => overlapsStretch(e, day, DAY_AFTERNOON)) : null,
  };
}

// --- How current the picture is ------------------------------------------------------------------

/**
 * Whether Loop can stand behind what it is showing.
 *
 * "NOTHING SCHEDULED" IS ONLY SAYABLE IN THE `CURRENT` AND `STALE` STATES. Every other value
 * means Loop does not know what is on the calendar, and the surface must say which -- never an
 * empty day (§22.4, and attention-state.ts).
 *
 *   CURRENT                 a successful read, recently enough to trust.
 *   STALE                   a successful read, but not recently; shown with its age.
 *   NEVER_SYNCED            connected, and nothing has been read yet.
 *   SYNC_FAILED             the last attempt failed; what is shown is the last good read.
 *   NOT_CONNECTED           no Google connection.
 *   CAPABILITY_NOT_GRANTED  connected, without Calendar.
 *   AUTHORIZATION_EXPIRED   the grant no longer works; reconnecting is the way back.
 *   NOT_CONFIGURED          this deployment has no Google client; nothing to offer.
 */
export const CALENDAR_FRESHNESS = WORK_SOURCE_FRESHNESS;
export type CalendarFreshness = WorkSourceFreshness;

/** The states in which an empty day means "nothing is scheduled" rather than "I could not look". */
export const FRESHNESS_ADMITS_EMPTY: readonly CalendarFreshness[] = WORK_FRESHNESS_ADMITS_EMPTY;

/** A successful read older than this is shown as stale, with its age. */
export const CALENDAR_STALE_AFTER_MS = CALENDAR_FRESHNESS_POLICY.staleAfterMs;

/** Loop refreshes on a visit at most this often. A page render is not a reason to call Google. */
export const CALENDAR_REFRESH_AFTER_MS = CALENDAR_FRESHNESS_POLICY.refreshAfterMs;

/** A person asking for a refresh by hand is honoured no more often than this. */
export const CALENDAR_MANUAL_REFRESH_FLOOR_MS = CALENDAR_FRESHNESS_POLICY.manualFloorMs;

export type CalendarStateInput = WorkSourceStateInput;

/** Which of the eight states the surface is in. Connection first: it outranks any stored read. */
export function calendarFreshness(input: CalendarStateInput, now: Date): CalendarFreshness {
  return workSourceFreshness(input, now, CALENDAR_FRESHNESS_POLICY);
}

/** Whether a visit should spend a Google call, given when the last successful read finished. */
export function shouldRefreshOnVisit(freshness: CalendarFreshness, lastSyncCompletedAt: Date | null, now: Date): boolean {
  return shouldRefreshWorkSourceOnVisit(freshness, lastSyncCompletedAt, now, CALENDAR_FRESHNESS_POLICY);
}
