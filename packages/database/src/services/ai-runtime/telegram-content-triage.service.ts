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
// and is dropped. What Loop keeps is MINIMIZED: a category, a one-line paraphrase (never a quote) and a
// KEYED anchor (never a raw id, never the body) per obligation. The ledger receives ids, versions and
// counts through the gateway -- never a message and never the paraphrase text (see gateway.ts).
//
// IT CAN ACT ON NOTHING. The task publishes no tool and produces only a JSON list. Turning an obligation
// into an employee-private WorkItem, and reconciling answered obligations, are the worker's job
// downstream of this service; this service concludes, it does not write work state.

import {
  AI_TASK_TELEGRAM_CONTENT_TRIAGE,
  AI_TRIAGE_LIMITS,
  type AiAdmissionRefusal,
  type AiInvocationProvenance,
  type AiOutputRejection,
  type AiTriageCategory,
} from '@emgloop/shared';

import { buildTelegramTriageContext, type TelegramTriageWindowMessage } from './telegram-content-triage-context';
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
}

/** One still-unresolved obligation, minimized. A KEYED anchor, a category, a paraphrase -- never a body. */
export interface TelegramTriageObligation {
  /** The keyed providerEventId of the message that originated it. Never a raw id, never the body. */
  readonly anchorProviderEventId: string;
  readonly category: AiTriageCategory;
  readonly oneLineMeaning: string;
}

export type TelegramConversationTriageResult =
  | {
      readonly outcome: 'TRIAGED';
      readonly items: readonly TelegramTriageObligation[];
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
      items.push({
        anchorProviderEventId,
        category: obligation.category,
        oneLineMeaning: obligation.oneLineMeaning.slice(0, AI_TRIAGE_LIMITS.maxMeaningChars),
      });
    }

    return {
      outcome: 'TRIAGED',
      items,
      limitations: result.output.limitations,
      provenance: result.provenance,
      evaluatedFloorProviderEventId: input.evaluatedFloorProviderEventId,
    };
  }
}
