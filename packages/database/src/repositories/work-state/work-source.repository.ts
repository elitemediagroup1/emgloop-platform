// Where ingestion got to, and how each pass went. DL-1: the store, with no ingestion.
//
// Architecture: daily-loop-employee-intelligence.md §13.5 and §17.1.
//
// THE CURSOR ONLY MOVES FORWARD. `advanceCursor` writes a boundary; there is no setter that
// rewinds one and no delete. A pass that fails leaves the cursor where it was, so the next
// pass retries the same page rather than skipping it -- the ProviderPollCheckpoint
// discipline, which exists because a rewound boundary silently loses data.

import type { PrismaClient } from '@prisma/client';
import type { WorkSource, WorkSyncFailureClass, WorkSyncOutcome, WorkCursorKind } from '@emgloop/shared';

import { workScope, type WorkPrincipal } from './work-principal';

export interface WorkCursorRecord {
  readonly source: WorkSource;
  readonly cursor: string | null;
  readonly cursorKind: WorkCursorKind | null;
  readonly lastSyncStartedAt: Date | null;
  readonly lastSyncCompletedAt: Date | null;
  readonly lastFailureClass: WorkSyncFailureClass | null;
  readonly backoffUntil: Date | null;
}

export interface WorkSyncRunRecord {
  readonly id: string;
  readonly source: WorkSource;
  readonly startedAt: Date;
  readonly finishedAt: Date | null;
  readonly outcome: WorkSyncOutcome | null;
  readonly examined: number | null;
  readonly written: number | null;
  readonly failureClass: WorkSyncFailureClass | null;
}

const cursorOf = (row: any): WorkCursorRecord => ({
  source: row.source,
  cursor: row.cursor,
  cursorKind: row.cursorKind,
  lastSyncStartedAt: row.lastSyncStartedAt,
  lastSyncCompletedAt: row.lastSyncCompletedAt,
  lastFailureClass: row.lastFailureClass,
  backoffUntil: row.backoffUntil,
});

const runOf = (row: any): WorkSyncRunRecord => ({
  id: row.id,
  source: row.source,
  startedAt: row.startedAt,
  finishedAt: row.finishedAt,
  outcome: row.outcome,
  examined: row.examined,
  written: row.written,
  failureClass: row.failureClass,
});

export class WorkSourceRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /** Every cursor this person holds. Their own, by construction. */
  async cursors(principal: WorkPrincipal): Promise<WorkCursorRecord[]> {
    const rows = await this.prisma.workSourceCursor.findMany({ where: workScope(principal), orderBy: { source: 'asc' } });
    return rows.map(cursorOf);
  }

  async cursor(principal: WorkPrincipal, source: WorkSource): Promise<WorkCursorRecord | null> {
    const row = await this.prisma.workSourceCursor.findFirst({ where: { ...workScope(principal), source } });
    return row ? cursorOf(row) : null;
  }

  /**
   * Record where a pass reached. `cursor` and `cursorKind` travel together -- a value nothing
   * can interpret is not a boundary -- and a failure class is kept so a stalled source is
   * visible without opening the database.
   */
  async advanceCursor(
    principal: WorkPrincipal,
    source: WorkSource,
    update: {
      readonly cursor?: string | null;
      readonly cursorKind?: WorkCursorKind | null;
      readonly startedAt?: Date | null;
      readonly completedAt?: Date | null;
      readonly failureClass?: WorkSyncFailureClass | null;
      readonly backoffUntil?: Date | null;
    },
  ): Promise<WorkCursorRecord> {
    const scope = workScope(principal);
    const fields = {
      ...(update.cursor !== undefined ? { cursor: update.cursor, cursorKind: update.cursorKind ?? null } : {}),
      ...(update.startedAt !== undefined ? { lastSyncStartedAt: update.startedAt } : {}),
      ...(update.completedAt !== undefined ? { lastSyncCompletedAt: update.completedAt } : {}),
      ...(update.failureClass !== undefined ? { lastFailureClass: update.failureClass } : {}),
      ...(update.backoffUntil !== undefined ? { backoffUntil: update.backoffUntil } : {}),
    };
    const existing = await this.prisma.workSourceCursor.findFirst({ where: { ...scope, source } });
    if (!existing) {
      const created = await this.prisma.workSourceCursor.create({ data: { ...scope, source, ...fields } });
      return cursorOf(created);
    }
    const updated = await this.prisma.workSourceCursor.update({ where: { id: existing.id }, data: fields });
    return cursorOf(updated);
  }

  /** Open a run record. Its outcome is written when the pass ends, by `finishRun`. */
  async startRun(principal: WorkPrincipal, source: WorkSource, startedAt: Date): Promise<WorkSyncRunRecord> {
    const row = await this.prisma.workSyncRun.create({ data: { ...workScope(principal), source, startedAt } });
    return runOf(row);
  }

  async finishRun(
    principal: WorkPrincipal,
    runId: string,
    result: {
      readonly finishedAt: Date;
      readonly outcome: WorkSyncOutcome;
      readonly examined?: number | null;
      readonly written?: number | null;
      readonly failureClass?: WorkSyncFailureClass | null;
    },
  ): Promise<boolean> {
    // Scoped by the principal as well as the id: another person's run is not found, not forbidden.
    const done = await this.prisma.workSyncRun.updateMany({
      where: { ...workScope(principal), id: runId },
      data: {
        finishedAt: result.finishedAt,
        outcome: result.outcome,
        examined: result.examined ?? null,
        written: result.written ?? null,
        failureClass: result.failureClass ?? null,
      },
    });
    return done.count === 1;
  }

  /** The recent passes, newest first, for this person only. */
  async recentRuns(principal: WorkPrincipal, limit = 20): Promise<WorkSyncRunRecord[]> {
    const rows = await this.prisma.workSyncRun.findMany({
      where: workScope(principal),
      orderBy: { startedAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 100),
    });
    return rows.map(runOf);
  }
}
