// The worker's observation sweep: OBSERVE -> NORMALIZE -> (hand to) INTELLIGENCE. PURE-ish.
//
// One process serves every tenant. Each sweep asks the repository which connections are due (a
// platform-wide discovery, routing fields only), and for each: picks the provider's adapter, opens
// the sealed credential, runs one cycle (runConnectionCycle holds the error/health/reconnect
// policy), hands the content-free observations to the sink, and records the result.
//
// THE CURSOR NEVER OUTRUNS THE SINK. Observations go to the sink BEFORE the advanced cursor is
// recorded; if the sink cannot accept them, the cursor holds and the next sweep re-observes (the
// sink is idempotent on providerEventId). This is the "do not prematurely throw away what Loop has
// not yet understood" rule, made mechanical.
//
// NOT A CLIENT. The sweep only observes and normalizes; turning observations into cross-source
// intelligence is a downstream consumer of the sink, not this loop. Everything provider-specific is
// behind an adapter; everything tenant-scoped is re-resolved by (org, user, provider).

import { runConnectionCycle, type ConnectionAdapter, type DueConnection } from '@emgloop/database';
import type { CapabilityStatus, ConnectionProvider, ConnectionState, ConversationEvent } from '@emgloop/shared';

/** Where a sweep sends the content-free observations it made. Must be idempotent on providerEventId. */
export interface ObservationSink {
  accept(connection: DueConnection, events: readonly ConversationEvent[]): Promise<void>;
}

export interface SweepPorts {
  /** Connections worth a cycle now (platform-wide; routing fields only). */
  due(): Promise<readonly DueConnection[]>;
  /** The adapter for a provider, or null when this deployment has none wired. */
  adapterFor(provider: ConnectionProvider): ConnectionAdapter | null;
  /** Open the sealed credential for one connection; null when none is held or it will not open. */
  openCredential(connection: DueConnection): Promise<string | null>;
  /** Persist one cycle's outcome (state, cursor, health). */
  recordCycle(
    connection: DueConnection,
    outcome: { state: ConnectionState; backgroundObservation: CapabilityStatus; cursor: string | null; failureClass: string | null },
  ): Promise<void>;
  sink: ObservationSink;
  now(): Date;
}

export interface SweepSummary {
  readonly due: number;
  readonly cycled: number;
  readonly skipped: number;
  readonly sinkFailures: number;
}

/** Run one observation sweep over all due connections. Never throws for a single connection. */
export async function runObservationSweep(ports: SweepPorts): Promise<SweepSummary> {
  const due = await ports.due();
  let cycled = 0;
  let skipped = 0;
  let sinkFailures = 0;

  for (const connection of due) {
    const adapter = ports.adapterFor(connection.provider);
    if (!adapter) {
      // No adapter wired for this provider in this deployment: leave it untouched, do not fabricate.
      skipped += 1;
      continue;
    }
    const secret = await ports.openCredential(connection);
    if (secret === null) {
      // The credential vanished or will not open between discovery and now: skip, do not guess.
      skipped += 1;
      continue;
    }

    const result = await runConnectionCycle(
      adapter,
      { organizationId: connection.organizationId, userId: connection.userId, cursor: connection.cursor, secret },
      ports.now(),
    );

    // Sink first, cursor second: never advance past observations the sink did not accept.
    let cursorToRecord = connection.cursor;
    let sinkFailureClass: string | null = result.failure;
    if (result.events.length > 0) {
      try {
        await ports.sink.accept(connection, result.events);
        cursorToRecord = result.cursor;
      } catch {
        sinkFailures += 1;
        sinkFailureClass = 'SINK_UNAVAILABLE';
      }
    } else {
      cursorToRecord = result.cursor;
    }

    await ports.recordCycle(connection, {
      state: result.state,
      backgroundObservation: result.backgroundObservation,
      cursor: cursorToRecord,
      failureClass: sinkFailureClass,
    });
    cycled += 1;
  }

  return { due: due.length, cycled, skipped, sinkFailures };
}
