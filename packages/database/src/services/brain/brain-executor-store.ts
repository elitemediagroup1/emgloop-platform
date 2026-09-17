// Everything a Brain executor may do to Loop's records, and nothing more. Slice B5.
//
// Architecture: docs/architecture/brain-boundary.md §6, brain-execution-infrastructure.md
// §8 and §12, and the restricted roles in scripts/operations/brain-database-roles.sql.
//
// ONE NARROW SURFACE. The executor (an execution-environment worker in B6, an in-process
// runner in tests) is handed a job reference or a command id and nothing else. This
// facade is the only persistence it uses: it resolves the reference to its organization
// once, then acts only through the organization-scoped Brain repositories and the usage
// ledger. It has no method that creates a job, records a reply, reads a product table or
// writes a governed artifact -- those belong to the Brain API and to Loop's internal
// API (`BrainInternalService`), which re-authorize the job's principal.
//
// THE DATABASE AGREES. In the execution environment this facade runs as
// `loop_brain_worker`, whose grants cover exactly these operations and whose UPDATE
// grants cannot change what a job is.
//
// NEON IS THE ONLY STATE. A lease, a checkpoint, a question, a usage row and a
// transition are all rows; a worker that dies loses nothing but the step it was on.

import type { PrismaClient } from '@prisma/client';
import {
  BRAIN_QUESTION_SCHEMA_ID,
  BRAIN_QUESTION_SCHEMA_VERSION,
  aiEffectiveControls,
  brainCallKey,
  brainCommandDisposition,
  parseBrainQuestion,
  type AiBudgetPolicy,
  type AiControlFloor,
  type AiEffectiveControls,
  type BrainCommandDisposition,
  type BrainJobRef,
  type BrainJobSnapshot,
  type BrainJobTransitionEvent,
  type BrainStepKind,
  type BrainTransitionContext,
} from '@emgloop/shared';

import { AiControlRepository } from '../../repositories/brain/ai-control.repository';
import { BrainCommandRepository } from '../../repositories/brain/brain-command.repository';
import { BrainExecutionReferences, type BrainJobReference } from '../../repositories/brain/brain-execution-references';
import { BrainJobRepository, type BrainJobRecord, type BrainLeaseOutcome } from '../../repositories/brain/brain-job.repository';
import type { BrainSealedPayload, BrainTaskInput } from '../../repositories/brain/brain-records';
import { BrainStepRepository, type BrainCheckpointRef } from '../../repositories/brain/brain-step.repository';
import { BrainWaitRepository } from '../../repositories/brain/brain-wait.repository';
import { AiUsageLedgerRepository, type AiInvocationReconcileInput } from '../../repositories/ai-usage-ledger.repository';
import { DurableAiUsageLedger } from '../ai-usage-ledger.service';
import type { AiCallReservation, AiReserveResult } from '../ai-runtime/gateway';

export type BrainExecutorJob = BrainJobReference;

export type BrainClaimOutcome =
  | { readonly ok: true; readonly job: BrainJobSnapshot; readonly record: BrainJobRecord; readonly input: BrainTaskInput; readonly lease: Extract<BrainLeaseOutcome, { ok: true }> }
  | { readonly ok: false; readonly reason: 'NOT_FOUND' | Extract<BrainLeaseOutcome, { ok: false }>['reason'] };

export type BrainCommandLookup =
  | {
      readonly ok: true;
      readonly job: BrainExecutorJob;
      readonly commandType: string;
      /** Which queue should carry the work. Read from the job, never from the ring. */
      readonly executionClass: BrainJobSnapshot['executionClass'];
      readonly disposition: BrainCommandDisposition;
    }
  | { readonly ok: false; readonly reason: 'COMMAND_NOT_FOUND' };

/** What a worker may transition by itself. Waits and stops have their own methods. */
export type BrainExecutorTransition = Extract<
  BrainJobTransitionEvent,
  { type: 'DISPATCHED' | 'STARTED' | 'PROMOTED' | 'CANCEL_SETTLED' | 'RESULT_COMMITTED' | 'FAILED' }
>;

export class BrainExecutorStore {
  private readonly references: BrainExecutionReferences;
  private readonly jobs: BrainJobRepository;
  private readonly steps: BrainStepRepository;
  private readonly waits: BrainWaitRepository;
  private readonly commands: BrainCommandRepository;
  private readonly controls: AiControlRepository;
  private readonly ledgerRows: AiUsageLedgerRepository;
  private readonly ledger: DurableAiUsageLedger;

  constructor(prisma: PrismaClient) {
    this.references = new BrainExecutionReferences(prisma);
    this.jobs = new BrainJobRepository(prisma);
    this.steps = new BrainStepRepository(prisma);
    this.waits = new BrainWaitRepository(prisma);
    this.commands = new BrainCommandRepository(prisma);
    this.controls = new AiControlRepository(prisma);
    this.ledgerRows = new AiUsageLedgerRepository(prisma);
    this.ledger = new DurableAiUsageLedger(prisma);
  }

  // --- Waking up ---------------------------------------------------------------------

  /** The job an advance message names, if its generation is current. */
  resolve(ref: BrainJobRef): Promise<BrainExecutorJob | null> {
    return this.references.resolveJob(ref);
  }

  /**
   * What to do with the command a doorbell ring named. The ring proves nothing; the
   * command and its job are read from Loop and must agree (`brainCommandDisposition`).
   */
  async command(commandId: string): Promise<BrainCommandLookup> {
    const ref = await this.references.resolveCommand(commandId);
    if (!ref) return { ok: false, reason: 'COMMAND_NOT_FOUND' };
    const stored = await this.commands.get(ref.organizationId, commandId);
    const record = await this.jobs.get(ref.organizationId, ref.jobId);
    if (!stored || !record) return { ok: false, reason: 'COMMAND_NOT_FOUND' };
    const replyRecorded =
      stored.command.waitId !== null
        ? (await this.waits.get(ref.organizationId, stored.command.waitId))?.wait.status === 'ANSWERED'
        : false;
    return {
      ok: true,
      job: { organizationId: ref.organizationId, jobId: ref.jobId, generation: record.job.generation },
      commandType: stored.command.type,
      executionClass: record.job.executionClass,
      disposition: brainCommandDisposition(stored.command, record.job, { replyRecorded }),
    };
  }

  markDispatched(job: BrainExecutorJob, commandId: string, now?: Date): Promise<boolean> {
    return this.commands.markDispatched(job.organizationId, commandId, now);
  }

  // --- Holding a job -----------------------------------------------------------------

  /** Take the job's lease and read what the worker needs to run its next step. */
  async claim(job: BrainExecutorJob, holder: string, durationMs: number, now?: Date): Promise<BrainClaimOutcome> {
    const lease = await this.jobs.lease(job.organizationId, job.jobId, { holder, generation: job.generation, durationMs, now });
    if (!lease.ok) return { ok: false, reason: lease.reason };
    const record = await this.jobs.get(job.organizationId, job.jobId);
    const input = await this.jobs.input(job.organizationId, job.jobId);
    if (!record || !input) return { ok: false, reason: 'NOT_FOUND' };
    return { ok: true, job: record.job, record, input, lease };
  }

  release(job: BrainExecutorJob, holder: string): Promise<boolean> {
    return this.jobs.releaseLease(job.organizationId, job.jobId, holder);
  }

  addActiveTime(job: BrainExecutorJob, holder: string, elapsedMs: number): Promise<boolean> {
    return this.jobs.addActiveTime(job.organizationId, job.jobId, holder, elapsedMs);
  }

  /** The controls this job's work is subject to now: the worker's own floor AND Loop's records. */
  async controlsFor(job: BrainExecutorJob, floor: AiControlFloor): Promise<AiEffectiveControls> {
    return aiEffectiveControls(floor, await this.controls.currentFor(job.organizationId), job.organizationId);
  }

  transition(
    job: BrainExecutorJob,
    event: BrainExecutorTransition,
    options: { readonly context: BrainTransitionContext; readonly holder?: string; readonly now?: Date },
  ) {
    return this.jobs.transition(job.organizationId, job.jobId, event, {
      context: options.context,
      leaseHolder: options.holder,
      now: options.now,
    });
  }

  /** Stop a job because a control says so. Recorded as a POLICY act, with its command. */
  stopByPolicy(job: BrainExecutorJob, policy: string, now?: Date) {
    return this.jobs.requestCancel(job.organizationId, job.jobId, { actor: { kind: 'POLICY', policy }, reason: 'KILL_SWITCH' }, { now });
  }

  // --- Steps -------------------------------------------------------------------------

  stepState(job: BrainExecutorJob, stepKey: string, inputFingerprint: string) {
    return this.steps.resumeState(job.organizationId, job.jobId, stepKey, inputFingerprint);
  }

  beginStep(
    job: BrainExecutorJob,
    step: { readonly stepKey: string; readonly kind: BrainStepKind; readonly inputFingerprint: string; readonly attempt: number; readonly paid: boolean; readonly now?: Date },
  ) {
    return this.steps.beginAttempt(job.organizationId, job.jobId, step);
  }

  checkpoint(job: BrainExecutorJob, step: { readonly stepKey: string; readonly inputFingerprint: string; readonly payload: BrainSealedPayload; readonly now?: Date }) {
    return this.steps.recordCheckpoint(job.organizationId, job.jobId, step);
  }

  readCheckpoint(job: BrainExecutorJob, ref: BrainCheckpointRef) {
    return this.steps.readCheckpoint(job.organizationId, ref);
  }

  failStep(job: BrainExecutorJob, step: { readonly stepKey: string; readonly inputFingerprint: string; readonly failureClass: string; readonly now?: Date }) {
    return this.steps.recordFailure(job.organizationId, job.jobId, step);
  }

  // --- Waiting for a person ----------------------------------------------------------

  /** Stop and ask the principal a structured question. Only well-formed questions wait. */
  async waitForUser(
    job: BrainExecutorJob,
    request: { readonly question: unknown; readonly expiresAt: Date; readonly context: BrainTransitionContext; readonly holder?: string; readonly now?: Date },
  ) {
    const parsed = parseBrainQuestion(request.question);
    if (!parsed.ok) return { ok: false as const, refusal: 'QUESTION_INVALID' as const, detail: parsed.refusals };
    return this.waits.open(job.organizationId, job.jobId, {
      question: { schemaId: BRAIN_QUESTION_SCHEMA_ID, schemaVersion: BRAIN_QUESTION_SCHEMA_VERSION, body: { ...parsed.question } },
      expiresAt: request.expiresAt,
      context: request.context,
      leaseHolder: request.holder,
      now: request.now,
    });
  }

  resumeAfterReply(job: BrainExecutorJob, request: { readonly waitId: string; readonly responderPermitted: boolean; readonly holder?: string; readonly now?: Date }) {
    return this.waits.resume(job.organizationId, job.jobId, {
      waitId: request.waitId,
      responderPermitted: request.responderPermitted,
      leaseHolder: request.holder,
      now: request.now,
    });
  }

  expireWait(job: BrainExecutorJob, waitId: string, now?: Date) {
    return this.waits.expire(job.organizationId, job.jobId, waitId, { now });
  }

  // --- Usage and provenance ----------------------------------------------------------

  /**
   * Reserve one provider call against the organization's budget before it is made, under
   * the job's call key. The reservation records the job, the step and the specialization
   * policy version, so every paid call is traceable to the Brain work that made it.
   */
  reserveCall(
    job: BrainExecutorJob,
    call: Omit<AiCallReservation, 'organizationId' | 'callKey' | 'brain' | 'callOrdinal'> & {
      readonly stepKey: string;
      readonly attempt: number;
      readonly targetOrdinal: number;
    },
    budget: AiBudgetPolicy,
    activeOrganizations: readonly string[],
  ): Promise<AiReserveResult> {
    const { stepKey, attempt, targetOrdinal, ...rest } = call;
    return this.ledger.reserve(
      {
        ...rest,
        organizationId: job.organizationId,
        callKey: brainCallKey(job.jobId, stepKey, attempt, targetOrdinal),
        callOrdinal: targetOrdinal,
        brain: { jobId: job.jobId, stepKey },
      },
      budget,
      activeOrganizations,
    );
  }

  /** Record what a reserved call actually cost and how it ended. Never another organization's row. */
  reconcileCall(job: BrainExecutorJob, reconciliation: AiInvocationReconcileInput): Promise<boolean> {
    if (!reconciliation.invocationId.startsWith(`${job.jobId}:`)) return Promise.resolve(false);
    return this.ledgerRows.reconcile(job.organizationId, reconciliation);
  }

  // --- The sweeper -------------------------------------------------------------------

  undispatchedCommands(before: Date, limit?: number) {
    return this.references.undispatchedCommands(before, limit);
  }

  expiredWaits(now: Date, limit?: number) {
    return this.references.expiredWaits(now, limit);
  }

  staleLeases(now: Date, limit?: number) {
    return this.references.staleLeases(now, limit);
  }
}
