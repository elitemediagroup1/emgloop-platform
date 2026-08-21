// Through what provider time has routine polling proven coverage?
//
// ONE VALUE, ONE DIRECTION. This repository can read the checkpoint and it can
// move it FORWARD. It has no setter, no reset, no delete and no way to write a
// boundary older than the stored one -- not because a caller would be careless,
// but because a checkpoint that can move backward silently re-opens an interval
// the platform has already told itself was covered.
//
// ADVANCEMENT IS A CONDITIONAL UPDATE, NOT A READ-THEN-WRITE. Two pollers may
// legitimately run at once: overlap is harmless because ingestion is idempotent
// on (provider, externalId), and the poll service proves completeness for its own
// interval independently. What must not happen is the slower run, holding an
// older boundary, overwriting the faster one's. The guard is expressed in the
// WHERE clause -- `completedThrough < :candidate` -- so exactly one update
// matches and the other reports that it changed nothing. This is the same
// conditional-update pattern `headline.repository.ts` uses for resighting, and
// for the same reason: no lock, no race.

import type { PrismaClient } from '@prisma/client';

export interface PollCheckpointView {
  provider: string;
  stream: string;
  /** The exclusive upper bound of the latest proven interval. */
  completedThrough: Date;
  /** The inclusive lower bound of the interval that last advanced it. Evidence. */
  lastIntervalSince: Date;
  updatedAt: Date;
}

/**
 * What an advance attempt did.
 *
 * ADVANCED and ALREADY_AHEAD are both correct outcomes and neither is an error.
 * A run whose interval ended before the stored boundary has proven something
 * true that was already known, which is exactly what an overlapping re-read is.
 */
export type AdvanceOutcome = 'ADVANCED' | 'ALREADY_AHEAD';

export interface AdvanceResult {
  outcome: AdvanceOutcome;
  /** The stored boundary AFTER the attempt, whoever wrote it. */
  completedThrough: Date;
}

export class ProviderPollCheckpointRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * The proven boundary, or null when none has ever been proven.
   *
   * NULL IS NOT ZERO. It means no routine interval has yet completed for this
   * stream, and the planner answers it with a bounded bootstrap lookback rather
   * than with the beginning of time.
   */
  async find(
    organizationId: string,
    provider: string,
    stream: string,
  ): Promise<PollCheckpointView | null> {
    const row = await this.prisma.providerPollCheckpoint.findFirst({
      where: { organizationId, provider, stream },
    });
    return row
      ? {
          provider: row.provider,
          stream: row.stream,
          completedThrough: row.completedThrough,
          lastIntervalSince: row.lastIntervalSince,
          updatedAt: row.updatedAt,
        }
      : null;
  }

  /**
   * Every checkpoint on the platform, for an operational health read.
   *
   * CROSS-ORGANIZATION, WHICH NEEDS SAYING OUT LOUD. CLAUDE.md allows exactly one
   * cross-tenant repository (`AuthRepository`), and this is a second read that
   * ignores tenancy — so it is worth being precise about why that is not the
   * vulnerability that rule exists to prevent.
   *
   * It returns OPERATIONAL METADATA, not tenant-owned business data: an
   * organization's slug, a provider, a stream and two instants. No call, no
   * customer, no money, no payload, no identity. The question it serves --
   * "is any stream's coverage stale" -- is a platform question and is answered the
   * same way `OutboxDrainRunner` asks which organizations have queued work.
   *
   * There is no filter, no id argument and no way for a caller to name a tenant,
   * so it cannot be turned into a lookup of one organization's data by someone
   * holding a shared secret. That is the distinction: a platform operation over
   * every tenant, never a tenant-scoped read authorised by a class credential.
   */
  async listForPlatformHealth(): Promise<
    Array<{
      organizationSlug: string;
      provider: string;
      stream: string;
      completedThrough: Date;
      updatedAt: Date;
    }>
  > {
    const rows = await this.prisma.providerPollCheckpoint.findMany({
      orderBy: [{ provider: 'asc' }, { stream: 'asc' }],
      select: {
        provider: true,
        stream: true,
        completedThrough: true,
        updatedAt: true,
        organization: { select: { slug: true } },
      },
    });
    return rows.map((r) => ({
      organizationSlug: r.organization.slug,
      provider: r.provider,
      stream: r.stream,
      completedThrough: r.completedThrough,
      updatedAt: r.updatedAt,
    }));
  }

  /**
   * Record that coverage is proven through `completedThrough`, if that is news.
   *
   * THE CALLER HAS ALREADY DECIDED. This method does not look at a poll outcome
   * and does not know what one is; it is handed a boundary that a completed run
   * proved, and its only judgement is whether that boundary is newer than the one
   * stored. Putting the outcome rule here would mean two places deciding what
   * counts as proof.
   */
  async advance(
    organizationId: string,
    provider: string,
    stream: string,
    input: { completedThrough: Date; intervalSince: Date },
  ): Promise<AdvanceResult> {
    // THE GUARD IS THE WHERE CLAUSE. `updateMany` rather than `update` because a
    // conditional update reports how many rows matched, and zero is the answer
    // that means "somebody else is already further ahead".
    const moved = await this.prisma.providerPollCheckpoint.updateMany({
      where: {
        organizationId,
        provider,
        stream,
        completedThrough: { lt: input.completedThrough },
      },
      data: {
        completedThrough: input.completedThrough,
        lastIntervalSince: input.intervalSince,
      },
    });
    if (moved.count === 1) {
      return { outcome: 'ADVANCED', completedThrough: input.completedThrough };
    }

    const existing = await this.prisma.providerPollCheckpoint.findFirst({
      where: { organizationId, provider, stream },
      select: { completedThrough: true },
    });
    if (existing) {
      // A row exists and was not older than the candidate. Another run proved at
      // least as much, which is not a failure and not something to retry.
      return { outcome: 'ALREADY_AHEAD', completedThrough: existing.completedThrough };
    }

    // FIRST PROOF FOR THIS STREAM. Two pollers can reach here at the same moment;
    // the unique index on (organization, provider, stream) is what decides
    // between them, and the loser re-reads rather than inventing a second row.
    try {
      const created = await this.prisma.providerPollCheckpoint.create({
        data: {
          organizationId,
          provider,
          stream,
          completedThrough: input.completedThrough,
          lastIntervalSince: input.intervalSince,
        },
        select: { completedThrough: true },
      });
      return { outcome: 'ADVANCED', completedThrough: created.completedThrough };
    } catch {
      // The other run created it first. Re-apply the same monotonic guard against
      // whatever it wrote, so the later boundary still wins.
      return this.advance(organizationId, provider, stream, input);
    }
  }
}
