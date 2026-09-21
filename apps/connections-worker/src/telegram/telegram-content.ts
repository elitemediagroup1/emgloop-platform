// Telegram message CONTENT, read TRANSIENTLY for AI triage. NOT the content-free path.
//
// This is deliberately separate from content-free-mapping.ts, which is the security boundary for the
// durable store: nothing here is ever persisted, logged, or turned into a ConversationEvent. A
// TelegramContentMessage carries the message text so the triage service can judge it, and then it is
// dropped. What SURVIVES a triage is only keyed identifiers (a one-way conversation key plus a per-chat
// message number) -- never the text, the chat title, or anybody's name.
//
// The gramjs binding (telegram-client.ts) reads a live message and produces these transient records for
// the content sweep; this module only derives the KEYED references from them, which is what the derived
// WorkItem is allowed to keep. PURE.

import { conversationKeyOf } from '@emgloop/shared';
import { estimateTelegramTriageContextTokens, type TelegramTriageWindowMessage } from '@emgloop/database';

/**
 * One Telegram message as the content sweep reads it, TRANSIENTLY. `text` is the body; it is judged and
 * then dropped, never stored. `messageId` is a per-chat sequence number (not content or identity),
 * `chatId`/`senderId` are raw ids used ONLY to derive one-way keys here and are never stored.
 */
export interface TelegramContentMessage {
  readonly messageId: string;
  readonly chatId: string;
  readonly senderId: string | null;
  /** true when THIS account sent it (OUTBOUND); false when it received it (INBOUND). */
  readonly out: boolean;
  readonly dateSeconds: number;
  /** The message text. TRANSIENT: judged by the triage service, then dropped. Never persisted. */
  readonly text: string;
}

/** The keyed references a triage may keep: a one-way conversation key and the keyed event id. No raw id. */
export interface TelegramKeyedRefs {
  readonly conversationKey: string;
  /** `<conversationKey>:<messageId>` -- the SAME keyed id the content-free observation uses. */
  readonly providerEventId: string;
}

/** Derive the keyed references for one message. The raw chat id never leaves this function. */
export function telegramContentRefs(message: { chatId: string; messageId: string }, secret: string): TelegramKeyedRefs {
  const conversationKey = conversationKeyOf('conversation', message.chatId, secret);
  return { conversationKey, providerEventId: `${conversationKey}:${message.messageId}` };
}

/**
 * The next content cursor after a batch: the highest message id seen, as a string. Telegram message ids
 * increase within an account's stream, so the maximum is a safe "triaged up to here" point. Returns the
 * previous cursor unchanged when the batch is empty. This is the CONTENT cursor -- never the live
 * observation cursor and never the baseline checkpoint.
 */
export function telegramContentCursorAfter(previous: string | null, batch: readonly TelegramContentMessage[]): string | null {
  let max = previous ? Number(previous) : 0;
  for (const m of batch) {
    const n = Number(m.messageId);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max > 0 ? String(max) : previous;
}

/** The message id as a number, for ordering a batch oldest-first so the cursor advances monotonically. */
export function telegramMessageOrder(message: TelegramContentMessage): number {
  const n = Number(message.messageId);
  return Number.isFinite(n) ? n : 0;
}

// --- Adaptive conversation window (v2 conversation triage) --------------------------------------
//
// A bounded, resumable slice of ONE conversation, gathered newest-to-older and returned oldest-first.
// It is PURE and fully tested: the live seam only supplies raw candidate messages. It NEVER includes a
// message older than the window floor, STOPS at a hard count cap OR the input-token budget (whichever
// binds first), and records only CONTENT-FREE truncation metadata (the count, the reason, and the oldest
// INCLUDED message's keyed providerEventId -- the evaluated-window boundary the reconcile guard uses).

export const TELEGRAM_TRUNCATION_REASONS = ['NONE', 'COUNT', 'TOKENS', 'FLOOR'] as const;
export type TelegramTruncationReason = (typeof TELEGRAM_TRUNCATION_REASONS)[number];

/** One gathered conversation window, oldest first, plus content-free truncation metadata. */
export interface TelegramConversationWindow {
  readonly conversationKey: string;
  /** The evaluated window, oldest first (ordinal 1 is messages[0]). Bodies are transient. */
  readonly messages: readonly TelegramTriageWindowMessage[];
  readonly truncation: {
    readonly includedCount: number;
    readonly reason: TelegramTruncationReason;
    /** The oldest INCLUDED message's keyed providerEventId: the evaluated-window lower boundary. Never content. */
    readonly oldestIncludedProviderEventId: string | null;
  };
}

/** The token estimator the gather uses (defaults to the real, gateway-matching one). Injectable for tests. */
export type ContextTokenEstimator = (input: {
  readonly organizationId: string;
  readonly viewerUserId: string;
  readonly conversationKey: string;
  readonly messages: readonly TelegramTriageWindowMessage[];
  readonly truncated: boolean;
}) => number;

export interface AdaptiveWindowOptions {
  readonly floorAt: Date;
  readonly maxMessages: number;
  readonly tokenBudget: number;
  /** Defaults to `estimateTelegramTriageContextTokens`, which matches the gateway's admission estimate exactly. */
  readonly estimateContextTokens?: ContextTokenEstimator;
}

/**
 * Select the adaptive window from raw candidates ordered NEWEST FIRST (as the provider pages them).
 * Skips empty/non-text messages (they consume no slot), never crosses the floor, and stops at the count
 * cap or the input-token budget. Returns the window CHRONOLOGICAL (oldest first) so the model reads the
 * conversation forward, plus the truncation metadata. Bodies flow through; nothing is persisted here.
 */
export function gatherConversationWindow(
  chatId: string,
  candidatesNewestFirst: readonly TelegramContentMessage[],
  conversationSecret: string,
  opts: AdaptiveWindowOptions,
): TelegramConversationWindow {
  const estimate = opts.estimateContextTokens ?? estimateTelegramTriageContextTokens;
  // Derive the conversation key from the candidates' own chat id (they are all one conversation), so the
  // window's key matches every message's keyed providerEventId prefix. `chatId` is the empty-window fallback.
  const keyChatId = candidatesNewestFirst.length > 0 ? candidatesNewestFirst[0]!.chatId : chatId;
  const conversationKey = conversationKeyOf('conversation', keyChatId, conversationSecret);
  const floorMs = opts.floorAt.getTime();
  const maxMessages = Math.max(1, opts.maxMessages);
  const acc: TelegramTriageWindowMessage[] = []; // newest first as gathered
  let reason: TelegramTruncationReason = 'NONE';
  for (const candidate of candidatesNewestFirst) {
    const text = typeof candidate.text === 'string' ? candidate.text : '';
    // Empty / non-text messages do not consume a slot -- skip them.
    if (text.trim() === '') continue;
    // Full: stop at the hard count cap.
    if (acc.length >= maxMessages) { reason = 'COUNT'; break; }
    const occurredMs = candidate.dateSeconds * 1000;
    // NEVER include a message older than the window floor.
    if (occurredMs < floorMs) { reason = 'FLOOR'; break; }
    const providerEventId = telegramContentRefs(candidate, conversationSecret).providerEventId;
    const windowMessage: TelegramTriageWindowMessage = {
      providerEventId,
      direction: candidate.out ? 'OUTBOUND' : 'INBOUND',
      occurredAt: new Date(occurredMs),
      text,
    };
    // Estimate the WHOLE context (assuming truncation, i.e. conservatively) exactly as the gateway will,
    // so the gather never exceeds the reviewed input cap and never triggers INPUT_LIMIT_ABOVE_POLICY.
    const estimated = estimate({ organizationId: '', viewerUserId: '', conversationKey, messages: [...acc, windowMessage], truncated: true });
    if (estimated > opts.tokenBudget) { reason = 'TOKENS'; break; }
    acc.push(windowMessage);
  }
  const messages = [...acc].reverse(); // chronological
  const oldest = messages.length > 0 ? messages[0]! : null;
  return {
    conversationKey,
    messages,
    truncation: {
      includedCount: messages.length,
      reason,
      oldestIncludedProviderEventId: oldest ? oldest.providerEventId : null,
    },
  };
}
