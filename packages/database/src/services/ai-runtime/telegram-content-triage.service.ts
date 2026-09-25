// Telegram conversation triage: a conservative, employee-private read of a bounded recent CONVERSATION
// that returns the obligations STILL UNRESOLVED, each anchored to the message that originated it.
//
// Architecture: the conversation-triage slice (v2) of the Telegram intelligence plan. The message
// bodies are read TRANSIENTLY by the worker, judged here through the governed AI runtime, and dropped.
// The employee authorized content processing (a separate consent), and the invocation traces to THEM --
// the gateway re-checks their authority, the deployment's activation, the budget, the routing and the
// output contract; nothing here names a provider or a model.
//
// NO BODY IS EVER LOGGED OR PERSISTED. The window enters one context package, goes to one governed call,
// and is dropped. What Loop keeps is MINIMIZED: a category, a few short paraphrase fields (what happened,
// the topic, the next step, a grounded deadline -- never a quote) and a KEYED anchor (never a raw id,
// never the body) per obligation. WHO the conversation is with is NOT a model output: the worker records
// Telegram's own label for the conversation, and there is no field here a model could put a name into.
// The ledger receives ids, versions and counts through the gateway -- never a message and never the
// paraphrase text (see gateway.ts).
//
// ONE CALL, TWO READINGS (task 3.0.0, schema v4). The same invocation also returns a minimized reading
// of the whole conversation (`conversation`), each anchored statement resolved here to its KEYED anchor.
// The worker stores it as the person's private CHATS digest (intelligence_digests); it is intelligence,
// never work, and nothing here makes it a WorkItem.
//
// IT CAN ACT ON NOTHING. The task publishes no tool and produces only JSON. Turning an obligation into an
// employee-private WorkItem, reconciling answered obligations, and storing the conversation reading are
// the worker's job downstream of this service; this service concludes, it does not write state.

import {
  AI_TASK_TELEGRAM_CONTENT_TRIAGE,
  AI_TRIAGE_LIMITS,
  type AiAdmissionRefusal,
  type AiConversationConfidence,
  type AiConversationIntelligence,
  type AiConversationRelevance,
  type AiConversationSignalKind,
  type AiInvocationProvenance,
  type AiOutputRejection,
  type AiTriageCategory,
} from '@emgloop/shared';

import {
  buildTelegramTriageContext,
  type TelegramTriageConversation,
  type TelegramTriageWindowMessage,
} from './telegram-content-triage-context';
import type { AiPrincipal, AiRunRequest, AiRunResult } from './gateway';
import {
  TELEGRAM_CONTENT_TRIAGE_SCHEMA,
  TELEGRAM_CONTENT_TRIAGE_SCHEMA_ID,
  TELEGRAM_CONTENT_TRIAGE_TEMPLATE_ID,
  TELEGRAM_CONTENT_TRIAGE_TEMPLATE_VERSION,
} from './templates/telegram-content-triage';

export interface TelegramContentTriageRuntime {
  run(principal: AiPrincipal, request: AiRunRequest): Promise<AiRunResult>;
}

export interface TelegramContentTriageDeps {
  readonly runtime: TelegramContentTriageRuntime;
}

/** One bounded conversation window to read. Bodies are transient: dropped after the call, never persisted. */
export interface TelegramConversationTriageInput {
  /** The one-way conversation key this window belongs to. Never a raw chat id. */
  readonly conversationKey: string;
  /** The window, oldest first (ordinal 1 is messages[0]). */
  readonly messages: readonly TelegramTriageWindowMessage[];
  /** True when older context (before the window) was not shown -- the model is told to be cautious. */
  readonly truncated: boolean;
  /**
   * The keyed providerEventId of the OLDEST message in the evaluated window (the window's lower
   * boundary). Reconcile may only close an obligation whose anchor is at or after this point; an
   * obligation anchored OUTSIDE the window is not evidence of resolution.
   */
  readonly evaluatedFloorProviderEventId: string;
  /**
   * How Telegram names this conversation (a contact's display name, a group title), minimized by the
   * worker. Shown to the model as context so the verdict can say who it is with; recorded by the worker
   * from this same value, never from anything the model writes. Absent or null: no label was available.
   */
  readonly conversation?: TelegramTriageConversation | null;
}

/**
 * One still-unresolved obligation, minimized. A KEYED anchor, a category and a few short paraphrase
 * fields -- never a body, never a quote, and NO identity field: who it is with comes from Telegram's own
 * label upstream, not from here.
 */
export interface TelegramTriageObligation {
  /** The keyed providerEventId of the message that originated it. Never a raw id, never the body. */
  readonly anchorProviderEventId: string;
  readonly category: AiTriageCategory;
  /** WHAT specifically happened or is being asked (<=140 chars). */
  readonly oneLineMeaning: string;
  /** What it is about, in a few words (<=60 chars); may be empty. */
  readonly topic: string;
  /** What the person needs to do (<=120 chars). */
  readonly nextStep: string;
  /** A time constraint written the way the conversation wrote it (<=40 chars, grounded), or null. */
  readonly deadline: string | null;
}

/** One paraphrased statement of the conversation reading, with its KEYED anchor. Never a quote. */
export interface TelegramConversationStatement {
  readonly anchorProviderEventId: string;
  readonly statement: string;
}

/**
 * The minimized reading of the whole conversation (triage v4), with every anchor resolved to its KEYED
 * providerEventId. No body, no quote, no identity field. Stored by the worker as a CHATS digest.
 */
export interface TelegramConversationReading {
  readonly relevance: AiConversationRelevance;
  readonly summary: string;
  readonly topics: readonly string[];
  readonly developments: readonly TelegramConversationStatement[];
  readonly decisions: readonly TelegramConversationStatement[];
  readonly commitments: readonly TelegramConversationStatement[];
  readonly signals: readonly (TelegramConversationStatement & { readonly kind: AiConversationSignalKind })[];
  readonly unresolved: string | null;
  readonly attention: { readonly needed: boolean; readonly reason: string | null };
  readonly confidence: AiConversationConfidence;
}

export type TelegramConversationTriageResult =
  | {
      readonly outcome: 'TRIAGED';
      readonly items: readonly TelegramTriageObligation[];
      /**
       * The minimized reading of the conversation, or null when the model said it could not read it
       * (the worker stores that as an INSUFFICIENT digest, with the limitations saying why).
       */
      readonly conversation: TelegramConversationReading | null;
      readonly limitations: readonly string[];
      readonly provenance: AiInvocationProvenance;
      /** The window's lower boundary, echoed for the worker's reconcile guard. */
      readonly evaluatedFloorProviderEventId: string;
    }
  | { readonly outcome: 'NOT_AVAILABLE'; readonly refusals: readonly AiAdmissionRefusal[] }
  | { readonly outcome: 'REJECTED_OUTPUT'; readonly rejections: readonly AiOutputRejection[] }
  | { readonly outcome: 'REFUSED_BY_MODEL' }
  | { readonly outcome: 'FAILED'; readonly failure: string };

export class TelegramContentTriageService {
  constructor(private readonly deps: TelegramContentTriageDeps) {}

  /**
   * Read one conversation window for one employee. The principal is the employee whose Telegram it is;
   * a conversation that is not theirs is never handed here (the worker resolves by (org, user, provider)
   * and fetches from their own authorized session). NOT_AVAILABLE covers every governed refusal -- not
   * authorized, not activated, no budget, no configured provider -- and yields NO WorkItem upstream.
   */
  async triage(principal: AiPrincipal, input: TelegramConversationTriageInput): Promise<TelegramConversationTriageResult> {
    const built = buildTelegramTriageContext({
      organizationId: principal.organizationId,
      viewerUserId: principal.userId,
      conversationKey: input.conversationKey,
      messages: input.messages,
      truncated: input.truncated,
      conversation: input.conversation ?? null,
    });

    // One governed call. The gateway owns authorization, activation, budget, routing, provenance and the
    // output contract; nothing here names a provider or a model, and the bodies reach nothing but this call.
    const result = await this.deps.runtime.run(principal, {
      task: AI_TASK_TELEGRAM_CONTENT_TRIAGE,
      context: built.context,
      instructions: built.instructions,
      templateId: TELEGRAM_CONTENT_TRIAGE_TEMPLATE_ID,
      templateVersion: TELEGRAM_CONTENT_TRIAGE_TEMPLATE_VERSION,
      schema: TELEGRAM_CONTENT_TRIAGE_SCHEMA,
      evidence: built.evidence,
    });

    if (result.outcome === 'REFUSED_BY_LOOP') return { outcome: 'NOT_AVAILABLE', refusals: result.refusals };
    if (result.outcome === 'REJECTED_OUTPUT') return { outcome: 'REJECTED_OUTPUT', rejections: result.rejections };
    if (result.outcome === 'REFUSED_BY_MODEL') return { outcome: 'REFUSED_BY_MODEL' };
    if (result.outcome !== 'ANSWERED') return { outcome: 'FAILED', failure: result.failure };

    // The gateway already validated the list against the task's schema (including the anchor bound);
    // defend in depth anyway, and never read a half-parsed answer as a result.
    const ct = result.output.conversationTriage;
    if (!ct || result.output.schemaId !== TELEGRAM_CONTENT_TRIAGE_SCHEMA_ID) {
      return { outcome: 'REJECTED_OUTPUT', rejections: ['WRONG_SCHEMA'] };
    }

    // Resolve each anchor ordinal to its KEYED providerEventId. An ordinal outside the evaluated window
    // has no mapping (the gateway already rejects those) and is dropped rather than guessed.
    const items: TelegramTriageObligation[] = [];
    for (const obligation of ct.items) {
      const anchorProviderEventId = built.ordinalToProviderEventId.get(obligation.anchorOrdinal);
      if (!anchorProviderEventId) continue;
      // Every field was already bounded (and the deadline grounded) by the gateway's validation; the
      // slices below are defence in depth, never a substitute for it.
      items.push({
        anchorProviderEventId,
        category: obligation.category,
        oneLineMeaning: obligation.oneLineMeaning.slice(0, AI_TRIAGE_LIMITS.maxMeaningChars),
        topic: obligation.topic.trim().slice(0, AI_TRIAGE_LIMITS.maxTopicChars),
        nextStep: obligation.nextStep.slice(0, AI_TRIAGE_LIMITS.maxNextStepChars),
        deadline: obligation.deadline === null ? null : obligation.deadline.trim().slice(0, AI_TRIAGE_LIMITS.maxDeadlineChars),
      });
    }

    // v4: the conversation reading is REQUIRED (the gateway rejects an answer without the key); null is
    // an honest "could not read it". Anything else here is a half-parsed answer -- refuse it whole.
    if (ct.conversation === undefined) return { outcome: 'REJECTED_OUTPUT', rejections: ['WRONG_SCHEMA'] };
    const conversation = ct.conversation === null ? null : keyedReading(ct.conversation, built.ordinalToProviderEventId);

    return {
      outcome: 'TRIAGED',
      items,
      conversation,
      limitations: result.output.limitations,
      provenance: result.provenance,
      evaluatedFloorProviderEventId: input.evaluatedFloorProviderEventId,
    };
  }
}

/**
 * The conversation reading with each ordinal resolved to its KEYED anchor. The gateway already bounded
 * every field, rejected any quote or copied run, and rejected an anchor outside the window; a statement
 * whose ordinal has no mapping is dropped rather than guessed (defence in depth, never a substitute).
 */
function keyedReading(c: AiConversationIntelligence, ordinals: ReadonlyMap<number, string>): TelegramConversationReading {
  const L = AI_TRIAGE_LIMITS;
  const keyed = <T extends { readonly anchorOrdinal: number; readonly statement: string }>(list: readonly T[], max: number) =>
    list.flatMap((s) => {
      const anchorProviderEventId = ordinals.get(s.anchorOrdinal);
      return anchorProviderEventId ? [{ source: s, anchorProviderEventId, statement: s.statement.trim().slice(0, L.maxStatementChars) }] : [];
    }).slice(0, max);
  const plain = (list: readonly { readonly anchorOrdinal: number; readonly statement: string }[], max: number): TelegramConversationStatement[] =>
    keyed(list, max).map(({ anchorProviderEventId, statement }) => ({ anchorProviderEventId, statement }));
  return {
    relevance: c.relevance,
    summary: c.summary.trim().slice(0, L.maxSummaryChars),
    topics: c.topics.map((t) => t.trim().slice(0, L.maxConversationTopicChars)).filter((t) => t !== '').slice(0, L.maxConversationTopics),
    developments: plain(c.developments, L.maxDevelopments),
    decisions: plain(c.decisions, L.maxDecisions),
    commitments: plain(c.commitments, L.maxCommitments),
    signals: keyed(c.signals, L.maxSignals).map(({ source, anchorProviderEventId, statement }) => ({ kind: source.kind, anchorProviderEventId, statement })),
    unresolved: c.unresolved === null ? null : c.unresolved.trim().slice(0, L.maxUnresolvedChars) || null,
    attention: c.attention.needed
      ? { needed: true, reason: (c.attention.reason ?? '').trim().slice(0, L.maxAttentionReasonChars) || null }
      : { needed: false, reason: null },
    confidence: c.confidence,
  };
}
