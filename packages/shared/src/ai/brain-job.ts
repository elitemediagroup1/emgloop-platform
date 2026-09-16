// The Brain job: how accepted work moves from submission to an outcome. Slice B2.
//
// Architecture: docs/architecture/brain-execution-architecture.md §8.
//
// ONCE ACCEPTED, THE WORK NO LONGER NEEDS WHOEVER ASKED. Acceptance is the moment a
// submission is authorized and recorded in Loop's database. From then on nothing the
// submitter's browser, phone, network or request does can move the job: no event in
// this machine describes a connection, and cancelling is an explicit, attributed act.
//
// STATES ARE FACTS, NOT GUESSES. ACCEPTED means recorded and not yet handed to an
// executor; QUEUED means an executor acknowledged it; RUNNING means a step has begun.
// A job stuck in ACCEPTED is a dispatch problem, and one stuck in QUEUED a capacity
// problem -- two different pages at three in the morning, so two states.
//
// TERMINAL MEANS TERMINAL. SUCCEEDED, FAILED and CANCELLED never change again.
// Resuming failed work is a new job that reuses what the old one already paid for.
// SUCCEEDED means the owning authority now holds at least one result; a job that ends
// without one did not succeed.
//
// PROGRESS IS NAMED, NOT INVENTED. A job reports the step it is on and how many steps
// are done. It reports a fraction only when its plan is fixed, because a plan that can
// grow has no honest denominator.
//
// PURE. Instants are supplied by the caller from Loop's clock.

import type { BrainExecutionClass } from './brain-execution';
import { BRAIN_EXECUTION_CLASSES } from './brain-execution';
import type {
  BrainCommitExpectation,
  BrainEventActor,
  BrainJobEventName,
  BrainResultOwner,
  BrainResultRef,
  BrainResultSubjectType,
  BrainResultType,
} from './brain-result';
import { BRAIN_RESULT_SUBJECT_TYPES } from './brain-result';
import type { BrainStepKind } from './brain-step';

export const BRAIN_JOB_STATES = ['ACCEPTED', 'QUEUED', 'RUNNING', 'WAITING_FOR_USER', 'SUCCEEDED', 'FAILED', 'CANCELLED'] as const;
export type BrainJobState = (typeof BRAIN_JOB_STATES)[number];

export const BRAIN_TERMINAL_STATES: readonly BrainJobState[] = Object.freeze(['SUCCEEDED', 'FAILED', 'CANCELLED']);

export function brainJobIsTerminal(state: BrainJobState): boolean {
  return BRAIN_TERMINAL_STATES.includes(state);
}

/** Why a job did not produce its result. Loop's taxonomy, never a provider's prose. */
export const BRAIN_FAILURE_REASONS = [
  'MODEL_REFUSED',
  'OUTPUT_REJECTED',
  'PROVIDER_UNAVAILABLE',
  'PROVIDER_RESULT_LOST',
  'BUDGET_REFUSED',
  'ACCESS_WITHDRAWN',
  'CONTEXT_UNAVAILABLE',
  'RETRIES_EXHAUSTED',
  'DEADLINE_EXCEEDED',
  'COMMIT_REFUSED',
  // B3: the routing policy the step would run under no longer conforms to the provider
  // specialization policy (brain-dispatch.ts `brainRouteGate`).
  'ROUTING_NOT_CONFORMANT',
  'INTERNAL',
] as const;
export type BrainFailureReason = (typeof BRAIN_FAILURE_REASONS)[number];

/** Why a job was stopped. Every one names who or what stopped it; none is "the page closed". */
export const BRAIN_CANCEL_REASONS = ['REQUESTED_BY_PRINCIPAL', 'REQUESTED_BY_ADMINISTRATOR', 'KILL_SWITCH', 'WAIT_EXPIRED'] as const;
export type BrainCancelReason = (typeof BRAIN_CANCEL_REASONS)[number];

export interface BrainCancelRequest {
  readonly actor: BrainEventActor;
  readonly reason: BrainCancelReason;
}

export interface BrainWait {
  readonly waitId: string;
  readonly expiresAtMs: number;
}

/**
 * A job as Loop records it. The executor sees only `jobId` and `generation`.
 *
 * FOUR SEPARATE DECLARATIONS, EACH FIXED OR MOVED ON ITS OWN. `capabilityRoute` (what
 * the work needs), `resultType` with `resultOwner` and `subject` (what it produces and
 * who holds it), and `executionClass` (how it runs, which promotion may change). None
 * is derived from another, and no provider or model is part of the job: those are
 * chosen per call by the routing policy and recorded on each ledger row.
 */
export interface BrainJobSnapshot {
  readonly jobId: string;
  /** Increments when the same job is handed to an executor again after an executor-side loss. */
  readonly generation: number;
  readonly organizationId: string;
  readonly principalUserId: string;
  readonly taskId: string;
  readonly taskVersion: string;
  readonly capabilityRoute: string;
  readonly resultType: BrainResultType;
  /** The authority that will hold the result, as the task version declared it at acceptance. */
  readonly resultOwner: BrainResultOwner;
  readonly subject: { readonly type: BrainResultSubjectType; readonly id: string };
  readonly executionClass: BrainExecutionClass;
  /** True once an interactive job has become durable. It never goes back. */
  readonly promoted: boolean;
  readonly state: BrainJobState;
  readonly cancelRequest: BrainCancelRequest | null;
  readonly wait: BrainWait | null;
  readonly resultRefs: readonly BrainResultRef[];
  readonly endReason: BrainFailureReason | BrainCancelReason | null;
  /** The job this one resumes, reusing its checkpoints. Null for a fresh job. */
  readonly resumesJobId: string | null;
}

/**
 * Everything that can move a job. Each is caused by Loop's executor, a person acting
 * through the Brain API, or a policy. There is no event for a client, a session or a
 * connection, and there must never be one.
 */
export type BrainJobTransitionEvent =
  | { readonly type: 'DISPATCHED' }
  | { readonly type: 'STARTED' }
  | { readonly type: 'PROMOTED' }
  | { readonly type: 'USER_INPUT_REQUESTED'; readonly wait: BrainWait }
  | { readonly type: 'USER_INPUT_RECEIVED'; readonly waitId: string; readonly responderUserId: string }
  | { readonly type: 'WAIT_EXPIRED'; readonly waitId: string }
  | { readonly type: 'CANCEL_REQUESTED'; readonly request: BrainCancelRequest }
  | { readonly type: 'CANCEL_SETTLED' }
  | { readonly type: 'RESULT_COMMITTED'; readonly resultRefs: readonly BrainResultRef[] }
  | { readonly type: 'FAILED'; readonly reason: BrainFailureReason };

export const BRAIN_TRANSITION_EVENT_TYPES = [
  'DISPATCHED',
  'STARTED',
  'PROMOTED',
  'USER_INPUT_REQUESTED',
  'USER_INPUT_RECEIVED',
  'WAIT_EXPIRED',
  'CANCEL_REQUESTED',
  'CANCEL_SETTLED',
  'RESULT_COMMITTED',
  'FAILED',
] as const satisfies readonly BrainJobTransitionEvent['type'][];

export const BRAIN_TRANSITION_REFUSALS = [
  'JOB_IS_TERMINAL',
  'EVENT_NOT_ALLOWED_IN_STATE',
  'INTERACTIVE_CANNOT_WAIT',
  'TASK_NEVER_WAITS',
  'CANCEL_PENDING',
  'WAIT_MISMATCH',
  'RESPONDER_IS_NOT_PRINCIPAL',
  'RESPONDER_NOT_PERMITTED',
  'NO_RESULT',
  'PROMOTION_NOT_SUPPORTED',
  'ALREADY_PROMOTED',
  'NO_CANCEL_REQUESTED',
] as const;
export type BrainTransitionRefusal = (typeof BRAIN_TRANSITION_REFUSALS)[number];

export type BrainTransition =
  | { readonly ok: true; readonly job: BrainJobSnapshot; readonly emits: BrainJobEventName | null }
  | { readonly ok: false; readonly refusal: BrainTransitionRefusal };

/** What the transition needs to know about the task and the moment. All read from Loop. */
export interface BrainTransitionContext {
  /** The task supports DURABLE execution, so an interactive job may be promoted. */
  readonly supportsDurable: boolean;
  /** The task's durable envelope allows asking a person. */
  readonly taskMayWait: boolean;
  /** For USER_INPUT_RECEIVED: the responder's access was re-decided just now and allowed. */
  readonly responderPermitted?: boolean;
}

function ok(job: BrainJobSnapshot, emits: BrainJobEventName | null): BrainTransition {
  return { ok: true, job, emits };
}
function no(refusal: BrainTransitionRefusal): BrainTransition {
  return { ok: false, refusal };
}

/**
 * The one way a job changes state. Anything not listed is refused, so a surprising
 * sequence becomes a visible refusal instead of a quietly corrupted job.
 */
export function brainJobTransition(
  job: BrainJobSnapshot,
  event: BrainJobTransitionEvent,
  context: BrainTransitionContext,
): BrainTransition {
  if (brainJobIsTerminal(job.state)) return no('JOB_IS_TERMINAL');

  switch (event.type) {
    case 'DISPATCHED':
      return job.state === 'ACCEPTED' ? ok({ ...job, state: 'QUEUED' }, null) : no('EVENT_NOT_ALLOWED_IN_STATE');

    case 'STARTED':
      if (job.state !== 'QUEUED') return no('EVENT_NOT_ALLOWED_IN_STATE');
      if (job.cancelRequest) return no('CANCEL_PENDING');
      return ok({ ...job, state: 'RUNNING' }, null);

    case 'PROMOTED':
      if (job.state === 'WAITING_FOR_USER') return no('EVENT_NOT_ALLOWED_IN_STATE');
      if (job.executionClass === 'DURABLE') return no(job.promoted ? 'ALREADY_PROMOTED' : 'EVENT_NOT_ALLOWED_IN_STATE');
      if (!context.supportsDurable) return no('PROMOTION_NOT_SUPPORTED');
      return ok({ ...job, executionClass: 'DURABLE', promoted: true }, 'brain.job.promoted');

    case 'USER_INPUT_REQUESTED':
      if (job.state !== 'RUNNING') return no('EVENT_NOT_ALLOWED_IN_STATE');
      if (job.executionClass !== 'DURABLE') return no('INTERACTIVE_CANNOT_WAIT');
      if (!context.taskMayWait) return no('TASK_NEVER_WAITS');
      if (job.cancelRequest) return no('CANCEL_PENDING');
      return ok({ ...job, state: 'WAITING_FOR_USER', wait: event.wait }, 'brain.job.waiting_for_user');

    case 'USER_INPUT_RECEIVED':
      if (job.state !== 'WAITING_FOR_USER' || !job.wait) return no('EVENT_NOT_ALLOWED_IN_STATE');
      if (event.waitId !== job.wait.waitId) return no('WAIT_MISMATCH');
      if (event.responderUserId !== job.principalUserId) return no('RESPONDER_IS_NOT_PRINCIPAL');
      if (context.responderPermitted !== true) return no('RESPONDER_NOT_PERMITTED');
      return ok({ ...job, state: 'RUNNING', wait: null }, null);

    case 'WAIT_EXPIRED':
      if (job.state !== 'WAITING_FOR_USER' || !job.wait) return no('EVENT_NOT_ALLOWED_IN_STATE');
      if (event.waitId !== job.wait.waitId) return no('WAIT_MISMATCH');
      return ok({ ...job, state: 'CANCELLED', wait: null, endReason: 'WAIT_EXPIRED' }, 'brain.job.cancelled');

    case 'CANCEL_REQUESTED':
      // Nothing is in flight before RUNNING or while waiting, so those stop at once.
      if (job.state === 'ACCEPTED' || job.state === 'QUEUED' || job.state === 'WAITING_FOR_USER') {
        return ok(
          { ...job, state: 'CANCELLED', wait: null, cancelRequest: event.request, endReason: event.request.reason },
          'brain.job.cancelled',
        );
      }
      // A running step may be mid-call. The first request stands; the job stops when it settles.
      return ok(job.cancelRequest ? job : { ...job, cancelRequest: event.request }, null);

    case 'CANCEL_SETTLED':
      if (job.state !== 'RUNNING') return no('EVENT_NOT_ALLOWED_IN_STATE');
      if (!job.cancelRequest) return no('NO_CANCEL_REQUESTED');
      return ok({ ...job, state: 'CANCELLED', endReason: job.cancelRequest.reason }, 'brain.job.cancelled');

    case 'RESULT_COMMITTED':
      if (job.state !== 'RUNNING') return no('EVENT_NOT_ALLOWED_IN_STATE');
      // A result that arrives after somebody asked to stop is kept by its step, never applied.
      if (job.cancelRequest) return no('CANCEL_PENDING');
      if (event.resultRefs.length === 0) return no('NO_RESULT');
      return ok({ ...job, state: 'SUCCEEDED', resultRefs: event.resultRefs, endReason: null }, 'brain.job.succeeded');

    case 'FAILED':
      return ok({ ...job, state: 'FAILED', wait: null, endReason: event.reason }, 'brain.job.failed');
  }
}

// --- Submission -------------------------------------------------------------------------

/**
 * What a caller may ask for. There is no organization, principal or role here: those
 * come from the verified session, and a body that tries to supply them is refused
 * loudly rather than quietly ignored.
 */
export interface BrainSubmission {
  readonly taskId: string;
  readonly subject: { readonly type: BrainResultSubjectType; readonly id: string };
  readonly executionClass: BrainExecutionClass;
  /** Chosen by the caller, unique per (organization, principal, task). */
  readonly idempotencyKey: string;
  /** Task parameters. Scalars only; never authority. */
  readonly input: Readonly<Record<string, string | number | boolean | null>>;
}

const SUBMISSION_FIELDS = ['taskId', 'subject', 'executionClass', 'idempotencyKey', 'input'] as const;

/** Keys that would carry authority if anybody honoured them. Nobody does. */
export const BRAIN_CLIENT_AUTHORITY_KEYS = [
  'organizationId',
  'orgId',
  'organization',
  'tenantId',
  'principal',
  'principalUserId',
  'userId',
  'role',
  'permissions',
] as const;

export const BRAIN_SUBMISSION_PARSE_REFUSALS = [
  'NOT_AN_OBJECT',
  'CLIENT_SUPPLIED_AUTHORITY',
  'UNEXPECTED_FIELD',
  'MISSING_FIELD',
  'INVALID_FIELD',
] as const;
export type BrainSubmissionParseRefusal = (typeof BRAIN_SUBMISSION_PARSE_REFUSALS)[number];

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,128}$/;

export function parseBrainSubmission(
  raw: unknown,
): { readonly ok: true; readonly submission: BrainSubmission } | { readonly ok: false; readonly refusals: readonly BrainSubmissionParseRefusal[] } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, refusals: ['NOT_AN_OBJECT'] };
  const body = raw as Record<string, unknown>;
  const refusals: BrainSubmissionParseRefusal[] = [];
  const keys = Object.keys(body);
  if (keys.some((k) => (BRAIN_CLIENT_AUTHORITY_KEYS as readonly string[]).includes(k))) refusals.push('CLIENT_SUPPLIED_AUTHORITY');
  if (keys.some((k) => !(SUBMISSION_FIELDS as readonly string[]).includes(k) && !(BRAIN_CLIENT_AUTHORITY_KEYS as readonly string[]).includes(k))) {
    refusals.push('UNEXPECTED_FIELD');
  }
  if (SUBMISSION_FIELDS.some((k) => !(k in body))) refusals.push('MISSING_FIELD');

  const subject = body.subject as Record<string, unknown> | undefined;
  const input = body.input as Record<string, unknown> | undefined;
  const validSubject =
    !!subject &&
    typeof subject === 'object' &&
    Object.keys(subject).every((k) => k === 'type' || k === 'id') &&
    (BRAIN_RESULT_SUBJECT_TYPES as readonly unknown[]).includes(subject.type) &&
    typeof subject.id === 'string' &&
    subject.id.length > 0;
  const validInput =
    !!input &&
    typeof input === 'object' &&
    !Array.isArray(input) &&
    Object.values(input).every((v) => v === null || ['string', 'number', 'boolean'].includes(typeof v));
  if (input && typeof input === 'object' && Object.keys(input).some((k) => (BRAIN_CLIENT_AUTHORITY_KEYS as readonly string[]).includes(k))) {
    refusals.push('CLIENT_SUPPLIED_AUTHORITY');
  }
  if (
    typeof body.taskId !== 'string' ||
    body.taskId.length === 0 ||
    !validSubject ||
    !(BRAIN_EXECUTION_CLASSES as readonly unknown[]).includes(body.executionClass) ||
    typeof body.idempotencyKey !== 'string' ||
    !IDEMPOTENCY_KEY.test(body.idempotencyKey) ||
    !validInput
  ) {
    if (!refusals.includes('MISSING_FIELD')) refusals.push('INVALID_FIELD');
  }
  if (refusals.length > 0) return { ok: false, refusals: [...new Set(refusals)] };
  return {
    ok: true,
    submission: {
      taskId: body.taskId as string,
      subject: { type: subject!.type as BrainResultSubjectType, id: subject!.id as string },
      executionClass: body.executionClass as BrainExecutionClass,
      idempotencyKey: body.idempotencyKey as string,
      input: { ...(input as Record<string, string | number | boolean | null>) },
    },
  };
}

/** Who is asking, as the verified session and Loop's records say. Never from the body. */
export interface BrainSubmitter {
  readonly organizationId: string;
  readonly userId: string;
  /** Only a person may start Brain work. An AI Employee or a service never may. */
  readonly kind: 'HUMAN' | 'AI_EMPLOYEE' | 'SERVICE';
  readonly membershipActive: boolean;
  /** The access decision for this task, made just now from membership and permissions. */
  readonly allowed: boolean;
}

/** What the task says it accepts. Read from the task definition. */
export interface BrainSubmittableTask {
  readonly taskId: string;
  readonly executionClasses: readonly BrainExecutionClass[];
  readonly subjectType: BrainResultSubjectType;
}

export const BRAIN_SUBMISSION_REFUSALS = [
  'NOT_PERMITTED',
  'UNKNOWN_TASK',
  'EXECUTION_CLASS_NOT_SUPPORTED',
  'SUBJECT_TYPE_MISMATCH',
] as const;
export type BrainSubmissionRefusal = (typeof BRAIN_SUBMISSION_REFUSALS)[number];

/**
 * Whether this person may start this work. Somebody who may not learns only that:
 * whether the task exists, and what it accepts, are not theirs to discover by asking.
 */
export function brainSubmissionRefusals(
  task: BrainSubmittableTask | null,
  submission: BrainSubmission,
  submitter: BrainSubmitter,
): BrainSubmissionRefusal[] {
  if (submitter.kind !== 'HUMAN' || !submitter.membershipActive || submitter.allowed !== true) return ['NOT_PERMITTED'];
  if (!task || task.taskId !== submission.taskId) return ['UNKNOWN_TASK'];
  const out: BrainSubmissionRefusal[] = [];
  if (!task.executionClasses.includes(submission.executionClass)) out.push('EXECUTION_CLASS_NOT_SUPPORTED');
  if (submission.subject.type !== task.subjectType) out.push('SUBJECT_TYPE_MISMATCH');
  return out;
}

/**
 * A canonical rendering of what was asked, so a retried submission with the same key
 * is recognised as the same request and a different request reusing the key is not.
 * The store hashes it.
 */
export function brainSubmissionFingerprint(submitter: Pick<BrainSubmitter, 'organizationId' | 'userId'>, submission: BrainSubmission): string {
  const input = Object.keys(submission.input)
    .sort()
    .map((k) => [k, submission.input[k]]);
  return JSON.stringify([
    submitter.organizationId,
    submitter.userId,
    submission.taskId,
    submission.subject.type,
    submission.subject.id,
    submission.executionClass,
    input,
  ]);
}

export type BrainSubmissionDecision =
  | { readonly kind: 'ACCEPT_NEW' }
  | { readonly kind: 'RETURN_EXISTING'; readonly jobId: string }
  | { readonly kind: 'REFUSE'; readonly refusal: 'IDEMPOTENCY_KEY_REUSED' };

/**
 * What to do with a submission given what the idempotency key already names, within
 * (organization, principal, task). The same request returns the same job and starts
 * no new work; a different request under a used key is refused.
 */
export function brainSubmissionDecision(
  existing: { readonly jobId: string; readonly fingerprint: string } | null,
  fingerprint: string,
): BrainSubmissionDecision {
  if (!existing) return { kind: 'ACCEPT_NEW' };
  if (existing.fingerprint === fingerprint) return { kind: 'RETURN_EXISTING', jobId: existing.jobId };
  return { kind: 'REFUSE', refusal: 'IDEMPOTENCY_KEY_REUSED' };
}

/** The recorded job an accepted submission becomes. */
export function brainAcceptedJob(input: {
  readonly jobId: string;
  readonly submitter: BrainSubmitter;
  readonly submission: BrainSubmission;
  readonly task: {
    readonly taskId: string;
    readonly version: string;
    readonly capabilityRoute: string;
    readonly resultType: BrainResultType;
    readonly resultOwner: BrainResultOwner;
  };
  readonly resumesJobId?: string | null;
}): BrainJobSnapshot {
  return {
    jobId: input.jobId,
    generation: 1,
    organizationId: input.submitter.organizationId,
    principalUserId: input.submitter.userId,
    taskId: input.task.taskId,
    taskVersion: input.task.version,
    capabilityRoute: input.task.capabilityRoute,
    resultType: input.task.resultType,
    resultOwner: { authority: input.task.resultOwner.authority, subjectType: input.task.resultOwner.subjectType },
    subject: { ...input.submission.subject },
    executionClass: input.submission.executionClass,
    promoted: false,
    state: 'ACCEPTED',
    cancelRequest: null,
    wait: null,
    resultRefs: [],
    endReason: null,
    resumesJobId: input.resumesJobId ?? null,
  };
}

/**
 * What a commit from this job must be, taken only from the job record: its
 * organization, its declared result type and owner, and the subject it was accepted
 * for. A draft job can therefore never commit a proposed action, whatever its output
 * says.
 */
export function brainCommitExpectation(
  job: Pick<BrainJobSnapshot, 'jobId' | 'organizationId' | 'resultType' | 'resultOwner' | 'subject'>,
): BrainCommitExpectation {
  return {
    jobId: job.jobId,
    organizationId: job.organizationId,
    resultType: job.resultType,
    owner: { authority: job.resultOwner.authority, subjectType: job.resultOwner.subjectType },
    subject: { type: job.subject.type, id: job.subject.id },
  };
}

// --- Progress -------------------------------------------------------------------------

export interface BrainJobProgress {
  readonly state: BrainJobState;
  readonly currentStep: { readonly key: string; readonly kind: BrainStepKind; readonly label: string } | null;
  readonly completedSteps: number;
  /** Known only when the task's plan is fixed. Null when the plan can grow. */
  readonly plannedSteps: number | null;
}

/** A fraction only when there is an honest denominator. Never an estimate. */
export function brainProgressFraction(progress: BrainJobProgress): number | null {
  const { plannedSteps, completedSteps } = progress;
  if (plannedSteps === null || !Number.isInteger(plannedSteps) || plannedSteps <= 0) return null;
  if (!Number.isInteger(completedSteps) || completedSteps < 0 || completedSteps > plannedSteps) return null;
  return completedSteps / plannedSteps;
}

// --- Compile-time guarantees ------------------------------------------------------------
// These fail the build, not a test, if the contract ever drifts.

type BrainMustBeTrue<T extends true> = T;

/** Nothing a caller submits can carry an organization, a principal or a role. */
export type BrainSubmissionCarriesNoAuthority = BrainMustBeTrue<
  Extract<keyof BrainSubmission, (typeof BRAIN_CLIENT_AUTHORITY_KEYS)[number]> extends never ? true : false
>;

/** No event can describe a client, a session, a browser or a connection. */
export type BrainJobIgnoresConnections = BrainMustBeTrue<
  Extract<
    BrainJobTransitionEvent['type'],
    `${string}CLIENT${string}` | `${string}SESSION${string}` | `${string}BROWSER${string}` | `${string}CONNECT${string}` | `${string}REQUEST_ABORT${string}`
  > extends never
    ? true
    : false
>;

/** The listed event types are exactly the events the machine accepts. */
export type BrainTransitionEventTypesAreComplete = BrainMustBeTrue<
  Exclude<BrainJobTransitionEvent['type'], (typeof BRAIN_TRANSITION_EVENT_TYPES)[number]> extends never ? true : false
>;
