// The Home briefing: ONE pure composition over what the existing loaders already return
// (approved design pass, 2026-09-24). Home answers three questions in order -- what changed that
// matters, what needs you, what to do next -- and then shows movement, not dashboards.
//
// PURE, AND ONLY A PROJECTION. This module imports no loader, no repository, no clock and no
// randomness: the page loads each source on its own (as before) and hands the results in; the
// composer reads them and returns a plan the views render. It never writes, never widens a scope
// and never invents: a row exists only where a source produced the fact, a deadline is only ever
// the words a conversation wrote, a Telegram row has no link because a private chat has none, and
// a "why" for a source that carries no rule is a fixed phrase that says which source moved.
//
// ORDERING IS PRESENTATION. The Telegram loader still returns its items by recency, the executive
// review still ranks its own; interleaving them here for display changes neither producer.
//
// EMPLOYEE-PRIVATE STAYS EMPLOYEE-PRIVATE. The "needs you" items are the viewer's own, loaded once
// by the page with the session principal. They are carried through this composer as data and
// rendered with their source on the row; they are never folded into an organization decision, a
// count for anyone else, or a metric.

import {
  counted,
  type ExecutiveReview,
  type HeadlineView,
  type ReviewAttention,
  type ReviewPeriod,
  type ReviewSourceId,
  type ReviewUpdate,
  type TimeView,
  type WorkSourceFreshness,
  REVIEW_SOURCE_LABELS,
  trend,
  metricValue,
  type TrendResult,
} from '@emgloop/shared';
import type { DayEvent } from '@emgloop/shared';
import type { NeedsYouItem } from '../../../daily-loop/needs-you';
import type { YourDayView } from '../../../daily-loop/your-day';
import type { MailDashboard } from '../../../daily-loop/mail-dashboard';
import type { DashboardData } from '../admin/dashboard-data';
import type { MyWorkItem } from '../admin/workspace-home-data';

// --- Limits and vocabulary -------------------------------------------------------------------------

/** A briefing is capped, not paginated: it is read, not browsed. */
export const BRIEFING_LIMITS = Object.freeze({ changes: 5, attention: 6, dueToday: 4 });

/** Where a row came from. Telegram is named by its provider; the rest by the review's source ids. */
export type BriefingSource = ReviewSourceId | 'TELEGRAM';

export const BRIEFING_SOURCE_LABELS: Readonly<Record<BriefingSource, string>> = Object.freeze({
  MAIL: 'Mail',
  CALENDAR: 'Calendar',
  CALLGRID: 'CallGrid',
  WORK: 'Loop work',
  HEADLINES: 'Headline',
  TELEGRAM: 'Telegram',
});

export type BriefingTone = 'critical' | 'attention' | 'good' | 'neutral';

/**
 * The Telegram triage categories that are "what changed" rather than "needs you": a conversation
 * that named a change or a commitment. Every other category is something the person still owes.
 */
export const CHANGE_CATEGORIES: readonly string[] = Object.freeze(['BUSINESS_CHANGE', 'COMMITMENT']);

/** The category, in plain words for the person. Presentation only; the vocabulary is the AI task's. */
export const CATEGORY_LABELS: Readonly<Record<string, string>> = Object.freeze({
  REQUEST: 'Request',
  DECISION_NEEDED: 'Decision needed',
  COMMITMENT: 'Commitment',
  DEADLINE: 'Deadline',
  BUSINESS_CHANGE: 'Change',
  PROBLEM: 'Problem',
  FOLLOW_UP: 'Follow-up',
  OTHER: 'Needs you',
  NONE: 'Needs you',
});

/**
 * How pressing a kind of obligation is, for ordering only. A named deadline outranks every kind;
 * within a kind, the older item comes first. These weights order rows; they decide nothing.
 */
const CATEGORY_WEIGHT: Readonly<Record<string, number>> = Object.freeze({
  DECISION_NEEDED: 40,
  DEADLINE: 40,
  PROBLEM: 35,
  REQUEST: 25,
  COMMITMENT: 25,
  BUSINESS_CHANGE: 15,
  FOLLOW_UP: 10,
  OTHER: 5,
  NONE: 5,
});
const TONE_WEIGHT: Readonly<Record<BriefingTone, number>> = Object.freeze({ critical: 40, attention: 25, good: 10, neutral: 10 });
const DEADLINE_BOOST = 100;

/** Where a Telegram row points back to: the conversation, in the app it lives in. No URL exists. */
export const TELEGRAM_PLACE = 'In Telegram';

// --- The plan the views render --------------------------------------------------------------------

export interface BriefingChange {
  readonly key: string;
  readonly source: BriefingSource;
  /** The source's own label for where it happened (a Telegram chat's label, a mail counterpart). */
  readonly where: string | null;
  readonly what: string;
  /** Why Loop surfaced it: a rule's own description, or a fixed phrase naming what moved. */
  readonly why: string;
  readonly next: string | null;
  readonly at: Date | null;
  readonly tone: BriefingTone;
  readonly href: string | null;
  readonly hrefLabel: string | null;
  /** For a source with no link: where the thing is. */
  readonly place: string | null;
  readonly provider: 'TELEGRAM' | null;
}

export interface BriefingAttention {
  readonly key: string;
  readonly source: BriefingSource;
  readonly where: string | null;
  readonly what: string;
  readonly kindLabel: string;
  readonly kindTone: BriefingTone;
  /** Only ever the words the source wrote (a Telegram deadline is grounded text, never a date). */
  readonly deadline: string | null;
  readonly next: string | null;
  readonly since: Date | null;
  readonly href: string | null;
  readonly hrefLabel: string | null;
  readonly place: string | null;
  readonly provider: 'TELEGRAM' | null;
  /** The ordering score, kept on the row so a test (or a reader) can see why it sits where it does. */
  readonly score: number;
  /** The producer's own rank within its source (the review's `rank`; 1 for a Telegram item): a tiebreak, never a score. */
  readonly rank: number;
}

export type BriefingSourceState =
  | { readonly state: 'READ' }
  | { readonly state: 'NOT_CONNECTED'; readonly line: string; readonly href: string; readonly action: string }
  | { readonly state: 'UNAVAILABLE'; readonly line: string }
  /** Loop is not set up for this source at all: nothing is said about it. */
  | { readonly state: 'NOT_CONFIGURED' };

export interface BriefingDue {
  readonly key: string;
  readonly at: Date;
  readonly what: string;
  readonly detail: string;
  readonly href: string | null;
}

export interface BriefingToday {
  readonly calendar: BriefingSourceState;
  /** Timed events today, in start order (all-day ones are counted, not listed). */
  readonly events: readonly DayEvent[];
  readonly allDayCount: number;
  readonly inProgress: DayEvent | null;
  readonly next: DayEvent | null;
  readonly minutesUntilNext: number | null;
  readonly afternoonClear: boolean | null;
  readonly lastSyncedAt: Date | null;
  readonly due: readonly BriefingDue[];
  readonly mail: BriefingSourceState;
  readonly mailCounts: { readonly needsReply: number; readonly followUps: number; readonly waiting: number } | null;
}

export interface BriefingKpi {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  readonly delta: { readonly kind: 'up' | 'down' | 'new'; readonly text: string } | null;
  readonly sub: string | null;
  readonly href: string | null;
  /** What was counted, in the source's own words. */
  readonly scope: string;
}

export interface BriefingPulse {
  readonly kpis: readonly BriefingKpi[];
  /** Figures that did not move, named once in one sentence. */
  readonly unchanged: readonly string[];
  /** Figures Loop does not track or could not read, with the reason, never drawn as a zero. */
  readonly omitted: readonly { readonly label: string; readonly reason: string }[];
}

export interface BriefingSentence {
  readonly since: Date | null;
  readonly changes: number;
  readonly attention: number;
  /** The soonest deadline named by an attention row, in the source's own words. */
  readonly soonestDeadline: string | null;
  readonly meetings: number | null;
  readonly nextMeetingIn: number | null;
  readonly inProgress: boolean;
  readonly read: readonly string[];
  readonly notRead: readonly { readonly label: string; readonly note: string }[];
}

export interface Briefing {
  readonly sentence: BriefingSentence;
  readonly changes: readonly BriefingChange[];
  /** How many change-shaped observations there were before the cap. */
  readonly changesObserved: number;
  readonly historyHref: string | null;
  readonly attention: readonly BriefingAttention[];
  readonly attentionTotal: number;
  readonly attentionElsewhere: readonly { readonly source: ReviewSourceId; readonly count: number; readonly href: string | null }[];
  /** Which kind of empty "needs you" is: nothing, or nothing readable. */
  readonly attentionReadable: boolean;
  readonly today: BriefingToday;
  readonly pulse: BriefingPulse | null;
}

// --- Input: the loaders' outputs, as the page settled them ------------------------------------------

export interface BriefingInput {
  readonly now: Date;
  /** The executive review and its period; null for a seat that has none (the module Home). */
  readonly review: ExecutiveReview | null;
  readonly period: ReviewPeriod | null;
  /** Non-dismissed Headlines read for this organization; null when the seat cannot open Headlines. */
  readonly headlines: readonly HeadlineView[] | null;
  /** The viewer's own items, from the one employee-private loader, with the session principal. */
  readonly needsYou: readonly NeedsYouItem[];
  readonly day: YourDayView | null;
  readonly dayFailed: boolean;
  readonly mail: MailDashboard | null;
  readonly mailFailed: boolean;
  readonly dashboard: DashboardData | null;
  /** Work expected back or due today, from the Work OS read the seat already has. */
  readonly workDue: readonly BriefingDue[];
  readonly connectionsHref: string;
  readonly headlinesHref: string;
}

// --- Helpers ---------------------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

function toneOf(t: ReviewAttention['tone'] | ReviewUpdate['tone']): BriefingTone {
  return t;
}

function sinceOf(input: BriefingInput): Date {
  return input.period?.from ?? new Date(input.now.getTime() - DAY_MS);
}

/** A telegram row's WHO and topic, only when the source supplied them. */
function about(item: NeedsYouItem): string | null {
  const parts = [item.counterparty, item.topic].filter((s): s is string => Boolean(s));
  return parts.length > 0 ? parts.join(' · ') : null;
}

function money(cents: number): string {
  return '$' + (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const pct = (r: TrendResult): string => (r.kind === 'up' ? `▲ ${r.pct.toFixed(1)}%` : r.kind === 'down' ? `▼ ${r.pct.toFixed(1)}%` : r.kind === 'new' ? 'new today' : '');

// --- What changed ------------------------------------------------------------------------------------

function headlineChanges(input: BriefingInput, since: Date): BriefingChange[] {
  if (!input.headlines) return [];
  return input.headlines
    // The read-side rule: a dismissed Headline never reappears here, whatever the read returned.
    .filter((h) => h.dismissedAt === null)
    .filter((h) => new Date(h.lastDetectedAt).getTime() >= since.getTime())
    .map((h): BriefingChange => {
      const m = h.measurement;
      const tone: BriefingTone = m.againstObjective ? 'critical' : 'attention';
      const seen = h.detectionCount > 1 ? `; seen ${h.detectionCount} runs` : '';
      const coverage = m.currentCoverage !== null ? `; coverage ${Math.round(m.currentCoverage * 100)}%` : '';
      return {
        key: `headline:${h.id}`,
        source: 'HEADLINES',
        where: h.objectiveTitle,
        what: h.statement,
        why: `${h.ruleDescription}${coverage}${seen}`,
        next: null,
        at: new Date(h.lastDetectedAt),
        tone,
        href: `${input.headlinesHref}/${encodeURIComponent(h.id)}`,
        hrefLabel: 'Look into it',
        place: null,
        provider: null,
      };
    });
}

function telegramChanges(input: BriefingInput): BriefingChange[] {
  return input.needsYou
    .filter((item) => item.category !== null && CHANGE_CATEGORIES.includes(item.category))
    .map((item): BriefingChange => ({
      key: `needs-you:${item.id}`,
      source: 'TELEGRAM',
      where: about(item),
      what: item.title,
      why: item.category === 'COMMITMENT' ? 'the conversation recorded a commitment' : 'the conversation named a change',
      next: item.nextStep,
      at: item.at,
      tone: 'attention',
      href: null,
      hrefLabel: null,
      place: TELEGRAM_PLACE,
      provider: 'TELEGRAM',
    }));
}

const UPDATE_WHY: Readonly<Record<ReviewSourceId, string>> = Object.freeze({
  WORK: 'work you can see moved a step',
  MAIL: 'a conversation in your mail moved',
  CALLGRID: 'CallGrid reported movement',
  CALENDAR: 'your calendar changed',
  HEADLINES: 'a headline moved',
});

function reviewChanges(input: BriefingInput, since: Date, attentionKeys: ReadonlySet<string>): BriefingChange[] {
  if (!input.review) return [];
  return input.review.updates
    .filter((u) => u.at.getTime() >= since.getTime())
    // A conversation already listed under "needs you" is not repeated as a change.
    .filter((u) => !attentionKeys.has(u.key))
    .map((u): BriefingChange => ({
      key: `update:${u.key}`,
      source: u.source,
      where: u.who,
      what: u.what,
      why: `${UPDATE_WHY[u.source]}${u.status ? ` (${u.status})` : ''}`,
      next: null,
      at: u.at,
      tone: toneOf(u.tone),
      href: u.href,
      hrefLabel: u.href ? (u.source === 'MAIL' ? 'Open in Mail' : 'Open') : null,
      place: null,
      provider: null,
    }));
}

/** One CallGrid row, only when today so far has moved against yesterday. Loop reports, it does not judge. */
function callgridChange(input: BriefingInput): BriefingChange | null {
  const cg = input.dashboard?.callgrid;
  if (!cg || cg.total === 0) return null;
  const y = cg.yesterday;
  const t = cg.today;
  const billable = trend(metricValue(y.billableCalls, y.available), metricValue(t.billableCalls, t.available));
  const revenue = trend(metricValue(y.revenueCents, y.available), metricValue(t.revenueCents, t.available));
  const moved = [billable, revenue].some((r) => r.kind === 'up' || r.kind === 'down' || r.kind === 'new');
  if (!moved) return null;
  const parts: string[] = [];
  if (t.billableCalls !== null && y.billableCalls !== null) parts.push(`${counted(t.billableCalls, 'billable call', 'billable calls')} so far today, ${y.billableCalls} yesterday${pct(billable) ? ` (${pct(billable)})` : ''}`);
  if (t.revenueCents !== null && y.revenueCents !== null) parts.push(`revenue ${money(t.revenueCents)} against ${money(y.revenueCents)}${pct(revenue) ? ` (${pct(revenue)})` : ''}`);
  if (parts.length === 0) return null;
  return {
    key: 'callgrid:today-vs-yesterday',
    source: 'CALLGRID',
    where: null,
    what: `CallGrid: ${parts.join(' · ')}`,
    why: 'today so far against yesterday complete; a move, not a verdict',
    next: null,
    at: input.now,
    tone: 'neutral',
    href: '/app/admin/marketplace',
    hrefLabel: 'CallGrid Intelligence',
    place: null,
    provider: null,
  };
}

// --- Needs your attention ---------------------------------------------------------------------------

function telegramAttention(input: BriefingInput): BriefingAttention[] {
  return input.needsYou
    .filter((item) => item.category === null || !CHANGE_CATEGORIES.includes(item.category))
    .map((item): BriefingAttention => {
      const category = item.category ?? 'NONE';
      const kindTone: BriefingTone = category === 'DECISION_NEEDED' || category === 'PROBLEM' || category === 'DEADLINE' ? 'critical' : 'attention';
      const score = (item.deadline ? DEADLINE_BOOST : 0) + (CATEGORY_WEIGHT[category] ?? CATEGORY_WEIGHT.OTHER!);
      return {
        key: `needs-you:${item.id}`,
        source: 'TELEGRAM',
        where: about(item),
        what: item.title,
        kindLabel: CATEGORY_LABELS[category] ?? 'Needs you',
        kindTone,
        deadline: item.deadline,
        next: item.nextStep,
        since: item.at,
        href: null,
        hrefLabel: null,
        place: TELEGRAM_PLACE,
        provider: 'TELEGRAM',
        score,
        rank: 1,
      };
    });
}

function reviewAttention(input: BriefingInput): BriefingAttention[] {
  if (!input.review) return [];
  return input.review.attention.map((a): BriefingAttention => ({
    key: `review:${a.key}`,
    source: a.source,
    where: a.who,
    what: a.happened,
    kindLabel: a.next,
    kindTone: toneOf(a.tone),
    deadline: null,
    next: a.next,
    since: a.since,
    href: a.href,
    hrefLabel: a.href ? a.next : null,
    place: null,
    provider: null,
    score: TONE_WEIGHT[toneOf(a.tone)],
    // The review's own rank breaks ties within a score: rank 0 is its most pressing.
    rank: a.rank,
  }));
}

/** Higher score first; within a score the producer's own rank, then the one that has waited longest; then a stable key. */
export function rankAttention(rows: readonly BriefingAttention[]): BriefingAttention[] {
  return [...rows].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.rank !== b.rank) return a.rank - b.rank;
    const as = a.since?.getTime() ?? Number.POSITIVE_INFINITY;
    const bs = b.since?.getTime() ?? Number.POSITIVE_INFINITY;
    if (as !== bs) return as - bs;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
}

// --- Today -------------------------------------------------------------------------------------------

function calendarState(input: BriefingInput): BriefingSourceState {
  if (input.dayFailed) return { state: 'UNAVAILABLE', line: 'Loop could not open your calendar just now.' };
  const day = input.day;
  if (!day || day.freshness === 'NOT_CONFIGURED') return { state: 'NOT_CONFIGURED' };
  return connectableState(day.freshness, 'calendar', input.connectionsHref);
}

function mailState(input: BriefingInput): BriefingSourceState {
  if (input.mailFailed) return { state: 'UNAVAILABLE', line: 'Loop could not open your mail just now.' };
  const mail = input.mail;
  if (!mail || mail.mail.freshness === 'NOT_CONFIGURED') return { state: 'NOT_CONFIGURED' };
  return connectableState(mail.mail.freshness, 'mail', input.connectionsHref);
}

/** The one-line state of a Google source that could be connected, with its own way in. */
function connectableState(freshness: WorkSourceFreshness, noun: 'calendar' | 'mail', href: string): BriefingSourceState {
  const thing = noun === 'calendar' ? 'Calendar' : 'Google';
  switch (freshness) {
    case 'CURRENT':
    case 'STALE':
    case 'NEVER_SYNCED':
    case 'SYNC_FAILED':
      return { state: 'READ' };
    case 'AUTHORIZATION_EXPIRED':
      return { state: 'NOT_CONNECTED', line: `Google no longer accepts this connection, so your ${noun} isn’t here.`, href, action: `Reconnect ${thing}` };
    case 'CAPABILITY_NOT_GRANTED':
      return { state: 'NOT_CONNECTED', line: noun === 'calendar' ? 'Calendar isn’t connected, so your day isn’t here yet.' : 'Mail isn’t connected. Loop shows only your own Gmail once it is.', href, action: `Connect ${thing}` };
    case 'NOT_CONNECTED':
    default:
      return { state: 'NOT_CONNECTED', line: noun === 'calendar' ? 'Calendar isn’t connected, so your day isn’t here yet.' : 'Mail isn’t connected. Loop shows only your own Gmail once it is.', href, action: `Connect ${thing}` };
  }
}

function today(input: BriefingInput): BriefingToday {
  const calendar = calendarState(input);
  const day = calendar.state === 'READ' ? input.day : null;
  const mail = mailState(input);
  const summary = mail.state === 'READ' ? input.mail?.summary ?? null : null;
  return {
    calendar,
    events: day ? day.todaySchedule.timed : [],
    allDayCount: day ? day.summary.allDayCount : 0,
    inProgress: day?.position.inProgress ?? null,
    next: day?.position.next ?? null,
    minutesUntilNext: day?.position.minutesUntilNext ?? null,
    afternoonClear: day?.summary.afternoonClear ?? null,
    lastSyncedAt: day?.lastSyncedAt ?? null,
    due: [...input.workDue].sort((a, b) => a.at.getTime() - b.at.getTime()).slice(0, BRIEFING_LIMITS.dueToday),
    mail,
    mailCounts: summary ? { needsReply: summary.needsReply, followUps: summary.followUps, waiting: summary.waiting } : null,
  };
}

// --- Business pulse ---------------------------------------------------------------------------------

function pulse(input: BriefingInput): BriefingPulse | null {
  if (!input.review && !input.dashboard) return null;
  const kpis: BriefingKpi[] = [];
  const unchanged: string[] = [];
  const omitted: { label: string; reason: string }[] = [];

  const cg = input.dashboard?.callgrid;
  if (cg && cg.total > 0) {
    const y = cg.yesterday;
    const t = cg.today;
    const rows: { key: string; label: string; yv: number | null; tv: number | null; fmt: (n: number) => string }[] = [
      { key: 'billable', label: 'Billable calls', yv: y.billableCalls, tv: t.billableCalls, fmt: (n) => n.toLocaleString('en-US') },
      { key: 'revenue', label: 'CallGrid revenue', yv: y.revenueCents, tv: t.revenueCents, fmt: money },
      { key: 'profit', label: 'Net profit', yv: y.profitCents, tv: t.profitCents, fmt: money },
      { key: 'calls', label: 'Total calls', yv: y.totalCalls, tv: t.totalCalls, fmt: (n) => n.toLocaleString('en-US') },
    ];
    for (const row of rows) {
      const r = trend(metricValue(row.yv, y.available), metricValue(row.tv, t.available));
      if (r.kind === 'unavailable') omitted.push({ label: row.label, reason: 'CallGrid could not be read' });
      else if (r.kind === 'unknown') omitted.push({ label: row.label, reason: 'CallGrid did not state it' });
      else if (r.kind === 'no_change' || r.kind === 'flat') unchanged.push(row.label.toLowerCase());
      else
        kpis.push({
          key: `callgrid:${row.key}`,
          label: `${row.label} · today so far`,
          value: row.fmt(row.tv!),
          delta: { kind: r.kind, text: pct(r) },
          sub: `yesterday ${row.fmt(row.yv!)}`,
          href: '/app/admin/marketplace',
          scope: 'CallGrid, today so far against yesterday complete',
        });
    }
  } else if (cg) {
    omitted.push({ label: 'CallGrid', reason: 'no calls yet' });
  }

  const m = input.review?.metrics;
  if (m) {
    const withPrior = (key: 'relevantEmails' | 'outreachSent', label: string) => {
      const metric = m[key];
      if (metric.state !== 'VALUE') {
        omitted.push({ label, reason: metric.reason });
        return;
      }
      if (metric.prior === null) {
        kpis.push({ key: `review:${key}`, label, value: metric.value.toLocaleString('en-US'), delta: null, sub: null, href: metric.href, scope: metric.scope });
        return;
      }
      const diff = metric.value - metric.prior;
      if (diff === 0) unchanged.push(label.toLowerCase());
      else if (metric.value === 0) unchanged.push(label.toLowerCase());
      else
        kpis.push({
          key: `review:${key}`,
          label,
          value: metric.value.toLocaleString('en-US'),
          delta: metric.prior === 0 ? { kind: 'new', text: 'new this period' } : { kind: diff > 0 ? 'up' : 'down', text: `${diff > 0 ? '▲' : '▼'} ${Math.abs(diff)} vs the period before` },
          sub: null,
          href: metric.href,
          scope: metric.scope,
        });
    };
    withPrior('relevantEmails', 'Relevant mail');
    withPrior('outreachSent', 'Outreach sent');
    const opp = m.newOpportunities;
    if (opp.state === 'NOT_TRACKED' || opp.state === 'UNAVAILABLE') omitted.push({ label: 'Opportunities', reason: opp.reason });
    else if (opp.value > 0) kpis.push({ key: 'review:newOpportunities', label: 'Opportunity signals', value: opp.value.toLocaleString('en-US'), delta: null, sub: null, href: opp.href, scope: opp.scope });
  }

  const w = input.dashboard?.home.workspace.workSummary;
  if (w && (w.assignedToMe > 0 || w.waitingBlocked > 0 || w.completedToday > 0)) {
    const bits = [w.waitingBlocked > 0 ? `${w.waitingBlocked} blocked` : null, w.completedToday > 0 ? `${w.completedToday} completed today` : null].filter(Boolean);
    kpis.push({ key: 'work:mine', label: 'Your work', value: String(w.assignedToMe), delta: null, sub: bits.length ? bits.join(' · ') : null, href: null, scope: 'work assigned to you' });
  }

  return { kpis, unchanged, omitted };
}

// --- The sentence ---------------------------------------------------------------------------------

function sentence(input: BriefingInput, changes: number, attention: readonly BriefingAttention[], todayPlan: BriefingToday): BriefingSentence {
  const read: string[] = [];
  const notRead: { label: string; note: string }[] = [];
  for (const s of input.review?.sources ?? []) {
    if (s.state === 'OK') read.push(REVIEW_SOURCE_LABELS[s.source]);
    else notRead.push({ label: REVIEW_SOURCE_LABELS[s.source], note: s.note ?? (s.state === 'UNAVAILABLE' ? 'Loop could not read this just now.' : 'Not connected.') });
  }
  if (!input.review) {
    if (todayPlan.calendar.state === 'READ') read.push(REVIEW_SOURCE_LABELS.CALENDAR);
    else if (todayPlan.calendar.state === 'NOT_CONNECTED') notRead.push({ label: REVIEW_SOURCE_LABELS.CALENDAR, note: 'not connected' });
    if (todayPlan.mail.state === 'READ') read.push(REVIEW_SOURCE_LABELS.MAIL);
    else if (todayPlan.mail.state === 'NOT_CONNECTED') notRead.push({ label: REVIEW_SOURCE_LABELS.MAIL, note: 'not connected' });
  }
  if (input.needsYou.length > 0) read.push(input.needsYou[0]!.sourceLabel);
  const withDeadline = attention.find((a) => a.deadline);
  return {
    since: input.period?.from ?? null,
    changes,
    attention: attention.length,
    soonestDeadline: withDeadline?.deadline ?? null,
    meetings: todayPlan.calendar.state === 'READ' && input.day ? input.day.summary.timedCount : null,
    nextMeetingIn: todayPlan.minutesUntilNext,
    inProgress: todayPlan.inProgress !== null,
    read,
    notRead,
  };
}

// --- The composition -----------------------------------------------------------------------------

export function composeBriefing(input: BriefingInput): Briefing {
  const since = sinceOf(input);

  const attentionRows = rankAttention([...telegramAttention(input), ...reviewAttention(input)]);
  const attentionKeys = new Set(input.review?.attention.map((a) => a.key) ?? []);
  const attention = attentionRows.slice(0, BRIEFING_LIMITS.attention);

  const cgChange = callgridChange(input);
  const changeRows = [...headlineChanges(input, since), ...telegramChanges(input), ...reviewChanges(input, since, attentionKeys), ...(cgChange ? [cgChange] : [])].sort(
    (a, b) => (b.at?.getTime() ?? 0) - (a.at?.getTime() ?? 0),
  );
  const changes = changeRows.slice(0, BRIEFING_LIMITS.changes);

  const todayPlan = today(input);
  const telegramCount = attentionRows.filter((r) => r.provider === 'TELEGRAM').length;
  const attentionTotal = (input.review?.attentionTotal ?? 0) + telegramCount;

  return {
    sentence: sentence(input, changeRows.length, attentionRows, todayPlan),
    changes,
    changesObserved: changeRows.length,
    historyHref: input.headlines !== null ? input.headlinesHref : null,
    attention,
    attentionTotal,
    attentionElsewhere: input.review?.attentionElsewhere ?? [],
    attentionReadable: input.review ? input.review.metrics.needAttention.state === 'VALUE' : true,
    today: todayPlan,
    pulse: pulse(input),
  };
}

/** The words of the briefing sentence, from its facts. Kept beside the composer so the wording is tested. */
export function briefingWords(s: BriefingSentence, time: TimeView): { lead: string; sources: string | null } {
  const parts: string[] = [];
  parts.push(s.changes === 0 ? 'nothing meaningful changed' : `${counted(s.changes, 'thing changed', 'things changed')}`);
  parts.push(s.attention === 0 ? 'nothing needs you' : `${counted(s.attention, 'needs you', 'need you')}${s.soonestDeadline ? `, one ${s.soonestDeadline.toLowerCase().startsWith('by ') || s.soonestDeadline.toLowerCase().startsWith('before ') ? '' : 'by '}${s.soonestDeadline}` : ''}`);
  const when = s.since ? `Since ${time.dateTime(s.since)}: ` : '';
  let day = '';
  if (s.meetings !== null) {
    day = s.meetings === 0 ? ' No meetings today.' : ` Your day has ${counted(s.meetings, 'meeting', 'meetings')}${s.inProgress ? ', one on now' : s.nextMeetingIn !== null && s.nextMeetingIn <= 120 ? `; next in ${s.nextMeetingIn} min` : ''}.`;
  }
  const lead = `${when}${parts.join(', ')}.${day}`;
  const from = s.read.length ? `From ${s.read.join(', ')}.` : null;
  const not = s.notRead.length ? `Not read: ${s.notRead.map((n) => `${n.label} — ${n.note.replace(/\.$/, '')}`).join('; ')}.` : null;
  const sources = [from, not].filter(Boolean).join(' ') || null;
  return { lead: lead.charAt(0).toUpperCase() + lead.slice(1), sources };
}

/**
 * Work due today, from the rows the Work OS read already returned: an expected return EMG
 * committed to, or the current step's own due date, falling inside the reader's day. Nothing is
 * inferred; a row with no date is not due.
 */
export function dueTodayFromWork(items: readonly MyWorkItem[], dayStart: Date, dayEnd: Date): BriefingDue[] {
  const out: BriefingDue[] = [];
  for (const item of items) {
    const candidates: { at: Date; detail: string }[] = [];
    if (item.expectedReturnAtIso) candidates.push({ at: new Date(item.expectedReturnAtIso), detail: `expected back · ${item.stageName}` });
    if (item.dueAtIso) candidates.push({ at: new Date(item.dueAtIso), detail: `${item.stageName} due` });
    for (const c of candidates) {
      if (Number.isNaN(c.at.getTime()) || c.at < dayStart || c.at >= dayEnd) continue;
      out.push({ key: `work:${item.workInstanceId}:${c.detail}`, at: c.at, what: item.title, detail: c.detail, href: item.href });
    }
  }
  return out.sort((a, b) => a.at.getTime() - b.at.getTime());
}
