// TODAY'S CALENDAR -- the right-hand column of the executive Home.
//
// The SAME read as Your Day (`loadYourDay`): the signed-in person's own calendar, the same freshness
// states, and the same words for them (`currency`, `todayLine`, `tomorrowLine` in ./your-day). What
// differs is the drawing: a timeline of today, so the shape of the day reads at a glance, with a
// line where "now" is.
//
// IT IS NOT A CALENDAR APPLICATION. There is no week or month, no editing and no invitations --
// Loop has none of those, and a switcher for views that do not exist would be a button for nothing.
// There is no Loop calendar page either, so the way out is Google Calendar itself.
//
// EVERY MARK IS A STORED FACT. An event's position is its stored start and end; its type is a
// column the provider set (out of office, focus time), a count it reported (people, and how many
// are outside the organization), or whether it carries a video call. Nothing says what a meeting is
// for or whether it matters. A day Loop has never read shows that state, never an empty grid.

import type { ReactNode } from 'react';

import { CONNECTIONS_PATH } from '../../../auth/landing';
import { FRESHNESS_ADMITS_EMPTY, createTimeView, type DayEvent, type TimeView } from '@emgloop/shared';
import type { YourDayView } from '../../../daily-loop/your-day';
import { SidebarIcon } from '../../crm/_brand/SidebarIcon';
import { Panel, StateBlock } from '../_loop-os/record';
import { currency, eventFacts, todayLine, tomorrowLine } from './your-day';

export const GOOGLE_CALENDAR_URL = 'https://calendar.google.com/';

/** Pixels per hour of the timeline. One constant, so positions and hour lines always agree. */
export const HOUR_PX = 46;
const MIN_EVENT_PX = 22;
/** The working hours the timeline always shows; events and "now" outside them widen it. */
const DEFAULT_HOURS = { first: 8, last: 18 } as const;

// --- The day, laid out ----------------------------------------------------------------------------

/** How an event is drawn -- each one read off a stored fact, never inferred from its title. */
export type EventType = 'OUT_OF_OFFICE' | 'FOCUS' | 'EXTERNAL' | 'MEETING' | 'EVENT';

export function eventType(event: DayEvent): EventType {
  if (event.kind === 'OUT_OF_OFFICE') return 'OUT_OF_OFFICE';
  if (event.kind === 'FOCUS_TIME') return 'FOCUS';
  if (event.externalAttendeeCount !== null && event.externalAttendeeCount > 0) return 'EXTERNAL';
  // Google lists the person themselves among the attendees: a meeting has someone else on it.
  if (event.attendanceKnown && event.attendeeCount !== null && event.attendeeCount >= 2) return 'MEETING';
  return 'EVENT';
}

export const EVENT_TYPE_LABELS: Readonly<Record<EventType, string>> = Object.freeze({
  EXTERNAL: 'External guests',
  MEETING: 'Meeting',
  FOCUS: 'Focus time',
  OUT_OF_OFFICE: 'Out of office',
  EVENT: 'On your calendar',
});

export interface PlacedEvent {
  readonly event: DayEvent;
  /** Minutes from the start of the day, clamped to the day. */
  readonly start: number;
  readonly end: number;
  /** Side-by-side position among the events it overlaps. */
  readonly lane: number;
  readonly lanes: number;
}

export interface DayLayout {
  readonly firstHour: number;
  readonly lastHour: number;
  readonly placed: readonly PlacedEvent[];
  /** Minutes from the start of the day to now, or null when now is not in this day. */
  readonly nowMinute: number | null;
}

/**
 * Where each timed event sits. Pure: the day's own bounds (instants in the reader's zone) and the
 * current instant are the only inputs.
 *
 * Positions are ELAPSED minutes from the day's first instant, and hour labels are formatted from the
 * same instants, so a day with a clock change stays self-consistent (it is 23 or 25 hours long).
 * Overlapping events share the width: each cluster of events that overlap one another is split into
 * as many lanes as it needs at its busiest.
 */
export function layoutDay(
  timed: readonly DayEvent[],
  day: { readonly startsAt: Date; readonly endsAt: Date },
  now: Date,
  hours: { readonly first: number; readonly last: number } = DEFAULT_HOURS,
): DayLayout {
  const dayMinutes = Math.round((day.endsAt.getTime() - day.startsAt.getTime()) / 60_000);
  const minuteOf = (instant: Date) => Math.min(dayMinutes, Math.max(0, Math.round((instant.getTime() - day.startsAt.getTime()) / 60_000)));

  const items = timed
    .filter((event) => event.startsAt !== null)
    .map((event) => {
      const start = minuteOf(event.startsAt!);
      const stated = event.endsAt ? minuteOf(event.endsAt) : start + 30;
      return { event, start, end: Math.max(stated, start + 15) };
    })
    .sort((a, b) => a.start - b.start || b.end - a.end);

  const placed: PlacedEvent[] = [];
  let cluster: { event: DayEvent; start: number; end: number; lane: number }[] = [];
  let laneEnds: number[] = [];
  let clusterEnd = -1;
  const close = () => {
    for (const c of cluster) placed.push({ ...c, lanes: laneEnds.length });
    cluster = [];
    laneEnds = [];
  };
  for (const item of items) {
    if (item.start >= clusterEnd) close();
    let lane = laneEnds.findIndex((end) => end <= item.start);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(item.end);
    } else {
      laneEnds[lane] = item.end;
    }
    clusterEnd = Math.max(clusterEnd, item.end);
    cluster.push({ ...item, lane });
  }
  close();

  const nowMinute = now >= day.startsAt && now < day.endsAt ? (now.getTime() - day.startsAt.getTime()) / 60_000 : null;
  const lastPossible = Math.ceil(dayMinutes / 60);
  const starts = placed.map((p) => Math.floor(p.start / 60));
  const ends = placed.map((p) => Math.ceil(p.end / 60));
  const firstHour = Math.max(0, Math.min(hours.first, ...starts, ...(nowMinute === null ? [] : [Math.floor(nowMinute / 60)])));
  const lastHour = Math.min(lastPossible, Math.max(hours.last, ...ends, ...(nowMinute === null ? [] : [Math.floor(nowMinute / 60) + 1])));
  return { firstHour, lastHour, placed, nowMinute };
}

// --- Drawing ----------------------------------------------------------------------------------------

/** "8 AM" rather than "8:00 AM": an hour line names an hour. */
function hourLabel(time: TimeView, instant: Date): string {
  return time.time(instant).replace(/:00(?=\s|$)/, '');
}

function EventBlock({ placed, firstHour, time, now }: { placed: PlacedEvent; firstHour: number; time: TimeView; now: boolean }) {
  const { event, start, end, lane, lanes } = placed;
  const type = eventType(event);
  const top = ((start - firstHour * 60) / 60) * HOUR_PX;
  const height = Math.max(MIN_EVENT_PX, ((end - start) / 60) * HOUR_PX - 2);
  const facts = eventFacts(event);
  const classes = ['loop-cal__event', `loop-cal__event--${type.toLowerCase().replace(/_/g, '-')}`];
  if (event.blocking === 'FREE') classes.push('loop-cal__event--free');
  if (now) classes.push('loop-cal__event--now');
  if (height < 40) classes.push('loop-cal__event--short');
  if (lanes > 1) classes.push('loop-cal__event--narrow');
  const when = `${time.time(event.startsAt!)}${event.endsAt ? `–${time.time(event.endsAt)}` : ''}`;
  return (
    <li
      className={classes.join(' ')}
      style={{ top: `${top}px`, height: `${height}px`, left: `calc(${(lane / lanes) * 100}% + 2px)`, width: `calc(${100 / lanes}% - 4px)` }}
      title={`${event.summary ?? 'Untitled event'} · ${when}`}
    >
      <span className="loop-cal__event-title">
        {event.hasConference ? (
          <span className="loop-cal__event-icon" aria-hidden="true">
            <SidebarIcon name="video" size={13} />
          </span>
        ) : null}
        {event.summary ?? 'Untitled event'}
      </span>
      <span className="loop-cal__event-when">
        <time dateTime={time.iso(event.startsAt!)}>{time.time(event.startsAt!)}</time>
        {event.endsAt ? <>–{time.time(event.endsAt)}</> : null}
        {now ? ' · now' : null}
      </span>
      {/* The same facts as Your Day, for a reader who cannot see the colours. */}
      <span className="loop-sr-only">{[...(lanes > 1 ? [when] : []), EVENT_TYPE_LABELS[type], ...facts].join(', ')}</span>
    </li>
  );
}

function Timeline({ view, time, current }: { view: YourDayView; time: TimeView; current: boolean }) {
  const layout = layoutDay(view.todaySchedule.timed, view.today, view.now);
  const hours = Array.from({ length: layout.lastHour - layout.firstHour }, (_, i) => layout.firstHour + i);
  const height = hours.length * HOUR_PX;
  const inProgress = view.position.inProgress?.eventId ?? null;
  // "Now" is drawn only on a picture current enough to speak in the present tense.
  const nowTop = current && layout.nowMinute !== null ? ((layout.nowMinute - layout.firstHour * 60) / 60) * HOUR_PX : null;
  const types = [...new Set(view.todaySchedule.timed.map(eventType))];
  const video = view.todaySchedule.timed.some((e) => e.hasConference);
  const free = view.todaySchedule.timed.some((e) => e.blocking === 'FREE');

  return (
    <>
      <div className="loop-cal__grid" style={{ height: `${height}px` }}>
        <ol className="loop-cal__hours" aria-hidden="true">
          {hours.map((h) => (
            <li key={h} className="loop-cal__hour" style={{ top: `${(h - layout.firstHour) * HOUR_PX}px` }}>
              <span className="loop-cal__hour-label">{hourLabel(time, new Date(view.today.startsAt.getTime() + h * 3_600_000))}</span>
            </li>
          ))}
        </ol>
        <ol className="loop-cal__events" aria-label="Today's schedule">
          {layout.placed.map((p) => (
            <EventBlock key={p.event.eventId} placed={p} firstHour={layout.firstHour} time={time} now={p.event.eventId === inProgress} />
          ))}
        </ol>
        {nowTop !== null ? (
          <div className="loop-cal__now" style={{ top: `${nowTop}px` }}>
            <span className="loop-sr-only">Now, {time.time(view.now)}</span>
          </div>
        ) : null}
      </div>
      {types.length > 0 || video || free ? (
        <ul className="loop-cal__legend" aria-label="What the colours mean">
          {(['EXTERNAL', 'MEETING', 'FOCUS', 'OUT_OF_OFFICE', 'EVENT'] as const)
            .filter((t) => types.includes(t))
            .map((t) => (
              <li key={t} className="loop-cal__key">
                <span className={`loop-cal__swatch loop-cal__swatch--${t.toLowerCase().replace(/_/g, '-')}`} aria-hidden="true" />
                {EVENT_TYPE_LABELS[t]}
              </li>
            ))}
          {video ? (
            <li className="loop-cal__key">
              <SidebarIcon name="video" size={13} /> Video call
            </li>
          ) : null}
          {free ? (
            <li className="loop-cal__key">
              <span className="loop-cal__swatch loop-cal__swatch--free" aria-hidden="true" />
              Not blocking time
            </li>
          ) : null}
        </ul>
      ) : null}
    </>
  );
}

function DayRow({ event, time }: { event: DayEvent; time: TimeView }) {
  const type = eventType(event);
  return (
    <li className="loop-cal__row">
      <span className="loop-cal__row-time">
        {event.allDay ? 'All day' : <time dateTime={time.iso(event.startsAt!)}>{time.time(event.startsAt!)}</time>}
      </span>
      <span className={`loop-cal__swatch loop-cal__swatch--${type.toLowerCase().replace(/_/g, '-')}`} aria-hidden="true" />
      <span className="loop-cal__row-title">{event.summary ?? 'Untitled event'}</span>
    </li>
  );
}

/** The calendar column could not be read at all (the read threw). Said, never hidden. */
export function DayUnavailable({ title = 'Today' }: { title?: string }) {
  return (
    <Panel title={title}>
      <StateBlock kind="attention" title="Loop could not open your calendar just now" body="Nothing is wrong with your calendar. Try again in a moment." compact />
    </Panel>
  );
}

export function DayCalendar({ view, refresh }: { view: YourDayView | null; refresh?: ReactNode }) {
  // No Google for this deployment, or no connection this person can hold: say so once, plainly.
  if (!view || view.freshness === 'NOT_CONFIGURED') {
    return (
      <Panel title="Today">
        <p className="loop-home__line muted">Your calendar appears here once Google Calendar is available in Loop.</p>
      </Panel>
    );
  }

  const time = createTimeView(view.zone, view.now);
  const state = currency(view, time);
  const connected = view.freshness !== 'NOT_CONNECTED' && view.freshness !== 'CAPABILITY_NOT_GRANTED' && view.freshness !== 'AUTHORIZATION_EXPIRED';
  const read = view.lastSyncedAt !== null && view.freshness !== 'NEVER_SYNCED';
  const current = FRESHNESS_ADMITS_EMPTY.includes(view.freshness);
  const { todaySchedule, tomorrowSchedule, tomorrowSummary } = view;
  const tomorrowRows = [...tomorrowSchedule.allDay, ...tomorrowSchedule.timed];

  return (
    <Panel title="Today" lead={time.format(view.now, 'weekdayMonthDay')}>
      <div className="loop-cal">
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
          <>
            <StateBlock
              kind="empty"
              title={view.freshness === 'SYNC_FAILED' ? 'Loop could not read your calendar' : 'Loop has not read your calendar yet'}
              body={
                view.freshness === 'SYNC_FAILED'
                  ? 'Google did not answer the last attempt. Loop has nothing to show from your calendar yet.'
                  : 'Your calendar is connected. Loop reads it when you open Loop, and the first read can take a moment.'
              }
              compact
            />
            {refresh ?? null}
          </>
        ) : (
          <>
            <p className="loop-cal__summary">{todayLine(view, time, current)}</p>
            {todaySchedule.allDay.length > 0 ? (
              <ul className="loop-cal__allday" aria-label="All day">
                {todaySchedule.allDay.map((event) => (
                  <li key={event.eventId} className={`loop-cal__chip loop-cal__chip--${eventType(event).toLowerCase().replace(/_/g, '-')}`}>
                    <span className="loop-cal__chip-when">All day</span> {event.summary ?? 'Untitled event'}
                  </li>
                ))}
              </ul>
            ) : null}
            <Timeline view={view} time={time} current={current} />

            <section className="loop-cal__tomorrow" aria-label="Tomorrow">
              <h3 className="loop-eyebrow">Tomorrow</h3>
              <p className="loop-home__line muted">{tomorrowLine(view, time, current)}</p>
              {tomorrowRows.length > 0 ? (
                <ul className="loop-cal__rows">
                  {tomorrowRows.slice(0, 4).map((event) => (
                    <DayRow key={event.eventId} event={event} time={time} />
                  ))}
                  {tomorrowSummary.total > 4 ? <li className="loop-home__more">and {tomorrowSummary.total - 4} more.</li> : null}
                </ul>
              ) : null}
            </section>
            {refresh ?? null}
          </>
        )}

        <a href={GOOGLE_CALENDAR_URL} className="loop-link" target="_blank" rel="noopener noreferrer">
          Open Google Calendar ↗
        </a>
      </div>
    </Panel>
  );
}
