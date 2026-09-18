// Today's Review -- the executive Home, composed from what Loop already knows. PURE.
//
// No I/O, no clock, no model. Every source that has something to say -- today mail, calendar,
// CallGrid, Loop work and Headlines -- hands the composer one CONTRIBUTION in the same shape, and
// the composer merges them into the four things the Home shows: a headline, four cards, what
// changed, and what needs attention.
//
// WHY A CONTRACT AND NOT A PAGE THAT READS EVERYTHING. A new source is one more contribution, not
// a reshaped page; and a source that fails is one contribution marked UNAVAILABLE, not a Home that
// will not render. The second is not hypothetical: a Home that read one missing table directly was
// a production outage (2026-09-18).
//
// THE HEADLINE IS FACTS, NOT A NARRATIVE. Each contribution offers complete sentences built from
// its own counts and names ("2 conversations need your reply, including …"), ranked; the composer
// takes the most important few. Nothing here reads a message body, guesses what a conversation is
// ABOUT, or chooses an adjective -- "accelerated", "major", "urgent" are claims Loop cannot yet
// support, and saying them anyway is exactly the fabricated reasoning the platform refuses. No model
// writes any of it; nothing here calls one.

import { startOfZonedDay } from './loop-time';
import { notificationMessageReason } from './mail-intelligence';

/** Where a contribution comes from. A new source is a new member, and a reviewed one. */
export const REVIEW_SOURCES = ['MAIL', 'CALENDAR', 'CALLGRID', 'WORK', 'HEADLINES'] as const;
export type ReviewSourceId = (typeof REVIEW_SOURCES)[number];

export const REVIEW_SOURCE_LABELS: Readonly<Record<ReviewSourceId, string>> = Object.freeze({
  MAIL: 'your mail',
  CALENDAR: 'your calendar',
  CALLGRID: 'CallGrid',
  WORK: 'Loop work',
  HEADLINES: 'Headlines',
});

/**
 * OK             the source was read and what it says is current enough to state.
 * NOT_CONNECTED  the source exists but is not connected for this person (no Google, no scope).
 * UNAVAILABLE    the source could not be read just now. Its absence is said, never hidden.
 */
export type ReviewSourceState = 'OK' | 'NOT_CONNECTED' | 'UNAVAILABLE';

export type ReviewTone = 'critical' | 'attention' | 'good' | 'neutral';

/** One sentence a source offers for the headline. Lower rank is said first. */
export interface ReviewFact {
  readonly rank: number;
  readonly sentence: string;
}

export const REVIEW_METRICS = ['relevantEmails', 'newOpportunities', 'needAttention', 'outreachSent'] as const;
export type ReviewMetricKey = (typeof REVIEW_METRICS)[number];

/**
 * A card's value -- or the honest reason there is none.
 *
 * `prior` is the same count over the equal-length period just before, when the source can say it;
 * null means no comparison is claimed, never "no change".
 */
export type ReviewMetric =
  | { readonly state: 'VALUE'; readonly value: number; readonly prior: number | null; readonly href: string | null; readonly scope: string }
  | { readonly state: 'UNAVAILABLE'; readonly reason: string }
  | { readonly state: 'NOT_TRACKED'; readonly reason: string };

/** Something that changed: who or what, what happened, and a status word backed by a fact. */
export interface ReviewUpdate {
  readonly key: string;
  readonly source: ReviewSourceId;
  readonly at: Date;
  readonly who: string;
  readonly what: string;
  readonly status: string;
  readonly tone: ReviewTone;
  readonly href: string | null;
}

/**
 * Something that needs a person: WHO/WHAT -> WHAT HAPPENED -> WHAT NEEDS TO HAPPEN NEXT.
 *
 * `rank` orders kinds (0 is most pressing); within a rank, whatever has waited longest comes first.
 * Corrections to a mail item (Handled, Snooze, Dismiss) are made on the conversation itself, which
 * `href` opens -- Home lists, it does not operate.
 */
export interface ReviewAttention {
  readonly key: string;
  readonly source: ReviewSourceId;
  readonly rank: number;
  readonly since: Date | null;
  readonly who: string;
  readonly happened: string;
  readonly next: string;
  readonly tone: ReviewTone;
  readonly href: string | null;
}

/** Everything one source says. Any part may be absent. */
export interface ReviewContribution {
  readonly source: ReviewSourceId;
  readonly state: ReviewSourceState;
  /** Why the source is not OK, in words a person can act on. */
  readonly note?: string;
  readonly facts?: readonly ReviewFact[];
  readonly metrics?: Partial<Record<ReviewMetricKey, ReviewMetric>>;
  readonly updates?: readonly ReviewUpdate[];
  readonly attention?: readonly ReviewAttention[];
  /** How many attention items the source holds, when it listed fewer than it has. */
  readonly attentionCount?: number;
  /** Where the source's full list lives, for the items Home does not have room to show. */
  readonly attentionHref?: string;
}

export interface ExecutiveReview {
  /** The facts that matter most, as sentences. Null when no source had anything to say. */
  readonly headline: string | null;
  readonly sources: readonly { readonly source: ReviewSourceId; readonly state: ReviewSourceState; readonly note?: string }[];
  readonly metrics: Readonly<Record<ReviewMetricKey, ReviewMetric>>;
  readonly updates: readonly ReviewUpdate[];
  readonly attention: readonly ReviewAttention[];
  readonly attentionTotal: number;
  /** Per source, how many of its items are not in `attention`, and where they are. */
  readonly attentionElsewhere: readonly { readonly source: ReviewSourceId; readonly count: number; readonly href: string | null }[];
}

/** The review's own window: since the start of yesterday in the reader's zone, until now. */
export interface ReviewPeriod {
  readonly from: Date;
  readonly to: Date;
}

export function reviewPeriod(now: Date, timeZone: string): ReviewPeriod {
  return { from: startOfZonedDay(new Date(now.getTime() - 86_400_000), timeZone), to: now };
}

export const REVIEW_LIMITS = Object.freeze({ facts: 4, updates: 8, attention: 8 });

/** Why a card has no number, when no source provides it at all. */
const UNTRACKED: Readonly<Record<ReviewMetricKey, string>> = Object.freeze({
  relevantEmails: 'Connect Gmail to count the mail that matters.',
  newOpportunities: 'Loop does not track opportunities yet.',
  needAttention: 'Nothing that raises attention items could be read.',
  outreachSent: 'Connect Gmail to count the conversations you start.',
});

/**
 * Merge every contribution into one review. The order of `contributions` does not matter.
 *
 * Need Attention is always the count of the attention feed itself -- the card and the list can
 * never disagree -- and it is only claimed when at least one attention-raising source was read.
 */
export function composeReview(contributions: readonly ReviewContribution[], limits = REVIEW_LIMITS): ExecutiveReview {
  const readable = contributions.filter((c) => c.state === 'OK');

  const facts = readable
    .flatMap((c) => c.facts ?? [])
    .slice()
    .sort((a, b) => a.rank - b.rank)
    .slice(0, limits.facts)
    .map((f) => f.sentence.trim())
    .filter(Boolean);

  const allAttention = readable.flatMap((c) => c.attention ?? []);
  const attention = allAttention
    .slice()
    .sort((a, b) => a.rank - b.rank || (a.since?.getTime() ?? Infinity) - (b.since?.getTime() ?? Infinity))
    .slice(0, limits.attention);

  // Something that needs a person is shown once, where it asks for them -- not again as news.
  const listed = new Set(attention.map((a) => a.key));
  const updates = readable
    .flatMap((c) => c.updates ?? [])
    .filter((u) => !listed.has(u.key))
    .sort((a, b) => b.at.getTime() - a.at.getTime())
    .slice(0, limits.updates);
  const attentionTotal = readable.reduce((sum, c) => sum + (c.attentionCount ?? c.attention?.length ?? 0), 0);
  const attentionElsewhere = readable
    .map((c) => ({
      source: c.source,
      count: (c.attentionCount ?? c.attention?.length ?? 0) - attention.filter((a) => a.source === c.source).length,
      href: c.attentionHref ?? null,
    }))
    .filter((e) => e.count > 0);
  const attentionSources = readable.filter((c) => c.attention !== undefined);

  const metrics = {} as Record<ReviewMetricKey, ReviewMetric>;
  for (const key of REVIEW_METRICS) {
    if (key === 'needAttention') continue;
    const offered = contributions.map((c) => c.metrics?.[key]).find((m) => m !== undefined);
    metrics[key] = offered ?? { state: 'NOT_TRACKED', reason: UNTRACKED[key] };
  }
  metrics.needAttention =
    attentionSources.length > 0
      ? { state: 'VALUE', value: attentionTotal, prior: null, href: '#needs-attention', scope: 'across the sources Loop read' }
      : { state: 'UNAVAILABLE', reason: UNTRACKED.needAttention };

  return {
    headline: facts.length > 0 ? facts.join(' ') : null,
    sources: contributions.map((c) => ({ source: c.source, state: c.state, ...(c.note ? { note: c.note } : {}) })),
    metrics,
    updates,
    attention,
    attentionTotal,
    attentionElsewhere,
  };
}

// --- Mail: what counts, over a window ----------------------------------------------------------

/**
 * Whether an arrived message is mail that matters: not spam or trash, and not notification mail by
 * the Mail dashboard's own rule (`notificationMessageReason`: an automated sender, or one of
 * Gmail's bulk tabs -- Promotions, Social, Forums, Updates -- which Gmail applies itself as system
 * labels, developers.google.com/workspace/gmail/api/guides/labels). ONE definition: Home's count
 * and Mail's lanes can never disagree about what is noise.
 */
export function isRelevantMail(message: { readonly fromAddress: string | null; readonly labels: readonly string[] }): boolean {
  if (message.labels.includes('SPAM') || message.labels.includes('TRASH')) return false;
  return notificationMessageReason(message) === null;
}

/** One stored message, as far as counting needs it. Nothing from a body. */
export interface MailActivityMessage {
  readonly threadId: string;
  readonly internalDate: Date;
  readonly direction: 'INBOUND' | 'OUTBOUND' | string;
  readonly labels: readonly string[];
  /** The RFC 5322 In-Reply-To header. A message that starts a conversation has none. */
  readonly inReplyTo?: string | null;
  /** The sender's stored address, for a message that arrived; null when Loop holds none. */
  readonly fromAddress?: string | null;
}

export interface MailActivityCounts {
  /** Messages that arrived and are not notification mail (`isRelevantMail`). */
  readonly relevantInbound: number;
  /**
   * Conversations the employee STARTED in the window: the thread's first stored message is theirs
   * and replies to nothing. Both, because Loop's mailbox read begins at a date: a reply to a
   * conversation older than that can be the first message Loop holds, and it is not outreach.
   */
  readonly conversationsStarted: number;
}

/**
 * Counts over one half-open window `[from, to)`. `firstMessageAt` is each thread's first message,
 * as the thread row records it, so a reply to an old conversation is never counted as outreach.
 */
export function mailActivity(
  messages: readonly MailActivityMessage[],
  firstMessageAt: ReadonlyMap<string, Date>,
  window: { readonly from: Date; readonly to: Date },
): MailActivityCounts {
  const inWindow = (at: Date) => at >= window.from && at < window.to;
  let relevantInbound = 0;
  const started = new Set<string>();
  for (const m of messages) {
    if (!inWindow(m.internalDate)) continue;
    if (m.direction === 'INBOUND' && isRelevantMail({ fromAddress: m.fromAddress ?? null, labels: m.labels })) relevantInbound += 1;
    if (m.direction === 'OUTBOUND' && !m.inReplyTo) {
      const first = firstMessageAt.get(m.threadId);
      if (first && first.getTime() === m.internalDate.getTime()) started.add(m.threadId);
    }
  }
  return { relevantInbound, conversationsStarted: started.size };
}

// --- Words ---------------------------------------------------------------------------------------

/** "1 reply" / "3 replies". */
export function counted(n: number, one: string, many: string): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
}

/** “A”, “A” and “B”, “A”, “B” and 2 more -- names quoted exactly as stored. */
export function namedList(names: readonly string[], max = 2): string {
  const shown = names.filter((n) => n.trim() !== '').slice(0, max).map((n) => `“${n.trim()}”`);
  const rest = names.length - shown.length;
  if (shown.length === 0) return '';
  if (rest > 0) return `${shown.join(', ')} and ${rest} more`;
  return shown.length === 2 ? `${shown[0]} and ${shown[1]}` : shown[0]!;
}
