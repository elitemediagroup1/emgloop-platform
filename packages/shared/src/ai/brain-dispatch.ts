// How accepted Brain work is handed to an executor and advanced safely. Slice B3.
//
// Architecture: docs/architecture/brain-execution-infrastructure.md (§5-§8, §14, §23).
//
// DELIVERY IS AT LEAST ONCE; EFFECTS ARE ONCE. Whatever carries work to an executor may
// deliver a message twice, late, or after a crash. Loop does not pretend otherwise. It
// gives every effect a durable identity -- a result commit, an event, an advance -- and
// lets only one worker advance a job at a time through a lease recorded with the job.
//
// AN ADVANCE MESSAGE IS A REFERENCE. It names a job, a generation and why it was sent.
// It carries no organization, no principal, no input and no content, so a message
// that is forged, replayed or read by the wrong party moves nothing on its own.
//
// THE WORKER PROVES ITSELF TO LOOP, TOO. When an executor asks Loop for an access
// decision, a context package or a result commit, the request carries a short-lived
// token signed by a key the worker cannot export, bound to one job, one purpose and
// one exact body. Loop reads the organization and the principal from the job, never
// from the token.
//
// A STEP THAT CANNOT FINISH IN TIME IS NOT STARTED. An interactive job whose next
// step could outlast its deadline is promoted first, when it may be, so nobody pays
// for a call that would be cut off.
//
// A NON-CONFORMING ROUTE NEVER SERVES. The specialization conformance the test suite
// proves is checked again where work is accepted and before every model step.
//
// PURE. Clocks are supplied by the caller.

import type { BrainExecutionClass, BrainExecutionContract } from './brain-execution';
import { brainDeadlineDecision } from './brain-execution';
import type { BrainJobSnapshot, BrainJobState } from './brain-job';
import { isBrainStepKey } from './brain-step';
import type { AiProviderSpecializationPolicy, AiRoutedTask, AiRouteConformanceFinding } from './capability';
import { aiRoutingConformance } from './capability';
import type { AiRoutingPolicy } from './runtime';

// --- Durable identities ---------------------------------------------------------------

/** One result commit per commit step. The owner's store is unique on it, so a repeat commits nothing new. */
export function brainResultCommitKey(jobId: string, stepKey: string): string {
  if (!isBrainStepKey(stepKey)) throw new Error(`invalid step key: ${stepKey}`);
  return `${jobId}:${stepKey}:commit`;
}

/** One event per recorded transition. The event store is unique on it, so a repeat publishes nothing new. */
export function brainEventId(jobId: string, transitionSequence: number): string {
  if (!Number.isInteger(transitionSequence) || transitionSequence < 1) throw new Error('transition sequence starts at 1');
  return `${jobId}#${transitionSequence}`;
}

export const BRAIN_ADVANCE_REASONS = ['START', 'RESUME', 'CANCEL', 'CONTINUE', 'TIMER', 'RECOVERY'] as const;
export type BrainAdvanceReason = (typeof BRAIN_ADVANCE_REASONS)[number];

/** What a queue carries to a worker. A reference and a reason; nothing that grants anything. */
export interface BrainAdvanceMessage {
  readonly jobId: string;
  readonly generation: number;
  readonly reason: BrainAdvanceReason;
  /** The stored command that caused it, for START, RESUME and CANCEL. */
  readonly commandId: string | null;
}

const ADVANCE_FIELDS = ['jobId', 'generation', 'reason', 'commandId'];
const ID = /^[A-Za-z0-9_-]{8,128}$/;

export const BRAIN_ADVANCE_REFUSALS = ['NOT_AN_OBJECT', 'UNEXPECTED_FIELD', 'INVALID_FIELD', 'COMMAND_REQUIRED'] as const;
export type BrainAdvanceRefusal = (typeof BRAIN_ADVANCE_REFUSALS)[number];

export function parseBrainAdvanceMessage(
  raw: unknown,
): { readonly ok: true; readonly message: BrainAdvanceMessage } | { readonly ok: false; readonly refusals: readonly BrainAdvanceRefusal[] } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, refusals: ['NOT_AN_OBJECT'] };
  const m = raw as Record<string, unknown>;
  const out: BrainAdvanceRefusal[] = [];
  if (Object.keys(m).some((k) => !ADVANCE_FIELDS.includes(k))) out.push('UNEXPECTED_FIELD');
  const reasonOk = (BRAIN_ADVANCE_REASONS as readonly unknown[]).includes(m.reason);
  if (
    typeof m.jobId !== 'string' ||
    !ID.test(m.jobId) ||
    !Number.isInteger(m.generation) ||
    (m.generation as number) < 1 ||
    !reasonOk ||
    !(m.commandId === null || (typeof m.commandId === 'string' && ID.test(m.commandId)))
  ) {
    out.push('INVALID_FIELD');
  }
  if (reasonOk && ['START', 'RESUME', 'CANCEL'].includes(m.reason as string) && typeof m.commandId !== 'string') out.push('COMMAND_REQUIRED');
  if (out.length > 0) return { ok: false, refusals: [...new Set(out)] };
  return {
    ok: true,
    message: { jobId: m.jobId as string, generation: m.generation as number, reason: m.reason as BrainAdvanceReason, commandId: (m.commandId as string | null) ?? null },
  };
}

// --- One worker at a time -------------------------------------------------------------

/** Who may advance a job, until when. Recorded with the job; changed only by a conditional write. */
export interface BrainLease {
  readonly holder: string;
  readonly expiresAtMs: number;
}

export type BrainLeaseDecision =
  | { readonly action: 'ACQUIRE' }
  | { readonly action: 'RENEW' }
  | { readonly action: 'TAKE_OVER'; readonly previousHolder: string }
  | { readonly action: 'BUSY'; readonly holder: string; readonly retryAfterMs: number };

/**
 * Whether this worker may advance the job now. A live lease held by someone else means
 * a duplicate delivery: the holder will carry the job forward, so this delivery stops.
 * An expired lease means its holder died: the next worker takes over and resumes from
 * checkpoints. The store applies the decision with a conditional write, so two workers
 * racing on the same expired lease cannot both win.
 */
export function brainLeaseDecision(current: BrainLease | null, requester: string, nowMs: number): BrainLeaseDecision {
  if (!current) return { action: 'ACQUIRE' };
  if (current.holder === requester) return { action: 'RENEW' };
  if (current.expiresAtMs <= nowMs) return { action: 'TAKE_OVER', previousHolder: current.holder };
  return { action: 'BUSY', holder: current.holder, retryAfterMs: current.expiresAtMs - nowMs };
}

/** A lease must outlive the longest step it covers, or a slow step would be taken over mid-flight. */
export function brainLeaseDurationMs(longestStepMs: number, marginMs: number): number {
  if (!(longestStepMs > 0) || !(marginMs > 0)) throw new Error('lease inputs must be positive');
  return longestStepMs + marginMs;
}

// --- Starting a step within the deadline ----------------------------------------------

export type BrainStepStartDecision =
  | { readonly action: 'START' }
  | { readonly action: 'PROMOTE' }
  | { readonly action: 'FAIL'; readonly reason: 'DEADLINE_EXCEEDED' };

/**
 * Whether the next step may start now. A step that could outlast the time its job has
 * left is not started: an interactive job is promoted first if its task allows, and
 * otherwise ends with a named reason before any money is spent.
 */
export function brainStepStartDecision(input: {
  readonly contract: BrainExecutionContract;
  readonly executionClass: BrainExecutionClass;
  readonly elapsedMs: number;
  readonly stepMaxDurationMs: number;
}): BrainStepStartDecision {
  const now = brainDeadlineDecision({ contract: input.contract, executionClass: input.executionClass, elapsedMs: input.elapsedMs });
  if (now.action !== 'CONTINUE') return now.action === 'PROMOTE' ? { action: 'PROMOTE' } : { action: 'FAIL', reason: 'DEADLINE_EXCEEDED' };
  const after = brainDeadlineDecision({
    contract: input.contract,
    executionClass: input.executionClass,
    elapsedMs: input.elapsedMs + Math.max(0, input.stepMaxDurationMs),
  });
  if (after.action === 'CONTINUE') return { action: 'START' };
  return after.action === 'PROMOTE' ? { action: 'PROMOTE' } : { action: 'FAIL', reason: 'DEADLINE_EXCEEDED' };
}

// --- Routing conformance, at run time ---------------------------------------------------

export type BrainRouteGate =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'ROUTING_NOT_CONFORMANT'; readonly findings: readonly AiRouteConformanceFinding[] };

/**
 * The run-time half of provider specialization. Called where work is accepted and
 * again before every model step, because the policy an executor runs with may be a
 * later deployment than the one that accepted the job.
 */
export function brainRouteGate(task: AiRoutedTask, routing: AiRoutingPolicy, specialization: AiProviderSpecializationPolicy): BrainRouteGate {
  const [row] = aiRoutingConformance([task], routing, specialization);
  if (!row || row.findings.length > 0) return { ok: false, reason: 'ROUTING_NOT_CONFORMANT', findings: row ? row.findings : ['NO_ROUTE_FOR_TASK'] };
  return { ok: true };
}

// --- The worker's requests to Loop ----------------------------------------------------

export const BRAIN_WORKER_AUDIENCE = 'loop-brain-internal';
export const BRAIN_WORKER_MAX_LIFETIME_SECONDS = 120;
export const BRAIN_WORKER_CLOCK_SKEW_SECONDS = 30;

/** What a worker may ask Loop for, and the job states in which it may ask. */
export const BRAIN_WORKER_PURPOSES = ['ACCESS_DECISION', 'CONTEXT', 'COMMIT_RESULT'] as const;
export type BrainWorkerPurpose = (typeof BRAIN_WORKER_PURPOSES)[number];

export const BRAIN_WORKER_PURPOSE_STATES: Readonly<Record<BrainWorkerPurpose, readonly BrainJobState[]>> = Object.freeze({
  // Access is re-decided before a step and before applying a reply, so a waiting job may ask.
  ACCESS_DECISION: Object.freeze(['QUEUED', 'RUNNING', 'WAITING_FOR_USER'] as const),
  CONTEXT: Object.freeze(['RUNNING'] as const),
  COMMIT_RESULT: Object.freeze(['RUNNING'] as const),
});

/** What a verified worker token says. The organization and principal are never in it. */
export interface BrainWorkerClaims {
  readonly iss: string;
  readonly aud: string | readonly string[];
  readonly sub: string;
  readonly jti: string;
  readonly iat: number;
  readonly exp: number;
  readonly jobId: string;
  readonly generation: number;
  readonly purpose: string;
  /** Lower-case hex SHA-256 of the exact request body. */
  readonly bodySha256: string;
}

export const BRAIN_WORKER_REQUEST_REFUSALS = [
  'ISSUER_NOT_TRUSTED',
  'CALLER_NOT_TRUSTED',
  'WRONG_AUDIENCE',
  'MISSING_TOKEN_ID',
  'NOT_YET_VALID',
  'EXPIRED',
  'LIFETIME_TOO_LONG',
  'PURPOSE_MISMATCH',
  'BODY_MISMATCH',
  'JOB_NOT_FOUND',
  'GENERATION_MISMATCH',
  'JOB_STATE_REFUSES_PURPOSE',
] as const;
export type BrainWorkerRequestRefusal = (typeof BRAIN_WORKER_REQUEST_REFUSALS)[number];

/**
 * Whether Loop answers a worker's request. The route states which purpose it serves and
 * hashes the body it actually received; the job is the one Loop loads by the token's
 * job id. On success Loop knows the job -- and from the job, the organization and the
 * principal -- and nothing else from the request.
 */
export function brainWorkerRequestCheck(
  claims: BrainWorkerClaims,
  request: { readonly purpose: BrainWorkerPurpose; readonly bodySha256: string },
  job: Pick<BrainJobSnapshot, 'jobId' | 'generation' | 'state' | 'organizationId' | 'principalUserId'> | null,
  options: {
    readonly nowSeconds: number;
    readonly trustedIssuers: readonly string[];
    readonly trustedWorkers: readonly string[];
    readonly maxLifetimeSeconds?: number;
    readonly clockSkewSeconds?: number;
  },
):
  | { readonly ok: true; readonly jobId: string; readonly organizationId: string; readonly principalUserId: string; readonly worker: string; readonly tokenId: string }
  | { readonly ok: false; readonly refusals: readonly BrainWorkerRequestRefusal[] } {
  const out: BrainWorkerRequestRefusal[] = [];
  const skew = options.clockSkewSeconds ?? BRAIN_WORKER_CLOCK_SKEW_SECONDS;
  const maxLifetime = options.maxLifetimeSeconds ?? BRAIN_WORKER_MAX_LIFETIME_SECONDS;
  if (!options.trustedIssuers.includes(claims.iss)) out.push('ISSUER_NOT_TRUSTED');
  if (!options.trustedWorkers.includes(claims.sub)) out.push('CALLER_NOT_TRUSTED');
  const audiences = typeof claims.aud === 'string' ? [claims.aud] : Array.isArray(claims.aud) ? [...claims.aud] : [];
  if (!audiences.includes(BRAIN_WORKER_AUDIENCE)) out.push('WRONG_AUDIENCE');
  if (typeof claims.jti !== 'string' || claims.jti.trim() === '') out.push('MISSING_TOKEN_ID');
  const iat = Number(claims.iat);
  const exp = Number(claims.exp);
  if (!Number.isFinite(iat) || iat > options.nowSeconds + skew) out.push('NOT_YET_VALID');
  if (!Number.isFinite(exp) || exp + skew <= options.nowSeconds) out.push('EXPIRED');
  if (Number.isFinite(iat) && Number.isFinite(exp) && exp - iat > maxLifetime) out.push('LIFETIME_TOO_LONG');
  if (claims.purpose !== request.purpose) out.push('PURPOSE_MISMATCH');
  if (typeof claims.bodySha256 !== 'string' || claims.bodySha256.toLowerCase() !== request.bodySha256.toLowerCase()) out.push('BODY_MISMATCH');
  if (!job || job.jobId !== claims.jobId) out.push('JOB_NOT_FOUND');
  else {
    if (job.generation !== claims.generation) out.push('GENERATION_MISMATCH');
    if (!BRAIN_WORKER_PURPOSE_STATES[request.purpose].includes(job.state)) out.push('JOB_STATE_REFUSES_PURPOSE');
  }
  if (out.length > 0 || !job) return { ok: false, refusals: [...new Set(out)] };
  return {
    ok: true,
    jobId: job.jobId,
    organizationId: job.organizationId,
    principalUserId: job.principalUserId,
    worker: claims.sub,
    tokenId: claims.jti,
  };
}
