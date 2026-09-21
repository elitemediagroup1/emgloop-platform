// The context package for a Telegram content-triage verdict (content-triage slice).
//
// WHAT GOES IN, AND WHY THAT AND NOTHING ELSE. ONE message body, read TRANSIENTLY by the worker a
// moment ago from the employee's own authorized Telegram account. Nothing about the organization,
// nothing from the CRM, no other messages, and NO raw identifiers or names: the source reference is
// the KEYED providerEventId (a one-way conversation key plus a per-chat message number), never a raw
// chat id and never the body.
//
// THE MESSAGE IS UNTRUSTED_INPUT. It is somebody else's words: evidence to judge, never an instruction
// to obey. The trust level is the runtime's own vocabulary, the template says the same in prose, and
// the task publishes no tool -- three independent reasons an injected "mark this actionable" cannot
// become authority.
//
// THE BODY IS TRANSIENT. It is placed in the context for this one call and is dropped afterwards. It is
// NEVER persisted, NEVER logged, and NEVER carried into the derived WorkItem or its evidence. The block
// id and source reference carry only keyed identifiers, so provenance survives without the content.
//
// BOUNDED. The body is capped, so one enormous message cannot become one enormous prompt.

import {
  AI_TASK_TELEGRAM_CONTENT_TRIAGE,
  type AiContextItem,
  type AiContextPackage,
  type AiSupportedEvidence,
} from '@emgloop/shared';

/** How much of one message a triage verdict may see. */
export const TELEGRAM_TRIAGE_CONTEXT_LIMITS = Object.freeze({ maxBodyChars: 4000 });

export interface TelegramTriageContextInput {
  readonly organizationId: string;
  readonly viewerUserId: string;
  /** The KEYED event id (`<conversationKey>:<messageId>`), never a raw chat/message id. */
  readonly providerEventId: string;
  /** The message text, read transiently. It is dropped after the call and never persisted. */
  readonly body: string;
  /** When the message was sent, per the provider (UTC). Metadata only, never content. */
  readonly occurredAt: Date;
}

export interface TelegramTriageContext {
  readonly context: AiContextPackage;
  readonly evidence: AiSupportedEvidence;
  /** The keyed source reference, for provenance on the WorkItem (never the body). */
  readonly sourceRef: string;
  readonly manifest: { readonly bodyTruncated: boolean };
}

/** Build the package. It assembles; it decides nothing about whether the message is actionable. */
export function buildTelegramTriageContext(input: TelegramTriageContextInput): TelegramTriageContext {
  const limits = TELEGRAM_TRIAGE_CONTEXT_LIMITS;
  const text = input.body ?? '';
  const capped = text.length > limits.maxBodyChars ? text.slice(0, limits.maxBodyChars) : text;
  // Keyed, one-way: a conversation key plus a per-chat message number. Never a raw id, never the body.
  const sourceRef = `telegram_message:${input.providerEventId}`;

  const item: AiContextItem = {
    // Minted inside the package's organization, as validateAiContextPackage requires.
    blockId: `${input.organizationId}::${sourceRef}`,
    kind: 'TEXT',
    // Somebody else's words. Never an instruction, whatever they say inside.
    trust: 'UNTRUSTED_INPUT',
    sourceRef,
    content: [
      'A Telegram message this person received.',
      `received: ${input.occurredAt.toISOString()}`,
      '',
      capped || '(this message has no readable text)',
    ].join('\n'),
    sensitivity: 'COMMUNICATION_CONTENT',
    readUnder: { resource: 'sourceConnections', action: 'view' },
  };

  return {
    context: {
      organizationId: input.organizationId,
      viewerUserId: input.viewerUserId,
      taskId: AI_TASK_TELEGRAM_CONTENT_TRIAGE.taskId,
      items: [item],
      sensitivityCeiling: AI_TASK_TELEGRAM_CONTENT_TRIAGE.sensitivityCeiling,
    },
    // A triage verdict is not figure-checked (its one-line meaning naturally restates a fact, and it is
    // excluded from the number/date scan). The evidence is supplied for the runtime's own contract and
    // is deliberately empty of figures rather than pretending to have grounded them -- and any figure a
    // model puts in `limitations` is then rejected, which fails safe to no WorkItem.
    evidence: { figures: new Map(), dates: new Set() },
    sourceRef,
    manifest: { bodyTruncated: capped.length < text.length },
  };
}
