// One employee's calendar, synchronized into their own private work state (DL-3).
//
// Architecture: docs/architecture/daily-loop-employee-intelligence.md §8.2, §13.3 and §13.5.
//
// THE FIRST COMPLETE PRIVATE DATA PATH: the employee's own Google connection, through the one
// existing token path, through the DL-2 sensor, into the DL-1 store. It observes and persists.
// It decides nothing -- not what a meeting is about, not whether it matters, not whether the
// person should be there. Those are rules, and rules arrive in DL-8.
//
// WHOSE CALENDAR. Every method takes a `WorkPrincipal`, the connection is read for THAT
// principal, and the rows are written for THAT principal. There is no path here that takes an
// organization and a user from different places: the Google account and the work state are the
// same person by construction, and no role -- OWNER or ADMIN included -- can point this at
// somebody else's calendar.
//
// A FAILED READ IS NEVER AN EMPTY CALENDAR. Every refusal keeps its class, is recorded on the
// run and on the cursor, and leaves the stored events exactly as they were. "Nothing is
// scheduled" and "Loop could not read your calendar" are different facts and never collapse.
//
// IDEMPOTENT BY PROVIDER KEY. Every write is an upsert on (organization, user, provider,
// eventId), so running this twice changes nothing the second time, and a truncated read simply
// re-reads on the next pass.
//
// GOOGLE, THE CLOCK AND THE SENSOR ARE INJECTED. This file holds no credential, builds no
// request and knows no Google field name.

import {
  calendarFailureForConnectionState,
  workSyncFailureForCalendarFailure,
  type CalendarEventFact,
  type CalendarReadFailure,
  type CalendarReadResult,
} from '@emgloop/shared';

import type { WorkGraphRepository, EventFacts } from '../../repositories/work-state/work-graph.repository';
import type { WorkSourceRepository } from '../../repositories/work-state/work-source.repository';
import type { WorkPrincipal } from '../../repositories/work-state/work-principal';

/** The bounded first window (§8.2): a week behind, a month ahead. Never an unbounded crawl. */
export const CALENDAR_LOOKBACK_DAYS = 7;
export const CALENDAR_LOOKAHEAD_DAYS = 30;

/** An access token for one principal's OWN connection, or why there is none. */
export interface CalendarAccessPort {
  accessToken(principal: WorkPrincipal): Promise<{ readonly ok: true; readonly accessToken: string } | { readonly ok: false; readonly state: CalendarConnectionState }>;
  /**
   * The facts needed to count attendance honestly: the connected account's own address, and
   * the domains that count as internal. Empty domains make external attendance UNKNOWN rather
   * than zero.
   */
  identity(principal: WorkPrincipal): Promise<{ readonly selfAddress: string | null; readonly internalDomains: readonly string[] }>;
}

export type CalendarConnectionState = 'NOT_CONFIGURED' | 'NOT_PERMITTED' | 'NOT_CONNECTED' | 'INSUFFICIENT_SCOPE' | 'EXPIRED' | 'UNAVAILABLE';

/** The DL-2 sensor, as this service needs it. The web tier binds the real adapter. */
export interface CalendarSensorPort {
  readWindow(request: {
    readonly accessToken: string;
    readonly timeMin: Date;
    readonly timeMax: Date;
    readonly observedAt: Date;
    readonly selfAddress: string | null;
    readonly internalDomains: readonly string[];
  }): Promise<CalendarReadResult>;
  readChanges(request: {
    readonly accessToken: string;
    readonly syncToken: string;
    readonly observedAt: Date;
    readonly selfAddress: string | null;
    readonly internalDomains: readonly string[];
  }): Promise<CalendarReadResult>;
}

export interface CalendarSyncDeps {
  readonly sources: WorkSourceRepository;
  readonly graph: WorkGraphRepository;
  readonly access: CalendarAccessPort;
  readonly sensor: CalendarSensorPort;
  readonly now?: () => Date;
  readonly lookbackDays?: number;
  readonly lookaheadDays?: number;
}

/**
 * How a pass went.
 *
 *   WINDOW        the bounded first read, because there was no cursor.
 *   INCREMENTAL   changes since the stored cursor.
 *   REBASELINE    ONE bounded window was read again although a cursor existed -- because Google
 *                 had forgotten it (410), or because the caller asked for a fresh baseline.
 */
export type CalendarSyncMode = 'WINDOW' | 'INCREMENTAL' | 'REBASELINE';

/**
 * How this pass should read.
 *
 * `baseline` asks for a bounded window read even though a usable cursor exists. IT IS NOT AN
 * OPTIMIZATION, IT IS A CORRECTION: a Google sync token inherits the window that minted it, so a
 * cursor kept alive for months keeps reporting against a `timeMax` that is months in the past,
 * and events scheduled beyond that horizon never arrive. Re-reading the rolling window replaces
 * the token with one whose horizon starts from today (§8.2, and the DL-5 follow-up recorded in
 * #292). The scheduled cycle asks for it on its own cadence; nothing else does.
 */
export interface CalendarSyncOptions {
  readonly baseline?: boolean;
}

export interface CalendarSyncOutcome {
  readonly outcome: 'SUCCEEDED' | 'TRUNCATED' | 'FAILED';
  readonly mode: CalendarSyncMode;
  /** Events the provider returned, and rows written. Equal unless an event was unreadable. */
  readonly examined: number;
  readonly written: number;
  /** Present only when the pass failed. A class -- never Google's text. */
  readonly failure: CalendarReadFailure | null;
  /** True when a fresh cursor was stored, so the next pass is incremental. */
  readonly cursorAdvanced: boolean;
}

/** A calendar fact, as the DL-1 store holds it. The only place the two shapes meet. */
export function eventFactsFor(fact: CalendarEventFact): EventFacts {
  return {
    provider: fact.provider,
    eventId: fact.eventId,
    recurringEventId: fact.recurringEventId,
    originalStartsAt: fact.originalStartsAt,
    // A timed event keeps its instants; an all-day event keeps its dates and its calendar's
    // zone, and neither is derived from the other. Inventing a UTC midnight here would bake
    // one reader's zone into a stored fact (DL-2, and the Loop Time Authority).
    startsAt: fact.when.allDay ? null : fact.when.startsAt,
    endsAt: fact.when.allDay ? null : fact.when.endsAt,
    allDay: fact.when.allDay,
    startDate: fact.when.startDate ? new Date(`${fact.when.startDate}T00:00:00.000Z`) : null,
    endDateExclusive: fact.when.endDateExclusive ? new Date(`${fact.when.endDateExclusive}T00:00:00.000Z`) : null,
    eventTimeZone: fact.when.timeZone,
    status: fact.status,
    kind: fact.kind,
    blocking: fact.blocking,
    summary: fact.summary,
    organizerHash: fact.organizerHash,
    organizerIsSelf: fact.organizerIsSelf,
    attendeeHashes: fact.attendance.known ? fact.attendeeHashes : [],
    attendanceKnown: fact.attendance.known,
    attendeeCount: fact.attendance.total,
    externalAttendeeCount: fact.attendance.external,
    selfResponse: fact.attendance.selfResponse,
    hasConference: fact.hasConference,
    providerUpdatedAt: fact.providerUpdatedAt,
    observedAt: fact.observedAt,
  };
}

export class CalendarSyncService {
  constructor(private readonly deps: CalendarSyncDeps) {}

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }

  /** The bounded window: the same one every time, so a re-baseline cannot become a crawl. */
  private window(now: Date): { readonly timeMin: Date; readonly timeMax: Date } {
    const day = 86_400_000;
    return {
      timeMin: new Date(now.getTime() - (this.deps.lookbackDays ?? CALENDAR_LOOKBACK_DAYS) * day),
      timeMax: new Date(now.getTime() + (this.deps.lookaheadDays ?? CALENDAR_LOOKAHEAD_DAYS) * day),
    };
  }

  /**
   * Synchronize ONE employee's calendar into their own work state.
   *
   * The principal is the whole authorization: the token is fetched for it, and the rows are
   * written for it. Nothing in the call can name a different person.
   */
  async syncCalendar(principal: WorkPrincipal, options: CalendarSyncOptions = {}): Promise<CalendarSyncOutcome> {
    const startedAt = this.now();
    const run = await this.deps.sources.startRun(principal, 'CALENDAR', startedAt);

    const token = await this.deps.access.accessToken(principal);
    if (!token.ok) {
      // No connection, no Calendar capability, or a grant that no longer works. Each keeps its
      // own class, and none of them is an empty calendar.
      return this.fail(principal, run.id, 'WINDOW', calendarFailureForConnectionState(token.state));
    }

    const identity = await this.deps.access.identity(principal);
    const cursor = await this.deps.sources.cursor(principal, 'CALENDAR');
    const storedToken = cursor?.cursorKind === 'CALENDAR_SYNC_TOKEN' ? cursor.cursor : null;
    // A requested baseline sets the stored token aside for this pass. It is NOT deleted: the
    // cursor is only ever replaced by a read that actually succeeded, so a failed baseline
    // leaves the employee on the incremental path they were already on.
    const readToken = options.baseline ? null : storedToken;
    const observedAt = this.now();

    // Re-reading the window while a cursor exists is a REBASELINE whoever asked for it; reading
    // it with no cursor at all is still the first WINDOW.
    let mode: CalendarSyncMode = readToken ? 'INCREMENTAL' : storedToken ? 'REBASELINE' : 'WINDOW';
    let result: CalendarReadResult = readToken
      ? await this.deps.sensor.readChanges({ accessToken: token.accessToken, syncToken: readToken, observedAt, ...identity })
      : await this.deps.sensor.readWindow({ accessToken: token.accessToken, ...this.window(observedAt), observedAt, ...identity });

    if (!result.ok && result.failure === 'CURSOR_EXPIRED') {
      // Google forgot the cursor. The architecture's answer is ONE bounded window read -- the
      // same window as the first pass -- and never a walk back through the calendar's history.
      // One retry, because this branch is only reachable from the incremental read above.
      mode = 'REBASELINE';
      result = await this.deps.sensor.readWindow({ accessToken: token.accessToken, ...this.window(observedAt), observedAt, ...identity });
    }

    if (!result.ok) return this.fail(principal, run.id, mode, result.failure);

    // Persist every fact, cancellations included: a cancelled event is how a meeting leaves the
    // day, and deleting the row would make the history ambiguous.
    let written = 0;
    for (const fact of result.page.events) {
      await this.deps.graph.upsertEvent(principal, eventFactsFor(fact));
      written += 1;
    }

    const finishedAt = this.now();
    const truncated = result.page.truncated;
    // A cursor is stored ONLY for a complete read: a truncated pass has no `nextSyncToken` to
    // store, and the next pass re-reads the same window, which is safe because every write is
    // an upsert.
    const advance = !truncated && result.page.nextSyncToken !== null;
    if (advance) {
      await this.deps.sources.advanceCursor(principal, 'CALENDAR', {
        cursor: result.page.nextSyncToken,
        cursorKind: 'CALENDAR_SYNC_TOKEN',
        startedAt,
        completedAt: finishedAt,
        failureClass: null,
      });
    } else {
      await this.deps.sources.advanceCursor(principal, 'CALENDAR', { startedAt, completedAt: finishedAt, failureClass: null });
    }

    await this.deps.sources.finishRun(principal, run.id, {
      finishedAt,
      outcome: truncated ? 'TRUNCATED' : 'SUCCEEDED',
      examined: result.page.events.length,
      written,
    });

    return {
      outcome: truncated ? 'TRUNCATED' : 'SUCCEEDED',
      mode,
      examined: result.page.events.length,
      written,
      failure: null,
      cursorAdvanced: advance,
    };
  }

  /**
   * Record a failed pass, on the run and on the cursor, and change nothing that was stored.
   * The cursor itself is never cleared by a failure: a rebaseline replaces it with a fresh one
   * only when a read actually succeeded.
   */
  private async fail(principal: WorkPrincipal, runId: string, mode: CalendarSyncMode, failure: CalendarReadFailure): Promise<CalendarSyncOutcome> {
    const finishedAt = this.now();
    const failureClass = workSyncFailureForCalendarFailure(failure);
    await this.deps.sources.advanceCursor(principal, 'CALENDAR', { failureClass });
    await this.deps.sources.finishRun(principal, runId, { finishedAt, outcome: 'FAILED', failureClass });
    return { outcome: 'FAILED', mode, examined: 0, written: 0, failure, cursorAdvanced: false };
  }
}
