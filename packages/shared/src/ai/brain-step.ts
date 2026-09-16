// The steps a Brain job is made of, and how each survives a crash. Slice B2.
//
// Architecture: docs/architecture/brain-execution-architecture.md §8.
//
// A STEP THAT FINISHED NEVER RUNS AGAIN. Every step's result is checkpointed in Loop's
// database under (job, step, input). On any restart the checkpoint is looked for FIRST,
// and if it exists the step returns it: no provider is called and nothing is paid twice.
//
// A PAID STEP RUNS AT MOST ONCE PER ATTEMPT. A model call costs money whether or not
// its answer is ever read. If a worker dies after a call was reserved but before its
// result was checkpointed, the call is treated as spent -- its ledger row stays
// counted -- and a new attempt is made only while the step's paid-attempt limit allows.
// Otherwise the job fails with PROVIDER_RESULT_LOST. Loop relies on no provider to
// de-duplicate a request.
//
// RETRIES ARE BOUNDED, PER STEP, BY FAILURE CLASS. A deterministic step (validating an
// answer) is never retried: a second look at the same text cannot change the verdict.
//
// A FALLBACK IS ALWAYS VISIBLE. When a model other than the policy's primary serves,
// the step records which model it stands in for and why the primary did not serve.
//
// PURE.

import { providerFailurePolicy } from './provider';

export const BRAIN_STEP_KINDS = [
  'LOAD_CONTEXT',
  'RETRIEVE_CONTEXT',
  'MODEL_CALL',
  'VALIDATE_OUTPUT',
  'REQUEST_USER_INPUT',
  'COMMIT_RESULT',
  'EMIT_EVENT',
] as const;
export type BrainStepKind = (typeof BRAIN_STEP_KINDS)[number];

export const BRAIN_STEP_STATUSES = ['PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'SKIPPED'] as const;
export type BrainStepStatus = (typeof BRAIN_STEP_STATUSES)[number];

export interface BrainStepPolicy {
  readonly kind: BrainStepKind;
  /** Total attempts, including the first. At least one. */
  readonly maxAttempts: number;
  /** Failure classes that may be retried. Anything else fails the step at once. */
  readonly retryOn: readonly string[];
  /** Whether an attempt can spend provider money. */
  readonly paid: boolean;
  /** For a paid step, how many attempts may spend. Zero for an unpaid step. */
  readonly maxPaidAttempts: number;
}

const TRANSIENT = Object.freeze(['UNAVAILABLE', 'TIMEOUT', 'RATE_LIMITED', 'STORE_UNAVAILABLE']);

/**
 * The defaults a task's plan starts from. A MODEL_CALL step is one provider target: its
 * fallback is a separate target inside the same step, so the step itself does not
 * retry on availability -- the gateway's routing does. Its second paid attempt exists
 * only to recover a result lost after it was paid for.
 */
export const BRAIN_DEFAULT_STEP_POLICIES: Readonly<Record<BrainStepKind, BrainStepPolicy>> = Object.freeze({
  LOAD_CONTEXT: policy('LOAD_CONTEXT', 3, TRANSIENT, false, 0),
  RETRIEVE_CONTEXT: policy('RETRIEVE_CONTEXT', 3, TRANSIENT, false, 0),
  MODEL_CALL: policy('MODEL_CALL', 2, Object.freeze(['RESULT_LOST']), true, 2),
  VALIDATE_OUTPUT: policy('VALIDATE_OUTPUT', 1, Object.freeze([]), false, 0),
  REQUEST_USER_INPUT: policy('REQUEST_USER_INPUT', 3, TRANSIENT, false, 0),
  COMMIT_RESULT: policy('COMMIT_RESULT', 3, TRANSIENT, false, 0),
  EMIT_EVENT: policy('EMIT_EVENT', 5, TRANSIENT, false, 0),
});

function policy(kind: BrainStepKind, maxAttempts: number, retryOn: readonly string[], paid: boolean, maxPaidAttempts: number): BrainStepPolicy {
  return Object.freeze({ kind, maxAttempts, retryOn, paid, maxPaidAttempts });
}

export const BRAIN_STEP_POLICY_VIOLATIONS = ['NO_ATTEMPTS', 'PAID_WITHOUT_PAID_LIMIT', 'UNPAID_WITH_PAID_LIMIT', 'PAID_LIMIT_ABOVE_ATTEMPTS'] as const;
export type BrainStepPolicyViolation = (typeof BRAIN_STEP_POLICY_VIOLATIONS)[number];

export function brainStepPolicyViolations(p: BrainStepPolicy): BrainStepPolicyViolation[] {
  const out: BrainStepPolicyViolation[] = [];
  if (!Number.isInteger(p.maxAttempts) || p.maxAttempts < 1) out.push('NO_ATTEMPTS');
  if (p.paid && (!Number.isInteger(p.maxPaidAttempts) || p.maxPaidAttempts < 1)) out.push('PAID_WITHOUT_PAID_LIMIT');
  if (!p.paid && p.maxPaidAttempts !== 0) out.push('UNPAID_WITH_PAID_LIMIT');
  if (p.maxPaidAttempts > p.maxAttempts) out.push('PAID_LIMIT_ABOVE_ATTEMPTS');
  return out;
}

// --- Identities -----------------------------------------------------------------------

/** Lower-case words joined by hyphens, optionally dotted. No colon, so keys cannot collide. */
const STEP_KEY = /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)*$/;

export function isBrainStepKey(value: string): boolean {
  return STEP_KEY.test(value);
}

/** Where a step's result is kept. The input fingerprint is part of it: a different input is a different step. */
export function brainCheckpointKey(jobId: string, stepKey: string, inputFingerprint: string): string {
  if (!isBrainStepKey(stepKey)) throw new Error(`invalid step key: ${stepKey}`);
  return `${jobId}:${stepKey}:${inputFingerprint}`;
}

/**
 * The ledger key of one provider call: job, step, attempt, and -- for a fallback target
 * -- its ordinal, in the same `.n` form the gateway already writes. Unique per
 * organization in `ai_invocations`, so the same call can never be counted twice and a
 * real retry is always a new row.
 */
export function brainCallKey(jobId: string, stepKey: string, attempt: number, targetOrdinal: number): string {
  if (!isBrainStepKey(stepKey)) throw new Error(`invalid step key: ${stepKey}`);
  if (!Number.isInteger(attempt) || attempt < 1 || !Number.isInteger(targetOrdinal) || targetOrdinal < 1) {
    throw new Error('attempt and target ordinal start at 1');
  }
  const base = `${jobId}:${stepKey}:${attempt}`;
  return targetOrdinal === 1 ? base : `${base}.${targetOrdinal}`;
}

// --- Retrying and resuming ------------------------------------------------------------

export type BrainStepRetryDecision =
  | { readonly action: 'RETRY'; readonly nextAttempt: number }
  | { readonly action: 'FAIL'; readonly reason: 'NOT_RETRYABLE' | 'RETRIES_EXHAUSTED' | 'PAID_ATTEMPTS_EXHAUSTED' };

export function brainStepRetryDecision(
  p: BrainStepPolicy,
  state: { readonly attemptsMade: number; readonly paidAttemptsMade: number; readonly failureClass: string },
): BrainStepRetryDecision {
  if (!p.retryOn.includes(state.failureClass)) return { action: 'FAIL', reason: 'NOT_RETRYABLE' };
  if (state.attemptsMade >= p.maxAttempts) return { action: 'FAIL', reason: 'RETRIES_EXHAUSTED' };
  if (p.paid && state.paidAttemptsMade >= p.maxPaidAttempts) return { action: 'FAIL', reason: 'PAID_ATTEMPTS_EXHAUSTED' };
  return { action: 'RETRY', nextAttempt: state.attemptsMade + 1 };
}

export type BrainStepResumeDecision =
  | { readonly action: 'RETURN_CHECKPOINT' }
  | { readonly action: 'EXECUTE'; readonly attempt: number }
  | { readonly action: 'ABANDON_AND_RETRY'; readonly abandonedCallKeys: readonly string[]; readonly attempt: number }
  | { readonly action: 'FAIL'; readonly reason: 'PROVIDER_RESULT_LOST' | 'RETRIES_EXHAUSTED' };

/**
 * What a step does when execution reaches it again -- after a crash, a redeploy or a
 * duplicate delivery. The checkpoint is consulted before anything else.
 *
 * `inFlightCallKeys` are this step's reserved-but-unreconciled ledger rows: calls that
 * may have been made and paid for, whose results were never recorded.
 */
export function brainStepResumeDecision(
  p: BrainStepPolicy,
  state: {
    readonly checkpointed: boolean;
    readonly attemptsMade: number;
    readonly paidAttemptsMade: number;
    readonly inFlightCallKeys: readonly string[];
  },
): BrainStepResumeDecision {
  if (state.checkpointed) return { action: 'RETURN_CHECKPOINT' };
  if (p.paid && state.inFlightCallKeys.length > 0) {
    if (state.paidAttemptsMade >= p.maxPaidAttempts || state.attemptsMade >= p.maxAttempts) {
      return { action: 'FAIL', reason: 'PROVIDER_RESULT_LOST' };
    }
    return { action: 'ABANDON_AND_RETRY', abandonedCallKeys: [...state.inFlightCallKeys], attempt: state.attemptsMade + 1 };
  }
  if (state.attemptsMade >= p.maxAttempts) return { action: 'FAIL', reason: 'RETRIES_EXHAUSTED' };
  return { action: 'EXECUTE', attempt: state.attemptsMade + 1 };
}

// --- Fallback provenance ---------------------------------------------------------------

export interface BrainModelTarget {
  readonly providerId: string;
  readonly modelId: string;
}

export interface BrainModelAttempt {
  readonly callKey: string | null;
  readonly target: BrainModelTarget;
  /** SERVED: it answered (whatever the answer). FAILED: the call failed. SKIPPED: never called. */
  readonly outcome: 'SERVED' | 'FAILED' | 'SKIPPED';
  /** For FAILED, the failure class; for SKIPPED, why (kill switch, not enabled, not registered). */
  readonly reason: string | null;
}

export interface BrainModelStepProvenance {
  readonly policyPrimary: BrainModelTarget;
  readonly servedBy: BrainModelTarget | null;
  /** `provider/model` of the policy primary, whenever something else served. */
  readonly fellBackFrom: string | null;
  /** Why the primary did not serve, when something else did. */
  readonly fallbackReason: string | null;
  readonly attempts: readonly BrainModelAttempt[];
}

function same(a: BrainModelTarget, b: BrainModelTarget): boolean {
  return a.providerId === b.providerId && a.modelId === b.modelId;
}

export function brainTargetLabel(t: BrainModelTarget): string {
  return `${t.providerId}/${t.modelId}`;
}

/** The provenance a model step records, derived from what actually happened. */
export function brainModelStepProvenance(policyPrimary: BrainModelTarget, attempts: readonly BrainModelAttempt[]): BrainModelStepProvenance {
  const served = attempts.find((a) => a.outcome === 'SERVED') ?? null;
  const servedBy = served ? served.target : null;
  let fellBackFrom: string | null = null;
  let fallbackReason: string | null = null;
  if (servedBy && !same(servedBy, policyPrimary)) {
    fellBackFrom = brainTargetLabel(policyPrimary);
    const primaryAttempt = attempts.find((a) => same(a.target, policyPrimary));
    fallbackReason = primaryAttempt
      ? `${primaryAttempt.outcome}:${primaryAttempt.reason ?? 'UNSPECIFIED'}`
      : 'NOT_ATTEMPTED';
  }
  return { policyPrimary, servedBy, fellBackFrom, fallbackReason, attempts: [...attempts] };
}

export const BRAIN_FALLBACK_REFUSALS = ['FALLBACK_AFTER_NON_FALLBACK_FAILURE', 'FALLBACK_AFTER_SERVED', 'FALLBACK_UNRECORDED'] as const;
export type BrainFallbackRefusal = (typeof BRAIN_FALLBACK_REFUSALS)[number];

/**
 * Whether a model step's attempts obeyed the failure policy. A refusal, a rejected
 * answer, an authentication failure or an unclassified error is an outcome: nothing
 * may be tried after it, so a preferred answer can never be shopped for.
 */
export function brainFallbackRefusals(provenance: BrainModelStepProvenance): BrainFallbackRefusal[] {
  const out: BrainFallbackRefusal[] = [];
  const attempts = provenance.attempts;
  for (let i = 0; i < attempts.length - 1; i += 1) {
    const current = attempts[i]!;
    const later = attempts.slice(i + 1).filter((a) => a.outcome !== 'SKIPPED');
    if (later.length === 0) continue;
    if (current.outcome === 'SERVED') out.push('FALLBACK_AFTER_SERVED');
    if (current.outcome === 'FAILED' && !providerFailurePolicy(current.reason ?? 'UNCLASSIFIED').fallback) {
      out.push('FALLBACK_AFTER_NON_FALLBACK_FAILURE');
    }
  }
  if (provenance.servedBy && !same(provenance.servedBy, provenance.policyPrimary) && !provenance.fellBackFrom) {
    out.push('FALLBACK_UNRECORDED');
  }
  return [...new Set(out)];
}
