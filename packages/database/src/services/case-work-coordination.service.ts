// The Case and its execution state, in one read that owns half of it.
//
// WHAT THIS ANSWERS. What did the Case ask, of whom; was work created; which
// authoritative work item represents it; what state is it in; is it inside
// policy; is it reminder- or escalation-eligible; what is blocking it; and when
// is that expected to clear.
//
// HALF OF THAT IS COMMERCIAL INTELLIGENCE'S AND HALF IS WORK OS'S, and the split
// is the point. The asks are read from the Case's own participants and its own
// log. Every execution answer is read from Work OS at the moment of the request
// and written into no Commercial Intelligence table. A copy would be a second
// answer that goes stale the first time somebody advances a stage, and the
// person reading the Case would be looking at a status the person doing the work
// had already changed.
//
// THIS SERVICE HAS NO WRITE. There is no create, no update, no append, no
// transaction anywhere in this file, and a test asserts it. That is the enforced
// form of "CI reads Work state" -- not a comment, and not a convention the next
// caller has to remember.
//
// THE PRODUCER IS CHECKED BEFORE THE REFERENCE IS TRUSTED. `destinationSystem`
// is deliberately generic; the Decision Engine "records that work was created
// somewhere, never which product". A reference naming a system this build cannot
// read is reported as exactly that, not as missing work.
//
// UNKNOWN SURVIVES ALL THE WAY OUT. Unreadable system, missing work item and
// unmeasured work are three different answers and none of them is "fine". They
// reach the caller as distinct values, and they land in `notKnown` so a surface
// cannot render a Case with a dangling reference as a Case with nothing
// outstanding.

import type { PrismaClient } from '@prisma/client';
import {
  CASE_COORDINATION_RULE_VERSION,
  COORDINATION_UNKNOWN_LABELS,
  WORK_OS_SYSTEM,
  type CaseCoordinationView,
  type CoordinatedAsk,
  type CoordinatedWork,
  type CoordinationBlocker,
  type CoordinationExecution,
  type CoordinationUnknown,
  type DependencyKind,
} from '@emgloop/shared';

import { CaseParticipationService } from './case-participation.service';
import { WorkExecutionService } from './work-execution.service';

/** The two reads this composes. Both are reads; neither may be a write. */
export interface CaseCoordinationDeps {
  participation?: Pick<CaseParticipationService, 'get'>;
  work?: Pick<WorkExecutionService, 'getForWorkInstance'>;
}

export class CaseWorkCoordinationService {
  private readonly participation: Pick<CaseParticipationService, 'get'>;
  private readonly work: Pick<WorkExecutionService, 'getForWorkInstance'>;

  constructor(prisma: PrismaClient, deps: CaseCoordinationDeps = {}) {
    this.participation = deps.participation ?? new CaseParticipationService(prisma);
    this.work = deps.work ?? new WorkExecutionService(prisma);
  }

  /**
   * Everything a Case surface needs about what it asked for and where that
   * stands.
   *
   * `now` IS AN ARGUMENT, all the way down into the pure assessor, so the same
   * question about the same moment always gets the same answer.
   *
   * TENANT-SCOPED THROUGHOUT. The Case is resolved within the organization, and
   * each work reference is resolved within the SAME organization -- so a
   * reference that somehow named another tenant's work reads as not-found rather
   * than reaching across. The reference is data the platform stores; it is not a
   * capability.
   */
  async get(
    organizationId: string,
    caseId: string,
    now: Date = new Date(),
  ): Promise<CaseCoordinationView | null> {
    const participation = await this.participation.get(organizationId, caseId);
    if (!participation) return null;

    const asks: CoordinatedAsk[] = participation.participants.map((p) => ({
      userId: p.userId,
      contribution: p.contribution,
      request: p.request,
      active: p.active,
      askedAt: p.addedAt,
    }));

    const work: CoordinatedWork[] = [];
    const notKnown: string[] = [];

    for (const reference of participation.work) {
      const resolved = await this.resolve(organizationId, reference, now);
      work.push(resolved);
      if (resolved.unknown !== null) {
        notKnown.push(COORDINATION_UNKNOWN_LABELS[resolved.unknown]);
      }
    }

    return {
      ruleVersion: CASE_COORDINATION_RULE_VERSION,
      caseId,
      asks,
      work,
      // De-duplicated: three dangling references produce one sentence, because a
      // reader needs to know the gap exists, not to read it three times.
      notKnown: [...new Set(notKnown)],
    };
  }

  /**
   * One reference, followed as far as it can honestly be followed.
   *
   * EACH FAILURE HAS ITS OWN NAME. "Loop cannot read that system" and "that work
   * item is gone" are different facts with different responses, and collapsing
   * them into a null would let a surface render both as a blank.
   */
  private async resolve(
    organizationId: string,
    reference: { system: string; type: string | null; id: string | null; recordedAt: string; observationId: string },
    now: Date,
  ): Promise<CoordinatedWork> {
    const base = {
      system: reference.system,
      type: reference.type,
      id: reference.id,
      recordedAt: reference.recordedAt,
      observationId: reference.observationId,
      workStatus: null,
      execution: null,
      blockers: [] as CoordinationBlocker[],
    };

    // A system this build has no reader for. A LIMIT OF THIS BUILD, not a
    // statement about the work -- and saying so is better than implying the work
    // is missing.
    if (reference.system !== WORK_OS_SYSTEM || !reference.id) {
      return { ...base, unknown: 'SYSTEM_NOT_READABLE' as CoordinationUnknown };
    }

    const found = await this.work.getForWorkInstance(organizationId, reference.id, now);
    // Not-found covers deleted and never-there and another tenant's, and Loop
    // must not guess which. All three are the same answer to the only question
    // that matters: this reference no longer leads anywhere.
    if (!found) return { ...base, unknown: 'WORK_NOT_FOUND' as CoordinationUnknown };

    if (!found.view) {
      return { ...base, workStatus: found.workStatus, unknown: 'NOT_MEASURED' as CoordinationUnknown };
    }

    const a = found.view.assessment;
    const execution: CoordinationExecution = {
      workStageId: found.view.workStageId,
      stageName: found.view.stageName,
      ownerUserId: found.view.ownerUserId,
      state: a.state,
      actionable: a.actionable,
      sla: a.sla,
      dueAt: a.dueAt?.toISOString() ?? null,
      overdue: a.overdue,
      waiting: a.waiting
        ? {
            reason: a.waiting.reason,
            subject: a.waiting.subject,
            expectedResolutionAt: a.waiting.expectedResolutionAt?.toISOString() ?? null,
          }
        : null,
      reminderEligible: a.reminderEligible,
      escalationEligible: a.escalationEligible,
      // Null, and null is the honest answer. This platform has no reporting
      // relationship; see ESCALATION_DESTINATION_ABSENT.
      escalationDestinationUserId: a.escalationDestinationUserId,
      durations: a.durations,
      extensions: a.extensions,
      explanation: a.explanation,
    };

    const blockers: CoordinationBlocker[] = found.view.openDependencies.map((d) => ({
      id: d.id,
      kind: d.kind as DependencyKind,
      description: d.description,
      expectedResolutionAt: d.expectedResolutionAt?.toISOString() ?? null,
      dependsOnWorkInstanceId: d.dependsOnWorkInstanceId,
    }));

    return {
      ...base,
      workStatus: found.workStatus,
      execution,
      blockers,
      // WORK WITH NO HISTORY IS UNKNOWN, NOT COMPLIANT. Every work item created
      // before the execution foundation is in exactly this position, and
      // reporting them as on track would be a clean bill of health nobody
      // earned.
      unknown: a.sla === 'UNKNOWN' ? ('NOT_MEASURED' as CoordinationUnknown) : null,
    };
  }
}
