// CommercialSignalRepository -- Commercial Intelligence Stage 2.
//
// Persistence for objective-relative relevance: a fact Loop observed, the
// Performance Objective it was evaluated against, and the reason it may matter.
//
// THIS REPOSITORY DOES NOT TOUCH THE INCUMBENT `Signal` MODEL. That model holds
// behavioural enrichment on customers and conversations, is written by the
// signal registry, and is read by four other repositories. Nothing in this file
// imports it, queries it, or changes any of its semantics. The two concepts
// share an English word; `repositories.signals` and
// `repositories.commercialSignals` are separate and always will be.
//
// TENANCY IS ENFORCED HERE, NOT AT THE CALL SITE, following
// PerformanceObjectiveRepository directly. Every method takes `organizationId`
// as its FIRST REQUIRED ARGUMENT. `establish` resolves the OBJECTIVE inside the
// organization before it will write anything, so a signal can never be attached
// to another tenant's objective even if a caller supplies its id -- and a
// cross-organization id is NOT-FOUND, never forbidden.
//
// POSITIVE DETERMINATIONS ONLY. `establish` is called with a relevance that an
// evaluator already produced; an evaluation that concluded nothing never reaches
// this file. The absence of a row therefore means only that no positive
// determination was recorded. It is NOT evidence that an observation was
// examined and dismissed, no method here implies otherwise, and Stage 2 stores
// no negative-evaluation history.
//
// THE DETERMINATION IS WRITTEN ONCE. Re-evaluating the same observation against
// the same objective with the same evaluator moves `lastEvaluatedAt` and
// increments `evaluationCount`, and rewrites NOTHING else -- not the rationale,
// not the basis, not the evaluator version, not the observation. A record of
// what CI believed is worth nothing if a later run can quietly replace it.
//
// WHAT THIS REPOSITORY DOES NOT DO. It does not score, rank, prioritize, route,
// notify, escalate, create work, create decisions, create opportunities, or
// contact anyone. It has no notion of a headline and no notion of attention.
// `MANAGER` does not appear in this file: it is an authorization level resolved
// by IamRepository and establishes no relationship between users, so there is no
// query here that takes a user and returns anyone else's signals.

import type { PrismaClient, CommercialSignal, Prisma } from '@prisma/client';
import {
  isCommercialSignalRelevanceBasis,
  measuredCount,
  type CommercialObservation,
  type CommercialRelevance,
  type CommercialSignalView,
  type Truth,
} from '@emgloop/shared';

function toView(row: CommercialSignal, objectiveTitle: string | null): CommercialSignalView {
  return {
    id: row.id,
    performanceObjectiveId: row.performanceObjectiveId,
    objectiveTitle,
    // Nested exactly as the contract nests them. Flattening these two groups
    // here would be the first step towards a caller presenting Loop's inference
    // as the source's statement.
    observation: {
      sourceSystem: row.sourceSystem,
      sourceKey: row.sourceKey,
      sourceReference: row.sourceReference,
      observedAt: row.observedAt.toISOString(),
      summary: row.observationSummary,
    },
    relevance: {
      // Validated on the way out as well as in. The column is a string so a new
      // evaluator needs no migration; that flexibility is only safe if a value
      // written by an older build cannot reach a caller as an unrecognised
      // basis. An unknown value fails closed to the one basis Stage 2 defines.
      basis: isCommercialSignalRelevanceBasis(row.relevanceBasis) ? row.relevanceBasis : 'TERM_MATCH',
      rationale: row.relevanceRationale,
      evaluatorId: row.evaluatorId,
      evaluatorVersion: row.evaluatorVersion,
    },
    firstEvaluatedAt: row.firstEvaluatedAt.toISOString(),
    lastEvaluatedAt: row.lastEvaluatedAt.toISOString(),
    evaluationCount: row.evaluationCount,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Objective titles for a set of signals, resolved WITHIN the organization.
 *
 * A second scoped query rather than a Prisma relation `include`, for two
 * reasons. It stays inside the drift-safe explicit-select discipline this
 * repository family follows -- production has no migration ledger, so a bare
 * include over a drifted column would 500 a whole page. And it means the join
 * is real behaviour a test can prove, rather than a display field nobody can
 * assert on. The id set is bounded by the caller's `take`.
 */
async function titlesFor(
  prisma: PrismaClient,
  organizationId: string,
  rows: readonly CommercialSignal[],
): Promise<Map<string, string>> {
  const ids = [...new Set(rows.map((r) => r.performanceObjectiveId))];
  if (ids.length === 0) return new Map();
  const objectives = await prisma.performanceObjective.findMany({
    where: { organizationId, id: { in: ids } },
    select: { id: true, title: true },
  });
  return new Map(objectives.map((o) => [o.id, o.title]));
}

export interface EstablishCommercialSignalInput {
  /** The objective this was evaluated against. Resolved inside the org first. */
  performanceObjectiveId: string;
  observation: CommercialObservation;
  relevance: CommercialRelevance;
}

/**
 * What `establish` did. The two outcomes are distinguished because they are
 * genuinely different events: one is CI concluding something for the first time,
 * the other is CI seeing the same thing again and changing nothing.
 */
export type EstablishOutcome = 'ESTABLISHED' | 'REAFFIRMED';

export interface EstablishResult {
  outcome: EstablishOutcome;
  signal: CommercialSignalView;
}

export interface ListCommercialSignalsOptions {
  /** Signals for one objective. Never widened by role. */
  performanceObjectiveId?: string;
  sourceSystem?: string;
  /** Observations at or after this instant, by SOURCE time, not evaluation time. */
  observedSince?: Date;
  take?: number;
}

export class CommercialSignalRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Record that an observation may matter to an objective.
   *
   * Returns `null` when the objective does not resolve inside this organization
   * -- unknown id and another tenant's id get the same answer, and neither
   * writes anything. The caller must not audit a write that did not happen.
   */
  async establish(
    organizationId: string,
    input: EstablishCommercialSignalInput,
  ): Promise<EstablishResult | null> {
    // FAIL CLOSED FIRST. The objective is the referent that makes this a signal
    // at all, so it is resolved WITHIN the organization before anything is
    // written. This is the check that makes a cross-tenant objective id
    // unusable rather than merely discouraged.
    const objective = await this.prisma.performanceObjective.findFirst({
      where: { id: input.performanceObjectiveId, organizationId },
      select: { id: true, title: true },
    });
    if (!objective) return null;

    const { observation, relevance } = input;
    const key = {
      organizationId,
      performanceObjectiveId: objective.id,
      sourceSystem: observation.sourceSystem,
      sourceKey: observation.sourceKey,
      evaluatorId: relevance.evaluatorId,
    };

    const existing = await this.prisma.commercialSignal.findFirst({ where: key, select: { id: true } });
    if (existing) return this.reaffirm(existing.id, objective.title);

    try {
      const row = await this.prisma.commercialSignal.create({
        data: {
          ...key,
          sourceReference: observation.sourceReference ?? null,
          observedAt: observation.observedAt,
          observationSummary: observation.summary,
          relevanceBasis: relevance.basis,
          relevanceRationale: relevance.rationale,
          evaluatorVersion: relevance.evaluatorVersion,
        },
      });
      return { outcome: 'ESTABLISHED', signal: toView(row, objective.title) };
    } catch (err) {
      // A concurrent evaluation won the race and inserted first. The unique index
      // is the authority, not the read above: two evaluation runs overlapping in
      // time is ordinary, and the correct answer is the same one a sequential
      // second run would get. Any other error is real and must surface.
      if (!isUniqueViolation(err)) throw err;
      const raced = await this.prisma.commercialSignal.findFirst({ where: key, select: { id: true } });
      if (!raced) throw err;
      return this.reaffirm(raced.id, objective.title);
    }
  }

  /**
   * Seeing the same thing again.
   *
   * Moves the two sighting counters and NOTHING else. The rationale, basis,
   * evaluator version, observation summary and `firstEvaluatedAt` are what CI
   * concluded the first time, and re-running an evaluator does not entitle it to
   * revise history -- the same discipline
   * `OperationalPriority.firstDetectedAt` keeps.
   */
  private async reaffirm(id: string, objectiveTitle: string): Promise<EstablishResult> {
    const row = await this.prisma.commercialSignal.update({
      where: { id },
      data: { lastEvaluatedAt: new Date(), evaluationCount: { increment: 1 } },
    });
    return { outcome: 'REAFFIRMED', signal: toView(row, objectiveTitle) };
  }

  /** One signal, resolved within the organization. Cross-org is null. */
  async get(organizationId: string, id: string): Promise<CommercialSignalView | null> {
    const row = await this.prisma.commercialSignal.findFirst({ where: { id, organizationId } });
    if (!row) return null;
    const titles = await titlesFor(this.prisma, organizationId, [row]);
    return toView(row, titles.get(row.performanceObjectiveId) ?? null);
  }

  /**
   * Signals for one organization.
   *
   * The `where` is built from the session organization plus explicit filters
   * only. No branch here widens the result set based on the caller's role, and
   * none may be added: role decides WHETHER you may read signals, never WHICH
   * tenant's you see.
   *
   * Ordered by the SOURCE's clock, newest first -- when the fact happened, not
   * when Loop got round to looking at it. This is an inspection ordering and not
   * a ranking: nothing here scores, and there is no column that could.
   */
  async list(
    organizationId: string,
    opts: ListCommercialSignalsOptions = {},
  ): Promise<CommercialSignalView[]> {
    const where: Prisma.CommercialSignalWhereInput = { organizationId };
    if (opts.performanceObjectiveId) where.performanceObjectiveId = opts.performanceObjectiveId;
    if (opts.sourceSystem) where.sourceSystem = opts.sourceSystem;
    if (opts.observedSince) where.observedAt = { gte: opts.observedSince };

    const rows = await this.prisma.commercialSignal.findMany({
      where,
      orderBy: [{ observedAt: 'desc' }],
      take: Math.min(500, Math.max(1, opts.take ?? 100)),
    });
    const titles = await titlesFor(this.prisma, organizationId, rows);
    return rows.map((r) => toView(r, titles.get(r.performanceObjectiveId) ?? null));
  }

  /**
   * How many signals this organization holds, optionally for one objective.
   *
   * Returns Truth rather than a bare number, because a bare zero cannot say
   * whether Loop counted nothing or failed to count -- the platform invariant
   * the truth-adoption fitness function enforces. Here the distinction is real
   * in a CI-specific way: zero signals means no positive determination has been
   * recorded, which is NOT the same as "Loop examined the data and found nothing
   * relevant". EMPTY is the honest state for that, and a surface rendering it
   * says so instead of showing a confident 0.
   */
  async count(organizationId: string, performanceObjectiveId?: string): Promise<Truth<number>> {
    const value = await this.prisma.commercialSignal.count({
      where: performanceObjectiveId
        ? { organizationId, performanceObjectiveId }
        : { organizationId },
    });
    return measuredCount(value, {
      measuredAt: new Date().toISOString(),
      subject: 'commercialIntelligence.signals',
    });
  }
}

/** Prisma's unique-constraint failure, without importing the error class. */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002';
}
