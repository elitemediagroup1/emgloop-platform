// Which executor this is, and how it keeps each promise Brain requires. Slice B6.
//
// Architecture: docs/architecture/brain-aws-foundation.md §2 (the record for this revision),
// brain-execution-infrastructure.md §7-§8 (the design it implements).
//
// THE REVISION. B3 replaced the B0 proposal (a hosted durable-function engine) with a
// Loop-owned step runner: stateless Lambda workers driven by two SQS queues and a
// scheduled sweeper, with Neon as the only workflow state. This package is that runner,
// revision 1. It changes only by a reviewed PR that bumps this constant.
//
// DARK ONLY. Revision 1 runs no provider. Its plan exercises every executor obligation
// that does not need a model, and it never commits a result: with no model output and
// no owner gate there is nothing a governed authority could accept.

import { BRAIN_EXECUTOR_OBLIGATIONS } from '@emgloop/shared';

export const BRAIN_EXECUTOR_REVISION = 'loop-step-runner.r1';

/** How the runner treats model steps. LIVE arrives with provider activation (B7), not before. */
export const BRAIN_EXECUTION_MODES = ['DARK'] as const;
export type BrainExecutionMode = (typeof BRAIN_EXECUTION_MODES)[number];

/**
 * Where each B2 obligation is kept in this revision. A test requires an entry for every
 * obligation, so a new obligation cannot be added without saying how it is honoured.
 */
export const BRAIN_EXECUTOR_OBLIGATION_EVIDENCE: Readonly<Record<string, string>> = Object.freeze({
  DETACHED: 'Work is carried by stored commands and queue messages; no request, session or device is referenced after acceptance (dispatcher.ts, worker.ts).',
  IDEMPOTENT_START: 'The dispatcher queues only EXECUTE dispositions; a duplicate message finds the job terminal, its lease held, or its steps already checkpointed (dispatcher.ts, worker.ts).',
  REFERENCES_ONLY: 'Queue messages are parseBrainAdvanceMessage references; organization, principal and input are re-read from Neon on every delivery (worker.ts).',
  CHECKPOINT_FIRST: 'Every step consults brainStepResumeDecision before running and returns its sealed checkpoint when one exists (worker.ts runStep).',
  PAID_AT_MOST_ONCE_PER_ATTEMPT: 'Revision 1 makes no paid call: DARK mode has no MODEL_CALL step, and the bundle contains no provider client (infra/brain bundle scan).',
  BOUNDED_RETRY: 'A failed step is retried only by brainStepRetryDecision against its policy, with a delayed CONTINUE message (worker.ts).',
  RECHECK_AT_BOUNDARIES: 'Access is re-decided through Loop and checked with brainBoundaryRefusals, and stored controls are read, before the commit boundary (worker.ts).',
  WAIT_WITHOUT_RUNNING: 'A question releases the lease and sends nothing; only a RESUME command for a recorded reply, or the sweeper TIMER, wakes the job (worker.ts, sweeper.ts).',
  CANCEL_AT_BOUNDARY: 'The job record is re-read before every step; a cancel request settles the job there (worker.ts).',
  LOOP_IS_AUTHORITY: 'The runner keeps no state between deliveries; every decision starts from the job record and its lease (worker.ts).',
  NO_CONTENT_OUTSIDE_LOOP: 'Step outputs are sealed into Loop checkpoints; logs carry identifiers and codes only (log.ts).',
  RESULTS_THROUGH_OWNERS: 'The runner never writes an artifact. Revision 1 never calls COMMIT_RESULT; it ends at the commit boundary with COMMIT_REFUSED (worker.ts).',
});

export function brainExecutorObligationsWithoutEvidence(): string[] {
  return BRAIN_EXECUTOR_OBLIGATIONS.map((o) => o.id).filter((id) => !BRAIN_EXECUTOR_OBLIGATION_EVIDENCE[id]);
}
