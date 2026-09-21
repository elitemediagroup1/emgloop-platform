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
