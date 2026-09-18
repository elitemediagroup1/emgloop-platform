// Today's Review, assembled for one signed-in Owner, Admin or Manager. SERVER ONLY.
//
// Each source Loop already has contributes in ONE shape (`ReviewContribution`, @emgloop/shared),
// built from data the rest of Loop already reads -- the Mail dashboard's read model, the person's
// own calendar (Your Day), CallGrid's scorecard and the Executive Brain's risks, Loop work, and
// Headlines -- and the pure composer merges them. Nothing here reads a new source, and nothing
// here writes.
//
// EVERY SOURCE IS ISOLATED. A source that throws becomes one contribution marked UNAVAILABLE: its
// card says so, and the rest of Home renders. A Home that read one missing table directly was a
// production outage (2026-09-18); this is the structural answer to it.
//
// MAIL AND CALENDAR ARE THE VIEWER'S OWN. Everything organization-level (CallGrid, work,
// Headlines) is read under the ADMIN workspace this Home already requires, and nothing here
// widens who sees whose mail.

import 'server-only';

import {
  composeReview,
  counted,
  mailActivity,
  mailViewRows,
  namedList,
  reviewPeriod,
  type ExecutiveReview,
  type ReviewAttention,
  type ReviewContribution,
  type ReviewFact,
  type ReviewPeriod,
  type ReviewUpdate,
  type TimeView,
} from '@emgloop/shared';
import { WorkGraphRepository, prisma, type WorkPrincipal } from '@emgloop/database';

import type { AuthSession } from '../../../auth/auth';
import { canOpenHeadlines } from '../../../crm/headlines-access';
import type { MailDashboard } from '../../../daily-loop/mail-dashboard';
import type { YourDayView } from '../../../daily-loop/your-day';
import { counterpartName, laneLine, opportunityLine, rowPill } from '../mail/_mail/dashboard';
import type { DashboardData } from '../admin/dashboard-data';
import { loadAttention } from '../admin/headlines/headlines-data';
import { settle } from './settle';

/** A contribution, or UNAVAILABLE when building it threw. Never a thrown Home. */
async function isolated(source: ReviewContribution['source'], build: () => Promise<ReviewContribution | null>): Promise<ReviewContribution | null> {
  const result = await settle(build);
  return result.ok ? result.value : { source, state: 'UNAVAILABLE', note: 'Loop could not read this just now.' };
}

const money = (cents: number) => '$' + (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// --- Mail -------------------------------------------------------------------------------------------

async function mailContribution(principal: WorkPrincipal, mail: MailDashboard | null, period: ReviewPeriod, time: TimeView): Promise<ReviewContribution | null> {
  if (!mail) return null;
  if (!mail.concludable) return { source: 'MAIL', state: 'NOT_CONNECTED', note: 'Loop has not read your mail yet.' };

  const insights = mail.rows.map((r) => r.insight);
  const byId = new Map(mail.rows.map((r) => [r.insight.threadId, r]));
  const lane = (view: 'needs-reply' | 'follow-ups' | 'opportunities') =>
    mailViewRows(insights, { view, query: '', unreadOnly: false, includeNotifications: false }).map((i) => byId.get(i.threadId)!);
  const needsReply = lane('needs-reply');
  const followUps = lane('follow-ups');
  const opportunities = lane('opportunities');
  const subjects = (rows: typeof needsReply) => rows.map((r) => r.insight.subject?.trim() || counterpartName(r));

  // Counts over the review period and the equal period before it, from stored message facts.
  const graph = new WorkGraphRepository(prisma);
  const span = period.to.getTime() - period.from.getTime();
  const prior = { from: new Date(period.from.getTime() - span), to: period.from };
  const activity = await graph.messageActivity(principal, { from: prior.from, to: period.to });
  const now = mailActivity(activity.messages, activity.firstMessageAt, period);
  const before = mailActivity(activity.messages, activity.firstMessageAt, prior);

  const facts: ReviewFact[] = [];
  if (needsReply.length > 0) {
    facts.push({
      rank: 10,
      sentence:
        needsReply.length === 1
          ? `1 conversation needs your reply: ${namedList(subjects(needsReply), 1)}.`
          : `${counted(needsReply.length, 'conversation', 'conversations')} need your reply, including ${namedList(subjects(needsReply))}.`,
    });
  }
  if (opportunities.length > 0) {
    facts.push({
      rank: 15,
      sentence: `Your mail shows ${counted(opportunities.length, 'new opportunity signal', 'new opportunity signals')}, including ${namedList(subjects(opportunities), 2)}.`,
    });
  }
  if (followUps.length > 0) {
    facts.push({ rank: 25, sentence: `${counted(followUps.length, 'follow-up is', 'follow-ups are')} due.` });
  }
  // Only what happened is said: "you started 0 conversations" is a zero nobody needed to read.
  const arrived = now.relevantInbound > 0 ? `${counted(now.relevantInbound, 'email that matters', 'emails that matter')} arrived` : null;
  const started = now.conversationsStarted > 0 ? `you started ${counted(now.conversationsStarted, 'new conversation', 'new conversations')}` : null;
  const moved = [arrived, started].filter(Boolean).join(' and ');
  if (moved) facts.push({ rank: 35, sentence: `${moved.charAt(0).toUpperCase()}${moved.slice(1)} since yesterday.` });

  const attention: ReviewAttention[] = [
    ...needsReply.map((r): ReviewAttention => ({
      key: `mail:${r.insight.threadId}`,
      source: 'MAIL',
      rank: 1,
      since: r.insight.laneAt,
      who: counterpartName(r),
      happened: `${r.insight.subject?.trim() || 'No subject'} · ${laneLine(r.insight, time)}`,
      next: 'Reply',
      tone: 'critical',
      href: `/app/mail/${encodeURIComponent(r.insight.threadId)}`,
    })),
    ...followUps.map((r): ReviewAttention => ({
      key: `mail:${r.insight.threadId}`,
      source: 'MAIL',
      rank: 3,
      since: r.insight.laneAt,
      who: counterpartName(r),
      happened: `${r.insight.subject?.trim() || 'No subject'} · ${laneLine(r.insight, time)}`,
      next: 'Follow up',
      tone: 'neutral',
      href: `/app/mail/${encodeURIComponent(r.insight.threadId)}`,
    })),
  ];

  const updates: ReviewUpdate[] = mail.recent.map((r) => {
    const pill = rowPill(r.insight, 'any');
    return {
      key: `mail:${r.insight.threadId}`,
      source: 'MAIL',
      at: r.insight.lastMessageAt ?? mail.now,
      who: counterpartName(r),
      what: `${r.insight.subject?.trim() || 'No subject'}${r.insight.opportunity && !r.insight.lane ? ` · ${opportunityLine(r.insight, time)}` : ''}`,
      status: pill?.label ?? (r.thread.lastDirection === 'OUTBOUND' ? 'You wrote last' : 'New message'),
      tone: pill?.tone === 'critical' ? 'critical' : pill?.tone === 'good' ? 'good' : pill?.tone === 'attention' ? 'attention' : 'neutral',
      href: `/app/mail/${encodeURIComponent(r.insight.threadId)}`,
    };
  });

  return {
    source: 'MAIL',
    state: 'OK',
    facts,
    // Home keeps mail concise: the three that matter most, and the count of all of them.
    attention: attention.slice(0, 3),
    attentionCount: needsReply.length + followUps.length,
    attentionHref: '/app/mail',
    updates,
    metrics: {
      relevantEmails: { state: 'VALUE', value: now.relevantInbound, prior: before.relevantInbound, href: '/app/mail', scope: 'your mail, leaving out notification mail and Gmail’s bulk tabs' },
      outreachSent: { state: 'VALUE', value: now.conversationsStarted, prior: before.conversationsStarted, href: '/app/mail?view=waiting', scope: 'new conversations you started' },
      newOpportunities: { state: 'VALUE', value: opportunities.length, prior: null, href: '/app/mail?view=opportunities', scope: 'opportunity signals in your mail' },
    },
  };
}

// --- Calendar ---------------------------------------------------------------------------------------

function calendarContribution(day: YourDayView | null, time: TimeView): ReviewContribution | null {
  if (!day || day.freshness === 'NOT_CONFIGURED') return null;
  const read = day.lastSyncedAt !== null && day.freshness !== 'NEVER_SYNCED';
  if (!read) return { source: 'CALENDAR', state: 'NOT_CONNECTED', note: 'Loop has not read your calendar yet.' };
  const { summary, position } = day;
  const facts: ReviewFact[] = [];
  if (summary.timedCount > 0) {
    const next = position.inProgress ?? position.next;
    const nextWords = next?.startsAt
      ? position.inProgress
        ? `, and “${next.summary ?? 'Untitled event'}” is on now`
        : `, next at ${time.time(next.startsAt)} — “${next.summary ?? 'Untitled event'}”`
      : ', and none are left today';
    facts.push({ rank: 45, sentence: `${counted(summary.timedCount, 'meeting', 'meetings')} today${nextWords}.` });
  }
  return { source: 'CALENDAR', state: 'OK', facts };
}

// --- CallGrid and Loop work ---------------------------------------------------------------------------

function callgridContribution(data: DashboardData): ReviewContribution {
  const { callgrid, home } = data;
  if (callgrid.total === 0) return { source: 'CALLGRID', state: 'NOT_CONNECTED', note: 'CallGrid has not sent any calls yet.' };
  const y = callgrid.yesterday;
  const facts: ReviewFact[] = [];
  if (y.available && y.totalCalls !== null) {
    // A billable count CallGrid did not state is left unsaid, never counted as none.
    const parts = [y.billableCalls !== null ? `${counted(y.billableCalls, 'billable call', 'billable calls')} of ${counted(y.totalCalls, 'call', 'calls')}` : counted(y.totalCalls, 'call', 'calls')];
    if (y.revenueCents !== null) parts.push(`${money(y.revenueCents)} revenue`);
    if (y.profitCents !== null) parts.push(`${money(y.profitCents)} net profit`);
    facts.push({ rank: 20, sentence: `CallGrid yesterday: ${parts.join(', ')}.` });
  }
  const attention = home.brain.signals.map((s): ReviewAttention => ({
    key: `callgrid:${s.id}`,
    source: 'CALLGRID',
    rank: s.tone === 'crit' ? 0 : 2,
    since: null,
    who: 'CallGrid',
    happened: s.title,
    next: 'Check',
    tone: s.tone === 'crit' ? 'critical' : 'attention',
    href: s.href,
  }));
  return { source: 'CALLGRID', state: 'OK', facts, attention };
}

function workContribution(data: DashboardData): ReviewContribution {
  const w = data.home.workspace;
  const attention = w.attention.map((a): ReviewAttention => ({
    key: `work:${a.key}`,
    source: 'WORK',
    rank: 2,
    since: null,
    who: a.title,
    happened: `${a.kindLabel} · ${a.reason}`,
    next: a.cta,
    tone: 'attention',
    href: a.href,
  }));
  const updates = w.recentActivity.map((a): ReviewUpdate => ({
    key: `activity:${a.id}`,
    source: 'WORK',
    at: new Date(a.createdAtIso),
    who: a.actorName || 'Loop',
    what: a.label,
    status: a.category === 'work' ? 'Work' : a.category === 'customer' ? 'CRM' : a.category === 'invitation' ? 'Team' : 'Loop',
    tone: 'neutral',
    href: null,
  }));
  const facts: ReviewFact[] = w.executiveSummary.slice(0, 1).map((sentence) => ({ rank: 50, sentence }));
  return { source: 'WORK', state: 'OK', facts, attention, attentionCount: w.attentionTotal, updates };
}

async function headlinesContribution(session: AuthSession, organizationId: string): Promise<ReviewContribution | null> {
  if (!(await canOpenHeadlines(session))) return null;
  const result = await loadAttention(organizationId);
  if (!result.ok) return { source: 'HEADLINES', state: 'UNAVAILABLE', note: 'Loop could not read Headlines just now.' };
  const a = result.value.attention;
  if (a.state !== 'NEEDS_ATTENTION') return { source: 'HEADLINES', state: 'OK', attention: [] };
  return {
    source: 'HEADLINES',
    state: 'OK',
    facts: [{ rank: 22, sentence: a.statement }],
    attention: [
      {
        key: 'headlines',
        source: 'HEADLINES',
        rank: 1,
        since: null,
        who: 'Headlines',
        happened: a.statement,
        next: 'Review',
        tone: 'attention',
        href: '/app/admin/headlines',
      },
    ],
  };
}

// --- The review ---------------------------------------------------------------------------------------

export interface ExecutiveReviewData {
  readonly review: ExecutiveReview;
  readonly period: ReviewPeriod;
}

export async function loadExecutiveReview(input: {
  readonly session: AuthSession;
  readonly principal: WorkPrincipal;
  readonly time: TimeView;
  readonly timeZone: string;
  readonly mail: MailDashboard | null;
  readonly day: YourDayView | null;
  readonly dashboard: DashboardData | null;
}): Promise<ExecutiveReviewData> {
  const period = reviewPeriod(input.time.now, input.timeZone);
  const contributions = await Promise.all([
    isolated('MAIL', () => mailContribution(input.principal, input.mail, period, input.time)),
    isolated('CALENDAR', async () => calendarContribution(input.day, input.time)),
    isolated('CALLGRID', async () => (input.dashboard ? callgridContribution(input.dashboard) : { source: 'CALLGRID', state: 'UNAVAILABLE', note: 'Loop could not read CallGrid just now.' })),
    isolated('WORK', async () => (input.dashboard ? workContribution(input.dashboard) : { source: 'WORK', state: 'UNAVAILABLE', note: 'Loop could not read work just now.' })),
    isolated('HEADLINES', () => headlinesContribution(input.session, input.principal.organizationId)),
  ]);
  return { review: composeReview(contributions.filter((c): c is ReviewContribution => c !== null)), period };
}
