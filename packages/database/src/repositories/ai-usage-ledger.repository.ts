// The durable AI usage ledger.
//
// An organization's daily AI budget is only real if the number behind it survives a
// process. The S1 gateway reads that number through an interface whose only
// implementation is a Map in one instance's memory, and Netlify runs serverless:
// instances share no memory, so a cap enforced per-instance is that cap multiplied by
// however many are warm. A budget that is decorative is worse than no budget, because
// it is a control somebody will trust.
//
// RESERVE, THEN RECONCILE. `reserve` writes the row BEFORE the provider call, with
// Loop's estimate. `reconcile` replaces the estimate with what the provider reported.
// Counting only afterwards would let N concurrent requests each read a spend-to-date
// of zero and all pass a cap that only one of them should have. A crash between the
// two leaves a row that over-counts slightly, which is the safe direction: the
// organization is briefly billed-against for work it may not have received.
//
// ESTIMATE AND REPORT ARE NEVER THE SAME COLUMN. A row still carrying only an
// estimate is a row that never reconciled, and being able to see that is the point.
// A provider that reported no count leaves NULL, never 0 -- a zero says "this was
// free", which is a different and false claim.
//
// IDEMPOTENT UNDER RETRY. `invocationId` is stable across retries and unique per
// organization, so a flaky provider cannot consume a cap several times over. A
// concurrent double-reserve is resolved by the unique index, not by a read-then-write
// the database never agreed to.
//
// NO PROMPT, NO RESPONSE, NO CONTACT VALUE. This repository cannot write a body
// because the table has no column for one. It writes a HASH of the ordered source
// refs -- enough to prove two invocations saw the same evidence, useless for
// reconstructing any of it.
//
// TENANCY. Every method takes the organization explicitly and scopes at the data
// layer, so the unsafe call is unwriteable rather than merely discouraged.
//
// COST AND LANES (PR 1, 2026-09-26). A row records the capacity LANE it ran in and, once reconciled, its
// COST at the route's price (`costMicros`), and the spend read sums cost per lane, per organization day
// and over the trailing 24 hours (capacity.ts). Both columns arrived in migration 20261005000000; the
// repository probes for them (`capacityColumnsPresent`) and, on a database without them, neither writes
// nor reads them -- the cost it then reports is the reserve of every call that reported usage, which
// over-counts (the safe direction) and applies only to the always-on emergency ceiling.

import { createHash } from 'crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { AI_LANES, isAiLane, type AiBudgetDate, type AiCostSnapshot, type AiLane, type AiSpendSnapshot, type AiSpendToday } from '@emgloop/shared';

import { absentUntilMigrated } from '../creator/until-migrated';

/**
 * A business date as the UTC-midnight `Date` Postgres `DATE` round-trips through
 * Prisma. Midnight UTC is a STORAGE convention, not a claim that the business day
 * began at that instant. It lives here, beside the column, rather than in the pure
 * AI contracts, which may not construct a Date at all.
 */
export function aiBudgetDateAsUtcDate(date: AiBudgetDate): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

export interface AiInvocationReserveInput {
  /** Loop's correlation id. Stable across retries. */
  readonly invocationId: string;
  readonly principalUserId: string | null;
  readonly taskId: string;
  readonly taskVersion: string;
  /**
   * The capability route the task declared. The column is still called `profile`: it
   * was named for the vocabulary this replaced in B2, and renaming it needs a migration.
   * Rows written before B2 hold the retired words; read them with `aiLedgerCapabilityOf`.
   */
  readonly capabilityRoute: string;
  readonly providerId: string;
  readonly requestedModelId: string;
  readonly routingPolicyVersion: string;
  readonly templateId: string;
  readonly templateVersion: string;
  /** The ordered source refs. Hashed here; the values themselves are never stored. */
  readonly contextSourceRefs: readonly string[];
  readonly estimatedInputTokens: number | null;
  readonly estimatedOutputTokens: number | null;
  readonly estimatedCostMicros: number | null;
  readonly unitCostBasis: string | null;
  readonly businessDate: AiBudgetDate;
  readonly requestedAt: Date;
  /** The model this call stands in for, when it is not the primary. */
  readonly fellBackFrom?: string | null;
  /** Which call of its invocation this is: 1 for the first, 2 for the next. */
  readonly attemptCount?: number;
  /**
   * B4. The Brain job and step this call serves, when it serves one. Both or neither,
   * and `invocationId` is then `brainCallKey(job, step, attempt)`; the database checks it.
   */
  readonly brainJobId?: string | null;
  readonly brainStepKey?: string | null;
  /** B4. The provider-specialization policy version the call's routing conformed to. */
  readonly specializationPolicyVersion?: string | null;
  /** PR 1. The capacity lane. Written only on a database that has the column. */
  readonly lane?: AiLane | null;
}

export interface AiInvocationReconcileInput {
  readonly invocationId: string;
  readonly outcome: 'ANSWERED' | 'REFUSED_BY_MODEL' | 'REJECTED_BY_LOOP' | 'FAILED' | 'CANCELLED';
  readonly servedModel?: string | null;
  readonly providerRequestId?: string | null;
  readonly fellBackFrom?: string | null;
  readonly inputTokens?: number | null;
  readonly outputTokens?: number | null;
  readonly cachedInputTokens?: number | null;
  readonly reasoningTokens?: number | null;
  readonly unitCostBasis?: string | null;
  readonly failureClass?: string | null;
  readonly rejectionCodes?: readonly string[];
  readonly attemptCount?: number;
  readonly completedAt: Date;
  readonly latencyMs?: number | null;
  /** PR 1. The call's cost at its route's price, from the reported usage. Written only where the column exists. */
  readonly costMicros?: number | null;
}

/** PR 1. What the capacity read needs besides the windows the invocation budget reads. */
export interface AiCapacityReadOptions {
  /** Whether migration 20261005000000's columns exist (`capacityColumnsPresent`). */
  readonly capacity: boolean;
  /** The circuit breaker's trailing window start, or null when no breaker is configured. */
  readonly breakerSince: Date | null;
}

export type AiLedgerDb = PrismaClient | Prisma.TransactionClient;

/**
 * A hash of the ordered refs, and only that. Order is preserved because two
 * invocations that saw the same evidence in a different order did not see the same
 * context, and the hash should say so. The separator cannot occur inside a ref, so
 * two different ref lists cannot collide by concatenation.
 */
export function aiContextManifestHash(refs: readonly string[]): string {
  const h = createHash('sha256');
  for (const ref of refs) {
    h.update(String(ref));
    h.update(Buffer.from([0]));
  }
  return h.digest('hex');
}

/** Prisma's error code for a unique constraint violation. */
const UNIQUE_VIOLATION = 'P2002';

/** In flight: reserved, dispatched, not yet reconciled. Never a final outcome. */
export const AI_INVOCATION_IN_FLIGHT = 'IN_FLIGHT';

/** How long a "not migrated yet" probe is trusted before it is asked again. A "migrated" answer is final. */
const CAPACITY_PROBE_RETRY_MS = 5 * 60 * 1000;

export class AiUsageLedgerRepository {
  private capacityProbe: { readonly present: boolean; readonly atMs: number } | null = null;

  constructor(private readonly prisma: PrismaClient) {}

  /**
   * PR 1. Whether `lane` and `costMicros` exist. Never inside a transaction: on a database without them the
   * probe fails, and a failed statement would abort the transaction it ran in.
   */
  async capacityColumnsPresent(nowMs: number = Date.now()): Promise<boolean> {
    if (this.capacityProbe && (this.capacityProbe.present || nowMs - this.capacityProbe.atMs < CAPACITY_PROBE_RETRY_MS)) {
      return this.capacityProbe.present;
    }
    const probed = await absentUntilMigrated(this.prisma.aiInvocation.findMany({ select: { id: true, lane: true, costMicros: true }, take: 1 }));
    this.capacityProbe = { present: probed !== null, atMs: nowMs };
    return this.capacityProbe.present;
  }

  /**
   * Claim the budget BEFORE the call. Returns true when this call created the row and
   * false when the attempt was already reserved -- a retry, or a concurrent duplicate
   * the unique index resolved. Either way the reservation exists exactly once.
   */
  async reserve(organizationId: string, input: AiInvocationReserveInput, db: AiLedgerDb = this.prisma, capacity = false): Promise<boolean> {
    try {
      await this.insertReservation(organizationId, input, db, capacity);
      return true;
    } catch (err) {
      if ((err as { code?: string })?.code === UNIQUE_VIOLATION) return false;
      throw err;
    }
  }

  /**
   * The same insert, without swallowing a duplicate. Inside a transaction a unique
   * violation aborts the transaction, so it must reach the transaction's owner
   * rather than be caught and followed by a COMMIT that silently rolls back.
   */
  async insertReservation(organizationId: string, input: AiInvocationReserveInput, db: AiLedgerDb = this.prisma, capacity = false): Promise<void> {
    await db.aiInvocation.create({
      data: {
        organizationId,
        invocationId: input.invocationId,
        principalUserId: input.principalUserId,
        taskId: input.taskId,
        taskVersion: input.taskVersion,
        profile: input.capabilityRoute,
        providerId: input.providerId,
        requestedModelId: input.requestedModelId,
        routingPolicyVersion: input.routingPolicyVersion,
        templateId: input.templateId,
        templateVersion: input.templateVersion,
        contextManifestHash: aiContextManifestHash(input.contextSourceRefs),
        contextSourceCount: input.contextSourceRefs.length,
        estimatedInputTokens: input.estimatedInputTokens,
        estimatedOutputTokens: input.estimatedOutputTokens,
        estimatedCostMicros: input.estimatedCostMicros,
        unitCostBasis: input.unitCostBasis,
        // It is not an answer, a refusal or a failure yet, and the budget counts it
        // regardless -- that is what reserving means.
        outcome: AI_INVOCATION_IN_FLIGHT,
        rejectionCodes: [],
        requestedAt: input.requestedAt,
        businessDate: aiBudgetDateAsUtcDate(input.businessDate),
        fellBackFrom: input.fellBackFrom ?? null,
        attemptCount: input.attemptCount ?? 1,
        brainJobId: input.brainJobId ?? null,
        brainStepKey: input.brainStepKey ?? null,
        specializationPolicyVersion: input.specializationPolicyVersion ?? null,
        // PR 1: named only where the column exists, so an unmigrated database gets the same insert as before.
        ...(capacity ? { lane: input.lane ?? null } : {}),
      },
      // Only the id comes back. Returning every column would make this insert depend on
      // columns a database migration adds, so code deployed ahead of its migration
      // would fail here instead of simply not using them.
      select: { id: true },
    });
  }

  /** Whether a call key is already reserved in this organization. */
  async exists(organizationId: string, invocationId: string, db: AiLedgerDb = this.prisma): Promise<boolean> {
    const row = await db.aiInvocation.findFirst({ where: { organizationId, invocationId }, select: { id: true } });
    return row !== null;
  }

  /**
   * Replace the estimate with what actually happened. Scoped by organization AND
   * invocation id, so a reconcile can never reach another tenant's row; a miss writes
   * nothing and returns false rather than inventing a row for an attempt nobody
   * reserved.
   */
  async reconcile(
    organizationId: string,
    input: AiInvocationReconcileInput,
    db: AiLedgerDb = this.prisma,
    capacity = false,
  ): Promise<boolean> {
    const result = await db.aiInvocation.updateMany({
      where: { organizationId, invocationId: input.invocationId },
      data: {
        outcome: input.outcome,
        servedModel: input.servedModel ?? null,
        providerRequestId: input.providerRequestId ?? null,
        // Written at reservation. A reconcile that does not say otherwise leaves it:
        // overwriting it with null erased the record that a call was a fallback.
        ...(input.fellBackFrom === undefined ? {} : { fellBackFrom: input.fellBackFrom }),
        inputTokens: input.inputTokens ?? null,
        outputTokens: input.outputTokens ?? null,
        cachedInputTokens: input.cachedInputTokens ?? null,
        reasoningTokens: input.reasoningTokens ?? null,
        ...(input.unitCostBasis === undefined ? {} : { unitCostBasis: input.unitCostBasis }),
        failureClass: input.failureClass ?? null,
        rejectionCodes: [...(input.rejectionCodes ?? [])],
        ...(input.attemptCount === undefined ? {} : { attemptCount: input.attemptCount }),
        completedAt: input.completedAt,
        latencyMs: input.latencyMs ?? null,
        ...(capacity && input.costMicros !== undefined ? { costMicros: input.costMicros } : {}),
      },
    });
    return result.count > 0;
  }

  /**
   * What this organization has spent on this business day. The read that happens
   * before EVERY invocation, so it is one indexed range scan on
   * (organizationId, businessDate) and never a scan of the organization's history.
   *
   * Tokens are REPORT OVER ESTIMATE: a reconciled row counts what the provider said,
   * an in-flight one counts what Loop reserved. Both are counted, which is why a
   * burst of concurrent requests cannot all read zero.
   */
  async spentOn(organizationId: string, businessDate: AiBudgetDate, db: AiLedgerDb = this.prisma): Promise<AiSpendToday> {
    const rows = await db.aiInvocation.findMany({
      where: { organizationId, businessDate: aiBudgetDateAsUtcDate(businessDate) },
      select: SPEND_COLUMNS,
    });
    return sumSpend(rows);
  }

  /**
   * The three windows a budget is checked against, read in one place so the
   * pre-check and the reservation cannot disagree about what "spent" means:
   *
   *   organization  this organization, on its own business day;
   *   task          the same rows, for one task;
   *   global        every organization the runtime is enabled for, over the trailing
   *                 24 hours by the server clock. Business days differ by timezone,
   *                 so a global ceiling is a rolling window, not anybody's calendar.
   *
   * Every read names its organizations, so each one is an indexed range scan.
   */
  async spendSnapshot(
    organizationId: string,
    taskId: string,
    businessDate: AiBudgetDate,
    activeOrganizations: readonly string[],
    globalSince: Date,
    db: AiLedgerDb = this.prisma,
    options: AiCapacityReadOptions = { capacity: false, breakerSince: null },
  ): Promise<AiSpendSnapshot> {
    const columns = options.capacity ? CAPACITY_SPEND_COLUMNS : SPEND_COLUMNS;
    const day = (await db.aiInvocation.findMany({
      where: { organizationId, businessDate: aiBudgetDateAsUtcDate(businessDate) },
      select: { ...columns, taskId: true },
    })) as (SpendRow & { taskId: string })[];
    const organizations = [...new Set([organizationId, ...activeOrganizations])];
    const recent = (await db.aiInvocation.findMany({
      where: { organizationId: { in: organizations }, requestedAt: { gte: globalSince } },
      select: columns,
    })) as SpendRow[];
    // The breaker counts this task's FAILED and REJECTED calls in this organization over its own window.
    const taskRecentFailures = options.breakerSince
      ? await db.aiInvocation.count({
          where: { organizationId, taskId, requestedAt: { gte: options.breakerSince }, outcome: { in: [...BREAKER_OUTCOMES] } },
        })
      : 0;
    const cost: AiCostSnapshot = {
      organizationMicros: sumCost(day),
      laneMicros: laneRecord((lane) => sumCost(day.filter((r) => laneOf(r) === lane))),
      laneInvocations: laneRecord((lane) => day.filter((r) => laneOf(r) === lane).length),
      globalMicros: sumCost(recent),
      taskRecentFailures,
    };
    return {
      organization: sumSpend(day),
      task: sumSpend(day.filter((r) => r.taskId === taskId)),
      global: sumSpend(recent),
      cost,
    };
  }
}

const SPEND_COLUMNS = {
  outcome: true,
  inputTokens: true,
  outputTokens: true,
  estimatedInputTokens: true,
  estimatedOutputTokens: true,
  estimatedCostMicros: true,
} as const;
/** PR 1: the same, plus the two columns migration 20261005000000 adds. Read only where they exist. */
const CAPACITY_SPEND_COLUMNS = { ...SPEND_COLUMNS, lane: true, costMicros: true } as const;

/** The outcomes the circuit breaker counts: a call that failed, or whose answer Loop refused. */
const BREAKER_OUTCOMES = ['FAILED', 'REJECTED_BY_LOOP'] as const;

interface SpendRow {
  readonly outcome: string;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly estimatedInputTokens: number | null;
  readonly estimatedOutputTokens: number | null;
  readonly estimatedCostMicros: number | null;
  readonly lane?: string | null;
  readonly costMicros?: number | null;
}

function laneRecord(value: (lane: AiLane) => number): Record<AiLane, number> {
  return Object.fromEntries(AI_LANES.map((lane) => [lane, value(lane)])) as Record<AiLane, number>;
}

/**
 * A row's lane. A row written before the lane column (or before a lane was named) counts as FORWARD, the
 * lane with the largest share: attributing it anywhere smaller could hold live work back for spend that
 * was never live.
 */
function laneOf(row: SpendRow): AiLane {
  return isAiLane(row.lane) ? row.lane : 'FORWARD';
}

/**
 * Cost, by the same switch as tokens. Outstanding: the reserve (its ceiling cost). Reconciled: the cost
 * recorded at reconcile -- and a reconciled call that reported no usage cost NOTHING, never its reserve
 * (the phantom-spend rule below). A reconciled row from before `costMicros` existed, that did report
 * usage, counts its reserve: an over-count that only ever errs toward refusing.
 */
function sumCost(rows: readonly SpendRow[]): number {
  let micros = 0;
  for (const row of rows) {
    if (row.outcome === AI_INVOCATION_IN_FLIGHT) micros += row.estimatedCostMicros ?? 0;
    else if (typeof row.costMicros === 'number') micros += row.costMicros;
    else if (row.inputTokens !== null || row.outputTokens !== null) micros += row.estimatedCostMicros ?? 0;
  }
  return micros;
}

/**
 * Report over estimate, and RECONCILIATION is the switch between them.
 *
 * `outcome` is `IN_FLIGHT` exactly while an invocation is still outstanding: `reserve` writes that,
 * and every `reconcile` overwrites it with a terminal outcome. It is always a non-null string, which
 * is why the switch reads it rather than the nullable `completedAt`. So:
 *   - outstanding (outcome === IN_FLIGHT): count the reserve. The provider has not told us the cost,
 *     so the estimate is the only conservative number, and it must hold capacity until it reconciles.
 *   - reconciled (any terminal outcome): count what the provider actually reported, and a reconciled
 *     call that reported no usage cost ZERO tokens -- NOT the estimate. A call that reached the
 *     provider and came back FAILED or INVALID_REQUEST with null usage processed nothing; falling back
 *     to its reserve there is phantom spend, and it once exhausted a task's whole token budget on 50
 *     zero-usage failures. A reconciled row's actual is authoritative, including when it is null.
 *
 * The invocation COUNT is deliberately every row, reconciled or not: it is a runaway/rate guard over
 * real provider round-trips, and a failed round-trip is still a round-trip. See the ledger service.
 */
function sumSpend(
  rows: readonly {
    outcome: string;
    inputTokens: number | null;
    outputTokens: number | null;
    estimatedInputTokens: number | null;
    estimatedOutputTokens: number | null;
  }[],
): AiSpendToday {
  let inputTokens = 0;
  let outputTokens = 0;
  for (const row of rows) {
    const outstanding = row.outcome === AI_INVOCATION_IN_FLIGHT;
    inputTokens += outstanding ? (row.inputTokens ?? row.estimatedInputTokens ?? 0) : (row.inputTokens ?? 0);
    outputTokens += outstanding ? (row.outputTokens ?? row.estimatedOutputTokens ?? 0) : (row.outputTokens ?? 0);
  }
  return { invocations: rows.length, inputTokens, outputTokens };
}
