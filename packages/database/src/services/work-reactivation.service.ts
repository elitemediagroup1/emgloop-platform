// What happens to everything that was waiting, when a piece of work finishes.
//
// THE TRANSITION IS WORK OS'S, AND SO IS THE DECISION ABOUT WHAT IT UNBLOCKS.
// Commercial Intelligence may learn that work became actionable again; it may
// not be the thing that decided so. A Case inferring "the buyer probably replied,
// so that step is probably unblocked" and writing it would make CI the authority
// on an execution fact it cannot observe. Resolution comes from an authoritative
// Work transition or an attributed person, and from nowhere else.
//
// IT PUBLISHES THROUGH THE OUTBOX THAT ALREADY EXISTS. `StateChangeOutbox` has
// carried `subjectType: WORK_ITEM` and `domain: WORK` since the Decision Center
// shipped, with a publisher, a subscription table, per-subscriber delivery rows
// and a drain runner already built around it. A second event mechanism for work
// would have been a second retry policy, a second dead-letter, and a second way
// to be subtly wrong -- and this repository already documents `EVENT_BUS.md` as
// the cost of describing one that does not exist.
//
// THE PAYLOAD CARRIES NO BUSINESS CONTENT, matching the decision payload for the
// same two reasons: a copy of the row goes stale the moment the row changes, and
// an outbox row is not tenant-scoped by anything the subscriber controls, so
// copying content into it widens what a delivery bug can leak. A subscriber
// re-reads by id, scoped to the organization ON THE OUTBOX ROW.
//
// IDEMPOTENT BY CONSTRUCTION. A completion can be observed twice -- a retry, a
// double-click, a redelivery. Resolving an already-resolved dependency is a
// no-op that appends nothing, and a stage that is already actionable is not
// transitioned again, so a second pass publishes nothing and changes nothing.

import type { PrismaClient, WorkDependency } from '@prisma/client';

import { StateChangeOutboxRepository } from '../repositories/cognitive/active-state.repository';
import { WorkExecutionRepository, normalizeState } from '../repositories/work-execution.repository';

/** What one completion set off. Everything here is a fact, not an intention. */
export interface ReactivationResult {
  workInstanceId: string;
  /** Dependencies that stopped blocking because this work completed. */
  resolvedDependencyIds: readonly string[];
  /** Stages that became actionable as a result. */
  reactivatedStageIds: readonly string[];
  /**
   * Stages whose block cleared but which are STILL waiting on something else.
   *
   * Reported rather than silently omitted: "one of the three things it was
   * waiting for arrived" is a real answer to "why is this still blocked", and it
   * is the answer nobody has when only the reactivated set is published.
   */
  stillBlockedStageIds: readonly string[];
  /** Outbox rows written. Empty on a repeat pass, which is how idempotency shows. */
  publishedEventIds: readonly string[];
}

/** The events Work OS publishes about execution. Names are contract. */
export const WORK_EVENT_NAMES = {
  /** A work item reached completion. */
  COMPLETED: 'WorkItemCompleted',
  /** A dependency stopped blocking, and it is named on the payload. */
  DEPENDENCY_RESOLVED: 'WorkDependencyResolved',
  /**
   * An obligation that was blocked can now be acted on.
   *
   * THE EVENT COMMERCIAL INTELLIGENCE ACTUALLY WANTS. A Case that asked somebody
   * to do something, and watched it stall, learns here that it is moving again --
   * and re-ranks attention on the strength of a Work OS transition rather than
   * an inference of its own.
   */
  BECAME_ACTIONABLE: 'WorkBecameActionable',
} as const;

export interface WorkReactivationDeps {
  execution?: WorkExecutionRepository;
  outbox?: StateChangeOutboxRepository;
}

export class WorkReactivationService {
  private readonly execution: WorkExecutionRepository;
  private readonly outbox: StateChangeOutboxRepository;

  constructor(
    private readonly prisma: PrismaClient,
    deps: WorkReactivationDeps = {},
  ) {
    this.execution = deps.execution ?? new WorkExecutionRepository(prisma);
    this.outbox = deps.outbox ?? new StateChangeOutboxRepository(prisma);
  }

  /**
   * React to a work item having completed.
   *
   * THE COMPLETION IS VERIFIED HERE, NOT TRUSTED. The caller says a work item
   * finished; this checks `work_instances.status` within the organization before
   * acting. A caller that is wrong -- a retry firing against a cancelled item, a
   * stale queue message -- would otherwise unblock work on the strength of an
   * assertion nobody checked.
   *
   * SAFE TO CALL AGAIN. Everything below converges: resolved dependencies stay
   * resolved without appending, and stages already actionable are left alone.
   */
  async onWorkCompleted(
    organizationId: string,
    workInstanceId: string,
    actor: { userId: string | null; type?: 'HUMAN' | 'SYSTEM'; source?: string } = {
      userId: null,
      type: 'SYSTEM',
      source: 'work-os',
    },
    now: Date = new Date(),
  ): Promise<ReactivationResult | null> {
    const instance = await this.prisma.workInstance.findFirst({
      where: { id: workInstanceId, organizationId },
      select: { id: true, status: true },
    });
    // Not-found and not-completed are both "nothing to do here". Neither is an
    // error: a cross-tenant id must be indistinguishable from a missing one, and
    // an item that is not finished has unblocked nothing.
    if (!instance || instance.status !== 'completed') return null;

    const waiting = await this.execution.listDependentsOfWork(organizationId, workInstanceId);
    const resolvedDependencyIds: string[] = [];
    const reactivatedStageIds: string[] = [];
    const stillBlockedStageIds: string[] = [];
    const publishedEventIds: string[] = [];

    // The completion itself, published whether or not anything was waiting. A
    // subscriber that only cares that work finished should not have to
    // understand dependencies, and should not stop hearing about completions on
    // the days nothing happened to be blocked on them.
    publishedEventIds.push(
      await this.publish(organizationId, {
        eventType: WORK_EVENT_NAMES.COMPLETED,
        subjectId: workInstanceId,
        changeType: 'completed',
        payload: { workInstanceId, waitingCount: waiting.length },
      }),
    );

    for (const dependency of waiting) {
      const resolved = await this.execution.resolveDependency(
        organizationId,
        dependency.id,
        'DEPENDED_WORK_COMPLETED',
        { userId: actor.userId, type: actor.type ?? 'SYSTEM', source: actor.source ?? 'work-os' },
        now,
      );
      if (!resolved) continue;
      resolvedDependencyIds.push(dependency.id);
      publishedEventIds.push(
        await this.publish(organizationId, {
          eventType: WORK_EVENT_NAMES.DEPENDENCY_RESOLVED,
          subjectId: dependency.workStageId,
          changeType: 'dependency_resolved',
          payload: {
            workStageId: dependency.workStageId,
            dependencyId: dependency.id,
            dependsOnWorkInstanceId: workInstanceId,
          },
        }),
      );

      const outcome = await this.reconsider(organizationId, dependency, actor, now);
      if (outcome === 'REACTIVATED') {
        reactivatedStageIds.push(dependency.workStageId);
        publishedEventIds.push(
          await this.publish(organizationId, {
            eventType: WORK_EVENT_NAMES.BECAME_ACTIONABLE,
            subjectId: dependency.workStageId,
            changeType: 'became_actionable',
            payload: { workStageId: dependency.workStageId, unblockedBy: workInstanceId },
          }),
        );
      } else if (outcome === 'STILL_BLOCKED') {
        stillBlockedStageIds.push(dependency.workStageId);
      }
    }

    return {
      workInstanceId,
      resolvedDependencyIds,
      reactivatedStageIds,
      stillBlockedStageIds,
      publishedEventIds,
    };
  }

  /**
   * Whether one stage can now proceed.
   *
   * ONE OF SEVERAL BLOCKS CLEARING IS NOT BEING UNBLOCKED. A stage waiting on
   * three things and now waiting on two is still blocked, and publishing
   * `WorkBecameActionable` for it would send somebody to work they still cannot
   * do. This is the check that makes the event trustworthy.
   *
   * AND ONLY A BLOCKED STAGE IS REACTIVATED. A stage its owner moved on to
   * something else, or completed, or that is waiting on a person rather than on
   * this dependency, is left exactly where it is -- Work OS does not know better
   * than the last person who touched it.
   */
  private async reconsider(
    organizationId: string,
    dependency: WorkDependency,
    actor: { userId: string | null; type?: 'HUMAN' | 'SYSTEM'; source?: string },
    now: Date,
  ): Promise<'REACTIVATED' | 'STILL_BLOCKED' | 'UNCHANGED'> {
    const open = await this.execution.listDependencies(organizationId, dependency.workStageId, {
      openOnly: true,
    });
    if (open.length > 0) return 'STILL_BLOCKED';

    const stage = await this.execution.getStage(organizationId, dependency.workStageId);
    if (!stage) return 'UNCHANGED';
    if (normalizeState(stage.status) !== 'blocked') return 'UNCHANGED';

    const moved = await this.execution.transition(organizationId, dependency.workStageId, {
      to: 'ready',
      actorUserId: actor.userId,
      actorType: actor.type ?? 'SYSTEM',
      source: actor.source ?? 'work-os',
      occurredAt: now,
      note: 'Everything this was waiting on has resolved.',
    });
    return moved.ok ? 'REACTIVATED' : 'UNCHANGED';
  }

  private async publish(
    organizationId: string,
    input: {
      eventType: string;
      subjectId: string;
      changeType: string;
      payload: Record<string, unknown>;
    },
  ): Promise<string> {
    const row = await this.outbox.enqueue(organizationId, {
      // BOTH VALUES ALREADY EXISTED. `WORK_ITEM` and `WORK` have been in the
      // schema since the Decision Center shipped, waiting for a producer. This
      // is that producer, and it needed no migration to become one.
      subjectType: 'WORK_ITEM',
      domain: 'WORK',
      subjectId: input.subjectId,
      eventType: input.eventType,
      stateKey: `work:${input.subjectId}`,
      changeType: input.changeType,
      payload: input.payload,
    });
    return row.id;
  }
}
