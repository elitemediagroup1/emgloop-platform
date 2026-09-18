// Mail intelligence -- what the Mail dashboard shows, decided from stored facts. PURE.
//
// No I/O, no clock, no model, no body. Every decision here is a rule over what Loop already stores
// about the employee's OWN mailbox (GM-1): which way each message went and when, who sent it,
// whether it replies to something, the subject, and the labels Gmail itself applied. Each decision
// carries its reason, so a person can see WHY a conversation is where it is and disagree with it.
//
// WHERE THIS SITS. GM-3's `mailAttention` still produces the correctable work items (Handled,
// Snooze, Dismiss, "I'm waiting on them") and nothing here replaces it. This is the READ MODEL the
// Mail dashboard and Home show: it reads the same facts, finer grained -- it separates "waiting on
// them" from "a follow-up is due", tells a person from a notification, and surfaces opportunity
// signals -- and it obeys every correction the employee made.
//
// NOTHING HERE IS AN OPAQUE SCORE. A lane is a rule; an opportunity is a named signal; an area is
// a matched word. When a rule cannot tell, the conversation is simply not raised.

import { MAIL_ATTENTION_POLICY } from './mail-attention';

/** The three places a conversation that needs a person can be. */
export const MAIL_LANES = ['NEEDS_REPLY', 'FOLLOW_UP', 'WAITING'] as const;
export type MailLane = (typeof MAIL_LANES)[number];

/** EMG's business areas, as a conversation's subject names them. */
export const MAIL_AREAS = ['TALENT', 'PERFORMANCE', 'OPERATIONS'] as const;
export type MailArea = (typeof MAIL_AREAS)[number];

/**
 * The thresholds, stated once. Operating policy, not constants of nature.
 *
 * Needs Reply keeps GM-3's own rule (unread at once, otherwise after four hours). A follow-up is
 * due three days after the employee wrote last with no answer; before that they are simply
 * waiting. Nothing older than the attention horizon is raised at all.
 */
export const MAIL_INTELLIGENCE_POLICY = Object.freeze({
  replyAfterMs: MAIL_ATTENTION_POLICY.needsYouAfterMs,
  followUpAfterMs: 3 * 24 * 60 * 60 * 1000,
  horizonMs: MAIL_ATTENTION_POLICY.horizonMs,
  /** An opportunity is "new" for two weeks after its signal. */
  opportunityWindowMs: 14 * 24 * 60 * 60 * 1000,
  /** "Recent" for the recent-important list. */
  recentWindowMs: 7 * 24 * 60 * 60 * 1000,
  /** "In the last day", for the inflow line under each card. */
  inflowWindowMs: 24 * 60 * 60 * 1000,
});
export type MailIntelligencePolicy = typeof MAIL_INTELLIGENCE_POLICY;

/** One stored message, as the rules need it. Nothing from a body. */
export interface MailMessageEvidence {
  readonly at: Date;
  readonly direction: 'INBOUND' | 'OUTBOUND';
  /** The sender, for an inbound message. Null when Loop does not hold the address. */
  readonly fromAddress: string | null;
  readonly fromName: string | null;
  readonly labels: readonly string[];
  /** The RFC 5322 In-Reply-To header. A message that starts a conversation has none. */
  readonly inReplyTo: string | null;
}

/** One conversation's stored facts. `messages` oldest first, as Loop holds them. */
export interface MailThreadEvidence {
  readonly threadId: string;
  readonly subject: string | null;
  readonly lastMessageAt: Date | null;
  readonly lastDirection: 'INBOUND' | 'OUTBOUND' | null;
  readonly unread: boolean;
  readonly messages: readonly MailMessageEvidence[];
  /** The other people on the conversation, as Loop holds them. */
  readonly people: readonly { readonly address: string; readonly name: string | null }[];
}

/**
 * What the employee has told Loop about one conversation (GM-3 corrections).
 *
 * `closed` is a Handled or Dismiss on an item of that class, with when. `snoozedUntil` hides the
 * conversation until then. `waitingOnThemAt` is "I'm waiting on them".
 */
export interface MailCorrections {
  readonly closed: readonly { readonly class: 'NEEDS_YOU' | 'WAITING_ON_THEM' | 'GONE_QUIET'; readonly at: Date }[];
  readonly snoozedUntil: Date | null;
  readonly waitingOnThemAt: Date | null;
}

export const NO_CORRECTIONS: MailCorrections = Object.freeze({ closed: [], snoozedUntil: null, waitingOnThemAt: null });

/** Why a conversation is in its lane. The UI turns the code and instant into words. */
export type MailLaneReason =
  | 'UNREAD_INBOUND'
  | 'INBOUND_UNANSWERED'
  | 'OUTREACH_REPLY_UNANSWERED'
  | 'AWAITING_RESPONSE'
  | 'MARKED_WAITING'
  | 'OUTREACH_NO_RESPONSE'
  | 'NO_RESPONSE_SINCE';

export interface MailOpportunity {
  readonly kind: 'INBOUND_INQUIRY' | 'OUTREACH_REPLY';
  /** When the signal happened: the inquiry, or their reply to the outreach. */
  readonly at: Date;
  /** The subject word that made it an inquiry, for INBOUND_INQUIRY. */
  readonly matched: string | null;
}

export interface MailInsight {
  readonly threadId: string;
  readonly subject: string | null;
  readonly lastMessageAt: Date | null;
  readonly unread: boolean;
  /** Who the conversation is with: the last person who wrote, else the first other participant. */
  readonly counterpart: { readonly name: string | null; readonly address: string | null; readonly domain: string | null } | null;
  readonly startedBySelf: boolean;
  readonly lastInboundAt: Date | null;
  readonly lastOutboundAt: Date | null;
  /** Why this is treated as notification mail, or null for a conversation between people. */
  readonly notification: string | null;
  readonly lane: MailLane | null;
  readonly laneReason: MailLaneReason | null;
  /** The instant the lane reason is about (their message, or yours). */
  readonly laneAt: Date | null;
  readonly opportunity: MailOpportunity | null;
  readonly areas: readonly { readonly area: MailArea; readonly matched: string }[];
}

// --- Notification mail -------------------------------------------------------------------------

/** Gmail's own bulk tabs (system labels applied by Gmail), and the words for them. */
const BULK_CATEGORIES: Readonly<Record<string, string>> = Object.freeze({
  CATEGORY_PROMOTIONS: 'Promotions',
  CATEGORY_SOCIAL: 'Social',
  CATEGORY_FORUMS: 'Forums',
  CATEGORY_UPDATES: 'Updates',
});

/** Local parts machines send from. Matched as whole segments, so "noreply" in "messages-noreply" counts. */
const AUTOMATED_SEGMENT = /(^|[._+-])(no-?reply|do-?not-?reply|donotreply|mailer-daemon|postmaster|bounces?)([._+-]|$)/i;
const AUTOMATED_PREFIX = /^(notifications?|notify|alerts?|newsletters?|digest|updates|automated|robot)([._+-]|$)/i;

export function isAutomatedAddress(address: string | null): boolean {
  if (!address) return false;
  const local = address.split('@')[0] ?? '';
  return AUTOMATED_SEGMENT.test(local) || AUTOMATED_PREFIX.test(local);
}

/**
 * Why a conversation is notification mail rather than people talking -- or null.
 *
 * A conversation the employee has written in is ALWAYS people talking, whatever Gmail filed it
 * under. Otherwise: the last message's sender is an automated address, or Gmail filed it in one of
 * its bulk tabs.
 */
export function notificationReason(thread: MailThreadEvidence): string | null {
  if (thread.messages.some((m) => m.direction === 'OUTBOUND')) return null;
  const lastInbound = [...thread.messages].reverse().find((m) => m.direction === 'INBOUND');
  if (!lastInbound) return null;
  return notificationMessageReason(lastInbound);
}

/**
 * Why ONE arrived message is notification mail -- an automated sender, or a Gmail bulk tab -- or
 * null. The single rule behind both the Mail dashboard and Home's "relevant emails".
 */
export function notificationMessageReason(message: { readonly fromAddress: string | null; readonly labels: readonly string[] }): string | null {
  if (isAutomatedAddress(message.fromAddress)) return `Sent from an automated address (${message.fromAddress})`;
  const tab = message.labels.map((l) => BULK_CATEGORIES[l]).find(Boolean);
  if (tab) return `Gmail files it under ${tab}`;
  return null;
}

// --- Words in a subject --------------------------------------------------------------------------

/** Subject words that make a new inbound conversation an opportunity signal. */
const OPPORTUNITY_WORDS = [
  'partnership', 'partner', 'partnering', 'collaboration', 'collab', 'sponsorship', 'sponsored', 'sponsor',
  'proposal', 'inquiry', 'enquiry', 'opportunity', 'opportunities', 'introduction', 'intro', 'campaign',
  'brand deal', 'ambassador', 'influencer', 'creator', 'talent', 'media kit', 'rate card', 'rfp', 'pitch',
  'work together', 'booking', 'feature', 'paid',
];

const AREA_WORDS: Readonly<Record<MailArea, readonly string[]>> = Object.freeze({
  TALENT: [
    'creator', 'creators', 'talent', 'influencer', 'influencers', 'ambassador', 'ugc', 'tiktok', 'instagram', 'youtube',
    'collab', 'collaboration', 'sponsorship', 'sponsored', 'media kit', 'rate card', 'brand deal',
  ],
  PERFORMANCE: [
    'callgrid', 'calls', 'call volume', 'buyer', 'buyers', 'publisher', 'publishers', 'io', 'ios', 'insertion order',
    'cap', 'caps', 'payout', 'payouts', 'cpa', 'cpl', 'leads', 'lead', 'traffic', 'billable', 'ping', 'bid', 'rtb',
    'conversion', 'conversions', 'affiliate', 'offer',
  ],
  OPERATIONS: [
    'invoice', 'invoices', 'payment', 'payments', 'contract', 'contracts', 'msa', 'agreement', 'w-9', 'w9', '1099',
    'billing', 'payroll', 'onboarding', 'legal', 'nda', 'insurance', 'tax', 'taxes', 'renewal', 'subscription', 'receipt',
  ],
});

/** A subject without its reply and forward prefixes, lowercased. */
function subjectText(subject: string | null): string {
  let text = (subject ?? '').trim().toLowerCase();
  for (;;) {
    const next = text.replace(/^(re|fw|fwd)\s*:\s*/, '');
    if (next === text) return text;
    text = next;
  }
}

/** The first listed word (or phrase) the subject contains as a whole word. */
function firstMatch(subject: string, words: readonly string[]): string | null {
  for (const word of words) {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+');
    if (new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(subject)) return word;
  }
  return null;
}

export function mailAreas(subject: string | null): { readonly area: MailArea; readonly matched: string }[] {
  const text = subjectText(subject);
  const out: { area: MailArea; matched: string }[] = [];
  for (const area of MAIL_AREAS) {
    const matched = firstMatch(text, AREA_WORDS[area]);
    if (matched) out.push({ area, matched });
  }
  return out;
}

// --- The classification --------------------------------------------------------------------------

const domainOf = (address: string | null): string | null => {
  if (!address) return null;
  const at = address.lastIndexOf('@');
  return at >= 0 ? address.slice(at + 1).toLowerCase() : null;
};

/**
 * Everything the dashboard needs to know about one conversation.
 *
 * `internalDomains` are the organization's own (the connection's Workspace domain, and any the
 * organization configured), so a colleague is never an "opportunity".
 */
export function classifyMailThread(
  thread: MailThreadEvidence,
  corrections: MailCorrections,
  now: Date,
  internalDomains: readonly string[],
  policy: MailIntelligencePolicy = MAIL_INTELLIGENCE_POLICY,
): MailInsight {
  const msgs = [...thread.messages].sort((a, b) => a.at.getTime() - b.at.getTime());
  const first = msgs[0] ?? null;
  const inbound = msgs.filter((m) => m.direction === 'INBOUND');
  const outbound = msgs.filter((m) => m.direction === 'OUTBOUND');
  const lastInbound = inbound.at(-1) ?? null;
  const lastOutbound = outbound.at(-1) ?? null;
  const startedBySelf = first !== null && first.direction === 'OUTBOUND' && !first.inReplyTo;

  const counterpartMsg = lastInbound ?? null;
  const fallback = thread.people[0] ?? null;
  const counterpartAddress = counterpartMsg?.fromAddress ?? fallback?.address ?? null;
  const counterpart =
    counterpartAddress || counterpartMsg?.fromName || fallback
      ? {
          name: counterpartMsg?.fromName ?? (fallback && fallback.address === counterpartAddress ? fallback.name : null) ?? null,
          address: counterpartAddress,
          domain: domainOf(counterpartAddress),
        }
      : null;
  const internal = counterpart?.domain != null && internalDomains.some((d) => d.toLowerCase() === counterpart.domain);

  const notification = notificationReason(thread);
  const lastAt = thread.lastMessageAt;
  const ageMs = lastAt ? now.getTime() - lastAt.getTime() : Infinity;
  const snoozed = corrections.snoozedUntil !== null && corrections.snoozedUntil > now;
  const closedAfter = (cls: 'NEEDS_YOU' | 'WAITING_ON_THEM' | 'GONE_QUIET', since: Date | null) =>
    corrections.closed.some((c) => c.class === cls && (since === null || c.at >= since));

  // --- The lane -------------------------------------------------------------------------------
  let lane: MailLane | null = null;
  let laneReason: MailLaneReason | null = null;
  let laneAt: Date | null = null;
  const inHorizon = lastAt !== null && ageMs >= 0 && ageMs <= policy.horizonMs;

  if (notification === null && inHorizon && !snoozed) {
    if (thread.lastDirection === 'INBOUND' && lastInbound) {
      const saidWaiting = corrections.waitingOnThemAt !== null && corrections.waitingOnThemAt >= lastInbound.at;
      if (saidWaiting) {
        lane = 'WAITING';
        laneReason = 'MARKED_WAITING';
        laneAt = corrections.waitingOnThemAt;
      } else if ((thread.unread || ageMs >= policy.replyAfterMs) && !closedAfter('NEEDS_YOU', lastInbound.at)) {
        lane = 'NEEDS_REPLY';
        laneReason = thread.unread ? 'UNREAD_INBOUND' : startedBySelf ? 'OUTREACH_REPLY_UNANSWERED' : 'INBOUND_UNANSWERED';
        laneAt = lastInbound.at;
      }
    } else if (thread.lastDirection === 'OUTBOUND' && lastOutbound) {
      const handled = closedAfter('WAITING_ON_THEM', lastOutbound.at) || closedAfter('GONE_QUIET', lastOutbound.at);
      if (!handled) {
        const sinceSent = now.getTime() - lastOutbound.at.getTime();
        if (sinceSent < policy.followUpAfterMs) {
          lane = 'WAITING';
          laneReason = 'AWAITING_RESPONSE';
        } else {
          lane = 'FOLLOW_UP';
          laneReason = startedBySelf && inbound.length === 0 ? 'OUTREACH_NO_RESPONSE' : 'NO_RESPONSE_SINCE';
        }
        laneAt = lastOutbound.at;
      }
    }
  }

  // --- The opportunity signal -------------------------------------------------------------------
  let opportunity: MailOpportunity | null = null;
  if (notification === null && !internal && counterpart?.domain) {
    if (startedBySelf && first) {
      // They answered a conversation the employee started: outreach that got a reply.
      const reply = inbound.find((m) => m.at > first.at) ?? null;
      if (reply && now.getTime() - reply.at.getTime() <= policy.opportunityWindowMs) {
        opportunity = { kind: 'OUTREACH_REPLY', at: reply.at, matched: null };
      }
    } else if (first && first.direction === 'INBOUND' && !first.inReplyTo && now.getTime() - first.at.getTime() <= policy.opportunityWindowMs) {
      // A new conversation somebody outside started, about something commercial.
      const matched = firstMatch(subjectText(thread.subject), OPPORTUNITY_WORDS);
      if (matched) opportunity = { kind: 'INBOUND_INQUIRY', at: first.at, matched };
    }
  }

  return {
    threadId: thread.threadId,
    subject: thread.subject,
    lastMessageAt: thread.lastMessageAt,
    unread: thread.unread,
    counterpart,
    startedBySelf,
    lastInboundAt: lastInbound?.at ?? null,
    lastOutboundAt: lastOutbound?.at ?? null,
    notification,
    lane,
    laneReason,
    laneAt,
    opportunity,
    areas: mailAreas(thread.subject),
  };
}

// --- The dashboard ------------------------------------------------------------------------------

export const MAIL_VIEWS = ['dashboard', 'all', 'needs-reply', 'follow-ups', 'waiting', 'opportunities', 'talent', 'performance', 'operations'] as const;
export type MailViewKey = (typeof MAIL_VIEWS)[number];

export function parseMailView(raw: unknown): MailViewKey {
  return typeof raw === 'string' && (MAIL_VIEWS as readonly string[]).includes(raw) ? (raw as MailViewKey) : 'dashboard';
}

export interface MailFilter {
  readonly view: MailViewKey;
  /** Case-insensitive search over subject, name, address and domain. */
  readonly query: string;
  readonly unreadOnly: boolean;
  /** Include notification mail. Off by default: the dashboard is about people. */
  readonly includeNotifications: boolean;
}

export function matchesMailQuery(insight: MailInsight, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === '') return true;
  const hay = [insight.subject, insight.counterpart?.name, insight.counterpart?.address, insight.counterpart?.domain]
    .filter((v): v is string => typeof v === 'string')
    .join(' \n ')
    .toLowerCase();
  return hay.includes(q);
}

const newestFirst = (at: (i: MailInsight) => Date | null) => (a: MailInsight, b: MailInsight) =>
  (at(b)?.getTime() ?? 0) - (at(a)?.getTime() ?? 0);
const longestWaitingFirst = (a: MailInsight, b: MailInsight) => (a.laneAt?.getTime() ?? 0) - (b.laneAt?.getTime() ?? 0);

/** The conversations one view shows, in the order it shows them. */
export function mailViewRows(insights: readonly MailInsight[], filter: MailFilter): MailInsight[] {
  const base = insights
    .filter((i) => filter.includeNotifications || i.notification === null)
    .filter((i) => !filter.unreadOnly || i.unread)
    .filter((i) => matchesMailQuery(i, filter.query));
  switch (filter.view) {
    case 'needs-reply':
      return base.filter((i) => i.lane === 'NEEDS_REPLY').sort(longestWaitingFirst);
    case 'follow-ups':
      return base.filter((i) => i.lane === 'FOLLOW_UP').sort(longestWaitingFirst);
    case 'waiting':
      return base.filter((i) => i.lane === 'WAITING').sort(newestFirst((i) => i.laneAt));
    case 'opportunities':
      return base.filter((i) => i.opportunity !== null).sort(newestFirst((i) => i.opportunity!.at));
    case 'talent':
    case 'performance':
    case 'operations': {
      const area = filter.view.toUpperCase() as MailArea;
      return base.filter((i) => i.areas.some((a) => a.area === area)).sort(newestFirst((i) => i.lastMessageAt));
    }
    default:
      return base.sort(newestFirst((i) => i.lastMessageAt));
  }
}

export interface MailSummary {
  readonly needsReply: number;
  readonly followUps: number;
  readonly waiting: number;
  readonly opportunities: number;
  readonly talent: number;
  readonly performance: number;
  readonly operations: number;
  /** Conversations people are having (notification mail excluded). */
  readonly conversations: number;
  /**
   * What arrived in the last day, per card -- facts about stored instants, not a comparison with a
   * snapshot Loop never took. Needs Reply: their message in the last day. Follow-Ups: became due in
   * the last day. Waiting: you wrote in the last day. Opportunities: the signal was in the last day.
   */
  readonly inflow: { readonly needsReply: number; readonly followUps: number; readonly waiting: number; readonly opportunities: number };
}

export function summarizeMail(insights: readonly MailInsight[], now: Date, policy: MailIntelligencePolicy = MAIL_INTELLIGENCE_POLICY): MailSummary {
  const people = insights.filter((i) => i.notification === null);
  const within = (at: Date | null, from: number, to: number) => at !== null && at.getTime() >= from && at.getTime() < to;
  const t = now.getTime();
  const day = policy.inflowWindowMs;
  const lane = (l: MailLane) => people.filter((i) => i.lane === l);
  const area = (a: MailArea) => people.filter((i) => i.areas.some((x) => x.area === a)).length;
  return {
    needsReply: lane('NEEDS_REPLY').length,
    followUps: lane('FOLLOW_UP').length,
    waiting: lane('WAITING').length,
    opportunities: people.filter((i) => i.opportunity !== null).length,
    talent: area('TALENT'),
    performance: area('PERFORMANCE'),
    operations: area('OPERATIONS'),
    conversations: people.length,
    inflow: {
      needsReply: lane('NEEDS_REPLY').filter((i) => within(i.laneAt, t - day, t + 1)).length,
      followUps: lane('FOLLOW_UP').filter((i) => within(i.laneAt, t - policy.followUpAfterMs - day, t - policy.followUpAfterMs + 1)).length,
      waiting: lane('WAITING').filter((i) => i.laneReason === 'AWAITING_RESPONSE' && within(i.laneAt, t - day, t + 1)).length,
      opportunities: people.filter((i) => i.opportunity !== null && within(i.opportunity.at, t - day, t + 1)).length,
    },
  };
}

/**
 * Recent important conversations: people talking (never notification mail), in the last week,
 * that matter by a rule -- something needs the employee, an opportunity, or a real exchange.
 */
export function recentImportant(insights: readonly MailInsight[], now: Date, limit = 5, policy: MailIntelligencePolicy = MAIL_INTELLIGENCE_POLICY): MailInsight[] {
  return insights
    .filter((i) => i.notification === null && i.lastMessageAt !== null && now.getTime() - i.lastMessageAt.getTime() <= policy.recentWindowMs)
    .filter((i) => i.lane !== null || i.opportunity !== null || (i.lastInboundAt !== null && i.lastOutboundAt !== null))
    .sort(newestFirst((i) => i.lastMessageAt))
    .slice(0, limit);
}
