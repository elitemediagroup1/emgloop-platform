// What any durable executor must do for Brain, and nothing about how. Slice B2.
//
// Architecture: docs/architecture/brain-execution-architecture.md §3, §8, §9.
//
// THE EXECUTOR IS RENTED; THE JOB IS LOOP'S. An executor schedules steps, retries them
// within their policy, waits without holding anything running, and wakes the job when
// told. It receives a job REFERENCE and nothing else, reads everything it needs from
// Loop's records at each step, and keeps no content of its own. When its state and
// Loop's job record disagree, Loop's record wins.
//
// Each obligation below is a conformance test the first real executor adapter must pass
// before it may run a job. Which service provides the executor is a later decision
// recorded elsewhere, and deliberately absent from this contract.
//
// PURE.

/** A job as an executor sees it. No organization, no principal, no input, no content. */
export interface BrainJobRef {
  readonly jobId: string;
  readonly generation: number;
}

export type BrainExecutorAck =
  | { readonly accepted: true; readonly executionRef: string; readonly duplicate: boolean }
  | { readonly accepted: false; readonly reason: 'UNKNOWN_JOB' | 'NOT_ACCEPTING' | 'UNAVAILABLE' };

export interface BrainExecutorPort {
  /** Begin executing an ACCEPTED job. Idempotent per job generation. */
  start(ref: BrainJobRef): Promise<BrainExecutorAck>;
  /** Wake a job waiting for a person, once the reply is recorded in Loop. */
  resume(ref: BrainJobRef, waitId: string): Promise<BrainExecutorAck>;
  /** Stop a job at its next step boundary. */
  cancel(ref: BrainJobRef): Promise<BrainExecutorAck>;
}

export interface BrainExecutorObligation {
  readonly id: string;
  readonly rule: string;
}

export const BRAIN_EXECUTOR_OBLIGATIONS: readonly BrainExecutorObligation[] = Object.freeze([
  obligation('DETACHED', "Once start is acknowledged, completion never depends on the submitter's device, connection, session or request."),
  obligation('IDEMPOTENT_START', 'Starting the same job generation twice runs it once; the second acknowledgement says it was a duplicate.'),
  obligation('REFERENCES_ONLY', "The executor is handed a job reference only. Organization, principal, input and content are read from Loop's records at each step."),
  obligation('CHECKPOINT_FIRST', "A step whose Loop checkpoint exists is never executed again, and its provider is never called again."),
  obligation('PAID_AT_MOST_ONCE_PER_ATTEMPT', 'A model call runs at most once per attempt; a reserved call whose result was lost counts as spent, and another attempt happens only within the paid-attempt limit.'),
  obligation('BOUNDED_RETRY', "Each step retries only the failure classes its policy names, and never beyond its attempt limit."),
  obligation('RECHECK_AT_BOUNDARIES', "Access, activation controls and budget are re-decided from Loop's records before every model call and every result commit."),
  obligation('WAIT_WITHOUT_RUNNING', 'WAITING_FOR_USER holds nothing running, and resumes only through resume() after the reply is recorded in Loop.'),
  obligation('CANCEL_AT_BOUNDARY', 'Cancel stops the job at its next step boundary; work already in flight is reconciled, and its result is kept but never applied.'),
  obligation('LOOP_IS_AUTHORITY', "The executor's own state is disposable. Where it disagrees with Loop's job record, Loop's record wins."),
  obligation('NO_CONTENT_OUTSIDE_LOOP', "Step outputs are stored in Loop's checkpoints; the executor holds references to them, not copies."),
  obligation('RESULTS_THROUGH_OWNERS', 'A result reaches Loop only through its owning authority, after the commit check; the executor never writes an artifact itself.'),
]);

function obligation(id: string, rule: string): BrainExecutorObligation {
  return Object.freeze({ id, rule });
}

type BrainExecutorMustBeTrue<T extends true> = T;

/** Compile-time: an executor is handed a job id and a generation, and nothing more. */
export type BrainJobRefIsReferenceOnly = BrainExecutorMustBeTrue<
  Exclude<keyof BrainJobRef, 'jobId' | 'generation'> extends never ? true : false
>;
