// OperationalPriorityRepository — the durable operational layer over anything
// an intelligence producer notices.
//
// This is a PLATFORM repository, not a CallGrid one. Nothing here knows what a
// buyer, a vendor or a call is; `sourceSystem` is how a producer names itself,
// and CallGrid Intelligence is simply the first to do so. CRM, Accounting and
// Website Intelligence are expected to write through this same surface.
//
// TWO RULES HOLD EVERYTHING ELSE UP:
//
//  1. The observation log is the truth. Every method that changes anything
//     appends an immutable row and then recomputes the priority's projection
//     columns from the WHOLE log via `projectLifecycle`. There is deliberately
//     no `setState()` — a caller cannot put a priority into a state without
//     leaving the fact that explains it. If the columns and the log ever
//     disagree, `rebuildProjection` restores the columns from the log.
//
//  2. `organizationId` is the first argument of every method, always from the
//     signed session, and every row is resolved WITHIN the organization before
//     it is touched (`findFirst({ id, organizationId })` → null). A cross-org id
//     is not-found, never forbidden. This is the discipline Sprint 29A paid for:
//     the unsafe call is not written here, so no caller can make it.

import type {
  PrismaClient,
  Prisma,
  OperationalPriority,
  OperationalObservation,
  OperationalPriorityState,
  OperationalObservationType,
  OperationalOutcome,
  OperationalActorType,
} from '@prisma/client';
import {
  projectLifecycle,
  summarizeHistory,
  isClosed,
  type LifecycleObservation,
  type LifecycleHistory,
  type PriorityState,
} from '@emgloop/shared';

/** A priority together with the log it was derived from. */
export interface PriorityWithLog {
  priority: OperationalPriority;
  observations: OperationalObservation[];
  history: LifecycleHistory;
}

/** What a producer knows when it notices something. */
export interface DetectSituationInput {
  /** The producing system, e.g. 'CALLGRID'. */
  sourceSystem: string;
  /** Stable across analysis runs for the same underlying event. */
  recurrenceKey: string;
  /**
   * Identity of the analysis period, e.g. 'yesterday:2026-07-29'. Makes a
   * sighting idempotent per period so re-rendering the page cannot inflate the
   * log. Required — a producer that cannot name its period cannot be trusted not
   * to repeat itself.
   */
  detectionKey: string;
  /** When the period being analysed ended. Never `new Date()` inside here. */
  detectedAt: Date;
  title: string;
  summary?: string | null;
  severity: string;
  impactCents?: number | null;
  impactLabel?: string | null;
  /** The belief this was opened from, when the producer recorded one. */
  hypothesisId?: string | null;
  /**
   * What the producer knew when it opened this — rules, versions, the values
   * behind the claim, and what it could not determine. Written once into the
   * opening observation and never edited.
   *
   * This is what makes the RECORD explain itself rather than only the live
   * analysis. A decision resolved six weeks ago, under a rule version that has
   * since changed, cannot be re-derived; without this snapshot the moment a
   * threshold moves every historical decision silently loses the reason it was
   * raised, and the outcome data Loop uses to judge its own recommendations
   * becomes uninterpretable.
   */
  evidence?: Record<string, unknown>;
  /**
   * The belief to record alongside a NEWLY opened priority.
   *
   * Created in the same transaction as the priority, so a first sighting can
   * never leave an orphan hypothesis behind — which is exactly what would happen
   * if a caller proposed one first and then lost the race to open the priority.
   */
  hypothesis?: {
    hypothesisType: string;
    title: string;
    summary?: string | null;
    confidence?: number | null;
    ruleVersion?: string | null;
    supportingWindowStart?: Date | null;
    supportingWindowEnd?: Date | null;
  };
}

export interface DetectResult {
  priority: OperationalPriority;
  /** What actually happened, so a caller can report it honestly. */
  effect: 'OPENED' | 'RESIGHTED' | 'REOPENED' | 'ALREADY_RECORDED';
}

/** An operator action. Everything an action needs, and nothing it does not. */
export interface RecordObservationInput {
  observationType: OperationalObservationType;
  /** When it happened in the world. Defaults to `recordedAt` at the call site. */
  occurredAt: Date;
  actorType: OperationalActorType;
  actorUserId?: string | null;
  source: string;
  note?: string | null;
  evidence?: Record<string, unknown>;
  assignedToUserId?: string | null;
  outcome?: OperationalOutcome | null;
  measuredEffectCents?: number | null;
  measuredEffectBasis?: string | null;
  detectionKey?: string | null;
  decisionId?: string | null;
}

export interface ListPrioritiesOptions {
  sourceSystem?: string;
  state?: OperationalPriorityState;
  states?: OperationalPriorityState[];
  ownerUserId?: string;
  take?: number;
}

/** Minimal shape of an observation row for projection. Keeps the mapper honest. */
function toLifecycle(o: OperationalObservation): LifecycleObservation {
  return {
    id: o.id,
    sequence: o.sequence,
    observationType: o.observationType as LifecycleObservation['observationType'],
    occurredAt: o.occurredAt,
    recordedAt: o.recordedAt,
    actorType: o.actorType as LifecycleObservation['actorType'],
    actorUserId: o.actorUserId,
    source: o.source,
    note: o.note,
    assignedToUserId: o.assignedToUserId,
    outcome: o.outcome as LifecycleObservation['outcome'],
    measuredEffectCents: o.measuredEffectCents,
    measuredEffectBasis: o.measuredEffectBasis,
  };
}

function isP2002(e: unknown): boolean {
  return (e as { code?: string })?.code === 'P2002';
}

export class OperationalPriorityRepository {
  constructor(private readonly prisma: PrismaClient) {}

  // --- Reads ---------------------------------------------------------------

  findById(organizationId: string, id: string): Promise<OperationalPriority | null> {
    return this.prisma.operationalPriority.findFirst({ where: { id, organizationId } });
  }

  findByRecurrenceKey(
    organizationId: string,
    sourceSystem: string,
    recurrenceKey: string,
  ): Promise<OperationalPriority | null> {
    return this.prisma.operationalPriority.findFirst({
      where: { organizationId, sourceSystem, recurrenceKey },
    });
  }

  list(
    organizationId: string,
    opts: ListPrioritiesOptions = {},
  ): Promise<OperationalPriority[]> {
    return this.prisma.operationalPriority.findMany({
      where: {
        organizationId,
        ...(opts.sourceSystem ? { sourceSystem: opts.sourceSystem } : {}),
        ...(opts.state ? { state: opts.state } : {}),
        ...(opts.states ? { state: { in: opts.states } } : {}),
        ...(opts.ownerUserId ? { ownerUserId: opts.ownerUserId } : {}),
      },
      orderBy: [{ lastDetectedAt: 'desc' }, { createdAt: 'desc' }],
      take: Math.min(500, Math.max(1, opts.take ?? 200)),
    });
  }

  /** The log for one priority, oldest first. Returns null for a cross-org id. */
  async findWithLog(organizationId: string, id: string): Promise<PriorityWithLog | null> {
    const priority = await this.findById(organizationId, id);
    if (!priority) return null;
    const observations = await this.listObservations(organizationId, priority.id);
    return { priority, observations, history: summarizeHistory(observations.map(toLifecycle)) };
  }

  listObservations(
    organizationId: string,
    priorityId: string,
  ): Promise<OperationalObservation[]> {
    return this.prisma.operationalObservation.findMany({
      where: { organizationId, priorityId },
      orderBy: [{ sequence: 'asc' }],
    });
  }

  /** Counts per lane, for the queue bar. */
  async countsByState(
    organizationId: string,
    sourceSystem?: string,
  ): Promise<Record<OperationalPriorityState, number>> {
    const rows = await this.prisma.operationalPriority.findMany({
      where: { organizationId, ...(sourceSystem ? { sourceSystem } : {}) },
      select: { state: true },
    });
    const counts = {
      NEEDS_REVIEW: 0,
      ASSIGNED: 0,
      WATCHING: 0,
      RESOLVED: 0,
      DISMISSED: 0,
    } as Record<OperationalPriorityState, number>;
    for (const r of rows) counts[r.state] += 1;
    return counts;
  }

  // --- Detection (the producer's entry point) ------------------------------

  /**
   * Open a priority, or record that an existing one was seen again.
   *
   * Idempotent per `detectionKey`, so the server-rendered Overview may call this
   * on every request without inflating the log. Concurrent duplicate calls race
   * to the same unique and the loser is swallowed as ALREADY_RECORDED.
   *
   * A sighting from a period that ENDED BEFORE an existing resolution does not
   * reopen anything — browsing back through history is reading, not relapsing.
   * That guard is the difference between a durable audit trail and one an
   * operator can corrupt by clicking "last week".
   */
  async detect(organizationId: string, input: DetectSituationInput): Promise<DetectResult> {
    const existing = await this.findByRecurrenceKey(
      organizationId,
      input.sourceSystem,
      input.recurrenceKey,
    );

    if (!existing) {
      try {
        const priority = await this.prisma.$transaction(async (tx) => {
          // The belief and the operational thread are opened together or not at
          // all. A hypothesis is ALWAYS created PROPOSED — there is no path here
          // that accepts one, because acceptance requires an attributed human
          // (the same hard invariant IntelligenceHypothesisRepository holds).
          // Written through `tx` rather than that repository so the two rows share
          // one transaction; the invariant is duplicated deliberately and the
          // duplication is one literal.
          const hypothesisId = input.hypothesis
            ? (
                await tx.intelligenceHypothesis.create({
                  data: {
                    organizationId,
                    hypothesisType: input.hypothesis.hypothesisType,
                    title: input.hypothesis.title,
                    summary: input.hypothesis.summary ?? null,
                    status: 'PROPOSED',
                    confidence: input.hypothesis.confidence ?? null,
                    supportingWindowStart: input.hypothesis.supportingWindowStart ?? null,
                    supportingWindowEnd: input.hypothesis.supportingWindowEnd ?? null,
                    scope: 'OPERATIONAL',
                    sensitivity: 'INTERNAL',
                    generatedBy: 'DETERMINISTIC_RULE',
                    ruleVersion: input.hypothesis.ruleVersion ?? null,
                  },
                })
              ).id
            : (input.hypothesisId ?? null);

          return tx.operationalPriority.create({
            data: {
              organizationId,
              sourceSystem: input.sourceSystem,
              recurrenceKey: input.recurrenceKey,
              hypothesisId,
              title: input.title,
              summary: input.summary ?? null,
              firstDetectedAt: input.detectedAt,
              lastDetectedAt: input.detectedAt,
              detectionCount: 1,
              severity: input.severity,
              impactCents: input.impactCents ?? null,
              impactLabel: input.impactLabel ?? null,
            },
          });
        });
        const after = await this.append(organizationId, priority, {
          observationType: 'SITUATION_DETECTED',
          occurredAt: input.detectedAt,
          actorType: 'SYSTEM',
          actorUserId: null,
          source: input.sourceSystem,
          detectionKey: input.detectionKey,
          evidence: input.evidence,
        });
        return { priority: after ?? priority, effect: 'OPENED' };
      } catch (e) {
        // Lost the race to another request opening the same situation. Fall
        // through and treat it as a sighting of the row that won.
        if (!isP2002(e)) throw e;
        const won = await this.findByRecurrenceKey(
          organizationId,
          input.sourceSystem,
          input.recurrenceKey,
        );
        if (!won) throw e;
        return this.resight(organizationId, won, input);
      }
    }

    return this.resight(organizationId, existing, input);
  }

  private async resight(
    organizationId: string,
    existing: OperationalPriority,
    input: DetectSituationInput,
  ): Promise<DetectResult> {
    // A closed priority observed again in a period that ended AFTER it was
    // closed is a relapse — the most informative event in the log, because it
    // says a resolution did not hold. A sighting from before the close is just
    // history being read.
    const relapsed =
      isClosed(existing.state as PriorityState)
      && Boolean(existing.resolvedAt)
      && input.detectedAt.getTime() > existing.resolvedAt!.getTime();

    try {
      const updated = await this.append(organizationId, existing, {
        observationType: relapsed ? 'REOPENED' : 'SITUATION_RESIGHTED',
        occurredAt: input.detectedAt,
        actorType: 'SYSTEM',
        actorUserId: null,
        source: input.sourceSystem,
        detectionKey: input.detectionKey,
      }, {
        // Detection facts move forward only. Viewing an older period must not
        // rewind when this was last seen.
        lastDetectedAt:
          input.detectedAt.getTime() > existing.lastDetectedAt.getTime()
            ? input.detectedAt
            : existing.lastDetectedAt,
        firstDetectedAt:
          input.detectedAt.getTime() < existing.firstDetectedAt.getTime()
            ? input.detectedAt
            : existing.firstDetectedAt,
        detectionCount: existing.detectionCount + 1,
        // The headline facts follow the most recent sighting, since an operator
        // reviewing today should see today's number.
        ...(input.detectedAt.getTime() >= existing.lastDetectedAt.getTime()
          ? {
              title: input.title,
              summary: input.summary ?? null,
              severity: input.severity,
              impactCents: input.impactCents ?? null,
              impactLabel: input.impactLabel ?? null,
            }
          : {}),
      });
      if (!updated) return { priority: existing, effect: 'ALREADY_RECORDED' };
      return { priority: updated, effect: relapsed ? 'REOPENED' : 'RESIGHTED' };
    } catch (e) {
      // Already recorded for this period (the unique on (priorityId,
      // detectionKey) held), or a concurrent writer got there first.
      if (isP2002(e)) return { priority: existing, effect: 'ALREADY_RECORDED' };
      throw e;
    }
  }

  // --- Operator actions ----------------------------------------------------

  /**
   * Append one immutable fact and recompute the projection from the whole log.
   *
   * The only way anything about a priority ever changes. Returns null for a
   * cross-org id — not-found, never forbidden, and no observation is written for
   * a priority the caller may not touch.
   */
  async recordObservation(
    organizationId: string,
    priorityId: string,
    input: RecordObservationInput,
  ): Promise<PriorityWithLog | null> {
    const priority = await this.findById(organizationId, priorityId);
    if (!priority) return null;
    const updated = await this.append(organizationId, priority, input);
    if (!updated) return null;
    return this.findWithLog(organizationId, priorityId);
  }

  /**
   * The append + reproject core.
   *
   * `extra` carries producer-owned columns (detection counters, headline facts)
   * that are NOT derived from the log; everything derived is written from
   * `projectLifecycle` and nothing else. Both land in one transaction, so a
   * projection can never reflect an observation that failed to persist.
   */
  private async append(
    organizationId: string,
    priority: OperationalPriority,
    input: RecordObservationInput,
    extra: Prisma.OperationalPriorityUpdateInput = {},
  ): Promise<OperationalPriority | null> {
    return this.prisma.$transaction(async (tx) => {
      const last = await tx.operationalObservation.findFirst({
        where: { priorityId: priority.id },
        orderBy: { sequence: 'desc' },
        select: { sequence: true },
      });
      const sequence = (last?.sequence ?? 0) + 1;

      await tx.operationalObservation.create({
        data: {
          organizationId,
          priorityId: priority.id,
          decisionId: input.decisionId ?? null,
          observationType: input.observationType,
          detectionKey: input.detectionKey ?? null,
          occurredAt: input.occurredAt,
          sequence,
          actorType: input.actorType,
          actorUserId: input.actorUserId ?? null,
          source: input.source,
          note: input.note ?? null,
          evidence: (input.evidence ?? {}) as Prisma.InputJsonValue,
          assignedToUserId: input.assignedToUserId ?? null,
          outcome: input.outcome ?? null,
          measuredEffectCents: input.measuredEffectCents ?? null,
          measuredEffectBasis: input.measuredEffectBasis ?? null,
        },
      });

      const log = await tx.operationalObservation.findMany({
        where: { priorityId: priority.id },
        orderBy: { sequence: 'asc' },
      });
      const projection = projectLifecycle(log.map(toLifecycle));

      return tx.operationalPriority.update({
        where: { id: priority.id },
        data: {
          ...extra,
          state: projection.state,
          ownerUserId: projection.ownerUserId,
          stateChangedAt: projection.stateChangedAt,
          reopenCount: projection.reopenCount,
          resolvedAt: projection.resolvedAt,
          outcome: projection.outcome,
          measuredEffectCents: projection.measuredEffectCents,
          observationCount: projection.observationCount,
          lastObservationAt: projection.lastObservationAt,
          projectionVersion: projection.projectionVersion,
        },
      });
    });
  }

  /**
   * Recompute the cached columns from the log without appending anything.
   *
   * The escape hatch that makes the cache honest: if the projection
   * implementation changes, or a column is ever suspected of drifting, this
   * restores it from the only source of truth. Nothing in the request path calls
   * it — it exists so the claim "the columns are rebuildable" is executable
   * rather than rhetorical.
   */
  async rebuildProjection(
    organizationId: string,
    priorityId: string,
  ): Promise<OperationalPriority | null> {
    const priority = await this.findById(organizationId, priorityId);
    if (!priority) return null;
    const log = await this.listObservations(organizationId, priority.id);
    const projection = projectLifecycle(log.map(toLifecycle));
    return this.prisma.operationalPriority.update({
      where: { id: priority.id },
      data: {
        state: projection.state,
        ownerUserId: projection.ownerUserId,
        stateChangedAt: projection.stateChangedAt,
        reopenCount: projection.reopenCount,
        resolvedAt: projection.resolvedAt,
        outcome: projection.outcome,
        measuredEffectCents: projection.measuredEffectCents,
        observationCount: projection.observationCount,
        lastObservationAt: projection.lastObservationAt,
        projectionVersion: projection.projectionVersion,
      },
    });
  }
}
