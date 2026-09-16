// DurableAiUsageLedger -- the AiUsageLedger the S1 gateway's budget is actually safe on.
//
// It implements the same interface as `InMemoryAiUsageLedger` and adds the two calls
// a serverless runtime needs: `reserve` before the provider call and `reconcile`
// after it. The in-memory one is kept for tests; it is not a production ledger and
// its own comment says so.
//
// THE BUSINESS DAY IS THE ORGANIZATION'S (Product, 2026-09-16). A daily cap has to
// mean a day somebody recognises, so the window follows `Organization.timezone`,
// which defaults to UTC. That is the ONLY thing the organization's zone is used for
// here. It is not a display timezone -- how a person sees an instant is the Time
// Authority's job, in that person's own zone -- and the canonical instants on every
// row stay UTC.
//
// COST STAYS REPRODUCIBLE (Product, 2026-09-16). The ledger records the provider's
// raw reported usage plus the price-list version to value it with. It never writes a
// final dollar amount as the only record, so correcting a price re-values history
// instead of rewriting it. `estimatedCostMicros` is the reserve, and is explicitly
// not the cost of record.
//
// NO PER-USER CAP (Product, 2026-09-16). `principalUserId` is attribution, not a
// budget grain. Nothing here reads it to decide anything, and an unused control still
// has to be maintained -- so there is not one.
//
// THIS SERVICE ACTIVATES NOTHING. It reads and writes one table. It constructs no
// provider client, reads no credential, and makes no model call. The runtime stays
// switched off (`activated: false`) until an operator turns it on, and the migration
// for this table must be deployed BEFORE that happens -- a live provider behind a
// budget nobody can enforce is the configuration this whole design exists to prevent.

import type { PrismaClient } from '@prisma/client';
import { aiBudgetDate, type AiBudgetDate, type AiInvocationProvenance, type AiSpendToday } from '@emgloop/shared';

import {
  AiUsageLedgerRepository,
  type AiInvocationReconcileInput,
  type AiInvocationReserveInput,
} from '../repositories/ai-usage-ledger.repository';

/** What the gateway holds of a ledger. Structurally `AiUsageLedger`. */
export interface AiUsageLedgerPort {
  spentToday(organizationId: string): Promise<AiSpendToday>;
  record(provenance: AiInvocationProvenance): Promise<void>;
}

export interface DurableAiUsageLedgerDeps {
  ledger?: AiUsageLedgerRepository;
  /** Injected, because a service that reads the clock cannot be tested against one. */
  now?: () => Date;
}

/** What `record` needs beyond the provenance contract to complete a row. */
export interface AiUsageRecordOptions {
  readonly taskVersion?: string;
  readonly profile?: string;
  readonly routingPolicyVersion?: string;
  readonly unitCostBasis?: string | null;
  readonly fellBackFrom?: string | null;
  readonly failureClass?: string | null;
  readonly rejectionCodes?: readonly string[];
  readonly attemptCount?: number;
}

/** Recorded when the caller did not say. Never invented as a plausible-looking value. */
const UNRECORDED = 'UNRECORDED';

export class DurableAiUsageLedger implements AiUsageLedgerPort {
  private readonly ledger: AiUsageLedgerRepository;
  private readonly now: () => Date;

  constructor(
    private readonly prisma: PrismaClient,
    deps: DurableAiUsageLedgerDeps = {},
  ) {
    this.ledger = deps.ledger ?? new AiUsageLedgerRepository(prisma);
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * The organization's reporting day for an instant. Read from its own governed
   * timezone, falling back to UTC -- a budget that could not be evaluated because of
   * a missing or unusable zone would fail OPEN, and no ceiling on spend is the one
   * outcome worth more than a slightly wrong window.
   */
  async businessDate(organizationId: string, instant: Date = this.now()): Promise<AiBudgetDate> {
    const org = await this.prisma.organization.findFirst({
      where: { id: organizationId },
      select: { timezone: true },
    });
    return aiBudgetDate(instant, org?.timezone ?? 'UTC');
  }

  /** Spend against this organization's own reporting day. */
  async spentToday(organizationId: string): Promise<AiSpendToday> {
    const instant = this.now();
    return this.ledger.spentOn(organizationId, await this.businessDate(organizationId, instant));
  }

  /**
   * Claim the budget BEFORE dispatch. False means the attempt was already reserved --
   * a retry or a concurrent duplicate -- and the reservation still exists exactly
   * once, so the caller may proceed either way.
   */
  async reserve(
    organizationId: string,
    input: Omit<AiInvocationReserveInput, 'businessDate' | 'requestedAt'> & {
      readonly requestedAt?: Date;
    },
  ): Promise<boolean> {
    const requestedAt = input.requestedAt ?? this.now();
    return this.ledger.reserve(organizationId, {
      ...input,
      requestedAt,
      businessDate: await this.businessDate(organizationId, requestedAt),
    });
  }

  /** Replace the reserve with what the provider reported. */
  reconcile(organizationId: string, input: AiInvocationReconcileInput): Promise<boolean> {
    return this.ledger.reconcile(organizationId, input);
  }

  /**
   * The gateway's post-hoc call. It reconciles the row `reserve` already wrote; if
   * there is none -- a caller that has not adopted reserve yet -- it writes the row
   * and reconciles it, so an invocation is never absent from the ledger merely
   * because the reserve step was skipped.
   *
   * A row written this way is still correct AFTER the fact and still not safe
   * BEFORE it: only `reserve` closes the concurrent-read window.
   */
  async record(provenance: AiInvocationProvenance, options: AiUsageRecordOptions = {}): Promise<void> {
    const completedAt = new Date(provenance.recordedAt);
    const requestedAt = new Date(completedAt.getTime() - Math.max(0, provenance.latencyMs));
    const reconciliation: AiInvocationReconcileInput = {
      invocationId: provenance.invocationId,
      outcome: provenance.outcome,
      servedModel: provenance.servedModel,
      providerRequestId: provenance.providerRequestId,
      fellBackFrom: options.fellBackFrom ?? null,
      inputTokens: provenance.usage.inputTokens,
      outputTokens: provenance.usage.outputTokens,
      cachedInputTokens: provenance.usage.cachedInputTokens ?? null,
      reasoningTokens: provenance.usage.reasoningTokens ?? null,
      ...(options.unitCostBasis === undefined ? {} : { unitCostBasis: options.unitCostBasis }),
      failureClass: options.failureClass ?? null,
      rejectionCodes: options.rejectionCodes ?? [],
      ...(options.attemptCount === undefined ? {} : { attemptCount: options.attemptCount }),
      completedAt,
      latencyMs: provenance.latencyMs,
    };

    if (await this.ledger.reconcile(provenance.organizationId, reconciliation)) return;

    await this.ledger.reserve(provenance.organizationId, {
      invocationId: provenance.invocationId,
      principalUserId: provenance.viewerUserId || null,
      taskId: provenance.taskId,
      taskVersion: provenance.taskVersion,
      profile: options.profile ?? UNRECORDED,
      providerId: provenance.requestedModel.providerId,
      requestedModelId: provenance.requestedModel.modelId,
      routingPolicyVersion: options.routingPolicyVersion ?? UNRECORDED,
      templateId: provenance.templateId,
      templateVersion: provenance.templateVersion,
      contextSourceRefs: provenance.contextSourceRefs,
      // No reserve was made, so there is no estimate. NULL, never 0: a zero would
      // claim Loop predicted this would be free.
      estimatedInputTokens: null,
      estimatedOutputTokens: null,
      estimatedCostMicros: null,
      unitCostBasis: options.unitCostBasis ?? null,
      requestedAt,
      businessDate: await this.businessDate(provenance.organizationId, requestedAt),
    });
    await this.ledger.reconcile(provenance.organizationId, reconciliation);
  }
}
