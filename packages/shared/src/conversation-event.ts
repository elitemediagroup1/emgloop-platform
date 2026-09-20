// The normalized, provider-neutral observation Loop stores from a conversation source. This is the
// METADATA-OBSERVATION layer of OBSERVE -> NORMALIZE -> INTELLIGENCE: who a conversation was between
// and when, so Loop can connect a source to what it already knows (relationship, timing, cadence)
// WITHOUT holding message content. Downstream Loop never sees Teams DOM, Graph objects, or Telegram/
// MTProto objects -- an adapter maps its provider's raw event to THIS. Metadata + one-way keys only:
// there is no field that can hold a title, preview, body, sender name or chat name, and a test pins it.
//
// It feeds the SAME Loop intelligence model as Gmail, Calendar, CallGrid and CRM -- never a
// provider-specific silo. Content-level observation (understanding what a message MEANS -- a
// commitment, a decision, a risk) is a separate, deliberately deferred and GOVERNED layer: Loop may
// need content to understand what matters, but it minimizes and governs raw content and never becomes
// a mirror of the provider. This shape carries none of that content, by construction.
import { createHmac } from 'crypto';
import type { ConnectionProvider } from './source-connection';

export type ConversationDirection = 'INBOUND' | 'OUTBOUND' | 'UNKNOWN';

/** A one-way key for a raw provider id (chat id / user id), stable and non-reversible. */
export function conversationKeyOf(namespace: 'conversation' | 'participant', rawId: string, secret: string): string {
  return createHmac('sha256', secret).update(`${namespace}:${rawId}`).digest('hex');
}

export interface ConversationEvent {
  readonly provider: ConnectionProvider;
  readonly conversationKey: string;
  readonly providerEventId: string;
  readonly participantKeys: readonly string[];
  readonly senderKey: string | null;
  readonly direction: ConversationDirection;
  readonly occurredAt: string; // when it happened, per the provider (ISO-8601 UTC)
  readonly observedAt: string; // when Loop saw it (ISO-8601 UTC)
  readonly hadText: boolean;   // WHETHER a message had text, never the text
  readonly cursor: string | null;
}

export const CONVERSATION_EVENT_KEYS = [
  'provider', 'conversationKey', 'providerEventId', 'participantKeys',
  'senderKey', 'direction', 'occurredAt', 'observedAt', 'hadText', 'cursor',
] as const;

const SAFE_KEYS = new Set(['hadText', 'providerEventId', 'conversationKey', 'senderKey', 'participantKeys']);
const CONTENT_SUBSTRINGS = ['body', 'text', 'title', 'preview', 'subject', 'message', 'content', 'name'];

/** Throws if an instance carries a key outside the allowlist (e.g. a body field). */
export function assertConversationEventContentFree(event: Record<string, unknown>): void {
  for (const k of Object.keys(event)) {
    if (!(CONVERSATION_EVENT_KEYS as readonly string[]).includes(k)) {
      throw new Error(`disallowed key on ConversationEvent: ${k}`);
    }
  }
}

/** Guards the contract itself: no allowlisted key may imply content (future-edit tripwire). */
export function assertConversationAllowlistContentFree(): void {
  for (const k of CONVERSATION_EVENT_KEYS) {
    if (SAFE_KEYS.has(k)) continue;
    const lower = k.toLowerCase();
    for (const bad of CONTENT_SUBSTRINGS) if (lower.includes(bad)) throw new Error(`content-shaped key in the allowlist: ${k}`);
  }
}
