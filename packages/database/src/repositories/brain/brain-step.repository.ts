// Brain steps: attempts, paid attempts and sealed checkpoints. Slice B4.
//
// Architecture: docs/architecture/brain-persistence.md §4, and the step contract in
// packages/shared/src/ai/brain-step.ts.
//
// CHECKPOINT FIRST. `resumeState` answers exactly what `brainStepResumeDecision` needs:
// whether a checkpoint exists for this step and input, how many attempts and paid
// attempts were made, and which provider calls were reserved for this step but never
// reconciled. A step with a checkpoint is never executed again, and its provider is
// never called again. A job that resumes a failed one reuses that job's checkpoints.
//
// ONE ATTEMPT AT A TIME. Starting attempt N is a write conditional on N-1 attempts having
// been made and no checkpoint existing, so two workers cannot both start the same
// attempt, and nobody starts a step that already finished.
//
// A STEP KEEPS ITS INPUT. Ledger call keys are (job, step, attempt), so one step key has
// one attempt sequence. A different input under the same key is refused
// (STEP_INPUT_CHANGED) rather than re-run or answered from another input's checkpoint:
// a plan that needs a different input needs a different step key.
//
// SEALED, BOUNDED, NEVER READ HERE. A checkpoint is stored as ciphertext with its key
// reference; `brainSealedPayloadRefusals` turns away anything that looks like plaintext.
// No prompt, response, credential or evidence is stored in the clear.

import type { PrismaClient } from '@prisma/client';
import { BRAIN_STEP_KINDS, isBrainStepKey, type BrainStepKind, type BrainStepStatus } from '@emgloop/shared';

import { AI_INVOCATION_IN_FLIGHT } from '../ai-usage-ledger.repository';
import {
  BrainPersistenceInvariantError,
  brainSealedPayloadRefusals,
  isUniqueViolation,
  type BrainSealedPayload,
  type BrainSealedPayloadRefusal,
} from './brain-records';

/** Where a checkpoint lives: possibly in the job this one resumes. */
export interface BrainCheckpointRef {
  readonly jobId: string;
  readonly stepKey: string;
  readonly inputFingerprint: string;
}

export type BrainStepResumeState =
  | {
      readonly ok: true;
      readonly checkpointed: boolean;
      readonly checkpoint: BrainCheckpointRef | null;
      readonly attemptsMade: number;
      readonly paidAttemptsMade: number;
      /** This step's reserved-but-unreconciled ledger call keys. */
      readonly inFlightCallKeys: readonly string[];
    }
  | { readonly ok: false; readonly refusal: 'JOB_NOT_FOUND' | 'STEP_INPUT_CHANGED' };

export type BrainStepBeginOutcome =
  | { readonly ok: true; readonly attempt: number }
  | {
      readonly ok: false;
      readonly refusal: 'JOB_NOT_FOUND' | 'JOB_NOT_RUNNING' | 'STEP_INPUT_CHANGED' | 'ALREADY_CHECKPOINTED' | 'ATTEMPT_CONFLICT' | 'KIND_MISMATCH';
    };

export type BrainCheckpointOutcome =
  | { readonly ok: true; readonly recorded: 'NOW' | 'ALREADY' }
  | { readonly ok: false; readonly refusal: 'STEP_NOT_RUNNING' | 'STEP_INPUT_CHANGED' | BrainSealedPayloadRefusal };

export interface BrainStepSummary {
  readonly stepKey: string;
  readonly kind: string;
  readonly state: string;
  readonly attempts: number;
  readonly paidAttempts: number;
  readonly lastFailureClass: string | null;
  readonly checkpointed: boolean;
  readonly checkpointSizeBytes: number | null;
  readonly startedAt: Date | null;
  readonly endedAt: Date | null;
}

/** How far back a resumed job's checkpoints are looked for. */
const MAX_RESUME_DEPTH = 8;
const FINGERPRINT = /^[A-Za-z0-9._-]{1,128}$/;
/** Loop's failure taxonomy: codes, never a provider's prose. */
const FAILURE_CLASS = /^[A-Z][A-Z0-9_]{0,63}$/;

function checkIdentity(stepKey: string, inputFingerprint: string): void {
  if (!isBrainStepKey(stepKey)) throw new BrainPersistenceInvariantError('invalid step key');
  if (!FINGERPRINT.test(inputFingerprint)) throw new BrainPersistenceInvariantError('invalid input fingerprint');
}

export class BrainStepRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async resumeState(organizationId: string, jobId: string, stepKey: string, inputFingerprint: string): Promise<BrainStepResumeState> {
    checkIdentity(stepKey, inputFingerprint);
    const job = await this.prisma.brainJob.findFirst({ where: { id: jobId, organizationId }, select: { id: true, resumesJobId: true } });
    if (!job) return { ok: false, refusal: 'JOB_NOT_FOUND' };
    const step = await this.prisma.brainJobStep.findFirst({
      where: { organizationId, jobId, stepKey },
      select: { inputFingerprint: true, attempts: true, paidAttempts: true, checkpointedAt: true },
    });
    if (step && step.inputFingerprint !== inputFingerprint) return { ok: false, refusal: 'STEP_INPUT_CHANGED' };

    let checkpoint: BrainCheckpointRef | null = step?.checkpointedAt ? { jobId, stepKey, inputFingerprint } : null;
    // Resuming failed work reuses what the earlier job already paid for -- in this
    // organization only, and only for the same step with the same input.
    let previous = job.resumesJobId;
    for (let depth = 0; !checkpoint && previous && depth < MAX_RESUME_DEPTH; depth += 1) {
      const earlier = await this.prisma.brainJobStep.findFirst({
        where: { organizationId, jobId: previous, stepKey, inputFingerprint, state: 'SUCCEEDED' },
        select: { jobId: true },
      });
      if (earlier) checkpoint = { jobId: earlier.jobId, stepKey, inputFingerprint };
      else {
        const next = await this.prisma.brainJob.findFirst({ where: { id: previous, organizationId }, select: { resumesJobId: true } });
        previous = next?.resumesJobId ?? null;
      }
    }

    const inFlight = await this.prisma.aiInvocation.findMany({
      where: { organizationId, brainJobId: jobId, brainStepKey: stepKey, outcome: AI_INVOCATION_IN_FLIGHT },
      select: { invocationId: true },
      orderBy: { invocationId: 'asc' },
    });
    return {
      ok: true,
      checkpointed: checkpoint !== null,
      checkpoint,
      attemptsMade: step?.attempts ?? 0,
      paidAttemptsMade: step?.paidAttempts ?? 0,
      inFlightCallKeys: inFlight.map((r) => r.invocationId),
    };
  }

  /**
   * Start attempt `attempt` of a step, which the caller chose with
   * `brainStepResumeDecision`. Only a RUNNING job's steps run.
   */
  async beginAttempt(
    organizationId: string,
    jobId: string,
    request: {
      readonly stepKey: string;
      readonly kind: BrainStepKind;
      readonly inputFingerprint: string;
      readonly attempt: number;
      readonly paid: boolean;
      readonly now?: Date;
    },
  ): Promise<BrainStepBeginOutcome> {
    checkIdentity(request.stepKey, request.inputFingerprint);
    if (!(BRAIN_STEP_KINDS as readonly string[]).includes(request.kind)) throw new BrainPersistenceInvariantError('unknown step kind');
    if (!Number.isInteger(request.attempt) || request.attempt < 1) throw new BrainPersistenceInvariantError('attempts start at 1');
    const now = request.now ?? new Date();
    const job = await this.prisma.brainJob.findFirst({ where: { id: jobId, organizationId }, select: { state: true } });
    if (!job) return { ok: false, refusal: 'JOB_NOT_FOUND' };
    if (job.state !== 'RUNNING') return { ok: false, refusal: 'JOB_NOT_RUNNING' };

    const existing = await this.prisma.brainJobStep.findFirst({
      where: { organizationId, jobId, stepKey: request.stepKey },
      select: { kind: true, inputFingerprint: true, checkpointedAt: true },
    });
    if (!existing) {
      if (request.attempt !== 1) return { ok: false, refusal: 'ATTEMPT_CONFLICT' };
      try {
        await this.prisma.brainJobStep.create({
          data: {
            organizationId,
            jobId,
            stepKey: request.stepKey,
            kind: request.kind,
            state: 'RUNNING',
            inputFingerprint: request.inputFingerprint,
            attempts: 1,
            paidAttempts: request.paid ? 1 : 0,
            startedAt: now,
          },
          select: { id: true },
        });
        return { ok: true, attempt: 1 };
      } catch (err) {
        if (isUniqueViolation(err)) return { ok: false, refusal: 'ATTEMPT_CONFLICT' };
        throw err;
      }
    }
    if (existing.inputFingerprint !== request.inputFingerprint) return { ok: false, refusal: 'STEP_INPUT_CHANGED' };
    if (existing.kind !== request.kind) return { ok: false, refusal: 'KIND_MISMATCH' };
    if (existing.checkpointedAt) return { ok: false, refusal: 'ALREADY_CHECKPOINTED' };
    const updated = await this.prisma.brainJobStep.updateMany({
      where: {
        organizationId,
        jobId,
        stepKey: request.stepKey,
        inputFingerprint: request.inputFingerprint,
        attempts: request.attempt - 1,
        checkpointedAt: null,
      },
      data: {
        attempts: request.attempt,
        ...(request.paid ? { paidAttempts: { increment: 1 } } : {}),
        state: 'RUNNING',
        lastFailureClass: null,
        endedAt: null,
      },
    });
    return updated.count === 1 ? { ok: true, attempt: request.attempt } : { ok: false, refusal: 'ATTEMPT_CONFLICT' };
  }

  /** Store a running step's sealed result. Recording the same step twice records it once. */
  async recordCheckpoint(
    organizationId: string,
    jobId: string,
    request: { readonly stepKey: string; readonly inputFingerprint: string; readonly payload: BrainSealedPayload; readonly now?: Date },
  ): Promise<BrainCheckpointOutcome> {
    checkIdentity(request.stepKey, request.inputFingerprint);
    const refusals = brainSealedPayloadRefusals(request.payload);
    if (refusals.length > 0) return { ok: false, refusal: refusals[0]! };
    const now = request.now ?? new Date();
    const bytes = Buffer.from(request.payload.sealed);
    const updated = await this.prisma.brainJobStep.updateMany({
      where: {
        organizationId,
        jobId,
        stepKey: request.stepKey,
        inputFingerprint: request.inputFingerprint,
        state: 'RUNNING',
        checkpointedAt: null,
      },
      data: {
        state: 'SUCCEEDED',
        checkpointSealed: bytes,
        checkpointKeyRef: request.payload.keyRef,
        checkpointSealVersion: request.payload.sealVersion,
        checkpointSizeBytes: bytes.byteLength,
        checkpointedAt: now,
        endedAt: now,
        lastFailureClass: null,
      },
    });
    if (updated.count === 1) return { ok: true, recorded: 'NOW' };
    const step = await this.prisma.brainJobStep.findFirst({
      where: { organizationId, jobId, stepKey: request.stepKey },
      select: { inputFingerprint: true, checkpointedAt: true },
    });
    if (step && step.inputFingerprint !== request.inputFingerprint) return { ok: false, refusal: 'STEP_INPUT_CHANGED' };
    if (step?.checkpointedAt) return { ok: true, recorded: 'ALREADY' };
    return { ok: false, refusal: 'STEP_NOT_RUNNING' };
  }

  /** Record that a running attempt failed, with Loop's failure class. */
  async recordFailure(
    organizationId: string,
    jobId: string,
    request: { readonly stepKey: string; readonly inputFingerprint: string; readonly failureClass: string; readonly now?: Date },
  ): Promise<boolean> {
    checkIdentity(request.stepKey, request.inputFingerprint);
    if (!FAILURE_CLASS.test(request.failureClass)) throw new BrainPersistenceInvariantError('a failure class is a code, never text');
    const updated = await this.prisma.brainJobStep.updateMany({
      where: { organizationId, jobId, stepKey: request.stepKey, inputFingerprint: request.inputFingerprint, state: 'RUNNING' },
      data: { state: 'FAILED', lastFailureClass: request.failureClass, endedAt: request.now ?? new Date() },
    });
    return updated.count === 1;
  }

  /** A sealed checkpoint, for its executor to open. Never another organization's. */
  async readCheckpoint(organizationId: string, ref: BrainCheckpointRef): Promise<BrainSealedPayload | null> {
    checkIdentity(ref.stepKey, ref.inputFingerprint);
    const row = await this.prisma.brainJobStep.findFirst({
      where: { organizationId, jobId: ref.jobId, stepKey: ref.stepKey, inputFingerprint: ref.inputFingerprint, state: 'SUCCEEDED' },
      select: { checkpointSealed: true, checkpointKeyRef: true, checkpointSealVersion: true },
    });
    if (!row?.checkpointSealed || !row.checkpointKeyRef || !row.checkpointSealVersion) return null;
    return { sealed: new Uint8Array(row.checkpointSealed), keyRef: row.checkpointKeyRef, sealVersion: row.checkpointSealVersion };
  }

  /** What the operator view shows about a job's steps. Never a payload. */
  async listForJob(organizationId: string, jobId: string): Promise<BrainStepSummary[]> {
    const rows = await this.prisma.brainJobStep.findMany({
      where: { organizationId, jobId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: {
        stepKey: true,
        kind: true,
        state: true,
        attempts: true,
        paidAttempts: true,
        lastFailureClass: true,
        checkpointedAt: true,
        checkpointSizeBytes: true,
        startedAt: true,
        endedAt: true,
      },
    });
    return rows.map((r) => ({
      stepKey: r.stepKey,
      kind: r.kind,
      state: r.state as BrainStepStatus,
      attempts: r.attempts,
      paidAttempts: r.paidAttempts,
      lastFailureClass: r.lastFailureClass,
      checkpointed: r.checkpointedAt !== null,
      checkpointSizeBytes: r.checkpointSizeBytes,
      startedAt: r.startedAt,
      endedAt: r.endedAt,
    }));
  }
}
