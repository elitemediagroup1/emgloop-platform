// WAITING_FOR_USER: the questions a durable job asks, and the one reply each accepts.
// Slice B4.
//
// Architecture: docs/architecture/brain-execution-infrastructure.md §11 and
// docs/architecture/brain-persistence.md §6.
//
// A WAIT HOLDS NOTHING RUNNING. Opening one moves the job to WAITING_FOR_USER in the same
// transaction that stores the question. Nothing is scheduled, nothing is billed, and the
// job survives a closed browser, a logout and a lost network for as long as the question
// stays open -- it is a row, not a connection.
//
// ONLY THE PRINCIPAL ANSWERS, ONCE (V1). `brainWaitReplyDecision` decides; this
// repository records the reply with a write conditional on the wait still being OPEN,
// and stores the RESUME command beside it. The same reply sent twice returns what was
// recorded. The job itself does not move until its executor re-decides access and
// resumes it -- recording a reply wakes nothing on its own.
//
// A LATE REPLY IS REFUSED. Expiry is a transition like any other, and it closes the
// wait in the same transaction.
//
// CONTENT. The question is the minimal structured question, the reply the validated
// reply. Neither is context, evidence or a model transcript, and both are bounded.

import { randomUUID } from 'crypto';
import type { PrismaClient } from '@prisma/client';
import {
  brainWaitExpiryDue,
  brainWaitReplyDecision,
  type BrainEventActor,
  type BrainJobSnapshot,
  type BrainTransitionContext,
  type BrainWaitRecord,
  type BrainWaitReplyRefusal,
} from '@emgloop/shared';

import { applyBrainJobTransition, storeBrainCommand, type BrainWriteRefusal } from './brain-job-writes';
import {
  brainCanonicalFingerprint,
  brainJobSnapshotOf,
  brainWaitJsonOf,
  brainWaitRecordOf,
} from './brain-records';

export interface BrainWaitQuestion {
  readonly schemaId: string;
  readonly schemaVersion: string;
  /** The minimal structured question, as a plain JSON object. */
  readonly body: Record<string, unknown>;
}

export type BrainWaitOpenOutcome =
  | { readonly ok: true; readonly job: BrainJobSnapshot; readonly waitId: string }
  | { readonly ok: false; readonly refusal: BrainWriteRefusal | 'EXPIRY_NOT_IN_FUTURE' };

export type BrainWaitAnswerOutcome =
  | { readonly ok: true; readonly recorded: 'NOW' | 'ALREADY'; readonly commandId: string }
  | { readonly ok: false; readonly refusal: BrainWaitReplyRefusal | 'REPLY_CONFLICT' };

export type BrainWaitExpireOutcome =
  | { readonly ok: true; readonly job: BrainJobSnapshot }
  | { readonly ok: false; readonly refusal: BrainWriteRefusal | 'WAIT_NOT_FOUND' | 'NOT_YET_EXPIRED' };

export type BrainWaitResumeOutcome =
  | { readonly ok: true; readonly job: BrainJobSnapshot; readonly reply: Record<string, unknown> }
  | { readonly ok: false; readonly refusal: BrainWriteRefusal | 'WAIT_NOT_FOUND' | 'REPLY_NOT_RECORDED' };

export interface BrainWaitView {
  readonly wait: BrainWaitRecord;
  readonly question: BrainWaitQuestion;
  readonly requestedAt: Date;
  readonly answeredAt: Date | null;
  readonly closedAt: Date | null;
}

export class BrainWaitRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /** Stop a running durable job to ask its principal something. */
  async open(
    organizationId: string,
    jobId: string,
    request: {
      readonly question: BrainWaitQuestion;
      readonly expiresAt: Date;
      readonly context: BrainTransitionContext;
      readonly expectedVersion?: number;
      readonly leaseHolder?: string;
      readonly now?: Date;
    },
  ): Promise<BrainWaitOpenOutcome> {
    const now = request.now ?? new Date();
    if (!(request.expiresAt.getTime() > now.getTime())) return { ok: false, refusal: 'EXPIRY_NOT_IN_FUTURE' };
    const body = brainWaitJsonOf(request.question.body, 'question');
    const waitId = `wait_${randomUUID().replace(/-/g, '')}`;
    return this.prisma.$transaction(async (tx) => {
      const outcome = await applyBrainJobTransition(tx, organizationId, jobId, {
        event: { type: 'USER_INPUT_REQUESTED', wait: { waitId, expiresAtMs: request.expiresAt.getTime() } },
        context: request.context,
        actor: { kind: 'SYSTEM' },
        now,
        expectedVersion: request.expectedVersion,
        leaseHolder: request.leaseHolder,
      });
      if (!outcome.ok) return { ok: false as const, refusal: outcome.refusal };
      await tx.brainJobWait.create({
        data: {
          id: waitId,
          organizationId,
          jobId,
          principalUserId: outcome.job.principalUserId,
          status: 'OPEN',
          openJobKey: jobId,
          questionSchemaId: request.question.schemaId,
          questionSchemaVersion: request.question.schemaVersion,
          question: body,
          expiresAt: request.expiresAt,
          requestedAt: now,
        },
        select: { id: true },
      });
      return { ok: true as const, job: outcome.job, waitId };
    });
  }

  /**
   * Record a person's reply. The Brain API has already re-checked their access and
   * validated the reply against the question's schema.
   */
  async answer(
    organizationId: string,
    request: { readonly waitId: string; readonly responderUserId: string; readonly reply: Record<string, unknown>; readonly now?: Date },
  ): Promise<BrainWaitAnswerOutcome> {
    const now = request.now ?? new Date();
    const reply = brainWaitJsonOf(request.reply, 'reply');
    const replyFingerprint = brainCanonicalFingerprint(reply);
    return this.prisma.$transaction(async (tx) => {
      const waitRow = await tx.brainJobWait.findFirst({ where: { id: request.waitId, organizationId } });
      const jobRow = waitRow ? await tx.brainJob.findFirst({ where: { id: waitRow.jobId, organizationId } }) : null;
      const job = jobRow ? brainJobSnapshotOf(jobRow) : null;
      const wait = waitRow ? brainWaitRecordOf(waitRow) : null;
      const decision = brainWaitReplyDecision(
        job,
        wait,
        { waitId: request.waitId, responderUserId: request.responderUserId, replyFingerprint },
        now.getTime(),
      );
      if (decision.action === 'REFUSE') return { ok: false as const, refusal: decision.refusal };
      if (decision.action === 'RECORD') {
        const updated = await tx.brainJobWait.updateMany({
          where: { id: request.waitId, organizationId, status: 'OPEN' },
          data: {
            status: 'ANSWERED',
            openJobKey: null,
            responderUserId: request.responderUserId,
            reply,
            replyFingerprint,
            answeredAt: now,
          },
        });
        // Somebody answered between the read and the write. The caller retries and the
        // decision then sees what was recorded.
        if (updated.count !== 1) return { ok: false as const, refusal: 'REPLY_CONFLICT' as const };
      }
      const issuedBy: BrainEventActor = { kind: 'HUMAN', userId: request.responderUserId };
      const command = await storeBrainCommand(tx, organizationId, {
        type: 'RESUME',
        jobId: job!.jobId,
        generation: job!.generation,
        waitId: request.waitId,
        issuedBy,
        now,
      });
      return { ok: true as const, recorded: decision.action === 'RECORD' ? ('NOW' as const) : ('ALREADY' as const), commandId: command.commandId };
    });
  }

  /** Close an unanswered question whose time has passed; the job ends as WAIT_EXPIRED. */
  async expire(
    organizationId: string,
    jobId: string,
    waitId: string,
    options: { readonly now?: Date; readonly actor?: BrainEventActor } = {},
  ): Promise<BrainWaitExpireOutcome> {
    const now = options.now ?? new Date();
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.brainJobWait.findFirst({ where: { id: waitId, organizationId, jobId } });
      if (!row) return { ok: false as const, refusal: 'WAIT_NOT_FOUND' as const };
      if (!brainWaitExpiryDue(brainWaitRecordOf(row), now.getTime())) return { ok: false as const, refusal: 'NOT_YET_EXPIRED' as const };
      const outcome = await applyBrainJobTransition(tx, organizationId, jobId, {
        event: { type: 'WAIT_EXPIRED', waitId },
        context: { supportsDurable: true, taskMayWait: true },
        actor: options.actor ?? { kind: 'SYSTEM' },
        now,
      });
      if (!outcome.ok) return { ok: false as const, refusal: outcome.refusal };
      return { ok: true as const, job: outcome.job };
    });
  }

  /**
   * Continue a job whose question was answered. The executor calls this after re-deciding
   * the principal's access (`responderPermitted`); the reply is read here, never carried.
   */
  async resume(
    organizationId: string,
    jobId: string,
    request: {
      readonly waitId: string;
      readonly responderPermitted: boolean;
      readonly expectedVersion?: number;
      readonly leaseHolder?: string;
      readonly now?: Date;
    },
  ): Promise<BrainWaitResumeOutcome> {
    const now = request.now ?? new Date();
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.brainJobWait.findFirst({ where: { id: request.waitId, organizationId, jobId } });
      if (!row) return { ok: false as const, refusal: 'WAIT_NOT_FOUND' as const };
      if (row.status !== 'ANSWERED' || row.reply === null) return { ok: false as const, refusal: 'REPLY_NOT_RECORDED' as const };
      // A responder whose account was deleted reads as nobody, and nobody is the principal.
      const responderUserId = row.responderUserId ?? '';
      const outcome = await applyBrainJobTransition(tx, organizationId, jobId, {
        event: { type: 'USER_INPUT_RECEIVED', waitId: request.waitId, responderUserId },
        context: { supportsDurable: true, taskMayWait: true, responderPermitted: request.responderPermitted },
        actor: responderUserId ? { kind: 'HUMAN', userId: responderUserId } : { kind: 'SYSTEM' },
        now,
        expectedVersion: request.expectedVersion,
        leaseHolder: request.leaseHolder,
      });
      if (!outcome.ok) return { ok: false as const, refusal: outcome.refusal };
      return { ok: true as const, job: outcome.job, reply: row.reply as Record<string, unknown> };
    });
  }

  /** A wait and its question, for the person it asks. Never another organization's. */
  async get(organizationId: string, waitId: string): Promise<BrainWaitView | null> {
    const row = await this.prisma.brainJobWait.findFirst({ where: { id: waitId, organizationId } });
    if (!row) return null;
    return {
      wait: brainWaitRecordOf(row),
      question: { schemaId: row.questionSchemaId, schemaVersion: row.questionSchemaVersion, body: row.question as Record<string, unknown> },
      requestedAt: row.requestedAt,
      answeredAt: row.answeredAt,
      closedAt: row.closedAt,
    };
  }
}
