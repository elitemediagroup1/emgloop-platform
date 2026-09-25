// Chats -- what Loop understands about a person's own chats, as the Chats page and Home both read it.
// PURE.
//
// ONE COMPOSITION, TWO DEPTHS. The Chats page (/app/chats) and Loop Home's Chats tile render the
// result of `composeChatsIntelligence`, so the domain and its window onto Home can never tell a person
// two different things: the tile shows the statement, the metric and the freshness; the page shows
// the same statement and then everything under it. It composes, deterministically and at read time,
// over authorities that already exist -- and nothing more:
//
//   - the viewer's OWN current CHATS digests (`intelligence_digests`, one per conversation, written by
//     the content-triage producer under the person's content consent). These are the ONLY source of
//     intelligence here: every sentence that says what is happening in a conversation is a digest's
//     own field, selected and counted -- never re-worded into a new claim;
//   - the viewer's OWN Telegram connection, as the Connections page reads it (state, and whether AI
//     triage -- the separate content consent -- is on);
//   - the viewer's OWN open NEEDS_YOU items the triage sweep raised (Work OS). These are OBLIGATIONS,
//     kept separate from the intelligence ("What you owe"): the AI's minimized paraphrase, the
//     source's own label for the conversation, a topic, a next step and a grounded deadline;
//   - content-free activity (how many messages and conversations since a moment, and when each
//     conversation was last active) -- supporting evidence only. It decides whether a digest is out
//     of date; it is NEVER turned into a summary, and it is called "active", never "business".
//
// NOTHING HERE IS INVENTED. "Business" means a digest whose relevance is BUSINESS, nothing else. A
// conversation is named only by the label Telegram itself shows (carried on the viewer's own
// obligations for that conversation); one without a label is said to be one Loop could not name --
// never a key. Where no digest exists, Loop says it has not generated Chats intelligence yet, and
// why; it never builds a summary from counts. How current a reading is comes from `digestFreshness`
// and is said in the governed coverage words (`intelligenceCoverageLabel`).
//
// NO I/O, NO CLOCK. The server loader (chats.ts) reads, and `now` is handed in; this decides. No
// loader, repository or database import belongs in this file -- only @emgloop/shared's pure contract.

import {
  DERIVED_WORK_SUBJECT_PREFIXES,
  INTELLIGENCE_COVERAGE,
  digestFreshness,
  intelligenceCoverageLabel,
  mayReadAbsenceAsNothingHappened,
  mayShowAsCurrent,
  type DigestConfidence,
  type DigestContent,
  type DigestRelevance,
  type IntelligenceCoverage,
  type ProductLabel,
} from '@emgloop/shared';

// --- Input ---------------------------------------------------------------------------------------

/** One flagged obligation, minimized. Never a message body, and never a link into the source. */
export interface ChatsItem {
  readonly provider: string;
  readonly category: string | null;
  readonly counterparty: string | null;
  readonly topic: string | null;
  readonly title: string;
  readonly nextStep: string | null;
  readonly deadline: string | null;
  readonly at: Date;
  /** The KEYED conversation the obligation came from (never a raw id, never shown). Links it to its digest. */
  readonly conversationKey?: string | null;
}

/** The viewer's own Telegram connection, in the Connections page's words. */
export interface ChatsConnection {
  readonly configured: boolean;
  readonly state: string;
  /** The Connections page's own label for the state ("Ready", "Not connected", ...). */
  readonly label: string;
  readonly contentAuthorized: boolean;
}

/** Content-free activity since a moment: counts only. */
export interface ChatsActivity {
  readonly since: Date;
  readonly messages: number;
  readonly conversations: number;
}

/** One of the viewer's own current CHATS digests, as the composition reads it. No provenance, no ids but the keyed subject. */
export interface ChatsDigest {
  /** The keyed subject reference. Used to link a digest to its obligations and activity; never rendered. */
  readonly subjectRef: string;
  readonly content: DigestContent;
  /** As recorded at generation (ERROR when the stored row could not be understood). */
  readonly coverage: IntelligenceCoverage;
  readonly status: string;
  readonly windowEnd: Date;
  readonly expiresAt: Date;
  readonly generatedAt: Date;
  readonly lastEvidenceAt: Date | null;
  readonly evidenceCount: number;
}

export interface ChatsIntelligenceInput {
  /** null: this person may not view connections. */
  readonly connection: ChatsConnection | null;
  /** The viewer's own current CHATS digests; null when that read failed (said, never read as "none"). */
  readonly digests: readonly ChatsDigest[] | null;
  readonly items: readonly ChatsItem[];
  /** null: the count could not be read -- said, never drawn as zero. */
  readonly activity24h: ChatsActivity | null;
  readonly activity7d: ChatsActivity | null;
  /** When each conversation (by key) was last active, content-free; null when unknown. */
  readonly latestActivity: ReadonlyMap<string, Date> | null;
  readonly now: Date;
}

// --- Output --------------------------------------------------------------------------------------

/**
 *   NOT_PERMITTED        this person may not view connections.
 *   NOT_AVAILABLE        this deployment cannot connect Telegram.
 *   NOT_CONNECTED        nothing live: never connected, disconnected, or sign-in not finished.
 *   CONSENT_OFF          live, but AI triage (the content consent) is off: Loop reads no content.
 *   UNAVAILABLE          connected once and Loop cannot use it now (reconnect required, a failure),
 *                        or Loop could not read its own Chats intelligence.
 *   NO_INTELLIGENCE_YET  live, triage on, and no digest exists yet.
 *   STALE                digests exist, and none may be shown as current.
 *   CURRENT              at least one digest may be shown as current.
 */
export type ChatsState = 'NOT_PERMITTED' | 'NOT_AVAILABLE' | 'NOT_CONNECTED' | 'CONSENT_OFF' | 'UNAVAILABLE' | 'NO_INTELLIGENCE_YET' | 'STALE' | 'CURRENT';

/** Why UNAVAILABLE: the connection itself, or Loop's own read of its intelligence. Null otherwise. */
export type ChatsUnavailable = 'CONNECTION' | 'READ_FAILED' | null;

/** The viewer's obligations in one conversation (Work OS), grouped by the source's own label. */
export interface ChatsConversation {
  /** The source's own label for the conversation, or null when it had none. */
  readonly label: string | null;
  /** Most pressing first. */
  readonly items: readonly ChatsItem[];
  readonly latestAt: Date;
  readonly hasDeadline: boolean;
}

/** Loop's interpretation of one conversation: one digest's own fields, and how current it is. */
export interface ChatsConversationCard {
  /** The keyed subject, for list keys only. Never rendered. */
  readonly key: string;
  /** Telegram's own label for the conversation, from the viewer's obligations there; null when none is known. */
  readonly label: string | null;
  readonly relevance: DigestRelevance | null;
  readonly synthesis: string | null;
  readonly stateChange: string | null;
  readonly topics: readonly string[];
  readonly developments: readonly string[];
  readonly commitments: readonly string[];
  readonly opportunities: readonly string[];
  readonly concerns: readonly string[];
  readonly operational: readonly string[];
  readonly unresolved: readonly string[];
  readonly limitations: readonly string[];
  readonly confidence: DigestConfidence | null;
  /** The digest's own sentence on why this conversation needs the person now; null when it gave none. */
  readonly attention: string | null;
  /** The coverage the digest has NOW (`digestFreshness`), and its governed words. */
  readonly coverage: IntelligenceCoverage;
  readonly coverageLabel: ProductLabel;
  /** Whether it may be presented as the current state of the conversation. */
  readonly asCurrent: boolean;
  readonly generatedAt: Date;
  readonly lastEvidenceAt: Date | null;
  /** How many of the viewer's open obligations come from this conversation. */
  readonly owed: number;
  /** What stands out, counted from its own fields and obligations ("1 unresolved situation"). Empty when nothing does. */
  readonly flags: readonly string[];
}

export interface ChatsCoverageSummary {
  /** Per coverage value, in the contract's order: how many digests have it now. */
  readonly counts: readonly { readonly coverage: IntelligenceCoverage; readonly label: ProductLabel; readonly count: number }[];
  /** e.g. "Up to date", or "2 up to date · 1 out of date"; null when there is no digest. */
  readonly words: string | null;
  /** The newest generation among the digests; null when there is none. */
  readonly latestGeneratedAt: Date | null;
}

export interface ChatsIntelligence {
  readonly state: ChatsState;
  readonly unavailable: ChatsUnavailable;
  /** The one compact statement: what the tile says, and what the page leads with. */
  readonly statement: string;
  /** At most two sentences, the statement first. */
  readonly headline: readonly string[];
  readonly metric: { readonly value: string; readonly label: string } | null;
  /** Digests whose relevance is BUSINESS; null when there are no digests to count. */
  readonly businessConversations: number | null;
  /** e.g. "Telegram · Ready · Triage on". Null when the person may not view connections. */
  readonly status: string | null;
  readonly coverage: ChatsCoverageSummary;
  /** Business and unclear conversations, most attention-worthy first. */
  readonly conversations: readonly ChatsConversationCard[];
  /** Conversations Loop read as not business: counted, not shown. */
  readonly notBusiness: number;
  /** What the viewer owes (Work OS obligations), grouped by the source's own label, most pressing first. */
  readonly obligations: readonly ChatsConversation[];
  /** One sentence on the obligations, or null when there are none. */
  readonly owed: string | null;
  readonly activity24h: ChatsActivity | null;
  readonly activity7d: ChatsActivity | null;
}

/** The only source Chats reads today. */
export const CHATS_PROVIDER = 'TELEGRAM';
const PROVIDER_LABEL = 'Telegram';

/** The label a conversation Loop could not name is shown under. */
export const UNNAMED_CONVERSATION = 'A conversation Loop could not name';

/** What Loop says where no digest exists. */
export const NO_CHATS_INTELLIGENCE = 'Loop hasn’t generated Chats intelligence yet.';

/**
 * Whether the person must go to Connections to change anything: only when setup or the content
 * consent is actually required. Every other state -- intelligence or not -- belongs on the Chats page.
 */
export function chatsNeedsConnections(state: ChatsState): boolean {
  return state === 'NOT_CONNECTED' || state === 'CONSENT_OFF';
}

// --- Obligations (Work OS), unchanged in meaning ---------------------------------------------------

/**
 * The triage categories, in the person's words, most pressing first. Presentation and ordering only;
 * the vocabulary is the AI triage task's (AI_TRIAGE_CATEGORIES). BUSINESS_CHANGE is not something
 * owed -- it is reported as a change a conversation named.
 */
const OWED_KINDS: readonly { readonly category: string; readonly one: string; readonly many: string; readonly weight: number }[] = Object.freeze([
  { category: 'DECISION_NEEDED', one: 'decision', many: 'decisions', weight: 40 },
  { category: 'DEADLINE', one: 'deadline', many: 'deadlines', weight: 40 },
  { category: 'PROBLEM', one: 'problem', many: 'problems', weight: 35 },
  { category: 'REQUEST', one: 'request', many: 'requests', weight: 25 },
  { category: 'COMMITMENT', one: 'commitment', many: 'commitments', weight: 25 },
  { category: 'FOLLOW_UP', one: 'follow-up', many: 'follow-ups', weight: 10 },
  { category: 'OTHER', one: 'other item', many: 'other items', weight: 5 },
]);
const CHANGE_CATEGORY = 'BUSINESS_CHANGE';
const CHANGE_WEIGHT = 15;
const DEADLINE_BOOST = 100;

/** A category's kind, in plain words, for a row. Unknown or absent reads as "Needs you". */
export function chatsKindLabel(category: string | null): string {
  if (category === CHANGE_CATEGORY) return 'Change';
  const kind = OWED_KINDS.find((k) => k.category === category);
  if (!kind || kind.category === 'OTHER') return 'Needs you';
  return kind.one.charAt(0).toUpperCase() + kind.one.slice(1);
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
function listWords(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
}

function pressure(item: ChatsItem): number {
  const weight = item.category === CHANGE_CATEGORY ? CHANGE_WEIGHT : OWED_KINDS.find((k) => k.category === item.category)?.weight ?? 5;
  return weight + (item.deadline ? DEADLINE_BOOST : 0);
}

const mostPressing = (a: ChatsItem, b: ChatsItem) => pressure(b) - pressure(a) || b.at.getTime() - a.at.getTime();

/**
 * The obligations grouped by the source's own label for their conversation. An item with no label is
 * its own group: Loop cannot tell whether two unnamed items share a conversation, so it does not
 * claim they do. Groups: a grounded deadline first, then the most pressing kind, then the most recent.
 */
export function groupChats(items: readonly ChatsItem[]): ChatsConversation[] {
  const named = new Map<string, ChatsItem[]>();
  const groups: ChatsItem[][] = [];
  for (const item of items) {
    const label = item.counterparty?.trim() || null;
    if (label === null) {
      groups.push([item]);
      continue;
    }
    const list = named.get(label);
    if (list) list.push(item);
    else {
      const fresh = [item];
      named.set(label, fresh);
      groups.push(fresh);
    }
  }
  const conversations = groups.map((list): ChatsConversation => {
    const sorted = [...list].sort(mostPressing);
    return {
      label: sorted[0]!.counterparty?.trim() || null,
      items: sorted,
      latestAt: new Date(Math.max(...sorted.map((i) => i.at.getTime()))),
      hasDeadline: sorted.some((i) => i.deadline !== null),
    };
  });
  return conversations.sort(
    (a, b) =>
      Number(b.hasDeadline) - Number(a.hasDeadline) ||
      pressure(b.items[0]!) - pressure(a.items[0]!) ||
      b.latestAt.getTime() - a.latestAt.getTime() ||
      (a.label ?? '').localeCompare(b.label ?? ''),
  );
}

/** What the person owes, as one sentence: how many conversations, what kinds, how many deadlines. */
function owedSentence(conversations: readonly ChatsConversation[], items: readonly ChatsItem[], earlier: boolean): string | null {
  if (conversations.length === 0) return null;
  const owedItems = items.filter((i) => i.category !== CHANGE_CATEGORY);
  const kinds = OWED_KINDS.map((k) => ({ k, n: owedItems.filter((i) => (OWED_KINDS.some((o) => o.category === i.category) ? i.category : 'OTHER') === k.category).length }))
    .filter(({ n }) => n > 0)
    .map(({ k, n }) => plural(n, k.one, k.many));
  const deadlines = conversations.filter((c) => c.hasDeadline).length;
  const head = `${plural(conversations.length, 'conversation', 'conversations')}${earlier ? ' Loop flagged earlier still' : ''} ${conversations.length === 1 ? 'needs' : 'need'} you`;
  const what = kinds.length > 0 ? `: ${listWords(kinds)}` : '';
  const due = deadlines > 0 ? `${kinds.length > 0 ? '; ' : ': '}${plural(deadlines, 'carries a deadline', 'carry a deadline')}` : '';
  return `${head}${what}${due}.`;
}

// --- Digests ---------------------------------------------------------------------------------------

const TELEGRAM_SUBJECT_PREFIX = DERIVED_WORK_SUBJECT_PREFIXES.TELEGRAM;

/**
 * The keyed conversation a digest's subject names: the subject reference itself, or the key under
 * the prefix derived Telegram work carries (`telegram_conversation:<key>`). Either way a key, never a
 * raw id -- and never shown.
 */
export function chatsConversationKeyOf(subjectRef: string): string {
  return subjectRef.startsWith(TELEGRAM_SUBJECT_PREFIX) ? subjectRef.slice(TELEGRAM_SUBJECT_PREFIX.length) : subjectRef;
}

const list = (v: readonly string[] | undefined): readonly string[] => (Array.isArray(v) ? v.filter((s) => typeof s === 'string' && s.trim() !== '') : []);
const text = (v: string | undefined): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

/**
 * How much a conversation asks of the reader: whether its digest says it needs the person now, then
 * what it carries and what the person owes there. Ordering only -- never shown as a figure.
 */
function attentionScore(c: Pick<ChatsConversationCard, 'attention' | 'unresolved' | 'concerns' | 'commitments' | 'opportunities' | 'developments' | 'operational' | 'owed'>): number {
  return (c.attention ? 100 : 0) + c.owed * 4 + c.unresolved.length * 3 + c.concerns.length * 3 + c.commitments.length * 2 + c.opportunities.length * 2 + c.developments.length + c.operational.length;
}

const RELEVANCE_ORDER: Readonly<Record<string, number>> = { BUSINESS: 0, UNCLEAR: 1 };

const byAttention = (a: ChatsConversationCard, b: ChatsConversationCard) =>
  (RELEVANCE_ORDER[a.relevance ?? 'UNCLEAR'] ?? 2) - (RELEVANCE_ORDER[b.relevance ?? 'UNCLEAR'] ?? 2) ||
  Number(b.asCurrent) - Number(a.asCurrent) ||
  attentionScore(b) - attentionScore(a) ||
  (b.lastEvidenceAt?.getTime() ?? 0) - (a.lastEvidenceAt?.getTime() ?? 0) ||
  a.key.localeCompare(b.key);

function cardOf(digest: ChatsDigest, input: ChatsIntelligenceInput, live: boolean, items: readonly ChatsItem[]): ChatsConversationCard {
  const key = chatsConversationKeyOf(digest.subjectRef);
  const linked = items.filter((i) => i.conversationKey === key && i.category !== CHANGE_CATEGORY);
  const label = items.find((i) => i.conversationKey === key && i.counterparty?.trim())?.counterparty?.trim() ?? null;
  const coverage = digestFreshness(digest, {
    sourceLastEvidenceAt: input.latestActivity?.get(key) ?? null,
    connectionLive: live,
    now: input.now,
  });
  const c = digest.content;
  const unresolved = list(c.unresolved);
  const concerns = list(c.concerns);
  const flags = [
    unresolved.length > 0 ? plural(unresolved.length, 'unresolved situation', 'unresolved situations') : null,
    concerns.length > 0 ? plural(concerns.length, 'concern', 'concerns') : null,
    linked.length > 0 ? `${plural(linked.length, 'thing', 'things')} you owe here` : null,
  ].filter((x): x is string => x !== null);
  return {
    key: digest.subjectRef,
    label,
    relevance: c.relevance ?? null,
    synthesis: text(c.synthesis),
    stateChange: text(c.stateChange),
    topics: list(c.topics),
    developments: list(c.developments),
    commitments: list(c.commitments),
    opportunities: list(c.opportunities),
    concerns,
    operational: list(c.operational),
    unresolved,
    limitations: list(c.limitations),
    confidence: c.confidence ?? null,
    attention: text(c.attention),
    coverage,
    coverageLabel: intelligenceCoverageLabel(coverage),
    asCurrent: mayShowAsCurrent(coverage),
    generatedAt: digest.generatedAt,
    lastEvidenceAt: digest.lastEvidenceAt,
    owed: linked.length,
    flags,
  };
}

function coverageSummary(cards: readonly ChatsConversationCard[], digests: readonly ChatsDigest[]): ChatsCoverageSummary {
  const counts = INTELLIGENCE_COVERAGE.map((coverage) => ({ coverage, label: intelligenceCoverageLabel(coverage), count: cards.filter((c) => c.coverage === coverage).length })).filter((c) => c.count > 0);
  const words = counts.length === 0 ? null : counts.length === 1 ? counts[0]!.label.label : counts.map((c) => `${c.count} ${c.label.label.toLowerCase()}`).join(' · ');
  const latest = digests.reduce<Date | null>((acc, d) => (acc === null || d.generatedAt.getTime() > acc.getTime() ? d.generatedAt : acc), null);
  return { counts, words, latestGeneratedAt: latest };
}

/** "Acme Buyers: <synthesis>" -- the digest's own sentence, under Telegram's own label when one is known. */
function attributed(card: ChatsConversationCard): string | null {
  if (!card.synthesis) return null;
  const s = /[.!?]$/.test(card.synthesis) ? card.synthesis : `${card.synthesis}.`;
  return card.label ? `${card.label}: ${s}` : s;
}

/** How many business conversations Loop holds a reading of, and what they carry -- counted, never re-worded. */
function businessSentence(business: readonly ChatsConversationCard[]): string {
  const n = business.length;
  const developing = business.filter((c) => c.developments.length > 0).length;
  const open = business.filter((c) => c.unresolved.length > 0).length;
  const head = `Loop has a reading of ${plural(n, 'business conversation', 'business conversations')}`;
  const parts = [
    developing > 0 ? `${developing} ${developing === 1 ? 'has' : 'have'} new developments` : null,
    open > 0 ? `${open} ${open === 1 ? 'has' : 'have'} something unresolved` : null,
  ].filter((x): x is string => x !== null);
  if (parts.length > 0) return `${head}: ${listWords(parts)}.`;
  // An absence is read as "nothing" only where every reading is sufficient and current.
  if (business.every((c) => mayReadAbsenceAsNothingHappened(c.coverage))) return `${head}; none has a new development or anything unresolved.`;
  return `${head}.`;
}

/** Where no conversation Loop read is business: counted by relevance, nothing more. */
function relevanceSentence(cards: readonly ChatsConversationCard[], notBusiness: number): string {
  const unclear = cards.filter((c) => c.relevance !== 'BUSINESS').length;
  const total = unclear + notBusiness;
  if (unclear === 0) return `None of the ${plural(total, 'conversation', 'conversations')} Loop has read looks like business.`;
  return `Loop could not tell whether ${unclear === total ? (total === 1 ? 'the conversation' : `the ${total} conversations`) : `${unclear} of the ${total} conversations`} it has read ${unclear === 1 ? 'is' : 'are'} business.`;
}

// --- The composition -------------------------------------------------------------------------------

const LIVE_STATES: readonly string[] = ['READY', 'CONNECTED_LIMITED'];
const BROKEN_STATES: readonly string[] = ['RECONNECT_REQUIRED', 'FAILED'];

export function composeChatsIntelligence(input: ChatsIntelligenceInput): ChatsIntelligence {
  const c = input.connection;
  const items = input.items.filter((i) => i.provider === CHATS_PROVIDER);
  const obligations = groupChats(items);
  const configured = c !== null && c.configured;
  const connectionLive = configured && LIVE_STATES.includes(c.state);
  const triageOn = c?.contentAuthorized === true;

  const digests = c === null ? [] : input.digests ?? [];
  const allCards = digests.map((d) => cardOf(d, input, connectionLive && triageOn, items)).sort(byAttention);
  const conversations = allCards.filter((card) => card.relevance !== 'NOT_BUSINESS');
  const notBusiness = allCards.length - conversations.length;
  const business = allCards.filter((card) => card.relevance === 'BUSINESS');
  const coverage = coverageSummary(allCards, digests);

  let state: ChatsState;
  let unavailable: ChatsUnavailable = null;
  if (c === null) state = 'NOT_PERMITTED';
  else if (!c.configured) state = 'NOT_AVAILABLE';
  else if (BROKEN_STATES.includes(c.state)) {
    state = 'UNAVAILABLE';
    unavailable = 'CONNECTION';
  } else if (!connectionLive) state = 'NOT_CONNECTED';
  else if (!triageOn) state = 'CONSENT_OFF';
  else if (input.digests === null) {
    state = 'UNAVAILABLE';
    unavailable = 'READ_FAILED';
  } else if (allCards.length === 0) state = 'NO_INTELLIGENCE_YET';
  else state = allCards.some((card) => card.asCurrent) ? 'CURRENT' : 'STALE';

  const status =
    c === null
      ? null
      : !c.configured
        ? `${PROVIDER_LABEL} · Not available on this deployment`
        : connectionLive
          ? `${PROVIDER_LABEL} · ${c.label} · Triage ${triageOn ? 'on' : 'off'}`
          : `${PROVIDER_LABEL} · ${c.label}`;

  const headline: string[] = [];
  switch (state) {
    case 'NOT_PERMITTED':
      headline.push('Chats are not available to your role in this organization.');
      break;
    case 'NOT_AVAILABLE':
      headline.push(`This Loop deployment has not been set up to connect ${PROVIDER_LABEL}, so Loop sees none of your chats.`);
      break;
    case 'NOT_CONNECTED':
      headline.push(`${PROVIDER_LABEL} is not connected, so Loop has no Chats intelligence.`);
      break;
    case 'UNAVAILABLE':
      headline.push(
        unavailable === 'CONNECTION'
          ? `Loop cannot use your ${PROVIDER_LABEL} connection right now, so it is not reading your chats.`
          : 'Loop could not read its Chats intelligence just now.',
      );
      break;
    case 'CONSENT_OFF':
      headline.push(NO_CHATS_INTELLIGENCE, 'AI triage is off, so Loop reads no content from your chats, only who and when.');
      break;
    case 'NO_INTELLIGENCE_YET':
      headline.push(NO_CHATS_INTELLIGENCE, 'Loop writes its reading of a conversation after new messages arrive there, and no conversation has one yet.');
      break;
    case 'STALE':
      headline.push(`No Chats reading is current: ${(coverage.words ?? '').toLowerCase()}.`);
      if (business.length > 0) headline.push(businessSentence(business));
      break;
    case 'CURRENT': {
      const lead = business.find((card) => card.asCurrent && card.synthesis !== null) ?? null;
      const leadWords = lead ? attributed(lead) : null;
      if (business.length === 0) headline.push(relevanceSentence(conversations, notBusiness));
      else if (leadWords) headline.push(leadWords, businessSentence(business));
      else headline.push(businessSentence(business));
      break;
    }
  }

  const active = input.activity24h?.conversations ?? null;
  const metric =
    state === 'CURRENT' || state === 'STALE'
      ? { value: String(business.length), label: business.length === 1 ? 'business conversation' : 'business conversations' }
      : (state === 'NO_INTELLIGENCE_YET' || state === 'CONSENT_OFF') && active !== null && active > 0
        ? { value: String(active), label: active === 1 ? 'active conversation since yesterday' : 'active conversations since yesterday' }
        : null;

  return {
    state,
    unavailable,
    statement: headline[0]!,
    headline: headline.slice(0, 2),
    metric,
    businessConversations: allCards.length > 0 ? business.length : null,
    status,
    coverage,
    conversations,
    notBusiness,
    obligations,
    owed: owedSentence(obligations, items, !connectionLive),
    activity24h: input.activity24h,
    activity7d: input.activity7d,
  };
}
