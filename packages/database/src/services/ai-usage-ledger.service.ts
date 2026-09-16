// DurableAiUsageLedger -- the ledger an AI budget is actually enforced on. Slices #265, AI-1.
//
// It implements the gateway's `AiUsageLedger` over the `ai_invocations` table: a
// cheap spend read, a RESERVATION that is atomic with its own budget check, and a
// reconciliation that replaces the estimate with what the provider reported.
//
// WHY SERIALIZABLE. Netlify runs serverless. Two instances can each read an
// organization's spend-to-date, each see room for one more call, and each insert --
// and the budget is exceeded by exactly the concurrency nobody planned for. The
// reservation therefore reads the spend and inserts the row inside ONE serializable
// transaction. Postgres detects the read/write conflict between two such
// transactions and aborts one of them; the loser re-reads, sees the other's row, and
// is refused if there is no longer room. No raw SQL, no advisory lock, no row
// touched that is not this table's.
//
// A reservation that keeps losing is refused (RESERVATION_CONTENDED) rather than
// retried forever: under contention, the safe answer is "not now".
//
// THE BUSINESS DAY IS THE ORGANIZATION'S (Product, 2026-09-16). The organization and
// task windows follow `Organization.timezone`, default UTC. That is the ONLY thing
// the organization's zone is used for here -- it is not a display timezone, and the
// canonical instants on every row stay UTC. The global window is a trailing 24 hours
// by the server clock, because business days differ between organizations.
//
// COST STAYS REPRODUCIBLE (Product, 2026-09-16). The row keeps raw reported usage and
// the price-list version. `estimatedCostMicros` is the reserve, never the cost of record.
//
// NO PER-USER CAP (Product, 2026-09-16). `principalUserId` is attribution only.
//
// THIS SERVICE ACTIVATES NOTHING. It reads and writes one table; it constructs no
// provider client, reads no credential, and makes no model call.

import { Prisma, type PrismaClient } from '@prisma/client';
import {
  aiBudgetDate,
  aiBudgetRefusals,
  aiCostMicros,
  type AiBudgetDate,
  type AiBudgetPolicy,
  type AiSpendSnapshot,
} from '@emgloop/shared';

import { AiUsageLedgerRepository } from '../repositories/ai-usage-ledger.repository';
import type {
  AiCallReconciliation,
  AiCallReservation,
  AiReserveResult,
  AiUsageLedger,
} from './ai-runtime/gateway';

export interface DurableAiUsageLedgerDeps {
  ledger?: AiUsageLedgerRepository;
  /** How many times a reservation that lost a serialization race is re-attempted. */
  maxReservationAttempts?: number;
}

const GLOBAL_WINDOW_MS = 24 * 60 * 60 * 1000;
const UNIQUE_VIOLATION = 'P2002';

/** Postgres aborted a serializable transaction because a concurrent one conflicted. */
export function isSerializationFailure(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown; meta?: { code?: unknown } };
  if (e?.code === 'P2034') return true;
  if (e?.meta?.code === '40001') return true;
  return typeof e?.message === 'string' && /could not serialize access|40001/.test(e.message);
}

export class DurableAiUsageLedger implements AiUsageLedger {
  private readonly ledger: AiUsageLedgerRepository;
  private readonly maxAttempts: number;

  constructor(
    private readonly prisma: PrismaClient,
    deps: DurableAiUsageLedgerDeps = {},
  ) {
    this.ledger = deps.ledger ?? new AiUsageLedgerRepository(prisma);
    this.maxAttempts = Math.max(1, deps.maxReservationAttempts ?? 3);
  }

  /**
   * The organization's reporting day for an instant, from its governed timezone. An
   * unusable or missing zone budgets on the UTC day: a budget that could not be
   * evaluated would fail OPEN.
   */
  async businessDate(organizationId: string, instant: Date): Promise<AiBudgetDate> {
    const org = await this.prisma.organization.findFirst({
      where: { id: organizationId },
      select: { timezone: true },
    });
    return aiBudgetDate(instant, org?.timezone ?? 'UTC');
  }

  async spend(organizationId: string, taskId: string, at: Date, activeOrganizations: readonly string[]): Promise<AiSpendSnapshot> {
    const date = await this.businessDate(organizationId, at);
    return this.ledger.spendSnapshot(organizationId, taskId, date, activeOrganizations, new Date(at.getTime() - GLOBAL_WINDOW_MS));
  }

  async reserve(
    reservation: AiCallReservation,
    budget: AiBudgetPolicy,
    activeOrganizations: readonly string[],
  ): Promise<AiReserveResult> {
    const date = await this.businessDate(reservation.organizationId, reservation.requestedAt);
    const since = new Date(reservation.requestedAt.getTime() - GLOBAL_WINDOW_MS);

    for (let attempt = 0; attempt < this.maxAttempts; attempt += 1) {
      try {
        return await this.prisma.$transaction(
          async (tx) => {
            if (await this.ledger.exists(reservation.organizationId, reservation.callKey, tx)) {
              return { ok: false, refusals: ['DUPLICATE_INVOCATION'] } as const;
            }
            const spend = await this.ledger.spendSnapshot(
              reservation.organizationId,
              reservation.taskId,
              date,
              activeOrganizations,
              since,
              tx,
            );
            const refusals = aiBudgetRefusals(budget, reservation.budgetClass, reservation.estimate, spend);
            if (refusals.length > 0) return { ok: false, refusals } as const;
            await this.ledger.insertReservation(
              reservation.organizationId,
              {
                invocationId: reservation.callKey,
                principalUserId: reservation.principalUserId,
                taskId: reservation.taskId,
                taskVersion: reservation.taskVersion,
                profile: reservation.profile,
                providerId: reservation.target.providerId,
                requestedModelId: reservation.target.modelId,
                routingPolicyVersion: reservation.routingPolicyVersion,
                templateId: reservation.templateId,
                templateVersion: reservation.templateVersion,
                contextSourceRefs: reservation.contextSourceRefs,
                estimatedInputTokens: reservation.estimate.inputTokens,
                estimatedOutputTokens: reservation.estimate.outputTokens,
                estimatedCostMicros: aiCostMicros(reservation.target.pricing, reservation.estimate),
                unitCostBasis: reservation.target.pricing?.listVersion ?? null,
                businessDate: date,
                requestedAt: reservation.requestedAt,
                fellBackFrom: reservation.fellBackFrom,
                attemptCount: reservation.callOrdinal,
              },
              tx,
            );
            return { ok: true } as const;
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
      } catch (err) {
        if (isSerializationFailure(err)) continue;
        // Two instances minted the same key at once and the index settled it.
        if ((err as { code?: unknown })?.code === UNIQUE_VIOLATION) return { ok: false, refusals: ['DUPLICATE_INVOCATION'] };
        throw err;
      }
    }
    return { ok: false, refusals: ['RESERVATION_CONTENDED'] };
  }

  reconcile(organizationId: string, reconciliation: AiCallReconciliation): Promise<boolean> {
    return this.ledger.reconcile(organizationId, {
      invocationId: reconciliation.callKey,
      outcome: reconciliation.outcome,
      servedModel: reconciliation.servedModel,
      providerRequestId: reconciliation.providerRequestId,
      inputTokens: reconciliation.usage?.inputTokens ?? null,
      outputTokens: reconciliation.usage?.outputTokens ?? null,
      cachedInputTokens: reconciliation.usage?.cachedInputTokens ?? null,
      reasoningTokens: reconciliation.usage?.reasoningTokens ?? null,
      unitCostBasis: reconciliation.unitCostBasis,
      failureClass: reconciliation.failureClass,
      rejectionCodes: reconciliation.rejectionCodes,
      completedAt: reconciliation.completedAt,
      latencyMs: reconciliation.latencyMs,
    });
  }
}
