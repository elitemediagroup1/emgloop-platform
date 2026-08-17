// HeadlineRepository -- Commercial Intelligence Stage 3 v1.
//
// Persistence for measured developments: something changed in an objective's
// world, by this much, against this comparison, with this evidence.
//
// A HEADLINE IS NOT A DECISION AND THIS FILE MUST NEVER MAKE IT ONE. There is no
// assign method, no owner method, no state transition, no lane, no outcome and no
// reopen. If a caller ever needs one of those, the thing being modelled is a
// Decision and `DecisionEngine` + `operational_priorities` already exist for it.
// Promotion is Stage 3 v1.1 and nothing here anticipates it.
//
// TENANCY IS ENFORCED HERE, NOT AT THE CALL SITE, following
// CommercialSignalRepository directly. Every method takes `organizationId` as its
// FIRST REQUIRED ARGUMENT. `record` resolves the OBJECTIVE and the BINDING inside
// the organization before it will write anything; a cross-organization id is
// NOT-FOUND, never forbidden, and nothing is written.
//
// THE MEASUREMENT IS WRITTEN ONCE. Re-detecting the same development in a later
// completed period moves `lastDetectedAt`, `detectionCount` and
// `lastDetectionKey` and rewrites NOTHING else -- not the values, not the
// statement, not the windows, not the limitations. A record of what Loop measured
// is worth nothing if a later run can quietly replace it, which is the same
// discipline `CommercialSignal` and `OperationalPriority.firstDetectedAt` keep.
//
// IDEMPOTENT PER COMPLETED PERIOD. A run over a period this Headline has already
// recorded changes nothing at all, so a server-rendered surface is safe to
// refresh and a scheduled run is safe to overlap. The claim is made with a
// conditional UPDATE rather than a read-then-write, so two concurrent runs cannot
// both increment.
//
// DISMISSAL IS ATTENTION FEEDBACK, NOT AN OUTCOME. It records that a human did
// not need this. It never reopens, never suppresses recurrence, and carries no
// claim about what the organization will do.

import type { PrismaClient, Headline, Prisma } from '@prisma/client';
import {
  MEASURE_METRIC_DEFINITIONS,
  describeThreshold,
  isHeadlineDismissalBasis,
  isMeasureMetric,
  measuredCount,
  type HeadlineDismissalBasis,
  type HeadlineView,
  type MeasureMetric,
  type MeasureMovement,
  type Truth,
} from '@emgloop/shared';

function movementOf(raw: string): MeasureMovement {
  // Validated on the way out. The column is a string so the vocabulary is a
  // contract change rather than DDL; an unrecognised value must not reach a
  // caller as a third movement nobody handles.
  return raw === 'DECREASE' ? 'DECREASE' : 'INCREASE';
}

function metricOf(raw: string): MeasureMetric {
  return isMeasureMetric(raw) ? raw : 'CALL_VOLUME';
}

function toView(
  row: Headline,
  context: { objectiveTitle: string | null; bindingVersion: number; dismissedByName: string | null },
): HeadlineView {
  const metric = metricOf(row.metric);
  return {
    id: row.id,
    performanceObjectiveId: row.performanceObjectiveId,
    objectiveTitle: context.objectiveTitle,
    measureBindingId: row.measureBindingId,
    measureBindingVersion: context.bindingVersion,
    // Nested exactly as the contract nests it. Flattening the measurement into
    // the statement's level would be the first step towards a surface presenting
    // Loop's sentence as if it were the measurement.
    measurement: {
      metric,
      metricLabel: MEASURE_METRIC_DEFINITIONS[metric].label,
      unit: MEASURE_METRIC_DEFINITIONS[metric].unit,
      movement: movementOf(row.movement),
      againstObjective: row.againstObjective,
      currentValue: row.currentValue,
      priorValue: row.priorValue,
      absoluteChange: row.absoluteChange,
      percentageChange: row.percentageChange,
      currentDenominator: row.currentDenominator,
      priorDenominator: row.priorDenominator,
      currentCoverage: row.currentCoverage,
      priorCoverage: row.priorCoverage,
      comparisonBasis: row.comparisonBasis,
      currentWindowStart: row.currentWindowStart.toISOString(),
      currentWindowEnd: row.currentWindowEnd.toISOString(),
      priorWindowStart: row.priorWindowStart.toISOString(),
      priorWindowEnd: row.priorWindowEnd.toISOString(),
    },
    statement: row.statement,
    limitations: row.limitations,
    unknowns: row.unknowns,
    ruleId: row.ruleId,
    ruleVersion: row.ruleVersion,
    producerVersion: row.producerVersion,
    ruleDescription: describeThreshold(metric),
    firstDetectedAt: row.firstDetectedAt.toISOString(),
    lastDetectedAt: row.lastDetectedAt.toISOString(),
    detectionCount: row.detectionCount,
    dismissedAt: row.dismissedAt?.toISOString() ?? null,
    dismissedByUserId: row.dismissedByUserId,
    dismissedByName: context.dismissedByName,
    dismissalBasis:
      row.dismissalBasis && isHeadlineDismissalBasis(row.dismissalBasis) ? row.dismissalBasis : null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Everything the detector established, ready to persist. */
export interface RecordHeadlineInput {
  performanceObjectiveId: string;
  measureBindingId: string;
  recurrenceKey: string;
  detectionKey: string;
  ruleId: string;
  ruleVersion: string;
  producerVersion: string;
  metric: string;
  movement: MeasureMovement;
  againstObjective: boolean;
  statement: string;
  currentValue: number | null;
  priorValue: number | null;
  absoluteChange: number | null;
  percentageChange: number | null;
  currentDenominator: number;
  priorDenominator: number;
  currentCoverage: number | null;
  priorCoverage: number | null;
  comparisonBasis: string;
  currentWindowStart: Date;
  currentWindowEnd: Date;
  priorWindowStart: Date;
  priorWindowEnd: Date;
  limitations: readonly string[];
  unknowns: readonly string[];
  /**
   * Which completeness rule certified the days behind this measurement, and how
   * many days it verified. Required, not optional: a caller that does not know
   * whether its window was observed must not be able to write a Headline that
   * looks certified by staying silent.
   */
  observationRuleVersion: string;
  observedDayCount: number;
  /** Detection time. Injected so the caller owns the clock and a test can pin it. */
  detectedAt: Date;
}

/**
 * What `record` did. Three genuinely different events, kept apart because a
 * caller reporting a run needs to distinguish them and a statistic built on them
 * would be meaningless if they were merged.
 */
export type RecordOutcome =
  /** Loop had never measured this development before. */
  | 'ESTABLISHED'
  /** A later completed period saw it again. Counters moved; nothing else did. */
  | 'RESIGHTED'
  /** This exact period was already recorded. Nothing moved at all. */
  | 'ALREADY_RECORDED';

export interface RecordHeadlineResult {
  outcome: RecordOutcome;
  headline: HeadlineView;
}

export interface ListHeadlinesOptions {
  performanceObjectiveId?: string;
  /** Omit for everything; false for open only; true for dismissed only. */
  dismissed?: boolean;
  take?: number;
}

export class HeadlineRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Record a measured development, or note that it is still happening.
   *
   * Returns `null` when the objective or the binding does not resolve inside this
   * organization, or when the binding does not belong to the objective. All three
   * get the same answer and none writes anything.
   */
  async record(
    organizationId: string,
    input: RecordHeadlineInput,
  ): Promise<RecordHeadlineResult | null> {
    // FAIL CLOSED FIRST, and on BOTH referents. A Headline whose binding belongs
    // to a different objective would be a measurement attributed to intent it was
    // never defined against.
    //
    // Two scoped queries rather than a relation `include`, staying inside the
    // explicit-select discipline this repository family follows: migrations here
    // are human-dispatched, so a bare include over a column that has drifted from
    // the deployed schema would 500 the whole page.
    const binding = await this.prisma.objectiveMeasureBinding.findFirst({
      where: {
        id: input.measureBindingId,
        organizationId,
        performanceObjectiveId: input.performanceObjectiveId,
      },
      select: { id: true, version: true, performanceObjectiveId: true },
    });
    if (!binding) return null;

    const objective = await this.prisma.performanceObjective.findFirst({
      where: { id: binding.performanceObjectiveId, organizationId },
      select: { id: true, title: true },
    });
    if (!objective) return null;

    const key = {
      organizationId,
      performanceObjectiveId: objective.id,
      recurrenceKey: input.recurrenceKey,
    };

    const existing = await this.prisma.headline.findFirst({ where: key, select: { id: true } });
    if (existing) {
      return this.resight(existing.id, input.detectionKey, input.detectedAt, {
        objectiveTitle: objective.title,
        bindingVersion: binding.version,
      });
    }

    try {
      const row = await this.prisma.headline.create({
        data: {
          ...key,
          measureBindingId: binding.id,
          ruleId: input.ruleId,
          ruleVersion: input.ruleVersion,
          producerVersion: input.producerVersion,
          metric: input.metric,
          movement: input.movement,
          againstObjective: input.againstObjective,
          statement: input.statement,
          currentValue: input.currentValue,
          priorValue: input.priorValue,
          absoluteChange: input.absoluteChange,
          percentageChange: input.percentageChange,
          currentDenominator: input.currentDenominator,
          priorDenominator: input.priorDenominator,
          currentCoverage: input.currentCoverage,
          priorCoverage: input.priorCoverage,
          comparisonBasis: input.comparisonBasis,
          currentWindowStart: input.currentWindowStart,
          currentWindowEnd: input.currentWindowEnd,
          priorWindowStart: input.priorWindowStart,
          priorWindowEnd: input.priorWindowEnd,
          limitations: [...input.limitations],
          unknowns: [...input.unknowns],
          observationRuleVersion: input.observationRuleVersion,
          observedDayCount: input.observedDayCount,
          firstDetectedAt: input.detectedAt,
          lastDetectedAt: input.detectedAt,
          detectionCount: 1,
          lastDetectionKey: input.detectionKey,
        },
      });
      return {
        outcome: 'ESTABLISHED',
        headline: toView(row, {
          objectiveTitle: objective.title,
          bindingVersion: binding.version,
          dismissedByName: null,
        }),
      };
    } catch (err) {
      // A concurrent run inserted first. The unique index is the authority, not
      // the read above: two detection runs overlapping in time is ordinary, and
      // the correct answer is the one a sequential second run would get.
      if (!isUniqueViolation(err)) throw err;
      const raced = await this.prisma.headline.findFirst({ where: key, select: { id: true } });
      if (!raced) throw err;
      return this.resight(raced.id, input.detectionKey, input.detectedAt, {
        objectiveTitle: objective.title,
        bindingVersion: binding.version,
      });
    }
  }

  /**
   * Seeing the same development in a later completed period.
   *
   * The counters move and NOTHING else does -- not the measured values, not the
   * statement, not the windows, not the limitations, and not the dismissal.
   *
   * RECURRENCE SURVIVES DISMISSAL, DELIBERATELY, AND NEVER REOPENS. A dismissed
   * Headline keeps accumulating sightings because "the condition Matt called
   * immaterial has now persisted for six periods" is exactly the fact that tells
   * Loop whether IMMATERIAL was the right call, and deleting it would destroy the
   * only feedback the attention model gets. This mirrors `SITUATION_RESIGHTED`,
   * which the Decision Center defines as deliberately NOT touching the lane: a
   * sighting is an observation, never a state change.
   *
   * The claim is a CONDITIONAL update, not a read-then-write. Two concurrent runs
   * over the same period both attempt it; exactly one matches, and the other sees
   * zero rows affected and reports ALREADY_RECORDED. No lock, no race.
   */
  private async resight(
    id: string,
    detectionKey: string,
    detectedAt: Date,
    context: { objectiveTitle: string | null; bindingVersion: number },
  ): Promise<RecordHeadlineResult> {
    const claimed = await this.prisma.headline.updateMany({
      where: { id, lastDetectionKey: { not: detectionKey } },
      data: {
        lastDetectionKey: detectionKey,
        lastDetectedAt: detectedAt,
        detectionCount: { increment: 1 },
      },
    });

    const row = await this.prisma.headline.findFirst({ where: { id } });
    // The row was resolved a moment ago inside this organization and nothing here
    // deletes; a miss means a concurrent delete, and inventing a view for it would
    // be worse than surfacing the fault.
    if (!row) throw new Error('headline.resight: row disappeared mid-update');
    return {
      outcome: claimed.count === 1 ? 'RESIGHTED' : 'ALREADY_RECORDED',
      headline: toView(row, {
        ...context,
        dismissedByName: null,
      }),
    };
  }

  /** One headline, resolved within the organization. Cross-org is null. */
  async get(organizationId: string, id: string): Promise<HeadlineView | null> {
    const row = await this.prisma.headline.findFirst({ where: { id, organizationId } });
    if (!row) return null;
    const [context] = await this.contextFor(organizationId, [row]);
    return context ? toView(row, context) : null;
  }

  /**
   * Headlines for one organization.
   *
   * Ordered by when the development was LAST CONFIRMED, newest first. This is a
   * recency ordering and NOT a ranking: nothing here scores, and no column could.
   * A surface that wants to rank must say what it ranked by.
   */
  async list(organizationId: string, opts: ListHeadlinesOptions = {}): Promise<HeadlineView[]> {
    const where: Prisma.HeadlineWhereInput = { organizationId };
    if (opts.performanceObjectiveId) where.performanceObjectiveId = opts.performanceObjectiveId;
    if (opts.dismissed === true) where.dismissedAt = { not: null };
    if (opts.dismissed === false) where.dismissedAt = null;

    const rows = await this.prisma.headline.findMany({
      where,
      orderBy: [{ lastDetectedAt: 'desc' }],
      take: Math.min(200, Math.max(1, opts.take ?? 50)),
    });
    const contexts = await this.contextFor(organizationId, rows);
    return rows.map((r, i) => toView(r, contexts[i] ?? emptyContext()));
  }

  /**
   * Record that a human did not need this.
   *
   * ATTENTION FEEDBACK, NOT AN OUTCOME. There is no ACCEPTED_RISK and no
   * NO_ACTION_NEEDED here: both assert what the organization will DO, which is a
   * Decision's vocabulary and belongs to a promotion Stage 3 v1 does not build.
   *
   * Returns null when the headline does not resolve inside this organization or
   * is already dismissed. Dismissing twice would overwrite who dismissed it and
   * when, and attention feedback that can be rewritten is not feedback.
   */
  async dismiss(
    organizationId: string,
    id: string,
    input: { basis: HeadlineDismissalBasis; userId: string | null; at: Date },
  ): Promise<HeadlineView | null> {
    const found = await this.prisma.headline.findFirst({
      where: { id, organizationId, dismissedAt: null },
      select: { id: true },
    });
    if (!found) return null;

    const row = await this.prisma.headline.update({
      where: { id: found.id },
      data: { dismissedAt: input.at, dismissedByUserId: input.userId, dismissalBasis: input.basis },
    });
    const [context] = await this.contextFor(organizationId, [row]);
    return toView(row, context ?? emptyContext());
  }

  /**
   * How many headlines this organization holds, optionally for one objective.
   *
   * Returns Truth rather than a bare number, because a bare zero cannot say
   * whether Loop measured nothing or failed to count. The distinction is real
   * here: zero headlines means no material development was detected, which is NOT
   * the same as "nothing was measured" -- an unbound objective is measured not at
   * all, and a surface rendering both as 0 says the same thing about two opposite
   * situations.
   */
  async count(organizationId: string, performanceObjectiveId?: string): Promise<Truth<number>> {
    const value = await this.prisma.headline.count({
      where: performanceObjectiveId
        ? { organizationId, performanceObjectiveId }
        : { organizationId },
    });
    return measuredCount(value, {
      measuredAt: new Date().toISOString(),
      subject: 'commercialIntelligence.headlines',
    });
  }

  /**
   * Objective title, binding version and dismisser name for a set of rows.
   *
   * Three scoped queries rather than Prisma relation `include`s, staying inside
   * the explicit-select discipline this repository family follows: a bare include
   * over a column that has drifted from the deployed schema would 500 the whole
   * page, and migrations here are human-dispatched. The id sets are bounded by
   * the caller's `take`.
   */
  private async contextFor(
    organizationId: string,
    rows: readonly Headline[],
  ): Promise<Array<{ objectiveTitle: string | null; bindingVersion: number; dismissedByName: string | null }>> {
    if (rows.length === 0) return [];

    const objectiveIds = [...new Set(rows.map((r) => r.performanceObjectiveId))];
    const bindingIds = [...new Set(rows.map((r) => r.measureBindingId))];
    const userIds = [...new Set(rows.map((r) => r.dismissedByUserId).filter((v): v is string => Boolean(v)))];

    const [objectives, bindings, users] = await Promise.all([
      this.prisma.performanceObjective.findMany({
        where: { organizationId, id: { in: objectiveIds } },
        select: { id: true, title: true },
      }),
      this.prisma.objectiveMeasureBinding.findMany({
        where: { organizationId, id: { in: bindingIds } },
        select: { id: true, version: true },
      }),
      userIds.length
        ? this.prisma.user.findMany({
            where: { organizationId, id: { in: userIds } },
            select: { id: true, name: true, email: true },
          })
        : Promise.resolve([]),
    ]);

    const titles = new Map(objectives.map((o) => [o.id, o.title]));
    const versions = new Map(bindings.map((b) => [b.id, b.version]));
    const names = new Map(users.map((u) => [u.id, u.name ?? u.email]));

    return rows.map((r) => ({
      objectiveTitle: titles.get(r.performanceObjectiveId) ?? null,
      // 0 is not a real version. It shows only when a binding has been deleted
      // beneath a headline, which the RESTRICT foreign key is there to prevent.
      bindingVersion: versions.get(r.measureBindingId) ?? 0,
      dismissedByName: r.dismissedByUserId ? (names.get(r.dismissedByUserId) ?? null) : null,
    }));
  }
}

function emptyContext(): { objectiveTitle: string | null; bindingVersion: number; dismissedByName: string | null } {
  return { objectiveTitle: null, bindingVersion: 0, dismissedByName: null };
}

/** Prisma's unique-constraint failure, without importing the error class. */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002';
}
