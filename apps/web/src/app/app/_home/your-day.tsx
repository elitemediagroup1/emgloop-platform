// YOUR DAY -- the first employee-facing Daily Loop surface (DL-4).
//
// Architecture: docs/architecture/daily-loop-employee-intelligence.md 5.2, 8.4, 22.4.
//
// WHAT THIS IS, AND IS NOT. It is the answer to "what does my day look like, what is next, and is
// Loop current" -- read in seconds, at the top of Home. It is not a calendar: there is no grid, no
// month, no colour-coded event types, and no attempt to reproduce Google Calendar inside Loop.
//
// IT IS READ IN ONE ORDER, AND SAYS SO. How current Loop is, then what the employee is walking
// into, then today, then tomorrow. Each of those is a named section rather than another sentence
// in a paragraph, because a day that reads as one block is a day nobody reads.
//
// EVERY SENTENCE HERE IS PROVABLE FROM A STORED ROW. Counts come from rows, times from instants
// the provider gave, "your afternoon is clear" from the absence of a blocking event between two
// wall-clock hours. Nothing states what a meeting is for, whether it matters, or whether the
// employee should prepare -- Loop does not know any of that yet, and pretending would cost the
// trust the surface exists to build.
//
// AN EMPTY DAY AND AN UNREADABLE ONE NEVER LOOK ALIKE. Two different facts decide the words: has
// Loop ever completed a read (is there a picture at all), and is that read current enough to speak
// in the present tense. A state where Loop has no read shows no schedule and says which state it
// is; a read Loop cannot refresh shows what it last saw and never calls an empty day clear.
//
// Drawn with the Loop design system's shared primitives and its existing Home classes. The layout
// rules this surface needed live in the one Loop stylesheet under YOUR DAY, with no new token.

import { CONNECTIONS_PATH } from '../../../auth/landing';
import { FRESHNESS_ADMITS_EMPTY, createTimeView, type DayEvent, type TimeView } from '@emgloop/shared';
import type { YourDayView } from '../../../daily-loop/your-day';
import { Panel, StateBlock } from '../_loop-os/record';

// --- Words, and the facts behind each one --------------------------------------------------------

/** How many people, when the provider said. Silence when it did not: a count we lack is not zero. */
function attendance(event: DayEvent): string | null {
  if (!event.attendanceKnown || event.attendeeCount === null) return null;
  if (event.attendeeCount === 0) return null;
  const people = `${event.attendeeCount} ${event.attendeeCount === 1 ? 'person' : 'people'}`;
  return event.externalAttendeeCount !== null && event.externalAttendeeCount > 0 ? `${people} · external` : people;
}

/** The facts beside an event, each one a stored column. No location, no link, no attendee names. */
function eventFacts(event: DayEvent): string[] {
  const facts: string[] = [];
  const people = attendance(event);
  if (people) facts.push(people);
  if (event.hasConference) facts.push('video call');
  if (event.recurringEventId) facts.push('recurring');
  if (event.blocking === 'FREE') facts.push('not blocking time');
  if (event.kind === 'OUT_OF_OFFICE') facts.push('out of office');
  if (event.kind === 'FOCUS_TIME') facts.push('focus time');
  return facts;
}

/** How long until it starts, while that is still a useful thing to say. */
function until(minutes: number): string | null {
  if (minutes > 120) return null;
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `in ${hours} hr` : `in ${hours} hr ${rest} min`;
}

function EventRow({ event, time, emphasis }: { event: DayEvent; time: TimeView; emphasis?: boolean }) {
  const facts = eventFacts(event);
  return (
    <li className="loop-home__item">
      <span className={'loop-home__dot' + (emphasis ? ' loop-home__dot--info' : '')} aria-hidden="true" />
      <span className="loop-home__item-text">
        <span className={emphasis ? 'val' : undefined}>{event.summary ?? 'Untitled event'}</span>
        {facts.length > 0 ? <span className="muted"> · {facts.join(' · ')}</span> : null}
      </span>
      <span className="loop-home__item-time">
        {event.allDay ? (
          'All day'
        ) : (
          <time dateTime={time.iso(event.startsAt!)}>
            {time.time(event.startsAt!)}
            {event.endsAt ? `–${time.time(event.endsAt)}` : ''}
          </time>
        )}
      </span>
    </li>
  );
}

/**
 * What is true about the rest of today.
 *
 * `current` is the difference between a day Loop can describe in the present tense and a day Loop
 * last saw some time ago: only the first may call an empty calendar clear.
 */
function todayLine(view: YourDayView, time: TimeView, current: boolean): string {
  const { summary } = view;
  if (summary.total === 0) {
    return current ? 'Your calendar is clear today.' : 'Nothing was scheduled when Loop last read your calendar.';
  }

  const parts: string[] = [];
  const counted = summary.timedCount > 0 ? `${summary.timedCount} ${summary.timedCount === 1 ? 'event' : 'events'}` : null;
  if (counted && summary.firstStart && summary.lastEnd) {
    parts.push(`${counted} today, ${time.time(summary.firstStart)} to ${time.time(summary.lastEnd)}.`);
  } else if (counted) {
    parts.push(`${counted} today.`);
  }
  if (summary.allDayCount > 0) {
    parts.push(`${summary.allDayCount} all-day ${summary.allDayCount === 1 ? 'entry' : 'entries'}.`);
  }
  // Only worth saying about a day that has something in it.
  if (summary.afternoonClear === true && summary.timedCount > 0) parts.push('Your afternoon is clear.');
  else if (summary.morningClear === true && summary.timedCount > 0) parts.push('Your morning is clear.');
  if (summary.cancelledCount > 0) {
    parts.push(`${summary.cancelledCount} ${summary.cancelledCount === 1 ? 'event was' : 'events were'} cancelled.`);
  }
  if (summary.declinedCount > 0) {
    parts.push(`${summary.declinedCount} you declined ${summary.declinedCount === 1 ? 'is' : 'are'} not shown.`);
  }
  return parts.join(' ');
}

function tomorrowLine(view: YourDayView, time: TimeView, current: boolean): string {
  const { tomorrowSummary: s, tomorrowSchedule } = view;
  if (s.total === 0) {
    return current ? 'Nothing scheduled tomorrow.' : 'Nothing was scheduled for tomorrow when Loop last read your calendar.';
  }
  const first = tomorrowSchedule.timed[0];
  const counted = `${s.total} ${s.total === 1 ? 'event' : 'events'}`;
  if (first?.startsAt) return `${counted} tomorrow, starting at ${time.time(first.startsAt)}.`;
  if (s.allDayCount > 0) return `${counted} tomorrow, all-day.`;
  return `${counted} tomorrow.`;
}

/** How current the picture is, and -- where there is one -- the way back. */
function currency(view: YourDayView, time: TimeView): { line: string; href?: string; action?: string } {
  switch (view.freshness) {
    case 'CURRENT':
      return { line: view.lastSyncedAt ? `Loop read your calendar ${time.relative(view.lastSyncedAt)}.` : 'Loop read your calendar just now.' };
    case 'STALE':
      return { line: `Loop last read your calendar ${time.relative(view.lastSyncedAt!)}.` };
    case 'NEVER_SYNCED':
      return { line: 'Loop has not read your calendar yet.' };
    case 'SYNC_FAILED':
      return {
        line: view.lastSyncedAt
          ? `Loop could not reach Google just now. This is your calendar as Loop last read it, ${time.relative(view.lastSyncedAt)}.`
          : 'Loop could not reach Google, and has not read your calendar yet.',
      };
    case 'AUTHORIZATION_EXPIRED':
      return { line: 'Google no longer accepts this connection. Reconnect to see your day.', href: CONNECTIONS_PATH, action: 'Reconnect' };
    case 'CAPABILITY_NOT_GRANTED':
      return { line: 'Calendar is not connected yet.', href: CONNECTIONS_PATH, action: 'Connect Calendar' };
    default:
      return { line: 'Connect your Google Calendar and Loop will show your day.', href: CONNECTIONS_PATH, action: 'Connect Calendar' };
  }
}

// --- UP NEXT ---------------------------------------------------------------------------------------

/**
 * The one thing the employee is walking into, given the most weight on the surface.
 *
 * It is a fact about stored rows and the current instant, never a judgement: Loop says what is
 * running and what starts next, and nothing about whether either matters.
 */
function UpNext({ view, time, current }: { view: YourDayView; time: TimeView; current: boolean }) {
  const { inProgress, next, minutesUntilNext } = view.position;

  if (inProgress) {
    const facts = eventFacts(inProgress);
    return (
      <div className="loop-day__next">
        <p className="loop-eyebrow">Happening now</p>
        <p className="loop-day__title">{inProgress.summary ?? 'Untitled event'}</p>
        <p className="loop-day__when">
          {inProgress.endsAt ? (
            <>Until <time dateTime={time.iso(inProgress.endsAt)}>{time.time(inProgress.endsAt)}</time></>
          ) : (
            'In progress'
          )}
          {facts.length > 0 ? ` · ${facts.join(' · ')}` : null}
          {next?.startsAt ? (
            <>
              {' · then '}
              {next.summary ?? 'Untitled event'} at <time dateTime={time.iso(next.startsAt)}>{time.time(next.startsAt)}</time>
            </>
          ) : null}
        </p>
      </div>
    );
  }

  if (next?.startsAt) {
    const soon = minutesUntilNext === null ? null : until(minutesUntilNext);
    const facts = eventFacts(next);
    return (
      <div className="loop-day__next">
        <p className="loop-eyebrow">Up next</p>
        <p className="loop-day__title">{next.summary ?? 'Untitled event'}</p>
        <p className="loop-day__when">
          <time dateTime={time.iso(next.startsAt)}>{time.time(next.startsAt)}</time>
          {soon ? ` · ${soon}` : null}
          {facts.length > 0 ? ` · ${facts.join(' · ')}` : null}
        </p>
      </div>
    );
  }

  // Nothing ahead. Whether that means a clear day or a finished one is a difference worth keeping.
  const done = view.summary.total > 0;
  return (
    <div className="loop-day__next loop-day__next--idle">
      <p className="loop-eyebrow">{done ? 'Rest of day' : 'Today'}</p>
      <p className="loop-day__title">
        {done
          ? current
            ? 'Nothing else is scheduled today.'
            : 'Nothing else was scheduled when Loop last read your calendar.'
          : todayLine(view, time, current)}
      </p>
    </div>
  );
}

// --- The surface -----------------------------------------------------------------------------------

export function YourDay({ view, refresh }: { view: YourDayView | null; refresh?: React.ReactNode }) {
  // Nothing to say: this deployment has no Google, or this principal can hold no connection.
  if (!view || view.freshness === 'NOT_CONFIGURED') return null;

  // The reader's own zone, resolved upstream from their preference or their browser: the Loop
  // Time Authority formats every instant below, and nothing here touches the server's zone.
  const time = createTimeView(view.zone, view.now);
  const state = currency(view, time);
  const connected = view.freshness !== 'NOT_CONNECTED' && view.freshness !== 'CAPABILITY_NOT_GRANTED' && view.freshness !== 'AUTHORIZATION_EXPIRED';
  // Is there a picture at all -- has Loop ever completed a read of this calendar? Both facts are
  // derived from the same cursor upstream, so they cannot disagree; if they ever did, the state
  // that shows less wins.
  const read = view.lastSyncedAt !== null && view.freshness !== 'NEVER_SYNCED';
  // Is that picture current enough to describe in the present tense?
  const current = FRESHNESS_ADMITS_EMPTY.includes(view.freshness);
  const { position, todaySchedule, tomorrowSchedule, tomorrowSummary } = view;
  const tomorrowRows = [...tomorrowSchedule.allDay, ...tomorrowSchedule.timed];

  return (
    <Panel title="Your day" lead={time.format(view.now, 'weekdayMonthDay')}>
      <div className="loop-day">
        <p className="loop-home__line muted">
          {state.line}
          {state.href ? (
            <>
              {' '}
              <a href={state.href}>{state.action}</a>
            </>
          ) : null}
        </p>

        {!connected ? (
          <StateBlock
            kind={view.freshness === 'AUTHORIZATION_EXPIRED' ? 'attention' : 'empty'}
            title={view.freshness === 'AUTHORIZATION_EXPIRED' ? 'Your calendar connection needs attention' : 'Your calendar is not connected'}
            body="Loop shows your day from your own Google Calendar. Nobody else in your organization can see it."
            action={{ label: state.action ?? 'Connections', href: state.href ?? CONNECTIONS_PATH }}
            compact
          />
        ) : !read ? (
          // Connected, but Loop has never completed a read. There is no day to show, and an empty
          // list here would read as an empty calendar -- so the surface shows the state instead.
          <>
            <StateBlock
              kind="empty"
              title={view.freshness === 'SYNC_FAILED' ? 'Loop could not read your calendar' : 'Loop has not read your calendar yet'}
              body={
                view.freshness === 'SYNC_FAILED'
                  ? 'Google did not answer the last attempt. Nothing is wrong with your calendar; Loop simply has nothing to show from it yet.'
                  : 'Your calendar is connected. Loop reads it when you open Loop, and the first read can take a moment.'
              }
              compact
            />
            {refresh ?? null}
          </>
        ) : (
          <>
            <UpNext view={view} time={time} current={current} />

            <div className="loop-day__sections">
              {view.summary.total > 0 ? (
                <section className="loop-day__section" aria-label="Today">
                  <h3 className="loop-eyebrow">Today</h3>
                  <ul className="loop-home__list">
                    {todaySchedule.allDay.map((event) => (
                      <EventRow key={event.eventId} event={event} time={time} />
                    ))}
                    {todaySchedule.timed.map((event) => (
                      <EventRow
                        key={event.eventId}
                        event={event}
                        time={time}
                        emphasis={event.eventId === position.next?.eventId || event.eventId === position.inProgress?.eventId}
                      />
                    ))}
                  </ul>
                  <p className="loop-home__line muted">{todayLine(view, time, current)}</p>
                </section>
              ) : null}

              <section className="loop-day__section" aria-label="Tomorrow">
                <h3 className="loop-eyebrow">Tomorrow</h3>
                <p className="loop-home__line muted">{tomorrowLine(view, time, current)}</p>
                {tomorrowRows.length > 0 ? (
                  <ul className="loop-home__list">
                    {tomorrowRows.slice(0, 3).map((event) => (
                      <EventRow key={event.eventId} event={event} time={time} />
                    ))}
                    {tomorrowSummary.total > 3 ? (
                      <li className="loop-home__more">and {tomorrowSummary.total - 3} more.</li>
                    ) : null}
                  </ul>
                ) : null}
              </section>
            </div>

            {refresh ?? null}
          </>
        )}
      </div>
    </Panel>
  );
}
