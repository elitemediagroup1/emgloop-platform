// How Brain work executes: the two execution classes. Slice B2.
//
// Architecture: docs/architecture/brain-execution-architecture.md §4.
//
// EXECUTION CLASS IS NOT RESULT TYPE, AND NOT CAPABILITY. INTERACTIVE and DURABLE say
// how the work runs. What the output means (brain-result.ts) and which capability it
// needs (capability.ts) are separate declarations on the task, and none of the three
// is derived from another: a durable job may draft a message, and an interactive one
// may analyse a Case.
//
// BOTH CLASSES RUN THE SAME WAY. An interactive job is still a job: it is accepted,
// recorded and executed without the requester's connection, then watched. What
// differs is the latency the task promises, what a surface shows while it runs, and
// that only durable work may stop to ask a person something.
//
// A HOSTING LIMIT IS NOT THE PRODUCT CONTRACT. Nothing here mentions how long any
// particular platform lets a request live. A task declares how long it may run
// interactively; when that is not enough, the job is PROMOTED to durable if the task
// supports it, and fails with a named reason if not -- it is never simply cut off by
// whatever happens to be hosting it.
//
// PURE. Elapsed times are supplied by the caller, measured by Loop's clock.

import type { BrainResultType } from './brain-result';

export const BRAIN_EXECUTION_CLASSES = ['INTERACTIVE', 'DURABLE'] as const;
export type BrainExecutionClass = (typeof BRAIN_EXECUTION_CLASSES)[number];

/**
 * What a surface may show while interactive work runs.
 *   NONE              the result appears whole when it is ready;
 *   PROGRESS          named steps as they complete;
 *   PROVISIONAL_TEXT  text before it is validated, for result types Product has
 *                     approved for that (none yet).
 */
export const BRAIN_INTERACTIVE_STREAMING = ['NONE', 'PROGRESS', 'PROVISIONAL_TEXT'] as const;
export type BrainInteractiveStreaming = (typeof BRAIN_INTERACTIVE_STREAMING)[number];

/**
 * The result types whose unvalidated text may be shown while it is produced. Empty:
 * an answer that breaks its contract is refused whole, so showing it early would
 * show text Loop may reject. Adding a type here is a Product decision.
 */
export const BRAIN_PROVISIONAL_TEXT_RESULT_TYPES: readonly BrainResultType[] = Object.freeze([]);

export interface BrainInteractiveEnvelope {
  /**
   * How long the requester is expected to watch in place before the surface shows the
   * job as working in the background. Presentation only: the job does not change.
   */
  readonly presentationBudgetMs: number;
  /**
   * How long the job may run as INTERACTIVE, excluding nothing. When it is reached the
   * job is promoted if the task supports DURABLE, and fails with DEADLINE_EXCEEDED if
   * it does not.
   */
  readonly executionDeadlineMs: number;
  readonly streaming: BrainInteractiveStreaming;
}

export interface BrainDurableEnvelope {
  /** How long the job may run in total, not counting time spent waiting for a person. */
  readonly executionDeadlineMs: number;
  /** How long one wait for a person may last. Null: the task never asks. */
  readonly maxUserWaitMs: number | null;
}

/** How a task may execute. Declared by the task, never chosen by the caller's connection. */
export interface BrainExecutionContract {
  readonly classes: readonly BrainExecutionClass[];
  readonly interactive: BrainInteractiveEnvelope | null;
  readonly durable: BrainDurableEnvelope | null;
}

export const BRAIN_EXECUTION_CONTRACT_VIOLATIONS = [
  'NO_EXECUTION_CLASS',
  'UNKNOWN_EXECUTION_CLASS',
  'INTERACTIVE_ENVELOPE_MISSING',
  'DURABLE_ENVELOPE_MISSING',
  'ENVELOPE_WITHOUT_CLASS',
  'LIMIT_NOT_POSITIVE',
  'PRESENTATION_BUDGET_EXCEEDS_DEADLINE',
  'PROVISIONAL_TEXT_NOT_APPROVED',
] as const;
export type BrainExecutionContractViolation = (typeof BRAIN_EXECUTION_CONTRACT_VIOLATIONS)[number];

function positive(value: number | null | undefined): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/** Everything wrong with a task's execution contract. Empty means it is coherent. */
export function brainExecutionContractViolations(
  contract: BrainExecutionContract,
  resultType: BrainResultType,
): BrainExecutionContractViolation[] {
  const out: BrainExecutionContractViolation[] = [];
  if (contract.classes.length === 0) out.push('NO_EXECUTION_CLASS');
  if (contract.classes.some((c) => !(BRAIN_EXECUTION_CLASSES as readonly string[]).includes(c))) out.push('UNKNOWN_EXECUTION_CLASS');
  const interactive = contract.classes.includes('INTERACTIVE');
  const durable = contract.classes.includes('DURABLE');
  if (interactive && !contract.interactive) out.push('INTERACTIVE_ENVELOPE_MISSING');
  if (durable && !contract.durable) out.push('DURABLE_ENVELOPE_MISSING');
  if ((!interactive && contract.interactive) || (!durable && contract.durable)) out.push('ENVELOPE_WITHOUT_CLASS');
  if (contract.interactive) {
    const e = contract.interactive;
    if (!positive(e.presentationBudgetMs) || !positive(e.executionDeadlineMs)) out.push('LIMIT_NOT_POSITIVE');
    else if (e.presentationBudgetMs > e.executionDeadlineMs) out.push('PRESENTATION_BUDGET_EXCEEDS_DEADLINE');
    if (e.streaming === 'PROVISIONAL_TEXT' && !BRAIN_PROVISIONAL_TEXT_RESULT_TYPES.includes(resultType)) {
      out.push('PROVISIONAL_TEXT_NOT_APPROVED');
    }
  }
  if (contract.durable) {
    const e = contract.durable;
    if (!positive(e.executionDeadlineMs) || (e.maxUserWaitMs !== null && !positive(e.maxUserWaitMs))) out.push('LIMIT_NOT_POSITIVE');
  }
  return [...new Set(out)];
}

/** Whether a job of this task may stop and ask a person, given how it is executing now. */
export function brainMayWaitForUser(contract: BrainExecutionContract, executionClass: BrainExecutionClass): boolean {
  return executionClass === 'DURABLE' && contract.durable !== null && contract.durable.maxUserWaitMs !== null;
}

export type BrainDeadlineDecision =
  | { readonly action: 'CONTINUE' }
  | { readonly action: 'PROMOTE' }
  | { readonly action: 'FAIL'; readonly reason: 'DEADLINE_EXCEEDED' };

/**
 * What happens at a step boundary given how long the job has been running in its
 * current class. `elapsedMs` excludes time spent waiting for a person.
 *
 * An interactive job that has used its time is PROMOTED when the task supports
 * durable execution -- the same job, its completed steps kept -- and fails with a
 * named reason when it does not. A durable job past its deadline fails.
 */
export function brainDeadlineDecision(input: {
  readonly contract: BrainExecutionContract;
  readonly executionClass: BrainExecutionClass;
  readonly elapsedMs: number;
}): BrainDeadlineDecision {
  const { contract, executionClass, elapsedMs } = input;
  if (executionClass === 'INTERACTIVE') {
    const deadline = contract.interactive?.executionDeadlineMs;
    if (positive(deadline) && elapsedMs < (deadline as number)) return { action: 'CONTINUE' };
    if (contract.classes.includes('DURABLE') && contract.durable) return { action: 'PROMOTE' };
    return { action: 'FAIL', reason: 'DEADLINE_EXCEEDED' };
  }
  const deadline = contract.durable?.executionDeadlineMs;
  if (positive(deadline) && elapsedMs < (deadline as number)) return { action: 'CONTINUE' };
  return { action: 'FAIL', reason: 'DEADLINE_EXCEEDED' };
}

/**
 * How a surface presents interactive work: in place, or as running in the background.
 * Pure presentation. The job neither knows nor cares whether anyone is watching.
 */
export function brainPresentation(envelope: BrainInteractiveEnvelope | null, elapsedMs: number): 'IN_PLACE' | 'BACKGROUND' {
  if (!envelope || !positive(envelope.presentationBudgetMs)) return 'BACKGROUND';
  return elapsedMs < envelope.presentationBudgetMs ? 'IN_PLACE' : 'BACKGROUND';
}
