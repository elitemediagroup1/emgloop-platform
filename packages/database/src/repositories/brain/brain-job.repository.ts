// Brain jobs: acceptance, state, cancellation, leases. Slice B4.
//
// Architecture: docs/architecture/brain-persistence.md §2-§5, brain-execution-infrastructure.md
// §6, §8, §14.
//
// ACCEPTED WORK OUTLIVES WHOEVER ASKED. Acceptance writes the job, its first transition,
// its `brain.job.accepted` event and its START command in one transaction. From then on
// the job is Loop's record: nothing about a browser, a session or a request is stored,
// and nothing here needs one to move the job.
//
// THE SAME REQUEST IS THE SAME JOB. The idempotency key is unique per (organization,
// principal, task). A retried submission returns the job it already created; a different
// submission under a used key is refused. Two simultaneous submissions are settled by
// the unique index, not by a read the database never agreed to.
//
// THE REPOSITORY DOES NOT AUTHORIZE. Deciding whether this person may start this task
// is the Brain API's job (B5), from the session and IAM. What this repository does
// enforce is what a record must never be: work on behalf of somebody who is not an
// active member of the organization, a result owned by an authority the ownership table
// does not allow, a subject the owner does not hold, or a capability route that does
// not exist.
//
// NO PROVIDER, NO MODEL. A job records what the work needs, not who will serve it.
//
// ORGANIZATION FIRST, EVERYWHERE. Every method takes the organization, and a job in
// another organization is not found -- never "forbidden".

import type { PrismaClient } from '@prisma/client';
import {
  BRAIN_EXECUTION_CLASSES,
  brainLeaseDecision,
  brainJobIsTerminal,
  brainOwnershipRule,
  brainSubmissionDecision,
  brainSubmissionFingerprint,
  isAiCapabilityRoute,
  measuredCount,
  parseBrainSubmission,
  type AiCapabilityRoute,
  type BrainCancelRequest,
  type BrainEventActor,
  type BrainExecutionClass,
  type BrainJobSnapshot,
  type BrainJobTransitionEvent,
  type BrainLeaseDecision,
  type BrainResultOwner,
  type BrainResultSubjectType,
  type BrainResultType,
  type BrainSubmission,
  type BrainTransitionContext,
  type Truth,
} from '@emgloop/shared';

import {
  appendBrainEvent,
  applyBrainJobTransition,
  storeBrainCommand,
  type BrainTransitionOutcome,
  type BrainWriteRefusal,
} from './brain-job-writes';
import {
  brainActorOf,
  brainJobSnapshotOf,
  brainResultRefsJson,
  brainSubmissionFingerprintHash,
  brainTaskInputOf,
  isUniqueViolation,
  type BrainTaskInput,
} from './brain-records';

/** What the Brain API hands over once it has decided this person may start this task. */
export interface BrainJobAcceptance {
  readonly principalUserId: string;
  /** Read from the task definition, never from the request. */
  readonly task: {
    readonly taskId: string;
    readonly version: string;
    readonly capabilityRoute: AiCapabilityRoute;
    readonly resultType: BrainResultType;
    readonly resultOwner: BrainResultOwner;
    readonly executionClasses: readonly BrainExecutionClass[];
  };
  /** The parsed submission. Parsed again here: nothing in it may carry authority. */
  readonly submission: BrainSubmission;
  /** A failed or cancelled job of the same task whose checkpoints this one reuses. */
  readonly resumesJobId?: string | null;
  readonly now?: Date;
}

export const BRAIN_ACCEPT_REFUSALS = [
  'INVALID_SUBMISSION',
  'UNKNOWN_CAPABILITY_ROUTE',
  'OWNERSHIP_NOT_PERMITTED',
  'SUBJECT_TYPE_MISMATCH',
  'EXECUTION_CLASS_NOT_SUPPORTED',
  'PRINCIPAL_NOT_ACTIVE_MEMBER',
  'RESUMED_JOB_NOT_RESUMABLE',
  'IDEMPOTENCY_KEY_REUSED',
] as const;
export type BrainAcceptRefusal = (typeof BRAIN_ACCEPT_REFUSALS)[number];

export type BrainAcceptOutcome =
  | { readonly kind: 'ACCEPTED'; readonly job: BrainJobSnapshot; readonly commandId: string; readonly eventId: string }
  | { readonly kind: 'EXISTING'; readonly job: BrainJobSnapshot }
  | { readonly kind: 'REFUSED'; readonly refusal: BrainAcceptRefusal };

/** A job as Loop records it: the contract snapshot plus the record-keeping around it. */
export interface BrainJobRecord {
  readonly job: BrainJobSnapshot;
  readonly version: number;
  readonly lastSequence: number;
  readonly acceptedAt: Date;
  readonly startedAt: Date | null;
  readonly endedAt: Date | null;
  readonly promotedAt: Date | null;
  readonly activeElapsedMs: number;
  readonly lease: { readonly holder: string; readonly expiresAt: Date } | null;
}

export interface BrainTransitionRecord {
  readonly sequence: number;
  readonly kind: string;
  readonly fromState: string | null;
  readonly toState: string;
  readonly executionClass: string;
  readonly actor: BrainEventActor;
  readonly reason: string | null;
  readonly waitId: string | null;
  readonly occurredAt: Date;
}

export type BrainLeaseOutcome =
  | { readonly ok: true; readonly decision: Exclude<BrainLeaseDecision, { action: 'BUSY' }>; readonly expiresAt: Date }
  | { readonly ok: false; readonly reason: 'JOB_NOT_FOUND' | 'GENERATION_MISMATCH' | 'JOB_IS_TERMINAL' | 'VERSION_CONFLICT' }
  | { readonly ok: false; readonly reason: 'BUSY'; readonly holder: string; readonly retryAfterMs: number };

export type BrainCancelOutcome =
  | { readonly ok: true; readonly job: BrainJobSnapshot; readonly commandId: string; readonly stoppedNow: boolean }
  | { readonly ok: false; readonly refusal: BrainWriteRefusal };

const LEASE_HOLDER = /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,199}$/;

export class BrainJobRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Record accepted work, or return the job this same request already created.
   * Everything is written in one transaction: job, first transition, accepted event and
   * START command.
   */
  async accept(organizationId: string, input: BrainJobAcceptance): Promise<BrainAcceptOutcome> {
    const parsed = parseBrainSubmission(input.submission);
    if (!parsed.ok) return refused('INVALID_SUBMISSION');
    const submission = parsed.submission;
    const task = input.task;
    if (!isAiCapabilityRoute(task.capabilityRoute)) return refused('UNKNOWN_CAPABILITY_ROUTE');
    const rule = brainOwnershipRule(task.resultType, task.resultOwner);
    if (!rule) return refused('OWNERSHIP_NOT_PERMITTED');
    if (submission.subject.type !== rule.subjectType || submission.taskId !== task.taskId) return refused('SUBJECT_TYPE_MISMATCH');
    if (
      !task.executionClasses.includes(submission.executionClass) ||
      !(BRAIN_EXECUTION_CLASSES as readonly string[]).includes(submission.executionClass)
    ) {
      return refused('EXECUTION_CLASS_NOT_SUPPORTED');
    }

    const now = input.now ?? new Date();
    const fingerprint = brainSubmissionFingerprintHash(
      brainSubmissionFingerprint({ organizationId, userId: input.principalUserId }, submission),
    );
    const key = { organizationId, principalUserId: input.principalUserId, taskId: task.taskId, idempotencyKey: submission.idempotencyKey };

    const existingDecision = async (db: Pick<PrismaClient, 'brainJob'>): Promise<BrainAcceptOutcome | null> => {
      const existing = await db.brainJob.findFirst({ where: key });
      const decision = brainSubmissionDecision(
        existing ? { jobId: existing.id, fingerprint: existing.submissionFingerprint } : null,
        fingerprint,
      );
      if (decision.kind === 'RETURN_EXISTING') return { kind: 'EXISTING', job: brainJobSnapshotOf(existing!) };
      if (decision.kind === 'REFUSE') return refused('IDEMPOTENCY_KEY_REUSED');
      return null;
    };

    try {
      return await this.prisma.$transaction(async (tx) => {
        const settled = await existingDecision(tx);
        if (settled) return settled;

        const member = await tx.organizationMembership.findFirst({
          where: { organizationId, userId: input.principalUserId, status: 'ACTIVE' },
          select: { id: true },
        });
        if (!member) return refused('PRINCIPAL_NOT_ACTIVE_MEMBER');

        if (input.resumesJobId) {
          const previous = await tx.brainJob.findFirst({
            where: { id: input.resumesJobId, organizationId, taskId: task.taskId, state: { in: ['FAILED', 'CANCELLED'] } },
            select: { id: true },
          });
          if (!previous) return refused('RESUMED_JOB_NOT_RESUMABLE');
        }

        const created = await tx.brainJob.create({
          data: {
            organizationId,
            principalUserId: input.principalUserId,
            taskId: task.taskId,
            taskVersion: task.version,
            capabilityRoute: task.capabilityRoute,
            resultType: task.resultType,
            resultOwnerAuthority: rule.authority,
            resultSubjectType: rule.subjectType,
            resultSubjectId: submission.subject.id,
            executionClass: submission.executionClass,
            state: 'ACCEPTED',
            generation: 1,
            version: 0,
            lastSequence: 1,
            resultRefs: brainResultRefsJson([]),
            input: { ...submission.input },
            idempotencyKey: submission.idempotencyKey,
            submissionFingerprint: fingerprint,
            resumesJobId: input.resumesJobId ?? null,
            acceptedAt: now,
          },
        });
        const job = brainJobSnapshotOf(created);
        const principal: BrainEventActor = { kind: 'HUMAN', userId: input.principalUserId };
        await tx.brainJobTransition.create({
          data: {
            organizationId,
            jobId: job.jobId,
            sequence: 1,
            kind: 'ACCEPTED',
            fromState: null,
            toState: 'ACCEPTED',
            executionClass: job.executionClass,
            actorKind: 'HUMAN',
            actorUserId: input.principalUserId,
            actorPolicy: null,
            reason: null,
            waitId: null,
            occurredAt: now,
          },
          select: { id: true },
        });
        const eventId = await appendBrainEvent(
          tx,
          {
            name: 'brain.job.accepted',
            organizationId,
            jobId: job.jobId,
            taskId: job.taskId,
            resultType: job.resultType,
            occurredAt: now.toISOString(),
            actor: principal,
            resultRefs: [],
            reason: null,
          },
          1,
        );
        const command = await storeBrainCommand(tx, organizationId, {
          type: 'START',
          jobId: job.jobId,
          generation: job.generation,
          waitId: null,
          issuedBy: principal,
          now,
        });
        return { kind: 'ACCEPTED' as const, job, commandId: command.commandId, eventId };
      });
    } catch (err) {
      // A simultaneous identical submission won the unique index. Its job is the answer.
      if (!isUniqueViolation(err)) throw err;
      const settled = await existingDecision(this.prisma);
      if (settled) return settled;
      throw err;
    }
  }

  async get(organizationId: string, jobId: string): Promise<BrainJobRecord | null> {
    const row = await this.prisma.brainJob.findFirst({ where: { id: jobId, organizationId } });
    if (!row) return null;
    return {
      job: brainJobSnapshotOf(row),
      version: row.version,
      lastSequence: row.lastSequence,
      acceptedAt: row.acceptedAt,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      promotedAt: row.promotedAt,
      activeElapsedMs: row.activeElapsedMs,
      lease: row.leaseHolder && row.leaseExpiresAt ? { holder: row.leaseHolder, expiresAt: row.leaseExpiresAt } : null,
    };
  }

  /** The task parameters the job was accepted with. Read by its executor at each step. */
  async input(organizationId: string, jobId: string): Promise<BrainTaskInput | null> {
    const row = await this.prisma.brainJob.findFirst({ where: { id: jobId, organizationId }, select: { input: true } });
    return row ? brainTaskInputOf(row.input) : null;
  }

  /**
   * "Brain - N working": this person's unfinished jobs, from Loop's records. A measured
   * count, so "nothing is running" and "this was not read" never look the same.
   */
  async countUnfinishedForPrincipal(organizationId: string, principalUserId: string): Promise<Truth<number>> {
    const value = await this.prisma.brainJob.count({
      where: { organizationId, principalUserId, state: { in: ['ACCEPTED', 'QUEUED', 'RUNNING', 'WAITING_FOR_USER'] } },
    });
    return measuredCount(value, { measuredAt: new Date().toISOString(), subject: 'brain.jobs.unfinished' });
  }

  /** The jobs about one subject, newest first: "Brain is working on this". */
  async listForSubject(
    organizationId: string,
    subject: { readonly type: BrainResultSubjectType; readonly id: string },
    options: { readonly unfinishedOnly?: boolean; readonly limit?: number } = {},
  ): Promise<BrainJobSnapshot[]> {
    const rows = await this.prisma.brainJob.findMany({
      where: {
        organizationId,
        resultSubjectType: subject.type,
        resultSubjectId: subject.id,
        ...(options.unfinishedOnly ? { state: { in: ['ACCEPTED', 'QUEUED', 'RUNNING', 'WAITING_FOR_USER'] } } : {}),
      },
      orderBy: [{ acceptedAt: 'desc' }, { id: 'desc' }],
      take: Math.min(Math.max(options.limit ?? 20, 1), 100),
    });
    return rows.map(brainJobSnapshotOf);
  }

  async transitions(organizationId: string, jobId: string): Promise<BrainTransitionRecord[]> {
    const rows = await this.prisma.brainJobTransition.findMany({ where: { organizationId, jobId }, orderBy: { sequence: 'asc' } });
    return rows.map((r) => ({
      sequence: r.sequence,
      kind: r.kind,
      fromState: r.fromState,
      toState: r.toState,
      executionClass: r.executionClass,
      actor: brainActorOf(r.actorKind, r.actorUserId, r.actorPolicy),
      reason: r.reason,
      waitId: r.waitId,
      occurredAt: r.occurredAt,
    }));
  }

  /**
   * Apply one transition decided by the contract. For the executor: DISPATCHED, STARTED,
   * PROMOTED, CANCEL_SETTLED, RESULT_COMMITTED, FAILED. Waits and cancellation have
   * their own methods, because they write more than the job.
   */
  async transition(
    organizationId: string,
    jobId: string,
    event: Extract<BrainJobTransitionEvent, { type: 'DISPATCHED' | 'STARTED' | 'PROMOTED' | 'CANCEL_SETTLED' | 'RESULT_COMMITTED' | 'FAILED' }>,
    options: {
      readonly context: BrainTransitionContext;
      readonly actor?: BrainEventActor;
      readonly expectedVersion?: number;
      readonly leaseHolder?: string;
      readonly now?: Date;
    },
  ): Promise<BrainTransitionOutcome> {
    return this.prisma.$transaction((tx) =>
      applyBrainJobTransition(tx, organizationId, jobId, {
        event,
        context: options.context,
        actor: options.actor ?? { kind: 'SYSTEM' },
        now: options.now ?? new Date(),
        expectedVersion: options.expectedVersion,
        leaseHolder: options.leaseHolder,
      }),
    );
  }

  /**
   * Ask a job to stop. Idle work (accepted, queued, waiting) stops at once; running work
   * stops at its next boundary. A CANCEL command is stored either way -- once -- so the
   * executor clears anything it scheduled. A job that already ended is refused.
   */
  async requestCancel(
    organizationId: string,
    jobId: string,
    request: BrainCancelRequest,
    options: { readonly now?: Date } = {},
  ): Promise<BrainCancelOutcome> {
    const now = options.now ?? new Date();
    return this.prisma.$transaction(async (tx) => {
      const outcome = await applyBrainJobTransition(tx, organizationId, jobId, {
        event: { type: 'CANCEL_REQUESTED', request },
        context: { supportsDurable: false, taskMayWait: false },
        actor: request.actor,
        now,
      });
      if (!outcome.ok) return { ok: false as const, refusal: outcome.refusal };
      // The first request stands, and so does its command.
      const issuer = outcome.job.cancelRequest?.actor ?? request.actor;
      const command = await storeBrainCommand(tx, organizationId, {
        type: 'CANCEL',
        jobId,
        generation: outcome.job.generation,
        waitId: null,
        issuedBy: issuer,
        now,
      });
      return { ok: true as const, job: outcome.job, commandId: command.commandId, stoppedNow: brainJobIsTerminal(outcome.job.state) };
    });
  }

  /**
   * Take, renew or take over the job's lease, as `brainLeaseDecision` allows, with a
   * write conditional on the version read -- so two workers racing on the same expired
   * lease cannot both win.
   */
  async lease(
    organizationId: string,
    jobId: string,
    request: { readonly holder: string; readonly generation: number; readonly durationMs: number; readonly now?: Date },
  ): Promise<BrainLeaseOutcome> {
    if (!LEASE_HOLDER.test(request.holder)) throw new Error('invalid lease holder');
    if (!(request.durationMs > 0)) throw new Error('lease duration must be positive');
    const now = request.now ?? new Date();
    const row = await this.prisma.brainJob.findFirst({
      where: { id: jobId, organizationId },
      select: { version: true, generation: true, state: true, leaseHolder: true, leaseExpiresAt: true },
    });
    if (!row) return { ok: false, reason: 'JOB_NOT_FOUND' };
    if (row.generation !== request.generation) return { ok: false, reason: 'GENERATION_MISMATCH' };
    if (brainJobIsTerminal(row.state as BrainJobSnapshot['state'])) return { ok: false, reason: 'JOB_IS_TERMINAL' };
    const current = row.leaseHolder && row.leaseExpiresAt ? { holder: row.leaseHolder, expiresAtMs: row.leaseExpiresAt.getTime() } : null;
    const decision = brainLeaseDecision(current, request.holder, now.getTime());
    if (decision.action === 'BUSY') return { ok: false, reason: 'BUSY', holder: decision.holder, retryAfterMs: decision.retryAfterMs };
    const expiresAt = new Date(now.getTime() + request.durationMs);
    const updated = await this.prisma.brainJob.updateMany({
      where: { id: jobId, organizationId, version: row.version, generation: request.generation },
      data: { leaseHolder: request.holder, leaseExpiresAt: expiresAt, version: { increment: 1 } },
    });
    if (updated.count !== 1) return { ok: false, reason: 'VERSION_CONFLICT' };
    return { ok: true, decision, expiresAt };
  }

  /** Give the lease back. Only its holder can. */
  async releaseLease(organizationId: string, jobId: string, holder: string): Promise<boolean> {
    const updated = await this.prisma.brainJob.updateMany({
      where: { id: jobId, organizationId, leaseHolder: holder },
      data: { leaseHolder: null, leaseExpiresAt: null, version: { increment: 1 } },
    });
    return updated.count === 1;
  }

  /** Add executing time (never waiting time) to the job, as its lease holder. */
  async addActiveTime(organizationId: string, jobId: string, holder: string, elapsedMs: number): Promise<boolean> {
    if (!Number.isInteger(elapsedMs) || elapsedMs < 0) throw new Error('elapsed time is a non-negative whole number of milliseconds');
    const updated = await this.prisma.brainJob.updateMany({
      where: { id: jobId, organizationId, leaseHolder: holder },
      data: { activeElapsedMs: { increment: elapsedMs } },
    });
    return updated.count === 1;
  }
}

function refused(refusal: BrainAcceptRefusal): BrainAcceptOutcome {
  return { kind: 'REFUSED', refusal };
}
