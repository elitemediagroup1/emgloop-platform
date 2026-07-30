// The Decision Engine — the canonical, organization-scoped application service
// that turns intelligence into durable operational decisions.
//
// THIS IS THE ONLY SUPPORTED INTERFACE FOR PRODUCERS. CallGrid Intelligence is
// the first; CRM, Accounting, Website, Marketing, Support, Compliance, Creator
// and AI Employees are expected to follow, and every one of them uses this same
// service. No producer may touch the repositories, the observation log, the
// projection columns or the outbox directly — not because that would be untidy,
// but because the invariants below only hold if there is exactly one place that
// enforces them.
//
// WHAT IT OWNS
//   Lifecycle invariants, transaction boundaries, projection maintenance, and
//   publication of exactly one domain event per lifecycle operation.
//
// WHAT IT DOES NOT OWN
//   Analysis. The engine never looks at raw data, never computes a metric and
//   never decides whether something is significant. It runs AFTER intelligence
//   has been produced, and its input is a producer's conclusion.
//
// WHAT IT KNOWS NOTHING ABOUT
//   Buyers, campaigns, calls, invoices, pages, tickets, revenue — and every
//   subscriber. Producers describe their subject in `sourceReference`, which is
//   opaque here and never parsed. Consumers read the outbox; the engine has no
//   idea they exist.
//
// THE TRANSACTION RULE
//   Every state-changing operation is atomic: validate scope, load, validate the
//   transition, append the immutable observation, rewrite the projection from the
//   whole log, write the domain event, commit once. No operation may append an
//   observation without publishing its event, or publish an event for something
//   that did not persist. A subscriber that learns about something which did not
//   happen is a bug; one that never learns about something which did is worse.

import type {
  PrismaClient,
  Prisma,
  OperationalPriority,
  OperationalObservation,
  DecisionEvidence,
  OperationalObservationType,
  OperationalPriorityState,
} from '@prisma/client';
import {
  projectLifecycle,
  summarizeHistory,
  isClosed,
  isDecisionSeverity,
  type LifecycleObservation,
  type PriorityState,
} from '@emgloop/shared';

import { StateChangeOutboxRepository } from '../../repositories/cognitive/active-state.repository';
import { DECISION_EVENT_TYPE, decisionStateKey } from './decision-events';
import {
  DecisionNotFoundError,
  InvalidDecisionInputError,
  InvalidTransitionError,
} from './decision-engine.errors';
import type {
  CreateDecisionInput,
  UpdateDecisionInput,
  DecisionActionInput,
  AssignInput,
  SetOwnerInput,
  CloseInput,
  RecordOutcomeInput,
  AddObservationInput,
  DecisionEvidenceInput,
  DecisionResult,
  DecisionView,
  DecisionTimelineEntry,
  ListDecisionsOptions,
  DecisionActor,
} from './decision-engine.contracts';

/** Map a stored observation into the pure projection contract. */
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

/** Every write is attributed. A HUMAN action with no user is not attributable. */
function validateActor(actor: DecisionActor): void {
  if (actor.type === 'HUMAN' && !actor.userId) {
    throw new InvalidDecisionInputError('A human action must name the acting user');
  }
  if (!actor.source || !actor.source.trim()) {
    throw new InvalidDecisionInputError('Every observation must record what produced it');
  }
}

export class DecisionEngine {
  private readonly outbox: StateChangeOutboxRepository;

  constructor(private readonly prisma: PrismaClient) {
    this.outbox = new StateChangeOutboxRepository(prisma);
  }

  // =========================================================================
  // Producer entry point
  // =========================================================================

  /**
   * Open a decision, or record that an existing one was seen again.
   *
   * Idempotent on two axes, which is what makes it safe to call from a
   * server-rendered page that re-runs on every request:
   *   - `(organizationId, producer, recurrenceKey)` is the decision's identity,
   *      so the same situation tomorrow lands on the same row;
   *   - `(decisionId, detectionKey)` is the sighting's identity, so re-analysing
   *      the same period any number of times records exactly one sighting.
   *
   * A sighting from a period that ENDED BEFORE an existing resolution does not
   * reopen anything. Reading history is not relapsing, and without that guard an
   * operator could corrupt the record by changing a date filter.
   */
  async create(organizationId: string, input: CreateDecisionInput): Promise<DecisionResult> {
    if (!input.producer?.trim()) {
      throw new InvalidDecisionInputError('A decision must name its producer');
    }
    if (!input.recurrenceKey?.trim()) {
      throw new InvalidDecisionInputError('A decision must carry a stable recurrence key');
    }
    if (!input.detectionKey?.trim()) {
      throw new InvalidDecisionInputError(
        'A decision must name the analysis period that produced it, or it cannot be recorded idempotently',
      );
    }
    // The severity vocabulary is shared across producers because a cross-producer
    // queue has to rank them against each other. Rejecting here is the boundary
    // mapping the contract describes; the column is a String only so that a new
    // producer is never blocked by a migration.
    if (!isDecisionSeverity(input.severity)) {
      throw new InvalidDecisionInputError(
        `Unknown severity "${input.severity}". Producers map their own scale into DECISION_SEVERITIES at the boundary.`,
      );
    }

    const existing = await this.findByRecurrenceKey(
      organizationId,
      input.producer,
      input.recurrenceKey,
    );
    if (existing) return this.resight(organizationId, existing, input);

    try {
      return await this.prisma.$transaction(async (tx) => {
        const hypothesisId = input.hypothesis
          ? (
              await tx.intelligenceHypothesis.create({
                data: {
                  organizationId,
                  hypothesisType: input.hypothesis.hypothesisType,
                  title: input.hypothesis.title,
                  summary: input.hypothesis.summary ?? null,
                  // ALWAYS proposed. There is no path in this engine that accepts
                  // a hypothesis: acceptance requires an attributed human, so a
                  // producer can never promote its own guess into accepted truth.
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
          : null;

        const decision = await tx.operationalPriority.create({
          data: {
            organizationId,
            sourceSystem: input.producer,
            recurrenceKey: input.recurrenceKey,
            hypothesisId,
            title: input.title,
            summary: input.summary ?? null,
            firstDetectedAt: input.detectedAt,
            lastDetectedAt: input.detectedAt,
            detectionCount: 1,
            severity: input.severity,
            priority: input.priority ?? null,
            confidence: input.confidence ?? null,
            impactCents: input.impactCents ?? null,
            impactLabel: input.impactLabel ?? null,
            sourceReference: input.sourceReference ?? null,
            producerVersion: input.producerVersion ?? null,
          },
        });

        for (const e of input.evidence ?? []) {
          await this.insertEvidence(tx, organizationId, decision.id, e, input.detectedAt);
        }

        const { decision: after, observation } = await this.appendInternal(tx, organizationId, decision, {
          observationType: 'SITUATION_DETECTED',
          occurredAt: input.detectedAt,
          actor: { type: 'SYSTEM', userId: null, source: input.producer },
          evidencePayload: input.evidenceSnapshot,
          detectionKey: input.detectionKey,
          identityId: input.identityId ?? null,
        });

        return { decision: after, observation, effect: 'CREATED' as const, eventType: 'DecisionCreated' };
      });
    } catch (e) {
      // Lost the race to another request opening the same decision. Treat it as
      // a sighting of the row that won rather than surfacing a collision the
      // producer cannot do anything about.
      if (!isP2002(e)) throw e;
      const won = await this.findByRecurrenceKey(organizationId, input.producer, input.recurrenceKey);
      if (!won) throw e;
      return this.resight(organizationId, won, input);
    }
  }

  private async resight(
    organizationId: string,
    existing: OperationalPriority,
    input: CreateDecisionInput,
  ): Promise<DecisionResult> {
    const relapsed =
      isClosed(existing.state as PriorityState)
      && Boolean(existing.resolvedAt)
      && input.detectedAt.getTime() > existing.resolvedAt!.getTime();

    const forward = input.detectedAt.getTime() >= existing.lastDetectedAt.getTime();

    try {
      return await this.prisma.$transaction(async (tx) => {
        for (const e of input.evidence ?? []) {
          await this.insertEvidence(tx, organizationId, existing.id, e, input.detectedAt);
        }
        const { decision, observation } = await this.appendInternal(tx, organizationId, existing, {
          observationType: relapsed ? 'REOPENED' : 'SITUATION_RESIGHTED',
          occurredAt: input.detectedAt,
          actor: { type: 'SYSTEM', userId: null, source: input.producer },
          detectionKey: input.detectionKey,
          identityId: input.identityId ?? null,
          extra: {
            // Detection facts move forward only, so browsing an older period can
            // never rewind when something was last seen.
            lastDetectedAt: forward ? input.detectedAt : existing.lastDetectedAt,
            firstDetectedAt:
              input.detectedAt.getTime() < existing.firstDetectedAt.getTime()
                ? input.detectedAt
                : existing.firstDetectedAt,
            detectionCount: existing.detectionCount + 1,
            // Headline facts follow the most recent sighting: an operator
            // reviewing today should see today's numbers.
            ...(forward
              ? {
                  title: input.title,
                  summary: input.summary ?? null,
                  severity: input.severity,
                  impactCents: input.impactCents ?? null,
                  impactLabel: input.impactLabel ?? null,
                  confidence: input.confidence ?? null,
                  producerVersion: input.producerVersion ?? null,
                }
              : {}),
          },
        });
        return {
          decision,
          observation,
          effect: relapsed ? ('REOPENED' as const) : ('RESIGHTED' as const),
          eventType: relapsed ? 'DecisionReopened' : 'DecisionObserved',
        };
      });
    } catch (e) {
      // Already recorded for this analysis period — the unique on
      // (priorityId, detectionKey) held. Not an error: it is the guard working.
      if (isP2002(e)) {
        return { decision: existing, observation: null, effect: 'UNCHANGED', eventType: null };
      }
      throw e;
    }
  }

  /** Revise producer-owned attributes. Records what changed and why. */
  async update(
    organizationId: string,
    decisionId: string,
    input: UpdateDecisionInput,
    actor: DecisionActor,
  ): Promise<DecisionResult> {
    validateActor(actor);
    if (input.severity !== undefined && !isDecisionSeverity(input.severity)) {
      throw new InvalidDecisionInputError(`Unknown severity "${input.severity}"`);
    }
    const decision = await this.requireDecision(organizationId, decisionId);

    // The observation type names WHICH attribute moved, because "who raised this
    // to urgent, and when" is a question an operations lead actually asks.
    const type: OperationalObservationType =
      input.priority !== undefined && input.priority !== decision.priority
        ? 'PRIORITY_CHANGED'
        : input.severity !== undefined && input.severity !== decision.severity
          ? 'SEVERITY_CHANGED'
          : 'NOTE_ADDED';

    return this.prisma.$transaction(async (tx) => {
      const { decision: after, observation } = await this.appendInternal(tx, organizationId, decision, {
        observationType: type,
        occurredAt: new Date(),
        actor,
        reason: input.reason ?? null,
        extra: {
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.summary !== undefined ? { summary: input.summary } : {}),
          ...(input.severity !== undefined ? { severity: input.severity } : {}),
          ...(input.priority !== undefined ? { priority: input.priority } : {}),
          ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
          ...(input.impactCents !== undefined ? { impactCents: input.impactCents } : {}),
          ...(input.impactLabel !== undefined ? { impactLabel: input.impactLabel } : {}),
        },
      });
      return { decision: after, observation, effect: 'UPDATED' as const, eventType: DECISION_EVENT_TYPE[type] };
    });
  }

  // =========================================================================
  // Lifecycle
  // =========================================================================

  /** Record that a human looked. Deliberately does NOT clear the queue. */
  review(organizationId: string, id: string, input: DecisionActionInput): Promise<DecisionResult> {
    return this.act(organizationId, id, 'REVIEWED', input);
  }

  /**
   * Set who is DOING the work.
   *
   * Assignment is execution and is expected to change often. It never touches
   * ownership: a manager who owns a problem does not stop owning it because a
   * specialist picked the task up.
   */
  async assign(organizationId: string, id: string, input: AssignInput): Promise<DecisionResult> {
    if (!input.assigneeUserId) throw new InvalidDecisionInputError('assign requires a user');
    const decision = await this.requireDecision(organizationId, id);
    // First assignment and handover are different facts. Collapsing them would
    // lose "how long before anyone picked this up", which is the single most
    // useful operational latency Loop can report.
    const type: OperationalObservationType = decision.assigneeUserId ? 'REASSIGNED' : 'ASSIGNED';
    return this.act(organizationId, id, type, { ...input, assignedToUserId: input.assigneeUserId });
  }

  /** Clear the assignee. Accountability is untouched. */
  unassign(organizationId: string, id: string, input: DecisionActionInput): Promise<DecisionResult> {
    return this.act(organizationId, id, 'UNASSIGNED', input);
  }

  /**
   * Set who is ACCOUNTABLE.
   *
   * Ownership answers "who owns this business problem" and changes rarely. It
   * moves neither the assignee nor the lane.
   */
  setOwner(organizationId: string, id: string, input: SetOwnerInput): Promise<DecisionResult> {
    if (!input.ownerUserId) throw new InvalidDecisionInputError('setOwner requires a user');
    return this.act(organizationId, id, 'OWNER_CHANGED', {
      ...input,
      assignedToUserId: input.ownerUserId,
    });
  }

  watch(organizationId: string, id: string, input: DecisionActionInput): Promise<DecisionResult> {
    return this.act(organizationId, id, 'WATCH_STARTED', input);
  }

  unwatch(organizationId: string, id: string, input: DecisionActionInput): Promise<DecisionResult> {
    return this.act(organizationId, id, 'WATCH_STOPPED', input);
  }

  escalate(organizationId: string, id: string, input: DecisionActionInput): Promise<DecisionResult> {
    return this.act(organizationId, id, 'ESCALATED', input);
  }

  /** Close it, having acted. */
  async resolve(organizationId: string, id: string, input: CloseInput): Promise<DecisionResult> {
    const decision = await this.requireDecision(organizationId, id);
    if (isClosed(decision.state as PriorityState)) {
      throw new InvalidTransitionError(decision.state, 'resolve');
    }
    return this.act(organizationId, id, 'RESOLVED', input);
  }

  /**
   * Close it without acting.
   *
   * `ignore` is an ACTION, not an outcome. The outcome says WHY — Loop should not
   * have raised it, it duplicates another decision, it is real and accepted, it
   * is real and nothing can be done. "Dismissed" alone tells you what the
   * operator did and nothing about what was true, and only the second is worth
   * anything a year later.
   */
  async ignore(organizationId: string, id: string, input: CloseInput): Promise<DecisionResult> {
    const decision = await this.requireDecision(organizationId, id);
    if (isClosed(decision.state as PriorityState)) {
      throw new InvalidTransitionError(decision.state, 'ignore');
    }
    return this.act(organizationId, id, 'DISMISSED', input);
  }

  /** Bring a closed decision back deliberately, as opposed to by re-detection. */
  async reopen(organizationId: string, id: string, input: DecisionActionInput): Promise<DecisionResult> {
    const decision = await this.requireDecision(organizationId, id);
    if (!isClosed(decision.state as PriorityState)) {
      throw new InvalidTransitionError(decision.state, 'reopen');
    }
    return this.act(organizationId, id, 'REOPENED', input);
  }

  /** Record what happened without closing. */
  recordOutcome(
    organizationId: string,
    id: string,
    input: RecordOutcomeInput,
  ): Promise<DecisionResult> {
    return this.act(organizationId, id, 'OUTCOME_RECORDED', input);
  }

  /** The general-purpose append, for producers with their own vocabulary needs. */
  addObservation(
    organizationId: string,
    id: string,
    input: AddObservationInput,
  ): Promise<DecisionResult> {
    return this.act(organizationId, id, input.observationType, input);
  }

  /**
   * Append evidence. Never replaces, never edits, never deletes.
   *
   * Recorded as an EVIDENCE_ADDED observation citing the new row, so the log
   * explains why the evidence set changed and the timeline shows it.
   */
  async addEvidence(
    organizationId: string,
    id: string,
    evidence: DecisionEvidenceInput,
    actor: DecisionActor,
  ): Promise<{ evidence: DecisionEvidence; result: DecisionResult }> {
    validateActor(actor);
    const decision = await this.requireDecision(organizationId, id);
    const now = new Date();

    return this.prisma.$transaction(async (tx) => {
      const row = await this.insertEvidence(tx, organizationId, decision.id, evidence, now);
      const { decision: after, observation } = await this.appendInternal(tx, organizationId, decision, {
        observationType: 'EVIDENCE_ADDED',
        occurredAt: now,
        actor,
        evidenceId: row.id,
      });
      return {
        evidence: row,
        result: {
          decision: after,
          observation,
          effect: 'UPDATED' as const,
          eventType: 'DecisionEvidenceAdded',
        },
      };
    });
  }

  // =========================================================================
  // Reads
  // =========================================================================

  async get(organizationId: string, id: string): Promise<DecisionView | null> {
    const decision = await this.prisma.operationalPriority.findFirst({
      where: { id, organizationId },
    });
    if (!decision) return null;
    const [observations, evidence] = await Promise.all([
      this.getHistory(organizationId, id),
      this.getEvidence(organizationId, id),
    ]);
    // Projected here rather than trusted from the row, so a read can never serve
    // a stale cache.
    const projection = projectLifecycle(observations.map(toLifecycle));
    return {
      decision,
      observations,
      evidence,
      history: summarizeHistory(observations.map(toLifecycle)),
      currentState: projection.state,
      ownerUserId: projection.ownerUserId,
      assigneeUserId: projection.assigneeUserId,
    };
  }

  /** The raw append-only log, oldest first. */
  getHistory(organizationId: string, id: string): Promise<OperationalObservation[]> {
    return this.prisma.operationalObservation.findMany({
      where: { organizationId, priorityId: id },
      orderBy: [{ sequence: 'asc' }],
    });
  }

  /**
   * The timeline. A PROJECTION of the log, never a stored table.
   *
   * Sorted by when things HAPPENED, which is deliberately not how state is
   * computed: a note backdated to Tuesday belongs at Tuesday on a timeline and
   * at the end of the log for deciding what is true now. Both are right.
   */
  async getTimeline(organizationId: string, id: string): Promise<DecisionTimelineEntry[]> {
    const log = await this.getHistory(organizationId, id);
    return [...log]
      .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime() || a.sequence - b.sequence)
      .map((o) => ({
        id: o.id,
        sequence: o.sequence,
        observationType: o.observationType,
        occurredAt: o.occurredAt,
        recordedAt: o.recordedAt,
        actorType: o.actorType,
        actorUserId: o.actorUserId,
        source: o.source,
        previousState: o.previousState,
        newState: o.newState,
        reason: o.reason,
        note: o.note,
        outcome: o.outcome,
        measuredEffectCents: o.measuredEffectCents,
        evidenceId: o.evidenceId,
        destination: o.destinationSystem
          ? { system: o.destinationSystem, type: o.destinationType, id: o.destinationId }
          : null,
      }));
  }

  getEvidence(organizationId: string, id: string): Promise<DecisionEvidence[]> {
    return this.prisma.decisionEvidence.findMany({
      where: { organizationId, priorityId: id },
      orderBy: [{ observedAt: 'asc' }, { createdAt: 'asc' }],
    });
  }

  /**
   * The current state, computed from the log.
   *
   * Never reads the cached column. This is the method that makes "state is a
   * projection, not truth" checkable at runtime rather than only in principle.
   */
  async getCurrentState(organizationId: string, id: string): Promise<PriorityState | null> {
    const decision = await this.prisma.operationalPriority.findFirst({
      where: { id, organizationId },
      select: { id: true },
    });
    if (!decision) return null;
    const log = await this.getHistory(organizationId, id);
    return projectLifecycle(log.map(toLifecycle)).state;
  }

  list(organizationId: string, opts: ListDecisionsOptions = {}): Promise<OperationalPriority[]> {
    return this.prisma.operationalPriority.findMany({
      where: {
        organizationId,
        ...(opts.producer ? { sourceSystem: opts.producer } : {}),
        ...(opts.state ? { state: opts.state } : {}),
        ...(opts.states ? { state: { in: opts.states } } : {}),
        ...(opts.ownerUserId ? { ownerUserId: opts.ownerUserId } : {}),
        ...(opts.assigneeUserId ? { assigneeUserId: opts.assigneeUserId } : {}),
      },
      orderBy: [{ lastDetectedAt: 'desc' }, { createdAt: 'desc' }],
      take: Math.min(500, Math.max(1, opts.take ?? 200)),
    });
  }

  async countsByState(
    organizationId: string,
    producer?: string,
  ): Promise<Record<OperationalPriorityState, number>> {
    const rows = await this.prisma.operationalPriority.findMany({
      where: { organizationId, ...(producer ? { sourceSystem: producer } : {}) },
      select: { state: true },
    });
    const counts = {
      NEEDS_REVIEW: 0, ASSIGNED: 0, WATCHING: 0, RESOLVED: 0, DISMISSED: 0,
    } as Record<OperationalPriorityState, number>;
    for (const r of rows) counts[r.state] += 1;
    return counts;
  }

  /**
   * Rebuild the projection columns from the log alone.
   *
   * The escape hatch that makes the cache honest. Nothing in a request path calls
   * it; it exists so "the columns are rebuildable" is executable rather than
   * rhetorical, and so a changed reducer can be rolled forward over existing rows.
   */
  async rebuildProjection(
    organizationId: string,
    id: string,
  ): Promise<OperationalPriority | null> {
    const decision = await this.prisma.operationalPriority.findFirst({
      where: { id, organizationId },
    });
    if (!decision) return null;
    const log = await this.getHistory(organizationId, id);
    return this.prisma.operationalPriority.update({
      where: { id: decision.id },
      data: this.projectionData(projectLifecycle(log.map(toLifecycle))),
    });
  }

  // =========================================================================
  // Internals
  // =========================================================================

  private findByRecurrenceKey(
    organizationId: string,
    producer: string,
    recurrenceKey: string,
  ): Promise<OperationalPriority | null> {
    return this.prisma.operationalPriority.findFirst({
      where: { organizationId, sourceSystem: producer, recurrenceKey },
    });
  }

  /**
   * Resolve WITHIN the organization or fail.
   *
   * A cross-organization id is not-found, never forbidden: telling a caller that
   * a row exists but belongs to someone else leaks the existence of other
   * tenants' data.
   */
  private async requireDecision(
    organizationId: string,
    id: string,
  ): Promise<OperationalPriority> {
    const found = await this.prisma.operationalPriority.findFirst({
      where: { id, organizationId },
    });
    if (!found) throw new DecisionNotFoundError(id);
    return found;
  }

  /** One shape for every operator action. */
  private async act(
    organizationId: string,
    id: string,
    observationType: OperationalObservationType,
    input: DecisionActionInput & {
      assignedToUserId?: string | null;
      outcome?: import('@prisma/client').OperationalOutcome | null;
      measuredEffectCents?: number | null;
      measuredEffectBasis?: string | null;
      evidencePayload?: Record<string, unknown>;
      destination?: { system: string; type?: string | null; id?: string | null };
    },
  ): Promise<DecisionResult> {
    validateActor(input.actor);
    const decision = await this.requireDecision(organizationId, id);

    return this.prisma.$transaction(async (tx) => {
      const { decision: after, observation } = await this.appendInternal(tx, organizationId, decision, {
        observationType,
        occurredAt: input.occurredAt ?? new Date(),
        actor: input.actor,
        note: input.note ?? null,
        reason: input.reason ?? null,
        assignedToUserId: input.assignedToUserId ?? null,
        outcome: input.outcome ?? null,
        measuredEffectCents: input.measuredEffectCents ?? null,
        measuredEffectBasis: input.measuredEffectBasis ?? null,
        evidenceId: input.evidenceId ?? null,
        evidencePayload: input.evidencePayload,
        destination: input.destination,
      });
      return {
        decision: after,
        observation,
        effect: 'UPDATED' as const,
        eventType: DECISION_EVENT_TYPE[observationType],
      };
    });
  }

  /**
   * Append + reproject + publish, inside one transaction.
   *
   * The single place any of those three things happen. Everything above is a
   * named wrapper, which is why there is no operation that can append without
   * publishing or publish without appending.
   */
  private async appendInternal(
    tx: Prisma.TransactionClient,
    organizationId: string,
    decision: OperationalPriority,
    op: {
      observationType: OperationalObservationType;
      occurredAt: Date;
      actor: DecisionActor;
      note?: string | null;
      reason?: string | null;
      assignedToUserId?: string | null;
      outcome?: import('@prisma/client').OperationalOutcome | null;
      measuredEffectCents?: number | null;
      measuredEffectBasis?: string | null;
      evidenceId?: string | null;
      evidencePayload?: Record<string, unknown>;
      detectionKey?: string | null;
      identityId?: string | null;
      destination?: { system: string; type?: string | null; id?: string | null };
      extra?: Prisma.OperationalPriorityUpdateInput;
    },
  ): Promise<{ decision: OperationalPriority; observation: OperationalObservation }> {
    const last = await tx.operationalObservation.findFirst({
      where: { priorityId: decision.id },
      orderBy: { sequence: 'desc' },
      select: { sequence: true },
    });
    const sequence = (last?.sequence ?? 0) + 1;

    // The lane before this observation, so the timeline can answer "what changed"
    // without replaying the log up to that point.
    //
    // Falls back to the opening lane rather than trusting the column to be
    // populated: on the very first observation the row has only just been
    // created, and a decision with no recorded state IS needing review — which is
    // the same opening state `projectLifecycle` assumes for an empty log. Reading
    // it from the row would make the timeline depend on whether the caller had
    // re-read the row after the database applied its defaults.
    const before: OperationalPriorityState = decision.state ?? 'NEEDS_REVIEW';

    const observation = await tx.operationalObservation.create({
      data: {
        organizationId,
        priorityId: decision.id,
        observationType: op.observationType,
        detectionKey: op.detectionKey ?? null,
        occurredAt: op.occurredAt,
        sequence,
        actorType: op.actor.type,
        actorUserId: op.actor.userId ?? null,
        source: op.actor.source,
        note: op.note ?? null,
        reason: op.reason ?? null,
        evidence: (op.evidencePayload ?? {}) as Prisma.InputJsonValue,
        evidenceId: op.evidenceId ?? null,
        assignedToUserId: op.assignedToUserId ?? null,
        outcome: op.outcome ?? null,
        measuredEffectCents: op.measuredEffectCents ?? null,
        measuredEffectBasis: op.measuredEffectBasis ?? null,
        destinationSystem: op.destination?.system ?? null,
        destinationType: op.destination?.type ?? null,
        destinationId: op.destination?.id ?? null,
        previousState: before,
        // Written explicitly rather than left unset, so "this observation moved
        // nothing" is a recorded null instead of an absent column that different
        // clients represent differently.
        newState: null,
      },
    });

    const log = await tx.operationalObservation.findMany({
      where: { priorityId: decision.id },
      orderBy: { sequence: 'asc' },
    });
    const projection = projectLifecycle(log.map(toLifecycle));

    // Stamp the resulting lane onto the observation that caused it. Written after
    // projecting rather than guessed before, so it can never disagree with the
    // reducer — the observation records what DID happen, not what was intended.
    if (projection.state !== before) {
      await tx.operationalObservation.update({
        where: { id: observation.id },
        data: { newState: projection.state },
      });
    }

    const updated = await tx.operationalPriority.update({
      where: { id: decision.id },
      data: { ...(op.extra ?? {}), ...this.projectionData(projection) },
    });

    // Exactly one domain event, in the same transaction as the fact that caused
    // it. The engine names no subscriber and attempts no delivery: the publisher
    // drains the outbox, and adding a consumer never touches this file.
    await this.outbox.enqueue(
      organizationId,
      {
        subjectType: 'DECISION',
        subjectId: decision.id,
        eventType: DECISION_EVENT_TYPE[op.observationType],
        domain: 'OPERATIONAL',
        stateKey: decisionStateKey(decision.sourceSystem, decision.recurrenceKey),
        changeType: op.observationType,
        identityId: op.identityId ?? null,
        payload: {
          decisionId: decision.id,
          producer: decision.sourceSystem,
          observationId: observation.id,
          sequence,
          previousState: before,
          newState: projection.state,
          ownerUserId: projection.ownerUserId,
          assigneeUserId: projection.assigneeUserId,
          outcome: projection.outcome,
        },
      },
      tx as unknown as Pick<PrismaClient, 'stateChangeOutbox'>,
    );

    return {
      decision: updated,
      observation: { ...observation, newState: projection.state !== before ? projection.state : null },
    };
  }

  private projectionData(
    p: ReturnType<typeof projectLifecycle>,
  ): Prisma.OperationalPriorityUpdateInput {
    return {
      state: p.state,
      ownerUserId: p.ownerUserId,
      assigneeUserId: p.assigneeUserId,
      stateChangedAt: p.stateChangedAt,
      reopenCount: p.reopenCount,
      resolvedAt: p.resolvedAt,
      outcome: p.outcome,
      measuredEffectCents: p.measuredEffectCents,
      observationCount: p.observationCount,
      lastObservationAt: p.lastObservationAt,
      projectionVersion: p.projectionVersion,
    };
  }

  private insertEvidence(
    tx: Prisma.TransactionClient,
    organizationId: string,
    priorityId: string,
    e: DecisionEvidenceInput,
    fallbackObservedAt: Date,
  ): Promise<DecisionEvidence> {
    return tx.decisionEvidence.create({
      data: {
        organizationId,
        priorityId,
        source: e.source,
        metricKey: e.metricKey,
        window: e.window ?? null,
        ruleId: e.ruleId ?? null,
        ruleVersion: e.ruleVersion ?? null,
        formulaVersion: e.formulaVersion ?? null,
        calculationVersion: e.calculationVersion ?? null,
        producerVersion: e.producerVersion ?? null,
        confidence: e.confidence ?? null,
        rawValue: e.rawValue ?? null,
        normalizedValue: e.normalizedValue ?? null,
        derivedValue: e.derivedValue ?? null,
        completeness: e.completeness ?? null,
        entityType: e.entityType ?? null,
        entityId: e.entityId ?? null,
        entityName: e.entityName ?? null,
        limitations: e.limitations ?? [],
        unknowns: e.unknowns ?? [],
        payload: (e.payload ?? {}) as Prisma.InputJsonValue,
        observedAt: e.observedAt ?? fallbackObservedAt,
      },
    });
  }
}

export function createDecisionEngine(prisma: PrismaClient): DecisionEngine {
  return new DecisionEngine(prisma);
}
