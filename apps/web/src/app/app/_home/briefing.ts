// The Home briefing: ONE pure composition over what the existing loaders already return
// (approved design pass, 2026-09-24; the front door, 2026-09-24). Home answers three questions in
// order -- what changed that matters, what needs you, what to do next. The figures themselves live
// on the KPI row (kpis.ts) and the tiles (tiles.ts); the briefing is the synthesis, not a dashboard.
//
// PURE, AND ONLY A PROJECTION. This module imports no loader, no repository, no clock and no
// randomness: the page loads each source on its own (as before) and hands the results in; the
// composer reads them and returns a plan the views render. It never writes, never widens a scope
// and never invents: a row exists only where a source produced the fact, a deadline is only ever
// the words a conversation wrote, a Telegram row has no link because a private chat has none, and
// a "why" for a source that carries no rule is a fixed phrase that says which source moved.
//
// CALLGRID IS THE COMMAND CENTER'S OWN COMPARISON. The CallGrid row reads the projected command
// context (kpis.ts): today so far against yesterday cut at the same time, withheld when Loop's
// record does not cover it. The retired "pulse" compared today-so-far with yesterday COMPLETE,
// which read as a decline every morning; nothing here compares a partial day with a whole one.
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
} from '@emgloop/shared';
import type { DayEvent } from '@emgloop/shared';
import type { NeedsYouItem } from '../../../daily-loop/needs-you';
import type { YourDayView } from '../../../daily-loop/your-day';
import type { MailDashboard } from '../../../daily-loop/mail-dashboard';
import type { MyWorkItem } from '../admin/workspace-home-data';
import type { HomeKpiStrip } from './kpis';

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
const CHANGE_CATEGORIES: readonly string[] = Object.freeze(['BUSINESS_CHANGE', 'COMMITMENT']);

/** The category, in plain words for the person. Presentation only; the vocabulary is the AI task's. */
const CATEGORY_LABELS: Readonly<Record<string, string>> = Object.freeze({
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
const TELEGRAM_PLACE = 'In Telegram';

/** The two destinations the briefing links to for every seat. (The Executive Brain link went with the pulse panel.) */
export const HOME_PATHS = Object.freeze({ headlines: '/app/admin/headlines', mail: '/app/mail' });

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
  /**
   * Loop has read this source. `current` is false when the read is old (STALE) or the last attempt
   * failed and this is the picture as last read (SYNC_FAILED); the view then says so and when.
   */
  | { readonly state: 'READ'; readonly current: boolean; readonly readAt: Date | null; readonly failed: boolean }
  /** Connected, but Loop has not read it yet: nothing here is empty, it is unread. */
  | { readonly state: 'NOT_READ'; readonly line: string }
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
  /** Counts only from a read Loop can conclude from; `current` says whether "right now" may be said. */
  readonly mailCounts: { readonly needsReply: number; readonly followUps: number; readonly waiting: number; readonly current: boolean } | null;
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
  /**
   * The CallGrid command context, projected (kpis.ts): the Command Center's own figures and its own
   * comparison. Null for a seat that is not offered CallGrid, or when the read failed.
   */
  readonly callgrid: HomeKpiStrip | null;
  /** Work expected back or due today, from the Work OS read the seat already has. */
  readonly workDue: readonly BriefingDue[];
  readonly connectionsHref: string;
  readonly headlinesHref: string;
  /**
   * True when Home draws the Headlines panel of its own: the review's single aggregate Headlines
   * row ("N things need your attention") is then not repeated under Needs you.
   */
  readonly headlinesPanel?: boolean;
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

function telegramChanges(input: BriefingInput, since: Date): BriefingChange[] {
  return input.needsYou
    .filter((item) => item.category !== null && CHANGE_CATEGORIES.includes(item.category))
    .filter((item) => item.at.getTime() >= since.getTime())
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

/**
 * One CallGrid row, only when a figure moved against the Command Center's OWN comparison -- the
 * window's comparison label is carried verbatim, so the row can never say "yesterday" of a partial
 * day measured against a whole one. Loop reports the move; it does not judge it.
 */
function callgridChange(input: BriefingInput): BriefingChange | null {
  const strip = input.callgrid;
  if (!strip || strip.state !== 'OK' || !strip.comparisonLabel) return null;
  const moved = strip.kpis.filter((k) => k.state === 'VALUE' && k.change !== null && k.change.direction !== 'flat');
  if (moved.length === 0) return null;
  const parts = moved.map((k) => `${k.label} ${k.value} (${k.change!.direction === 'up' ? '▲' : '▼'} ${k.change!.text})`);
  return {
    key: 'callgrid:period-vs-comparison',
    source: 'CALLGRID',
    where: strip.periodLabel,
    what: `CallGrid: ${parts.join(' · ')}`,
    why: `against ${strip.comparisonLabel.charAt(0).toLowerCase()}${strip.comparisonLabel.slice(1)}; a move, not a verdict`,
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

/** The review's aggregate Headlines row is omitted when Home draws the Headlines panel itself. */
function reviewAttentionRows(input: BriefingInput): readonly ReviewAttention[] {
  if (!input.review) return [];
  return input.headlinesPanel ? input.review.attention.filter((a) => a.source !== 'HEADLINES') : input.review.attention;
}

function reviewAttention(input: BriefingInput): BriefingAttention[] {
  return reviewAttentionRows(input).map((a): BriefingAttention => ({
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
  return connectableState(day.freshness, 'calendar', input.connectionsHref, day.lastSyncedAt);
}

function mailState(input: BriefingInput): BriefingSourceState {
  if (input.mailFailed) return { state: 'UNAVAILABLE', line: 'Loop could not open your mail just now.' };
  const mail = input.mail;
  if (!mail || mail.mail.freshness === 'NOT_CONFIGURED') return { state: 'NOT_CONFIGURED' };
  const state = connectableState(mail.mail.freshness, 'mail', input.connectionsHref, mail.mail.lastSyncedAt);
  // The read model's own verdict outranks the freshness word: with nothing to conclude from, the
  // mailbox is unread, and an old read is not current.
  if (state.state === 'READ' && !mail.concludable) return { state: 'NOT_READ', line: 'Loop has not read your mail yet.' };
  if (state.state === 'READ' && !mail.current) return { ...state, current: false };
  return state;
}

/** The one-line state of a Google source that could be connected, with its own way in. */
function connectableState(freshness: WorkSourceFreshness, noun: 'calendar' | 'mail', href: string, readAt: Date | null): BriefingSourceState {
  const thing = noun === 'calendar' ? 'Calendar' : 'Google';
  switch (freshness) {
    case 'CURRENT':
      return { state: 'READ', current: true, readAt, failed: false };
    case 'STALE':
      return { state: 'READ', current: false, readAt, failed: false };
    case 'SYNC_FAILED':
      // What Loop last read, if it ever did; never an empty day dressed as a read one.
      return readAt ? { state: 'READ', current: false, readAt, failed: true } : { state: 'NOT_READ', line: `Loop could not reach Google, and has not read your ${noun} yet.` };
    case 'NEVER_SYNCED':
      return { state: 'NOT_READ', line: `Loop has not read your ${noun} yet.` };
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
    mailCounts: summary && mail.state === 'READ' ? { needsReply: summary.needsReply, followUps: summary.followUps, waiting: summary.waiting, current: mail.current } : null,
  };
}

// --- The sentence ---------------------------------------------------------------------------------

function sentence(input: BriefingInput, changes: number, attention: readonly BriefingAttention[], attentionTotal: number, todayPlan: BriefingToday): BriefingSentence {
  const read: string[] = [];
  const notRead: { label: string; note: string }[] = [];
  for (const s of input.review?.sources ?? []) {
    if (s.state === 'OK') read.push(REVIEW_SOURCE_LABELS[s.source]);
    else notRead.push({ label: REVIEW_SOURCE_LABELS[s.source], note: s.note ?? (s.state === 'UNAVAILABLE' ? 'Loop could not read this just now.' : 'Not connected.') });
  }
  if (!input.review) {
    if (todayPlan.calendar.state === 'READ') read.push(REVIEW_SOURCE_LABELS.CALENDAR);
    else if (todayPlan.calendar.state === 'NOT_CONNECTED') notRead.push({ label: REVIEW_SOURCE_LABELS.CALENDAR, note: 'not connected' });
    else if (todayPlan.calendar.state === 'NOT_READ') notRead.push({ label: REVIEW_SOURCE_LABELS.CALENDAR, note: 'not read yet' });
    if (todayPlan.mail.state === 'READ') read.push(REVIEW_SOURCE_LABELS.MAIL);
    else if (todayPlan.mail.state === 'NOT_CONNECTED') notRead.push({ label: REVIEW_SOURCE_LABELS.MAIL, note: 'not connected' });
    else if (todayPlan.mail.state === 'NOT_READ') notRead.push({ label: REVIEW_SOURCE_LABELS.MAIL, note: 'not read yet' });
  }
  if (input.needsYou.length > 0) read.push(input.needsYou[0]!.sourceLabel);
  const withDeadline = attention.find((a) => a.deadline);
  return {
    since: input.period?.from ?? null,
    changes,
    attention: attentionTotal,
    /** The first-ranked deadline, in the source's own words. Text, never a parsed date. */
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
  // Newest first; a row with no instant (none today) would sort last, never be given a time.
  const instant = (d: Date | null): number => (d ? d.getTime() : Number.NEGATIVE_INFINITY);
  const changeRows = [...headlineChanges(input, since), ...telegramChanges(input, since), ...reviewChanges(input, since, attentionKeys), ...(cgChange ? [cgChange] : [])].sort(
    (a, b) => instant(b.at) - instant(a.at),
  );
  const changes = changeRows.slice(0, BRIEFING_LIMITS.changes);

  const todayPlan = today(input);
  const telegramCount = attentionRows.filter((r) => r.provider === 'TELEGRAM').length;
  // The review counts its aggregate Headlines row as one; when Home draws Headlines itself that row
  // is withheld here, and the total says so. With no review (the module Home) the total is the
  // viewer's own items; nothing is defaulted.
  const withheld = input.review ? input.review.attention.length - reviewAttentionRows(input).length : 0;
  const attentionTotal = input.review ? input.review.attentionTotal - withheld + telegramCount : telegramCount;

  return {
    sentence: sentence(input, changeRows.length, attentionRows, attentionTotal, todayPlan),
    changes,
    changesObserved: changeRows.length,
    historyHref: input.headlines !== null ? input.headlinesHref : null,
    attention,
    attentionTotal,
    attentionElsewhere: input.review?.attentionElsewhere ?? [],
    attentionReadable: input.review ? input.review.metrics.needAttention.state === 'VALUE' : true,
    today: todayPlan,
  };
}

/** The words of the briefing sentence, from its facts. Kept beside the composer so the wording is tested. */
export function briefingWords(s: BriefingSentence, time: TimeView): { lead: string; sources: string | null } {
  const parts: string[] = [];
  parts.push(s.changes === 0 ? 'nothing changed in what Loop can read' : `${counted(s.changes, 'thing changed', 'things changed')}`);
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

/**
 * A queue row as `WorkRepository.listMyWork` returns it -- an instance with its stages -- named
 * structurally so this module imports nothing from the database package.
 */
export interface QueueInstance {
  readonly id: string;
  readonly title: string;
  readonly currentStageId: string | null;
  readonly expectedReturnAt: Date | null;
  readonly stages: readonly { readonly id: string; readonly name: string; readonly ownerUserId: string | null; readonly status: string; readonly dueAt: Date | null }[];
}

/**
 * Work due today for the employee seat, from the rows its own queue read returned: only an instance
 * whose CURRENT stage this person owns and can act on, dated by that stage's own due date or by the
 * return EMG committed to, falling inside the reader's day. A row waiting on someone else is not
 * due; a row with no date is not due. Links go to the employee tree.
 */
export function dueTodayFromQueue(rows: readonly QueueInstance[], userId: string, dayStart: Date, dayEnd: Date, hrefFor: (workInstanceId: string) => string): BriefingDue[] {
  const out: BriefingDue[] = [];
  for (const row of rows) {
    const current = row.stages.find((s) => s.id === row.currentStageId);
    if (!current || current.ownerUserId !== userId || (current.status !== 'ready' && current.status !== 'in_progress')) continue;
    const candidates: { at: Date | null; detail: string }[] = [
      { at: current.dueAt, detail: `${current.name} due` },
      { at: row.expectedReturnAt, detail: `expected back · ${current.name}` },
    ];
    for (const c of candidates) {
      if (!c.at) continue;
      const at = new Date(c.at);
      if (Number.isNaN(at.getTime()) || at < dayStart || at >= dayEnd) continue;
      out.push({ key: `work:${row.id}:${c.detail}`, at, what: row.title, detail: c.detail, href: hrefFor(row.id) });
    }
  }
  return out.sort((a, b) => a.at.getTime() - b.at.getTime());
}
