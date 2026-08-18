// Deterministic measurement and materiality -- Commercial Intelligence Stage 3.
//
// The pure half of Stage 3. Given two windows of already-aggregated counts and
// sums, this file computes what a bound measure was in each period, whether the
// move clears an approved materiality threshold, and what the resulting
// statement says. It reads no clock, performs no I/O, calls no model and touches
// no database -- so the same inputs give the same answer in a test, in a
// repository, and in a re-run six months from now. That is what makes a stored
// Headline reproducible rather than merely recorded.
//
// THE THRESHOLDS ARE INHERITED, NOT INVENTED. Every number below is copied from
// `CALLGRID_SIGNIFICANCE_RULES` in `callgrid-intelligence.ts`, which is the
// platform's existing, approved statement of what counts as material. The origin
// rule is named on each entry so the inheritance is checkable, and a test asserts
// the numbers still match. Loop did not get a second opinion about materiality;
// it reused the one it already had.
//
// SPARSE BY CONSTRUCTION. A measurement that can be computed is not a reason to
// tell anybody. Every guard here fails towards SILENCE: no baseline, no
// headline; thin sample, no headline; partial coverage, no headline; move below
// threshold, no headline. Twenty ordinary calls must produce nothing at all, and
// a test asserts exactly that.
//
// NULL IS NOT ZERO, AND NEITHER IS UNKNOWN. A metric whose inputs are absent
// returns a null value with a stated reason. A zero denominator produces UNKNOWN
// rather than a percentage. This is the rule the metric layer already applies to
// money, applied to measurement.
//
// NOTHING HERE SCORES, RANKS OR PRIORITIZES. There is no score, no confidence, no
// weight and no severity. A measurement either cleared a stated threshold or it
// did not, and the reader can check which.

import {
  absoluteChange,
  coverage as coverageOf,
  percentageChange,
  share,
} from './callgrid-metric-contract';
import {
  MEASURE_METRIC_DEFINITIONS,
  type MeasureDirection,
  type MeasureMetric,
  type MeasureUnit,
} from './objective-measure-binding';
import { describeUnobserved, type WindowObservation } from './provider-observation';

export const COMMERCIAL_MEASUREMENT_VERSION = 'commercial-measurement.v1';

/** Which build of the Stage 3 producer emitted a result. */
export const COMMERCIAL_HEADLINE_PRODUCER_VERSION = 'ci-headline.v1';

/** The one materiality rule Stage 3 v1 ships. Versioned, testable, explainable. */
export const CI_MATERIALITY_RULE_ID = 'ci.objective-measure-change';
export const CI_MATERIALITY_RULE_VERSION = 'v1';

/** How many complete Eastern days each side of the comparison covers. */
export const COMPARISON_SPAN_DAYS = 7;

export const COMPARISON_BASIS_LABEL =
  'Trailing 7 complete Eastern days against the 7 complete Eastern days before them';

// --- What a caller must supply ------------------------------------------------

/**
 * One window's aggregate facts about a bound population.
 *
 * ALREADY AGGREGATED, DELIBERATELY. Row-level economics never reach this file --
 * a layer that only needs a total must not be handed per-call money on the way
 * past, which is the same boundary Stage 2 drew when it selected labels and
 * refused revenue.
 *
 * The `*Reported` counts are the honest denominators: how many calls actually
 * carried the field, as opposed to how many calls there were. Without them a
 * rate over three reporting calls out of four hundred is indistinguishable from
 * a rate over all four hundred.
 */
export interface PopulationWindowAggregate {
  /** Every call in the bound population over the window. Always known. */
  totalCalls: number;

  /** Sum of reported revenue in cents, or null when NO call reported any. */
  revenueCents: number | null;
  /** How many calls carried a revenue value at all. */
  revenueReported: number;

  monetizedTrue: number;
  monetizedReported: number;

  convertedTrue: number;
  convertedReported: number;

  noRouteTrue: number;
  noRouteReported: number;
}

/** The half-open window an aggregate describes. */
export interface MeasurementWindow {
  start: Date;
  end: Date;
}

export interface MeasurementInput {
  metric: MeasureMetric;
  direction: MeasureDirection;
  current: PopulationWindowAggregate;
  prior: PopulationWindowAggregate;
  currentWindow: MeasurementWindow;
  priorWindow: MeasurementWindow;
  /**
   * Whether every business date in both windows was actually observed.
   *
   * REQUIRED, DELIBERATELY. An optional field defaulting to "observed" would let
   * any caller — including one written before this guard existed — measure an
   * unobserved window by saying nothing, which is the failure mode itself. Making
   * it required means the type system refuses to compile a caller that has not
   * answered the question. The verdict is PASSED IN rather than resolved here so
   * this file stays pure: it reads no ledger, exactly as it reads no clock.
   */
  observation: WindowObservation;
}

// --- What one window measured -------------------------------------------------

/** One side of the comparison, resolved. */
export interface MeasuredValue {
  /** The value in the metric's own unit, or null when it cannot be established. */
  value: number | null;
  /**
   * The denominator the value was computed over -- calls for a rate, calls in the
   * population for a count or a sum. Always stated, so a reader can judge the
   * sample rather than trusting the number.
   */
  denominator: number;
  /**
   * Fraction of the denominator that actually carried the input, 0-1. Null when
   * the metric has no coverage concept (a call either exists or it does not).
   */
  coverage: number | null;
  /** Why the value is null, when it is. Empty when the value resolved. */
  unknownReason: string | null;
}

// --- The result ----------------------------------------------------------------

/**
 * Why a measurement did not become a Headline.
 *
 * A CLOSED VOCABULARY, and it exists because silence must be explicable. "Loop
 * found nothing" and "Loop could not look" are different facts, and a surface
 * that cannot tell them apart is an empty state that reads as an all-clear.
 */
export const MATERIALITY_WITHHOLDINGS = [
  // Readiness -- the measure could not be computed at all. Every member here is
  // a gate that runs BEFORE the arithmetic, and each one names a different thing
  // a person or a job must do. See `measurement-readiness.ts`.
  'WINDOW_NOT_OBSERVED',
  'RECONCILIATION_MISSING',
  'RECONCILIATION_INCONCLUSIVE',
  'CAMPAIGN_EXPECTATION_UNKNOWN',
  'POPULATION_INCOMPLETE',
  'SOURCE_AUTHORITY_MISSING',
  'SOURCE_AUTHORITY_CONFLICT',
  'MEASURE_NOT_SUPPORTED_BY_SOURCE',
  'AUTHORITATIVE_DATA_PENDING',
  'AUTHORITATIVE_DATA_INCOMPLETE',
  'MIXED_SOURCE_AGGREGATION_UNSUPPORTED',
  'CALL_UNATTRIBUTED',
  // Materiality -- the measure WAS computed and is not worth telling anyone about.
  // These are findings about the data, not gaps in it.
  'NO_BASELINE',
  'INSUFFICIENT_VOLUME',
  'INSUFFICIENT_COVERAGE',
  'BELOW_THRESHOLD',
  'VALUE_UNKNOWN',
] as const;
export type MaterialityWithholding = (typeof MATERIALITY_WITHHOLDINGS)[number];

export const MATERIALITY_WITHHOLDING_LABELS: Record<MaterialityWithholding, string> = {
  WINDOW_NOT_OBSERVED:
    'Some days in the compared periods were never observed, so a change cannot be measured.',
  RECONCILIATION_MISSING:
    'Some days were observed but never reconciled, so what arrived was never checked against what exists.',
  RECONCILIATION_INCONCLUSIVE:
    'The comparison between the provider and Loop is not sound, so nothing can be concluded from it.',
  CAMPAIGN_EXPECTATION_UNKNOWN:
    'Nobody has said whether records from a campaign in this population were expected.',
  POPULATION_INCOMPLETE:
    'Records that were expected to arrive did not, so this population is measured over an incomplete set.',
  SOURCE_AUTHORITY_MISSING: 'No source has been declared authoritative for this measure.',
  SOURCE_AUTHORITY_CONFLICT: 'Two sources are declared authoritative for this measure at once.',
  MEASURE_NOT_SUPPORTED_BY_SOURCE:
    'The authoritative source does not supply this measure.',
  AUTHORITATIVE_DATA_PENDING:
    'The authoritative data for some days has not arrived yet.',
  AUTHORITATIVE_DATA_INCOMPLETE:
    'The authoritative data arrived with rows that matched no call, so the totals are unknown rather than lower.',
  MIXED_SOURCE_AGGREGATION_UNSUPPORTED:
    'This population spans sources whose definitions of the measure are not declared to be the same.',
  CALL_UNATTRIBUTED:
    'Some calls in this population carry no campaign, so no source can be resolved for them.',
  NO_BASELINE: 'There was no non-zero prior value to compare against.',
  INSUFFICIENT_VOLUME: 'Too few calls for the change to mean anything.',
  INSUFFICIENT_COVERAGE: 'Too few calls reported the value, so the totals are lower bounds.',
  BELOW_THRESHOLD: 'The change did not reach the threshold this rule requires.',
  VALUE_UNKNOWN: 'The measure could not be established in one or both periods.',
};

/**
 * What the operator must DO about each withholding.
 *
 * A SEPARATE RECORD rather than a second field on the labels above, so no existing
 * reader of `MATERIALITY_WITHHOLDING_LABELS` changes shape. "Measurement
 * unavailable" is not an answer a person can act on; every silence Loop produces
 * should end with the next move, and the materiality members honestly say that
 * there isn't one -- they are findings, not gaps.
 */
export const MATERIALITY_WITHHOLDING_NEXT_ACTIONS: Record<MaterialityWithholding, string> = {
  WINDOW_NOT_OBSERVED: 'Run provider certification for the named dates.',
  RECONCILIATION_MISSING: 'Run reconciliation for the named dates.',
  RECONCILIATION_INCONCLUSIVE:
    'Investigate: the provider read or the identity comparison itself is unsound.',
  CAMPAIGN_EXPECTATION_UNKNOWN:
    'Declare the campaign: expected, not connected to Loop, or deliberately excluded.',
  POPULATION_INCOMPLETE:
    'Check the campaign is connected to Loop, then recover the named days.',
  SOURCE_AUTHORITY_MISSING: 'Declare which source is authoritative for this campaign and measure.',
  SOURCE_AUTHORITY_CONFLICT: 'Close one of the two overlapping declarations.',
  MEASURE_NOT_SUPPORTED_BY_SOURCE:
    'Measure something this source supplies, or declare a source that supplies this.',
  AUTHORITATIVE_DATA_PENDING: 'Wait for the report, or import it if it has arrived.',
  AUTHORITATIVE_DATA_INCOMPLETE: 'Resolve the rows that matched no call.',
  MIXED_SOURCE_AGGREGATION_UNSUPPORTED:
    'Split the objective by source, or declare the two definitions to be the same measure.',
  CALL_UNATTRIBUTED: 'Investigate why calls in this population carry no campaign.',
  NO_BASELINE: 'Nothing to do — there is no prior period to compare against.',
  INSUFFICIENT_VOLUME: 'Nothing to do — the sample is too small to mean anything.',
  INSUFFICIENT_COVERAGE: 'Nothing to do — too few calls reported the value.',
  BELOW_THRESHOLD: 'Nothing to do — the change did not clear the materiality threshold.',
  VALUE_UNKNOWN: 'Nothing to do — the measure could not be established from the data.',
};

/** What a reader sees when observation, not materiality, is the reason for silence. */
export const NOT_MEASURABLE_INCOMPLETE_DATA = 'NOT MEASURABLE — INCOMPLETE DATA';

/**
 * What a reader sees when the data is not broken, merely not here yet.
 *
 * A SECOND STRING, deliberately. Something that resolves by waiting and something
 * that resolves by fixing are different situations, and sending an operator to
 * debug a report that simply has not been sent yet wastes their morning and
 * teaches them to ignore the banner.
 */
export const NOT_MEASURABLE_AWAITING_DATA = 'AWAITING AUTHORITATIVE DATA';

/** Which way the measure moved. Part of a Headline's identity -- see `headline.ts`. */
export type MeasureMovement = 'INCREASE' | 'DECREASE';

export interface MeasurementResult {
  metric: MeasureMetric;
  unit: MeasureUnit;
  direction: MeasureDirection;

  current: MeasuredValue;
  prior: MeasuredValue;

  /** Current less prior, in the metric's unit. Null when either side is unknown. */
  absoluteChange: number | null;
  /** Relative change as a fraction. Null when there is no non-zero baseline. */
  percentageChange: number | null;
  movement: MeasureMovement | null;
  /** True when the move runs against the objective's stated direction. */
  againstObjective: boolean | null;

  currentWindow: MeasurementWindow;
  priorWindow: MeasurementWindow;
  comparisonBasis: string;

  /** Caveats that travel with this measurement forever. */
  limitations: string[];
  /** What this measurement leaves undetermined. Never silently empty. */
  unknowns: string[];

  /** True only when every guard passed AND the threshold was cleared. */
  material: boolean;
  /** Why not, when not. Null when `material` is true. */
  withheld: MaterialityWithholding | null;

  ruleId: string;
  ruleVersion: string;
  formulaVersion: string;
}

// --- The inherited thresholds --------------------------------------------------

interface MaterialityThreshold {
  /** Minimum relative move, as a fraction. */
  relative: number;
  /** Minimum absolute move in the metric's unit. Null when the rule has none. */
  absolute: number | null;
  /** Minimum calls required, and in which windows. */
  minimumVolume: number;
  /**
   * true  -- the minimum applies to BOTH windows (a rate needs a denominator on
   *          each side or it cannot be computed at all)
   * false -- the minimum applies to the PRIOR window only, so a genuine collapse
   *          from a healthy base still reports rather than being suppressed for
   *          having too few calls left
   */
  volumeBothWindows: boolean;
  /** Minimum share of the denominator that must have reported. Null = n/a. */
  minimumCoverage: number | null;
  /** The CallGrid significance rule these numbers were taken from. */
  inheritedFrom: string;
}

/**
 * Thresholds per metric, every number inherited from an approved rule.
 *
 *   volume-change v1        15% relative, 20 calls absolute, 20-call baseline
 *   revenue-change v1       10% relative, $250 absolute, 10-call baseline, 50% coverage
 *   billable-efficiency v1  20% relative change in a rate, 30 calls in EACH window
 *
 * The rate rules borrow `billable-efficiency` because it is the platform's only
 * approved answer to "how much must a RATE move before it is worth saying", and
 * a monetized rate, a conversion rate and a no-route rate are the same shape of
 * quantity as a billable rate. Coverage is held at 50% across the board, the
 * floor `revenue-change` already sets.
 */
const THRESHOLDS: Record<MeasureMetric, MaterialityThreshold> = {
  CALL_VOLUME: {
    relative: 0.15,
    absolute: 20,
    minimumVolume: 20,
    volumeBothWindows: false,
    minimumCoverage: null,
    inheritedFrom: 'volume-change v1',
  },
  REVENUE: {
    relative: 0.1,
    absolute: 25_000,
    minimumVolume: 10,
    volumeBothWindows: false,
    minimumCoverage: 0.5,
    inheritedFrom: 'revenue-change v1',
  },
  MONETIZED_RATE: {
    relative: 0.2,
    absolute: null,
    minimumVolume: 30,
    volumeBothWindows: true,
    minimumCoverage: 0.5,
    inheritedFrom: 'billable-efficiency v1',
  },
  CONVERSION_RATE: {
    relative: 0.2,
    absolute: null,
    minimumVolume: 30,
    volumeBothWindows: true,
    minimumCoverage: 0.5,
    inheritedFrom: 'billable-efficiency v1',
  },
  NO_ROUTE_RATE: {
    relative: 0.2,
    absolute: null,
    minimumVolume: 30,
    volumeBothWindows: true,
    minimumCoverage: 0.5,
    inheritedFrom: 'billable-efficiency v1',
  },
};

/** Exported so the surface can state the rule rather than assert its conclusion. */
export function materialityThreshold(metric: MeasureMetric): MaterialityThreshold {
  return THRESHOLDS[metric];
}

/** The rule in one sentence a reader can check the numbers against. */
export function describeThreshold(metric: MeasureMetric): string {
  const t = THRESHOLDS[metric];
  const def = MEASURE_METRIC_DEFINITIONS[metric];
  const parts = [`a move of at least ${Math.round(t.relative * 100)}%`];
  if (t.absolute !== null) parts.push(`and at least ${formatValue(t.absolute, def.unit)}`);
  parts.push(
    t.volumeBothWindows
      ? `over at least ${t.minimumVolume} calls in each period`
      : `with at least ${t.minimumVolume} calls in the earlier period`,
  );
  if (t.minimumCoverage !== null) {
    parts.push(`and at least ${Math.round(t.minimumCoverage * 100)}% of those calls reporting the value`);
  }
  return `Requires ${parts.join(', ')}. Thresholds inherited from ${t.inheritedFrom}.`;
}

// --- Measuring one window ------------------------------------------------------

/**
 * Resolve one metric over one window's aggregate.
 *
 * Every branch that cannot answer returns a null value WITH a reason. There is no
 * path here that returns 0 for an absent input, and there is no path that divides
 * by a zero denominator.
 */
export function measureWindow(
  metric: MeasureMetric,
  agg: PopulationWindowAggregate,
): MeasuredValue {
  switch (metric) {
    case 'CALL_VOLUME':
      // A count has no coverage concept: a call row either exists or it does not.
      return { value: agg.totalCalls, denominator: agg.totalCalls, coverage: null, unknownReason: null };

    case 'REVENUE': {
      const cov = coverageOf(agg.revenueReported, agg.totalCalls);
      if (agg.revenueCents === null) {
        return {
          value: null,
          denominator: agg.totalCalls,
          coverage: cov,
          unknownReason: 'No call in this period reported a revenue value.',
        };
      }
      return { value: agg.revenueCents, denominator: agg.totalCalls, coverage: cov, unknownReason: null };
    }

    case 'MONETIZED_RATE':
      return rate(agg.monetizedTrue, agg.monetizedReported, agg.totalCalls, 'monetized');
    case 'CONVERSION_RATE':
      return rate(agg.convertedTrue, agg.convertedReported, agg.totalCalls, 'converted');
    case 'NO_ROUTE_RATE':
      return rate(agg.noRouteTrue, agg.noRouteReported, agg.totalCalls, 'no-route');

    default: {
      const unreachable: never = metric;
      throw new Error(`Unhandled measure metric: ${String(unreachable)}`);
    }
  }
}

/**
 * A flag rate over the calls that CARRIED the flag.
 *
 * The denominator is `reported`, never `totalCalls`: a call whose flag the
 * provider never sent has not been observed as false, and counting it as false
 * would manufacture the very outcome the rate is measuring.
 */
function rate(trueCount: number, reported: number, totalCalls: number, name: string): MeasuredValue {
  const cov = coverageOf(reported, totalCalls);
  const value = share(trueCount, reported);
  return {
    value,
    denominator: reported,
    coverage: cov,
    unknownReason:
      value === null
        ? `No call in this period carried the ${name} flag, so there is no denominator to divide by.`
        : null,
  };
}

// --- Measuring the change ------------------------------------------------------

/**
 * Compare two windows and decide whether the move is material.
 *
 * PURE. No clock, no I/O, no randomness. The windows arrive resolved from
 * `business-time.ts`, which is the only place allowed to decide what a complete
 * Eastern day is.
 */
export function measureChange(input: MeasurementInput): MeasurementResult {
  const def = MEASURE_METRIC_DEFINITIONS[input.metric];
  const t = THRESHOLDS[input.metric];

  // THE OBSERVATION GATE, BEFORE ANY ARITHMETIC.
  //
  // This returns before `measureWindow` is ever called, so no value, change or
  // percentage is computed at all. That is the point: a measurement over a window
  // Loop did not fully observe is not a true result that happens to be withheld,
  // it is not a measurement. Computing it and then declining to show it would
  // leave a number in the result object for some later caller to read, and Stage
  // 2 already shipped one defect of exactly that shape.
  if (!input.observation.fullyObserved) {
    return unobservedResult(input, def);
  }

  const current = measureWindow(input.metric, input.current);
  const prior = measureWindow(input.metric, input.prior);

  const abs = absoluteChange(current.value, prior.value);
  const pct = percentageChange(current.value, prior.value);
  const movement: MeasureMovement | null = abs === null || abs === 0 ? null : abs > 0 ? 'INCREASE' : 'DECREASE';

  const againstObjective =
    movement === null
      ? null
      : input.direction === 'HIGHER_IS_BETTER'
        ? movement === 'DECREASE'
        : movement === 'INCREASE';

  const limitations = [...def.limitations];
  const unknowns: string[] = [];
  if (current.unknownReason) unknowns.push(`Current period: ${current.unknownReason}`);
  if (prior.unknownReason) unknowns.push(`Earlier period: ${prior.unknownReason}`);

  const withheld = assess(input, current, prior, abs, pct, t);
  if (withheld === 'INSUFFICIENT_COVERAGE') {
    unknowns.push(
      'Coverage is below the level this rule requires, so the totals are lower bounds rather than measurements.',
    );
  }

  return {
    metric: input.metric,
    unit: def.unit,
    direction: input.direction,
    current,
    prior,
    absoluteChange: abs,
    percentageChange: pct,
    movement,
    againstObjective,
    currentWindow: input.currentWindow,
    priorWindow: input.priorWindow,
    comparisonBasis: COMPARISON_BASIS_LABEL,
    limitations,
    unknowns,
    material: withheld === null,
    withheld,
    ruleId: CI_MATERIALITY_RULE_ID,
    ruleVersion: CI_MATERIALITY_RULE_VERSION,
    formulaVersion: COMMERCIAL_MEASUREMENT_VERSION,
  };
}

/**
 * The result for a comparison whose days were not all observed.
 *
 * Every measured field is null and every denominator is zero, because nothing was
 * measured and nothing was counted. Zero here is not a quantity claimed about the
 * business — `value` is null, which is what a reader and every downstream rule
 * actually consult — it is the honest count of rows this refusal looked at, which
 * is none. The unobserved dates travel in `unknowns` so the reason survives with
 * the result rather than living only in a log line.
 */
function unobservedResult(
  input: MeasurementInput,
  def: (typeof MEASURE_METRIC_DEFINITIONS)[MeasureMetric],
): MeasurementResult {
  const notMeasured: MeasuredValue = {
    value: null,
    denominator: 0,
    coverage: null,
    unknownReason: 'The period was not fully observed, so no value was established.',
  };
  return {
    metric: input.metric,
    unit: def.unit,
    direction: input.direction,
    current: notMeasured,
    prior: { ...notMeasured },
    absoluteChange: null,
    percentageChange: null,
    movement: null,
    againstObjective: null,
    currentWindow: input.currentWindow,
    priorWindow: input.priorWindow,
    comparisonBasis: COMPARISON_BASIS_LABEL,
    limitations: [...def.limitations],
    unknowns: [describeUnobserved(input.observation)],
    material: false,
    withheld: 'WINDOW_NOT_OBSERVED',
    ruleId: CI_MATERIALITY_RULE_ID,
    ruleVersion: CI_MATERIALITY_RULE_VERSION,
    formulaVersion: COMMERCIAL_MEASUREMENT_VERSION,
  };
}

/**
 * The materiality rule itself. Returns the reason to stay silent, or null to
 * speak. Ordered from "could not look" to "looked and it was small", because the
 * first explanation a reader needs is the most fundamental one that applied.
 *
 * Observation is not checked here: it is more fundamental still, and is settled
 * in `measureChange` before any value is computed.
 */
function assess(
  input: MeasurementInput,
  current: MeasuredValue,
  prior: MeasuredValue,
  abs: number | null,
  pct: number | null,
  t: MaterialityThreshold,
): MaterialityWithholding | null {
  // 1. Sample. Checked first because a threshold applied to four calls is not a
  //    weaker conclusion, it is a meaningless one.
  if (input.prior.totalCalls < t.minimumVolume) return 'INSUFFICIENT_VOLUME';
  if (t.volumeBothWindows && input.current.totalCalls < t.minimumVolume) return 'INSUFFICIENT_VOLUME';

  // 2. Could the measure be established at all?
  if (current.value === null || prior.value === null) return 'VALUE_UNKNOWN';

  // 3. Coverage. A change computed over a third of the population is a statement
  //    about reporting, not about the business.
  if (t.minimumCoverage !== null) {
    if (current.coverage === null || current.coverage < t.minimumCoverage) return 'INSUFFICIENT_COVERAGE';
    if (prior.coverage === null || prior.coverage < t.minimumCoverage) return 'INSUFFICIENT_COVERAGE';
  }

  // 4. A baseline of zero has no percentage. An increase from nothing is an entry
  //    and would need its own rule; Stage 3 v1 does not have one and says so
  //    rather than reporting an infinite move.
  if (pct === null || abs === null) return 'NO_BASELINE';

  // 5. The threshold. Both tests must pass where both exist, so a large
  //    percentage on a tiny base stays quiet -- the whole point of pairing them.
  if (Math.abs(pct) < t.relative) return 'BELOW_THRESHOLD';
  if (t.absolute !== null && Math.abs(abs) < t.absolute) return 'BELOW_THRESHOLD';

  return null;
}

// --- Rendering measured values -------------------------------------------------

/**
 * A measured value in its own unit. Presentation only.
 *
 * Cents are rendered as whole dollars because a marketplace total to the penny
 * implies a precision the provider's reporting does not have.
 */
export function formatValue(value: number | null, unit: MeasureUnit): string {
  if (value === null) return 'unknown';
  switch (unit) {
    case 'CENTS':
      return `$${Math.round(value / 100).toLocaleString('en-US')}`;
    case 'RATIO':
      return `${(value * 100).toFixed(1)}%`;
    case 'COUNT':
      return value.toLocaleString('en-US');
    default: {
      const unreachable: never = unit;
      throw new Error(`Unhandled unit: ${String(unreachable)}`);
    }
  }
}

/**
 * The statement a Headline carries, composed ENTIRELY from measured values.
 *
 * DISPLAY ONLY, AND NEVER AN INPUT. This sentence contains Loop's own words as
 * well as the source's, exactly like `CommercialSignal.observationSummary` -- and
 * Stage 2 shipped a real defect by letting a mapper's template words establish
 * relevance and then reporting them back as terms the source had supplied. No
 * evaluator, rule or future measurement may read this field. It exists so a human
 * can read one line; the numbers beside it are the record.
 *
 * It states WHAT MOVED and BY HOW MUCH. It never states why, never names a cause,
 * and never recommends anything.
 */
export function composeStatement(
  result: MeasurementResult,
  context: { metricLabel: string; population: string },
): string {
  const verb = result.movement === 'INCREASE' ? 'rose' : 'fell';
  const pct = result.percentageChange === null ? null : Math.abs(result.percentageChange * 100);
  const from = formatValue(result.prior.value, result.unit);
  const to = formatValue(result.current.value, result.unit);
  const magnitude = pct === null ? '' : ` ${pct.toFixed(pct < 10 ? 1 : 0)}%`;
  return `${context.metricLabel} ${verb}${magnitude}, from ${from} to ${to}, across ${context.population} over the last ${COMPARISON_SPAN_DAYS} complete days.`;
}
