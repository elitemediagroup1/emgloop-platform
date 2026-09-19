// The provider-neutral adapter interface every connection source implements. The worker and
// the Loop backend depend on THIS, never on Graph/MTProto/Teams specifics. Each provider
// (Microsoft Teams Graph, Microsoft Teams interactive-session, Telegram MTProto) ships an
// implementation; the worker treats them identically.
//
// Auth INITIATION is provider-specific and lives outside this interface (an OAuth redirect,
// an MTProto phone-code exchange, an interactive browser sign-in). What the worker needs is
// uniform: resume an authorized session from sealed material, observe incrementally, report
// health, and disconnect.
import type { CapabilityStatus, ConnectionProvider } from '@emgloop/shared';
import type { ConversationEvent } from '@emgloop/shared';

/** An opened, in-memory authorized session. Never serialized to logs or the AI. */
export interface AdapterSession {
  readonly provider: ConnectionProvider;
  /** Opaque handle the adapter uses internally (socket, client, browser context). */
  readonly handle: unknown;
}

export interface ObservationResult {
  /** New, content-free observations since `cursor`, oldest first. */
  readonly events: readonly ConversationEvent[];
  /** The checkpoint to pass next time; null if unchanged. */
  readonly cursor: string | null;
  /** Whether background observation is actually operational right now. */
  readonly backgroundObservation: CapabilityStatus;
}

export interface ConnectionAdapter {
  readonly provider: ConnectionProvider;
  /** Open an authorized session from the (already-unsealed) secret. Throws on auth failure. */
  resume(secret: string, binding: { organizationId: string; userId: string }): Promise<AdapterSession>;
  /** One incremental observation cycle. Reads only metadata; never message content into Loop. */
  observe(session: AdapterSession, cursor: string | null, now: Date): Promise<ObservationResult>;
  /** Close the session and release the socket/browser. Never modifies the provider account. */
  disconnect(session: AdapterSession): Promise<void>;
}
