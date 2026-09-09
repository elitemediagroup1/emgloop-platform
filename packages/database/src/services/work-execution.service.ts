// What is actually going on with one piece of work — assembled, never stored.
//
// WHAT THIS IS. The read that answers "is this on track", by loading the
// obligation, its history and its open blocks, and handing all three to the pure
// assessor. It is the only place that composes those, so there is exactly one
// answer to whether something is overdue.
//
// NOTHING ABOUT THE ANSWER IS PERSISTED. Not the SLA state, not the durations,
// not reminder or escalation eligibility. Every one of them is a function of the
// current time, so a stored copy would be wrong within the hour and a person
// looking at a stale "within policy" would be worse off than one told nothing.
// The log is durable; the verdict is computed.
//
// NO MODEL DECIDES ANY OF IT. Whether work is late is arithmetic over
// timestamps, and it stays arithmetic.
//
// COMMERCIAL INTELLIGENCE READS THIS AND MAY NOT WRITE IT. A Case shows the
// execution state of the work it asked for; it does not own it, copy it, or
// change it. That boundary is enforced by the shape of what CI is given — a
// view, assembled here, whose every field is derived at read time.

import type { PrismaClient, WorkDependency } from '@prisma/client';
import {
  assessExecution,
  dependencyIsOpen,
  type DependencyKind,
  type DependencyResolution,
  type DependencyView,
  type ExecutionAssessment,
  type WaitDeclaration,
  type WaitReason,
  type WorkExecutionState,
} from '@emgloop/shared';

import {
  WorkExecutionRepository,
  normalizeState,
  toEventRecords,
  type DependencyResult,
  type TransitionInput,
  type TransitionResult,
} from '../repositories/work-execution.repository';

/** Everything a surface needs about one obligation, in one shape. */
export interface WorkExecutionView {
  workInstanceId: string;
  workStageId: string;
  title: string;
  stageName: string;
  ownerUserId: string | null;
  /** The verdict. Derived on every read, stored nowhere. */
  assessment: ExecutionAssessment;
  /** What is blocking it, resolved and unresolved alike. History is kept. */
  dependencies: readonly DependencyView[];
  openDependencies: readonly DependencyView[];
}

export interface WorkExecutionDeps {
  execution?: WorkExecutionRepository;
}

export class WorkExecutionService {
  private readonly execution: WorkExecutionRepository;

  constructor(prisma: PrismaClient, deps: WorkExecutionDeps = {}) {
    this.execution = deps.execution ?? new WorkExecutionRepository(prisma);
  }

  /**
   * The current state of one obligation, with the reasoning that produced it.
   *
   * `now` IS AN ARGUMENT ALL THE WAY DOWN. The assessor is pure and this passes
   * the clock into it, so the same question asked about the same moment always
   * gets the same answer — which is what makes "why is this escalation-eligible"
   * a thing that can be tested rather than a thing that has to be trusted.
   */
  async get(
    organizationId: string,
    stageId: string,
    now: Date = new Date(),
  ): Promise<WorkExecutionView | null> {
    const stage = await this.execution.getStage(organizationId, stageId);
    if (!stage) return null;

    const state = normalizeState(stage.status);
    if (state === null) {
      // A stored status this build does not know. Refusing to assess is the
      // honest answer: assuming the nearest known state would attribute
      // accountability on the strength of a guess.
      return null;
    }

    const [events, dependencies] = await Promise.all([
      this.execution.listEvents(organizationId, stageId),
      this.execution.listDependencies(organizationId, stageId),
    ]);
    const views = dependencies.map(toDependencyView);
    const open = views.filter(dependencyIsOpen);

    const assessment = assessExecution({
      state,
      dueAt: stage.dueAt,
      events: toEventRecords(events),
      waiting: currentWait(events),
      openDependencies: open.length,
      now,
    });

    return {
      workInstanceId: stage.workInstanceId,
      workStageId: stage.id,
      title: stage.workInstance.title,
      stageName: stage.name,
      ownerUserId: stage.ownerUserId,
      assessment,
      dependencies: views,
      openDependencies: open,
    };
  }

  /**
   * The obligation that best represents a whole work item right now.
   *
   * WHY A WORK ITEM NEEDS ONE. A Case points at a work INSTANCE — that is what
   * `destinationId` records — but accountability lives on a STAGE, because a
   * stage is what has an owner and a clock. Something has to choose which stage
   * answers "where does this stand", and doing it here means every caller gets
   * the same choice rather than each picking its own.
   *
   * THE CHOICE, IN ORDER: the instance's current stage if it names one, else the
   * first stage that is not finished, else the last stage. The first two are
   * where the work actually is; the third is what a completed item looks like,
   * and returning it is what lets a finished work item report CLOSED rather than
   * report nothing.
   *
   * RETURNS null FOR A WORK ITEM WITH NO STAGES, which is a real shape — an
   * instance can exist mid-creation — and is reported as unreadable rather than
   * as fine.
   */
  async getForWorkInstance(
    organizationId: string,
    workInstanceId: string,
    now: Date = new Date(),
  ): Promise<{ workStatus: string; view: WorkExecutionView | null } | null> {
    const instance = await this.execution.getWorkInstance(organizationId, workInstanceId);
    if (!instance) return null;
    const stageId = this.execution.representativeStageId(instance);
    if (!stageId) return { workStatus: instance.status, view: null };
    return { workStatus: instance.status, view: await this.get(organizationId, stageId, now) };
  }

  /** Move an obligation. Refuses, with a reason, rather than coercing. */
  transition(
    organizationId: string,
    stageId: string,
    input: TransitionInput,
  ): Promise<TransitionResult> {
    return this.execution.transition(organizationId, stageId, input);
  }

  /** Set or move the expected time. Every move stays on the log. */
  setDue(
    organizationId: string,
    stageId: string,
    dueAt: Date,
    actor: { userId: string | null; type?: 'HUMAN' | 'SYSTEM'; source?: string },
    note?: string | null,
  ) {
    return this.execution.setDue(organizationId, stageId, dueAt, actor, note);
  }

  /** Declare a block. Fails closed on self-dependency, cross-tenant and cycles. */
  addDependency(
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
    return this.execution.addDependency(organizationId, stageId, input);
  }

  /**
   * Record that a block cleared, and say how.
   *
   * THE AUTHORITY IS ALWAYS HERE. A dependency resolves because Work OS observed
   * its own transition or because an attributed person said so — never because
   * some other part of the platform inferred that something probably happened.
   */
  resolveDependency(
    organizationId: string,
    dependencyId: string,
    resolution: DependencyResolution,
    actor: { userId: string | null; type?: 'HUMAN' | 'SYSTEM'; source?: string },
    occurredAt?: Date,
  ) {
    return this.execution.resolveDependency(
      organizationId,
      dependencyId,
      resolution,
      actor,
      occurredAt,
    );
  }
}

// --- Projections ------------------------------------------------------------------

function toDependencyView(d: WorkDependency): DependencyView {
  return {
    id: d.id,
    kind: d.kind as DependencyKind,
    dependsOnWorkInstanceId: d.dependsOnWorkInstanceId,
    conditionSubject: d.conditionSubject,
    description: d.description,
    expectedResolutionAt: d.expectedResolutionAt,
    resolvedAt: d.resolvedAt,
    resolution: (d.resolution as DependencyResolution | null) ?? null,
    createdAt: d.createdAt,
  };
}

/**
 * The wait currently in force, read from the last state change into one.
 *
 * FROM THE LOG, NOT FROM A COLUMN. The declaration belongs to the transition
 * that entered the wait, and keeping it there means the reason a stage waited in
 * March is still legible in June — a mutable "current wait" column would have
 * been overwritten by the next one.
 *
 * A LATER CHANGE OUT OF WAITING CLEARS IT, because the wait is over. Reading the
 * newest event backwards is what makes that automatic rather than a second write
 * somebody could forget.
 */
function currentWait(
  events: readonly { eventType: string; toStatus: string | null; waitReason: string | null; waitSubject: string | null; expectedResolutionAt: Date | null; note: string | null; sequence: number }[],
): WaitDeclaration | null {
  const latest = [...events]
    .filter((e) => e.eventType === 'STATE_CHANGED')
    .sort((a, b) => b.sequence - a.sequence)[0];
  if (!latest || latest.waitReason === null) return null;
  const state = latest.toStatus ? (latest.toStatus as WorkExecutionState) : null;
  if (state === null || (state !== 'waiting_internal' && state !== 'waiting_external' && state !== 'blocked')) {
    return null;
  }
  return {
    reason: latest.waitReason as WaitReason,
    subject: latest.waitSubject,
    expectedResolutionAt: latest.expectedResolutionAt,
    note: latest.note,
  };
}
