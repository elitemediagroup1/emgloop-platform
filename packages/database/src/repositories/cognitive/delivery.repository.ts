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
}
