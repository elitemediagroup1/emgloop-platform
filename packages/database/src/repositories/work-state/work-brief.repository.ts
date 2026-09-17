// The daily brief: an immutable record of a window, and its history.
//
// Architecture: daily-loop-employee-intelligence.md §7.
//
// A BRIEF IS A RECORD, NOT A RENDER. "What happened while I was out on Friday" reads
// Friday's brief; it does not re-derive Friday from today's data, because the second answer
// would change silently as mail arrived. So there is no update path: a regeneration writes
// a NEW VERSION beside the old one.
//
// COVERAGE IS PART OF THE RECORD. A brief written when a source could not be read says so,
// because "nothing needed you" and "I could not look" must never render the same.
//
// `headline` IS A STAGE 3 SEAM AND IS ALWAYS NULL HERE. The narrative sentence needs message
// content and a model; a brief with counts and references is honest without one.

import type { PrismaClient } from '@prisma/client';

import { workScope, type WorkPrincipal } from './work-principal';

export interface BriefComposition {
  /** The calendar day in the employee's own zone. */
  readonly localDate: Date;
  readonly windowStart: Date;
  readonly windowEnd: Date;
  /** Per source: what was read, and what could not be. */
  readonly coverage: Record<string, unknown>;
  /** Counts by class. A count that could not be computed is absent, never 0. */
  readonly counts: Record<string, unknown>;
  /** References to the items and threads this brief points at. */
  readonly items: readonly unknown[];
  readonly generatorVersion: string;
  readonly generatedAt?: Date;
}

export class WorkBriefRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Write a brief for one local day. Called twice for the same day, it writes version 2 and
   * leaves version 1 exactly as it was.
   */
  async write(principal: WorkPrincipal, composition: BriefComposition): Promise<{ readonly id: string; readonly version: number }> {
    const scope = workScope(principal);
    if (composition.windowEnd <= composition.windowStart) throw new Error('a brief window ends after it starts');
    const prior = await this.prisma.workBrief.findMany({
      where: { ...scope, localDate: composition.localDate },
      orderBy: { version: 'desc' },
      take: 1,
    });
    const version = (prior[0]?.version ?? 0) + 1;
    const row = await this.prisma.workBrief.create({
      data: {
        ...scope,
        localDate: composition.localDate,
        version,
        windowStart: composition.windowStart,
        windowEnd: composition.windowEnd,
        coverage: composition.coverage as any,
        counts: composition.counts as any,
        items: composition.items as any,
        generatorVersion: composition.generatorVersion,
        ...(composition.generatedAt ? { generatedAt: composition.generatedAt } : {}),
      },
    });
    return { id: row.id, version };
  }

  /** The newest version of one day's brief, or null when that day has none. */
  async forDate(principal: WorkPrincipal, localDate: Date) {
    const rows = await this.prisma.workBrief.findMany({
      where: { ...workScope(principal), localDate },
      orderBy: { version: 'desc' },
      take: 1,
    });
    return rows[0] ?? null;
  }

  /** Recent briefs, newest first: the history surface. */
  async recent(principal: WorkPrincipal, limit = 30) {
    return this.prisma.workBrief.findMany({
      where: workScope(principal),
      orderBy: [{ localDate: 'desc' }, { version: 'desc' }],
      take: Math.min(Math.max(limit, 1), 120),
    });
  }
}
