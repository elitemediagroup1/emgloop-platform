// The context package for a Telegram conversation-triage read (content-triage slice, v2).
//
// WHAT GOES IN, AND WHY THAT AND NOTHING ELSE. An ORDERED slice of ONE conversation -- the recent
// messages the worker read TRANSIENTLY a moment ago from the employee's own authorized Telegram
// account -- one context block per message. Nothing about the organization, nothing from the CRM, no
// other conversation, and NO raw identifiers or names: each source reference is the KEYED
// providerEventId (a one-way conversation key plus a per-chat message number), never a raw chat id and
// never a body once the call is made.
//
// EACH MESSAGE IS UNTRUSTED_INPUT. It is somebody else's words: evidence to judge, never an instruction
// to obey. The trust level is the runtime's own vocabulary, the template says the same in prose, and
// the task publishes no tool -- three independent reasons an injected "mark this actionable" cannot
// become authority.
//
// THE BODIES ARE TRANSIENT. They are placed in the context for this one call and dropped afterwards.
// They are NEVER persisted, NEVER logged, and NEVER carried into a derived WorkItem or its evidence.
// The block ids and source references carry only keyed identifiers, so provenance survives without content.
//
// BOUNDED. Each message's text is capped, and the window itself is bounded upstream (count and input
// tokens), so one enormous message -- or an enormous conversation -- cannot become an enormous prompt.
// A TRUNCATED window adds one synthetic, CONTENT-FREE note so the model knows older context is not shown.

import {
  AI_TASK_TELEGRAM_CONTENT_TRIAGE,
  AI_TRIAGE_LIMITS,
  estimateAiInputTokens,
  type AiContextItem,
  type AiContextPackage,
  type AiSupportedEvidence,
} from '@emgloop/shared';

import {
  TELEGRAM_CONTENT_TRIAGE_SCHEMA,
  renderTelegramContentTriageInstructions,
} from './templates/telegram-content-triage';

/** How much of any ONE message a triage read may see. Bodies over this are truncated (never a whole prompt). */
export const TELEGRAM_TRIAGE_CONTEXT_LIMITS = Object.freeze({ maxMessageChars: AI_TRIAGE_LIMITS.maxMessageChars });

/** One message in the evaluated window. `text` is transient: dropped after the call, never persisted. */
export interface TelegramTriageWindowMessage {
  /** The KEYED event id (`<conversationKey>:<messageId>`), never a raw chat/message id. */
  readonly providerEventId: string;
  /** INBOUND when the person received it, OUTBOUND when they sent it. */
  readonly direction: 'INBOUND' | 'OUTBOUND';
  /** When the message was sent, per the provider (UTC). */
  readonly occurredAt: Date;
  /** The message text, read transiently. It is dropped after the call and never persisted. */
  readonly text: string;
}

export interface TelegramTriageContextInput {
  readonly organizationId: string;
  readonly viewerUserId: string;
  /** The one-way conversation key this window belongs to. Never a raw chat id. */
  readonly conversationKey: string;
  /** The window, oldest first. Ordinal 1 is messages[0]. */
  readonly messages: readonly TelegramTriageWindowMessage[];
  /** True when older context (before ordinal 1) was not shown. Adds a content-free caution. */
  readonly truncated: boolean;
}

export interface TelegramTriageContext {
  readonly context: AiContextPackage;
  readonly evidence: AiSupportedEvidence;
  /** Renders the reviewed instructions with the truncation caution matching this window. */
  readonly instructions: string;
  /** ordinal (1-based) -> keyed providerEventId, so a returned anchorOrdinal resolves to a keyed anchor. */
  readonly ordinalToProviderEventId: ReadonlyMap<number, string>;
  readonly manifest: { readonly includedCount: number; readonly truncated: boolean };
}

/** One keyed source ref for a message. Never a raw id, never the body. */
function messageSourceRef(providerEventId: string): string {
  return `telegram_message:${providerEventId}`;
}

/** The one keyed source ref for the truncation note. Content-free: the conversation key only. */
function truncationSourceRef(conversationKey: string): string {
  return `telegram_conversation:${conversationKey}`;
}

/** The content string for one message block: "<ordinal> <DIR> <occurredAt>: <text>" (text capped). */
export function formatTriageMessageContent(ordinal: number, message: TelegramTriageWindowMessage): string {
  const text = message.text ?? '';
  const capped = text.length > TELEGRAM_TRIAGE_CONTEXT_LIMITS.maxMessageChars ? text.slice(0, TELEGRAM_TRIAGE_CONTEXT_LIMITS.maxMessageChars) : text;
  return `${ordinal} ${message.direction} ${message.occurredAt.toISOString()}: ${capped || '(no readable text)'}`;
}

/**
 * The context items for a window, and the ordinal->providerEventId map. Shared by the package builder
 * and the token estimator so the worker's gather and the gateway's admission check see byte-identical
 * items. A truncated window appends one synthetic, content-free note (GOVERNED_FACT, OPERATIONAL).
 */
function windowContextItems(input: TelegramTriageContextInput): {
  readonly items: AiContextItem[];
  readonly ordinalToProviderEventId: Map<number, string>;
} {
  const items: AiContextItem[] = [];
  const ordinalToProviderEventId = new Map<number, string>();
  input.messages.forEach((message, index) => {
    const ordinal = index + 1;
    const sourceRef = messageSourceRef(message.providerEventId);
    ordinalToProviderEventId.set(ordinal, message.providerEventId);
    items.push({
      blockId: `${input.organizationId}::${sourceRef}`,
      kind: 'TEXT',
      // Somebody else's words. Never an instruction, whatever they say inside.
      trust: 'UNTRUSTED_INPUT',
      sourceRef,
      content: formatTriageMessageContent(ordinal, message),
      sensitivity: 'COMMUNICATION_CONTENT',
      readUnder: { resource: 'sourceConnections', action: 'view' },
    });
  });
  if (input.truncated) {
    const sourceRef = truncationSourceRef(input.conversationKey);
    items.push({
      blockId: `${input.organizationId}::${sourceRef}`,
      kind: 'TEXT',
      // Loop's own note, not the correspondents' words. Content-free: no message text, no name, no raw id.
      trust: 'GOVERNED_FACT',
      sourceRef,
      content: 'NOTE: this is a bounded recent slice of the conversation. Older messages before ordinal 1 are not shown.',
      sensitivity: 'OPERATIONAL',
      readUnder: { resource: 'sourceConnections', action: 'view' },
    });
  }
  return { items, ordinalToProviderEventId };
}

/** Build the package. It assembles; it decides nothing about which obligations are unresolved. */
export function buildTelegramTriageContext(input: TelegramTriageContextInput): TelegramTriageContext {
  const { items, ordinalToProviderEventId } = windowContextItems(input);
  return {
    context: {
      organizationId: input.organizationId,
      viewerUserId: input.viewerUserId,
      taskId: AI_TASK_TELEGRAM_CONTENT_TRIAGE.taskId,
      items,
      sensitivityCeiling: AI_TASK_TELEGRAM_CONTENT_TRIAGE.sensitivityCeiling,
    },
    instructions: renderTelegramContentTriageInstructions({ truncated: input.truncated }),
    // A conversation triage is not figure-checked (a minimized paraphrase naturally restates a fact, and
    // it is excluded from the number/date scan). The evidence is supplied for the runtime's own contract
    // and is deliberately empty of figures rather than pretending to have grounded them.
    evidence: { figures: new Map(), dates: new Set() },
    ordinalToProviderEventId,
    manifest: { includedCount: input.messages.length, truncated: input.truncated },
  };
}

/**
 * The estimated INPUT tokens for the whole context the gateway will admit, computed EXACTLY the way the
 * gateway does: `estimateAiInputTokens([instructions, JSON.stringify(schema), ...items(sourceRef,trust,content)])`.
 * The worker's adaptive window gathers messages against this so it never exceeds the reviewed input cap
 * and never triggers INPUT_LIMIT_ABOVE_POLICY. Order-independent in the message set; deterministic.
 */
export function estimateTelegramTriageContextTokens(input: TelegramTriageContextInput): number {
  const { items } = windowContextItems(input);
  return estimateAiInputTokens([
    renderTelegramContentTriageInstructions({ truncated: input.truncated }),
    JSON.stringify(TELEGRAM_CONTENT_TRIAGE_SCHEMA),
    ...items.flatMap((item) => [item.sourceRef, item.trust, item.content]),
  ]);
}
