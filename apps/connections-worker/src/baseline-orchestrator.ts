// The worker's HISTORICAL BASELINE sweep: walk each due connection's past BACKWARD to an
// employee-chosen floor, landing the SAME content-free observations the live sweep does. COMPLETELY
// INDEPENDENT of the live observation sweep: it advances only the baseline CHECKPOINT and NEVER writes
// the live observation cursor (SourceConnection.cursor). That independence is the whole point.
//
// SINK BEFORE CHECKPOINT. A page's observations go to the sink BEFORE the checkpoint advances; if the
// sink cannot accept them, the checkpoint HOLDS and the next sweep re-pages (the sink is idempotent on
// providerEventId, so no row is duplicated). This is the same "never throw away what Loop has not yet
// stored" rule the live sweep follows, applied to the backward walk.
//
// BOUNDED AND CONVERGENT. Each page moves strictly backward (a lower offset) and stops at the floor;
// a short page means the floor (or the end of history) is reached -> COMPLETE. A FLOOD_WAIT sets a
// backoff and holds. It never throws for a single connection.

import type { AdapterSession, DueBaseline, DueConnection } from '@emgloop/database';
import { deriveBaselineState, type BaselineState, type ConnectionProvider, type ConversationEvent } from '@emgloop/shared';

import type { ObservationSink } from './orchestrator';

const DAY_MS = 24 * 60 * 60 * 1000;

/** What one backward history page produced. Content-free: events + offsets, never message content. */
export interface BaselineObservationResult {
  /** New, content-free observations within the window, from this page. */
  readonly events: readonly ConversationEvent[];
  /** The next BACKWARD offset (checkpoint), strictly older than the last; NEVER the live cursor. */
  readonly nextCursor: string | null;
  /** The oldest occurredAt this page reached, as an ISO instant, or null when the page was empty. */
  readonly oldestReachedAt: string | null;
  /** True when the floor (or the end of history) has been reached: the walk is complete. */
  readonly reachedFloor: boolean;
  /** Present when Telegram asked Loop to wait: the checkpoint holds and backs off for this long. */
  readonly floodWaitSeconds?: number;
}

/** The adapter capability the baseline needs. TelegramAdapter satisfies this structurally. */
export interface BaselineAdapter {
  readonly provider: ConnectionProvider;
  resume(secret: string, binding: { organizationId: string; userId: string }): Promise<AdapterSession>;
  observeHistory(
    session: AdapterSession,
    opts: { readonly checkpointCursor: string | null; readonly windowFloorAt: Date; readonly pageSize: number },
    now: Date,
  ): Promise<BaselineObservationResult>;
  disconnect(session: AdapterSession): Promise<void>;
}

/** What one baseline run records. NEVER carries the live observation cursor. */
export interface BaselineProgressToRecord {
  readonly checkpointCursor: string | null;
  readonly oldestReachedAt: Date | null;
  readonly state: BaselineState;
  readonly failureClass: string | null;
  readonly backoffUntil: Date | null;
  readonly now: Date;
}

export interface BaselinePorts {
  /** Baselines worth a run now (platform-wide; routing fields only). */
  dueForBaseline(): Promise<readonly DueBaseline[]>;
  /** The adapter for a provider, or null when this deployment has none wired. */
  adapterFor(provider: ConnectionProvider): BaselineAdapter | null;
  /** Open the sealed credential for one baseline's connection; null when none is held or it will not open. */
  openCredential(due: DueBaseline): Promise<string | null>;
  /** The SAME content-free sink the live sweep uses -- idempotent on providerEventId. */
  sink: ObservationSink;
  /** Advance (or hold) the checkpoint. MUST NOT touch source_connections. */
  recordBaselineProgress(due: DueBaseline, progress: BaselineProgressToRecord): Promise<void>;
  /** Hard ceiling on how far back any walk may go, whatever a checkpoint says. */
  readonly maxWindowDays: number;
  /** How many facts one page fetches. */
  readonly pageSize: number;
  now(): Date;
}

export interface BaselineSweepSummary {
  readonly due: number;
  readonly advanced: number;
  readonly skipped: number;
  readonly held: number;
  readonly sinkFailures: number;
  readonly floodWaits: number;
}

/** A baseline's connection, in the shape the shared observation sink accepts. cursor is always null here. */
function sinkConnectionOf(due: DueBaseline): DueConnection {
  return { organizationId: due.organizationId, userId: due.userId, provider: due.provider, cursor: null };
}

/** Run one baseline sweep over all due checkpoints. Never throws for a single connection. */
export async function runBaselineSweep(ports: BaselinePorts): Promise<BaselineSweepSummary> {
  const due = await ports.dueForBaseline();
  const now = ports.now();
  const maxWindowMs = Math.max(1, ports.maxWindowDays) * DAY_MS;
  let advanced = 0;
  let skipped = 0;
  let held = 0;
  let sinkFailures = 0;
  let floodWaits = 0;

  for (const item of due) {
    try {
      const adapter = ports.adapterFor(item.provider);
      if (!adapter) {
        // No adapter wired for this provider in this deployment: leave it untouched, do not fabricate.
        skipped += 1;
        continue;
      }
      const secret = await ports.openCredential(item);
      if (secret === null) {
        // No live, openable credential (liveness is enforced here, exactly like the live sweep): skip.
        skipped += 1;
        continue;
      }

      let session: AdapterSession;
      try {
        session = await adapter.resume(secret, { organizationId: item.organizationId, userId: item.userId });
      } catch {
        // The session would not resume: hold the checkpoint, do not advance, try again next sweep.
        await ports.recordBaselineProgress(item, hold(item, 'AUTH', null, now));
        held += 1;
        continue;
      }

      let result: BaselineObservationResult;
      try {
        // Clamp the floor to the hard ceiling: even a corrupted checkpoint cannot walk beyond it.
        const effectiveFloor = new Date(Math.max(item.windowFloorAt.getTime(), now.getTime() - maxWindowMs));
        result = await adapter.observeHistory(
          session,
          { checkpointCursor: item.checkpointCursor, windowFloorAt: effectiveFloor, pageSize: ports.pageSize },
          now,
        );
      } catch {
        await ports.recordBaselineProgress(item, hold(item, 'TRANSIENT', null, now));
        held += 1;
        await adapter.disconnect(session).catch(() => undefined);
        continue;
      }
      await adapter.disconnect(session).catch(() => undefined);

      if (result.floodWaitSeconds !== undefined) {
        // Telegram asked Loop to wait: hold the checkpoint and back off. No cursor movement.
        const backoffUntil = new Date(now.getTime() + Math.max(0, result.floodWaitSeconds) * 1000);
        await ports.recordBaselineProgress(item, hold(item, 'FLOOD_WAIT', backoffUntil, now));
        held += 1;
        floodWaits += 1;
        continue;
      }

      // SINK BEFORE CHECKPOINT: never advance past observations the sink did not accept.
      if (result.events.length > 0) {
        try {
          await ports.sink.accept(sinkConnectionOf(item), result.events);
        } catch {
          await ports.recordBaselineProgress(item, hold(item, 'SINK_UNAVAILABLE', null, now));
          held += 1;
          sinkFailures += 1;
          continue;
        }
      }

      const state = deriveBaselineState({ revoked: false, reachedFloor: result.reachedFloor, hasStarted: true });
      await ports.recordBaselineProgress(item, {
        checkpointCursor: result.nextCursor,
        oldestReachedAt: result.oldestReachedAt ? new Date(result.oldestReachedAt) : null,
        state,
        failureClass: null,
        backoffUntil: null,
        now,
      });
      advanced += 1;
    } catch {
      // A single connection's unexpected error never breaks the sweep.
      held += 1;
    }
  }

  return { due: due.length, advanced, skipped, held, sinkFailures, floodWaits };
}

/** A progress record that HOLDS the checkpoint where it is (never advances the offset). */
function hold(item: DueBaseline, failureClass: string, backoffUntil: Date | null, now: Date): BaselineProgressToRecord {
  return { checkpointCursor: item.checkpointCursor, oldestReachedAt: null, state: 'IN_PROGRESS', failureClass, backoffUntil, now };
}
