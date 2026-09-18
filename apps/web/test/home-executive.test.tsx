// THE EXECUTIVE HOME: Today's Review on the left, the day on the right.
//
// Renders the real parts with prepared data (renderToStaticMarkup + markup assertions), plus source
// assertions for the guarantees that are properties of the code rather than of one render: every
// source loads on its own, the authority comes first, and nothing here is a sample.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  composeReview,
  createTimeView,
  positionInDay,
  scheduleFor,
  startOfZonedDay,
  summarizeDay,
  zonedCalendarDay,
  type CalendarFreshness,
  type DayBounds,
  type DayEvent,
  type ReviewAttention,
  type ReviewContribution,
} from '@emgloop/shared';
import { KeyUpdates, Metrics, NeedsAttention, ReviewCard } from '../src/app/app/_home/admin-home';
import { DayCalendar, DayUnavailable, eventType, layoutDay, HOUR_PX } from '../src/app/app/_home/day-calendar';
import type { YourDayView } from '../src/daily-loop/your-day';

const NY = 'America/New_York';
const NOW = new Date('2026-09-18T15:30:00Z'); // 11:30 in New York
const time = createTimeView({ timeZone: NY, source: 'device' }, NOW);
const at = (iso: string) => new Date(iso);
const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

// --- Today's Review --------------------------------------------------------------------------------

const period = { from: startOfZonedDay(at('2026-09-17T16:00:00Z'), NY), to: NOW };

function attention(over: Partial<ReviewAttention> = {}): ReviewAttention {
  return { key: 'mail:t1', source: 'MAIL', rank: 1, since: at('2026-09-18T09:00:00Z'), who: 'Ben Cashion', happened: 'Cashion pricing · They wrote 6 hours ago', next: 'Reply', tone: 'critical', href: '/app/mail/t1', ...over };
}

const mail: ReviewContribution = {
  source: 'MAIL',
  state: 'OK',
  facts: [{ rank: 10, sentence: '2 conversations need your reply, including “Cashion pricing”.' }],
  attention: [attention()],
  attentionCount: 2,
  updates: [{ key: 'mail:t2', source: 'MAIL', at: at('2026-09-18T14:00:00Z'), who: 'Kim Lee', what: 'Intro: EMG x Northwind', status: 'Outreach reply', tone: 'good', href: '/app/mail/t2' }],
  metrics: {
    relevantEmails: { state: 'VALUE', value: 14, prior: 11, href: '/app/mail', scope: 'your mail' },
    outreachSent: { state: 'VALUE', value: 2, prior: 2, href: '/app/mail?view=waiting', scope: 'new conversations you started' },
    newOpportunities: { state: 'VALUE', value: 3, prior: null, href: '/app/mail?view=opportunities', scope: 'opportunity signals in your mail' },
  },
};

describe('Today’s Review says what Loop can prove, and names what it could not read', () => {
  it('the headline is the sources’ own sentences, and the period is stated', () => {
    const review = composeReview([mail, { source: 'CALENDAR', state: 'NOT_CONNECTED', note: 'Loop has not read your calendar yet.' }, { source: 'CALLGRID', state: 'UNAVAILABLE', note: 'Loop could not read CallGrid just now.' }]);
    const html = renderToStaticMarkup(<ReviewCard review={review} period={period} time={time} />);
    assert.match(html, /2 conversations need your reply, including “Cashion pricing”\./);
    assert.match(html, /Since <time[^>]*>Thursday, September 17<\/time>/);
    assert.match(html, /From your mail\./);
    assert.match(html, /Not included: your calendar — Loop has not read your calendar yet\./);
    assert.match(html, /Not included: CallGrid — Loop could not read CallGrid just now\./);
  });

  it('with nothing to say, it says so -- it never fills the space with words it cannot back', () => {
    const quiet = renderToStaticMarkup(<ReviewCard review={composeReview([{ source: 'MAIL', state: 'OK' }])} period={period} time={time} />);
    assert.match(quiet, /Nothing new needs saying from what Loop can read\./);
    const failed = renderToStaticMarkup(<ReviewCard review={null} period={null} time={time} />);
    assert.match(failed, /could not put today(&#x27;|’|')s review together/);
    for (const html of [quiet, failed]) {
      for (const forbidden of ['accelerat', 'major', 'urgent', 'momentum', 'strong week']) assert.equal(html.toLowerCase().includes(forbidden), false, forbidden);
    }
  });

  it('a card with no source says “not tracked yet” -- never a zero dressed as data', () => {
    const review = composeReview([{ source: 'CALLGRID', state: 'OK' }]);
    const html = renderToStaticMarkup(<Metrics review={review} />);
    for (const label of ['Relevant emails', 'New opportunities', 'Need attention', 'Outreach sent']) assert.ok(html.includes(label), label);
    assert.equal((html.match(/Not tracked yet\./g) ?? []).length, 3);
    assert.equal(/loop-mx__card-value">0</.test(html), false);
    assert.match(html, /Nothing that raises attention items could be read\./);
    assert.equal(/<a\b/.test(html), false, 'a card with no number opens nothing');
  });

  it('a card with a number opens where it came from, and compares only with a period it can count', () => {
    const html = renderToStaticMarkup(<Metrics review={composeReview([mail])} />);
    assert.match(html, /href="\/app\/mail"[^>]*>[\s\S]*?>14<[\s\S]*?Up 3 on the period before/);
    assert.match(html, /Same as the period before/);
    assert.match(html, /href="\/app\/mail\?view=opportunities"[\s\S]*?>3<[\s\S]*?opportunity signals in your mail/);
    // Need attention is the count of the attention list itself, and jumps to it.
    assert.match(html, /href="#needs-attention"[\s\S]*?>2</);
    assert.equal(/%/.test(html), false, 'no percentage Loop did not compute');
  });

  it('needs attention: who, what happened, what to do next -- and says which kind of empty it is', () => {
    const html = renderToStaticMarkup(<NeedsAttention attention={[attention()]} total={2} time={time} readable />);
    assert.match(html, /id="needs-attention"/);
    assert.match(html, /Ben Cashion/);
    assert.match(html, /Cashion pricing · They wrote 6 hours ago/);
    assert.match(html, /Reply/);
    assert.match(html, /href="\/app\/mail\/t1"/);
    assert.match(html, /Showing 1 of 2/);
    const more = renderToStaticMarkup(<NeedsAttention attention={[attention()]} total={5} elsewhere={[{ source: 'MAIL', count: 4, href: '/app/mail' }, { source: 'WORK', count: 1, href: null }]} time={time} readable />);
    assert.match(more, /href="\/app\/mail"[^>]*>4 more in your mail →/);
    assert.equal(more.includes('in Loop work'), false, 'no link to a list that has no page');
    // Home lists; it does not operate. Corrections are on the conversation.
    assert.equal(/<form\b|<button\b/.test(html), false);

    const empty = renderToStaticMarkup(<NeedsAttention attention={[]} total={0} time={time} readable />);
    assert.match(empty, /Nothing needs you right now/);
    const unreadable = renderToStaticMarkup(<NeedsAttention attention={[]} total={0} time={time} readable={false} />);
    assert.match(unreadable, /could not read the sources/);
    assert.equal(unreadable.includes('Nothing needs you'), false);
  });

  it('key updates: who, what, a status backed by a rule, and when', () => {
    const html = renderToStaticMarkup(<KeyUpdates updates={composeReview([mail]).updates} time={time} />);
    assert.match(html, /Kim Lee/);
    assert.match(html, /Intro: EMG x Northwind/);
    assert.match(html, /Outreach reply/);
    assert.match(html, /datetime="2026-09-18T14:00:00\.000Z"/i);
    assert.match(renderToStaticMarkup(<KeyUpdates updates={[]} time={time} />), /Nothing has changed since yesterday/);
  });
});

// --- The day ---------------------------------------------------------------------------------------

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
    lastSyncedAt: over.lastSyncedAt === undefined ? (over.freshness === 'NEVER_SYNCED' ? null : new Date(NOW.getTime() - 4 * 60_000)) : over.lastSyncedAt,
    refreshed: false,
  };
}

const DAY: DayEvent[] = [
  event({ eventId: 'daily', summary: 'Team Daily', hasConference: true }), // 09:30–10:00
  event({ eventId: 'brand', summary: 'Brand call', startsAt: at('2026-09-18T15:00:00Z'), endsAt: at('2026-09-18T16:00:00Z'), externalAttendeeCount: 2 }), // 11:00–12:00, now
  event({ eventId: 'overlap', summary: 'Pitch review', startsAt: at('2026-09-18T15:30:00Z'), endsAt: at('2026-09-18T16:30:00Z') }), // overlaps
  event({ eventId: 'focus', summary: 'Deep work', kind: 'FOCUS_TIME', attendeeCount: null, attendanceKnown: false, startsAt: at('2026-09-18T18:00:00Z'), endsAt: at('2026-09-18T20:00:00Z') }),
];

describe('the day, as a timeline of the viewer’s own calendar', () => {
  it('places each event at its stored time, splits overlaps side by side, and knows where now is', () => {
    const v = view({ events: DAY });
    const layout = layoutDay(v.todaySchedule.timed, v.today, NOW);
    assert.equal(layout.firstHour, 8, 'the working day is always shown');
    assert.equal(layout.lastHour, 18);
    const byId = new Map(layout.placed.map((p) => [p.event.eventId, p]));
    assert.equal(byId.get('daily')!.start, 9 * 60 + 30);
    assert.equal(byId.get('daily')!.lanes, 1);
    assert.equal(byId.get('brand')!.lanes, 2);
    assert.equal(byId.get('overlap')!.lanes, 2);
    assert.notEqual(byId.get('brand')!.lane, byId.get('overlap')!.lane);
    assert.equal(layout.nowMinute, 11 * 60 + 30);

    // An early start, or a late now, widens the day rather than falling off it.
    const early = layoutDay([event({ startsAt: at('2026-09-18T10:00:00Z'), endsAt: at('2026-09-18T10:30:00Z') })], v.today, at('2026-09-19T01:15:00Z'));
    assert.equal(early.firstHour, 6);
    assert.equal(early.lastHour, 22);
  });

  it('a day with a clock change is laid out on elapsed time, and stays inside its own length', () => {
    const fallBack = bounds(at('2026-11-01T16:00:00Z')); // 25 hours in New York
    assert.equal((fallBack.endsAt.getTime() - fallBack.startsAt.getTime()) / 3_600_000, 25);
    const layout = layoutDay([event({ startsAt: at('2026-11-02T03:00:00Z'), endsAt: at('2026-11-02T06:00:00Z') })], fallBack, at('2026-11-01T16:00:00Z'));
    assert.equal(layout.lastHour, 25);
    assert.ok(layout.placed[0]!.end <= 25 * 60);
  });

  it('an event’s type is a stored fact: out of office, focus time, outside guests, a meeting, or just on the calendar', () => {
    assert.equal(eventType(event({ kind: 'OUT_OF_OFFICE' })), 'OUT_OF_OFFICE');
    assert.equal(eventType(event({ kind: 'FOCUS_TIME' })), 'FOCUS');
    assert.equal(eventType(event({ externalAttendeeCount: 1 })), 'EXTERNAL');
    assert.equal(eventType(event({ externalAttendeeCount: null })), 'MEETING', 'unknown externality is never guessed external');
    assert.equal(eventType(event({ attendeeCount: 1 })), 'EVENT', 'only the person themselves');
    assert.equal(eventType(event({ attendanceKnown: false, attendeeCount: null })), 'EVENT');
  });

  it('draws the day with a now line, a legend of only the types present, tomorrow, and the way to Google Calendar', () => {
    const html = renderToStaticMarkup(<DayCalendar view={view({ events: DAY, tomorrow: [event({ eventId: 't1', summary: 'Board prep', startsAt: at('2026-09-19T14:00:00Z'), endsAt: at('2026-09-19T15:00:00Z') })] })} />);
    assert.match(html, /Friday, September 18/);
    assert.match(html, /aria-label="Today(&#x27;|’|')s schedule"/);
    for (const title of ['Team Daily', 'Brand call', 'Pitch review', 'Deep work']) assert.ok(html.includes(title), title);
    assert.match(html, /class="loop-cal__now" style="top:\d+(\.\d+)?px"/);
    assert.match(html, new RegExp(`style="height:${10 * HOUR_PX}px"`));
    assert.match(html, /loop-cal__event--now/, 'the meeting in progress is marked');
    assert.match(html, /External guests/);
    assert.match(html, /Focus time/);
    assert.match(html, /Video call/);
    assert.equal(html.includes('Out of office'), false, 'no legend for a type the day does not have');
    assert.match(html, /Tomorrow/);
    assert.match(html, /Board prep/);
    assert.match(html, /href="https:\/\/calendar\.google\.com\/"[^>]*target="_blank"[^>]*rel="noopener noreferrer"/);
    // Loop has no week or month view, so it offers none.
    for (const absent of ['>Week<', '>Month<', '>Day<', 'View Full Calendar']) assert.equal(html.includes(absent), false, absent);
  });

  it('never presents an old read as current: no now line on the last good read, and no grid without a read', () => {
    // Stale is still the present tense (as on Your Day), and says its age.
    const stale = renderToStaticMarkup(<DayCalendar view={view({ events: DAY, freshness: 'STALE', lastSyncedAt: new Date(NOW.getTime() - 5 * 3_600_000) })} />);
    assert.match(stale, /Loop last read your calendar/);
    // After a failed sync the day is the last good read, labelled -- and "now" is not drawn over it.
    const failed = renderToStaticMarkup(<DayCalendar view={view({ events: DAY, freshness: 'SYNC_FAILED', lastSyncedAt: new Date(NOW.getTime() - 26 * 3_600_000) })} />);
    assert.match(failed, /as Loop last read it/);
    assert.match(failed, /Team Daily/);
    assert.equal(failed.includes('loop-cal__now'), false);

    const never = renderToStaticMarkup(<DayCalendar view={view({ freshness: 'NEVER_SYNCED' })} />);
    assert.match(never, /has not read your calendar yet/);
    assert.equal(never.includes('loop-cal__grid'), false);

    const disconnected = renderToStaticMarkup(<DayCalendar view={view({ freshness: 'NOT_CONNECTED', lastSyncedAt: null })} />);
    assert.match(disconnected, /Your calendar is not connected/);
    assert.match(disconnected, /Nobody else in your organization can see it/);

    assert.match(renderToStaticMarkup(<DayCalendar view={null} />), /once Google Calendar is available/);
    assert.match(renderToStaticMarkup(<DayUnavailable />), /could not open your calendar just now/);
  });
});

// --- Structure -------------------------------------------------------------------------------------

describe('the executive Home is assembled safely', () => {
  it('states its authority before any read, and every source loads on its own', () => {
    const home = code(read('../src/app/app/_home/admin-home.tsx'));
    const body = home.slice(home.indexOf('export async function AdminHome'));
    assert.ok(body.indexOf("await requireWorkspace('ADMIN');") < body.indexOf('loadDashboard('));
    assert.match(body, /settle\(\(\) => loadDashboard\(\)\)/);
    assert.match(body, /settle\(\(\) =>\s*loadExecutiveReview\(/);

    const page = code(read('../src/app/app/page.tsx'));
    assert.match(page, /settle\(\(\) => loadYourDay\(principal\)\)/);
    assert.match(page, /settle\(\(\) => loadMailDashboard\(principal, /);
    assert.match(page, /dayResult\.ok \? <YourDay view=\{day\}[\s\S]*?: <DayUnavailable /);

    const data = code(read('../src/app/app/_home/review-data.ts'));
    for (const source of ['MAIL', 'CALENDAR', 'CALLGRID', 'WORK', 'HEADLINES']) assert.match(data, new RegExp(`isolated\\('${source}'`), source);
    // Mail and calendar are the viewer's own: the principal is the session's, handed down.
    assert.match(page, /const principal = \{ organizationId: session\.organizationId, userId: session\.userId \};/);
  });

  it('a redirect or not-found thrown by a guard is never swallowed as “a source failed”', async () => {
    const { settle } = await import('../src/app/app/_home/settle');
    const redirect = Object.assign(new Error('NEXT_REDIRECT'), { digest: 'NEXT_REDIRECT;replace;/crm/login;307;' });
    await assert.rejects(settle(async () => { throw redirect; }), (e) => e === redirect);
    assert.deepEqual(await settle(async () => { throw new Error('P2021 table does not exist'); }), { ok: false });
    assert.deepEqual(await settle(async () => 7), { ok: true, value: 7 });
  });

  it('keeps the operating panels that worked, and drops the ones that only restated static text', () => {
    const home = code(read('../src/app/app/_home/admin-home.tsx'));
    for (const kept of ['CallGrid Intelligence', 'My Work', 'Quick Actions', 'label="Net profit"']) assert.ok(home.includes(kept), kept);
    for (const gone of ['Creator Hub has not yet been built', 'Accounting integration has not yet been configured', 'Phase 1 CRM is live']) {
      assert.equal(home.includes(gone), false, gone);
    }
  });

  it('two columns on a desktop; review, then the day, then the rest on a phone -- with no horizontal scroll', () => {
    const css = read('../src/app/loop-os.css');
    assert.match(css, /\.loop-exec \{ display: grid; grid-template-columns: minmax\(0, 1fr\) minmax\(320px, 372px\);[^}]*grid-template-areas: 'top side' 'bottom side';/);
    assert.match(css, /@media \(max-width: 1180px\) \{\s*\.loop-exec \{ grid-template-columns: minmax\(0, 1fr\); grid-template-rows: none; grid-template-areas: 'top' 'side' 'bottom'; \}/);
    assert.match(css, /@media \(max-width: 760px\) \{\s*\.loop-exec__cards \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); \}/);
  });
});
