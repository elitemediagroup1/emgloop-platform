// StateChangeDeliveryRepository — one durable delivery per (state change, subscriber).
//
// The publisher (Increment 3) fans an outbox row out into one delivery per
// matching subscription and tracks each independently, because subscribers can
// have different results. The (outboxId, subscriptionId) unique is the whole
// idempotency + single-claim story:
//
//   - ensure(): create-or-get. Two competing publisher runs both try to create;
//     the loser catches P2002 and reads back the SAME row. Never two deliveries
//     for one (change, subscriber).
//   - claim(): a CONDITIONAL update (status PENDING/FAILED & due → PROCESSING),
//     not a read-then-write. Exactly one competing worker gets count===1 and
//     dispatches; everyone else gets 0 and skips. The database row is the mutex —
//     no raw SQL, no in-memory lock. A SUCCEEDED/DEAD_LETTERED delivery never
//     re-claims, so a succeeded sibling is never re-dispatched while another
//     delivery retries.
//
// Org-scoped like every cognitive repository: organizationId is the first
// argument, always from authenticated server context, and every read/mutation
// resolves within the organization.

import type { PrismaClient, StateChangeDelivery } from '@prisma/client';

export interface EnsureDeliveryInput {
  outboxId: string;
  subscriptionId: string;
  subscriberKey: string;
  /** Stable dedup key derived from (revision, subscription) — never a timestamp. */
  idempotencyKey: string;
  required: boolean;
  now?: Date;
}

export interface DeliveryRetryOptions {
  maxAttempts?: number;
  retryDelayMs?: number;
  now?: Date;
}

const DEFAULT_MAX_ATTEMPTS = 5;

/**
 * How long a claimed delivery may stay PROCESSING before it is considered
 * abandoned.
 *
 * Generous on purpose. Reclaiming a delivery that is merely slow re-runs a
 * handler that may already have had a side effect, so the lease must comfortably
 * exceed the slowest legitimate handler rather than the average one. Five minutes
 * is well past any serverless execution limit this runs under.
 */
const DEFAULT_LEASE_MS = 5 * 60_000;
const DEFAULT_RETRY_DELAY_MS = 30_000;

export class StateChangeDeliveryRepository {
  constructor(private readonly prisma: PrismaClient) {}

  findByPair(
    organizationId: string,
    outboxId: string,
    subscriptionId: string,
  ): Promise<StateChangeDelivery | null> {
    return this.prisma.stateChangeDelivery.findFirst({
      where: { organizationId, outboxId, subscriptionId },
    });
  }

  listForOutbox(organizationId: string, outboxId: string): Promise<StateChangeDelivery[]> {
    return this.prisma.stateChangeDelivery.findMany({
      where: { organizationId, outboxId },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * Create-or-get the delivery for a (change, subscriber). Idempotent under
   * concurrency: the (outboxId, subscriptionId) unique means the second creator
   * catches P2002 and reads back the existing row instead of duplicating.
   */
  async ensure(
    organizationId: string,
    input: EnsureDeliveryInput,
  ): Promise<StateChangeDelivery> {
    const existing = await this.findByPair(organizationId, input.outboxId, input.subscriptionId);
    if (existing) return existing;
    try {
      return await this.prisma.stateChangeDelivery.create({
        data: {
          organizationId,
          outboxId: input.outboxId,
          subscriptionId: input.subscriptionId,
          subscriberKey: input.subscriberKey,
          idempotencyKey: input.idempotencyKey,
          required: input.required,
          status: 'PENDING',
          attemptCount: 0,
          availableAt: input.now ?? new Date(),
        },
      });
    } catch (e) {
      if ((e as { code?: string })?.code === 'P2002') {
        const row = await this.findByPair(organizationId, input.outboxId, input.subscriptionId);
        if (row) return row;
      }
      throw e;
    }
  }

  /**
   * Atomically claim a due delivery for dispatch. Conditional update: only a row
   * that is still PENDING or a retryable FAILED (and due) flips to PROCESSING,
   * incrementing attemptCount and stamping startedAt. Returns true iff THIS call
   * won the claim (count===1). A false return means another worker owns it, or it
   * is already terminal, or it is not yet due — the caller must not dispatch.
   */
  async claim(
    organizationId: string,
    id: string,
    opts: { now?: Date } = {},
  ): Promise<boolean> {
    const now = opts.now ?? new Date();
    const res = await this.prisma.stateChangeDelivery.updateMany({
      where: {
        id,
        organizationId,
        status: { in: ['PENDING', 'FAILED'] },
        availableAt: { lte: now },
      },
      data: {
        status: 'PROCESSING',
        attemptCount: { increment: 1 },
        startedAt: now,
      },
    });
    return res.count === 1;
  }

  async markSucceeded(
    organizationId: string,
    id: string,
    opts: { summary?: string | null; now?: Date } = {},
  ): Promise<StateChangeDelivery | null> {
    const found = await this.prisma.stateChangeDelivery.findFirst({ where: { id, organizationId } });
    if (!found) return null;
    return this.prisma.stateChangeDelivery.update({
      where: { id: found.id },
      data: {
        status: 'SUCCEEDED',
        completedAt: opts.now ?? new Date(),
        lastError: null,
        resultSummary: opts.summary ? opts.summary.slice(0, 500) : found.resultSummary,
      },
    });
  }

  /**
   * Record a failed attempt. Dead-letters once attemptCount (already incremented
   * at claim) has reached maxAttempts; otherwise re-queues to FAILED with a
   * back-off availableAt. Never resurrects a sibling — only this row moves.
   */
  async markFailed(
    organizationId: string,
    id: string,
    error: string,
    opts: DeliveryRetryOptions = {},
  ): Promise<StateChangeDelivery | null> {
    const found = await this.prisma.stateChangeDelivery.findFirst({ where: { id, organizationId } });
    if (!found) return null;
    const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    const now = opts.now ?? new Date();
    const deadLettered = found.attemptCount >= maxAttempts;
    return this.prisma.stateChangeDelivery.update({
      where: { id: found.id },
      data: {
        status: deadLettered ? 'DEAD_LETTERED' : 'FAILED',
        lastError: error.slice(0, 500),
        completedAt: deadLettered ? now : null,
        availableAt: deadLettered
          ? found.availableAt
          : new Date(now.getTime() + (opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS)),
      },
    });
  }

  /**
   * Recover deliveries abandoned mid-flight.
   *
   * THE GAP THIS CLOSES. `claim()` moves PENDING/FAILED → PROCESSING and nothing
   * else ever moves a row out of PROCESSING except the handler that claimed it.
   * A worker that died — a serverless timeout, a deploy mid-dispatch, an OOM —
   * therefore left its delivery in PROCESSING permanently: never retried, never
   * dead-lettered, never surfaced. It simply stopped existing as far as the
   * publisher was concerned. That is the difference between "at-least-once" and
   * "at-least-once unless the process dies", and only one of those is a
   * guarantee a subscriber can build on.
   *
   * Deliberately a SEPARATE method rather than a wider `claim()` predicate. A
   * reclaim is not a claim: it is a statement that a previous attempt is presumed
   * dead, it is the one transition that can re-run a side effect that already
   * happened, and it deserves to be visible in `lastError` rather than folded
   * invisibly into normal dispatch.
   *
   * EXHAUSTED ROWS DEAD-LETTER INSTEAD OF RECYCLING. A handler that reliably
   * kills its worker would otherwise be reclaimed forever, burning every run and
   * never surfacing. Once a row has spent its attempts it becomes DEAD_LETTERED
   * with a stated reason, which is a visible failure rather than a silent loop.
   */
  async reclaimStale(
    organizationId: string,
    opts: { leaseMs?: number; maxAttempts?: number; now?: Date } = {},
  ): Promise<{ reclaimed: number; deadLettered: number }> {
    const now = opts.now ?? new Date();
    const leaseMs = opts.leaseMs ?? DEFAULT_LEASE_MS;
    const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    const cutoff = new Date(now.getTime() - leaseMs);

    const stale = await this.prisma.stateChangeDelivery.findMany({
      where: {
        organizationId,
        status: 'PROCESSING',
        // A row claimed but never stamped cannot be aged, so it is left alone
        // rather than reclaimed on a guess.
        startedAt: { not: null, lt: cutoff },
      },
      take: 500,
    });

    let reclaimed = 0;
    let deadLettered = 0;

    for (const row of stale) {
      // Conditional on still being the same PROCESSING row, so a worker that
      // wakes up and completes between the read and the write wins the race
      // rather than being trampled.
      if (row.attemptCount >= maxAttempts) {
        const res = await this.prisma.stateChangeDelivery.updateMany({
          where: { id: row.id, organizationId, status: 'PROCESSING' },
          data: {
            status: 'DEAD_LETTERED',
            completedAt: now,
            lastError:
              `Abandoned in PROCESSING for more than ${Math.round(leaseMs / 1000)}s `
              + `after ${row.attemptCount} attempt(s); presumed dead and not retried again.`,
          },
        });
        deadLettered += res.count;
        continue;
      }

      const res = await this.prisma.stateChangeDelivery.updateMany({
        where: { id: row.id, organizationId, status: 'PROCESSING' },
        data: {
          status: 'PENDING',
          availableAt: now,
          lastError:
            `Reclaimed after being abandoned in PROCESSING for more than `
            + `${Math.round(leaseMs / 1000)}s. The previous attempt may have partially run.`,
        },
      });
      reclaimed += res.count;
    }

    return { reclaimed, deadLettered };
  }
}
