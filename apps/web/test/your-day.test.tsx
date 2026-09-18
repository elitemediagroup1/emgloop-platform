// YOUR DAY: what an employee actually sees, and what they can never see.
//
// Renders the real component with prepared views, in the style this app already uses
// (renderToStaticMarkup + markup assertions), plus source assertions for the guarantees that are
// properties of the code rather than of one render.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  positionInDay,
  scheduleFor,
  summarizeDay,
  startOfZonedDay,
  zonedCalendarDay,
  type CalendarFreshness,
  type DayBounds,
  type DayEvent,
} from '@emgloop/shared';
import { YourDay } from '../src/app/app/_home/your-day';
import type { YourDayView } from '../src/daily-loop/your-day';

const NY = 'America/New_York';
const NOW = new Date('2026-09-18T13:40:00Z'); // 09:40 in New York
const at = (iso: string) => new Date(iso);

function bounds(anchor: Date): DayBounds {
  const startsAt = startOfZonedDay(anchor, NY);
  const endsAt = startOfZonedDay(new Date(startsAt.getTime() + 129_600_000), NY);
  return { civilDate: zonedCalendarDay(startsAt, NY), startsAt, endsAt };
}

function event(over: Partial<DayEvent> = {}): DayEvent {
  return {
    eventId: 'e1',
    summary: 'Team Daily',
    startsAt: at('2026-09-18T13:30:00Z'),
    endsAt: at('2026-09-18T14:00:00Z'),
    allDay: false,
    startDate: null,
    endDateExclusive: null,
    status: 'CONFIRMED',
    blocking: 'BLOCKING',
    kind: 'DEFAULT',
    selfResponse: 'ACCEPTED',
    hasConference: false,
    organizerIsSelf: true,
    attendanceKnown: true,
    attendeeCount: 6,
    externalAttendeeCount: 0,
    recurringEventId: null,
    ...over,
  };
}

function view(over: { events?: DayEvent[]; tomorrow?: DayEvent[]; freshness?: CalendarFreshness; lastSyncedAt?: Date | null } = {}): YourDayView {
  const today = bounds(NOW);
  const tomorrowBounds = bounds(new Date(today.endsAt.getTime() + 43_200_000));
  const todaySchedule = scheduleFor(over.events ?? [], today);
  const tomorrowSchedule = scheduleFor(over.tomorrow ?? [], tomorrowBounds);
  return {
    zone: { timeZone: NY, source: 'device' },
    now: NOW,
    today,
    tomorrow: tomorrowBounds,
    todaySchedule,
    tomorrowSchedule,
    summary: summarizeDay(todaySchedule, today, NOW),
    tomorrowSummary: summarizeDay(tomorrowSchedule, tomorrowBounds, tomorrowBounds.startsAt),
    position: positionInDay(todaySchedule, NOW),
    freshness: over.freshness ?? 'CURRENT',
    lastSyncedAt:
      over.lastSyncedAt === undefined
        ? over.freshness === 'NEVER_SYNCED'
          ? null
          : new Date(NOW.getTime() - 4 * 60_000)
        : over.lastSyncedAt,
    refreshed: false,
  };
}

const render = (v: YourDayView | null) => renderToStaticMarkup(<YourDay view={v} />);

describe('Your Day shows the day an employee is actually having', () => {
  it('leads with what is happening now and what is next, in the reader’s own zone', () => {
    const html = render(
      view({
        events: [
          event({ eventId: 'standup', summary: 'Team Daily', startsAt: at('2026-09-18T13:30:00Z'), endsAt: at('2026-09-18T14:00:00Z') }),
          event({ eventId: 'cashion', summary: 'Cashion / Trevon', startsAt: at('2026-09-18T15:00:00Z'), endsAt: at('2026-09-18T15:30:00Z'), attendeeCount: 3, externalAttendeeCount: 1, hasConference: true }),
        ],
      }),
    );
    assert.match(html, /Your day/);
    // The day is read in one order, and the surface names each part of it.
    assert.match(html, /Happening now/);
    assert.match(html, /loop-day__title">Team Daily/);
    assert.match(html, /<h3 class="loop-eyebrow">Today<\/h3>/);
    assert.match(html, /<h3 class="loop-eyebrow">Tomorrow<\/h3>/);
    assert.match(html, /then Cashion \/ Trevon at/);
    // 09:30 and 11:00 in New York -- the reader's zone, not UTC.
    assert.match(html, /9:30 AM/);
    assert.match(html, /11:00 AM/);
    // The canonical instant stays machine-readable in the attribute, and never becomes the
    // visible time: a reader sees their own clock, a machine sees UTC.
    assert.match(html, /datetime="2026-09-18T13:30:00\.000Z"/i);
    assert.equal(/>[^<]*13:30/.test(html), false, 'no UTC time is rendered as text');
    // The facts beside an event are the stored ones.
    assert.match(html, /6 people/);
    assert.match(html, /3 people · external/);
    assert.match(html, /video call/);
  });

  it('frames the day with all-day entries and says what is provable about the rest', () => {
    const html = render(
      view({
        events: [
          event({ eventId: 'conf', summary: 'Conference', allDay: true, startsAt: null, endsAt: null, startDate: '2026-09-18', endDateExclusive: '2026-09-19' }),
          event({ eventId: 'standup', startsAt: at('2026-09-18T13:30:00Z'), endsAt: at('2026-09-18T14:00:00Z') }),
        ],
      }),
    );
    assert.match(html, /All day/);
    assert.match(html, /Conference/);
    assert.match(html, /1 event today/);
    assert.match(html, /1 all-day entry/);
    assert.match(html, /Your afternoon is clear/);
  });

  it('counts a cancelled or declined event out of the day, and says so', () => {
    const html = render(
      view({
        events: [
          event({ eventId: 'ok' }),
          event({ eventId: 'gone', summary: 'Called off', status: 'CANCELLED' }),
          event({ eventId: 'declined', summary: 'Not attending', selfResponse: 'DECLINED' }),
        ],
      }),
    );
    assert.equal(html.includes('Called off'), false, 'a cancelled meeting is not on the day');
    assert.equal(html.includes('Not attending'), false);
    assert.match(html, /1 event was cancelled/);
    assert.match(html, /1 you declined is not shown/);
  });

  it('previews tomorrow in a line', () => {
    const html = render(view({ tomorrow: [event({ eventId: 't1', summary: 'Planning', startsAt: at('2026-09-19T13:00:00Z'), endsAt: at('2026-09-19T14:00:00Z') })] }));
    assert.match(html, /<h3 class="loop-eyebrow">Tomorrow<\/h3>/);
    assert.match(html, /1 event tomorrow, starting at 9:00 AM/);
    assert.match(html, /Planning/);
  });
});

describe('Your Day never turns "I could not look" into "nothing is scheduled"', () => {
  it('says a clear day is clear, but only when Loop actually read the calendar', () => {
    assert.match(render(view({ events: [] })), /Your calendar is clear today/);
    assert.match(render(view({ events: [], freshness: 'STALE' })), /Your calendar is clear today/);

    for (const freshness of ['NEVER_SYNCED', 'SYNC_FAILED'] as const) {
      const html = render(view({ events: [], freshness }));
      assert.equal(html.includes('Your calendar is clear'), false, freshness);
      assert.match(html, /Loop (has not read|could not reach)/, freshness);
    }
  });

  it('names each state, and offers the way back where there is one', () => {
    assert.match(render(view({ freshness: 'CURRENT' })), /Loop read your calendar 4 minutes ago|Loop read your calendar/);
    assert.match(render(view({ freshness: 'STALE', lastSyncedAt: new Date(NOW.getTime() - 5 * 3_600_000) })), /Loop last read your calendar/);
    assert.match(render(view({ freshness: 'NEVER_SYNCED', lastSyncedAt: null })), /has not read your calendar yet/);
    assert.match(render(view({ freshness: 'SYNC_FAILED' })), /could not reach Google/);

    const expired = render(view({ freshness: 'AUTHORIZATION_EXPIRED' }));
    assert.match(expired, /no longer accepts this connection/);
    assert.match(expired, /\/app\/connections/);
    assert.match(expired, /Reconnect/);

    const missing = render(view({ freshness: 'CAPABILITY_NOT_GRANTED' }));
    assert.match(missing, /Calendar is not connected yet/);
    assert.match(missing, /\/app\/connections/);

    const none = render(view({ freshness: 'NOT_CONNECTED' }));
    assert.match(none, /Connect your Google Calendar/);
    assert.match(none, /Nobody else in your organization can see it/);

    // Nothing at all when the deployment has no Google, or the principal can hold no connection.
    assert.equal(render(view({ freshness: 'NOT_CONFIGURED' })), '');
    assert.equal(render(null), '');
  });

  it('shows the last picture it read when it cannot refresh, and never calls it current', () => {
    const html = render(view({ events: [event({ eventId: 'standup', summary: 'Team Daily' })], freshness: 'SYNC_FAILED' }));
    // The day Loop last read is still the most useful thing it has; it is shown, and framed.
    assert.match(html, /Team Daily/);
    assert.match(html, /as Loop last read it/);
    assert.equal(html.includes('Nothing is scheduled'), false);
  });

  it('shows no schedule before its first read, rather than a day that looks empty', () => {
    const html = render(view({ events: [event()], freshness: 'NEVER_SYNCED' }));
    assert.equal(html.includes('Team Daily'), false, 'a calendar Loop has never read shows no events');
    assert.equal(html.includes('loop-home__list'), false);
    assert.match(html, /has not read your calendar yet/);
  });

  it('shows no schedule at all in a disconnected state, rather than an empty one', () => {
    const html = render(view({ events: [event()], freshness: 'NOT_CONNECTED' }));
    assert.equal(html.includes('Team Daily'), false, 'a state Loop cannot stand behind shows no events');
    assert.equal(html.includes('loop-home__list'), false);
  });
});

describe('Your Day is private, honest and drawn from the design system', () => {
  it('renders nothing Loop did not store: no description, location, link, attendee or organizer identity', () => {
    const html = render(view({ events: [event({ eventId: 'x', summary: 'Cashion / Trevon', hasConference: true })] }));
    for (const absent of ['description', 'Location', 'maps.google', 'meet.google', 'hangout', '@', 'organizer@', 'attendees']) {
      assert.equal(html.includes(absent), false, absent);
    }
    // A conference is reported as a fact, never as a link.
    assert.match(html, /video call/);
    assert.equal(/href="https?:\/\/(?!\/)/.test(html), false, 'no outbound link is rendered');
  });

  it('is drawn from the design system: one stylesheet, no inline style, no colour-coded events', () => {
    const source = readFileSync(fileURLToPath(new URL('../src/app/app/_home/your-day.tsx', import.meta.url)), 'utf8');
    const css = readFileSync(fileURLToPath(new URL('../src/app/loop-os.css', import.meta.url)), 'utf8');
    assert.match(source, /from '\.\.\/_loop-os\/record'/);
    for (const forbidden of ['styled', 'style=', 'className="calendar', 'grid-template', 'rainbow', 'backgroundColor']) {
      assert.equal(source.includes(forbidden), false, forbidden);
    }

    // Every class this surface uses is declared in the one Loop stylesheet. A class that is only
    // declared under another component's scope renders as nothing, which is how emphasis went
    // missing here once; this catches that as well as a class with no rule at all.
    const classes = [...source.matchAll(/className=(?:"([^"]*)"|\{([^}]*)\})/g)]
      .flatMap((m) => (m[1] === undefined ? [...m[2]!.matchAll(/'([^']*)'/g)].map((q) => q[1]!) : [m[1]]))
      .flatMap((value) => value.split(/\s+/))
      .filter((c) => /^[a-z][a-z0-9-]*$/.test(c));
    assert.ok(classes.length > 6, 'the surface draws with classes');
    for (const cls of new Set(classes)) {
      assert.match(css, new RegExp('\\.' + cls + '[\\s,.:{]'), cls + ' has no rule in loop-os.css');
    }

    // Loop's stylesheets are the two that were already here: the Next.js reset and the design
    // system. A surface earns rules inside loop-os.css, never a stylesheet of its own.
    const sheets = readdirSync(fileURLToPath(new URL('../src/app', import.meta.url))).filter((f) => f.endsWith('.css')).sort();
    assert.deepEqual(sheets, ['globals.css', 'loop-os.css']);

    // A colour is never what an event means: the only dot the day paints is the accent one that
    // marks the event the reader is walking into.
    const dots = [...source.matchAll(/loop-home__dot--(\w+)/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(dots)], ['info']);
  });

  it('takes no userId from anywhere but the session, and calls no model', () => {
    const readModel = readFileSync(fileURLToPath(new URL('../src/daily-loop/your-day.ts', import.meta.url)), 'utf8');
    const page = readFileSync(fileURLToPath(new URL('../src/app/app/page.tsx', import.meta.url)), 'utf8');
    const action = readFileSync(fileURLToPath(new URL('../src/daily-loop/actions.ts', import.meta.url)), 'utf8');

    for (const forbidden of ['searchParams', 'params.userId', 'request.json', 'formData', 'headers.get(']) {
      assert.equal(readModel.includes(forbidden), false, `read model: ${forbidden}`);
      assert.equal(action.includes(forbidden), false, `action: ${forbidden}`);
    }
    assert.match(page, /organizationId: session\.organizationId, userId: session\.userId/);
    assert.match(action, /requirePermission\('employeeIntelligence', 'update'\)/);
    assert.match(action, /organizationId: session\.organizationId, userId: session\.userId/);

    for (const forbidden of ['anthropic', 'openai', 'AiRuntimeGateway', 'gmail', 'drive', 'googleapis.com']) {
      assert.equal(readModel.toLowerCase().includes(forbidden.toLowerCase()), false, forbidden);
    }
  });

  it('reads on a phone: one column, no table, no fixed widths', () => {
    const source = readFileSync(fileURLToPath(new URL('../src/app/app/_home/your-day.tsx', import.meta.url)), 'utf8');
    for (const forbidden of ['<table', 'loop-table', 'min-width', 'width:', 'overflow-x']) {
      assert.equal(source.includes(forbidden), false, forbidden);
    }
    const html = render(view({ events: [event(), event({ eventId: 'b', startsAt: at('2026-09-18T15:00:00Z') })] }));
    // The list is the existing Home list, which is a single column at every width.
    assert.match(html, /class="loop-home__list"/);
    assert.match(html, /class="loop-home__item"/);
  });
});
