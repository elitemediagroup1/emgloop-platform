// The sweeper: find work whose wakeup was lost, and hand it on. Slice B6.
//
// Architecture: brain-execution-infrastructure.md §6 (step 7) and §7.
//
// READS ONLY, HANDS ON. The sweeper's database role can read Brain state and nothing else
// (scripts/operations/brain-database-roles.sql). It finds:
//   - commands never dispatched (a lost or unconfigured ring)  -> the dispatcher, which
//     alone records a dispatch;
//   - questions past their expiry                              -> a TIMER message;
//   - leases whose holder stopped renewing                      -> a RECOVERY message.
// Every hand-over is a reference; the dispatcher and worker re-read and decide.

import type { BrainLogger } from './log';
import type { BrainDispatcherInvoker, BrainSweeperReferences, BrainWorkQueues } from './ports';

/** A ring gets this long to arrive before the sweeper stands in for it. */
export const BRAIN_RING_GRACE_MS = 15_000;

export interface BrainSweepSummary {
  readonly recovered: number;
  readonly timers: number;
  readonly takeovers: number;
  readonly errors: number;
}

export async function sweep(deps: {
  readonly refs: BrainSweeperReferences;
  readonly dispatcher: BrainDispatcherInvoker;
  readonly queues: BrainWorkQueues;
  readonly now: () => Date;
  readonly log: BrainLogger;
  readonly limit?: number;
}): Promise<BrainSweepSummary> {
  const now = deps.now();
  const limit = deps.limit ?? 100;
  let recovered = 0;
  let timers = 0;
  let takeovers = 0;
  let errors = 0;

  for (const lost of await deps.refs.undispatchedCommands(new Date(now.getTime() - BRAIN_RING_GRACE_MS), limit)) {
    try {
      await deps.dispatcher.recover(lost.commandId);
      recovered += 1;
    } catch {
      errors += 1;
      deps.log.error('sweeper.recover_failed', { commandId: lost.commandId, jobId: lost.jobId, organizationId: lost.organizationId });
    }
  }

  for (const wait of await deps.refs.expiredWaits(now, limit)) {
    try {
      const job = await deps.refs.locateJob(wait.jobId);
      if (!job) continue;
      await deps.queues.send('DURABLE', { jobId: job.jobId, generation: job.generation, reason: 'TIMER', commandId: null });
      timers += 1;
    } catch {
      errors += 1;
      deps.log.error('sweeper.timer_failed', { jobId: wait.jobId, waitId: wait.waitId, organizationId: wait.organizationId });
    }
  }

  for (const stale of await deps.refs.staleLeases(now, limit)) {
    try {
      await deps.queues.send('DURABLE', { jobId: stale.jobId, generation: stale.generation, reason: 'RECOVERY', commandId: null });
      takeovers += 1;
    } catch {
      errors += 1;
      deps.log.error('sweeper.takeover_failed', { jobId: stale.jobId, organizationId: stale.organizationId });
    }
  }

  const summary = { recovered, timers, takeovers, errors };
  deps.log.info('sweeper.done', { count: recovered + timers + takeovers, outcome: errors > 0 ? 'PARTIAL' : 'OK' });
  deps.log.metric('SweeperRecovered', recovered);
  deps.log.metric('SweeperTimers', timers);
  deps.log.metric('SweeperTakeovers', takeovers);
  if (errors > 0) deps.log.metric('SweeperErrors', errors);
  return summary;
}
