// Watching whether it held, and closing only when that is actually established.
//
// WHAT THIS OWNS. The monitoring plan a person committed to before the answer
// was known, the verdict reached over the declared window, the outcome assembled
// from what is already recorded, and the deterministic rule that says whether
// Loop may close an investigation itself.
//
// THE PLAN LIVES ON THE CASE'S OWN LOG. A monitoring plan is somebody's
// declaration, made at a moment and correctable afterwards, whose whole value
// depends on the previous version staying legible -- a success criterion
// rewritten after the numbers are in is a rationalisation, not a test. That is
// an append-only log, and the Case already has one. A `case_monitoring` table
// would have needed its own ordering, supersession, tenant scope and answer to
// "what did this say in March", all of which the observation log already gets
// right.
//
// NO SECOND LIFECYCLE. `WATCHING` already means "somebody is waiting to see
// whether this holds", and `REOPENED` already clears `resolvedAt` and increments
// `reopenCount`. Monitoring is WATCHING; re-engagement is REOPENED. Nothing here
// invents a state.
//
// LOOP MAY CLOSE, AND A PERSON IS NEVER BOUND BY THAT. Auto-resolution requires
// every condition, records which ones it checked, and is the only autonomous
// close in the file. Keeping an eligible Case open, closing an ineligible one
// and reopening a closed one all remain available and all remain recorded.
//
// NO MODEL DECIDES ANYTHING HERE. Every verdict is an arithmetic comparison over
// numbers a person declared in advance, and there is nowhere for a model to
// attach without changing this file.

import type { PrismaClient } from '@prisma/client';
import {
  AUTO_RESOLVED_REASON,
  CASE_MONITORING_RULE_VERSION,
  CAUSAL_CAVEAT,
  MONITORING_CONCLUDED_REASON,
  MONITORING_EVENTS,
  MONITORING_REVISED_REASON,
  MONITORING_STARTED_REASON,
  assessMonitoring,
  assessResolutionEligibility,
  describeOutcome,
  isRecommendationEvent,
  type CaseOutcomeLineage,
  type CaseOutcomeView,
  type MonitoringAssessment,
  type MonitoringObservation,
  type MonitoringPlan,
  type OperationalOutcome,
  type ResolutionEligibility,
} from '@emgloop/shared';

import { DecisionEngine } from './decision/decision-engine';
import { CaseWorkCoordinationService } from './case-work-coordination.service';
import { CaseFindingService } from './case-finding.service';

/** How a monitoring act ended. Every one of them is a fact, not an intention. */
export const MONITORING_OUTCOMES = [
  'STARTED',
  'REVISED',
  'CONCLUDED',
  'CASE_NOT_FOUND',
  'NO_PLAN',
] as const;
export type MonitoringActOutcome = (typeof MONITORING_OUTCOMES)[number];

export interface MonitoringView {
  caseId: string;
  /** The plan currently in force. Null when nothing is being watched. */
  plan: MonitoringPlan | null;
  /** Every plan ever recorded, newest first. Corrections never erase. */
  history: readonly MonitoringPlan[];
  /** The verdict as of `now`, when there is a plan. Derived, never stored. */
  assessment: MonitoringAssessment | null;
}

export interface CaseMonitoringDeps {
  cases?: Pick<DecisionEngine, 'get' | 'addObservation' | 'resolve'>;
  coordination?: Pick<CaseWorkCoordinationService, 'get'>;
  findings?: Pick<CaseFindingService, 'get'>;
  /**
   * What the producer measured over a window.
   *
   * A SEAM, NOT A GUESS. Commercial Intelligence does not know how to measure
   * an arbitrary producer's metric, and inventing a reading here would be the
   * exact failure this stage exists to prevent. A caller that has no measurement
   * supplies none, and the verdict is INCONCLUSIVE.
   */
  measure?: (
    organizationId: string,
    caseId: string,
    plan: MonitoringPlan,
  ) => Promise<MonitoringObservation | null>;
}

export class CaseMonitoringService {
  private readonly cases: Pick<DecisionEngine, 'get' | 'addObservation' | 'resolve'>;
  private readonly coordination: Pick<CaseWorkCoordinationService, 'get'>;
  private readonly findings: Pick<CaseFindingService, 'get'>;
  private readonly measure: NonNullable<CaseMonitoringDeps['measure']>;

  constructor(prisma: PrismaClient, deps: CaseMonitoringDeps = {}) {
    this.cases = deps.cases ?? new DecisionEngine(prisma);
    this.coordination = deps.coordination ?? new CaseWorkCoordinationService(prisma);
    this.findings = deps.findings ?? new CaseFindingService(prisma);
    // NO MEASUREMENT BY DEFAULT, AND THAT IS THE SAFE DEFAULT. A build with no
    // producer wired in returns INCONCLUSIVE rather than a fabricated reading.
    this.measure = deps.measure ?? (async () => null);
  }

  /**
   * Begin watching whether something held.
   *
   * THE PLAN IS WRITTEN BEFORE THE ANSWER IS KNOWN, and that is the only reason
   * a verdict later means anything. Nothing here evaluates it; this records what
   * would count.
   */
  async start(
    organizationId: string,
    caseId: string,
    plan: MonitoringPlan,
    actor: { type: 'HUMAN' | 'SYSTEM'; userId?: string | null; source: string },
  ): Promise<{ outcome: MonitoringActOutcome; caseId: string }> {
    const view = await this.cases.get(organizationId, caseId);
    if (!view) return { outcome: 'CASE_NOT_FOUND', caseId };
    const existing = this.plansFrom(view.observations);

    await this.cases.addObservation(organizationId, caseId, {
      observationType: existing.length > 0 ? MONITORING_EVENTS.REVISED : MONITORING_EVENTS.STARTED,
      actor,
      reason: existing.length > 0 ? MONITORING_REVISED_REASON : MONITORING_STARTED_REASON,
      note: plan.condition,
      evidencePayload: { monitoringPlan: plan as unknown as Record<string, unknown> },
    });
    return { outcome: existing.length > 0 ? 'REVISED' : 'STARTED', caseId };
  }

  /**
   * The plan in force, the plans that preceded it, and where it stands now.
   *
   * THE VERDICT IS DERIVED ON EVERY READ. A stored verdict would be wrong the
   * moment more measurement arrived, and the whole point is that the window is
   * judged against what is actually known at the time of asking.
   */
  async get(
    organizationId: string,
    caseId: string,
    now: Date = new Date(),
  ): Promise<MonitoringView | null> {
    const view = await this.cases.get(organizationId, caseId);
    if (!view) return null;
    const history = this.plansFrom(view.observations);
    const plan = history[0] ?? null;
    if (!plan) return { caseId, plan: null, history: [], assessment: null };

    const observation = await this.measure(organizationId, caseId, plan);
    return {
      caseId,
      plan,
      history,
      assessment: assessMonitoring({ plan, observation, now }),
    };
  }

  /**
   * Record the verdict the window reached.
   *
   * DOES NOT CLOSE THE CASE. A verdict is what was observed; deciding the
   * investigation is finished is a separate act, taken by a person or by the
   * eligibility rule below. Collapsing the two would mean a monitor that fired
   * could close a Case nobody agreed was answered.
   */
  async conclude(
    organizationId: string,
    caseId: string,
    actor: { type: 'HUMAN' | 'SYSTEM'; userId?: string | null; source: string },
    now: Date = new Date(),
  ): Promise<{ outcome: MonitoringActOutcome; assessment: MonitoringAssessment | null }> {
    const monitoring = await this.get(organizationId, caseId, now);
    if (!monitoring) return { outcome: 'CASE_NOT_FOUND', assessment: null };
    if (!monitoring.assessment) return { outcome: 'NO_PLAN', assessment: null };

    await this.cases.addObservation(organizationId, caseId, {
      observationType: MONITORING_EVENTS.CONCLUDED,
      actor,
      reason: MONITORING_CONCLUDED_REASON,
      note: monitoring.assessment.verdict,
      evidencePayload: {
        verdict: monitoring.assessment.verdict,
        insufficiency: monitoring.assessment.insufficiency,
        ruleVersion: monitoring.assessment.ruleVersion,
        evidenceIds: [...monitoring.assessment.evidenceIds],
      },
    });
    return { outcome: 'CONCLUDED', assessment: monitoring.assessment };
  }

  /**
   * What happened, assembled from what is already recorded.
   *
   * NO NEW TABLE, AND NO NEW OUTCOME VOCABULARY. `OperationalOutcome`,
   * `OUTCOME_RECORDED`, `measuredEffectCents` and `measuredEffectBasis` have all
   * existed since the Decision Center shipped, and the Case already carries the
   * Finding, the recommendation decisions, the work references and the evidence.
   * What was missing was the lineage assembled in one place -- and the refusal.
   *
   * `causalClaim` IS ALWAYS NULL. It is a field rather than an absence so the
   * refusal is visible instead of looking like nobody thought about it.
   */
  async outcome(
    organizationId: string,
    caseId: string,
    now: Date = new Date(),
  ): Promise<CaseOutcomeView | null> {
    const view = await this.cases.get(organizationId, caseId);
    if (!view) return null;

    const monitoring = await this.get(organizationId, caseId, now);
    const coordination = await this.coordination.get(organizationId, caseId, now);
    const finding = await this.findings.get(organizationId, caseId, now);

    const outcomeRow = [...view.observations]
      .reverse()
      .find((o) => o.outcome !== null) ?? null;

    const recommendationIds = view.observations
      .filter((o) => o.decisionId && isRecommendationEvent(o, 'RECORDED'))
      .map((o) => o.decisionId as string);
    const selected = view.observations
      .filter((o) => o.decisionId && isRecommendationEvent(o, 'SELECTED'))
      .map((o) => o.decisionId as string);

    const lineage: CaseOutcomeLineage = {
      findingId: finding?.findingId ?? null,
      recommendationDecisionIds: recommendationIds,
      // THE LAST SELECTION WINS, and the earlier ones stay on the log. A person
      // who changed their mind selected twice, and both acts are history.
      selectedRecommendationDecisionId: selected[selected.length - 1] ?? null,
      workReferences: (coordination?.work ?? []).map((w) => ({ system: w.system, id: w.id })),
      monitoringWindow: monitoring?.plan
        ? { start: monitoring.plan.observationStart, end: monitoring.plan.observationEnd }
        : null,
      monitoringVerdict: monitoring?.assessment?.verdict ?? null,
      evidenceIds: monitoring?.assessment?.evidenceIds ?? [],
      observationId: outcomeRow?.id ?? null,
    };

    const notEstablished: string[] = [...(coordination?.notKnown ?? [])];
    if (monitoring?.assessment?.verdict === 'INCONCLUSIVE') {
      notEstablished.push('Monitoring could not establish what happened over its window.');
    }
    if (finding?.state !== 'ESTABLISHED') {
      notEstablished.push('No established finding stands behind this outcome.');
    }

    return {
      ruleVersion: CASE_MONITORING_RULE_VERSION,
      caseId,
      outcome: (outcomeRow?.outcome as OperationalOutcome | null) ?? null,
      measuredEffectCents: outcomeRow?.measuredEffectCents ?? null,
      measuredEffectBasis: outcomeRow?.measuredEffectBasis ?? null,
      statement: describeOutcome({
        outcome: (outcomeRow?.outcome as OperationalOutcome | null) ?? null,
        monitoring: monitoring?.assessment ?? null,
        window: lineage.monitoringWindow,
      }),
      causalClaim: null,
      causalCaveat: CAUSAL_CAVEAT,
      lineage,
      notEstablished: [...new Set(notEstablished)],
    };
  }

  /** Whether Loop may close this itself, and what it would record. A READ. */
  async resolutionEligibility(
    organizationId: string,
    caseId: string,
    now: Date = new Date(),
  ): Promise<ResolutionEligibility | null> {
    const coordination = await this.coordination.get(organizationId, caseId, now);
    if (!coordination) return null;
    const finding = await this.findings.get(organizationId, caseId, now);
    const monitoring = await this.get(organizationId, caseId, now);

    return assessResolutionEligibility({
      findingEstablished: finding?.state === 'ESTABLISHED',
      workAllComplete:
        coordination.work.length > 0 &&
        coordination.work.every((w) => w.unknown === null && w.workStatus === 'completed'),
      noWorkRequested: coordination.work.length === 0,
      openBlockers: coordination.work.reduce((n, w) => n + w.blockers.length, 0),
      monitoring: monitoring?.assessment ?? null,
      coordinationComplete: coordination.notKnown.length === 0,
    });
  }

  /**
   * Close it, but only if every condition holds.
   *
   * ALL OF THEM, NOT MOST. A Case is a question somebody authorized; closing it
   * says the question is answered. Closing on four conditions out of five is
   * Loop deciding the fifth did not matter, which is not a decision it is
   * entitled to make. An ineligible Case is left open and the unmet conditions
   * are returned, so a person can see exactly what is left.
   *
   * WHAT IT QUALIFIED ON IS RECORDED. The resolving row carries the conditions
   * checked and the rule version, so "why did Loop close this" is answerable a
   * year later without re-deriving anything.
   */
  async autoResolve(
    organizationId: string,
    caseId: string,
    now: Date = new Date(),
  ): Promise<{ resolved: boolean; eligibility: ResolutionEligibility | null }> {
    const eligibility = await this.resolutionEligibility(organizationId, caseId, now);
    if (!eligibility || !eligibility.eligible) return { resolved: false, eligibility };

    // THE JUSTIFICATION IS APPENDED FIRST, DELIBERATELY. If the close then fails,
    // the log holds a reasoning row and no close -- readable, and obviously
    // incomplete. The other order leaves an autonomous close with nothing saying
    // why, which is the one outcome that must not be possible.
    //
    // It is a separate row because `CloseInput` carries no free-form payload:
    // closing a Case is a narrow act, and widening its input to fit this would
    // have widened it for every producer.
    await this.cases.addObservation(organizationId, caseId, {
      observationType: 'NOTE_ADDED',
      actor: { type: 'SYSTEM', source: 'ci-monitoring' },
      reason: AUTO_RESOLVED_REASON,
      occurredAt: now,
      evidencePayload: {
        ruleVersion: eligibility.ruleVersion,
        conditionsMet: [...eligibility.met],
        outcome: eligibility.outcome,
      },
    });

    await this.cases.resolve(organizationId, caseId, {
      actor: { type: 'SYSTEM', source: 'ci-monitoring' },
      outcome: eligibility.outcome ?? 'NO_ACTION_NEEDED',
      reason: AUTO_RESOLVED_REASON,
      occurredAt: now,
    });
    return { resolved: true, eligibility };
  }

  /**
   * The monitoring plans on a Case's log, newest first.
   *
   * READ FROM THE TYPED EVENT, NOT FROM PROSE. `MONITORING_STARTED` and
   * `MONITORING_REVISED` are governed enum members, so this never compares a
   * sentence -- which is the debt the vocabulary migration paid off.
   */
  private plansFrom(
    observations: readonly { observationType: string; evidence: unknown }[],
  ): MonitoringPlan[] {
    const plans: MonitoringPlan[] = [];
    for (const o of observations) {
      if (
        o.observationType !== MONITORING_EVENTS.STARTED &&
        o.observationType !== MONITORING_EVENTS.REVISED
      ) {
        continue;
      }
      const payload = o.evidence as { monitoringPlan?: MonitoringPlan } | null;
      if (payload?.monitoringPlan) plans.push(payload.monitoringPlan);
    }
    // Newest first. Corrections never erase: every earlier plan stays readable,
    // which is what makes "what did we say we would accept" answerable after the
    // numbers are in.
    return plans.reverse();
  }
}
