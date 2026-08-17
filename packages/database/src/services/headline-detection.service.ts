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
//
// AND OBSERVED PERIODS ONLY. Complete is not the same as observed. A window can
// consist entirely of finished Eastern days and still contain days Loop never
// looked at, because zero stored rows and zero actual calls were indistinguishable
// until provider_observation_days existed. In August 2026 exactly that happened:
// three consecutive days ingested nothing, and the trailing-7-day window they fell
// into would have measured the gap as a commercial collapse -- correctly, by every
// rule then written. So this service now reads the observation ledger for all
// fourteen business dates FIRST and returns without touching an aggregate when any
// of them is uncertified. `measureChange` refuses the same case independently and
// is required by its own type to be told; neither guard trusts the other.

import {
  COMMERCIAL_HEADLINE_PRODUCER_VERSION,
  COMPARISON_SPAN_DAYS,
  MEASURE_METRIC_DEFINITIONS,
  assessWindowObservation,
  composeStatement,
  describePopulation,
  easternBusinessDatesIn,
  easternTrailingCompleteWindows,
  headlineDetectionKey,
  headlineRecurrenceKey,
  measureChange,
  membersOf,
  type BusinessDate,
  type MaterialityWithholding,
  type MeasurementResult,
  type ObjectiveMeasureBindingView,
  type WindowObservation,
} from '@emgloop/shared';

import type { PerformanceObjectiveRepository } from '../repositories/performance-objective.repository';
import type { ObjectiveMeasureBindingRepository } from '../repositories/objective-measure-binding.repository';
import type { MarketplaceCallRepository } from '../repositories/marketplace-call.repository';
import type { HeadlineRepository, RecordOutcome } from '../repositories/headline.repository';
import type { ProviderObservationRepository } from '../repositories/provider-observation.repository';
import { CALLGRID_PROVIDER, CALLS_STREAM } from './provider-observation.service';

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
  /**
   * Whether the compared periods were actually observed, and which days were not.
   *
   * Reported on EVERY run, not only a blocked one, so an operator can see that the
   * question was asked. A run that measured normally still says which fourteen
   * days it verified.
   */
  observation: WindowObservation;
  outcomes: ObjectiveDetectionOutcome[];
}

export class HeadlineDetectionService {
  constructor(
    private readonly objectives: PerformanceObjectiveRepository,
    private readonly bindings: ObjectiveMeasureBindingRepository,
    private readonly calls: MarketplaceCallRepository,
    private readonly headlines: HeadlineRepository,
    private readonly observations: ProviderObservationRepository,
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

    // THE OBSERVATION GATE, BEFORE ANY OBJECTIVE IS READ.
    //
    // Both windows are made of complete Eastern business days, and every one of
    // them must have been observed before any of them may be compared. The dates
    // come from the SAME helpers that built the windows, so the days certified and
    // the days measured cannot drift apart across a DST boundary.
    //
    // Ordered prior-then-current so a reader scanning the list reads time forwards.
    const dates: BusinessDate[] = [
      ...easternBusinessDatesIn(windows.prior),
      ...easternBusinessDatesIn(windows.current),
    ];
    const observation = assessWindowObservation(
      dates,
      await this.observations.statusesForDates(organizationId, CALLGRID_PROVIDER, CALLS_STREAM, dates),
    );

    // ACTIVE only. An archived objective records what the organization used to be
    // pursuing, and measuring against it would manufacture present relevance to
    // past intent.
    const objectives = await this.objectives.list(organizationId, { status: 'ACTIVE' });

    // NOT MEASURABLE -- INCOMPLETE DATA. Return before a single aggregate is read.
    //
    // The pure `measureChange` refuses an unobserved window too, and that is the
    // guarantee: it is required by the type system and cannot be bypassed. This
    // check is the same refusal made earlier, so no aggregate is even queried and
    // no commercial result is computed and then hidden. An objective still needs a
    // binding to be reported measurable, so that distinction survives -- a reader
    // learns both that the objective could be measured and that this period could
    // not be.
    if (!observation.fullyObserved) {
      const blocked: ObjectiveDetectionOutcome[] = [];
      let blockedMeasurable = 0;
      for (const objective of objectives) {
        const binding = await this.bindings.activeFor(organizationId, objective.id);
        if (binding) blockedMeasurable += 1;
        blocked.push({
          performanceObjectiveId: objective.id,
          objectiveTitle: objective.title,
          measureBindingId: binding?.id ?? null,
          measurement: null,
          recorded: null,
          headlineId: null,
          withheld: binding ? 'WINDOW_NOT_OBSERVED' : 'NOT_MEASURABLE',
        });
      }
      return {
        objectivesConsidered: objectives.length,
        objectivesMeasurable: blockedMeasurable,
        established: 0,
        resighted: 0,
        alreadyRecorded: 0,
        withheld: blockedMeasurable,
        currentWindowStart: windows.current.start,
        currentWindowEnd: windows.current.end,
        priorWindowStart: windows.prior.start,
        priorWindowEnd: windows.prior.end,
        observation,
        outcomes: blocked,
      };
    }

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
        observation,
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
        // Which completeness rule certified the days behind this measurement, and
        // how many it verified. Stored so the row stays interpretable when the
        // rule changes; never inferred later, because by then the evidence is gone.
        observationRuleVersion: observation.ruleVersion,
        observedDayCount: observation.observedDayCount,
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
      observation,
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
