// What EMG did, assembled from what was already recorded.
//
// THE ONLY THING THIS SERVICE ADDS IS ASSEMBLY. Every fact it returns was
// written by some earlier act -- Loop recorded options, a person selected one, a
// person revised one, a monitor reached a verdict, an outcome was recorded. None
// of it is derived from judgement and none of it is filled in when absent.
//
// IT WRITES NOTHING, AND CANNOT. There is no create, no update, no append and no
// transaction anywhere in this file, and a test asserts it. In particular
// `nominate` does not write a KnowledgeAssertion: promotion into durable
// organizational knowledge requires explicit human approval, and the honest
// expression of that is a boundary a person crosses rather than a status a
// machine sets.
//
// THE KNOWLEDGE AUTHORITY ALREADY EXISTS AND IS NOT DUPLICATED.
// `KnowledgeAssertion` carries `assertionClass: ORGANIZATIONAL`, a status that
// starts PROPOSED and only a person moves to ACTIVE, explicit supersession, and
// a header recording that a class is "NEVER silently promoted". A second store
// for what EMG has learned would be a second Brain.
//
// WHAT IT REFUSES TO KNOW. Whether the selected sequence is the executed one.
// Loop knows what was chosen and that work was created; it does not know what
// somebody did. `executed` is null in the common case, and that is the honest
// answer rather than the useful-looking one.

import type { PrismaClient } from '@prisma/client';
import {
  assessPattern,
  comparableKey,
  groupComparable,
  isRecommendationEvent,
  nominateForKnowledge,
  type KnowledgeNomination,
  type LearningObservation,
  type LearningOption,
  type MonitoringVerdict,
  type OperationalOutcome,
  type PatternView,
} from '@emgloop/shared';

import { DecisionEngine } from './decision/decision-engine';
import { CaseMonitoringService } from './case-monitoring.service';
import { CaseFindingService } from './case-finding.service';

export interface CaseLearningDeps {
  cases?: Pick<DecisionEngine, 'get' | 'list'>;
  monitoring?: Pick<CaseMonitoringService, 'get'>;
  findings?: Pick<CaseFindingService, 'get'>;
  decisions?: { findMany(args: unknown): Promise<unknown[]> };
}

/** Lanes a Case has to have reached before it says anything about what worked. */
const CLOSED_STATES = ['RESOLVED', 'DISMISSED'] as const;

export class CaseLearningService {
  private readonly cases: Pick<DecisionEngine, 'get' | 'list'>;
  private readonly monitoring: Pick<CaseMonitoringService, 'get'>;
  private readonly findings: Pick<CaseFindingService, 'get'>;

  constructor(
    private readonly prisma: PrismaClient,
    deps: CaseLearningDeps = {},
  ) {
    this.cases = deps.cases ?? new DecisionEngine(prisma);
    this.monitoring = deps.monitoring ?? new CaseMonitoringService(prisma);
    this.findings = deps.findings ?? new CaseFindingService(prisma);
  }

  /**
   * One Case, reduced to the facts a later comparison would need.
   *
   * READS THE TYPED EVENTS, never prose. Which option Loop recorded, which a
   * person selected and which a person revised are governed observation types
   * since the vocabulary migration, so this compares enum members.
   */
  async observationFor(
    organizationId: string,
    caseId: string,
    now: Date = new Date(),
  ): Promise<LearningObservation | null> {
    const view = await this.cases.get(organizationId, caseId);
    if (!view) return null;

    const optionsById = await this.optionsFor(organizationId, view.observations);
    const machineOptions = [...optionsById.values()]
      .filter((o) => o.author === 'MACHINE')
      .map((o) => o.option)
      .sort((a, b) => a.rank - b.rank);

    const lastOf = (kind: 'SELECTED' | 'REVISED'): LearningOption | null => {
      const rows = view.observations.filter((o) => o.decisionId && isRecommendationEvent(o, kind));
      const last = rows[rows.length - 1];
      return last?.decisionId ? (optionsById.get(last.decisionId)?.option ?? null) : null;
    };

    const monitoring = await this.monitoring.get(organizationId, caseId, now);
    const finding = await this.findings.get(organizationId, caseId, now);

    return {
      caseId,
      // THE PRODUCER'S OWN COMPARABILITY KEY. `recurrenceKey` is what already
      // makes the same situation tomorrow the same Case, so it is the only
      // honest answer to "is this the same kind of thing" -- and it is a value
      // the producer chose, not a similarity this file invented.
      subject: view.decision.recurrenceKey,
      machineOptions,
      selected: lastOf('SELECTED'),
      revised: lastOf('REVISED'),
      // NULL, AND HONESTLY SO. Loop knows what was selected and that work was
      // created. It does not know what anybody did. Assuming the selected
      // sequence was the executed one would invent the single fact every
      // comparison turns on.
      executed: null,
      outcome: (view.decision.outcome as OperationalOutcome | null) ?? null,
      monitoringVerdict: (monitoring?.assessment?.verdict as MonitoringVerdict | null) ?? null,
      evidenceAtDecision: {
        findingEstablished: finding?.state === 'ESTABLISHED',
        readinessOutcome: finding?.establishment.readinessWithholdings.length
          ? 'WITHHELD'
          : (finding?.establishment.eligible ? 'READY' : null),
        supportingCount: finding?.supporting.length ?? 0,
      },
      closedAt: view.decision.resolvedAt?.toISOString() ?? null,
    };
  }

  /**
   * What comparable Cases in this organization amount to.
   *
   * CLOSED CASES ONLY. An investigation still running has not finished saying
   * what happened, and counting it would let a pattern move on the strength of
   * work in progress.
   */
  async patterns(
    organizationId: string,
    opts: { take?: number; now?: Date } = {},
  ): Promise<PatternView[]> {
    const now = opts.now ?? new Date();
    const rows = await this.cases.list(organizationId, {
      states: [...CLOSED_STATES] as never,
      take: Math.min(500, Math.max(1, opts.take ?? 200)),
    });

    const observations: LearningObservation[] = [];
    for (const row of rows) {
      const observation = await this.observationFor(organizationId, row.id, now);
      if (observation) observations.push(observation);
    }

    return [...groupComparable(observations)].map(([subject, group]) =>
      assessPattern(subject, group),
    );
  }

  /**
   * Propose a pattern for promotion into durable organizational knowledge.
   *
   * WRITES NOTHING. Not a KnowledgeAssertion, not an observation, not an audit
   * row. What comes back is a proposal with its blockers attached, and
   * `HUMAN_APPROVAL_REQUIRED` is always among them -- it is not a condition that
   * clears, it is the shape of the boundary.
   */
  nominate(pattern: PatternView, claim: string): KnowledgeNomination {
    return nominateForKnowledge(pattern, claim);
  }

  /**
   * The recommendation options a Case recorded, by their decision id.
   *
   * READ DIRECTLY BECAUSE THE OPTION IS ON THE DECISION. A recommendation is a
   * `CognitiveDecision` whose `policyEvaluation` carries the option Loop
   * recorded, and the Case's log points at it by `decisionId`. Re-deriving the
   * options from anywhere else would be a second answer to what Loop proposed.
   */
  private async optionsFor(
    organizationId: string,
    observations: readonly { decisionId: string | null }[],
  ): Promise<Map<string, { author: string; option: LearningOption }>> {
    const ids = [...new Set(observations.map((o) => o.decisionId).filter((id): id is string => !!id))];
    if (ids.length === 0) return new Map();

    const rows = await this.prisma.cognitiveDecision.findMany({
      where: { organizationId, id: { in: ids } },
    });
    const out = new Map<string, { author: string; option: LearningOption }>();
    for (const row of rows) {
      const policy = row.policyEvaluation as { option?: Record<string, unknown> } | null;
      const option = policy?.option;
      if (!option) continue;
      const snapshot = row.inputStateSnapshot as { author?: string } | null;
      out.set(row.id, {
        author: snapshot?.author ?? 'MACHINE',
        option: {
          key: String(option.key ?? ''),
          label: String(option.label ?? ''),
          posture: String(option.posture ?? ''),
          rank: Number(option.rank ?? 0),
          actions: Array.isArray(option.actions)
            ? (option.actions as { verb?: unknown }[]).map((a) => String(a?.verb ?? ''))
            : [],
        },
      });
    }
    return out;
  }
}

/** Re-exported so a caller can group without importing two packages. */
export { comparableKey };
