// Telegram content triage: a conservative, employee-private verdict on ONE inbound message.
//
// Architecture: the content-triage slice of the Telegram intelligence plan. The message body is read
// TRANSIENTLY by the worker, judged here through the governed AI runtime, and dropped. The employee
// authorized content processing (a separate consent), and the invocation traces to THEM -- the gateway
// re-checks their authority, the deployment's activation, the budget, the routing and the output
// contract; nothing here names a provider or a model.
//
// THE BODY IS NEVER LOGGED AND NEVER PERSISTED. It enters one context package, goes to one governed
// call, and is dropped. The verdict Loop keeps is MINIMIZED: a boolean, a category, a one-line
// paraphrase (never a quote) and a few limitations. The ledger receives ids, versions and counts
// through the gateway -- never the message and never the verdict text (see gateway.ts, "NO BODY IS
// PERSISTED").
//
// IT CAN ACT ON NOTHING. The task publishes no tool and produces only a JSON verdict. Turning an
// actionable verdict into an employee-private WorkItem is the worker's job, downstream of this service;
// this service concludes, it does not write work state.

import {
  AI_TASK_TELEGRAM_CONTENT_TRIAGE,
  type AiAdmissionRefusal,
  type AiInvocationProvenance,
  type AiOutputRejection,
  type AiTriageCategory,
} from '@emgloop/shared';

import { buildTelegramTriageContext } from './telegram-content-triage-context';
import type { AiPrincipal, AiRunRequest, AiRunResult } from './gateway';
import {
  TELEGRAM_CONTENT_TRIAGE_SCHEMA,
  TELEGRAM_CONTENT_TRIAGE_SCHEMA_ID,
  TELEGRAM_CONTENT_TRIAGE_TEMPLATE_ID,
  TELEGRAM_CONTENT_TRIAGE_TEMPLATE_VERSION,
  renderTelegramContentTriageInstructions,
} from './templates/telegram-content-triage';

export interface TelegramContentTriageRuntime {
  run(principal: AiPrincipal, request: AiRunRequest): Promise<AiRunResult>;
}

export interface TelegramContentTriageDeps {
  readonly runtime: TelegramContentTriageRuntime;
}

/** One inbound message to judge. `body` is transient: it is dropped after the call, never persisted. */
export interface TelegramTriageInput {
  /** The KEYED event id (`<conversationKey>:<messageId>`), never a raw chat/message id. */
  readonly providerEventId: string;
  /** The message text, read transiently by the worker. */
  readonly body: string;
  /** When the message was sent, per the provider (UTC). */
  readonly occurredAt: Date;
}

/** The minimized verdict. No body, ever -- a paraphrase, a category, and provenance by keyed refs. */
export interface TelegramTriageVerdict {
  readonly actionable: boolean;
  readonly category: AiTriageCategory;
  readonly oneLineMeaning: string;
  readonly limitations: readonly string[];
  readonly provenance: AiInvocationProvenance;
  /** The keyed source reference, for the WorkItem's provenance. Never the body. */
  readonly sourceRef: string;
}

export type TelegramTriageResult =
  | { readonly outcome: 'TRIAGED'; readonly verdict: TelegramTriageVerdict }
  | { readonly outcome: 'NOT_AVAILABLE'; readonly refusals: readonly AiAdmissionRefusal[] }
  | { readonly outcome: 'REJECTED_OUTPUT'; readonly rejections: readonly AiOutputRejection[] }
  | { readonly outcome: 'REFUSED_BY_MODEL' }
  | { readonly outcome: 'FAILED'; readonly failure: string };

export class TelegramContentTriageService {
  constructor(private readonly deps: TelegramContentTriageDeps) {}

  /**
   * Judge one inbound message for one employee. The principal is the employee whose Telegram it is; a
   * message that is not theirs is never handed here (the worker resolves by (org, user, provider) and
   * fetches from their own authorized session). NOT_AVAILABLE covers every governed refusal -- not
   * authorized, not activated, no budget, no configured provider -- and yields NO WorkItem upstream.
   */
  async triage(principal: AiPrincipal, input: TelegramTriageInput): Promise<TelegramTriageResult> {
    const built = buildTelegramTriageContext({
      organizationId: principal.organizationId,
      viewerUserId: principal.userId,
      providerEventId: input.providerEventId,
      body: input.body,
      occurredAt: input.occurredAt,
    });

    // One governed call. The gateway owns authorization, activation, budget, routing, provenance and
    // the output contract; nothing here names a provider or a model, and the body reaches nothing but
    // this call.
    const result = await this.deps.runtime.run(principal, {
      task: AI_TASK_TELEGRAM_CONTENT_TRIAGE,
      context: built.context,
      instructions: renderTelegramContentTriageInstructions(built.sourceRef),
      templateId: TELEGRAM_CONTENT_TRIAGE_TEMPLATE_ID,
      templateVersion: TELEGRAM_CONTENT_TRIAGE_TEMPLATE_VERSION,
      schema: TELEGRAM_CONTENT_TRIAGE_SCHEMA,
      evidence: built.evidence,
    });

    if (result.outcome === 'REFUSED_BY_LOOP') return { outcome: 'NOT_AVAILABLE', refusals: result.refusals };
    if (result.outcome === 'REJECTED_OUTPUT') return { outcome: 'REJECTED_OUTPUT', rejections: result.rejections };
    if (result.outcome === 'REFUSED_BY_MODEL') return { outcome: 'REFUSED_BY_MODEL' };
    if (result.outcome !== 'ANSWERED') return { outcome: 'FAILED', failure: result.failure };

    // The gateway already validated the verdict against the task's schema; defend in depth anyway, and
    // never read a half-parsed answer as a verdict.
    const t = result.output.triage;
    if (!t || result.output.schemaId !== TELEGRAM_CONTENT_TRIAGE_SCHEMA_ID) {
      return { outcome: 'REJECTED_OUTPUT', rejections: ['WRONG_SCHEMA'] };
    }

    return {
      outcome: 'TRIAGED',
      verdict: {
        actionable: t.actionable,
        category: t.category,
        oneLineMeaning: t.oneLineMeaning,
        limitations: result.output.limitations,
        provenance: result.provenance,
        sourceRef: built.sourceRef,
      },
    };
  }
}
