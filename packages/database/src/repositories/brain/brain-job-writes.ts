// The one write path that moves a Brain job. Slice B4.
//
// Architecture: docs/architecture/brain-persistence.md §3.
//
// EVERY STATE CHANGE IS FOUR WRITES OR NONE. The job row, its next transition, the
// event Activity may read, and any wait the change closes are written in the caller's
// transaction. A job is never RUNNING without the history that says so, and an event is
// never published for a change that did not happen.
//
// ONE WRITER AT A TIME, PROVABLY. The job update is conditional on the version the
// writer read. Two writers that read the same version cannot both succeed: the second
// finds nothing to update and gets VERSION_CONFLICT, and re-reads before deciding again.
// The job row is updated FIRST, so its row lock also serializes the child writes.
//
// A COMMAND IS STORED ONCE. `storeBrainCommand` inserts under `brainCommandDedupeKey`
// with ON CONFLICT DO NOTHING and reads back what is stored, so a repeated request, a
// retried transaction or two people pressing Stop together all return the same command.
//
// ORGANIZATION FIRST. Every function takes the organization and scopes every read and
// write by it; a job in another organization is simply not found.

import {
  BRAIN_JOB_EVENT_NAMES,
  brainCommandDedupeKey,
  brainEventId,
  brainJobEventRefusals,
  brainJobTransition,
  type BrainCommand,
  type BrainCommandType,
  type BrainEventActor,
  type BrainJobEvent,
  type BrainJobEventName,
  type BrainJobSnapshot,
  type BrainJobTransitionEvent,
  type BrainResultRef,
  type BrainTransitionContext,
  type BrainTransitionRefusal,
} from '@emgloop/shared';

import {
  BrainPersistenceInvariantError,
  brainActorColumns,
  brainCommandOf,
  brainJobChanges,
  brainJobSnapshotOf,
  brainResultRefsJson,
  type BrainDb,
} from './brain-records';

export interface BrainTransitionWrite {
  readonly event: BrainJobTransitionEvent;
  readonly context: BrainTransitionContext;
  /** Who caused the change. Recorded on the transition and on any event. */
  readonly actor: BrainEventActor;
  readonly now: Date;
  /** When set, the write succeeds only against exactly this version of the job. */
  readonly expectedVersion?: number;
  /** When set, the writer must hold the job's unexpired lease under this name. */
  readonly leaseHolder?: string;
}

export type BrainWriteRefusal = BrainTransitionRefusal | 'JOB_NOT_FOUND' | 'VERSION_CONFLICT' | 'LEASE_NOT_HELD';

export type BrainTransitionOutcome =
  | {
      readonly ok: true;
      readonly job: BrainJobSnapshot;
      readonly version: number;
      /** False when the decision left the job exactly as it was; nothing was written. */
      readonly changed: boolean;
      readonly sequence: number | null;
      readonly eventId: string | null;
    }
  | { readonly ok: false; readonly refusal: BrainWriteRefusal };

/**
 * Decide and record one transition of a job in `organizationId`. The caller owns the
 * transaction; this function never commits on its own.
 */
export async function applyBrainJobTransition(
  db: BrainDb,
  organizationId: string,
  jobId: string,
  write: BrainTransitionWrite,
): Promise<BrainTransitionOutcome> {
  const row = await db.brainJob.findFirst({ where: { id: jobId, organizationId } });
  if (!row) return { ok: false, refusal: 'JOB_NOT_FOUND' };
  if (write.expectedVersion !== undefined && row.version !== write.expectedVersion) return { ok: false, refusal: 'VERSION_CONFLICT' };
  if (
    write.leaseHolder !== undefined &&
    !(row.leaseHolder === write.leaseHolder && row.leaseExpiresAt !== null && row.leaseExpiresAt.getTime() > write.now.getTime())
  ) {
    return { ok: false, refusal: 'LEASE_NOT_HELD' };
  }

  const before = brainJobSnapshotOf(row);
  const decided = brainJobTransition(before, write.event, write.context);
  if (!decided.ok) return { ok: false, refusal: decided.refusal };
  const data = brainJobChanges(before, decided.job, write.now);
  if (Object.keys(data).length === 0) {
    return { ok: true, job: before, version: row.version, changed: false, sequence: null, eventId: null };
  }

  const sequence = row.lastSequence + 1;
  const updated = await db.brainJob.updateMany({
    where: { id: jobId, organizationId, version: row.version },
    data: { ...data, version: { increment: 1 }, lastSequence: sequence },
  });
  if (updated.count !== 1) return { ok: false, refusal: 'VERSION_CONFLICT' };

  const after = decided.job;
  const actor = brainActorColumns(write.actor);
  await db.brainJobTransition.create({
    data: {
      organizationId,
      jobId,
      sequence,
      kind: write.event.type,
      fromState: before.state,
      toState: after.state,
      executionClass: after.executionClass,
      actorKind: actor.kind,
      actorUserId: actor.userId,
      actorPolicy: actor.policy,
      reason: transitionReason(write.event, after),
      waitId: transitionWaitId(write.event, before),
      occurredAt: write.now,
    },
    select: { id: true },
  });

  // A question the job is no longer waiting on is closed with the change that ended it.
  if (before.wait && !after.wait && write.event.type !== 'USER_INPUT_RECEIVED') {
    const expired = write.event.type === 'WAIT_EXPIRED';
    await db.brainJobWait.updateMany({
      where: { id: before.wait.waitId, organizationId, jobId, status: 'OPEN' },
      data: { status: expired ? 'EXPIRED' : 'CLOSED', openJobKey: null, closedAt: write.now },
    });
  }

  let eventId: string | null = null;
  if (decided.emits) {
    eventId = await appendBrainEvent(db, {
      name: decided.emits,
      organizationId,
      jobId,
      taskId: after.taskId,
      resultType: after.resultType,
      occurredAt: write.now.toISOString(),
      actor: write.actor,
      resultRefs: decided.emits === 'brain.job.succeeded' ? after.resultRefs : [],
      reason: decided.emits === 'brain.job.failed' || decided.emits === 'brain.job.cancelled' ? after.endReason : null,
    }, sequence);
  }
  return { ok: true, job: after, version: row.version + 1, changed: true, sequence, eventId };
}

function transitionReason(event: BrainJobTransitionEvent, after: BrainJobSnapshot): string | null {
  switch (event.type) {
    case 'FAILED':
      return event.reason;
    case 'CANCEL_REQUESTED':
      return event.request.reason;
    case 'WAIT_EXPIRED':
    case 'CANCEL_SETTLED':
      return after.endReason;
    default:
      return null;
  }
}

function transitionWaitId(event: BrainJobTransitionEvent, before: BrainJobSnapshot): string | null {
  switch (event.type) {
    case 'USER_INPUT_REQUESTED':
      return event.wait.waitId;
    case 'USER_INPUT_RECEIVED':
    case 'WAIT_EXPIRED':
      return event.waitId;
    default:
      return before.wait?.waitId ?? null;
  }
}

/**
 * Record an event under the identity of the transition it reports. The event is
 * checked against the contract's allowlist first: a pointer, never a payload, and
 * never an owner.
 */
export async function appendBrainEvent(db: BrainDb, event: BrainJobEvent, sequence: number): Promise<string> {
  const refusals = brainJobEventRefusals(event as unknown as Record<string, unknown>);
  if (refusals.length > 0) throw new BrainPersistenceInvariantError(`event refused: ${refusals.join(',')}`);
  if (!(BRAIN_JOB_EVENT_NAMES as readonly BrainJobEventName[]).includes(event.name)) {
    throw new BrainPersistenceInvariantError('unknown event');
  }
  const id = brainEventId(event.jobId, sequence);
  const actor = brainActorColumns(event.actor);
  await db.brainEvent.create({
    data: {
      id,
      organizationId: event.organizationId,
      jobId: event.jobId,
      sequence,
      name: event.name,
      taskId: event.taskId,
      resultType: event.resultType,
      occurredAt: new Date(event.occurredAt),
      actorKind: actor.kind,
      actorUserId: actor.userId,
      actorPolicy: actor.policy,
      resultRefs: brainResultRefsJson(event.resultRefs as readonly BrainResultRef[]),
      reason: event.reason,
    },
    select: { id: true },
  });
  return id;
}

export interface BrainCommandWrite {
  readonly type: BrainCommandType;
  readonly jobId: string;
  readonly generation: number;
  readonly waitId: string | null;
  readonly issuedBy: BrainEventActor;
  readonly now: Date;
}

/**
 * Store a command once. Returns the stored command -- this call's, or the one an earlier
 * identical request already stored. Never raises on a duplicate, so it is safe inside a
 * transaction.
 */
export async function storeBrainCommand(db: BrainDb, organizationId: string, write: BrainCommandWrite): Promise<BrainCommand> {
  const dedupeKey = brainCommandDedupeKey(write);
  const issuer = brainActorColumns(write.issuedBy);
  await db.brainCommand.createMany({
    data: [
      {
        organizationId,
        jobId: write.jobId,
        type: write.type,
        generation: write.generation,
        waitId: write.waitId,
        dedupeKey,
        issuerKind: issuer.kind,
        issuerUserId: issuer.userId,
        issuerPolicy: issuer.policy,
        issuedAt: write.now,
      },
    ],
    skipDuplicates: true,
  });
  const stored = await db.brainCommand.findFirst({ where: { organizationId, dedupeKey } });
  if (!stored) throw new BrainPersistenceInvariantError('a stored command could not be read back');
  return brainCommandOf(stored);
}
