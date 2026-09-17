// The queue: what needs this person, and what they said about it.
//
// Architecture: daily-loop-employee-intelligence.md §12 and §17.1.
//
// THE LOG IS THE TRUTH; THE COLUMNS ARE ITS PROJECTION. Every state change appends an
// observation and writes the projection in the SAME transaction, so the two cannot disagree
// -- and a projection that ever did can be rebuilt from the log (ENGINEERING_PRINCIPLES
// Rule 2). Nothing here edits a recorded observation, and there is no delete.
//
// THE SAME SITUATION TOMORROW IS THE SAME ROW. `recurrenceKey` is the producer's rule plus
// its subject, never a timestamp: a thread that is still unanswered tomorrow moves
// `lastDetectedAt` and increments `detectionCount` rather than appearing twice.
//
// PRODUCER-AGNOSTIC. A rule writes items today; a Stage 3 task writes the same row with
// `producerKind = 'MODEL'`. Intelligence arriving later is not a second queue.

import type { PrismaClient } from '@prisma/client';
import type {
  WorkActorType,
  WorkClass,
  WorkFeedbackKind,
  WorkItemOutcome,
  WorkItemState,
  WorkObservationType,
  WorkProducerKind,
  WorkSubjectKind,
} from '@emgloop/shared';

import { workScope, type WorkPrincipal } from './work-principal';

export interface WorkItemDetection {
  readonly recurrenceKey: string;
  readonly class: WorkClass;
  readonly subjectKind: WorkSubjectKind;
  readonly subjectRef: string;
  readonly title?: string | null;
  readonly producerKind: WorkProducerKind;
  readonly producerId: string;
  readonly producerVersion: string;
  /** References to the facts that raised it. Never content. */
  readonly evidence?: Record<string, unknown>;
  readonly detectedAt: Date;
}

export interface WorkItemRecord {
  readonly id: string;
  readonly recurrenceKey: string;
  readonly class: WorkClass;
  readonly subjectKind: WorkSubjectKind;
  readonly subjectRef: string;
  readonly title: string | null;
  readonly producerKind: WorkProducerKind;
  readonly producerId: string;
  readonly producerVersion: string;
  readonly evidence: unknown;
  readonly firstDetectedAt: Date;
  readonly lastDetectedAt: Date;
  readonly detectionCount: number;
  readonly state: WorkItemState;
  readonly stateChangedAt: Date | null;
  readonly snoozedUntil: Date | null;
  readonly resolvedAt: Date | null;
  readonly outcome: WorkItemOutcome | null;
}

const itemOf = (row: any): WorkItemRecord => ({
  id: row.id,
  recurrenceKey: row.recurrenceKey,
  class: row.class,
  subjectKind: row.subjectKind,
  subjectRef: row.subjectRef,
  title: row.title,
  producerKind: row.producerKind,
  producerId: row.producerId,
  producerVersion: row.producerVersion,
  evidence: row.evidence,
  firstDetectedAt: row.firstDetectedAt,
  lastDetectedAt: row.lastDetectedAt,
  detectionCount: row.detectionCount,
  state: row.state,
  stateChangedAt: row.stateChangedAt,
  snoozedUntil: row.snoozedUntil,
  resolvedAt: row.resolvedAt,
  outcome: row.outcome,
});

/** The closed states, and what each one requires. Mirrors the migration's CHECK. */
const CLOSED: readonly WorkItemState[] = ['RESOLVED', 'DISMISSED'];

export class WorkItemRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * A producer saw something. New: one item and its opening observation. Seen before: the
   * detection window widens and the count rises -- no second row, and no state change, because
   * a re-sighting is not a reopening.
   */
  async detect(principal: WorkPrincipal, detection: WorkItemDetection): Promise<WorkItemRecord> {
    const scope = workScope(principal);
    return this.prisma.$transaction(async (tx: any) => {
      const existing = await tx.workItem.findFirst({ where: { ...scope, recurrenceKey: detection.recurrenceKey } });
      if (existing) {
        const updated = await tx.workItem.update({
          where: { id: existing.id },
          data: {
            lastDetectedAt: detection.detectedAt > existing.lastDetectedAt ? detection.detectedAt : existing.lastDetectedAt,
            detectionCount: existing.detectionCount + 1,
            class: detection.class,
            title: detection.title ?? existing.title,
            evidence: (detection.evidence ?? existing.evidence) as any,
            producerVersion: detection.producerVersion,
          },
        });
        await this.append(tx, scope, existing.id, {
          observationType: 'REDETECTED',
          occurredAt: detection.detectedAt,
          actorType: 'SYSTEM',
        });
        return itemOf(updated);
      }
      const created = await tx.workItem.create({
        data: {
          ...scope,
          recurrenceKey: detection.recurrenceKey,
          class: detection.class,
          subjectKind: detection.subjectKind,
          subjectRef: detection.subjectRef,
          title: detection.title ?? null,
          producerKind: detection.producerKind,
          producerId: detection.producerId,
          producerVersion: detection.producerVersion,
          evidence: (detection.evidence ?? {}) as any,
          firstDetectedAt: detection.detectedAt,
          lastDetectedAt: detection.detectedAt,
          state: 'OPEN',
          stateChangedAt: detection.detectedAt,
        },
      });
      await this.append(tx, scope, created.id, {
        observationType: 'DETECTED',
        occurredAt: detection.detectedAt,
        actorType: 'SYSTEM',
        newState: 'OPEN',
      });
      return itemOf(created);
    });
  }

  /**
   * The person acted on an item: handled it, said it is not theirs, snoozed it, reopened it.
   * The observation and the projection are written together, and `actorUserId` is the person
   * themselves -- nobody acts on somebody else's queue.
   */
  async record(
    principal: WorkPrincipal,
    itemId: string,
    act: {
      readonly state: WorkItemState;
      readonly observationType: WorkObservationType;
      readonly occurredAt: Date;
      readonly outcome?: WorkItemOutcome | null;
      readonly snoozedUntil?: Date | null;
      readonly reason?: string | null;
      readonly actorType?: WorkActorType;
    },
  ): Promise<WorkItemRecord | null> {
    const scope = workScope(principal);
    const closing = CLOSED.includes(act.state);
    if (closing && !act.outcome) throw new Error('a closed work item requires an outcome');
    if (!closing && act.outcome) throw new Error('an open work item has no outcome');
    if (act.state === 'SNOOZED' && !act.snoozedUntil) throw new Error('a snoozed work item requires a time to wake');

    return this.prisma.$transaction(async (tx: any) => {
      const existing = await tx.workItem.findFirst({ where: { ...scope, id: itemId } });
      if (!existing) return null;
      const updated = await tx.workItem.update({
        where: { id: existing.id },
        data: {
          state: act.state,
          stateChangedAt: act.occurredAt,
          snoozedUntil: act.state === 'SNOOZED' ? act.snoozedUntil ?? null : null,
          resolvedAt: closing ? act.occurredAt : null,
          outcome: closing ? act.outcome ?? null : null,
        },
      });
      await this.append(tx, scope, existing.id, {
        observationType: act.observationType,
        occurredAt: act.occurredAt,
        actorType: act.actorType ?? 'HUMAN',
        actorUserId: (act.actorType ?? 'HUMAN') === 'HUMAN' ? principal.userId : null,
        reason: act.reason ?? null,
        previousState: existing.state,
        newState: act.state,
      });
      return itemOf(updated);
    });
  }

  async items(principal: WorkPrincipal, options: { readonly state?: WorkItemState; readonly limit?: number } = {}): Promise<WorkItemRecord[]> {
    const rows = await this.prisma.workItem.findMany({
      where: { ...workScope(principal), ...(options.state ? { state: options.state } : {}) },
      orderBy: { lastDetectedAt: 'desc' },
      take: Math.min(Math.max(options.limit ?? 50, 1), 200),
    });
    return rows.map(itemOf);
  }

  async item(principal: WorkPrincipal, itemId: string): Promise<WorkItemRecord | null> {
    const row = await this.prisma.workItem.findFirst({ where: { ...workScope(principal), id: itemId } });
    return row ? itemOf(row) : null;
  }

  /** The item's whole history, oldest first. What "why is Loop telling me this" reads. */
  async observations(principal: WorkPrincipal, itemId: string) {
    return this.prisma.workItemObservation.findMany({
      where: { ...workScope(principal), itemId },
      orderBy: { sequence: 'asc' },
    });
  }

  // -- Corrections ----------------------------------------------------------------------

  /**
   * A correction, appended. It is this person's judgment about their own surface and never
   * becomes a rule for anybody else -- Loop's rule, and Google's Limited Use policy.
   */
  async recordFeedback(
    principal: WorkPrincipal,
    feedback: { readonly kind: WorkFeedbackKind; readonly subjectKind: WorkSubjectKind; readonly subjectRef: string; readonly reason?: string | null },
  ): Promise<string> {
    const scope = workScope(principal);
    const row = await this.prisma.workFeedback.create({
      data: {
        ...scope,
        kind: feedback.kind,
        subjectKind: feedback.subjectKind,
        subjectRef: feedback.subjectRef,
        reason: feedback.reason ?? null,
        createdByUserId: principal.userId,
      },
    });
    return row.id;
  }

  async feedback(principal: WorkPrincipal, subject?: { readonly subjectKind: WorkSubjectKind; readonly subjectRef: string }) {
    return this.prisma.workFeedback.findMany({
      where: { ...workScope(principal), ...(subject ? { subjectKind: subject.subjectKind, subjectRef: subject.subjectRef } : {}) },
      orderBy: { createdAt: 'desc' },
    });
  }

  // -- internals ------------------------------------------------------------------------

  private async append(
    tx: any,
    scope: { organizationId: string; userId: string },
    itemId: string,
    observation: {
      readonly observationType: WorkObservationType;
      readonly occurredAt: Date;
      readonly actorType: WorkActorType;
      readonly actorUserId?: string | null;
      readonly reason?: string | null;
      readonly previousState?: WorkItemState | null;
      readonly newState?: WorkItemState | null;
    },
  ): Promise<void> {
    const prior = await tx.workItemObservation.findMany({ where: { ...scope, itemId }, orderBy: { sequence: 'desc' }, take: 1 });
    const sequence = (prior[0]?.sequence ?? 0) + 1;
    await tx.workItemObservation.create({
      data: {
        ...scope,
        itemId,
        sequence,
        observationType: observation.observationType,
        occurredAt: observation.occurredAt,
        actorType: observation.actorType,
        actorUserId: observation.actorUserId ?? null,
        reason: observation.reason ?? null,
        previousState: observation.previousState ?? null,
        newState: observation.newState ?? null,
      },
    });
  }
}
