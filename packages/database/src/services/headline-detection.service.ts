// HeadlineDetectionService -- Commercial Intelligence Stage 3 v1.
//
// The one place that turns a confirmed measure binding into a measured
// development. It reads three domains and writes one:
//
//   READ   performance_objectives       (Stage 1 -- what we are trying to do)
//   READ   objective_measure_bindings   (Stage 3 -- what that means, measurably)
//   READ   marketplace_calls            (CallGrid -- aggregates and member splits)
//   READ   provider_observation_days    (did Loop LOOK at this date?)
//   READ   provider_reconciliation_*    (did what it saw ARRIVE?)
//   READ   measurement_sources / _metrics / measure_source_authorities
//                                       (WHOSE number is this measure?)
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
// rule then written. So this service reads the observation ledger for all fourteen
// business dates FIRST and returns without touching an aggregate when any of them
// is uncertified.
//
// AND READY PERIODS ONLY -- WHICH IS MORE THAN OBSERVED. Observation answers "did
// Loop look". It does not answer "did what it saw arrive", "was this campaign
// supposed to deliver", or "whose number is this measure" -- and on 2026-08-05 all
// three mattered at once: 974 provider records against 867 local, 106 of the 107
// absences belonging to campaigns that could not have delivered, and every record
// carrying `converted=false` because one buyer settles the next day and never
// tells the provider. A window can be perfectly observed and still make a
// conversion rate of 0% computable at full coverage. So before any aggregate is
// read, this service resolves the day facts, splits the bound population by
// member, resolves each member's authority for THIS measure, and asks
// `assessReadiness`. `measureChange` takes that verdict as a REQUIRED input and
// refuses independently; neither guard trusts the other.
//
// IT RESOLVES, IT DOES NOT DECIDE. Every rule above lives in @emgloop/shared as a
// pure function. This service reads ledgers and passes what it found. It never
// declares an expectation, never declares an authority, never reconciles a day and
// never certifies one -- a measurement path that could write the facts it gates on
// would be able to unblock itself.

import {
  COMMERCIAL_HEADLINE_PRODUCER_VERSION,
  COMPARISON_SPAN_DAYS,
  MEASURE_METRIC_DEFINITIONS,
  assessReadiness,
  assessWindowObservation,
  composeStatement,
  describePopulation,
  easternBusinessDatesIn,
  easternTrailingCompleteWindows,
  headlineDetectionKey,
  headlineRecurrenceKey,
  measureChange,
  membersOf,
  principalReadinessReason,
  type BusinessDate,
  type MaterialityWithholding,
  type MeasurementReadiness,
  type MeasurementResult,
  type ObjectiveMeasureBindingView,
  type WindowObservation,
} from '@emgloop/shared';

import type { PerformanceObjectiveRepository } from '../repositories/performance-objective.repository';
import type { ObjectiveMeasureBindingRepository } from '../repositories/objective-measure-binding.repository';
import type { MarketplaceCallRepository } from '../repositories/marketplace-call.repository';
import type { HeadlineRepository, RecordOutcome } from '../repositories/headline.repository';
import type { ProviderObservationRepository } from '../repositories/provider-observation.repository';
import type { ProviderReconciliationRepository } from '../repositories/provider-reconciliation.repository';
import type { MeasurementSourceRepository } from '../repositories/measurement-source.repository';
import { CALLGRID_PROVIDER, CALLS_STREAM } from './provider-observation.service';

/** What one objective's evaluation concluded. Silence is reported, not hidden. */
export interface ObjectiveDetectionOutcome {
  performanceObjectiveId: string;
  objectiveTitle: string;
  /** Null when the objective has no confirmed binding: NOT MEASURABLE YET. */
  measureBindingId: string | null;
  /** Null when there was no binding to measure with. */
  measurement: MeasurementResult | null;
  /**
   * What stood between this objective and a number, in full.
   *
   * `withheld` names ONE reason because a table cell holds one. This holds every
   * finding, with the date and member each belongs to, so an operator reading a
   * run can see all four problems at once rather than fixing one and re-running to
   * discover the next. Null when the objective had no binding, or when the window
   * was refused before any population was resolved.
   */
  readiness: MeasurementReadiness | null;
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
    // REQUIRED, NOT OPTIONAL, for the reason `MeasurementInput.readiness` is
    // required: a service constructed without these could not ask whether a
    // measure may be computed, and the only two things it could then do are
    // assume yes -- the failure this layer exists to stop -- or withhold
    // everything while looking like it was working. Both are worse than a
    // compile error at the one place a caller wires it up.
    private readonly reconciliation: ProviderReconciliationRepository,
    private readonly measurementSources: MeasurementSourceRepository,
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
          // No population was resolved, so there is no per-member verdict to give.
          // `observation` on the run summary already names every unobserved day.
          readiness: null,
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

    // ONCE PER RUN, NOT ONCE PER OBJECTIVE. A day's reconciliation is a fact about
    // the provider stream and the date, not about any binding, so every objective
    // in this run is judged against the same fourteen answers -- and two objectives
    // can never disagree about whether the 11th was reconciled.
    const reconciliation = await this.reconciliation.factsForDates(
      organizationId,
      CALLGRID_PROVIDER,
      CALLS_STREAM,
      dates,
    );

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
          readiness: null,
          recorded: null,
          headlineId: null,
          withheld: 'NOT_MEASURABLE',
        });
        continue;
      }
      measurable += 1;

      const population = populationOf(binding);

      // THE POPULATION IS SPLIT BEFORE IT IS SUMMED. Every bound member is
      // returned, including one that contributed nothing, because a campaign that
      // went silent must still be assessed -- it is the silent ones that carry the
      // absences.
      const partitioned = await this.calls.partitionPopulationWindows(
        organizationId,
        population,
        [windows.prior, windows.current],
      );

      // A binding with no members cannot produce a population. The repository
      // rejects that at confirmation, so this is only reachable through a row
      // written by an older build -- and the honest answer is still silence.
      if (!partitioned) {
        outcomes.push({
          performanceObjectiveId: objective.id,
          objectiveTitle: objective.title,
          measureBindingId: binding.id,
          measurement: null,
          readiness: null,
          recorded: null,
          headlineId: null,
          withheld: 'VALUE_UNKNOWN',
        });
        withheldCount += 1;
        continue;
      }

      const { sources, authorities } = await this.measurementSources.readinessFacts(
        organizationId,
        partitioned.partitions.map((p) => ({
          dimension: p.dimension,
          memberExternalId: p.memberExternalId,
        })),
        binding.metric,
      );

      const readiness = assessReadiness({
        metric: binding.metric,
        dates,
        observation,
        partitions: partitioned.partitions,
        unattributedCalls: partitioned.unattributedCalls,
        reconciliation,
        authorities,
        sources,
        // NO OUTCOME DAYS, AND THAT FAILS CLOSED. `SourceOutcomeDay` is not
        // persisted yet, and the gate treats a missing outcome day for a
        // BUYER_REPORT source as AUTHORITATIVE_DATA_PENDING -- so a measure whose
        // authority names a report source withholds until the importer exists,
        // rather than being computed from whatever happens to be in the call rows.
        // Today no BUYER_REPORT source is registered, so the branch is unreached.
        outcomeDays: [],
      });

      // REFUSED BEFORE ANY AGGREGATE IS READ. `measureChange` would refuse the
      // same input -- it takes this verdict and cannot be called without one --
      // but returning here means no value is computed and then hidden, which is
      // the difference between a guard and a curtain.
      if (!readiness.ready) {
        outcomes.push({
          performanceObjectiveId: objective.id,
          objectiveTitle: objective.title,
          measureBindingId: binding.id,
          measurement: null,
          readiness,
          recorded: null,
          headlineId: null,
          withheld: principalReadinessReason(readiness),
        });
        withheldCount += 1;
        continue;
      }

      const [current, prior] = await Promise.all([
        this.calls.aggregatePopulationWindow(organizationId, population, windows.current),
        this.calls.aggregatePopulationWindow(organizationId, population, windows.prior),
      ]);
      if (!current || !prior) {
        outcomes.push({
          performanceObjectiveId: objective.id,
          objectiveTitle: objective.title,
          measureBindingId: binding.id,
          measurement: null,
          readiness,
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
        readiness,
      });

      if (!measurement.material || measurement.movement === null) {
        withheldCount += 1;
        outcomes.push({
          performanceObjectiveId: objective.id,
          objectiveTitle: objective.title,
          measureBindingId: binding.id,
          measurement,
          readiness,
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
          readiness,
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
        readiness,
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
