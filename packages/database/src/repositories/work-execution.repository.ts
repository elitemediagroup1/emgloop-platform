// Execution truth: the writes, and the reads they are derived from.
//
// WHAT THIS OWNS. Whether an obligation is actionable, waiting or blocked; when
// it was expected; what is blocking it; and the append-only history all three
// are derived from. Nothing else in the platform may write any of it.
//
// WHY IT IS SEPARATE FROM WorkRepository. That file is 1,250 lines and already
// carries blueprints, work types, workflow templates, instances, stages,
// assignments, notifications and comments. Adding an execution clock, a wait
// vocabulary, a dependency graph and an event log to it would have made the one
// file nobody can hold in their head longer. This is the same layer, split by
// concern rather than by table.
//
// EVERY METHOD TAKES THE ORGANIZATION FIRST, and resolves the row within it
// before touching anything. A stage is reached only through its work instance,
// which is where the organization lives, so another tenant's stage id resolves
// to null rather than to a row. Not-found, never forbidden.
//
// STATE CHANGES AND THEIR LOG ROWS ARE ONE TRANSACTION. A status written without
// its event would make every duration below wrong forever, and there would be
// nothing to notice it with -- the projection would simply be quietly short.

import type { Prisma, PrismaClient, WorkDependency, WorkStage, WorkStageEvent } from '@prisma/client';
import {
  ALLOWED_TRANSITIONS,
  WAIT_STATE_FOR_REASON,
  isTerminal,
  isWaitReason,
  isWorkExecutionState,
  transitionAllowed,
  wouldCreateCycle,
  type DependencyKind,
  type DependencyRefusal,
  type DependencyResolution,
  type WaitReason,
  type WorkEventType,
  type WorkExecutionState,
  type WorkStageEventRecord,
} from '@emgloop/shared';

export interface StageWithInstance extends WorkStage {
  workInstance: { id: string; organizationId: string; status: string; title: string };
}

/** What a caller supplies to move an obligation. */
export interface TransitionInput {
  to: WorkExecutionState;
  actorUserId: string | null;
  actorType?: 'HUMAN' | 'SYSTEM';
  source?: string;
  occurredAt?: Date;
  note?: string | null;
  /** Required when `to` is a waiting state. Structured, never prose. */
  wait?: {
    reason: WaitReason;
    subject?: string | null;
    expectedResolutionAt?: Date | null;
  };
}

/** Why a transition was refused. Fail closed, always with a reason. */
export const TRANSITION_REFUSALS = [
  'STAGE_NOT_FOUND',
  'UNKNOWN_STATE',
  'TRANSITION_NOT_ALLOWED',
  'WAIT_REASON_REQUIRED',
  'WAIT_REASON_MISMATCH',
  'UNKNOWN_WAIT_REASON',
  'BLOCKED_BY_DEPENDENCY',
] as const;
export type TransitionRefusal = (typeof TRANSITION_REFUSALS)[number];

export type TransitionResult =
  | { ok: true; stage: WorkStage; event: WorkStageEvent }
  | { ok: false; refusal: TransitionRefusal };

export type DependencyResult =
  | { ok: true; dependency: WorkDependency }
  | { ok: false; refusal: DependencyRefusal };

export class WorkExecutionRepository {
  constructor(private readonly prisma: PrismaClient) {}

  // =========================================================================
  // Reads
  // =========================================================================

  /**
   * One stage, resolved within the organization through its work instance.
   *
   * `work_stages` carries no organizationId of its own -- it is scoped by its
   * instance -- so the tenant check is a filter on the relation rather than on
   * the row. That is the only correct place for it: a stage id from another
   * tenant matches nothing here and never reaches a write.
   */
  async getStage(organizationId: string, stageId: string): Promise<StageWithInstance | null> {
    const stage = await this.prisma.workStage.findUnique({ where: { id: stageId } });
    if (!stage) return null;
    // THE TENANT GATE IS THE INSTANCE, and it is not optional. `work_stages`
    // carries no organizationId of its own, so the only authoritative answer to
    // "whose stage is this" is its work instance resolved WITHIN the
    // organization. A stage whose instance does not resolve here returns null and
    // its row never leaves this method -- the caller cannot tell it from an id
    // that does not exist, which is the point.
    const workInstance = await this.prisma.workInstance.findFirst({
      where: { id: stage.workInstanceId, organizationId },
      select: { id: true, organizationId: true, status: true, title: true },
    });
    if (!workInstance) return null;
    return { ...stage, workInstance };
  }

  /** The full history of one obligation, in sequence order. */
  async listEvents(organizationId: string, stageId: string): Promise<WorkStageEvent[]> {
    return this.prisma.workStageEvent.findMany({
      where: { organizationId, workStageId: stageId },
      orderBy: { sequence: 'asc' },
    });
  }

  /** Everything currently blocking one obligation. */
  async listDependencies(
    organizationId: string,
    stageId: string,
    opts: { openOnly?: boolean } = {},
  ): Promise<WorkDependency[]> {
    return this.prisma.workDependency.findMany({
      where: {
        organizationId,
        workStageId: stageId,
        ...(opts.openOnly ? { resolvedAt: null } : {}),
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * Open dependencies waiting on one work item.
   *
   * THE REACTIVATION READ. When a work item completes, this is what was waiting
   * on it. Indexed for exactly this query, because it runs on every completion.
   */
  async listDependentsOfWork(
    organizationId: string,
    workInstanceId: string,
  ): Promise<WorkDependency[]> {
    return this.prisma.workDependency.findMany({
      where: { organizationId, dependsOnWorkInstanceId: workInstanceId, resolvedAt: null },
      orderBy: { createdAt: 'asc' },
    });
  }

  // =========================================================================
  // Writes
  // =========================================================================

  /**
   * Move an obligation from one state to another, and record that it moved.
   *
   * REFUSES RATHER THAN COERCES. An unlisted transition, a wait with no reason,
   * a reason that does not match the state being entered -- each returns a
   * refusal. Terminal states have no exits at all: reopening completed work is a
   * different act with a different name, and allowing it through a status write
   * would erase the completion from the only place it is recorded.
   *
   * BECOMING ACTIONABLE STAMPS `actionableAt` ONCE. The first time an obligation
   * could be acted on is the origin of every duration in the assessment, and
   * re-stamping it on a later return from waiting would silently reset an
   * accountability clock that must never be resettable.
   */
  async transition(
    organizationId: string,
    stageId: string,
    input: TransitionInput,
  ): Promise<TransitionResult> {
    const stage = await this.getStage(organizationId, stageId);
    if (!stage) return { ok: false, refusal: 'STAGE_NOT_FOUND' };

    const from = normalizeState(stage.status);
    if (!isWorkExecutionState(input.to)) return { ok: false, refusal: 'UNKNOWN_STATE' };
    if (from === null) {
      // A stored status this build cannot interpret. Refuse rather than guess:
      // guessing would write a transition FROM a state that never existed.
      return { ok: false, refusal: 'UNKNOWN_STATE' };
    }
    if (!transitionAllowed(from, input.to)) {
      return { ok: false, refusal: 'TRANSITION_NOT_ALLOWED' };
    }

    const entersWaiting = ALLOWED_TRANSITIONS[from].includes(input.to) && isWaitingState(input.to);
    if (entersWaiting) {
      if (!input.wait) return { ok: false, refusal: 'WAIT_REASON_REQUIRED' };
      if (!isWaitReason(input.wait.reason)) return { ok: false, refusal: 'UNKNOWN_WAIT_REASON' };
      // The state and the reason cannot disagree. If they were independent, a
      // row could claim to be waiting internally on an external response, and
      // nothing would catch it.
      if (WAIT_STATE_FOR_REASON[input.wait.reason] !== input.to) {
        return { ok: false, refusal: 'WAIT_REASON_MISMATCH' };
      }
    }

    // AN OPEN DEPENDENCY MEANS IT IS NOT ACTIONABLE. Letting a blocked stage be
    // marked ready would make the assessment claim somebody can act on
    // something they demonstrably cannot, and start a clock against them for it.
    if (isActionableState(input.to)) {
      const open = await this.prisma.workDependency.count({
        where: { organizationId, workStageId: stageId, resolvedAt: null },
      });
      if (open > 0) return { ok: false, refusal: 'BLOCKED_BY_DEPENDENCY' };
    }

    const occurredAt = input.occurredAt ?? new Date();

    return this.prisma.$transaction(async (tx) => {
      const event = await this.append(tx, organizationId, stage, {
        eventType: 'STATE_CHANGED',
        occurredAt,
        fromStatus: from,
        toStatus: input.to,
        waitReason: input.wait?.reason ?? null,
        waitSubject: input.wait?.subject ?? null,
        expectedResolutionAt: input.wait?.expectedResolutionAt ?? null,
        dueAt: null,
        dependencyId: null,
        actorType: input.actorType ?? 'HUMAN',
        actorUserId: input.actorUserId,
        source: input.source ?? 'work-os',
        note: input.note ?? null,
      });

      const updated = await tx.workStage.update({
        where: { id: stageId },
        data: {
          status: input.to,
          // Stamped once, on the first time this could be acted on.
          ...(isActionableState(input.to) && stage.actionableAt === null
            ? { actionableAt: occurredAt }
            : {}),
          ...(input.to === 'in_progress' && stage.startedAt === null
            ? { startedAt: occurredAt }
            : {}),
          ...(input.to === 'completed'
            ? { completedAt: occurredAt, completedByUserId: input.actorUserId }
            : {}),
        },
      });
      return { ok: true as const, stage: updated, event };
    });
  }

  /**
   * Set or move the time an obligation is expected to be met.
   *
   * A MOVE IS A DIFFERENT EVENT FROM A FIRST SETTING, and every move stays on
   * the log. "This has been pushed four times" is one of the few facts about
   * execution that nobody volunteers and everybody wants, and it is derivable
   * only because the moves are not overwritten.
   */
  async setDue(
    organizationId: string,
    stageId: string,
    dueAt: Date,
    actor: { userId: string | null; type?: 'HUMAN' | 'SYSTEM'; source?: string },
    note?: string | null,
  ): Promise<{ stage: WorkStage; event: WorkStageEvent } | null> {
    const stage = await this.getStage(organizationId, stageId);
    if (!stage) return null;
    const eventType: WorkEventType = stage.dueAt === null ? 'DUE_SET' : 'DUE_EXTENDED';

    return this.prisma.$transaction(async (tx) => {
      const event = await this.append(tx, organizationId, stage, {
        eventType,
        occurredAt: new Date(),
        fromStatus: null,
        toStatus: null,
        waitReason: null,
        waitSubject: null,
        expectedResolutionAt: null,
        dueAt,
        dependencyId: null,
        actorType: actor.type ?? 'HUMAN',
        actorUserId: actor.userId,
        source: actor.source ?? 'work-os',
        note: note ?? null,
      });
      const updated = await tx.workStage.update({ where: { id: stageId }, data: { dueAt } });
      return { stage: updated, event };
    });
  }

  /**
   * Declare that an obligation cannot proceed until something else resolves.
   *
   * EVERY REFUSAL IS A REAL ONE. Self-dependency, cross-tenant, a cycle, a
   * missing subject and a duplicate all fail closed with a named reason rather
   * than being written and sorted out later. A cycle in particular is not merely
   * untidy: every work item in it waits forever and nothing would ever say why.
   */
  async addDependency(
    organizationId: string,
    stageId: string,
    input: {
      kind: DependencyKind;
      dependsOnWorkInstanceId?: string | null;
      conditionSubject?: string | null;
      description: string;
      expectedResolutionAt?: Date | null;
      createdByUserId: string | null;
    },
  ): Promise<DependencyResult> {
    const stage = await this.getStage(organizationId, stageId);
    if (!stage) return { ok: false, refusal: 'STAGE_NOT_FOUND' };

    if (input.kind === 'WORK_INSTANCE') {
      const target = input.dependsOnWorkInstanceId?.trim();
      if (!target) return { ok: false, refusal: 'MISSING_SUBJECT' };
      if (target === stage.workInstanceId) return { ok: false, refusal: 'SELF_DEPENDENCY' };

      // Resolved WITHIN the organization. A work id from another tenant is
      // not-found, and is never written into a dependency row.
      const depended = await this.prisma.workInstance.findFirst({
        where: { id: target, organizationId },
        select: { id: true },
      });
      if (!depended) return { ok: false, refusal: 'CROSS_TENANT' };

      const existing = await this.prisma.workDependency.findFirst({
        where: { workStageId: stageId, dependsOnWorkInstanceId: target },
      });
      if (existing) return { ok: false, refusal: 'ALREADY_DECLARED' };

      // The graph is loaded tenant-scoped and walked in memory. Only OPEN
      // dependencies constrain: a resolved one is history, and history cannot
      // make new work wait.
      const open = await this.prisma.workDependency.findMany({
        where: { organizationId, resolvedAt: null, dependsOnWorkInstanceId: { not: null } },
        select: { workStageId: true, dependsOnWorkInstanceId: true },
      });
      const stageIds = new Set(open.map((d) => d.workStageId));
      const stages = await this.prisma.workStage.findMany({
        where: { id: { in: [...stageIds] } },
        select: { id: true, workInstanceId: true },
      });
      const instanceOf = new Map(stages.map((s) => [s.id, s.workInstanceId]));
      const edges = open.flatMap((d) => {
        const fromInstance = instanceOf.get(d.workStageId);
        return fromInstance && d.dependsOnWorkInstanceId
          ? [{ from: fromInstance, to: d.dependsOnWorkInstanceId }]
          : [];
      });
      if (wouldCreateCycle(edges, stage.workInstanceId, target)) {
        return { ok: false, refusal: 'CYCLE' };
      }
    } else if (!input.conditionSubject?.trim()) {
      return { ok: false, refusal: 'MISSING_SUBJECT' };
    }

    return this.prisma.$transaction(async (tx) => {
      const dependency = await tx.workDependency.create({
        data: {
          organizationId,
          workStageId: stageId,
          kind: input.kind,
          dependsOnWorkInstanceId:
            input.kind === 'WORK_INSTANCE' ? (input.dependsOnWorkInstanceId ?? null) : null,
          conditionSubject:
            input.kind === 'EXTERNAL_CONDITION' ? (input.conditionSubject ?? null) : null,
          description: input.description,
          expectedResolutionAt: input.expectedResolutionAt ?? null,
          createdByUserId: input.createdByUserId,
        },
      });
      await this.append(tx, organizationId, stage, {
        eventType: 'DEPENDENCY_ADDED',
        occurredAt: new Date(),
        fromStatus: null,
        toStatus: null,
        waitReason: 'AWAITING_DEPENDENCY',
        waitSubject: input.dependsOnWorkInstanceId ?? input.conditionSubject ?? null,
        expectedResolutionAt: input.expectedResolutionAt ?? null,
        dueAt: null,
        dependencyId: dependency.id,
        actorType: 'HUMAN',
        actorUserId: input.createdByUserId,
        source: 'work-os',
        note: input.description,
      });
      return { ok: true as const, dependency };
    });
  }

  /**
   * Record that a dependency stopped blocking, and say how.
   *
   * IDEMPOTENT. Resolving an already-resolved dependency returns the row
   * unchanged and appends nothing -- a completion event can arrive twice, and
   * the second arrival must not manufacture a second history.
   *
   * THE ROW IS NEVER DELETED. Keeping it is what lets somebody afterwards see
   * why a piece of work was stalled for a week.
   */
  async resolveDependency(
    organizationId: string,
    dependencyId: string,
    resolution: DependencyResolution,
    actor: { userId: string | null; type?: 'HUMAN' | 'SYSTEM'; source?: string },
    occurredAt?: Date,
  ): Promise<WorkDependency | null> {
    const dependency = await this.prisma.workDependency.findFirst({
      where: { id: dependencyId, organizationId },
    });
    if (!dependency) return null;
    if (dependency.resolvedAt !== null) return dependency;

    const stage = await this.getStage(organizationId, dependency.workStageId);
    if (!stage) return null;
    const at = occurredAt ?? new Date();

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.workDependency.update({
        where: { id: dependencyId },
        data: { resolvedAt: at, resolution, resolvedByUserId: actor.userId },
      });
      await this.append(tx, organizationId, stage, {
        eventType: 'DEPENDENCY_RESOLVED',
        occurredAt: at,
        fromStatus: null,
        toStatus: null,
        waitReason: null,
        waitSubject: null,
        expectedResolutionAt: null,
        dueAt: null,
        dependencyId,
        actorType: actor.type ?? 'HUMAN',
        actorUserId: actor.userId,
        source: actor.source ?? 'work-os',
        note: null,
      });
      return updated;
    });
  }

  // =========================================================================
  // Internals
  // =========================================================================

  /**
   * Append one row to a stage's log.
   *
   * THE SEQUENCE IS READ INSIDE THE TRANSACTION and the unique on
   * (workStageId, sequence) is what makes a concurrent double-append fail loudly
   * rather than silently interleave. Same device as the Case log.
   */
  private async append(
    tx: Prisma.TransactionClient,
    organizationId: string,
    stage: StageWithInstance,
    row: {
      eventType: WorkEventType;
      occurredAt: Date;
      fromStatus: WorkExecutionState | null;
      toStatus: WorkExecutionState | null;
      waitReason: WaitReason | null;
      waitSubject: string | null;
      expectedResolutionAt: Date | null;
      dueAt: Date | null;
      dependencyId: string | null;
      actorType: 'HUMAN' | 'SYSTEM';
      actorUserId: string | null;
      source: string;
      note: string | null;
    },
  ): Promise<WorkStageEvent> {
    const last = await tx.workStageEvent.findFirst({
      where: { workStageId: stage.id },
      orderBy: { sequence: 'desc' },
      select: { sequence: true },
    });
    return tx.workStageEvent.create({
      data: {
        organizationId,
        workInstanceId: stage.workInstanceId,
        workStageId: stage.id,
        sequence: (last?.sequence ?? 0) + 1,
        ...row,
      },
    });
  }
}

// --- Helpers ------------------------------------------------------------------------

/** A stored status this build understands, or null. Never a guess. */
export function normalizeState(status: string): WorkExecutionState | null {
  return isWorkExecutionState(status) ? status : null;
}

function isWaitingState(state: WorkExecutionState): boolean {
  return state === 'waiting_internal' || state === 'waiting_external' || state === 'blocked';
}

function isActionableState(state: WorkExecutionState): boolean {
  return state === 'ready' || state === 'in_progress';
}

/** The stored rows, in the shape the pure assessor replays. */
export function toEventRecords(events: readonly WorkStageEvent[]): WorkStageEventRecord[] {
  return events.map((e) => ({
    eventType: e.eventType as WorkEventType,
    occurredAt: e.occurredAt,
    sequence: e.sequence,
    fromStatus: e.fromStatus ? normalizeState(e.fromStatus) : null,
    toStatus: e.toStatus ? normalizeState(e.toStatus) : null,
    waitReason: e.waitReason && isWaitReason(e.waitReason) ? e.waitReason : null,
    expectedResolutionAt: e.expectedResolutionAt,
    dueAt: e.dueAt,
    actorUserId: e.actorUserId,
  }));
}

/** True when nothing further is expected of this obligation. */
export function stageIsClosed(stage: Pick<WorkStage, 'status'>): boolean {
  const s = normalizeState(stage.status);
  return s !== null && isTerminal(s);
}
