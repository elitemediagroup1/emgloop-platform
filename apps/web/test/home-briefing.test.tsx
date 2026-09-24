// Loop Home as a daily briefing (approved design pass, 2026-09-24).
//
// The composer is pure: these tests hand it the loaders' outputs and read the plan back. They pin
// the order and the cap, the ranking as presentation over unchanged producers, the read-side rule
// that a dismissed Headline never reappears, the honest empty and not-connected states, the
// wording, and -- carried over from the retired Needs You, Your Day and Your Mail panels -- that a
// Telegram row is minimized, source-labelled and never given a link, that a calendar row shows only
// stored columns in the reader's zone, and that mail is a line of counts, not a second inbox.
//
// Since the front door (2026-09-24) the composer has no "pulse": CallGrid reaches it as the projected
// command context (kpis.ts) and the one CallGrid row carries the window's own comparison label.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  callGridKpis,
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
  type HeadlineView,
  type ReviewAttention,
  type ReviewContribution,
  type ReviewUpdate,
} from '@emgloop/shared';
import { BRIEFING_LIMITS, briefingWords, composeBriefing, dueTodayFromQueue, dueTodayFromWork, rankAttention, type Briefing, type BriefingInput, type QueueInstance } from '../src/app/app/_home/briefing';
import { BriefingLead, NeedsAttention, TodayPanel, WhatChanged } from '../src/app/app/_home/briefing-view';
import { HOME_KPI_KEYS, projectHomeKpis, type HomeKpiStrip } from '../src/app/app/_home/kpis';
import type { NeedsYouItem } from '../src/daily-loop/needs-you';
import type { YourDayView } from '../src/daily-loop/your-day';
import type { MailDashboard } from '../src/daily-loop/mail-dashboard';
import type { MyWorkItem } from '../src/app/app/admin/workspace-home-data';

const NY = 'America/New_York';
const NOW = new Date('2026-09-24T15:30:00Z'); // 11:30 in New York
const time = createTimeView({ timeZone: NY, source: 'device' }, NOW);
const at = (iso: string) => new Date(iso);
const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
const period = { from: startOfZonedDay(at('2026-09-23T16:00:00Z'), NY), to: NOW };

// --- fixtures ----------------------------------------------------------------------------------------

function attention(over: Partial<ReviewAttention> = {}): ReviewAttention {
  return { key: 'mail:t1', source: 'MAIL', rank: 1, since: at('2026-09-24T09:00:00Z'), who: 'Dana Rivera', happened: 'HVAC AC repair · They wrote 3 days ago', next: 'Reply', tone: 'critical', href: '/app/mail/t1', ...over };
}
function update(over: Partial<ReviewUpdate> = {}): ReviewUpdate {
  return { key: 'activity:a1', source: 'WORK', at: at('2026-09-24T03:54:00Z'), who: 'Charlie', what: 'Returned Edit v1 of “Kona unboxing — cut A”', status: 'Work', tone: 'neutral', href: null, ...over };
}
function needsYou(over: Partial<NeedsYouItem> = {}): NeedsYouItem {
  return {
    id: 'w1',
    provider: 'TELEGRAM',
    sourceLabel: 'Telegram',
    title: 'Dana Reyes asks to reschedule the Thursday kickoff call',
    category: 'REQUEST',
    counterparty: 'Dana Reyes',
    topic: 'Kickoff call',
    nextStep: 'Propose a new time',
    deadline: 'by Thursday',
    at: at('2026-09-24T12:02:00Z'),
    detectionCount: 1,
    ...over,
  };
}
function headline(over: Partial<HeadlineView> = {}): HeadlineView {
  return {
    id: 'h1',
    performanceObjectiveId: 'obj1',
    objectiveTitle: 'Grow roofing lead revenue in Texas',
    measureBindingId: 'b1',
    measureBindingVersion: 1,
    measurement: {
      metric: 'REVENUE' as HeadlineView['measurement']['metric'],
      metricLabel: 'Revenue',
      unit: 'USD' as HeadlineView['measurement']['unit'],
      movement: 'DECREASE',
      againstObjective: true,
      currentValue: 4180,
      priorValue: 6940,
      absoluteChange: -2760,
      percentageChange: -0.398,
      currentDenominator: 14,
      priorDenominator: 14,
      currentCoverage: 0.86,
      priorCoverage: 0.93,
      comparisonBasis: 'week over week',
      currentWindowStart: '2026-09-15',
      currentWindowEnd: '2026-09-22',
      priorWindowStart: '2026-09-08',
      priorWindowEnd: '2026-09-15',
    },
    statement: 'Roofing lead revenue in Texas: $4,180 this week vs $6,940 last week (−40%)',
    limitations: [],
    unknowns: [],
    ruleId: 'ci.week-over-week',
    ruleVersion: '1',
    producerVersion: '1',
    ruleDescription: 'movement against an objective you set',
    firstDetectedAt: '2026-09-23T06:10:00Z',
    lastDetectedAt: '2026-09-24T06:10:00Z',
    detectionCount: 2,
    dismissedAt: null,
    dismissedByUserId: null,
    dismissedByName: null,
    dismissalBasis: null,
    createdAt: '2026-09-23T06:10:00Z',
    ...over,
  };
}
const mailContribution: ReviewContribution = {
  source: 'MAIL',
  state: 'OK',
  facts: [],
  attention: [attention()],
  attentionCount: 4,
  attentionHref: '/app/mail',
  updates: [update({ key: 'mail:t2', source: 'MAIL', at: at('2026-09-24T11:31:00Z'), who: 'Sun & Soil', what: 'Spring series terms', status: 'Outreach reply', tone: 'good', href: '/app/mail/t2' })],
  metrics: {
    relevantEmails: { state: 'VALUE', value: 12, prior: 8, href: '/app/mail', scope: 'your mail' },
    outreachSent: { state: 'VALUE', value: 5, prior: 5, href: '/app/mail?view=waiting', scope: 'new conversations you started' },
    newOpportunities: { state: 'NOT_TRACKED', reason: 'Loop does not track opportunities yet.' },
  },
};
const workContribution: ReviewContribution = {
  source: 'WORK',
  state: 'OK',
  attention: [attention({ key: 'work:w9', source: 'WORK', rank: 2, since: null, who: 'Production 2 · Sculpey teaser', happened: 'Work · the Edit step is ready and nobody is assigned', next: 'Assign', tone: 'attention', href: '/app/admin/work/w9' })],
  attentionCount: 1,
  updates: [update()],
};
const calendarNotRead: ReviewContribution = { source: 'CALENDAR', state: 'NOT_CONNECTED', note: 'Loop has not read your calendar yet.' };
const callgridUnavailable: ReviewContribution = { source: 'CALLGRID', state: 'UNAVAILABLE', note: 'Loop could not read CallGrid just now.' };
const headlinesUnavailable: ReviewContribution = { source: 'HEADLINES', state: 'UNAVAILABLE', note: 'Loop could not read Headlines just now.' };
function review(contributions: ReviewContribution[] = [mailContribution, calendarNotRead, callgridUnavailable, workContribution, headlinesUnavailable]) {
  return composeReview(contributions);
}

function bounds(anchor: Date): DayBounds {
  const startsAt = startOfZonedDay(anchor, NY);
  const endsAt = startOfZonedDay(new Date(startsAt.getTime() + 129_600_000), NY);
  return { civilDate: zonedCalendarDay(startsAt, NY), startsAt, endsAt };
}
function event(over: Partial<DayEvent> = {}): DayEvent {
  return {
    eventId: 'e1', summary: 'Team Daily', startsAt: at('2026-09-24T13:30:00Z'), endsAt: at('2026-09-24T14:00:00Z'), allDay: false, startDate: null, endDateExclusive: null,
    status: 'CONFIRMED', blocking: 'BLOCKING', kind: 'DEFAULT', selfResponse: 'ACCEPTED', hasConference: false, organizerIsSelf: true, attendanceKnown: true, attendeeCount: 6, externalAttendeeCount: 0, recurringEventId: null,
    ...over,
  };
}
function day(over: { events?: DayEvent[]; freshness?: CalendarFreshness; lastSyncedAt?: Date | null } = {}): YourDayView {
  const today = bounds(NOW);
  const todaySchedule = scheduleFor(over.events ?? [], today);
  return {
    zone: { timeZone: NY, source: 'device' }, now: NOW, today, todaySchedule,
    summary: summarizeDay(todaySchedule, today, NOW), position: positionInDay(todaySchedule, NOW),
    freshness: over.freshness ?? 'CURRENT', lastSyncedAt: over.lastSyncedAt === undefined ? new Date(NOW.getTime() - 4 * 60_000) : over.lastSyncedAt, refreshed: false,
  };
}
const DAY: DayEvent[] = [
  event({ eventId: 'daily', summary: 'Team Daily', hasConference: true }), // 09:30–10:00
  event({ eventId: 'brand', summary: 'Harbor / Kona — reel review', startsAt: at('2026-09-24T15:00:00Z'), endsAt: at('2026-09-24T16:00:00Z'), externalAttendeeCount: 2, attendeeCount: 3 }), // 11:00–12:00, now
  event({ eventId: 'weekly', summary: 'CallGrid weekly', startsAt: at('2026-09-24T20:00:00Z'), endsAt: at('2026-09-24T21:00:00Z') }),
];
function mailDashboard(freshness: string, summary?: Partial<MailDashboard['summary']>, over: { concludable?: boolean; current?: boolean; lastSyncedAt?: Date | null } = {}): MailDashboard {
  const lastSyncedAt = over.lastSyncedAt === undefined ? (freshness === 'NEVER_SYNCED' ? null : new Date(NOW.getTime() - 4 * 60_000)) : over.lastSyncedAt;
  const concludable = over.concludable ?? (lastSyncedAt !== null && (freshness === 'CURRENT' || freshness === 'STALE' || freshness === 'SYNC_FAILED'));
  const current = over.current ?? freshness === 'CURRENT';
  return { mail: { freshness, lastSyncedAt } as MailDashboard['mail'], concludable, current, now: NOW, rows: [], recent: [], summary: { needsReply: 3, followUps: 1, waiting: 2, opportunities: 0, talent: 0, performance: 0, operations: 0, conversations: 0, inflow: { needsReply: 0, followUps: 0, waiting: 0, opportunities: 0 }, ...summary } } as unknown as MailDashboard;
}
function myWork(over: Partial<MyWorkItem> = {}): MyWorkItem {
  return { workInstanceId: 'w1', title: 'Production 1 · Kona unboxing — cut A', stageName: 'Edit', status: 'in_progress', verb: 'Resume', assignedLabel: 'Waiting 2 hours', href: '/app/admin/work/w1', expectedReturnAtIso: '2026-09-24T16:00:00Z', dueAtIso: null, ...over };
}
type Metrics = Parameters<typeof callGridKpis>[0]['metrics'];
const metrics = (over: Partial<Metrics> = {}): Metrics => ({ available: true, totalCalls: 20, billableCalls: 14, revenueCents: 112_000, profitCents: 61_000, costCents: 400, revenueCoverage: 1, profitCoverage: 1, ...over });
/** The Command Center's context, projected exactly as Home projects it: the contract's KPIs over today so far and yesterday to the same time. */
function callgrid(over: { current?: Partial<Metrics>; comparison?: Partial<Metrics> | null; withheld?: boolean; ok?: boolean; freshnessState?: string } = {}): HomeKpiStrip {
  const m = metrics(over.current);
  const c = over.comparison === null ? null : metrics({ totalCalls: 20, billableCalls: 9, revenueCents: 85_000, profitCents: 40_000, ...(over.comparison ?? {}) });
  return projectHomeKpis({
    kpis: callGridKpis({ keys: HOME_KPI_KEYS, metrics: m, comparison: c, series: [], comparisonWithheld: over.withheld }),
    window: { label: 'Sep 24, 2026', includesLiveData: true, comparisonLabel: c ? 'Yesterday to the same time' : null },
    coverage: { note: over.withheld ? 'Not compared: Loop’s call record starts Sep 24, after the comparison period began.' : null },
    freshness: { state: over.freshnessState ?? 'LIVE', word: 'Live', detail: 'CallGrid delivered data 3 min ago.' },
    report: { ok: over.ok ?? true, metrics: over.ok === false ? { ...m, available: false } : m, dimensions: { campaigns: [{ label: 'Campaign 1', monetized: 3, revenueCents: 50_000 }, { label: 'Campaign 2', monetized: 0, revenueCents: null }, { label: 'Campaign 3', monetized: 0, revenueCents: 1_000 }] } },
    query: 'period=day',
  });
}
function input(over: Partial<BriefingInput> = {}): BriefingInput {
  return {
    now: NOW, review: review(), period, headlines: [headline()], needsYou: [needsYou()], day: day({ events: DAY }), dayFailed: false, mail: mailDashboard('CURRENT'), mailFailed: false, callgrid: callgrid(),
    workDue: [], connectionsHref: '/app/connections', headlinesHref: '/app/admin/headlines', ...over,
  };
}
const deepFreeze = <T,>(v: T): T => {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v as object)) deepFreeze((v as Record<string, unknown>)[k]);
  }
  return v;
};
const brief = (over: Partial<BriefingInput> = {}): Briefing => composeBriefing(input(over));
const html = (node: React.ReactElement) => renderToStaticMarkup(node);

// --- the composer -------------------------------------------------------------------------------------

describe('the briefing is a pure projection of what the loaders returned', () => {
  it('imports no loader, repository, client or clock, and never mutates its input', () => {
    const src = code(read('../src/app/app/_home/briefing.ts'));
    for (const forbidden of ["from '@emgloop/database'", "from '@prisma/client'", 'prisma', 'fetch(', 'Math.random', 'new Date()', 'Date.now(', "'server-only'", "'use client'"]) {
      assert.equal(src.includes(forbidden), false, forbidden);
    }
    const frozen = deepFreeze(input());
    const a = composeBriefing(frozen);
    const b = composeBriefing(frozen);
    assert.deepEqual(a, b, 'deterministic');
    assert.deepEqual(frozen, input(), 'the input is exactly what it was');
  });

  it('answers the three questions in order and caps each: what changed, what needs you, then today and movement', () => {
    const b = brief();
    assert.ok(b.changes.length > 0 && b.attention.length > 0);
    assert.ok(b.changes.length <= BRIEFING_LIMITS.changes);
    assert.ok(b.attention.length <= BRIEFING_LIMITS.attention);
    const many = brief({ headlines: Array.from({ length: 9 }, (_, i) => headline({ id: `h${i}`, lastDetectedAt: `2026-09-24T0${i}:00:00Z` })) });
    assert.equal(many.changes.length, BRIEFING_LIMITS.changes);
    assert.ok(many.changesObserved > BRIEFING_LIMITS.changes, 'the cap is stated, not silently applied');
  });

  it('what changed: a Headline row carries what, the objective, the rule as its why, and its investigation link', () => {
    const row = brief().changes.find((c) => c.source === 'HEADLINES')!;
    assert.equal(row.what, 'Roofing lead revenue in Texas: $4,180 this week vs $6,940 last week (−40%)');
    assert.equal(row.where, 'Grow roofing lead revenue in Texas');
    assert.match(row.why, /^movement against an objective you set; coverage 86%; seen 2 runs$/);
    assert.equal(row.href, '/app/admin/headlines/h1');
    assert.equal(row.hrefLabel, 'Look into it');
    assert.equal(row.tone, 'critical', 'against the objective');
  });

  it('a dismissed Headline never reappears, whatever the read returned; an old one is not "since yesterday"', () => {
    const dismissed = headline({ id: 'gone', dismissedAt: '2026-09-23T10:00:00Z', dismissedByUserId: 'u', dismissedByName: 'Matt', dismissalBasis: 'IMMATERIAL' });
    const old = headline({ id: 'old', lastDetectedAt: '2026-09-10T06:10:00Z' });
    const b = brief({ headlines: [dismissed, old, headline()] });
    assert.deepEqual(b.changes.filter((c) => c.source === 'HEADLINES').map((c) => c.key), ['headline:h1']);
    assert.equal(brief({ headlines: null }).historyHref, null, 'no history link for a seat that cannot open Headlines');
    assert.equal(brief().historyHref, '/app/admin/headlines');
  });

  it('a Telegram change or commitment is "what changed"; every other Telegram item is "needs you" -- the same loader, split by its own category', () => {
    const b = brief({ needsYou: [needsYou({ id: 'chg', category: 'BUSINESS_CHANGE', title: 'Kona moved the two-reel delivery to October 11', nextStep: 'confirm the new date with Denise', deadline: null }), needsYou({ id: 'ask' })] });
    const change = b.changes.find((c) => c.key === 'needs-you:chg')!;
    assert.equal(change.source, 'TELEGRAM');
    assert.equal(change.why, 'the conversation named a change');
    assert.equal(change.next, 'confirm the new date with Denise');
    assert.equal(change.href, null, 'a private chat has no link');
    assert.equal(change.place, 'In Telegram');
    assert.equal(b.attention.some((a) => a.key === 'needs-you:chg'), false, 'not repeated as an obligation');
    assert.ok(b.attention.some((a) => a.key === 'needs-you:ask'));
    const old = brief({ needsYou: [needsYou({ id: 'old', category: 'BUSINESS_CHANGE', at: at('2026-09-20T12:00:00Z') })] });
    assert.equal(old.changes.some((c) => c.key === 'needs-you:old'), false, 'a change is "since yesterday", like every other change');
  });

  it('a review update already listed under needs you is not repeated as a change; CallGrid is one row and only when it moved', () => {
    const dup = review([{ ...mailContribution, updates: [update({ key: 'mail:t1', source: 'MAIL', at: at('2026-09-24T12:00:00Z'), href: '/app/mail/t1' })] }, workContribution]);
    const b = brief({ review: dup });
    assert.equal(b.changes.some((c) => c.key === 'update:mail:t1'), false);
    assert.ok(b.changes.some((c) => c.key === 'update:activity:a1' && c.why === 'work you can see moved a step (Work)'));
    const moved = brief().changes.find((c) => c.source === 'CALLGRID')!;
    // The contract's own figures and percentages (14 against 9 is +56%), the window's own comparison words.
    // Total calls did not move (20 against 20), so it is not part of the change row: only moved figures are.
    assert.match(moved.what, /^CallGrid: Revenue \$1,120 \(▲ 32%\) · Net Profit \$610 \(▲ 53%\) · Billable Calls 14 \(▲ 56%\)$/);
    assert.equal(moved.where, 'Today so far');
    assert.equal(moved.why, 'against yesterday to the same time; a move, not a verdict');
    const still = brief({ callgrid: callgrid({ comparison: { totalCalls: 20, billableCalls: 14, revenueCents: 112_000, profitCents: 61_000 } }) });
    assert.equal(still.changes.some((c) => c.source === 'CALLGRID'), false, 'no movement, no row');
    assert.equal(brief({ callgrid: callgrid({ ok: false }) }).changes.some((c) => c.source === 'CALLGRID'), false, 'could not be read, no row');
    assert.equal(brief({ callgrid: callgrid({ freshnessState: 'UNAVAILABLE' }) }).changes.some((c) => c.source === 'CALLGRID'), false, 'nothing ever delivered, no row');
    assert.equal(brief({ callgrid: null }).changes.some((c) => c.source === 'CALLGRID'), false, 'not offered, no row');
  });

  it('needs you: ranked by a named deadline, then the kind, then how long it has waited -- ordering only, the producers unchanged', () => {
    const rows = brief({
      needsYou: [
        needsYou({ id: 'follow', category: 'FOLLOW_UP', deadline: null, at: at('2026-09-24T12:00:00Z') }),
        needsYou({ id: 'decide', category: 'DECISION_NEEDED', deadline: null, at: at('2026-09-24T12:30:00Z') }),
        needsYou({ id: 'dated', category: 'REQUEST', deadline: 'by Friday', at: at('2026-09-24T13:00:00Z') }),
        needsYou({ id: 'older', category: 'DECISION_NEEDED', deadline: null, at: at('2026-09-24T08:00:00Z') }),
      ],
    }).attention.map((a) => a.key);
    // The named deadline first; then every critical kind (a decision, a reply that is critical) oldest first, whichever source raised it.
    assert.deepEqual(rows.slice(0, 4), ['needs-you:dated', 'needs-you:older', 'review:mail:t1', 'needs-you:decide']);
    assert.ok(rows.indexOf('review:mail:t1') < rows.indexOf('needs-you:follow'), 'a critical reply outranks a follow-up');
    assert.equal(rows[rows.length - 1], 'needs-you:follow');
    // The scores are on the rows, so the order can be read, not guessed.
    const dated = brief({ needsYou: [needsYou({ id: 'dated', deadline: 'by Friday' })] }).attention.find((a) => a.key === 'needs-you:dated')!;
    assert.ok(dated.score >= 100);
    const sorted = rankAttention([{ ...dated, key: 'x', score: 1 }, dated]).map((r) => r.key);
    assert.deepEqual(sorted, ['needs-you:dated', 'x']);
  });

  it('a Telegram obligation keeps who, what, the next step, the grounded deadline and its source; nothing is invented', () => {
    const row = brief().attention.find((a) => a.provider === 'TELEGRAM')!;
    assert.equal(row.where, 'Dana Reyes · Kickoff call');
    assert.equal(row.what, 'Dana Reyes asks to reschedule the Thursday kickoff call');
    assert.equal(row.next, 'Propose a new time');
    assert.equal(row.deadline, 'by Thursday');
    assert.equal(row.kindLabel, 'Request');
    assert.equal(row.href, null);
    assert.equal(row.place, 'In Telegram');
    const bare = brief({ needsYou: [needsYou({ counterparty: null, topic: null, nextStep: null, deadline: null, category: null })] }).attention.find((a) => a.provider === 'TELEGRAM')!;
    assert.deepEqual([bare.where, bare.next, bare.deadline, bare.kindLabel], [null, null, null, 'Needs you']);
  });

  it('the count says the whole truth: the review total plus the viewer’s own items, and where the rest are', () => {
    const b = brief();
    assert.equal(b.attentionTotal, review().attentionTotal + 1);
    assert.deepEqual(b.attentionElsewhere, review().attentionElsewhere);
    assert.equal(brief({ review: null }).attentionReadable, true, 'with no review, nothing is unreadable');
  });

  it('today: the calendar as read, work due today from dates the Work OS rows carry, and mail as counts', () => {
    const b = brief({ workDue: dueTodayFromWork([myWork(), myWork({ workInstanceId: 'w2', title: 'Tomorrow', expectedReturnAtIso: '2026-09-25T16:00:00Z' }), myWork({ workInstanceId: 'w3', title: 'Undated', expectedReturnAtIso: null })], time.startOfDay(), new Date(time.startOfDay().getTime() + 86_400_000)) });
    assert.deepEqual(b.today.calendar, { state: 'READ', current: true, readAt: new Date(NOW.getTime() - 4 * 60_000), failed: false });
    assert.deepEqual(b.today.events.map((e) => e.eventId), ['daily', 'brand', 'weekly']);
    assert.equal(b.today.inProgress?.eventId, 'brand');
    assert.deepEqual(b.today.due.map((d) => [d.what, d.detail, d.href]), [['Production 1 · Kona unboxing — cut A', 'expected back · Edit', '/app/admin/work/w1']]);
    assert.deepEqual(b.today.mailCounts, { needsReply: 3, followUps: 1, waiting: 2, current: true });
    assert.equal(b.sentence.meetings, 3);
    assert.equal(b.sentence.inProgress, true);
  });

  it('the employee seat: due today comes from its own queue rows -- only a current stage this person owns, dated by the row itself, linked into the employee tree', () => {
    const me = 'user_charlie';
    const dayStart = time.startOfDay();
    const dayEnd = new Date(dayStart.getTime() + 86_400_000);
    const stage = (over: Partial<QueueInstance['stages'][number]> = {}) => ({ id: 's-edit', name: 'Edit', ownerUserId: me, status: 'in_progress', dueAt: null, ...over });
    const row = (over: Partial<QueueInstance> = {}): QueueInstance => ({ id: 'w1', title: 'Production 1 · Kona unboxing — cut A', currentStageId: 's-edit', expectedReturnAt: at('2026-09-24T16:00:00Z'), stages: [stage()], ...over });
    const href = (id: string) => `/app/employee/work/${id}`;
    const rows = dueTodayFromQueue(
      [
        row(), // expected back today, my current step
        row({ id: 'w2', title: 'Step due today', expectedReturnAt: null, stages: [stage({ dueAt: at('2026-09-24T18:00:00Z') })] }),
        row({ id: 'w3', title: 'Waiting on someone else', stages: [stage({ ownerUserId: 'user_other' })] }),
        row({ id: 'w4', title: 'My later step, not current', currentStageId: 's-other', stages: [stage({ id: 's-other', ownerUserId: 'user_other' }), stage({ id: 's-mine', status: 'pending' })] }),
        row({ id: 'w5', title: 'Tomorrow', expectedReturnAt: at('2026-09-25T16:00:00Z') }),
        row({ id: 'w6', title: 'Undated', expectedReturnAt: null }),
        row({ id: 'w7', title: 'Completed step', stages: [stage({ status: 'completed' })] }),
      ],
      me,
      dayStart,
      dayEnd,
      href,
    );
    assert.deepEqual(rows.map((d) => [d.what, d.detail, d.href, time.time(d.at)]), [
      ['Production 1 · Kona unboxing — cut A', 'expected back · Edit', '/app/employee/work/w1', '12:00 PM'],
      ['Step due today', 'Edit due', '/app/employee/work/w2', '2:00 PM'],
    ]);
    const b = brief({ review: null, callgrid: null, headlines: null, period: null, workDue: rows });
    assert.equal(b.today.due.length, 2);
    assert.match(html(<TodayPanel today={b.today} time={time} mailHref="/app/mail" />), /Due today[\s\S]*href="\/app\/employee\/work\/w1"[\s\S]*expected back · Edit/);
  });

  it('a source that is not connected is one line with its way in; one Loop is not set up for says nothing; one that failed says it failed', () => {
    const notConnected = brief({ day: day({ freshness: 'CAPABILITY_NOT_GRANTED' }), mail: mailDashboard('NOT_CONNECTED') });
    assert.deepEqual(notConnected.today.calendar, { state: 'NOT_CONNECTED', line: 'Calendar isn’t connected, so your day isn’t here yet.', href: '/app/connections', action: 'Connect Calendar' });
    assert.equal(notConnected.today.mail.state, 'NOT_CONNECTED');
    assert.equal(notConnected.today.mailCounts, null);
    assert.equal(notConnected.today.events.length, 0);
    assert.deepEqual(brief({ day: day({ freshness: 'AUTHORIZATION_EXPIRED' }) }).today.calendar, { state: 'NOT_CONNECTED', line: 'Google no longer accepts this connection, so your calendar isn’t here.', href: '/app/connections', action: 'Reconnect Calendar' });
    assert.deepEqual(brief({ day: null, mail: null }).today.calendar, { state: 'NOT_CONFIGURED' });
    assert.deepEqual(brief({ day: null, dayFailed: true }).today.calendar, { state: 'UNAVAILABLE', line: 'Loop could not open your calendar just now.' });
    assert.deepEqual(brief({ mail: null, mailFailed: true }).today.mail, { state: 'UNAVAILABLE', line: 'Loop could not open your mail just now.' });
    // A clear day is clear only when Loop read the calendar: a never-read one is unread, an old read says so.
    assert.deepEqual(brief({ day: day({ freshness: 'NEVER_SYNCED', lastSyncedAt: null, events: [] }) }).today.calendar, { state: 'NOT_READ', line: 'Loop has not read your calendar yet.' });
    assert.equal(brief({ day: day({ freshness: 'NEVER_SYNCED', lastSyncedAt: null, events: [] }) }).sentence.meetings, null, 'no "no meetings" claim about an unread calendar');
    const stale = brief({ day: day({ freshness: 'STALE', lastSyncedAt: at('2026-09-24T10:00:00Z') }) }).today.calendar;
    assert.deepEqual(stale, { state: 'READ', current: false, readAt: at('2026-09-24T10:00:00Z'), failed: false });
    const failed = brief({ day: day({ freshness: 'SYNC_FAILED', lastSyncedAt: at('2026-09-24T10:00:00Z') }) }).today.calendar;
    assert.deepEqual(failed, { state: 'READ', current: false, readAt: at('2026-09-24T10:00:00Z'), failed: true });
    assert.equal(brief({ day: day({ freshness: 'SYNC_FAILED', lastSyncedAt: null, events: [] }) }).today.calendar.state, 'NOT_READ', 'a failed first read is not an empty day');
    // Mail: the read model's own verdict is honoured -- nothing to conclude from is unread, an old read is not current.
    assert.deepEqual(brief({ mail: mailDashboard('NEVER_SYNCED') }).today.mail, { state: 'NOT_READ', line: 'Loop has not read your mail yet.' });
    assert.equal(brief({ mail: mailDashboard('NEVER_SYNCED') }).today.mailCounts, null, 'no counts of a mailbox Loop has not read');
    assert.equal(brief({ mail: mailDashboard('CURRENT', {}, { concludable: false }) }).today.mail.state, 'NOT_READ');
    assert.equal(brief({ mail: mailDashboard('STALE', {}, { current: false }) }).today.mailCounts?.current, false);
  });

  it('there is no pulse: figures live on the KPI row, and CallGrid is compared only the way the Command Center compares it', () => {
    assert.equal('pulse' in brief(), false, 'the plan carries no figures of its own');
    const src = code(read('../src/app/app/_home/briefing.ts'));
    for (const forbidden of ['easternYesterdayWindow', 'easternTodayWindow', 'trend(', 'metricValue(', 'yesterday complete', 'DashboardData', 'dashboard-data']) assert.equal(src.includes(forbidden), false, forbidden);
    // The row's why is the window's own comparison label, verbatim: never "yesterday" alone against a partial day.
    const row = brief().changes.find((c) => c.source === 'CALLGRID')!;
    assert.match(row.why, /yesterday to the same time/);
    assert.equal(/\byesterday\b(?! to the same time)/.test(row.why), false);
    // A comparison Loop's record does not cover is withheld by the context, and then there is no row at all.
    const withheld = callgrid({ comparison: null, withheld: true });
    assert.equal(withheld.comparisonLabel, null);
    assert.equal(brief({ callgrid: withheld }).changes.some((c) => c.source === 'CALLGRID'), false);
    // The aggregate Headlines row leaves Needs you when Home draws the Headlines panel, and the total says so.
    const headlinesRow = { ...mailContribution, source: 'HEADLINES' as const, attention: [attention({ key: 'headlines', source: 'HEADLINES', who: 'Headlines', happened: 'One thing needs your attention.', next: 'Review', tone: 'attention', href: '/app/admin/headlines' })], attentionCount: undefined, updates: [], metrics: undefined };
    const withRow = brief({ review: review([mailContribution, workContribution, headlinesRow]) });
    const withPanel = brief({ review: review([mailContribution, workContribution, headlinesRow]), headlinesPanel: true });
    assert.ok(withRow.attention.some((a) => a.source === 'HEADLINES'));
    assert.equal(withPanel.attention.some((a) => a.source === 'HEADLINES'), false);
    assert.equal(withPanel.attentionTotal, withRow.attentionTotal - 1);
    assert.equal(withPanel.sentence.attention, withPanel.attentionTotal);
  });

  it('the sentence is the facts in words, and names the sources it read and the ones it could not', () => {
    const words = briefingWords(brief().sentence, time);
    assert.match(words.lead, /^Since .*: 4 things changed, 6 need you, one by Thursday\. Your day has 3 meetings, one on now\.$/);
    assert.equal(brief().sentence.attention, brief().attentionTotal, 'the sentence counts what the list counts');
    assert.match(words.sources!, /From your mail, Loop work, Telegram\./);
    assert.match(words.sources!, /Not read: your calendar — Loop has not read your calendar yet; CallGrid — Loop could not read CallGrid just now; Headlines — Loop could not read Headlines just now\./);
    const quiet = briefingWords(brief({ review: review([{ source: 'MAIL', state: 'OK', attention: [], updates: [] }]), headlines: [], needsYou: [], callgrid: null, day: null, mail: null }).sentence, time);
    assert.match(quiet.lead, /nothing changed in what Loop can read, nothing needs you\./i);
    for (const forbidden of ['accelerat', 'major', 'urgent', 'momentum', 'strong week', 'probably']) assert.equal(words.lead.toLowerCase().includes(forbidden), false, forbidden);
    // The module Home, with nothing but the viewer's own sources, still says what it read.
    const own = briefingWords(brief({ review: null, callgrid: null, headlines: null, period: null }).sentence, time);
    assert.match(own.sources!, /From your calendar, your mail, Telegram\./);
    const unread = briefingWords(brief({ review: null, callgrid: null, headlines: null, period: null, day: day({ freshness: 'NEVER_SYNCED', lastSyncedAt: null }), mail: mailDashboard('NEVER_SYNCED') }).sentence, time);
    assert.match(unread.sources!, /Not read: your calendar — not read yet; your mail — not read yet\./);
  });
});

// --- the views ----------------------------------------------------------------------------------------

describe('the briefing, drawn', () => {
  it('what changed: what, the source, why, next, when -- and a way back; a Telegram row says where it is and has no link', () => {
    const out = html(<WhatChanged briefing={brief({ needsYou: [needsYou({ id: 'chg', category: 'BUSINESS_CHANGE', title: 'Kona moved the two-reel delivery to October 11', nextStep: 'confirm the new date with Denise' })] })} time={time} />);
    assert.match(out, /id="what-changed"/);
    assert.match(out, /Roofing lead revenue in Texas/);
    assert.match(out, /data-briefing-why[^>]*>Why: movement against an objective you set/);
    assert.match(out, /href="\/app\/admin\/headlines\/h1"[^>]*>Look into it/);
    assert.match(out, /href="\/app\/admin\/headlines"[^>]*>Headlines history →/);
    assert.match(out, /data-briefing-provider="TELEGRAM"/);
    assert.match(out, /data-briefing-next[^>]*>Next: confirm the new date with Denise/);
    assert.match(out, /In Telegram/);
    const telegramRow = out.slice(out.indexOf('data-briefing-change="TELEGRAM"'), out.indexOf('</li>', out.indexOf('data-briefing-change="TELEGRAM"')));
    assert.equal(telegramRow.includes('href='), false, 'no fabricated deep link for a private chat');
    assert.match(out, /datetime="2026-09-24T06:10:00\.000Z"/i);
    assert.match(html(<WhatChanged briefing={brief({ headlines: [], needsYou: [], review: review([{ source: 'MAIL', state: 'OK', attention: [], updates: [] }]), callgrid: null })} time={time} />), /Nothing changed in what Loop can read since yesterday\./);
  });

  it('needs you: ranked rows with who, what, kind, the grounded deadline, next and source; minimized, no forms, no invented fields', () => {
    const out = html(<NeedsAttention briefing={brief()} time={time} />);
    assert.match(out, /id="needs-attention"/);
    assert.match(out, /data-briefing-attention="TELEGRAM"[^>]*data-briefing-provider="TELEGRAM"/);
    assert.match(out, /Dana Reyes · Kickoff call/);
    assert.ok(out.includes('Dana Reyes asks to reschedule the Thursday kickoff call'), 'WHAT, as the minimized paraphrase');
    assert.match(out, /data-briefing-next[^>]*>Next: Propose a new time/);
    assert.match(out, /data-briefing-deadline[^>]*>Due by Thursday/);
    assert.ok(out.includes('Request'), 'the category in plain words');
    assert.ok(out.includes('still open as of'), 'still unresolved at the last review');
    assert.ok(out.includes('In Telegram'), 'points back to the source');
    assert.match(out, /Dana Rivera/);
    assert.match(out, /href="\/app\/mail\/t1"[^>]*>Reply/);
    assert.match(out, /href="\/app\/admin\/work\/w9"[^>]*>Assign/);
    assert.match(out, /Showing 3 of 6\./);
    const many = html(<WhatChanged briefing={brief({ headlines: Array.from({ length: 9 }, (_, i) => headline({ id: `h${i}`, lastDetectedAt: `2026-09-24T0${i}:00:00Z` })) })} time={time} />);
    assert.match(many, /Not shown: \d+ earlier changes\./, 'the hidden rows are older, and it says so');
    assert.match(out, /href="\/app\/mail"[^>]*>3 more in Mail →/);
    assert.equal(/<form\b|<button\b/.test(out), false, 'corrections live on the source, not as buttons on Home');
    assert.equal(/\bnull\b|\bundefined\b/.test(out), false);
    const bareAll = html(<NeedsAttention briefing={brief({ needsYou: [needsYou({ counterparty: null, topic: null, nextStep: null, deadline: null })] })} time={time} />);
    const bare = bareAll.slice(bareAll.indexOf('data-briefing-attention="TELEGRAM"'), bareAll.indexOf('</li>', bareAll.indexOf('data-briefing-attention="TELEGRAM"')));
    assert.equal(bare.includes('data-briefing-deadline'), false);
    assert.equal(bare.includes('Due '), false);
    assert.equal(bare.includes('Next:'), false);
    assert.equal(bare.includes('href='), false);
    for (const forbidden of ['urgent', 'important', 'probably', 'seems', 'priority']) assert.equal(out.toLowerCase().includes(forbidden), false, forbidden);
  });

  it('needs you says which kind of empty it is', () => {
    const none = brief({ needsYou: [], review: review([{ source: 'MAIL', state: 'OK', attention: [], updates: [], metrics: { needAttention: { state: 'VALUE', value: 0, prior: null, href: null, scope: 'x' } } }]) });
    assert.match(html(<NeedsAttention briefing={none} time={time} />), /Nothing needs you right now in what Loop can read\./);
    const unreadable = html(<NeedsAttention briefing={brief({ needsYou: [], review: review([{ source: 'MAIL', state: 'UNAVAILABLE', note: 'x' }]) })} time={time} />);
    assert.match(unreadable, /could not read the sources/);
    assert.equal(unreadable.includes('Nothing needs you'), false);
  });

  it('today: events in the reader’s zone from stored columns only, the one on now marked, work due today, and mail as a line of counts', () => {
    const out = html(<TodayPanel today={brief({ workDue: dueTodayFromWork([myWork()], time.startOfDay(), new Date(time.startOfDay().getTime() + 86_400_000)) }).today} time={time} mailHref="/app/mail" />);
    assert.match(out, /id="today"/);
    assert.match(out, /3 meetings/);
    assert.match(out, /9:30 AM/);
    assert.match(out, /11:00 AM/);
    assert.equal(/>[^<]*13:30/.test(out), false, 'no UTC time is rendered as text');
    assert.match(out, /class="is-live"[\s\S]*?Harbor \/ Kona — reel review/);
    assert.match(out, /6 people/);
    assert.match(out, /3 people · external/);
    assert.match(out, /video call/);
    assert.match(out, /organizer: you/);
    assert.match(out, /Due today/);
    assert.match(out, /href="\/app\/admin\/work\/w1"/);
    assert.match(out, /expected back · Edit/);
    assert.match(out, /12:00 PM/);
    assert.match(out, /data-briefing-mail[^>]*>3 need a reply · 1 follow-up due · 2 waiting on others/);
    assert.match(out, /href="\/app\/mail"[^>]*>Open Mail →/);
    assert.match(out, /href="https:\/\/calendar\.google\.com\/"[^>]*target="_blank"/);
    for (const absent of ['>Week<', '>Month<', 'View Full Calendar', 'href="mailto']) assert.equal(out.includes(absent), false, absent);
  });

  it('today: a source that is not connected is one line with its way in; a clear day is clear only after a read; nothing configured renders nothing', () => {
    const notConnected = html(<TodayPanel today={brief({ day: day({ freshness: 'CAPABILITY_NOT_GRANTED' }), mail: mailDashboard('NOT_CONNECTED') }).today} time={time} mailHref="/app/mail" />);
    assert.match(notConnected, /data-briefing-source-state="NOT_CONNECTED" data-briefing-source-of="calendar"/);
    assert.match(notConnected, /Calendar isn’t connected, so your day isn’t here yet\.[\s\S]*?href="\/app\/connections"[^>]*>Connect Calendar/);
    assert.match(notConnected, /Mail isn’t connected\. Loop shows only your own Gmail once it is\.[\s\S]*?href="\/app\/connections"[^>]*>Connect Google/);
    assert.equal(notConnected.includes('need a reply'), false, 'no counts of a mailbox Loop has not read');
    assert.equal(notConnected.includes('loop-brief__tl'), false);
    const expired = html(<TodayPanel today={brief({ mail: mailDashboard('AUTHORIZATION_EXPIRED') }).today} time={time} mailHref="/app/mail" />);
    assert.match(expired, /Google no longer accepts this connection[\s\S]*?Reconnect Google/);
    assert.match(html(<TodayPanel today={brief({ day: day({ events: [] }) }).today} time={time} mailHref="/app/mail" />), /No meetings on your calendar today\./);
    assert.match(html(<TodayPanel today={brief({ mail: mailDashboard('CURRENT', { needsReply: 0, followUps: 0, waiting: 0 }) }).today} time={time} mailHref="/app/mail" />), /Nothing in your mail needs you right now\./);
    const staleMail = html(<TodayPanel today={brief({ mail: mailDashboard('STALE', { needsReply: 0, followUps: 0, waiting: 0 }, { current: false }) }).today} time={time} mailHref="/app/mail" />);
    assert.match(staleMail, /Nothing in your mail needed you when Loop last read it\./);
    assert.equal(staleMail.includes('right now'), false);
    assert.match(staleMail, /Loop last read your mail 4 minutes ago\./);
    const neverRead = html(<TodayPanel today={brief({ day: day({ freshness: 'NEVER_SYNCED', lastSyncedAt: null }), mail: mailDashboard('NEVER_SYNCED') }).today} time={time} mailHref="/app/mail" />);
    assert.match(neverRead, /data-briefing-source-state="NOT_READ" data-briefing-source-of="calendar"[\s\S]*Loop has not read your calendar yet\./);
    assert.equal(neverRead.includes('No meetings on your calendar today'), false, 'an unread calendar is never an empty one');
    assert.match(neverRead, /Loop has not read your mail yet\./);
    const failedRead = html(<TodayPanel today={brief({ day: day({ freshness: 'SYNC_FAILED', lastSyncedAt: at('2026-09-24T10:00:00Z'), events: DAY }) }).today} time={time} mailHref="/app/mail" />);
    assert.match(failedRead, /Loop could not reach Google just now\. This is your calendar as Loop last read it, 5 hours ago\./);
    assert.match(failedRead, /Team Daily/);
    assert.equal(html(<TodayPanel today={brief({ day: null, mail: null }).today} time={time} mailHref="/app/mail" />), '', 'no source set up, no panel');
    assert.match(html(<TodayPanel today={brief({ day: null, dayFailed: true, mail: null }).today} time={time} mailHref="/app/mail" />), /could not open your calendar/);
  });

  it('the lead sentence is on the page as text, with the sources beside it', () => {
    const out = html(<BriefingLead briefing={brief()} time={time} />);
    assert.match(out, /data-briefing-lead[^>]*>Since .*4 things changed, 6 need you, one by Thursday\./);
    assert.match(out, /From your mail, Loop work, Telegram\./);
  });

  it('the views are server components over the plan and draw with the design system only', () => {
    const view = read('../src/app/app/_home/briefing-view.tsx');
    assert.equal(view.includes("'use client'"), false);
    for (const forbidden of ["from '@emgloop/database'", 'prisma', 'fetch(', 'dangerouslySetInnerHTML', 'style=']) assert.equal(code(view).includes(forbidden), false, forbidden);
    const css = read('../src/app/loop-os.css');
    const classes = [...view.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)].flatMap((m) => (m[1] ?? m[2] ?? '').replace(/\$\{[^}]*\}/g, '').split(/\s+/)).filter((c) => /^[a-z][a-z0-9_-]*$/.test(c));
    for (const c of new Set(classes)) assert.ok(css.includes(`.${c}`), `${c} is a Loop class`);
  });
});

// --- the two Homes -----------------------------------------------------------------------------------

describe('both Homes compose the same briefing from the page’s reads, and load nothing of the viewer’s themselves', () => {
  it('the page loads day, mail and needs-you once each with the session principal and hands them to whichever Home renders', () => {
    const page = code(read('../src/app/app/page.tsx'));
    assert.match(page, /const principal = \{ organizationId: session\.organizationId, userId: session\.userId \};/);
    for (const loader of ['loadYourDay(principal)', 'loadMailDashboard(principal', 'loadNeedsYou(principal)']) assert.equal(page.split(loader).length - 1, 1, loader);
    // The employee seat's own queue: the same guarded read its My Work page makes, and only for that seat.
    assert.match(page, /role === 'EMPLOYEE' \? settle\(\(\) => loadMyQueueForHome\(\)\) : Promise\.resolve\(null\),/);
    assert.equal(page.split('loadMyQueueForHome(').length - 1, 1);
    assert.match(page, /<ModuleHome[^>]*queue=\{queue\}/);
    assert.equal(page.includes('loadWorkspaceHome') || page.includes('loadDashboard') || page.includes('loadEmployeeWork'), false, 'no admin loader and no wider employee read for Home');
    assert.match(page, /<AdminHome[^>]*needsYou=\{needsYou\}/);
    assert.match(page, /<ModuleHome[^>]*needsYou=\{needsYou\}/);
    assert.match(page, /<CreatorHome seat=\{creatorSeat\} time=\{time\} \/>/, 'the creator Home is untouched');
    assert.equal(page.includes('composeBriefing'), false, 'the page loads; the Homes compose');
  });

  it('the executive Home states its authority first, loads only the organization reads, and composes -- it never reads the viewer’s items or a second time', () => {
    const home = code(read('../src/app/app/_home/admin-home.tsx'));
    const body = home.slice(home.indexOf('export async function AdminHome'));
    assert.ok(body.indexOf("await requireWorkspace('ADMIN')") < body.indexOf('loadHome('), 'authority before any read');
    assert.ok(body.indexOf("await requireWorkspace('ADMIN')") < body.indexOf('loadFrontDoor('), 'authority before the front door reads too');
    for (const forbidden of ['loadNeedsYou', 'loadYourDay', 'loadMailDashboard', 'prisma', 'repositories', 'loadDashboard', 'PulsePanel']) assert.equal(home.includes(forbidden), false, forbidden);
    assert.match(body, /composeBriefing\(\{[\s\S]*?headlines: review\?\.headlines \?\? null,[\s\S]*?needsYou,/);
    assert.match(body, /callgrid,[\s\S]*?headlinesPanel: showHeadlines,/, 'the projected command context in, the aggregate Headlines row out');
    // The front door's order: KPIs, the briefing, Headlines, recent activity; beside them the day and needs you; then the tools.
    assert.match(body, /<KpiStrip[\s\S]*<BriefingLead[\s\S]*<WhatChanged[\s\S]*<HeadlinesPanel[\s\S]*<RecentActivityPanel[\s\S]*<TodayPanel[\s\S]*<NeedsAttention[\s\S]*<ToolsGrid/, 'the approved order');
    assert.match(body, /const auditHref = navOffers\(groups, AUDIT_PATH\) \? AUDIT_PATH : null;/, 'Home links to the audit log only where the rail would');
    const review = code(read('../src/app/app/_home/review-data.ts'));
    assert.match(review, /loadAttention\(organizationId, new Date\(\), \{ dismissed: false \}\)/, 'the Home read excludes dismissed Headlines');
    assert.equal(review.includes('loadNeedsYou'), false, 'the review never reads the employee-private items');
  });

  it('the module Home composes from the viewer’s own sources only and keeps the areas they can open', () => {
    const home = code(read('../src/app/app/_home/module-home.tsx'));
    for (const forbidden of ['loadNeedsYou', 'loadDashboard', 'loadExecutiveReview', 'loadMyQueueForHome', 'loadEmployeeWork', 'prisma', 'repositories']) assert.equal(home.includes(forbidden), false, forbidden);
    assert.match(home, /review: null,[\s\S]*?callgrid: null,/);
    for (const absent of ['KpiStrip', 'HeadlinesPanel', 'RecentActivityPanel', 'loadFrontDoor']) assert.equal(home.includes(absent), false, `${absent}: not this seat's to read`);
    assert.match(home, /workDue: dueTodayFromQueue\(queue, userId, dayStart, dayEnd, \(id\) => `\/app\/employee\/work\/\$\{encodeURIComponent\(id\)\}`\),/);
    // The narrow loader: the queue page's guard and read, nothing more.
    const loader = code(read('../src/app/app/employee/work/work-data.ts'));
    const narrow = loader.slice(loader.indexOf('export async function loadMyQueueForHome'), loader.indexOf('export async function listMyCompletedToday'));
    assert.match(narrow, /const actor = await requireEmployeeActor\(\);/);
    assert.match(narrow, /workRepo\(\)\.listMyWork\(actor\.userId, actor\.organizationId\)/);
    for (const extra of ['getMyNextAction', 'listMyCompletedToday', 'listNotifications', 'prisma.']) assert.equal(narrow.includes(extra), false, extra);
    assert.match(home, /<BriefingLead[\s\S]*<TodayPanel[\s\S]*<NeedsAttention[\s\S]*<ToolsGrid/);
  });
});
