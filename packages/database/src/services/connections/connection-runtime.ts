// The worker's per-connection cycle, as a PURE-ish orchestrator: given one connection, its
// adapter and its last cursor, run one observation and return the new cursor, the truthful
// connection state, and counts. All provider I/O is behind the adapter; this holds the
// error/health/reconnect policy so the worker process stays thin and testable.
import { deriveConnectionState, type CapabilityStatus, type ConnectionState, type ConversationEvent } from '@emgloop/shared';
import type { ConnectionAdapter } from './connection-adapter';

export type CycleFailure = 'AUTH' | 'TRANSIENT';

export interface ConnectionCycleInput {
  readonly organizationId: string;
  readonly userId: string;
  readonly cursor: string | null;
  /** Provided by the caller after unsealing; never logged. */
  readonly secret: string;
}

export interface ConnectionCycleResult {
  readonly state: ConnectionState;
  readonly cursor: string | null;
  readonly observed: number;
  readonly failure: CycleFailure | null;
  /** Whether background observation was operational this cycle, for the worker to record faithfully. */
  readonly backgroundObservation: CapabilityStatus;
  /**
   * The content-free observations from this cycle, oldest first (empty on any failure). The worker
   * hands these to its observation sink BEFORE it records the advanced cursor, so a cursor never
   * moves past an observation the sink did not accept.
   */
  readonly events: readonly ConversationEvent[];
}

/** Classify a thrown error into auth (reconnect) vs transient (retry). Message never surfaced. */
function classify(err: unknown): CycleFailure {
  const name = err instanceof Error ? err.name : '';
  return /auth|unauthor|forbidden|login|session/i.test(name) ? 'AUTH' : 'TRANSIENT';
}

/**
 * Run one cycle for one connection. Never throws: a failure becomes a truthful state
 * (RECONNECT_REQUIRED for auth loss, FAILED for a transient error) so the card can tell the
 * truth. A successful cycle whose background capability is not operational is CONNECTED_LIMITED,
 * not READY -- authentication alone is never READY.
 */
export async function runConnectionCycle(
  adapter: ConnectionAdapter,
  input: ConnectionCycleInput,
  now: Date,
): Promise<ConnectionCycleResult> {
  let session;
  try {
    session = await adapter.resume(input.secret, { organizationId: input.organizationId, userId: input.userId });
  } catch (err) {
    // A stored credential EXISTS (we were resuming it); an auth failure means it went stale
    // -> RECONNECT_REQUIRED, not NOT_CONNECTED. A transient resume error -> FAILED.
    const failure = classify(err);
    return {
      state: deriveConnectionState({ authenticated: true, backgroundObservation: 'UNAVAILABLE', reconnectRequired: failure === 'AUTH', failed: failure !== 'AUTH', disconnected: false }),
      cursor: input.cursor,
      observed: 0,
      failure,
      backgroundObservation: 'UNAVAILABLE',
      events: [],
    };
  }
  try {
    const result = await adapter.observe(session, input.cursor, now);
    return {
      state: deriveConnectionState({ authenticated: true, backgroundObservation: result.backgroundObservation, reconnectRequired: false, failed: false, disconnected: false }),
      cursor: result.cursor ?? input.cursor,
      observed: result.events.length,
      failure: null,
      backgroundObservation: result.backgroundObservation,
      events: result.events,
    };
  } catch (err) {
    const failure = classify(err);
    return {
      state: deriveConnectionState({ authenticated: true, backgroundObservation: 'UNAVAILABLE', reconnectRequired: failure === 'AUTH', failed: failure !== 'AUTH', disconnected: false }),
      cursor: input.cursor,
      observed: 0,
      failure,
      backgroundObservation: 'UNAVAILABLE',
      events: [],
    };
  } finally {
    await adapter.disconnect(session).catch(() => undefined);
  }
}
