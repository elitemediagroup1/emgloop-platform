// One person's queue, ordered by two things that never become one number.
//
// WHAT THIS IS. The read that answers "what should I look at first, and why".
// It assembles, for each open investigation, how much it matters to the business
// and why it is this person's — and orders them by a declared walk over three
// named facts rather than by a computed score.
//
// IT WRITES NOTHING, AND CANNOT. Every seam it holds is a read: the engine's
// `list` and `get`, the participant repository's `list`, the Headline and
// objective reads. There is no create, no append, no update and no transaction
// anywhere in this file.
//
// NOTHING IS CACHED, AND NOTHING IS STORED. A person's queue changes the moment
// somebody asks them for a decision; a stored ordering would be wrong before it
// was read. The assembly is cheap — an organization has tens of open
// investigations, not thousands — and correctness is worth more than the query.
//
// THE ORDER IS EXPLAINED, ALWAYS. Every adjacent pair carries the sentence saying
// why one sits above the other, produced by the same walk that produced the
// order, so a rationalisation that disagreed with the sort is impossible.
//
// WHAT IT DELIBERATELY DOES NOT KNOW. Revenue exposure, client value, workload
// and reporting lines are not in this schema. They are reported as not
// considered rather than approximated, because a ranking that silently ignores
// client value looks identical to one that weighed it and found it small.

import type { OperationalPriority, PrismaClient } from '@prisma/client';
import {
  assessPersonalPriority,
  explainOrder,
  isDecisionSeverity,
  orderForUser,
  type BusinessSignificance,
  type CaseContribution,
  type HeadlineView,
  type PersonalPriorityView,
  type PriorityComparisonReason,
} from '@emgloop/shared';
import { INVESTIGATION_PRODUCER } from '@emgloop/shared';

import { CaseParticipantRepository } from '../repositories/case-participant.repository';
import { HeadlineRepository } from '../repositories/headline.repository';
import { PerformanceObjectiveRepository } from '../repositories/performance-objective.repository';
import { DecisionEngine } from './decision/decision-engine';

/** Why one item sits directly above the next, in the person's own queue. */
export interface QueueOrdering {
  aboveCaseId: string;
  belowCaseId: string;
  reason: PriorityComparisonReason;
  statement: string;
}

export interface PersonalQueueView {
  userId: string;
  /** The investigations, in order. */
  items: readonly PersonalPriorityView[];
  /**
   * Why each item sits above the next.
   *
   * ADJACENT PAIRS ONLY. "Why is this first" is answered against the one below
   * it; every pair would be n² sentences nobody reads, and the order is
   * transitive by construction.
   */
  orderings: readonly QueueOrdering[];
  /** What this ordering could not take into account. Carried, not hidden. */
  notConsidered: readonly string[];
}

/** The Decision Center reads this service needs. Both are reads. */
export type PriorityCaseAccess = Pick<DecisionEngine, 'list'>;

export interface PriorityHeadlineReader {
  get(organizationId: string, id: string): Promise<HeadlineView | null>;
}

export interface PersonalPriorityDeps {
  cases?: PriorityCaseAccess;
  participants?: CaseParticipantRepository;
  headlines?: PriorityHeadlineReader;
  objectives?: Pick<PerformanceObjectiveRepository, 'get'>;
}

/** Lanes that are still open. A resolved investigation is not in anybody's queue. */
const OPEN_STATES = ['NEEDS_REVIEW', 'ASSIGNED', 'WATCHING'] as const;

export class PersonalPriorityService {
  private readonly cases: PriorityCaseAccess;
  private readonly participants: CaseParticipantRepository;
  private readonly headlines: PriorityHeadlineReader;
  private readonly objectives: Pick<PerformanceObjectiveRepository, 'get'>;

  constructor(prisma: PrismaClient, deps: PersonalPriorityDeps = {}) {
    this.cases = deps.cases ?? new DecisionEngine(prisma);
    this.participants = deps.participants ?? new CaseParticipantRepository(prisma);
    this.headlines = deps.headlines ?? new HeadlineRepository(prisma);
    this.objectives = deps.objectives ?? new PerformanceObjectiveRepository(prisma);
  }

  /**
   * What this person should look at, and why.
   *
   * TENANT-SCOPED THROUGHOUT, and the person is never trusted from a caller's
   * argument alone: every read is scoped to the organization first, so a user id
   * from another tenant simply matches nothing rather than reaching across.
   *
   * EVERY OPEN INVESTIGATION APPEARS, including the ones nothing connects this
   * person to — those land in ORGANIZATION_WIDE. A queue that hid them would let
   * the most important thing in the business be invisible to everybody who was
   * not personally named on it.
   */
  async queueFor(
    organizationId: string,
    userId: string,
    opts: { take?: number } = {},
  ): Promise<PersonalQueueView> {
    const empty: PersonalQueueView = {
      userId,
      items: [],
      orderings: [],
      notConsidered: assessPersonalPriority({
        caseId: '',
        userId,
        significance: emptySignificance(),
        participation: [],
        ownerUserId: null,
        assigneeUserId: null,
        objective: null,
      }).notConsidered,
    };
    if (!userId?.trim()) return empty;

    const cases = await this.cases.list(organizationId, {
      states: [...OPEN_STATES] as never,
      take: Math.min(200, Math.max(1, opts.take ?? 100)),
    });
    if (cases.length === 0) return empty;

    const mine = await this.participants.listForUser(organizationId, userId.trim(), { take: 200 });
    const byCase = new Map<string, typeof mine>();
    for (const p of mine) {
      byCase.set(p.priorityId, [...(byCase.get(p.priorityId) ?? []), p]);
    }

    const items: PersonalPriorityView[] = [];
    for (const row of cases) {
      items.push(
        assessPersonalPriority({
          caseId: row.id,
          userId: userId.trim(),
          significance: await this.significanceOf(organizationId, row),
          participation: (byCase.get(row.id) ?? []).map((p) => ({
            id: p.id,
            contribution: p.contribution as CaseContribution,
            request: p.request,
            active: p.releasedAt === null,
          })),
          ownerUserId: row.ownerUserId,
          assigneeUserId: row.assigneeUserId,
          objective: await this.objectiveOf(organizationId, row),
        }),
      );
    }

    const ordered = orderForUser(items);
    const orderings: QueueOrdering[] = [];
    for (let i = 0; i + 1 < ordered.length; i += 1) {
      const above = ordered[i];
      const below = ordered[i + 1];
      if (!above || !below) continue;
      const { reason, statement } = explainOrder(above, below);
      orderings.push({ aboveCaseId: above.caseId, belowCaseId: below.caseId, reason, statement });
    }

    return {
      userId: userId.trim(),
      items: ordered,
      orderings,
      notConsidered: ordered[0]?.notConsidered ?? empty.notConsidered,
    };
  }

  /**
   * The organization's stake in one investigation, from what is already recorded.
   *
   * THE HEADLINE IS RE-READ THROUGH ITS OWN ORGANIZATION-SCOPED READ. It supplies
   * `againstObjective` and the measured move; a Case opened by some other producer
   * has neither, and reports them as null rather than as false and zero.
   */
  private async significanceOf(
    organizationId: string,
    row: OperationalPriority,
  ): Promise<BusinessSignificance> {
    const base: BusinessSignificance = {
      // A severity this build cannot interpret is treated as the least alarming
      // reading rather than the most: a vocabulary widened in a later build must
      // not make an older one shout.
      severity: isDecisionSeverity(row.severity) ? row.severity : 'INFORMATIONAL',
      againstObjective: null,
      // WHATEVER WAS ACTUALLY MEASURED, AND NULL OTHERWISE. Never a forecast.
      measuredImpactCents: row.measuredEffectCents ?? row.impactCents ?? null,
      percentageChange: null,
    };
    const headline = await this.headlineOf(organizationId, row);
    if (!headline) return base;
    return {
      ...base,
      againstObjective: headline.measurement.againstObjective,
      percentageChange: headline.measurement.percentageChange,
    };
  }

  private async objectiveOf(
    organizationId: string,
    row: OperationalPriority,
  ): Promise<{ id: string; scopeUserId: string | null } | null> {
    const headline = await this.headlineOf(organizationId, row);
    if (!headline) return null;
    const objective = await this.objectives.get(organizationId, headline.performanceObjectiveId);
    return objective ? { id: objective.id, scopeUserId: objective.scopeUserId } : null;
  }

  /**
   * The Headline behind an investigation, when there is one.
   *
   * THE PRODUCER IS CHECKED BEFORE THE REFERENCE IS TRUSTED, exactly as the Case
   * Brief does it: `sourceReference` is an opaque producer handle the platform
   * never parses, and a CallGrid thread's reference is a call id rather than a
   * Headline id.
   */
  private async headlineOf(
    organizationId: string,
    row: OperationalPriority,
  ): Promise<HeadlineView | null> {
    if (row.sourceSystem !== INVESTIGATION_PRODUCER || !row.sourceReference) return null;
    return this.headlines.get(organizationId, row.sourceReference);
  }
}

function emptySignificance(): BusinessSignificance {
  return {
    severity: 'INFORMATIONAL',
    againstObjective: null,
    measuredImpactCents: null,
    percentageChange: null,
  };
}
