// The queue: what needs this person, and what they said about it.
//
// Architecture: daily-loop-employee-intelligence.md §12 and §17.1.
//
// THE LOG IS THE TRUTH; THE COLUMNS ARE ITS PROJECTION. Every state change appends an
// observation and writes the projection in the SAME transaction, so the two cannot disagree
// -- and a projection that ever did can be rebuilt from the log (ENGINEERING_PRINCIPLES
// Rule 2). Nothing here edits a recorded observation, and there is no delete in this file:
// deletion belongs to the two repositories that own a retention decision -- work-erasure
// (a membership ended) and work-withdrawal (an authorization withdrawn, or a disconnect past
// its grace window) -- and both append through `appendWorkObservation` below, so a close they
// write reads like any other in the log.
//
// THE SAME SITUATION TOMORROW IS THE SAME ROW. `recurrenceKey` is the producer's rule plus
// its subject, never a timestamp: a thread that is still unanswered tomorrow moves
// `lastDetectedAt` and increments `detectionCount` rather than appearing twice.
//
// PRODUCER-AGNOSTIC. A rule writes items today; a Stage 3 task writes the same row with
// `producerKind = 'MODEL'`. Intelligence arriving later is not a second queue.
//
// SYSTEM-ONLY OUTCOMES. `record` is the person's own act, so it refuses an outcome only the
// system may write (REVOKED): a human cannot make an item read as "the authorization was
// withdrawn", whatever the caller passes as actorType.
//
// THE WRITE RE-CHECKS CONSENT (2026-09-24). A MODEL item on a derived subject (§21.2: a
// `subjectRef` carrying a provider's `DERIVED_WORK_SUBJECT_PREFIXES` entry) is a paraphrase of
// content read under a revocable authorization. `detect` reads that authorization INSIDE its own
// transaction, before any write, and returns null -- no create, no update, no observation -- when
// it is no longer in force. It lives here and not in the worker because the race is between the
// sweep that snapshotted the principal and the revoke (or offboarding) that committed while it was
// triaging: a worker-side pre-check would re-open exactly that window, and a revoke's withdrawal
// (close + minimize) must not be followed by a fresh paraphrase or a refreshed title from a
// detection already in hand. Every other detection -- a RULE producer, a Gmail or Calendar
// subject -- makes NO authorization query: those rules run in production web cycles where the
// query is a needless cost and, before the source-connection migration lands, a missing table.

import type { Prisma, PrismaClient } from '@prisma/client';
import {
  WORK_SYSTEM_ONLY_OUTCOMES,
  derivedWorkProviderOf,
  type WorkActorType,
  type WorkClass,
  type WorkFeedbackKind,
  type WorkItemOutcome,
  type WorkItemState,
  type WorkObservationType,
  type WorkProducerKind,
  type WorkSubjectKind,
} from '@emgloop/shared';

import { contentAuthorizedInTx } from '../source-content-consent';
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

/** The numeric per-chat message id encoded at the end of a keyed providerEventId (`<key>:<id>`). Never content. */
function messageIdOf(providerEventId: string | null | undefined): number | null {
  if (!providerEventId) return null;
  const idx = providerEventId.lastIndexOf(':');
  if (idx < 0) return null;
  const n = Number(providerEventId.slice(idx + 1));
  return Number.isFinite(n) ? n : null;
}

/** The keyed anchor providerEventId an obligation's evidence carries, or null. Keyed id only, never content. */
function anchorProviderEventIdOf(evidence: unknown): string | null {
  if (!evidence || typeof evidence !== 'object') return null;
  const value = (evidence as Record<string, unknown>).providerEventId;
  return typeof value === 'string' ? value : null;
}

export class WorkItemRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * A producer saw something. New: one item and its opening observation. Seen before: the
   * detection window widens and the count rises -- no second row, and no state change, because
   * a re-sighting is not a reopening.
   *
   * REFUSED, returning null and writing nothing, when the detection is a MODEL item on a derived
   * subject and this person's content authorization for that provider is not in force at the
   * moment of the write (header: THE WRITE RE-CHECKS CONSENT). A refusal records nothing -- no
   * observation, no audit -- because nothing happened.
   */
  async detect(principal: WorkPrincipal, detection: WorkItemDetection): Promise<WorkItemRecord | null> {
    const scope = workScope(principal);
    // Only a MODEL item on a derived subject was produced under a revocable content authorization.
    // For anything else this is null and the transaction below makes no authorization query at all.
    const consentProvider = detection.producerKind === 'MODEL' ? derivedWorkProviderOf(detection.subjectRef) : null;
    return this.prisma.$transaction(async (tx: any) => {
      if (consentProvider !== null && !(await contentAuthorizedInTx(tx, scope.organizationId, scope.userId, consentProvider))) {
        return null; // the authorization ended after the sweep that produced this began
      }
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
   * RECONCILE-ON-ANSWER (conversation triage). A fresh read of ONE conversation concluded that a set of
   * obligations are STILL unresolved (`keptAnchorProviderEventIds`). Close every OTHER open MODEL
   * obligation for that conversation (`subjectRef`) whose anchor was INSIDE the evaluated window: it was
   * raised before, is no longer among the unresolved, and a later message answered it. Employee-private
   * and append-only, exactly like `detect` -- each close writes a RESOLVED observation in the same
   * transaction as the projection, actorType SYSTEM (there is no AI actor).
   *
   * THE GUARD. An obligation whose anchor fell OUTSIDE the evaluated window -- its message id is older
   * than `evaluatedFloorProviderEventId`, so the truncated window never reached it -- is NOT evidence of
   * resolution: this read never saw where it stands. It is LEFT OPEN. Only anchors at or after the
   * window's lower boundary are eligible to close. Returns how many obligations closed.
   */
  async resolveObligationsNotIn(
    principal: WorkPrincipal,
    subjectRef: string,
    keptAnchorProviderEventIds: readonly string[],
    evaluatedFloorProviderEventId: string,
    occurredAt: Date,
  ): Promise<number> {
    const scope = workScope(principal);
    const kept = new Set(keptAnchorProviderEventIds);
    const floorMessageId = messageIdOf(evaluatedFloorProviderEventId);
    // A missing or unparseable boundary means the window's extent is unknown; close nothing (fail safe).
    if (floorMessageId === null) return 0;
    return this.prisma.$transaction(async (tx: any) => {
      const open = await tx.workItem.findMany({ where: { ...scope, subjectRef, producerKind: 'MODEL', state: 'OPEN' } });
      let closed = 0;
      for (const item of open) {
        const anchor = anchorProviderEventIdOf(item.evidence);
        if (!anchor || kept.has(anchor)) continue; // no keyed anchor, or still unresolved this read
        const anchorMessageId = messageIdOf(anchor);
        // THE GUARD: an anchor older than the window's lower boundary was truncated out -- leave it open.
        if (anchorMessageId === null || anchorMessageId < floorMessageId) continue;
        await tx.workItem.update({
          where: { id: item.id },
          data: { state: 'RESOLVED', stateChangedAt: occurredAt, resolvedAt: occurredAt, outcome: 'SUPERSEDED', snoozedUntil: null },
        });
        await this.append(tx, scope, item.id, {
          observationType: 'RESOLVED',
          occurredAt,
          actorType: 'SYSTEM',
          reason: 'reconciled: resolved later in the conversation',
          previousState: item.state,
          newState: 'RESOLVED',
        });
        closed += 1;
      }
      return closed;
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
    // Fail closed for every actor: only WorkWithdrawalRepository writes a system-only outcome.
    if (act.outcome && WORK_SYSTEM_ONLY_OUTCOMES.includes(act.outcome)) {
      throw new Error(`${act.outcome} is a system-only outcome: it records a withdrawn authorization, not a person's act`);
    }

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

  private append(
    tx: Prisma.TransactionClient,
    scope: { organizationId: string; userId: string },
    itemId: string,
    observation: WorkObservationToAppend,
  ): Promise<void> {
    return appendWorkObservation(tx, scope, itemId, observation);
  }
}

/** One observation to append to an item's log. */
export interface WorkObservationToAppend {
  readonly observationType: WorkObservationType;
  readonly occurredAt: Date;
  readonly actorType: WorkActorType;
  readonly actorUserId?: string | null;
  readonly reason?: string | null;
  readonly previousState?: WorkItemState | null;
  readonly newState?: WorkItemState | null;
}

/**
 * Append one observation to an item's log, with the next sequence number for that item. THE ONE
 * PLACE the sequence is computed: every repository that writes a state change -- this one, and
 * the sibling that withdraws derived items -- appends through here, inside the caller's
 * transaction, so no writer can invent a second numbering.
 */
export async function appendWorkObservation(
  db: PrismaClient | Prisma.TransactionClient,
  scope: { organizationId: string; userId: string },
  itemId: string,
  observation: WorkObservationToAppend,
): Promise<void> {
  const prior = await db.workItemObservation.findMany({ where: { ...scope, itemId }, orderBy: { sequence: 'desc' }, take: 1 });
  const sequence = (prior[0]?.sequence ?? 0) + 1;
  await db.workItemObservation.create({
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
