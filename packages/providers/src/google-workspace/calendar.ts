// Google Calendar as a SENSOR: bounded reads, normalized into Loop's own facts.
//
// Architecture: docs/architecture/daily-loop-employee-intelligence.md §8 and §13.3 (slice DL-2).
// Verified against Google's documentation on 2026-09-17:
//   - events.list: developers.google.com/workspace/calendar/api/v3/reference/events/list
//   - the Events resource: .../api/v3/reference/events
//   - incremental sync: developers.google.com/workspace/calendar/api/guides/sync
//
// A SENSOR OBSERVES AND EMITS FACTS. NOTHING ELSE (boundaries.md). This file scores nothing,
// ranks nothing, decides nothing about what a meeting means, and stores nothing: it turns one
// bounded page of Google's answer into `CalendarEventFact`s and hands them back. Whether a
// meeting matters is a rule, and rules arrive later.
//
// WHAT IT DOES NOT HOLD. No client id, no secret, no refresh token, no connection, no
// database. The caller passes an access token it obtained through the ONE existing path
// (`GoogleWorkspaceService.accessToken`), and the network is injected, so every request shape
// is tested without a live call.
//
// THE SCOPE IS UNCHANGED. `calendar.events.readonly` authorizes `events.list`, which Google's
// reference lists explicitly. Loop does not hold `calendar.calendarlist.readonly`, so this
// reads the PRIMARY calendar and nothing else -- which is what "today and tomorrow" means for
// an employee (§8.1).
//
// NOTHING SENSITIVE LEAVES THROUGH A FAILURE OR A LOG. A failure is a CLASS. The access token,
// Google's error text, an event description, a location, an attachment and an attendee's
// address never appear in a returned value, a thrown error or a log line here. Attendees are
// COUNTED and the organizer is HASHED; the addresses do not cross this boundary.

import { createHash } from 'crypto';
import {
  CALENDAR_EVENT_KINDS,
  type CalendarAttendance,
  type CalendarEventFact,
  type CalendarEventKind,
  type CalendarEventPage,
  type CalendarEventStatus,
  type CalendarEventWhen,
  type CalendarReadFailure,
  type CalendarReadResult,
  type CalendarResponse,
} from '@emgloop/shared';

import { GOOGLE_OAUTH_TIMEOUT_MS } from './oauth';

/** The primary calendar, and only it: Loop holds no scope to list a person's other calendars. */
export const GOOGLE_CALENDAR_EVENTS_ENDPOINT = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';

/** Google's own default is 250 and its maximum 2500. Loop asks for 250 and never more than 2500. */
export const GOOGLE_CALENDAR_PAGE_SIZE = 250;
export const GOOGLE_CALENDAR_MAX_PAGE_SIZE = 2500;

/**
 * How many pages one read may follow. A read is BOUNDED: with the default page size this is
 * 2,500 events, after which the result says `truncated` and hands back a page token rather
 * than walking a calendar forever.
 */
export const GOOGLE_CALENDAR_MAX_PAGES = 10;

type CalendarFetch = (
  input: string,
  init: { method: 'GET'; headers: Record<string, string>; signal?: AbortSignal },
) => Promise<{ status: number; json(): Promise<unknown> }>;

/** The organization's own domains, so "external" is a fact rather than a guess. */
export interface CalendarIdentityContext {
  /** The connected account's own address. Used for `self` facts and excluded from counts. */
  readonly selfAddress?: string | null;
  /**
   * Lower-case domains that count as internal. Empty or absent means external attendance is
   * UNKNOWABLE, and the fact is reported null rather than as zero.
   */
  readonly internalDomains?: readonly string[];
}

interface CalendarCallOptions extends CalendarIdentityContext {
  readonly fetchImpl: CalendarFetch;
  /** An access token for THIS employee's connection. Never stored, never logged. */
  readonly accessToken: string;
  readonly observedAt: Date;
  readonly timeoutMs?: number;
  readonly pageSize?: number;
  readonly maxPages?: number;
  /**
   * Cancelled events are part of the truth: a meeting called off must leave the day. The value
   * is part of the sync configuration and MUST match between the first read and every
   * incremental read that follows it (Google rejects a changed parameter set).
   */
  readonly showDeleted?: boolean;
  /** Continue a read that stopped at the page limit. */
  readonly pageToken?: string | null;
}

/** A first, bounded read: an explicit window, expanded to instances, oldest first. */
export interface CalendarWindowRequest extends CalendarCallOptions {
  readonly timeMin: Date;
  readonly timeMax: Date;
}

/** Every change since a cursor. Google forbids a time window here, and returns deletions. */
export interface CalendarChangesRequest extends CalendarCallOptions {
  readonly syncToken: string;
}

/** SHA-256 of a normalized address: the stable key DL-1 stores, with the address left behind. */
export function googleCalendarAddressHash(address: string): string {
  return createHash('sha256').update(address.trim().toLowerCase()).digest('hex');
}

function domainOf(address: string): string | null {
  const at = address.lastIndexOf('@');
  if (at < 0 || at === address.length - 1) return null;
  return address.slice(at + 1).trim().toLowerCase();
}

const STATUS: Record<string, CalendarEventStatus> = { confirmed: 'CONFIRMED', tentative: 'TENTATIVE', cancelled: 'CANCELLED' };
const KIND: Record<string, CalendarEventKind> = {
  default: 'DEFAULT',
  outOfOffice: 'OUT_OF_OFFICE',
  focusTime: 'FOCUS_TIME',
  workingLocation: 'WORKING_LOCATION',
  birthday: 'BIRTHDAY',
  fromGmail: 'FROM_GMAIL',
};
const RESPONSE: Record<string, CalendarResponse> = {
  accepted: 'ACCEPTED',
  declined: 'DECLINED',
  tentative: 'TENTATIVE',
  needsAction: 'NEEDS_ACTION',
};

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function instant(value: unknown): Date | null {
  if (typeof value !== 'string' || value === '') return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * When an event happens, in the provider's own terms.
 *
 * An all-day event carries DATES and no instant, because a date is not a moment until somebody
 * says whose day it is (§8.3 and the Loop Time Authority). A timed event carries instants: its
 * `dateTime` is RFC3339 with an offset, so the moment is unambiguous whatever zone the reader
 * is in, and a daylight-saving transition is already resolved inside it.
 */
function when(raw: Record<string, unknown>): CalendarEventWhen | null {
  const start = (raw.start ?? {}) as Record<string, unknown>;
  const end = (raw.end ?? {}) as Record<string, unknown>;
  const startDate = typeof start.date === 'string' && DATE_ONLY.test(start.date) ? start.date : null;
  const endDate = typeof end.date === 'string' && DATE_ONLY.test(end.date) ? end.date : null;
  const timeZone = typeof start.timeZone === 'string' && start.timeZone !== '' ? start.timeZone : null;

  if (startDate) {
    return { allDay: true, startsAt: null, endsAt: null, startDate, endDateExclusive: endDate, timeZone };
  }
  const startsAt = instant(start.dateTime);
  if (!startsAt) return null; // Neither a date nor a readable instant: not an event this contract can state.
  return { allDay: false, startsAt, endsAt: instant(end.dateTime), startDate: null, endDateExclusive: null, timeZone };
}

/**
 * Who is on it, counted.
 *
 * `attendeesOmitted` means Google did not send the list, so the counts are UNKNOWN -- not zero.
 * Resources (rooms, equipment) are not people and are excluded. External attendance is only a
 * fact when the caller said which domains are internal; otherwise it is null.
 */
function attendance(raw: Record<string, unknown>, context: CalendarIdentityContext): CalendarAttendance {
  const omitted = raw.attendeesOmitted === true;
  const list = Array.isArray(raw.attendees) ? (raw.attendees as Record<string, unknown>[]) : null;
  const selfResponseOf = (entries: Record<string, unknown>[]): CalendarResponse | null => {
    const mine = entries.find((a) => a.self === true);
    const status = typeof mine?.responseStatus === 'string' ? RESPONSE[mine.responseStatus] : undefined;
    return status ?? null;
  };

  if (omitted || !list) {
    return { known: false, total: null, external: null, resources: null, selfResponse: list ? selfResponseOf(list) : null };
  }

  const internal = (context.internalDomains ?? []).map((d) => d.trim().toLowerCase()).filter((d) => d !== '');
  let resources = 0;
  let people = 0;
  let external = 0;
  let externalKnowable = internal.length > 0;

  for (const attendee of list) {
    if (attendee.resource === true) {
      resources += 1;
      continue;
    }
    people += 1;
    const address = typeof attendee.email === 'string' ? attendee.email : null;
    if (!externalKnowable) continue;
    if (!address) {
      // An attendee Google named without an address cannot be placed inside or outside.
      externalKnowable = false;
      continue;
    }
    const domain = domainOf(address);
    if (!domain) {
      externalKnowable = false;
      continue;
    }
    if (!internal.includes(domain)) external += 1;
  }

  return {
    known: true,
    total: people,
    external: externalKnowable ? external : null,
    resources,
    selfResponse: selfResponseOf(list),
  };
}

/** One Google event, as a Loop fact. Null when the payload is not an event this contract can state. */
export function normalizeGoogleCalendarEvent(
  raw: unknown,
  context: CalendarIdentityContext & { readonly observedAt: Date },
): CalendarEventFact | null {
  if (!raw || typeof raw !== 'object') return null;
  const event = raw as Record<string, unknown>;
  const eventId = typeof event.id === 'string' && event.id !== '' ? event.id : null;
  if (!eventId) return null;

  const status = typeof event.status === 'string' ? STATUS[event.status] : undefined;
  // A cancelled instance arrives with no start at all; that is still a fact worth reporting,
  // because it is how a meeting leaves the day.
  const timing = when(event);
  if (!timing && status !== 'CANCELLED') return null;

  const organizer = (event.organizer ?? {}) as Record<string, unknown>;
  const organizerAddress = typeof organizer.email === 'string' && organizer.email !== '' ? organizer.email : null;
  const selfAddress = context.selfAddress ? context.selfAddress.trim().toLowerCase() : null;
  const kindWord = typeof event.eventType === 'string' ? event.eventType : 'default';
  const kind = KIND[kindWord] ?? 'OTHER';

  return {
    provider: 'GOOGLE',
    eventId,
    recurringEventId: typeof event.recurringEventId === 'string' && event.recurringEventId !== '' ? event.recurringEventId : null,
    isRecurringInstance: typeof event.recurringEventId === 'string' && event.recurringEventId !== '',
    originalStartsAt: instant(((event.originalStartTime ?? {}) as Record<string, unknown>).dateTime),
    status: status ?? 'CONFIRMED',
    kind: (CALENDAR_EVENT_KINDS as readonly string[]).includes(kind) ? kind : 'OTHER',
    blocking: event.transparency === 'transparent' ? 'FREE' : 'BLOCKING',
    when: timing ?? { allDay: false, startsAt: null, endsAt: null, startDate: null, endDateExclusive: null, timeZone: null },
    summary: typeof event.summary === 'string' && event.summary !== '' ? event.summary : null,
    organizerHash: organizerAddress ? googleCalendarAddressHash(organizerAddress) : null,
    organizerIsSelf:
      organizer.self === true || (organizerAddress !== null && selfAddress !== null && organizerAddress.trim().toLowerCase() === selfAddress),
    attendance: attendance(event, context),
    // Whether a conference EXISTS. The joining link is not a fact Daily Loop needs.
    hasConference: Boolean(event.conferenceData) || (typeof event.hangoutLink === 'string' && event.hangoutLink !== ''),
    providerUpdatedAt: instant(event.updated),
    observedAt: context.observedAt,
  };
}

function failureForStatus(status: number, payload: unknown): CalendarReadFailure {
  const error = payload && typeof payload === 'object' ? ((payload as { error?: unknown }).error as Record<string, unknown> | undefined) : undefined;
  const reasons = Array.isArray(error?.errors)
    ? (error!.errors as Record<string, unknown>[]).map((e) => (typeof e.reason === 'string' ? e.reason : '')).filter((r) => r !== '')
    : [];
  const rateLimited = reasons.some((r) => r === 'rateLimitExceeded' || r === 'userRateLimitExceeded' || r === 'quotaExceeded');
  if (status === 401) return 'AUTH';
  // A 403 is two different things: "slow down" and "you may not". Google says which.
  if (status === 403) return rateLimited ? 'RATE_LIMITED' : 'FORBIDDEN';
  if (status === 410) return 'CURSOR_EXPIRED';
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 500) return 'UNAVAILABLE';
  return 'UNAVAILABLE';
}

async function requestPage(
  options: CalendarCallOptions,
  params: URLSearchParams,
): Promise<{ readonly ok: true; readonly payload: Record<string, unknown> } | { readonly ok: false; readonly failure: CalendarReadFailure }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? GOOGLE_OAUTH_TIMEOUT_MS);
  try {
    const response = await options.fetchImpl(`${GOOGLE_CALENDAR_EVENTS_ENDPOINT}?${params.toString()}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${options.accessToken}`, accept: 'application/json' },
      signal: controller.signal,
    });
    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (response.status !== 200) return { ok: false, failure: failureForStatus(response.status, payload) };
    if (!payload || typeof payload !== 'object' || !Array.isArray((payload as { items?: unknown }).items)) {
      return { ok: false, failure: 'MALFORMED' };
    }
    return { ok: true, payload: payload as Record<string, unknown> };
  } catch {
    return { ok: false, failure: controller.signal.aborted ? 'TIMEOUT' : 'NETWORK' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Follow pages until Google stops, or until the page limit -- whichever comes first. Stopping
 * at the limit is reported (`truncated`, with the token to continue), never silently dropped:
 * a short answer that looks complete is how a day view loses a meeting.
 */
async function readPages(options: CalendarCallOptions, base: () => URLSearchParams): Promise<CalendarReadResult> {
  const maxPages = Math.max(1, options.maxPages ?? GOOGLE_CALENDAR_MAX_PAGES);
  const events: CalendarEventFact[] = [];
  let pageToken: string | null = options.pageToken ?? null;
  let nextSyncToken: string | null = null;
  let pagesRead = 0;

  while (pagesRead < maxPages) {
    const params = base();
    if (pageToken) params.set('pageToken', pageToken);
    const page = await requestPage(options, params);
    if (!page.ok) return { ok: false, failure: page.failure };
    pagesRead += 1;

    for (const item of page.payload.items as unknown[]) {
      const fact = normalizeGoogleCalendarEvent(item, { ...options, observedAt: options.observedAt });
      // An item this contract cannot state is skipped rather than half-guessed.
      if (fact) events.push(fact);
    }

    const next = typeof page.payload.nextPageToken === 'string' && page.payload.nextPageToken !== '' ? page.payload.nextPageToken : null;
    nextSyncToken = typeof page.payload.nextSyncToken === 'string' && page.payload.nextSyncToken !== '' ? page.payload.nextSyncToken : null;
    pageToken = next;
    if (!next) break;
  }

  return {
    ok: true,
    page: { events, nextPageToken: pageToken, nextSyncToken, truncated: pageToken !== null, pagesRead },
  };
}

function pageSizeOf(options: CalendarCallOptions): string {
  return String(Math.min(Math.max(options.pageSize ?? GOOGLE_CALENDAR_PAGE_SIZE, 1), GOOGLE_CALENDAR_MAX_PAGE_SIZE));
}

/**
 * The first read: one explicit window of the primary calendar, AND the read that has to come
 * back with a sync token, because every later read depends on one.
 *
 * `singleEvents=true` expands a recurring event into the instances a person actually has,
 * which is what a day is made of.
 *
 * THERE IS DELIBERATELY NO `orderBy`. Google's events.list reference lists the parameters that
 * cannot be combined with a sync token -- `iCalUID`, `orderBy`, `privateExtendedProperty`, `q`,
 * `sharedExtendedProperty`, `timeMin`, `timeMax`, `updatedMin` -- and a request carrying one it
 * cannot replay incrementally is answered WITHOUT a `nextSyncToken`. `timeMin` and `timeMax`
 * are the documented exception: the sync guide's own sample limits a full sync by date range
 * and still receives a token. `orderBy` is not, so asking for sorted results silently cost the
 * cursor, and every pass re-read the whole window instead of the changes (first seen in
 * production on 2026-09-17: two identical WINDOW syncs in a row).
 *
 * NOTHING NEEDED THE SORT. Events are stored and later read back ordered by their own start
 * time, so ordering here bought nothing -- except that a truncated read is now an arbitrary
 * subset of the window rather than its earliest events. That is acceptable because a truncated
 * pass stores no cursor and re-reads next time, and because 10 pages of 250 is 2,500 events
 * inside a 37-day window.
 */
export function readGoogleCalendarWindow(request: CalendarWindowRequest): Promise<CalendarReadResult> {
  if (!(request.timeMax > request.timeMin)) {
    return Promise.resolve({ ok: false, failure: 'MALFORMED' });
  }
  return readPages(request, () => {
    const params = new URLSearchParams({
      singleEvents: 'true',
      maxResults: pageSizeOf(request),
      timeMin: request.timeMin.toISOString(),
      timeMax: request.timeMax.toISOString(),
      showDeleted: String(request.showDeleted ?? true),
    });
    return params;
  });
}

/**
 * Every change since a cursor.
 *
 * GOOGLE FORBIDS A TIME WINDOW HERE: `syncToken` may not be combined with `timeMin`, `timeMax`
 * or `orderBy`, and the parameter set must otherwise match the read that produced the token --
 * which is why `singleEvents` and `showDeleted` are configured the same way in both calls. An
 * expired token answers 410, which is `CURSOR_EXPIRED`: the caller does a bounded window read
 * again rather than guessing what it missed.
 */
export function readGoogleCalendarChanges(request: CalendarChangesRequest): Promise<CalendarReadResult> {
  return readPages(request, () =>
    new URLSearchParams({
      singleEvents: 'true',
      maxResults: pageSizeOf(request),
      showDeleted: String(request.showDeleted ?? true),
      syncToken: request.syncToken,
    }),
  );
}
