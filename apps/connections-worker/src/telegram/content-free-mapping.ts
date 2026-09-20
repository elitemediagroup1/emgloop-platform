// Telegram raw message -> Loop's content-free ConversationEvent. PURE.
//
// THIS IS THE SECURITY BOUNDARY FOR TELEGRAM. Everything the worker learns from a Telegram message
// passes through here, and the only thing that comes out is metadata: keyed (one-way, HMAC)
// identifiers, direction, timestamps, and WHETHER there was text -- never the text, media, caption,
// chat title or anybody's name. The input type is deliberately narrow: it has no field that could
// carry content, so a future edit cannot widen the shape by accident, and the mapping ends by
// asserting the produced event is content-free (assertConversationEventContentFree).
//
// The gramjs binding (telegram-client.ts) reads a live message and produces ONLY these facts; it is
// the untested-until-deployed seam. This mapping, which turns facts into the event Loop stores, is
// pure and fully tested.

import { assertConversationEventContentFree, conversationKeyOf, type ConversationEvent } from '@emgloop/shared';

/**
 * The metadata Loop reads from one Telegram message. No content field exists, by design.
 *  - `messageId`   the message's id within its chat (for a stable event id and idempotency)
 *  - `chatId`      the conversation/peer id
 *  - `senderId`    who sent it, or null when the provider does not say
 *  - `participantIds` the party ids known for this conversation (e.g. self + peer); keyed, not stored raw
 *  - `out`         true when THIS account sent the message (OUTBOUND), false when it received it
 *  - `dateSeconds` the provider's timestamp, unix seconds UTC
 *  - `hadText`     whether the message had text -- the boolean only, never the text
 */
export interface TelegramMessageFacts {
  readonly messageId: string;
  readonly chatId: string;
  readonly senderId: string | null;
  readonly participantIds: readonly string[];
  readonly out: boolean;
  readonly dateSeconds: number;
  readonly hadText: boolean;
}

/** Map one Telegram message's metadata to a content-free ConversationEvent. */
export function telegramMessageToConversationEvent(
  facts: TelegramMessageFacts,
  ctx: { readonly secret: string; readonly observedAt: Date; readonly cursor: string | null },
): ConversationEvent {
  const participantKeys = [...new Set(facts.participantIds.filter((id) => id !== '').map((id) => conversationKeyOf('participant', id, ctx.secret)))];
  const conversationKey = conversationKeyOf('conversation', facts.chatId, ctx.secret);
  const event: ConversationEvent = {
    provider: 'TELEGRAM',
    conversationKey,
    // Keyed off the hashed conversation key, NOT the raw chat id -- the message id is a per-chat
    // sequence number, not content or identity, so the pair stays stable and unique without leaking.
    providerEventId: `${conversationKey}:${facts.messageId}`,
    participantKeys,
    senderKey: facts.senderId ? conversationKeyOf('participant', facts.senderId, ctx.secret) : null,
    direction: facts.out ? 'OUTBOUND' : 'INBOUND',
    occurredAt: new Date(facts.dateSeconds * 1000).toISOString(),
    observedAt: ctx.observedAt.toISOString(),
    hadText: facts.hadText,
    cursor: ctx.cursor,
  };
  // Belt and braces: the event that leaves this module carries nothing but the allowlisted keys.
  assertConversationEventContentFree(event as unknown as Record<string, unknown>);
  return event;
}

/**
 * The resume cursor after a batch: the highest message id observed, as a string. Telegram message
 * ids increase within an account's update stream, so the maximum is a safe "seen up to here" point.
 * Returns the previous cursor unchanged when the batch is empty.
 */
export function telegramCursorAfter(previous: string | null, batch: readonly TelegramMessageFacts[]): string | null {
  let max = previous ? Number(previous) : 0;
  for (const f of batch) {
    const n = Number(f.messageId);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max > 0 ? String(max) : previous;
}
