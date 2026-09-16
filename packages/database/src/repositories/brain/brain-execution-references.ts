// The executor's way in: references, and nothing else, found without an organization.
// Slice B4.
//
// Architecture: docs/architecture/brain-execution-infrastructure.md §5.2, §6, §8.
//
// THE ONE DELIBERATE EXCEPTION TO "ORGANIZATION FIRST". The approved trust design gives
// an executor nothing but references: a doorbell ring names a stored command, and an
// advance message names a job and its generation. Neither carries an organization, on
// purpose -- a message that named one could name the wrong one. So the executor's first
// read has to find the organization FROM the record, and this is the only Brain module
// allowed to read without one.
//
// IT RETURNS IDENTITIES ONLY. Every method selects an organization, an id and a
// generation -- never a subject, an input, a question, a reply, a checkpoint or a
// result. Everything after this first read goes through the organization-scoped
// repositories, with the organization this read returned. A fence test holds both rules.
//
// THE SWEEPER'S SCANS live here for the same reason: they look for due work across
// every organization, and hand back references to act on one at a time.

import type { PrismaClient } from '@prisma/client';
import type { BrainJobRef } from '@emgloop/shared';

export interface BrainJobReference {
  readonly organizationId: string;
  readonly jobId: string;
  readonly generation: number;
}

export interface BrainCommandReference {
  readonly organizationId: string;
  readonly commandId: string;
  readonly jobId: string;
}

export interface BrainWaitReference {
  readonly organizationId: string;
  readonly jobId: string;
  readonly waitId: string;
}

const MAX_SCAN = 500;

function bounded(limit: number): number {
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_SCAN);
}

export class BrainExecutionReferences {
  constructor(private readonly prisma: PrismaClient) {}

  /** The job an advance message names, if that generation is still current. */
  async resolveJob(ref: BrainJobRef): Promise<BrainJobReference | null> {
    const row = await this.prisma.brainJob.findFirst({
      where: { id: ref.jobId, generation: ref.generation },
      select: { organizationId: true, id: true, generation: true },
    });
    return row ? { organizationId: row.organizationId, jobId: row.id, generation: row.generation } : null;
  }

  /** The command a doorbell ring names. */
  async resolveCommand(commandId: string): Promise<BrainCommandReference | null> {
    const row = await this.prisma.brainCommand.findFirst({
      where: { id: commandId },
      select: { organizationId: true, id: true, jobId: true },
    });
    return row ? { organizationId: row.organizationId, commandId: row.id, jobId: row.jobId } : null;
  }

  /** Commands never handed to an executor, older than `before`: a lost ring. */
  async undispatchedCommands(before: Date, limit = 100): Promise<BrainCommandReference[]> {
    const rows = await this.prisma.brainCommand.findMany({
      where: { dispatchedAt: null, issuedAt: { lt: before } },
      select: { organizationId: true, id: true, jobId: true },
      orderBy: [{ issuedAt: 'asc' }, { id: 'asc' }],
      take: bounded(limit),
    });
    return rows.map((r) => ({ organizationId: r.organizationId, commandId: r.id, jobId: r.jobId }));
  }

  /** Open questions whose time has passed. */
  async expiredWaits(now: Date, limit = 100): Promise<BrainWaitReference[]> {
    const rows = await this.prisma.brainJobWait.findMany({
      where: { status: 'OPEN', expiresAt: { lte: now } },
      select: { organizationId: true, jobId: true, id: true },
      orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
      take: bounded(limit),
    });
    return rows.map((r) => ({ organizationId: r.organizationId, jobId: r.jobId, waitId: r.id }));
  }

  /** Running work whose worker stopped renewing its lease. */
  async staleLeases(now: Date, limit = 100): Promise<BrainJobReference[]> {
    const rows = await this.prisma.brainJob.findMany({
      where: { state: { in: ['QUEUED', 'RUNNING'] }, leaseExpiresAt: { lte: now } },
      select: { organizationId: true, id: true, generation: true },
      orderBy: [{ leaseExpiresAt: 'asc' }, { id: 'asc' }],
      take: bounded(limit),
    });
    return rows.map((r) => ({ organizationId: r.organizationId, jobId: r.id, generation: r.generation }));
  }
}
