// Brain commands and Brain events: what moves a job, and what it told Loop. Slice B4.
//
// Architecture: docs/architecture/brain-persistence.md §5 and §6.
//
// COMMANDS ARE WRITTEN WITH THE CHANGE THEY ACCOMPANY (acceptance, a reply, a cancel),
// never on their own, so this repository only reads them and records that one was handed
// to the executor. Marking a dispatch is idempotent: the first dispatch time is kept, and
// every hand-over is counted.
//
// EVENTS ARE POINTERS. A Brain event says that a job changed state, who caused it and
// where results now live. Activity reads them as a source; it never holds the result and
// never becomes its owner. The rows carry the contract's allowlisted fields and nothing
// else.

import type { PrismaClient } from '@prisma/client';
import {
  BRAIN_JOB_EVENT_NAMES,
  BRAIN_RESULT_TYPES,
  type BrainCommand,
  type BrainJobEvent,
  type BrainJobEventName,
  type BrainResultType,
} from '@emgloop/shared';

import { BrainRecordUnreadable, brainActorOf, brainCommandOf, brainResultRefsOf } from './brain-records';

export interface BrainCommandRecord {
  readonly command: BrainCommand;
  readonly dispatchedAt: Date | null;
  readonly lastDispatchedAt: Date | null;
  readonly dispatchCount: number;
}

/** A stored event, with the identity Activity pages by. */
export interface BrainEventRecord {
  readonly eventId: string;
  readonly sequence: number;
  readonly event: BrainJobEvent;
  readonly recordedAt: Date;
}

export class BrainCommandRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async get(organizationId: string, commandId: string): Promise<BrainCommandRecord | null> {
    const row = await this.prisma.brainCommand.findFirst({ where: { id: commandId, organizationId } });
    if (!row) return null;
    return { command: brainCommandOf(row), dispatchedAt: row.dispatchedAt, lastDispatchedAt: row.lastDispatchedAt, dispatchCount: row.dispatchCount };
  }

  async listForJob(organizationId: string, jobId: string): Promise<BrainCommandRecord[]> {
    const rows = await this.prisma.brainCommand.findMany({ where: { organizationId, jobId }, orderBy: [{ issuedAt: 'asc' }, { id: 'asc' }] });
    return rows.map((row) => ({
      command: brainCommandOf(row),
      dispatchedAt: row.dispatchedAt,
      lastDispatchedAt: row.lastDispatchedAt,
      dispatchCount: row.dispatchCount,
    }));
  }

  /**
   * Record that a command was handed to the executor. Safe to repeat. The first hand-over
   * sets the first-dispatch time and the count in one statement -- the database checks
   * that a count and its stamps always agree -- and every later one only counts.
   */
  async markDispatched(organizationId: string, commandId: string, now: Date = new Date()): Promise<boolean> {
    const first = await this.prisma.brainCommand.updateMany({
      where: { id: commandId, organizationId, dispatchedAt: null },
      data: { dispatchedAt: now, lastDispatchedAt: now, dispatchCount: { increment: 1 } },
    });
    if (first.count === 1) return true;
    const again = await this.prisma.brainCommand.updateMany({
      where: { id: commandId, organizationId, dispatchedAt: { not: null } },
      data: { lastDispatchedAt: now, dispatchCount: { increment: 1 } },
    });
    return again.count === 1;
  }
}

export class BrainEventRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async listForJob(organizationId: string, jobId: string): Promise<BrainEventRecord[]> {
    const rows = await this.prisma.brainEvent.findMany({ where: { organizationId, jobId }, orderBy: { sequence: 'asc' } });
    return rows.map(brainEventRecordOf);
  }
}

export interface BrainEventRow {
  readonly id: string;
  readonly organizationId: string;
  readonly jobId: string;
  readonly sequence: number;
  readonly name: string;
  readonly taskId: string;
  readonly resultType: string;
  readonly occurredAt: Date;
  readonly actorKind: string;
  readonly actorUserId: string | null;
  readonly actorPolicy: string | null;
  readonly resultRefs: unknown;
  readonly reason: string | null;
  readonly createdAt: Date;
}

export function brainEventRecordOf(row: BrainEventRow): BrainEventRecord {
  if (!(BRAIN_JOB_EVENT_NAMES as readonly string[]).includes(row.name)) throw new BrainRecordUnreadable('event name');
  if (!(BRAIN_RESULT_TYPES as readonly string[]).includes(row.resultType)) throw new BrainRecordUnreadable('event result type');
  return {
    eventId: row.id,
    sequence: row.sequence,
    recordedAt: row.createdAt,
    event: {
      name: row.name as BrainJobEventName,
      organizationId: row.organizationId,
      jobId: row.jobId,
      taskId: row.taskId,
      resultType: row.resultType as BrainResultType,
      occurredAt: row.occurredAt.toISOString(),
      actor: brainActorOf(row.actorKind, row.actorUserId, row.actorPolicy),
      resultRefs: brainResultRefsOf(row.resultRefs),
      reason: row.reason,
    },
  };
}
