// The Telegram ConnectionAdapter: resume an authorized MTProto session, observe incrementally,
// disconnect. It depends on a TelegramClientPort (the MTProto client), NOT on gramjs directly, so
// the adapter's policy -- what an auth failure is, how a cursor advances, what "observing" means --
// is pure and fully testable, while the live client is a thin seam (telegram-client.ts).
//
// AN INTELLIGENCE SOURCE, NOT A CLIENT. This adapter OBSERVES and NORMALIZES; it has no send, reply,
// react, edit or delete -- Telegram stays the place the conversation happens. observe() turns the
// client's raw messages into content-free ConversationEvents through the one mapping
// (content-free-mapping.ts); the adapter itself never touches text, media or names. Turning what
// matters into cross-source intelligence is a downstream step over these observations, not the
// adapter's job -- and content-level observation is a separate, governed, deferred layer.
//
// This is the OFFICIAL USER CLIENT route (MTProto), not a bot. Auth INITIATION (the phone-code
// exchange) is out of band and lives in the login flow, not here: resume() only restores an
// already-authorized session from the unsealed session string.

import type { AdapterSession, ConnectionAdapter, ObservationResult } from '@emgloop/database';
import type { CapabilityStatus } from '@emgloop/shared';

import { telegramCursorAfter, telegramMessageToConversationEvent, type TelegramMessageFacts } from './content-free-mapping';

/** A stale or invalid MTProto session. Named so runConnectionCycle classifies it as auth loss. */
export class TelegramAuthError extends Error {
  constructor(message = 'telegram session is no longer authorized') {
    super(message);
    this.name = 'TelegramAuthError';
  }
}

/** The MTProto client, as the adapter needs it. The gramjs binding implements this. */
export interface TelegramClientPort {
  /** Restore a client from the unsealed session string. Throws TelegramAuthError if it is stale. */
  connectFromSession(session: string, binding: { organizationId: string; userId: string }): Promise<TelegramClientHandle>;
  /** Message metadata since `cursor` (a message id), oldest first. Content-free facts only. */
  fetchSince(handle: TelegramClientHandle, cursor: string | null, now: Date): Promise<readonly TelegramMessageFacts[]>;
  /** Close the socket. Never modifies the Telegram account. */
  close(handle: TelegramClientHandle): Promise<void>;
  /** Revoke this authorization at Telegram (used only by disconnect). Optional; best-effort. */
  logOut?(handle: TelegramClientHandle): Promise<void>;
}

export interface TelegramClientHandle {
  readonly kind: 'telegram-mtproto';
  readonly client: unknown;
}

export class TelegramAdapter implements ConnectionAdapter {
  readonly provider = 'TELEGRAM' as const;
  private readonly port: TelegramClientPort;
  private readonly conversationSecret: string;

  constructor(deps: { port: TelegramClientPort; conversationSecret: string }) {
    this.port = deps.port;
    this.conversationSecret = deps.conversationSecret;
  }

  async resume(secret: string, binding: { organizationId: string; userId: string }): Promise<AdapterSession> {
    const handle = await this.port.connectFromSession(secret, binding);
    return { provider: this.provider, handle };
  }

  async observe(session: AdapterSession, cursor: string | null, now: Date): Promise<ObservationResult> {
    const handle = session.handle as TelegramClientHandle;
    const batch = await this.port.fetchSince(handle, cursor, now);
    const events = batch.map((facts) => telegramMessageToConversationEvent(facts, { secret: this.conversationSecret, observedAt: now, cursor: null }));
    const nextCursor = telegramCursorAfter(cursor, batch);
    // Reaching this point means the client answered: background observation is operational.
    const backgroundObservation: CapabilityStatus = 'OPERATIONAL';
    return { events, cursor: nextCursor, backgroundObservation };
  }

  async disconnect(session: AdapterSession): Promise<void> {
    await this.port.close(session.handle as TelegramClientHandle);
  }
}
