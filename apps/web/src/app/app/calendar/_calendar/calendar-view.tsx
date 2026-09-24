// The Calendar page's body: the viewer's own day, drawn from `loadYourDay` (the read Home and Mail use).
//
// EVERY LINE IS A STORED FACT. Times, all-day entries, what is on now and next, and "your morning /
// afternoon is clear" -- said ONLY when the day's summary says true (`summarizeDay`). The stored events
// carry no location, no join link and no attendee names, so none is shown; attendance is a count.
//
// "NOTHING SCHEDULED" IS SAID ONLY FROM A READ LOOP MADE. Every other freshness state says what it
// is -- not connected, calendar not granted, reconnect, never read -- and the way back is Connections.
//
// SERVER COMPONENT, pure over its props. The one action is the existing Refresh control, imported.

import Link from 'next/link';
import type { DayEvent, TimeView } from '@emgloop/shared';

import type { YourDayView } from '../../../../daily-loop/your-day';
import { Panel, StateBlock } from '../../_loop-os/record';
import { RefreshCalendar } from '../../_home/refresh-calendar';

export const CONNECTIONS_HREF = '/app/connections';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The facts beside an event, each one a stored column. No location, no link, no attendee names. */
export function calendarEventFacts(event: DayEvent): string[] {
  const facts: string[] = [];
  if (event.attendanceKnown && event.attendeeCount !== null && event.attendeeCount > 1) {
    facts.push(
      event.externalAttendeeCount !== null && event.externalAttendeeCount > 0
        ? `${plural(event.attendeeCount, 'person', 'people')}, ${event.externalAttendeeCount} external`
        : plural(event.attendeeCount, 'person', 'people'),
    );
  }
  if (event.hasConference) facts.push('Video call');
  if (event.organizerIsSelf) facts.push('You organize it');
  if (event.kind === 'OUT_OF_OFFICE') facts.push('Out of office');
  if (event.kind === 'FOCUS_TIME') facts.push('Focus time');
  if (event.blocking === 'FREE') facts.push('Shown as free');
  return facts;
}

/** Whether the calendar is connected with Calendar granted: whether reading it again means anything. */
const canRefresh = (day: YourDayView) => ['CURRENT', 'STALE', 'SYNC_FAILED', 'NEVER_SYNCED'].includes(day.freshness);
/** Whether the page shows a read Loop made. */
const hasRead = (day: YourDayView) =>
  day.freshness === 'CURRENT' || day.freshness === 'STALE' || (day.freshness === 'SYNC_FAILED' && day.lastSyncedAt !== null);

function freshnessLine(day: YourDayView, time: TimeView): string {
  const when = day.lastSyncedAt ? time.relative(day.lastSyncedAt, { style: 'long' }) : null;
  if (day.freshness === 'SYNC_FAILED') {
    return when ? `Loop could not reach Google just now. As Loop last read it, ${when}.` : 'Loop could not reach Google just now.';
  }
  if (day.freshness === 'STALE') return when ? `As Loop last read it, ${when}.` : 'As Loop last read it.';
  return when ? `Loop read your calendar ${when}.` : 'Loop read your calendar recently.';
}

function NotRead({ day }: { day: YourDayView }) {
  switch (day.freshness) {
    case 'NOT_CONFIGURED':
      return <StateBlock kind="unavailable" title="Calendar is not available yet" body="This Loop deployment has not been set up to connect Google. Nothing is connected, and Loop works without it." />;
    case 'NOT_CONNECTED':
      return (
        <StateBlock
          kind="empty"
          title="Your calendar is not connected"
          body="Connect your own Google account and Loop will show your day here. Loop reads your calendar; it never changes it."
          action={{ label: 'Connect Google Calendar', href: CONNECTIONS_HREF, primary: true }}
        />
      );
    case 'CAPABILITY_NOT_GRANTED':
      return (
        <StateBlock
          kind="attention"
          title="Loop may not read your calendar"
          body="Your Google account is connected without calendar access, so Loop does not know what is on your day."
          action={{ label: 'Allow calendar access', href: CONNECTIONS_HREF, primary: true }}
        />
      );
    case 'AUTHORIZATION_EXPIRED':
      return (
        <StateBlock
          kind="attention"
          title="Reconnect Google to see your day"
          body="Google no longer accepts Loop's access, so Loop does not know what is on your calendar now."
          action={{ label: 'Reconnect Google', href: CONNECTIONS_HREF, primary: true }}
        />
      );
    case 'NEVER_SYNCED':
      return <StateBlock kind="empty" title="Loop has not read your calendar yet" body="Your calendar is connected. Loop reads it in the background; you can also ask it to read now." />;
    default:
      return <StateBlock kind="error" title="Loop could not read your calendar" body="Loop has no read of your calendar to show, so it shows nothing rather than an empty day. Try again in a moment." />;
  }
}

function NowAndNext({ day, time }: { day: YourDayView; time: TimeView }) {
  const { inProgress, next, minutesUntilNext } = day.position;
  const lines: string[] = [];
  if (inProgress) {
    lines.push(`On now: ${inProgress.summary ?? 'Untitled event'}${inProgress.endsAt ? `, until ${time.time(inProgress.endsAt)}` : ''}.`);
  }
  if (next?.startsAt) {
    const soon = minutesUntilNext !== null && minutesUntilNext <= 120 ? ` (in ${plural(minutesUntilNext, 'minute', 'minutes')})` : '';
    lines.push(`Next: ${next.summary ?? 'Untitled event'} at ${time.time(next.startsAt)}${soon}.`);
  } else if (day.summary.timedCount > 0 && !inProgress) {
    lines.push('Nothing more on your calendar today.');
  }
  if (day.summary.morningClear === true) lines.push('Your morning is clear.');
  if (day.summary.afternoonClear === true) lines.push('Your afternoon is clear.');
  if (lines.length === 0) return null;
  return (
    <section className="loop-cal__now" aria-label="Now and next">
      {lines.map((line) => (
        <p key={line} className="loop-cal__line">
          {line}
        </p>
      ))}
    </section>
  );
}

function Schedule({ day, time }: { day: YourDayView; time: TimeView }) {
  const { allDay, timed } = day.todaySchedule;
  const empty = allDay.length === 0 && timed.length === 0;
  const excluded = [
    day.summary.cancelledCount > 0 ? `${plural(day.summary.cancelledCount, 'event was', 'events were')} cancelled` : null,
    day.summary.declinedCount > 0 ? `you declined ${plural(day.summary.declinedCount, 'event', 'events')}` : null,
  ].filter((x): x is string => x !== null);
  const counts = [
    timed.length > 0 ? plural(timed.length, 'meeting', 'meetings') : null,
    allDay.length > 0 ? plural(allDay.length, 'all-day event', 'all-day events') : null,
  ].filter((x): x is string => x !== null);

  return (
    <Panel title={`Today · ${time.date(day.today.startsAt)}`} lead={counts.length > 0 ? counts.join(' · ') : undefined}>
      {empty ? (
        <p className="loop-cal__empty">
          {day.freshness === 'SYNC_FAILED' ? 'Nothing was on your calendar today when Loop last read it.' : 'Nothing is on your calendar today.'}
        </p>
      ) : null}
      {allDay.length > 0 ? (
        <ul className="loop-cal__allday" aria-label="All day">
          {allDay.map((e) => (
            <li key={e.eventId} className="loop-cal__allday-item">
              <span className="loop-cal__tag">All day</span>
              <span className="loop-cal__title">{e.summary ?? 'Untitled event'}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {timed.length > 0 ? (
        <ol className="loop-cal__list" aria-label="Schedule">
          {timed.map((e) => {
            const live = day.position.inProgress?.eventId === e.eventId;
            const past = !live && (e.endsAt ?? e.startsAt)! <= day.now;
            const facts = calendarEventFacts(e);
            return (
              <li key={e.eventId} className={`loop-cal__event${live ? ' is-live' : ''}${past ? ' is-past' : ''}`} data-cal-event>
                <span className="loop-cal__time">
                  <time dateTime={time.iso(e.startsAt!)}>{time.time(e.startsAt!)}</time>
                  {e.endsAt ? (
                    <>
                      {' – '}
                      <time dateTime={time.iso(e.endsAt)}>{time.time(e.endsAt)}</time>
                    </>
                  ) : null}
                </span>
                <span className="loop-cal__what">
                  <span className="loop-cal__title">{e.summary ?? 'Untitled event'}</span>
                  {live ? <span className="loop-pill loop-pill--good">On now</span> : null}
                  {facts.length > 0 ? <span className="loop-cal__facts">{facts.join(' · ')}</span> : null}
                </span>
              </li>
            );
          })}
        </ol>
      ) : null}
      {excluded.length > 0 ? <p className="loop-note">Not shown: {excluded.join('; ')}.</p> : null}
    </Panel>
  );
}

export function CalendarView({ day, time }: { day: YourDayView | null | 'UNAVAILABLE'; time: TimeView }) {
  if (day === 'UNAVAILABLE') {
    return (
      <StateBlock
        kind="error"
        title="Loop could not open your calendar just now"
        body="Nothing is wrong with your calendar. Loop could not read what it stored about it, so it shows nothing rather than an empty day. Try again in a moment."
      />
    );
  }
  if (day === null) {
    return <StateBlock kind="denied" title="No calendar" body="Loop has no calendar for this account." />;
  }

  return (
    <div className="loop-cal" data-cal-freshness={day.freshness}>
      <div className="loop-cal__status">
        {hasRead(day) ? <p className="loop-cal__currency">{freshnessLine(day, time)}</p> : null}
        {canRefresh(day) ? <RefreshCalendar /> : null}
        <Link className="loop-link" href={CONNECTIONS_HREF}>
          Manage connection
        </Link>
      </div>
      {hasRead(day) ? (
        <>
          <NowAndNext day={day} time={time} />
          <Schedule day={day} time={time} />
        </>
      ) : (
        <NotRead day={day} />
      )}
      <p className="loop-note">
        Your own calendar, as Loop read it from Google, in {time.timeZone}
        {time.source === 'fallback' ? ' (your time zone is not known yet)' : ''}. Loop reads it; it never changes it.
      </p>
    </div>
  );
}
