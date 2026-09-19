// What Loop knows about a calendar, independent of whose calendar it is.
//
// Architecture: docs/architecture/daily-loop-employee-intelligence.md §8 and §13.3, slice DL-2.
//
// THIS IS THE LOOP-OWNED SHAPE, NOT GOOGLE'S. A provider adapter turns its own payload into
// these facts and nothing above it ever sees a Google field name, a Google enum or a Google
// response object. A second calendar provider implements the same contract and Daily Loop
// does not change -- which is the whole reason this file is not simply Google's schema with
// different capitalisation.
//
// FACTS, NOT MEANING. Nothing here says a meeting is important, needs preparation, or is
// one the employee should attend. Those are rules, they belong to later slices, and they are
// deterministic producers over these facts (§6, §8.4).
//
// WHAT IS DELIBERATELY ABSENT. No description, no location, no attendee addresses, no
// attachment, no conference joining URL. An attendee's address is a CONTACT_IDENTIFIER: the
// adapter counts attendees and reduces the organizer and each other invitee to the same one-way
// key a mail correspondent has (D2, approved 2026-09-19), and the addresses do not survive the
// boundary. Those keys join the person's own mail to their own calendar and nothing else: they
// are never matched to a Party (§8.3, §11.4, and meeting-intelligence.md §2).
//
// PURE. No clock, no I/O, no environment: an adapter passes `observedAt` in.

import type { WorkProvider, WorkSyncFailureClass } from './work-state';

// --- The vocabularies ------------------------------------------------------------------------

/** Confirmed, tentatively confirmed, or cancelled. Google's three, normalized. */
export const CALENDAR_EVENT_STATUSES = ['CONFIRMED', 'TENTATIVE', 'CANCELLED'] as const;
export type CalendarEventStatus = (typeof CALENDAR_EVENT_STATUSES)[number];

/**
 * What kind of entry this is. `OUT_OF_OFFICE`, `FOCUS_TIME` and `WORKING_LOCATION` are not
 * meetings, and a later rule needs to know that without inspecting a title. `OTHER` covers a
 * kind this contract has not met: an unknown word is reported as unknown, never as DEFAULT.
 */
export const CALENDAR_EVENT_KINDS = ['DEFAULT', 'OUT_OF_OFFICE', 'FOCUS_TIME', 'WORKING_LOCATION', 'BIRTHDAY', 'FROM_GMAIL', 'OTHER'] as const;
export type CalendarEventKind = (typeof CALENDAR_EVENT_KINDS)[number];

/** Whether the entry blocks time. A transparent event is on the calendar and is not a conflict. */
export const CALENDAR_TIME_BLOCKING = ['BLOCKING', 'FREE'] as const;
export type CalendarTimeBlocking = (typeof CALENDAR_TIME_BLOCKING)[number];

/** The connected person's own answer, when the provider states one. */
export const CALENDAR_RESPONSES = ['ACCEPTED', 'DECLINED', 'TENTATIVE', 'NEEDS_ACTION'] as const;
export type CalendarResponse = (typeof CALENDAR_RESPONSES)[number];

// --- The facts ------------------------------------------------------------------------------

/**
 * When an event happens.
 *
 * A TIMED EVENT HAS INSTANTS. `startsAt` and `endsAt` are absolute moments, which is what the
 * Loop Time Authority means by an instant: UTC underneath, rendered later in the reader's zone.
 *
 * AN ALL-DAY EVENT HAS DATES, AND A DATE IS NOT AN INSTANT. "18 September" begins at a
 * different moment in Chicago than in Zurich, so the adapter does NOT invent one: it reports
 * the provider's dates and the calendar's own zone, and the layer that knows whose day it is
 * resolves them (`zonedWallTimeToUtc` in loop-time.ts). Guessing here would bake one zone into
 * a stored fact and be wrong for every reader in another.
 *
 * `endDateExclusive` keeps Google's own semantics rather than silently shifting them: a
 * one-day event on the 18th ends on the 19th.
 */
export interface CalendarEventWhen {
  readonly allDay: boolean;
  /** Instants. Present for a timed event; null for an all-day one. */
  readonly startsAt: Date | null;
  readonly endsAt: Date | null;
  /** `YYYY-MM-DD`. Present for an all-day event; null for a timed one. */
  readonly startDate: string | null;
  /** `YYYY-MM-DD`, EXCLUSIVE, exactly as the provider reports it. */
  readonly endDateExclusive: string | null;
  /** The calendar's own IANA zone where the provider states one. Never the reader's. */
  readonly timeZone: string | null;
}

/** Attendee keys kept per event. A large invitation keeps the first ones the provider lists. */
export const CALENDAR_ATTENDEE_KEY_LIMIT = 50;

/**
 * Who is on it, counted rather than listed.
 *
 * `known: false` means the provider omitted attendees (a large event, or a capped request):
 * the counts are then null, because "I could not count" and "nobody is invited" are different
 * facts and must not render the same.
 *
 * `external` counts attendees whose address is outside the organization's own domains. It is
 * null when the caller supplied no domains to judge against -- an unknowable fact is unknown,
 * not zero.
 */
export interface CalendarAttendance {
  readonly known: boolean;
  readonly total: number | null;
  readonly external: number | null;
  /** Rooms and equipment are not people and are excluded from both counts. */
  readonly resources: number | null;
  /** The connected person's own response, when stated. */
  readonly selfResponse: CalendarResponse | null;
}

/** One event, as Loop understands events. */
export interface CalendarEventFact {
  readonly provider: WorkProvider;
  /** The provider's own id for this event or instance. */
  readonly eventId: string;
  /** The series this is an instance of, when it is one. */
  readonly recurringEventId: string | null;
  readonly isRecurringInstance: boolean;
  /** For an instance, the moment the series said it would start, before any move. */
  readonly originalStartsAt: Date | null;
  readonly status: CalendarEventStatus;
  readonly kind: CalendarEventKind;
  readonly blocking: CalendarTimeBlocking;
  readonly when: CalendarEventWhen;
  /** The event's title. Content: never logged, never sent anywhere it was not needed. */
  readonly summary: string | null;
  /** SHA-256 of the organizer's normalized address. The address itself does not cross this line. */
  readonly organizerHash: string | null;
  readonly organizerIsSelf: boolean;
  /**
   * The same key for each invited PERSON other than the connected one (rooms excluded), in the
   * provider's order, deduplicated, at most `CALENDAR_ATTENDEE_KEY_LIMIT`. Empty when attendance
   * is not known. Keys only: the addresses do not cross this line either.
   */
  readonly attendeeHashes: readonly string[];
  readonly attendance: CalendarAttendance;
  /** Whether a conference is attached at all. Never the joining link. */
  readonly hasConference: boolean;
  /** The provider's own last-modified stamp. */
  readonly providerUpdatedAt: Date | null;
  /** When Loop read it, as against when it changed. */
  readonly observedAt: Date;
}

/** One page of facts, plus the tokens that make the next read cheap. */
export interface CalendarEventPage {
  readonly events: readonly CalendarEventFact[];
  /** Present when the provider stopped early and the caller may continue. */
  readonly nextPageToken: string | null;
  /** Present on the final page: the cursor a later incremental read passes back. */
  readonly nextSyncToken: string | null;
  /** True when the adapter stopped at its own page limit rather than at the end. */
  readonly truncated: boolean;
  /** How many pages were fetched, so a caller can see what a read cost. */
  readonly pagesRead: number;
}

// --- Failure ----------------------------------------------------------------------------------

/**
 * Why a calendar could not be read.
 *
 * "NOTHING SCHEDULED" IS NOT ONE OF THESE. An empty calendar is a successful read with no
 * events; every value here means Loop does not know what is on the calendar, and a surface
 * must say so rather than showing an empty day (§24.1, and attention-state.ts).
 *
 *   NOT_CONNECTED           the person has no Google connection at all.
 *   CAPABILITY_NOT_GRANTED  connected, but Calendar was not among the capabilities granted.
 *   AUTHORIZATION_EXPIRED   the stored grant no longer works; the person must reconnect.
 *   AUTH                    the provider refused the credential (401).
 *   FORBIDDEN               authenticated, and not allowed (403 that is not a rate limit).
 *   RATE_LIMITED            asked to slow down (429, or a 403 naming a rate limit).
 *   CURSOR_EXPIRED          the incremental cursor is too old; a bounded full read is needed.
 *   NETWORK / TIMEOUT       no answer, or not in time.
 *   MALFORMED               a success status carrying something this contract cannot read.
 *   UNAVAILABLE             any other provider failure, including 5xx.
 */
export const CALENDAR_READ_FAILURES = [
  'NOT_CONNECTED',
  'CAPABILITY_NOT_GRANTED',
  'AUTHORIZATION_EXPIRED',
  'AUTH',
  'FORBIDDEN',
  'RATE_LIMITED',
  'CURSOR_EXPIRED',
  'NETWORK',
  'TIMEOUT',
  'MALFORMED',
  'UNAVAILABLE',
] as const;
export type CalendarReadFailure = (typeof CALENDAR_READ_FAILURES)[number];

export type CalendarReadResult =
  | { readonly ok: true; readonly page: CalendarEventPage }
  | { readonly ok: false; readonly failure: CalendarReadFailure };

/**
 * The connection states the database layer reports, mapped to why a read could not happen.
 *
 * It lives here so DL-3 does not invent its own words when `accessToken()` refuses: the three
 * failures an adapter can never observe for itself (there is no connection, the capability was
 * not granted, the grant expired) come from exactly one place.
 */
export function calendarFailureForConnectionState(
  state: 'NOT_CONFIGURED' | 'NOT_PERMITTED' | 'NOT_CONNECTED' | 'INSUFFICIENT_SCOPE' | 'EXPIRED' | 'UNAVAILABLE',
): CalendarReadFailure {
  switch (state) {
    case 'NOT_CONNECTED':
    case 'NOT_CONFIGURED':
    case 'NOT_PERMITTED':
      return 'NOT_CONNECTED';
    case 'INSUFFICIENT_SCOPE':
      return 'CAPABILITY_NOT_GRANTED';
    case 'EXPIRED':
      return 'AUTHORIZATION_EXPIRED';
    default:
      return 'UNAVAILABLE';
  }
}

/**
 * How a read failure is recorded on a sync run (`work_sync_runs.failureClass`, DL-1).
 *
 * The two vocabularies are deliberately different: this one says why a CALENDAR read failed,
 * the other says why a PASS failed, and several calendar failures collapse into one pass
 * outcome. Keeping the mapping here stops each caller inventing its own.
 */
export function workSyncFailureForCalendarFailure(failure: CalendarReadFailure): WorkSyncFailureClass {
  switch (failure) {
    case 'NOT_CONNECTED':
    case 'CAPABILITY_NOT_GRANTED':
    case 'AUTHORIZATION_EXPIRED':
    case 'AUTH':
    case 'FORBIDDEN':
      return 'AUTH';
    case 'RATE_LIMITED':
      return 'RATE_LIMITED';
    case 'CURSOR_EXPIRED':
      return 'CURSOR_EXPIRED';
    case 'NETWORK':
      return 'NETWORK';
    case 'TIMEOUT':
      return 'TIMEOUT';
    case 'MALFORMED':
      return 'MALFORMED';
    default:
      return 'UNAVAILABLE';
  }
}
