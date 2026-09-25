// Telegram content triage, output schema v5 -- Chats v5. Loop Intelligence Phase B, 2026-09-26.
//
// WHAT CHANGED FROM v4. v4 found the person's still-unresolved obligations and wrote a paraphrased
// reading. Matt asked for more than that: "read my authorized chats, understand what is happening, and
// tell me specifically what I or my team may need to pay attention to". v5 answers WHO appears to owe
// what, in the same one call:
//
//   items[]          the still-unresolved obligations (unchanged in spirit) plus `owedBy` -- VIEWER (the
//                    person whose account it is), OTHER (someone else in the conversation) or UNKNOWN --
//                    and `who`: the label the conversation itself shows for that someone, or null.
//   conversation     the reading, now with TYPED signals: CHANGE, DECIDED, DECISION_PENDING, OBLIGATION,
//                    UNRESOLVED, STALLED, OPPORTUNITY, RISK, OPERATIONAL, UPCOMING -- each anchored to the
//                    message it rests on, with a severity, and (for an OBLIGATION) owedBy/who; plus a
//                    one-line `stateChange` when the conversation's situation moved.
//
// NO INVENTED PEOPLE, NO ASSIGNMENTS. `who` must be EXACTLY one of the labels the context showed
// (Telegram's conversation label, or an in-group sender label) -- otherwise the whole answer is refused
// (UNGROUNDED_PARTY). OTHER is "someone in this conversation", never a teammate: Loop does not turn a
// name in a chat into a colleague. Whether an obligation is someone's WORK is decided later by a person
// (Promote to Work), never here.
//
// PORTABLE. The schema (templates/telegram-content-triage.ts) uses a one-value `enum` for its schemaId
// and nothing outside the shared subset, so the v4 `const` exemption and the OpenAI+triage guard retire
// with it (coupled by a test). Every bound lives here, after the answer.
//
// PURE.

import {
  AI_CONVERSATION_CONFIDENCE,
  AI_CONVERSATION_RELEVANCE,
  AI_TRIAGE_CATEGORIES,
  AI_TRIAGE_LIMITS,
  aiHasQuotation,
  aiTermsInText,
  aiVerbatimRuns,
  type AiConversationConfidence,
  type AiConversationRelevance,
  type AiOutputRejection,
  type AiSupportedEvidence,
  type AiTaskDefinition,
  type AiTaskOutput,
  type AiTriageCategory,
} from './task';

export const TELEGRAM_TRIAGE_V5_SCHEMA_ID = 'telegram-content-triage.v5';

/** Who appears to owe an obligation, relative to the person whose account it is. */
export const AI_TRIAGE_OWED_BY = ['VIEWER', 'OTHER', 'UNKNOWN'] as const;
export type AiTriageOwedBy = (typeof AI_TRIAGE_OWED_BY)[number];

/** The typed signals a Chats reading may carry. */
export const AI_CHATS_SIGNAL_KINDS = ['CHANGE', 'DECIDED', 'DECISION_PENDING', 'OBLIGATION', 'UNRESOLVED', 'STALLED', 'OPPORTUNITY', 'RISK', 'OPERATIONAL', 'UPCOMING'] as const;
export type AiChatsSignalKind = (typeof AI_CHATS_SIGNAL_KINDS)[number];

export const AI_CHATS_SEVERITY = ['LOW', 'MEDIUM', 'HIGH'] as const;
export type AiChatsSeverity = (typeof AI_CHATS_SEVERITY)[number];

export const AI_CHATS_LIMITS = Object.freeze({
  maxSignals: 10,
  maxWhoChars: AI_TRIAGE_LIMITS.maxCounterpartyLabelChars,
  maxStateChangeChars: 160,
});

export interface AiChatsObligation {
  readonly anchorOrdinal: number;
  readonly category: AiTriageCategory;
  readonly oneLineMeaning: string;
  readonly topic: string;
  readonly nextStep: string;
  readonly deadline: string | null;
  readonly owedBy: AiTriageOwedBy;
  readonly who: string | null;
}

export interface AiChatsSignal {
  readonly kind: AiChatsSignalKind;
  readonly anchorOrdinal: number;
  readonly statement: string;
  readonly severity: AiChatsSeverity;
  /** Only on an OBLIGATION; null otherwise. */
  readonly owedBy: AiTriageOwedBy | null;
  readonly who: string | null;
}

export interface AiChatsReading {
  readonly relevance: AiConversationRelevance;
  readonly summary: string;
  readonly topics: readonly string[];
  readonly stateChange: string | null;
  readonly signals: readonly AiChatsSignal[];
  readonly attention: { readonly needed: boolean; readonly reason: string | null };
  readonly confidence: AiConversationConfidence;
}

export interface AiChatsTriage {
  readonly items: readonly AiChatsObligation[];
  /** null: the model said it could not read the conversation (stored as an INSUFFICIENT digest). */
  readonly conversation: AiChatsReading | null;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}
function exactKeys(o: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(o);
  return own.length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(o, k));
}
const nullableString = (v: unknown) => v === null || typeof v === 'string';

const ITEM_KEYS = ['anchorOrdinal', 'category', 'oneLineMeaning', 'topic', 'nextStep', 'deadline', 'owedBy', 'who'];
const SIGNAL_KEYS = ['kind', 'anchorOrdinal', 'statement', 'severity', 'owedBy', 'who'];
const READING_KEYS = ['relevance', 'summary', 'topics', 'stateChange', 'signals', 'attention', 'confidence'];

/**
 * Mail content triage (Loop Intelligence Phase D) reads one mail THREAD with exactly the same contract:
 * obligations with who owes them, and a typed reading of the conversation. One contract, two schema ids,
 * so each task is versioned and activated on its own.
 */
export const MAIL_CONTENT_TRIAGE_SCHEMA_ID = 'mail-content-triage.v1';
/** Every schema id judged by this conversation-triage contract. */
export const CONVERSATION_TRIAGE_SCHEMA_IDS: readonly string[] = Object.freeze([TELEGRAM_TRIAGE_V5_SCHEMA_ID, MAIL_CONTENT_TRIAGE_SCHEMA_ID]);

/** Shape only, by EXACT keys: one extra key anywhere refuses the whole answer. */
export function parseTriageV5Output(value: unknown): AiTaskOutput | null {
  return parseConversationTriageOutput(value, TELEGRAM_TRIAGE_V5_SCHEMA_ID);
}

export function parseConversationTriageOutput(value: unknown, schemaId: string): AiTaskOutput | null {
  if (!CONVERSATION_TRIAGE_SCHEMA_IDS.includes(schemaId)) return null;
  if (!isObject(value) || !exactKeys(value, ['schemaId', 'items', 'conversation', 'limitations'])) return null;
  if (value.schemaId !== schemaId) return null;
  if (!Array.isArray(value.items) || !Array.isArray(value.limitations) || !value.limitations.every((l) => typeof l === 'string')) return null;
  const items: AiChatsObligation[] = [];
  for (const raw of value.items) {
    if (!isObject(raw) || !exactKeys(raw, ITEM_KEYS)) return null;
    if (typeof raw.anchorOrdinal !== 'number' || !Number.isFinite(raw.anchorOrdinal)) return null;
    if (typeof raw.category !== 'string' || typeof raw.oneLineMeaning !== 'string' || typeof raw.topic !== 'string' || typeof raw.nextStep !== 'string') return null;
    if (!nullableString(raw.deadline) || typeof raw.owedBy !== 'string' || !nullableString(raw.who)) return null;
    items.push({
      anchorOrdinal: raw.anchorOrdinal,
      category: raw.category as AiTriageCategory,
      oneLineMeaning: raw.oneLineMeaning,
      topic: raw.topic,
      nextStep: raw.nextStep,
      deadline: raw.deadline as string | null,
      owedBy: raw.owedBy as AiTriageOwedBy,
      who: raw.who as string | null,
    });
  }
  let conversation: AiChatsReading | null = null;
  if (value.conversation !== null) {
    const c = value.conversation;
    if (!isObject(c) || !exactKeys(c, READING_KEYS)) return null;
    if (typeof c.relevance !== 'string' || typeof c.summary !== 'string' || typeof c.confidence !== 'string' || !nullableString(c.stateChange)) return null;
    if (!Array.isArray(c.topics) || !c.topics.every((t) => typeof t === 'string')) return null;
    if (!isObject(c.attention) || !exactKeys(c.attention, ['needed', 'reason']) || typeof c.attention.needed !== 'boolean' || !nullableString(c.attention.reason)) return null;
    if (!Array.isArray(c.signals)) return null;
    const signals: AiChatsSignal[] = [];
    for (const raw of c.signals) {
      if (!isObject(raw) || !exactKeys(raw, SIGNAL_KEYS)) return null;
      if (typeof raw.kind !== 'string' || typeof raw.anchorOrdinal !== 'number' || !Number.isFinite(raw.anchorOrdinal) || typeof raw.statement !== 'string') return null;
      if (typeof raw.severity !== 'string' || !nullableString(raw.owedBy) || !nullableString(raw.who)) return null;
      signals.push({
        kind: raw.kind as AiChatsSignalKind,
        anchorOrdinal: raw.anchorOrdinal,
        statement: raw.statement,
        severity: raw.severity as AiChatsSeverity,
        owedBy: raw.owedBy as AiTriageOwedBy | null,
        who: raw.who as string | null,
      });
    }
    conversation = {
      relevance: c.relevance as AiConversationRelevance,
      summary: c.summary,
      topics: c.topics as string[],
      stateChange: c.stateChange as string | null,
      signals,
      attention: { needed: c.attention.needed, reason: c.attention.reason as string | null },
      confidence: c.confidence as AiConversationConfidence,
    };
  }
  return {
    schemaId,
    summary: '',
    claims: [],
    limitations: value.limitations as string[],
    chatsTriage: { items, conversation },
  };
}

/** Whether `who` is exactly a label the context showed (case-insensitive, trimmed). */
function grounded(who: string, labels: ReadonlySet<string> | undefined): boolean {
  return !!labels && labels.has(who.trim().toLowerCase());
}

function partyRejections(owedBy: string | null, who: string | null, evidence: AiSupportedEvidence, out: AiOutputRejection[]): void {
  if (owedBy === null) {
    if (who !== null) out.push('WRONG_SCHEMA');
    return;
  }
  if (!(AI_TRIAGE_OWED_BY as readonly string[]).includes(owedBy)) out.push('WRONG_SCHEMA');
  if (who === null) return;
  // The person whose account it is has no label here, and "unknown" names nobody.
  if (owedBy !== 'OTHER') out.push('WRONG_SCHEMA');
  if (who.trim() === '' || who.length > AI_CHATS_LIMITS.maxWhoChars) out.push('WRONG_SCHEMA');
  else if (!grounded(who, evidence.labels)) out.push('UNGROUNDED_PARTY');
}

/** Every rule a parsed v5 answer breaks. Empty means Loop may store it. */
export function validateTriageV5Output(
  output: AiTaskOutput,
  task: AiTaskDefinition,
  suppliedRefs: ReadonlySet<string>,
  evidence: AiSupportedEvidence,
): AiOutputRejection[] {
  const L = AI_TRIAGE_LIMITS;
  const out: AiOutputRejection[] = [];
  if (output.schemaId !== task.outputSchemaId || !CONVERSATION_TRIAGE_SCHEMA_IDS.includes(output.schemaId)) out.push('WRONG_SCHEMA');
  const t = output.chatsTriage;
  if (!t) return [...new Set([...out, 'EMPTY_ANSWER' as const])];
  if (output.claims.length > 0 || output.draft !== undefined || output.domainReading !== undefined) out.push('WRONG_SCHEMA');
  // Anchors number MESSAGE blocks only; conversation-level blocks (label, state, truncation) are not anchorable.
  const chunkSize = [...suppliedRefs].filter((ref) => !/_conversation:/.test(ref)).length;
  const inWindow = (n: number) => Number.isInteger(n) && n >= 1 && n <= chunkSize;
  const texts: string[] = [];
  const bounded = (value: string, max: number) => {
    if (value.trim() === '') out.push('EMPTY_ANSWER');
    if (value.length > max) out.push('ANSWER_TOO_LONG');
    texts.push(value);
  };

  if (t.items.length > L.maxObligations) out.push('ANSWER_TOO_LONG');
  for (const item of t.items) {
    if (item.category === 'NONE' || !(AI_TRIAGE_CATEGORIES as readonly string[]).includes(item.category)) out.push('WRONG_SCHEMA');
    if (!inWindow(item.anchorOrdinal)) out.push('WRONG_SCHEMA');
    if (item.oneLineMeaning.trim() === '') out.push('EMPTY_ANSWER');
    if (item.oneLineMeaning.length > L.maxMeaningChars) out.push('ANSWER_TOO_LONG');
    if (item.nextStep.trim() === '') out.push('EMPTY_ANSWER');
    if (item.nextStep.length > L.maxNextStepChars) out.push('ANSWER_TOO_LONG');
    if (item.topic.length > L.maxTopicChars) out.push('ANSWER_TOO_LONG');
    if (item.deadline !== null) {
      if (item.deadline.trim() === '') out.push('WRONG_SCHEMA');
      if (item.deadline.length > L.maxDeadlineChars) out.push('ANSWER_TOO_LONG');
      const tokens = aiTermsInText(item.deadline);
      if (!evidence.terms || tokens.length === 0 || tokens.some((tok) => !evidence.terms!.has(tok))) out.push('UNGROUNDED_DEADLINE');
    }
    partyRejections(item.owedBy, item.who, evidence, out);
  }

  const c = t.conversation;
  if (c !== null) {
    if (!(AI_CONVERSATION_RELEVANCE as readonly string[]).includes(c.relevance)) out.push('WRONG_SCHEMA');
    if (!(AI_CONVERSATION_CONFIDENCE as readonly string[]).includes(c.confidence)) out.push('WRONG_SCHEMA');
    bounded(c.summary, L.maxSummaryChars);
    if (c.topics.length > L.maxConversationTopics) out.push('ANSWER_TOO_LONG');
    for (const topic of c.topics) bounded(topic, L.maxConversationTopicChars);
    if (c.stateChange !== null) bounded(c.stateChange, AI_CHATS_LIMITS.maxStateChangeChars);
    if (c.signals.length > AI_CHATS_LIMITS.maxSignals) out.push('ANSWER_TOO_LONG');
    for (const s of c.signals) {
      if (!(AI_CHATS_SIGNAL_KINDS as readonly string[]).includes(s.kind)) out.push('WRONG_SCHEMA');
      if (!(AI_CHATS_SEVERITY as readonly string[]).includes(s.severity)) out.push('WRONG_SCHEMA');
      if (!inWindow(s.anchorOrdinal)) out.push('WRONG_SCHEMA');
      bounded(s.statement, L.maxStatementChars);
      // Only an obligation says who owes it -- and then it must.
      if (s.kind === 'OBLIGATION' ? s.owedBy === null : s.owedBy !== null) out.push('WRONG_SCHEMA');
      partyRejections(s.owedBy, s.who, evidence, out);
    }
    if (c.attention.needed) {
      if (c.attention.reason === null || c.attention.reason.trim() === '') out.push('WRONG_SCHEMA');
      else bounded(c.attention.reason, L.maxAttentionReasonChars);
    } else if (c.attention.reason !== null) out.push('WRONG_SCHEMA');
  }
  if (output.limitations.length > L.maxLimitations || output.limitations.some((l) => l.length > L.maxLimitationChars)) out.push('ANSWER_TOO_LONG');

  // NO QUOTE, NO COPIED SENTENCE in the reading. Fail closed: with nothing to check against, nothing passes.
  const runs = evidence.verbatimRuns;
  for (const value of texts) {
    if (aiHasQuotation(value)) out.push('VERBATIM_CONTENT');
    if (!runs || aiVerbatimRuns(value).some((run) => runs.has(run))) out.push('VERBATIM_CONTENT');
  }
  return [...new Set(out)];
}
