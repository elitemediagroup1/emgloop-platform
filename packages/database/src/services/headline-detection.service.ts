// HeadlineDetectionService -- Commercial Intelligence Stage 3 v1.
//
// The one place that turns a confirmed measure binding into a measured
// development. It reads three domains and writes one:
//
//   READ   performance_objectives       (Stage 1 -- what we are trying to do)
//   READ   objective_measure_bindings   (Stage 3 -- what that means, measurably)
//   READ   marketplace_calls            (CallGrid -- aggregates only)
//   WRITE  headlines                    (material developments only)
//
// IT DOES NOTHING DOWNSTREAM. Detecting a development creates no decision, no
// OperationalPriority, no DecisionEvidence, no work item, no notification, no
// outbound message, and it publishes no event. A Headline is awareness. Judgement
// is a human act performed later in the Decision Center, and promotion into one
// is Stage 3 v1.1 -- this service will not grow a side effect.
//
// IT NEVER READS A COMMERCIAL SIGNAL. Not as a population, not as a denominator,
// not as corroboration, not as importance. TERM_MATCH is a deliberately dumb
// lexical mechanism whose own contract says commercial relevance is not lexical
// overlap; using its output as a measurement population would turn a documented
// limitation into a percentage. Signals sit beside this flow and may be cited by
// a surface as supporting detail. They are never an input here.
//
// THE MEASUREMENT AND THE MATERIALITY RULE ARE PURE AND LIVE ELSEWHERE.
// `measureChange` is a pure function in @emgloop/shared: no clock, no I/O, no
// randomness, and every threshold inherited from CALLGRID_SIGNIFICANCE_RULES
// rather than invented. This service supplies aggregates and persists what comes
// back. That split is what makes a stored Headline reproducible.
//
// SILENCE IS THE DEFAULT. Every guard in the rule fails towards emitting nothing:
// no baseline, thin sample, partial coverage or a small move all produce no
// Headline and a stated reason. Twenty ordinary calls produce nothing at all.
//
// COMPLETE PERIODS ONLY. The windows come from `business-time.ts`, which cannot
// return an in-progress day. Comparing a partial period against a whole one is
// the defect that made "Today" report an ~85% collapse every morning, and no
// caller can reintroduce it through this service because no caller chooses the
// windows.

import {
  COMMERCIAL_HEADLINE_PRODUCER_VERSION,
  COMPARISON_SPAN_DAYS,
  MEASURE_METRIC_DEFINITIONS,
  composeStatement,
  describePopulation,
  easternTrailingCompleteWindows,
  headlineDetectionKey,
  headlineRecurrenceKey,
  measureChange,
  membersOf,
  type MaterialityWithholding,
  type MeasurementResult,
  type ObjectiveMeasureBindingView,
} from '@emgloop/shared';

import type { PerformanceObjectiveRepository } from '../repositories/performance-objective.repository';
import type { ObjectiveMeasureBindingRepository } from '../repositories/objective-measure-binding.repository';
import type { MarketplaceCallRepository } from '../repositories/marketplace-call.repository';
import type { HeadlineRepository, RecordOutcome } from '../repositories/headline.repository';

/** What one objective's evaluation concluded. Silence is reported, not hidden. */
export interface ObjectiveDetectionOutcome {
  performanceObjectiveId: string;
  objectiveTitle: string;
  /** Null when the objective has no confirmed binding: NOT MEASURABLE YET. */
  measureBindingId: string | null;
  /** Null when there was no binding to measure with. */
  measurement: MeasurementResult | null;
  /** Set when a material development was recorded. */
  recorded: RecordOutcome | null;
  headlineId: string | null;
  /** Why nothing was recorded, when nothing was. */
  withheld: MaterialityWithholding | 'NOT_MEASURABLE' | null;
}

/** What one detection run examined and what it concluded. */
export interface DetectionRunSummary {
  /** ACTIVE objectives in scope. Archived intent is history, not intent. */
  objectivesConsidered: number;
  /** How many of those had a confirmed binding to measure against. */
  objectivesMeasurable: number;
  established: number;
  resighted: number;
  alreadyRecorded: number;
  /** Measurable objectives whose move did not clear the rule. Silence, reported. */
  withheld: number;
  currentWindowStart: Date;
  currentWindowEnd: Date;
  priorWindowStart: Date;
  priorWindowEnd: Date;
  outcomes: ObjectiveDetectionOutcome[];
}

export class HeadlineDetectionService {
  constructor(
    private readonly objectives: PerformanceObjectiveRepository,
    private readonly bindings: ObjectiveMeasureBindingRepository,
    private readonly calls: MarketplaceCallRepository,
    private readonly headlines: HeadlineRepository,
  ) {}

  /**
   * Detect material developments across one organization's bound objectives.
   *
   * TENANT-SCOPED THROUGHOUT. `organizationId` comes from the caller's signed
   * session and is passed to every repository call. There is no path here that
   * reads or writes another tenant's row: both sides of every comparison load
   * org-scoped, and a population member from another tenant simply matches
   * nothing.
   *
   * USER SCOPE DOES NOT LEAVE THE TENANT. A USER-scoped objective is measured
   * exactly like an ORGANIZATION-scoped one, and its Headlines belong to the
   * organization. Nothing here reads `scopeUserId` to decide what to measure or
   * who may see the result -- that field says whose objective it IS. `MANAGER` is
   * not consulted anywhere in this service, because it is an authorization level
   * and not an organizational relationship.
   *
   * @param now injected so the caller owns the clock and a test can pin it. The
   *            windows are derived from it through `business-time.ts` and can
   *            never include the in-progress day.
   */
  async detect(organizationId: string, now: Date): Promise<DetectionRunSummary> {
    const windows = easternTrailingCompleteWindows(now, COMPARISON_SPAN_DAYS);
    const detectionKey = headlineDetectionKey(windows.current.start);

    // ACTIVE only. An archived objective records what the organization used to be
    // pursuing, and measuring against it would manufacture present relevance to
    // past intent.
    const objectives = await this.objectives.list(organizationId, { status: 'ACTIVE' });

    const outcomes: ObjectiveDetectionOutcome[] = [];
    let measurable = 0;
    let established = 0;
    let resighted = 0;
    let alreadyRecorded = 0;
    let withheldCount = 0;

    for (const objective of objectives) {
      const binding = await this.bindings.activeFor(organizationId, objective.id);

      // NOT MEASURABLE YET. A first-class state, not an error: an objective may
      // legitimately exceed what Loop can measure, and no default binding is
      // manufactured, no proxy is inferred and no metric is invented.
      if (!binding) {
        outcomes.push({
          performanceObjectiveId: objective.id,
          objectiveTitle: objective.title,
          measureBindingId: null,
          measurement: null,
          recorded: null,
          headlineId: null,
          withheld: 'NOT_MEASURABLE',
        });
        continue;
      }
      measurable += 1;

      const population = populationOf(binding);
      const [current, prior] = await Promise.all([
        this.calls.aggregatePopulationWindow(organizationId, population, windows.current),
        this.calls.aggregatePopulationWindow(organizationId, population, windows.prior),
      ]);

      // A binding with no members cannot produce a population. The repository
      // rejects that at confirmation, so this is only reachable through a row
      // written by an older build -- and the honest answer is still silence.
      if (!current || !prior) {
        outcomes.push({
          performanceObjectiveId: objective.id,
          objectiveTitle: objective.title,
          measureBindingId: binding.id,
          measurement: null,
          recorded: null,
          headlineId: null,
          withheld: 'VALUE_UNKNOWN',
        });
        withheldCount += 1;
        continue;
      }

      const measurement = measureChange({
        metric: binding.metric,
        direction: binding.direction,
        current,
        prior,
        currentWindow: windows.current,
        priorWindow: windows.prior,
      });

      if (!measurement.material || measurement.movement === null) {
        withheldCount += 1;
        outcomes.push({
          performanceObjectiveId: objective.id,
          objectiveTitle: objective.title,
          measureBindingId: binding.id,
          measurement,
          recorded: null,
          headlineId: null,
          withheld: measurement.withheld ?? 'BELOW_THRESHOLD',
        });
        continue;
      }

      const statement = composeStatement(measurement, {
        metricLabel: MEASURE_METRIC_DEFINITIONS[binding.metric].label,
        population: describePopulation(binding),
      });

      const result = await this.headlines.record(organizationId, {
        performanceObjectiveId: objective.id,
        measureBindingId: binding.id,
        // Timestamp-free by construction, so the same development next period
        // lands on the same row instead of accumulating one per week.
        recurrenceKey: headlineRecurrenceKey({
          measureBindingId: binding.id,
          metric: measurement.metric,
          ruleId: measurement.ruleId,
          movement: measurement.movement,
        }),
        detectionKey,
        ruleId: measurement.ruleId,
        ruleVersion: measurement.ruleVersion,
        producerVersion: COMMERCIAL_HEADLINE_PRODUCER_VERSION,
        metric: measurement.metric,
        movement: measurement.movement,
        againstObjective: measurement.againstObjective ?? false,
        statement,
        currentValue: measurement.current.value,
        priorValue: measurement.prior.value,
        absoluteChange: measurement.absoluteChange,
        percentageChange: measurement.percentageChange,
        currentDenominator: measurement.current.denominator,
        priorDenominator: measurement.prior.denominator,
        currentCoverage: measurement.current.coverage,
        priorCoverage: measurement.prior.coverage,
        comparisonBasis: measurement.comparisonBasis,
        currentWindowStart: windows.current.start,
        currentWindowEnd: windows.current.end,
        priorWindowStart: windows.prior.start,
        priorWindowEnd: windows.prior.end,
        limitations: measurement.limitations,
        unknowns: measurement.unknowns,
        detectedAt: now,
      });

      // null means a referent stopped resolving inside this organization mid-run
      // -- archived away or deleted. Skip it rather than write a measurement
      // against something that is no longer there.
      if (!result) {
        outcomes.push({
          performanceObjectiveId: objective.id,
          objectiveTitle: objective.title,
          measureBindingId: binding.id,
          measurement,
          recorded: null,
          headlineId: null,
          withheld: 'VALUE_UNKNOWN',
        });
        continue;
      }

      if (result.outcome === 'ESTABLISHED') established += 1;
      else if (result.outcome === 'RESIGHTED') resighted += 1;
      else alreadyRecorded += 1;

      outcomes.push({
        performanceObjectiveId: objective.id,
        objectiveTitle: objective.title,
        measureBindingId: binding.id,
        measurement,
        recorded: result.outcome,
        headlineId: result.headline.id,
        withheld: null,
      });
    }

    return {
      objectivesConsidered: objectives.length,
      objectivesMeasurable: measurable,
      established,
      resighted,
      alreadyRecorded,
      withheld: withheldCount,
      currentWindowStart: windows.current.start,
      currentWindowEnd: windows.current.end,
      priorWindowStart: windows.prior.start,
      priorWindowEnd: windows.prior.end,
      outcomes,
    };
  }
}

/** The binding's confirmed selection, in the shape the aggregate read expects. */
function populationOf(binding: ObjectiveMeasureBindingView): {
  campaignExternalIds: string[];
  sourceExternalIds: string[];
  buyerExternalIds: string[];
  vendorExternalIds: string[];
  callerStates: string[];
} {
  return {
    campaignExternalIds: membersOf(binding.members, 'CAMPAIGN'),
    sourceExternalIds: membersOf(binding.members, 'SOURCE'),
    buyerExternalIds: membersOf(binding.members, 'BUYER'),
    vendorExternalIds: membersOf(binding.members, 'VENDOR'),
    // Empty means NO RESTRICTION. The repository treats an empty array as
    // "do not filter", never as "match nothing".
    callerStates: binding.callerStates,
  };
}
