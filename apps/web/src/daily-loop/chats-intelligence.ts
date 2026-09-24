// Chats -- what is happening in a person's own chats, as the Chats page and Home both read it. PURE.
//
// ONE PROJECTION, TWO SURFACES. The Chats page (/app/chats) and Loop Home's Chats tile render this
// same result, so the domain and its window onto Home can never tell a person two different
// things. It is composition over authorities that already exist and nothing more:
//   - the viewer's OWN Telegram connection, as the Connections page reads it (state, and whether AI
//     triage -- the separate content consent -- is on);
//   - the viewer's OWN open NEEDS_YOU items the content-triage sweep raised (`loadNeedsYou`): the AI's
//     minimized paraphrase, the source's own label for the conversation, a topic, a next step and a
//     grounded deadline. NEVER a message body; there is none to read;
//   - content-free activity counts from the governed observation store (how many messages and
//     conversations, since a moment) -- who/when metadata, never content.
//
// NOTHING HERE IS INVENTED. A conversation is named only by the label Telegram itself shows; one
// without a label is said to be one Loop could not name. A deadline is the conversation's own words
// (the triage task rejects an ungrounded one). Activity that could not be read is SAID, never drawn
// as a zero. The wording is deterministic: no model, no names beyond the source's own labels.
//
// NO I/O, NO CLOCK. The server loader (chats.ts) reads; this decides. No loader, repository or
// database import belongs in this file.

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

export interface ChatsIntelligenceInput {
  /** null: this person may not view connections. */
  readonly connection: ChatsConnection | null;
  readonly items: readonly ChatsItem[];
  /** null: the count could not be read -- said, never drawn as zero. */
  readonly activity24h: ChatsActivity | null;
  readonly activity7d: ChatsActivity | null;
}

/**
 *   NOT_PERMITTED  this person may not view connections.
 *   NOT_AVAILABLE  this deployment cannot connect Telegram.
 *   NOT_CONNECTED  nothing live: never connected, disconnected, or sign-in not finished.
 *   UNAVAILABLE    connected once, and Loop cannot use it now (reconnect required, or a failure).
 *   QUIET          live, nothing owed and no business conversation active since yesterday (or
 *                  activity could not be read).
 *   ACTIVE         live, and something is owed or conversations were active since yesterday.
 */
export type ChatsState = 'NOT_PERMITTED' | 'NOT_AVAILABLE' | 'NOT_CONNECTED' | 'UNAVAILABLE' | 'QUIET' | 'ACTIVE';

export interface ChatsConversation {
  /** The source's own label for the conversation, or null when it had none. */
  readonly label: string | null;
  /** Most pressing first. */
  readonly items: readonly ChatsItem[];
  readonly latestAt: Date;
  readonly hasDeadline: boolean;
}

export interface ChatsIntelligence {
  readonly state: ChatsState;
  readonly metric: { readonly value: string; readonly label: string } | null;
  /** At most two sentences of domain intelligence. */
  readonly summary: readonly string[];
  /** e.g. "Telegram · Ready · Triage on". Null when the person may not view connections. */
  readonly status: string | null;
  /** Grouped by the source's own label, most pressing first. */
  readonly conversations: readonly ChatsConversation[];
  readonly activity24h: ChatsActivity | null;
  readonly activity7d: ChatsActivity | null;
}

/** The only source Chats reads today. */
export const CHATS_PROVIDER = 'TELEGRAM';
const PROVIDER_LABEL = 'Telegram';

/**
 * The triage categories, in the person's words, most pressing first. Presentation and ordering only;
 * the vocabulary is the AI triage task's (AI_TRIAGE_CATEGORIES). BUSINESS_CHANGE is not something
 * owed -- it is reported as the latest change a conversation named.
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

/** The label a conversation Loop could not name is shown under. */
export const UNNAMED_CONVERSATION = 'A conversation Loop could not name';

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
 * The items grouped by the source's own label for their conversation. An item with no label is its
 * own group: Loop cannot tell whether two unnamed items share a conversation, so it does not claim
 * they do. Groups: a grounded deadline first, then the most pressing kind, then the most recent.
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

const LIVE_STATES: readonly string[] = ['READY', 'CONNECTED_LIMITED'];
const BROKEN_STATES: readonly string[] = ['RECONNECT_REQUIRED', 'FAILED'];

function stateOf(input: ChatsIntelligenceInput, owed: number): ChatsState {
  const c = input.connection;
  if (c === null) return 'NOT_PERMITTED';
  if (!c.configured) return 'NOT_AVAILABLE';
  if (BROKEN_STATES.includes(c.state)) return 'UNAVAILABLE';
  if (!LIVE_STATES.includes(c.state)) return 'NOT_CONNECTED';
  return owed > 0 || (input.activity24h?.conversations ?? 0) > 0 ? 'ACTIVE' : 'QUIET';
}

/** "N business conversations were active since yesterday." -- or that it could not be read. */
function activitySentence(activity: ChatsActivity | null): string {
  if (activity === null) return 'Activity could not be read.';
  const n = activity.conversations;
  if (n === 0) return 'No business conversation was active since yesterday.';
  return `${plural(n, 'business conversation was', 'business conversations were')} active since yesterday.`;
}

/** What the person owes, as one sentence: how many conversations, what kinds, how many deadlines. */
function owedSentence(conversations: readonly ChatsConversation[], owedItems: readonly ChatsItem[], earlier: boolean): string {
  const kinds = OWED_KINDS.map((k) => ({ k, n: owedItems.filter((i) => (OWED_KINDS.some((o) => o.category === i.category) ? i.category : 'OTHER') === k.category).length }))
    .filter(({ n }) => n > 0)
    .map(({ k, n }) => plural(n, k.one, k.many));
  const deadlines = conversations.filter((c) => c.hasDeadline).length;
  const head = `${plural(conversations.length, 'conversation', 'conversations')}${earlier ? ' Loop flagged earlier still' : ''} ${conversations.length === 1 ? 'needs' : 'need'} you`;
  const what = kinds.length > 0 ? `: ${listWords(kinds)}` : '';
  const due = deadlines > 0 ? `${kinds.length > 0 ? '; ' : ': '}${plural(deadlines, 'carries a deadline', 'carry a deadline')}` : '';
  return `${head}${what}${due}.`;
}

/** The latest change a conversation named, by its minimized topic and the source's own label. */
function changeClause(items: readonly ChatsItem[]): string | null {
  const change = items
    .filter((i) => i.category === CHANGE_CATEGORY && i.topic)
    .sort((a, b) => b.at.getTime() - a.at.getTime())[0];
  if (!change) return null;
  const where = change.counterparty?.trim() ? ` in ${change.counterparty.trim()}` : '';
  return `the latest change named${where} is about ${change.topic}`;
}

export function chatsIntelligence(input: ChatsIntelligenceInput): ChatsIntelligence {
  const items = input.items.filter((i) => i.provider === CHATS_PROVIDER);
  const conversations = groupChats(items);
  const owedItems = items.filter((i) => i.category !== CHANGE_CATEGORY);
  const state = stateOf(input, conversations.length);
  const c = input.connection;
  const live = state === 'QUIET' || state === 'ACTIVE';
  const triageOn = c?.contentAuthorized === true;

  const status =
    c === null
      ? null
      : !c.configured
        ? `${PROVIDER_LABEL} · Not available on this deployment`
        : live
          ? `${PROVIDER_LABEL} · ${c.label} · Triage ${triageOn ? 'on' : 'off'}`
          : `${PROVIDER_LABEL} · ${c.label}`;

  const summary: string[] = [];
  const change = changeClause(items);
  if (state === 'NOT_PERMITTED') {
    summary.push('Chats are not available to your role in this organization.');
  } else if (state === 'NOT_AVAILABLE') {
    summary.push(`This Loop deployment has not been set up to connect ${PROVIDER_LABEL}, so Loop sees none of your chats.`);
  } else if (state === 'NOT_CONNECTED' || state === 'UNAVAILABLE') {
    summary.push(
      state === 'NOT_CONNECTED'
        ? `${PROVIDER_LABEL} is not connected, so Loop sees none of your chats.`
        : `Loop cannot use your ${PROVIDER_LABEL} connection right now, so it is not observing your chats.`,
    );
    if (conversations.length > 0) summary.push(owedSentence(conversations, owedItems, true));
  } else if (conversations.length > 0) {
    // What is owed first; then the latest change a conversation named, and what moved since yesterday.
    summary.push(owedSentence(conversations, owedItems, false));
    const activity = activitySentence(input.activity24h);
    summary.push(change ? `${change.charAt(0).toUpperCase()}${change.slice(1)}; ${activity.charAt(0).toLowerCase()}${activity.slice(1)}` : activity);
  } else {
    summary.push(activitySentence(input.activity24h));
    if (!triageOn) {
      summary.push('Loop observes this activity but flags nothing, because AI triage is off.');
    } else if ((input.activity24h?.conversations ?? 0) > 0) {
      summary.push('None currently contains an unresolved obligation Loop has identified for you.');
    } else {
      summary.push('Loop has identified no unresolved obligation for you.');
    }
  }

  const active = input.activity24h?.conversations ?? 0;
  const metric =
    conversations.length > 0
      ? { value: String(conversations.length), label: conversations.length === 1 ? 'conversation needs you' : 'conversations need you' }
      : live && active > 0
        ? { value: String(active), label: active === 1 ? 'business conversation active since yesterday' : 'business conversations active since yesterday' }
        : null;

  return {
    state,
    metric,
    summary: summary.slice(0, 2),
    status,
    conversations,
    activity24h: input.activity24h,
    activity7d: input.activity7d,
  };
}
