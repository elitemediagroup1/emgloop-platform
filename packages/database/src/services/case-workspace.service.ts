// The one read a Case screen makes, and the one read a home screen makes.
//
// WHY THIS EXISTS. Everything a Case surface needs already existed, in six
// services with six shapes: the Brief, the Finding, the recommendation options,
// the participants, the Work coordination, the monitoring and the outcome. A web
// client that assembled those itself would have to know which producer owns a
// `sourceReference`, that a work reference is opaque until its system is
// checked, that an unmeasured stage is UNKNOWN rather than fine, and that an
// empty Headline list is not an all-clear. Every one of those is domain logic,
// and every one of them would eventually be got wrong in a page component.
//
// SO THIS COMPOSES, AND ADDS NOTHING. There is no rule in this file. Each part
// is produced by the service that owns it, and this puts them in one shape with
// one tenant check. If a question cannot be answered by one of those services,
// the answer here is that it is not known — never a value assembled from parts.
//
// NO PRISMA MODEL REACHES THE UI. Every field below is a contract type from
// `@emgloop/shared`. A `WorkStage`, an `OperationalObservation` or a
// `CognitiveDecision` appearing in a UI contract would make the database schema
// the product's API, and the next migration would be a front-end change.
//
// UNKNOWN, WITHHELD, INCOMPLETE AND CONFLICTING ALL SURVIVE. Nothing here
// flattens a refusal into a null, a false or a zero. The states arrive as the
// values the engines produced, and `notKnown` carries the sentences.
//
// IT WRITES NOTHING, AND CANNOT.

import type { PrismaClient } from '@prisma/client';
import {
  assessAttention,
  type AttentionAssessment,
  type CaseBriefView,
  type CaseCoordinationView,
  type CaseFindingView,
  type CaseOutcomeView,
  type HeadlineView,
  type CaseParticipationView,
  type ObjectiveCoverage,
  type ReadinessOutcome,
} from '@emgloop/shared';

import { CaseBriefService } from './case-brief.service';
import { CaseFindingService } from './case-finding.service';
import {
  CaseRecommendationService,
  type CaseRecommendationsView,
} from './case-recommendation.service';
import { CaseParticipationService } from './case-participation.service';
import { CaseWorkCoordinationService } from './case-work-coordination.service';
import { CaseMonitoringService, type MonitoringView } from './case-monitoring.service';
import { HeadlineRepository } from '../repositories/headline.repository';
import { PerformanceObjectiveRepository } from '../repositories/performance-objective.repository';
import { ObjectiveMeasureBindingRepository } from '../repositories/objective-measure-binding.repository';
import { MarketplaceCallRepository } from '../repositories/marketplace-call.repository';
import { ProviderObservationRepository } from '../repositories/provider-observation.repository';
import { ProviderReconciliationRepository } from '../repositories/provider-reconciliation.repository';
import { MeasurementSourceRepository } from '../repositories/measurement-source.repository';
import { HeadlineDetectionService } from './headline-detection.service';

/**
 * Everything one investigation is, in one shape.
 *
 * EVERY PART IS NULLABLE, and null means "this Case does not have one" rather
 * than "the read failed". A Case with no Finding yet, no recommendations yet and
 * no work is a completely ordinary Case on its first morning, and the shape has
 * to say that without looking broken.
 */
export interface CaseWorkspaceView {
  caseId: string;
  /** The 5Ws, the evidence, the timeline and the authorization. */
  brief: CaseBriefView;
  /** What Loop currently claims, and whether it is established. */
  finding: CaseFindingView | null;
  /** The options, their factors and their action sequences. */
  recommendations: CaseRecommendationsView | null;
  /** Who is involved, and what each is being asked for. */
  participation: CaseParticipationView | null;
  /** What was asked for and where the work stands. Work OS owns every answer. */
  coordination: CaseCoordinationView | null;
  /** What is being watched, and how the window is going. */
  monitoring: MonitoringView | null;
  /** What happened, with lineage — and without a causal claim. */
  outcome: CaseOutcomeView | null;
  /**
   * Everything this composition could not establish, de-duplicated.
   *
   * THE FIELD THAT MUST NOT BE DROPPED IN THE UI. A Case with a dangling work
   * reference and an unmeasured monitoring window looks identical to a healthy
   * one if this is not rendered.
   */
  notKnown: readonly string[];
}

/** What a home screen needs before it may say anything reassuring. */
export interface AttentionView {
  attention: AttentionAssessment;
  /**
   * The items themselves, so the surface does not need a second read.
   *
   * TYPED AS THE CONTRACT, NOT AS `unknown`. `unknown[]` looked harmless and was
   * the leak: the repository returns a shared view type, and declaring it as
   * `unknown` would have let a raw row through under a name that told nobody.
   * A weak type is not the absence of a contract -- it is a contract that has
   * given up.
   */
  headlines: readonly HeadlineView[];
}

export interface CaseWorkspaceDeps {
  brief?: Pick<CaseBriefService, 'get'>;
  findings?: Pick<CaseFindingService, 'get'>;
  recommendations?: Pick<CaseRecommendationService, 'get'>;
  participation?: Pick<CaseParticipationService, 'get'>;
  coordination?: Pick<CaseWorkCoordinationService, 'get'>;
  monitoring?: Pick<CaseMonitoringService, 'get' | 'outcome'>;
  headlines?: Pick<HeadlineRepository, 'list'>;
  objectives?: Pick<PerformanceObjectiveRepository, 'list'>;
  readiness?: Pick<HeadlineDetectionService, 'readinessFor'>;
}

export class CaseWorkspaceService {
  private readonly brief: Pick<CaseBriefService, 'get'>;
  private readonly findings: Pick<CaseFindingService, 'get'>;
  private readonly recommendations: Pick<CaseRecommendationService, 'get'>;
  private readonly participation: Pick<CaseParticipationService, 'get'>;
  private readonly coordination: Pick<CaseWorkCoordinationService, 'get'>;
  private readonly monitoring: Pick<CaseMonitoringService, 'get' | 'outcome'>;
  private readonly headlines: Pick<HeadlineRepository, 'list'>;
  private readonly objectives: Pick<PerformanceObjectiveRepository, 'list'>;
  private readonly readiness: Pick<HeadlineDetectionService, 'readinessFor'>;

  constructor(prisma: PrismaClient, deps: CaseWorkspaceDeps = {}) {
    this.brief = deps.brief ?? new CaseBriefService(prisma);
    this.findings = deps.findings ?? new CaseFindingService(prisma);
    this.recommendations = deps.recommendations ?? new CaseRecommendationService(prisma);
    this.participation = deps.participation ?? new CaseParticipationService(prisma);
    this.coordination = deps.coordination ?? new CaseWorkCoordinationService(prisma);
    this.monitoring = deps.monitoring ?? new CaseMonitoringService(prisma);
    this.headlines = deps.headlines ?? new HeadlineRepository(prisma);
    this.objectives = deps.objectives ?? new PerformanceObjectiveRepository(prisma);
    // THE SAME READINESS ENGINE STAGE 3 USES, not a second one. `readinessFor`
    // is the read-only half of `detect` -- it shares one private `assessBinding`
    // with it -- so an objective's coverage here is decided by exactly the rule
    // that decided whether a Headline could exist at all.
    this.readiness =
      deps.readiness ??
      new HeadlineDetectionService(
        new PerformanceObjectiveRepository(prisma),
        new ObjectiveMeasureBindingRepository(prisma),
        new MarketplaceCallRepository(prisma),
        new HeadlineRepository(prisma),
        new ProviderObservationRepository(prisma),
        new ProviderReconciliationRepository(prisma),
        new MeasurementSourceRepository(prisma),
      );
  }

  /**
   * One investigation, everything about it.
   *
   * THE BRIEF IS THE GATE. If it does not resolve within the organization there
   * is no Case here, and nothing else is read — so a cross-tenant id costs one
   * query and reveals nothing.
   */
  async case(
    organizationId: string,
    caseId: string,
    now: Date = new Date(),
  ): Promise<CaseWorkspaceView | null> {
    const brief = await this.brief.get(organizationId, caseId);
    if (!brief) return null;

    const [finding, recommendations, participation, coordination, monitoring, outcome] =
      await Promise.all([
        this.findings.get(organizationId, caseId, now),
        this.recommendations.get(organizationId, caseId),
        this.participation.get(organizationId, caseId),
        this.coordination.get(organizationId, caseId, now),
        this.monitoring.get(organizationId, caseId, now),
        this.monitoring.outcome(organizationId, caseId, now),
      ]);

    const notKnown = [
      ...(coordination?.notKnown ?? []),
      ...(outcome?.notEstablished ?? []),
      // The Finding's own refusals, in the product's words rather than the
      // gate's — the gate's are carried on the Finding itself, unchanged, for
      // anybody who needs them.
      ...(finding && finding.state !== 'ESTABLISHED'
        ? ['Loop has not established this claim yet.']
        : []),
    ];

    return {
      caseId,
      brief,
      finding,
      recommendations,
      participation,
      coordination,
      monitoring,
      outcome,
      notKnown: [...new Set(notKnown)],
    };
  }

  /**
   * Whether a person may be told that nothing needs their attention.
   *
   * THE READINESS VERDICT IS RE-READ, NEVER ASSUMED. Every ACTIVE objective is
   * asked, and an objective that cannot produce a verdict at all counts as
   * unmeasurable rather than as fine — which is the difference between an
   * all-clear and an outage that looks like one.
   *
   * A HEADLINE OUTRANKS EVERYTHING, because a Headline exists only when Stage 3
   * already said its measurement was ready.
   */
  async attention(
    organizationId: string,
    now: Date = new Date(),
  ): Promise<AttentionView> {
    const [headlines, objectives] = await Promise.all([
      this.headlines.list(organizationId, { take: 200 }),
      this.objectives.list(organizationId, { status: 'ACTIVE' }),
    ]);

    const coverage: ObjectiveCoverage[] = [];
    for (const objective of objectives) {
      const verdict = await this.readiness.readinessFor(organizationId, objective.id, now);
      coverage.push({
        performanceObjectiveId: objective.id,
        objectiveTitle: objective.title,
        // NULL WHEN NOTHING COULD BE ASKED -- no binding, no source authority,
        // nothing to evaluate. Null is not READY, and the assessor treats it as
        // unmeasurable.
        readiness: (verdict?.readiness.outcome as ReadinessOutcome | undefined) ?? null,
        // The gate's own refusals, unchanged. Translated for a person only at
        // the very edge, by `WITHHOLDING_LANGUAGE`, and never here.
        withholdings: verdict?.readiness.findings.map((f) => f.reason) ?? [],
      });
    }

    return {
      attention: assessAttention({ objectives: coverage, headlineCount: headlines.length }),
      headlines,
    };
  }
}
