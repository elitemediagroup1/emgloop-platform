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
//
// CALLGRID IS THE COMMAND CENTER'S OWN READ. The CallGrid contribution takes the projected command
// context (kpis.ts) and the Executive Brain's signals; it no longer states a "yesterday" fact of
// its own from a scorecard that compared a partial day with a complete one (retired 2026-09-24).

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
  type HeadlineView,
  type AttentionAssessment,
} from '@emgloop/shared';
import { WorkGraphRepository, prisma, type WorkPrincipal } from '@emgloop/database';

import type { AuthSession } from '../../../auth/auth';
import { canOpenHeadlines } from '../../../crm/headlines-access';
import type { MailDashboard } from '../../../daily-loop/mail-dashboard';
import type { YourDayView } from '../../../daily-loop/your-day';
import { counterpartName, laneLine, opportunityLine, rowPill } from '../mail/_mail/dashboard';
import type { HomeData } from '../admin/home-data';
import { loadAttention } from '../admin/headlines/headlines-data';
import type { HomeKpiStrip } from './kpis';
import { auditUpdates, type OrgActivity } from './org-activity';
import { settle } from './settle';

/** A contribution, or UNAVAILABLE when building it threw. Never a thrown Home. */
async function isolated(source: ReviewContribution['source'], build: () => Promise<ReviewContribution | null>): Promise<ReviewContribution | null> {
  const result = await settle(build);
  return result.ok ? result.value : { source, state: 'UNAVAILABLE', note: 'Loop could not read this just now.' };
}

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

/**
 * CallGrid, as the Command Center reads it. The state is the projected context's own (read, could
 * not be read, or nothing ever delivered); the attention rows are the Executive Brain's signals over
 * the same organization. No figure is stated here: the KPI row states them, with their comparison.
 */
function callgridContribution(home: HomeData | null, callgrid: HomeKpiStrip | null): ReviewContribution {
  if (!callgrid || callgrid.state === 'UNAVAILABLE') return { source: 'CALLGRID', state: 'UNAVAILABLE', note: 'Loop could not read CallGrid just now.' };
  if (callgrid.state === 'NO_DATA') return { source: 'CALLGRID', state: 'NOT_CONNECTED', note: 'CallGrid has not sent any calls yet.' };
  const attention = (home?.brain.signals ?? []).map((s): ReviewAttention => ({
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
  return { source: 'CALLGRID', state: 'OK', attention };
}

function workContribution(home: HomeData, activity: OrgActivity | null): ReviewContribution {
  const w = home.workspace;
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
  // The business acts the audit log recorded, as the Universal Activity audit adapter returned
  // them -- under `audit:view`, which the direct audit read this replaced never required.
  const updates = auditUpdates(activity).map((a): ReviewUpdate => ({
    key: `activity:${a.id}`,
    source: 'WORK',
    at: a.at,
    who: a.who,
    what: a.what,
    status: a.area,
    tone: 'neutral',
    href: null,
  }));
  const facts: ReviewFact[] = w.executiveSummary.slice(0, 1).map((sentence) => ({ rank: 50, sentence }));
  return { source: 'WORK', state: 'OK', facts, attention, attentionCount: w.attentionTotal, updates };
}

/** What the Headlines read established, kept beside the contribution for Home's own Headlines panel. */
interface HeadlinesSink {
  /** Whether this seat may open Headlines at all (ADMIN + commercialIntelligence:view). */
  offered: boolean;
  headlines: readonly HeadlineView[] | null;
  attention: AttentionAssessment | null;
}

/** The Headlines Home read: only the ones nobody dismissed, so a dismissed Headline never reappears here. */
async function headlinesContribution(session: AuthSession, organizationId: string, sink: HeadlinesSink): Promise<ReviewContribution | null> {
  if (!(await canOpenHeadlines(session))) return null;
  sink.offered = true;
  const result = await loadAttention(organizationId, new Date(), { dismissed: false });
  if (!result.ok) return { source: 'HEADLINES', state: 'UNAVAILABLE', note: 'Loop could not read Headlines just now.' };
  sink.headlines = result.value.headlines;
  sink.attention = result.value.attention;
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
  /** Whether this seat may open Headlines (ADMIN + commercialIntelligence:view); Home draws its Headlines panel only then. */
  readonly headlinesOffered: boolean;
  /**
   * The non-dismissed Headlines the review read (one read, shared with Home's Headlines panel and
   * "What changed"); null when this seat cannot open Headlines or the read failed.
   */
  readonly headlines: readonly HeadlineView[] | null;
  /** The governed attention state the same read produced; null on the same conditions. */
  readonly attention: AttentionAssessment | null;
}

export async function loadExecutiveReview(input: {
  readonly session: AuthSession;
  readonly principal: WorkPrincipal;
  readonly time: TimeView;
  readonly timeZone: string;
  readonly mail: MailDashboard | null;
  readonly day: YourDayView | null;
  /** The operational home (work, attention, the Brain); null when its read failed. */
  readonly home: HomeData | null;
  /** The organization's activity feed Home read once (org-activity-data.ts); its audit acts are the work changes. */
  readonly activity: OrgActivity | null;
  /** The projected command context: `offered` false when this seat is not shown CallGrid at all. */
  readonly callgrid: { readonly offered: boolean; readonly strip: HomeKpiStrip | null };
}): Promise<ExecutiveReviewData> {
  const period = reviewPeriod(input.time.now, input.timeZone);
  const sink: HeadlinesSink = { offered: false, headlines: null, attention: null };
  const contributions = await Promise.all([
    isolated('MAIL', () => mailContribution(input.principal, input.mail, period, input.time)),
    isolated('CALENDAR', async () => calendarContribution(input.day, input.time)),
    isolated('CALLGRID', async () => (input.callgrid.offered ? callgridContribution(input.home, input.callgrid.strip) : null)),
    isolated('WORK', async () => (input.home ? workContribution(input.home, input.activity) : { source: 'WORK', state: 'UNAVAILABLE', note: 'Loop could not read work just now.' })),
    isolated('HEADLINES', () => headlinesContribution(input.session, input.principal.organizationId, sink)),
  ]);
  return {
    review: composeReview(contributions.filter((c): c is ReviewContribution => c !== null)),
    period,
    headlinesOffered: sink.offered,
    headlines: sink.headlines,
    attention: sink.attention,
  };
}
