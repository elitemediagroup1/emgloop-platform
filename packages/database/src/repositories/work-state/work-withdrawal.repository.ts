// WITHDRAWING ONE PERSON'S DERIVED (MODEL-PRODUCED) WORK STATE FOR ONE PROVIDER.
//
// Architecture: docs/architecture/daily-loop-employee-intelligence.md §21.2 (rows dated
// 2026-09-24): "Employee removes one capability -- items sourced from it are closed with an
// outcome naming the reason, not silently dropped", and "Grace period expires (30 days after a
// voluntary disconnect) -- work rows are deleted by a scheduled sweep; the audit trail of acts
// remains".
//
// WHY THIS EXISTS. A model reads a source's content (Telegram, today) under an explicit,
// revocable authorization and writes items whose title and evidence are its paraphrases of
// that content. Before this file, withdrawing the authorization stopped further reading and
// nothing else: every paraphrase already written stayed, indefinitely, on a queue the employee
// had just said the model may no longer read for. That is content-derived intelligence
// retained past its authorization -- exactly the archive the record refuses. Two acts, two
// methods:
//
//   withdrawDerived  the authorization is withdrawn. Every open or snoozed item is CLOSED with
//                    outcome REVOKED (a system-only outcome that says nothing about accuracy)
//                    and a RESOLVED observation in the log, and EVERY matching item -- closed
//                    ones too -- is MINIMIZED: title cleared, evidence reduced to the provenance
//                    allowlist (`minimizeDerivedEvidence`), quote cleared. The row and its log
//                    stay, because the conclusion's provenance outlives the conclusion
//                    (ENGINEERING_PRINCIPLES Rule 3) and the accuracy history is the person's own.
//   deleteDerived    the connection has been gone past its grace window. The rows go, with
//                    their observations; the audit row the caller writes is what remains.
//
// WHAT IT TOUCHES. Only items with `producerKind = 'MODEL'` whose `subjectRef` carries the
// provider's derived-subject prefix (`DERIVED_WORK_SUBJECT_PREFIXES`, shared with the
// producers so the two cannot drift), scoped by the principal and nothing else. A RULE-produced
// item, another provider's item and another person's item are never matched. Neither method
// writes an audit row: the caller records the act with the counts returned.
//
// Runs INSIDE the caller's transaction (a revoke, an expiry), exactly like work-erasure: there is
// no moment where the authorization is gone and the paraphrases are not.

import type { Prisma, PrismaClient } from '@prisma/client';
import {
  WORK_ITEM_CLOSED_STATES,
  derivedWorkSubjectPrefix,
  minimizeDerivedEvidence,
  workWithdrawalReason,
  type ConnectionProvider,
  type WorkItemState,
} from '@emgloop/shared';

import { appendWorkObservation } from './work-item.repository';
import { workScope, type WorkPrincipal } from './work-principal';

/** What one withdrawal did. Counts only; never a row. */
export interface WorkWithdrawal {
  /** Items that were OPEN or SNOOZED and are now RESOLVED / REVOKED. */
  readonly closed: number;
  /** Every matched item, closed before or not, reduced to provenance. */
  readonly minimized: number;
}

/** What one expiry deleted. Counts only; never a row. */
export interface WorkDerivedDeletion {
  readonly items: number;
  readonly observations: number;
}

export class WorkWithdrawalRepository {
  constructor(private readonly db: PrismaClient | Prisma.TransactionClient) {}

  /**
   * The authorization that produced this person's derived items for `provider` was withdrawn at
   * `occurredAt`. Close what is still open (REVOKED, with a SYSTEM observation carrying the
   * reason) and minimize everything matched. A provider with no derived-subject prefix has
   * nothing to withdraw and returns zeros.
   */
  async withdrawDerived(
    principal: WorkPrincipal,
    request: { readonly provider: ConnectionProvider; readonly occurredAt: Date; readonly reason: string },
  ): Promise<WorkWithdrawal> {
    const scope = workScope(principal);
    const prefix = derivedWorkSubjectPrefix(request.provider);
    if (prefix === null) return { closed: 0, minimized: 0 };
    const items = await this.db.workItem.findMany({ where: { ...scope, producerKind: 'MODEL', subjectRef: { startsWith: prefix } } });
    const reason = workWithdrawalReason(request.reason);
    let closed = 0;
    for (const item of items) {
      const closing = !WORK_ITEM_CLOSED_STATES.includes(item.state as WorkItemState);
      await this.db.workItem.update({
        where: { id: item.id },
        data: {
          title: null,
          evidence: minimizeDerivedEvidence(item.evidence, { at: request.occurredAt, reason: request.reason }) as Prisma.InputJsonValue,
          evidenceQuote: null,
          evidenceQuoteRef: null,
          ...(closing
            ? { state: 'RESOLVED', outcome: 'REVOKED', resolvedAt: request.occurredAt, stateChangedAt: request.occurredAt, snoozedUntil: null }
            : {}),
        },
      });
      if (!closing) continue;
      await appendWorkObservation(this.db, scope, item.id, {
        observationType: 'RESOLVED',
        occurredAt: request.occurredAt,
        actorType: 'SYSTEM',
        reason,
        previousState: item.state as WorkItemState,
        newState: 'RESOLVED',
      });
      closed += 1;
    }
    return { closed, minimized: items.length };
  }

  /**
   * Delete this person's derived items for `provider`, observations first (the log of a row
   * that no longer exists is not evidence of anything). The §21.2 "deleted at 30 days" row; the
   * caller has established that the connection is not live and its grace window has passed.
   */
  async deleteDerived(principal: WorkPrincipal, request: { readonly provider: ConnectionProvider }): Promise<WorkDerivedDeletion> {
    const scope = workScope(principal);
    const prefix = derivedWorkSubjectPrefix(request.provider);
    if (prefix === null) return { items: 0, observations: 0 };
    const items = await this.db.workItem.findMany({
      where: { ...scope, producerKind: 'MODEL', subjectRef: { startsWith: prefix } },
      select: { id: true },
    });
    if (items.length === 0) return { items: 0, observations: 0 };
    const ids = items.map((i) => i.id);
    const observations = (await this.db.workItemObservation.deleteMany({ where: { ...scope, itemId: { in: ids } } })).count;
    const deleted = (await this.db.workItem.deleteMany({ where: { ...scope, id: { in: ids } } })).count;
    return { items: deleted, observations };
  }
}
