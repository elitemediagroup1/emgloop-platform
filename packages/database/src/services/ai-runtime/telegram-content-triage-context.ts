// The context package for a Telegram conversation-triage read (content-triage slice, v2.1).
//
// WHAT GOES IN, AND WHY THAT AND NOTHING ELSE. An ORDERED slice of ONE conversation -- the recent
// messages the worker read TRANSIENTLY a moment ago from the employee's own authorized Telegram
// account -- one context block per message, preceded by ONE block naming the conversation the way
// Telegram itself names it (a contact's display name or a group title). Nothing about the organization,
// nothing from the CRM, no other conversation, and NO raw identifiers: each source reference is the KEYED
// providerEventId (a one-way conversation key plus a per-chat message number), never a raw chat id, and
// the bodies are gone once the call is made.
//
// WHY THE LABEL IS IN. A verdict that cannot say who a conversation is with is a generic card nobody
// can act on. The label is the same one the employee already sees in Telegram, it is supplied by Telegram
// (never produced by a model), and it is minimized upstream (trimmed, capped, no handle, no phone). In a
// GROUP, each inbound message also carries its sender's display label so the model can tell who asked --
// that per-message label is TRANSIENT context only, and nothing downstream persists it.
//
// EVERY BLOCK IS UNTRUSTED_INPUT -- the label included. A group title can say "ignore your instructions"
// as easily as a message can. It is somebody else's text: evidence to judge, never an instruction to obey.
// The trust level is the runtime's own vocabulary, the template says the same in prose, and the task
// publishes no tool -- three independent reasons an injected "mark this actionable" cannot become authority.
//
// THE BODIES ARE TRANSIENT. They are placed in the context for this one call and dropped afterwards.
// They are NEVER persisted, NEVER logged, and NEVER carried into a derived WorkItem or its evidence.
// The block ids and source references carry only keyed identifiers, so provenance survives without content.
//
// GROUNDING. The evidence handed to the validator carries the word tokens of everything the model was
// shown (`terms`), so a deadline the model returns can be checked to be RESTATED from the conversation
// rather than produced -- and (v4) every run of ten consecutive words inside each message
// (`verbatimRuns`), so a conversation reading that COPIES a message is refused. Both are transient: they
// exist for the one validation and are dropped.
//
// BOUNDED. Each message's text is capped, and the window itself is bounded upstream (count and input
// tokens), so one enormous message -- or an enormous conversation -- cannot become an enormous prompt.
// A TRUNCATED window adds one synthetic, CONTENT-FREE note so the model knows older context is not shown.

import {
  AI_TASK_TELEGRAM_CONTENT_TRIAGE,
  AI_TRIAGE_LIMITS,
  aiTermsInText,
  aiVerbatimRuns,
  estimateAiInputTokens,
  telegramConversationSubjectRef,
  type AiContextItem,
  type AiContextPackage,
  type AiSupportedEvidence,
} from '@emgloop/shared';

import {
  TELEGRAM_CONTENT_TRIAGE_SCHEMA,
  renderTelegramContentTriageInstructions,
} from './templates/telegram-content-triage';

/** How much of any ONE message a triage read may see, and how long a conversation label may be. */
export const TELEGRAM_TRIAGE_CONTEXT_LIMITS = Object.freeze({
  maxMessageChars: AI_TRIAGE_LIMITS.maxMessageChars,
  maxLabelChars: AI_TRIAGE_LIMITS.maxCounterpartyLabelChars,
});

export const TELEGRAM_CONVERSATION_KINDS = ['PRIVATE', 'GROUP'] as const;
export type TelegramConversationKind = (typeof TELEGRAM_CONVERSATION_KINDS)[number];

/**
 * How Telegram itself names the conversation: a contact's display name for a private chat, a group's
 * title for a group. Supplied by the worker from the provider's own entity, MINIMIZED (trimmed, capped,
 * no @handle, no phone number) -- and never produced by a model. Null when Telegram gave none.
 */
export interface TelegramTriageConversation {
  readonly label: string | null;
  readonly kind: TelegramConversationKind | null;
}

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
  /**
   * In a GROUP, the sender's display label as Telegram shows it (inbound only), so the model can tell
   * who asked. TRANSIENT context only: nothing downstream persists it.
   */
  readonly senderLabel?: string | null;
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
  /** How Telegram names this conversation. Absent or null: the model is not told who it is with. */
  readonly conversation?: TelegramTriageConversation | null;
}

export interface TelegramTriageContext {
  readonly context: AiContextPackage;
  readonly evidence: AiSupportedEvidence;
  /** Renders the reviewed instructions with the truncation caution matching this window. */
  readonly instructions: string;
  /** ordinal (1-based) -> keyed providerEventId, so a returned anchorOrdinal resolves to a keyed anchor. */
  readonly ordinalToProviderEventId: ReadonlyMap<number, string>;
  readonly manifest: { readonly includedCount: number; readonly truncated: boolean; readonly labelled: boolean };
}

/** One keyed source ref for a message. Never a raw id, never the body. */
function messageSourceRef(providerEventId: string): string {
  return `telegram_message:${providerEventId}`;
}

/** The one keyed source ref for conversation-level blocks (the label header, the truncation note). */
function conversationSourceRef(conversationKey: string): string {
  return telegramConversationSubjectRef(conversationKey);
}

function capLabel(label: string): string {
  return label.length > TELEGRAM_TRIAGE_CONTEXT_LIMITS.maxLabelChars ? label.slice(0, TELEGRAM_TRIAGE_CONTEXT_LIMITS.maxLabelChars) : label;
}

/** The content string for one message block: "<ordinal> <DIR> <occurredAt>[ [from <label>]]: <text>" (text capped). */
export function formatTriageMessageContent(ordinal: number, message: TelegramTriageWindowMessage): string {
  const text = message.text ?? '';
  const capped = text.length > TELEGRAM_TRIAGE_CONTEXT_LIMITS.maxMessageChars ? text.slice(0, TELEGRAM_TRIAGE_CONTEXT_LIMITS.maxMessageChars) : text;
  const sender = typeof message.senderLabel === 'string' && message.senderLabel.trim() !== '' ? ` [from ${capLabel(message.senderLabel.trim())}]` : '';
  return `${ordinal} ${message.direction} ${message.occurredAt.toISOString()}${sender}: ${capped || '(no readable text)'}`;
}

/** The content string for the conversation header block. Telegram's own label, in the provider's own terms. */
export function formatTriageConversationContent(conversation: TelegramTriageConversation): string | null {
  const label = typeof conversation.label === 'string' ? conversation.label.trim() : '';
  if (label === '') return null;
  const capped = capLabel(label);
  return conversation.kind === 'GROUP' ? `CONVERSATION: group "${capped}"` : `CONVERSATION: private chat with "${capped}"`;
}

/**
 * The context items for a window, and the ordinal->providerEventId map. Shared by the package builder
 * and the token estimator so the worker's gather and the gateway's admission check see byte-identical
 * items. The label header (when Telegram gave a label) comes first; a truncated window appends one
 * synthetic, content-free note (GOVERNED_FACT, OPERATIONAL). Neither is anchorable: the validator numbers
 * anchors over MESSAGE blocks only.
 */
function windowContextItems(input: TelegramTriageContextInput): {
  readonly items: AiContextItem[];
  readonly ordinalToProviderEventId: Map<number, string>;
  readonly labelled: boolean;
} {
  const items: AiContextItem[] = [];
  const ordinalToProviderEventId = new Map<number, string>();
  const header = input.conversation ? formatTriageConversationContent(input.conversation) : null;
  if (header !== null) {
    const sourceRef = conversationSourceRef(input.conversationKey);
    items.push({
      blockId: `${input.organizationId}::${sourceRef}#about`,
      kind: 'TEXT',
      // Telegram's label for the conversation -- somebody else's text, as a group title can be. Never an instruction.
      trust: 'UNTRUSTED_INPUT',
      sourceRef,
      content: header,
      sensitivity: 'COMMUNICATION_CONTENT',
      readUnder: { resource: 'sourceConnections', action: 'view' },
    });
  }
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
    const sourceRef = conversationSourceRef(input.conversationKey);
    items.push({
      blockId: `${input.organizationId}::${sourceRef}#truncated`,
      kind: 'TEXT',
      // Loop's own note, not the correspondents' words. Content-free: no message text, no name, no raw id.
      trust: 'GOVERNED_FACT',
      sourceRef,
      content: 'NOTE: this is a bounded recent slice of the conversation. Older messages before ordinal 1 are not shown.',
      sensitivity: 'OPERATIONAL',
      readUnder: { resource: 'sourceConnections', action: 'view' },
    });
  }
  return { items, ordinalToProviderEventId, labelled: header !== null };
}

/**
 * The word tokens of everything the model is shown -- the (capped) message texts and the label -- so a
 * deadline it returns can be checked to be restated, not produced. Transient: built for one validation.
 */
function supportedTerms(input: TelegramTriageContextInput): ReadonlySet<string> {
  const terms = new Set<string>();
  for (const message of input.messages) {
    const text = message.text ?? '';
    const capped = text.length > TELEGRAM_TRIAGE_CONTEXT_LIMITS.maxMessageChars ? text.slice(0, TELEGRAM_TRIAGE_CONTEXT_LIMITS.maxMessageChars) : text;
    for (const term of aiTermsInText(capped)) terms.add(term);
  }
  if (input.conversation?.label) for (const term of aiTermsInText(input.conversation.label)) terms.add(term);
  return terms;
}

/**
 * Every run of `AI_TRIAGE_LIMITS.verbatimRunTokens` consecutive words inside ONE (capped) message, so a
 * conversation reading that copies a sentence is refused (VERBATIM_CONTENT). Runs never span two
 * messages. Transient, like `terms`: built for one validation and dropped.
 */
function verbatimRuns(input: TelegramTriageContextInput): ReadonlySet<string> {
  const runs = new Set<string>();
  for (const message of input.messages) {
    const text = message.text ?? '';
    const capped = text.length > TELEGRAM_TRIAGE_CONTEXT_LIMITS.maxMessageChars ? text.slice(0, TELEGRAM_TRIAGE_CONTEXT_LIMITS.maxMessageChars) : text;
    for (const run of aiVerbatimRuns(capped)) runs.add(run);
  }
  return runs;
}

/** Build the package. It assembles; it decides nothing about which obligations are unresolved. */
export function buildTelegramTriageContext(input: TelegramTriageContextInput): TelegramTriageContext {
  const { items, ordinalToProviderEventId, labelled } = windowContextItems(input);
  return {
    context: {
      organizationId: input.organizationId,
      viewerUserId: input.viewerUserId,
      taskId: AI_TASK_TELEGRAM_CONTENT_TRIAGE.taskId,
      items,
      sensitivityCeiling: AI_TASK_TELEGRAM_CONTENT_TRIAGE.sensitivityCeiling,
    },
    instructions: renderTelegramContentTriageInstructions({ truncated: input.truncated, labelled }),
    // A conversation triage is not figure-checked (a minimized paraphrase naturally restates a fact, and
    // it is excluded from the number/date scan): figures and dates are deliberately empty rather than
    // pretending to have grounded them. `terms` grounds the one field that must be COPIED: the deadline.
    // `verbatimRuns` lets the validator refuse a conversation reading that copies a message (v4).
    evidence: { figures: new Map(), dates: new Set(), terms: supportedTerms(input), verbatimRuns: verbatimRuns(input) },
    ordinalToProviderEventId,
    manifest: { includedCount: input.messages.length, truncated: input.truncated, labelled },
  };
}

/**
 * The estimated INPUT tokens for the whole context the gateway will admit, computed EXACTLY the way the
 * gateway does: `estimateAiInputTokens([instructions, JSON.stringify(schema), ...items(sourceRef,trust,content)])`.
 * The worker's adaptive window gathers messages against this so it never exceeds the reviewed input cap
 * and never triggers INPUT_LIMIT_ABOVE_POLICY. Order-independent in the message set; deterministic.
 */
export function estimateTelegramTriageContextTokens(input: TelegramTriageContextInput): number {
  const { items, labelled } = windowContextItems(input);
  return estimateAiInputTokens([
    renderTelegramContentTriageInstructions({ truncated: input.truncated, labelled }),
    JSON.stringify(TELEGRAM_CONTENT_TRIAGE_SCHEMA),
    ...items.flatMap((item) => [item.sourceRef, item.trust, item.content]),
  ]);
}
