// Anomaly detection — "is this unusual?", which is a different question from
// "did this change?".
//
// A change is two points. An anomaly is a point against a DISTRIBUTION. Reporting
// a 30% revenue drop as an anomaly when revenue routinely swings 40% would be
// false alarm; missing a 12% drop in a business that has never moved more than 3%
// would be a miss. Both require the series, so every rule here that needs a
// distribution declines to fire without one and says why.
//
// TWO RULES THAT SHAPE THE FILE
//
// 1. **Never compare incomplete periods.** The series only ever contains complete
//    periods (`buildHistoryPeriods` refuses to build one for a live window), so a
//    distribution rule cannot silently include a partial measurement.
//
// 2. **Divergence is an observation, not a diagnosis.** "Revenue rose while calls
//    fell" is a fact. WHY is not visible to Loop — pricing, mix, routing and
//    demand are all invisible — so these findings describe the shape of the
//    movement and hand the question to a person.

import {
  deriveConfidence,
  type ActionSafety,
  type AffectedEntity,
  type CallGridFinding,
  type Severity,
  type SignificanceRule,
} from './callgrid-intelligence';
import { buildFinding, type EvidenceSpec, type FindingContext } from './callgrid-finding-builder';
import {
  MIN_SERIES_POINTS,
  entityCallSeries,
  entitySeries,
  extremeVersusSeries,
  historyEntityKey,
  mean,
  oscillations,
  seriesOf,
  zScore,
  type HistorySeries,
} from './callgrid-history';

export const ANOMALY_RULE_VERSION = 'v1';

/** Standard deviations from the series mean before a point is called unusual. */
const SPIKE_Z = 2;
/** Direction flips across the series before it is called unstable rather than trending. */
const OSCILLATION_FLIPS = 3;
/** Minimum money move before any anomaly is worth an operator's time ($250). */
const MONEY_FLOOR = 25_000;

export const ANOMALY_SIGNIFICANCE_RULES: readonly SignificanceRule[] = [
  {
    ruleId: 'anomaly-revenue-outlier',
    version: ANOMALY_RULE_VERSION,
    metric: 'revenue',
    minimumDataRequirements: `At least ${MIN_SERIES_POINTS} complete prior periods carrying a revenue value, and a non-zero deviation across them.`,
    absoluteThreshold: MONEY_FLOOR,
    percentageThreshold: null,
    minimumVolume: 10,
    baselineWindow: 'historical_series',
    severityLogic: 'NOTABLE at 2 standard deviations, HIGH at 3, CRITICAL at 4.',
    suppressionConditions: [
      'No historical series (a live window has none by construction).',
      'Every prior period held the same value — there is no deviation scale to measure against.',
      'The move is smaller than $250 in absolute terms.',
    ],
    explanation: 'A move is only unusual relative to how much this business normally moves. Two points cannot establish that.',
  },
  {
    ruleId: 'anomaly-volume-outlier',
    version: ANOMALY_RULE_VERSION,
    metric: 'totalCalls',
    minimumDataRequirements: `At least ${MIN_SERIES_POINTS} complete prior periods, and a non-zero deviation across them.`,
    absoluteThreshold: 20,
    percentageThreshold: null,
    minimumVolume: 20,
    baselineWindow: 'historical_series',
    severityLogic: 'NOTABLE at 2 standard deviations, HIGH at 3, CRITICAL at 4.',
    suppressionConditions: ['No historical series.', 'Fewer than 20 calls moved.'],
    explanation: 'Call volume has its own normal range; a drop is only notable against it.',
  },
  {
    ruleId: 'anomaly-entity-disappeared',
    version: ANOMALY_RULE_VERSION,
    metric: 'revenue',
    minimumDataRequirements: `An entity present with revenue in at least ${MIN_SERIES_POINTS} prior complete periods and absent from the selected one.`,
    absoluteThreshold: MONEY_FLOOR,
    percentageThreshold: null,
    minimumVolume: 0,
    baselineWindow: 'historical_series',
    severityLogic: 'Scaled by the entity\'s average share of prior revenue.',
    suppressionConditions: [
      'No historical series.',
      'The entity was intermittent — it must have been present in every observed prior period for absence to be notable.',
    ],
    explanation: 'An entity that was consistently present and is now absent is the single most actionable observation available from call data.',
  },
  {
    ruleId: 'anomaly-divergence',
    version: ANOMALY_RULE_VERSION,
    metric: 'revenue',
    minimumDataRequirements: 'Revenue and call volume both known in the selected and comparison windows.',
    absoluteThreshold: MONEY_FLOOR,
    percentageThreshold: 0.15,
    minimumVolume: 20,
    baselineWindow: 'comparison_window',
    severityLogic: 'NOTABLE always; HIGH when both sides moved more than 30%.',
    suppressionConditions: ['Either side is unknown.', 'The two moved in the same direction.'],
    explanation: 'Revenue and volume moving in opposite directions means the value per call changed. That is a different problem from a traffic problem, and it needs a different review.',
  },
  {
    ruleId: 'anomaly-profit-divergence',
    version: ANOMALY_RULE_VERSION,
    metric: 'profit',
    minimumDataRequirements: 'Revenue and profit both known in both windows, with profit coverage above 50%.',
    absoluteThreshold: MONEY_FLOOR,
    percentageThreshold: 0.15,
    minimumVolume: 10,
    baselineWindow: 'comparison_window',
    severityLogic: 'NOTABLE always; HIGH when profit fell while revenue rose.',
    suppressionConditions: [
      'Profit coverage below 50% — profit computed over rows missing payout or cost overstates margin.',
      'Both moved in the same direction by a similar proportion.',
    ],
    explanation: 'Profit moving against revenue means the cost of the revenue changed. Revenue alone would hide it.',
  },
  {
    ruleId: 'anomaly-oscillation',
    version: ANOMALY_RULE_VERSION,
    metric: 'revenue',
    minimumDataRequirements: `At least ${MIN_SERIES_POINTS} complete prior periods carrying a revenue value.`,
    absoluteThreshold: null,
    percentageThreshold: null,
    minimumVolume: 0,
    baselineWindow: 'historical_series',
    severityLogic: `INFORMATIONAL below ${OSCILLATION_FLIPS} direction flips, NOTABLE at or above.`,
    suppressionConditions: ['No historical series.'],
    explanation: 'Repeated reversals mean "unstable", which calls for a different review than "declining". Reporting one as the other sends a person to the wrong place.',
  },
];

export type AnomalyDimension = 'buyers' | 'vendors' | 'sources' | 'campaigns';

export interface AnomalyDimRow {
  key: string;
  label: string;
  calls: number;
  revenueCents: number | null;
}

export interface AnomalyMetrics {
  available: boolean;
  totalCalls: number | null;
  billableCalls: number | null;
  revenueCents: number | null;
  profitCents: number | null;
  revenueCoverage: number | null;
  profitCoverage: number | null;
}

export interface AnomalyInput extends FindingContext {
  includesLiveData: boolean;
  metrics: AnomalyMetrics;
  comparison: AnomalyMetrics | null;
  dimensions: Record<AnomalyDimension, readonly AnomalyDimRow[]>;
  history: HistorySeries;
}

const DIMS: AnomalyDimension[] = ['buyers', 'vendors', 'sources', 'campaigns'];

const DIM_NOUN: Record<AnomalyDimension, { one: string; entity: AffectedEntity['entityType'] }> = {
  buyers: { one: 'buyer', entity: 'buyer' },
  vendors: { one: 'vendor', entity: 'vendor' },
  sources: { one: 'source', entity: 'source' },
  campaigns: { one: 'campaign', entity: 'campaign' },
};

function money(cents: number | null): string {
  if (cents === null) return 'an unknown amount';
  return (cents < 0 ? '-' : '') + '$' + Math.round(Math.abs(cents) / 100).toLocaleString('en-US');
}

function severityFromZ(z: number): Severity {
  const m = Math.abs(z);
  if (m >= 4) return 'CRITICAL';
  if (m >= 3) return 'HIGH';
  return 'NOTABLE';
}

/** The caveat every finding on an in-progress window must carry. */
function liveLimitation(input: AnomalyInput): string[] {
  return input.includesLiveData
    ? ['The selected period is still in progress, so this observation may change before the period closes.']
    : [];
}

const NO_SERIES_LIMITATION =
  'No historical series is available for this period, so Loop compared against a single prior period rather than a distribution.';

// --- Distribution rules -------------------------------------------------------

function outlierFinding(
  input: AnomalyInput,
  metric: 'revenueCents' | 'totalCalls',
  ruleId: string,
  label: string,
  floor: number,
  format: (n: number | null) => string,
): CallGridFinding | null {
  const series = seriesOf(input.history, metric);
  const current = input.metrics[metric];
  const z = zScore(current, series);
  if (z.value === null || current === null) return null;
  if (Math.abs(z.value) < SPIKE_Z) return null;

  const avg = mean(series);
  if (avg.value === null) return null;
  const delta = current - avg.value;
  if (Math.abs(delta) < floor) return null;

  const up = delta > 0;
  const extreme = extremeVersusSeries(current, series);
  const severity = severityFromZ(z.value);
  const id = `anomaly-${metric}-outlier`;

  const recordClause =
    extreme.extreme === 'HIGH' ? ' It is the highest value across every period observed.'
      : extreme.extreme === 'LOW' ? ' It is the lowest value across every period observed.'
      : '';

  const evidence: EvidenceSpec[] = [
    {
      metricKey: metric === 'revenueCents' ? 'revenue' : 'totalCalls',
      entityType: 'window',
      window: input.windowLabel,
      normalizedValue: current,
      classification: 'VERIFIED',
      completeness: metric === 'revenueCents' ? input.metrics.revenueCoverage : null,
      notes: 'The selected period\'s measured value.',
    },
    {
      metricKey: metric === 'revenueCents' ? 'revenue' : 'totalCalls',
      entityType: 'window',
      window: `${z.usablePoints} complete prior periods`,
      derivedValue: Math.round(avg.value),
      formula: 'mean(value) over complete prior periods carrying a value',
      formulaVersion: ANOMALY_RULE_VERSION,
      classification: 'DERIVED',
      notes: `Average across the historical series. ${z.usablePoints} of ${z.totalPoints} periods carried a value.`,
    },
    {
      metricKey: metric === 'revenueCents' ? 'revenue' : 'totalCalls',
      entityType: 'window',
      window: `${z.usablePoints} complete prior periods`,
      derivedValue: Math.round(z.value * 100) / 100,
      formula: '(current - mean) / standard deviation',
      formulaVersion: ANOMALY_RULE_VERSION,
      classification: 'DERIVED',
      notes: 'Standard deviations from the historical mean.',
    },
  ];

  return buildFinding(
    {
      id,
      findingType: 'ANOMALY',
      title: `${label} is unusually ${up ? 'high' : 'low'} for this business`,
      plainLanguageSummary:
        `${label} of ${format(current)} sits ${Math.abs(Math.round(z.value * 10) / 10)} standard deviations ` +
        `${up ? 'above' : 'below'} the average of ${format(Math.round(avg.value))} across the last ${z.usablePoints} complete periods.` +
        recordClause +
        ` This measures how unusual the value is, not why it moved.`,
      classification: 'DERIVED',
      severity,
      confidence: deriveConfidence(
        metric === 'revenueCents' ? input.metrics.revenueCoverage : 1,
        z.usablePoints,
        MIN_SERIES_POINTS,
      ),
      primaryMetric: metric === 'revenueCents' ? 'revenue' : 'totalCalls',
      currentValue: current,
      comparisonValue: Math.round(avg.value),
      absoluteChange: Math.round(delta),
      percentageChange: avg.value === 0 ? null : delta / Math.abs(avg.value),
      evidence,
      limitations: [
        `Measured against ${z.usablePoints} complete prior periods. A short series makes the "normal range" itself uncertain.`,
        ...liveLimitation(input),
      ],
      unknowns: [
        'Why the value moved. Loop can establish that it is outside the normal range, not what put it there.',
        'Whether an external factor (seasonality, a campaign change, a provider-side change) explains it — none of those are exposed by CallGrid.',
      ],
      recommendedReview: `Compare the ${DIMS.map((d) => DIM_NOUN[d].one).join(', ')} mix for this period against the preceding periods to see where the difference sits.`,
      actionSafety: 'SAFE_TO_REVIEW',
      ruleId,
      ruleVersion: ANOMALY_RULE_VERSION,
    },
    input,
  );
}

/**
 * An entity that was present in EVERY observed prior period and is absent now.
 *
 * The "every period" bar is deliberate. An entity that appears intermittently
 * going quiet is its normal behaviour, and flagging it would train an operator to
 * ignore the whole section.
 */
function disappearanceFindings(input: AnomalyInput, dim: AnomalyDimension): CallGridFinding[] {
  const series = input.history;
  if (series.points.length < MIN_SERIES_POINTS) return [];

  // Keys are namespaced by dimension in the series, so a buyer id can never be
  // mistaken for a source id with the same value.
  const present = new Set(input.dimensions[dim].map((r) => historyEntityKey(dim, r.key)));
  const prefix = `${dim}::`;
  const out: CallGridFinding[] = [];

  const candidates = new Set<string>();
  for (const p of series.points) {
    for (const key of Object.keys(p.entityRevenueCents)) {
      if (key.startsWith(prefix)) candidates.add(key);
    }
  }

  for (const namespaced of candidates) {
    if (present.has(namespaced)) continue;
    const key = namespaced.slice(prefix.length);
    const revenues = entitySeries(series, namespaced);
    const usable = revenues.filter((v): v is number => v !== null && v > 0);
    // Must have been present in EVERY observed period.
    if (usable.length !== series.points.length) continue;

    const avg = usable.reduce((s, v) => s + v, 0) / usable.length;
    if (avg < MONEY_FLOOR) continue;

    const label = labelFor(series, namespaced) ?? key;
    const noun = DIM_NOUN[dim];
    const calls = entityCallSeries(series, namespaced);
    const avgCalls = calls.reduce((s, v) => s + v, 0) / calls.length;

    out.push(
      buildFinding(
        {
          id: `anomaly-${dim}-absent-${key}`,
          findingType: 'ANOMALY',
          title: `${label} recorded no activity this period`,
          plainLanguageSummary:
            `${label} produced revenue in all ${series.points.length} of the last complete periods, averaging ` +
            `${money(Math.round(avg))} and ${Math.round(avgCalls)} calls, and recorded nothing in ${input.windowLabel.toLowerCase()}. ` +
            `This is an observation of absence — Loop cannot tell whether the ${noun.one} is paused, capped, rerouted, or simply had no matching traffic.`,
          classification: 'DERIVED',
          severity: avg >= MONEY_FLOOR * 8 ? 'HIGH' : 'NOTABLE',
          confidence: deriveConfidence(1, series.points.length, MIN_SERIES_POINTS),
          primaryMetric: 'revenue',
          currentValue: 0,
          comparisonValue: Math.round(avg),
          absoluteChange: -Math.round(avg),
          percentageChange: -1,
          affectedEntities: [
            {
              entityType: noun.entity,
              entityId: key,
              entityName: label,
              // Absence measured across a fully-read window is a proven zero, not
              // missing data — the distinction the rest of this platform depends on.
              currentValue: 0,
              comparisonValue: Math.round(avg),
              absoluteChange: -Math.round(avg),
              contributionToChange: null,
              currentShare: 0,
              comparisonShare: null,
              currentRank: null,
              comparisonRank: null,
            },
          ],
          evidence: [
            {
              metricKey: 'revenue',
              entityType: noun.entity,
              entityId: key,
              entityName: label,
              window: `${series.points.length} complete prior periods`,
              derivedValue: Math.round(avg),
              formula: 'mean(entity revenue) over complete prior periods',
              formulaVersion: ANOMALY_RULE_VERSION,
              classification: 'DERIVED',
              notes: `Present with revenue in ${usable.length} of ${series.points.length} prior periods.`,
            },
            {
              metricKey: 'revenue',
              entityType: noun.entity,
              entityId: key,
              entityName: label,
              window: input.windowLabel,
              normalizedValue: 0,
              classification: 'VERIFIED',
              notes: 'The whole window was read and this entity did not appear, so its absence is a measured zero rather than missing data.',
            },
          ],
          limitations: [
            `Based on ${series.points.length} complete prior periods.`,
            ...liveLimitation(input),
          ],
          unknowns: [
            `Why the ${noun.one} is absent. CallGrid exposes no cap state, schedule, pause flag or routing decision, so none of those can be confirmed or ruled out.`,
          ],
          recommendedReview: `Check whether ${label} is still active and whether its associated campaigns changed.`,
          actionTarget: key,
          actionSafety: 'SAFE_TO_REVIEW',
          ruleId: 'anomaly-entity-disappeared',
          ruleVersion: ANOMALY_RULE_VERSION,
        },
        input,
      ),
    );
  }

  // Strongest first, and bounded — a page listing twenty absences prioritizes nothing.
  return out
    .sort((a, b) => Math.abs(b.absoluteChange ?? 0) - Math.abs(a.absoluteChange ?? 0))
    .slice(0, 3);
}

function labelFor(series: HistorySeries, key: string): string | null {
  for (const p of series.points) {
    const label = p.entityLabels?.[key];
    if (label) return label;
  }
  return null;
}

function oscillationFinding(input: AnomalyInput): CallGridFinding | null {
  const series = seriesOf(input.history, 'revenueCents');
  const flips = oscillations(series);
  if (flips.value === null || flips.value < OSCILLATION_FLIPS) return null;

  return buildFinding(
    {
      id: 'anomaly-oscillation',
      findingType: 'ANOMALY',
      title: 'Revenue is unstable rather than trending',
      plainLanguageSummary:
        `Revenue reversed direction ${flips.value} times across the last ${flips.usablePoints} complete periods. ` +
        `A period-over-period change is therefore a weak signal for this business: the movement is oscillation, not a trend.`,
      classification: 'DERIVED',
      severity: 'NOTABLE',
      confidence: deriveConfidence(1, flips.usablePoints, MIN_SERIES_POINTS),
      primaryMetric: 'revenue',
      currentValue: flips.value,
      evidence: [
        {
          metricKey: 'revenue',
          entityType: 'window',
          window: `${flips.usablePoints} complete prior periods`,
          derivedValue: flips.value,
          formula: 'count(direction changes in period-over-period revenue)',
          formulaVersion: ANOMALY_RULE_VERSION,
          classification: 'DERIVED',
          notes: 'Counted over consecutive complete periods carrying a revenue value.',
        },
      ],
      limitations: [
        `Based on ${flips.usablePoints} complete prior periods.`,
        ...liveLimitation(input),
      ],
      unknowns: [
        'What drives the instability. Loop can measure that revenue reverses often; the cause is not exposed.',
      ],
      recommendedReview: 'Evaluate this period against the multi-period range rather than against the single prior period.',
      actionSafety: 'SAFE_TO_REVIEW',
      ruleId: 'anomaly-oscillation',
      ruleVersion: ANOMALY_RULE_VERSION,
    },
    input,
  );
}

// --- Two-point divergence rules -----------------------------------------------

function divergenceFinding(input: AnomalyInput): CallGridFinding | null {
  const cmp = input.comparison;
  if (!cmp) return null;
  const rev = input.metrics.revenueCents;
  const revPrior = cmp.revenueCents;
  const calls = input.metrics.totalCalls;
  const callsPrior = cmp.totalCalls;
  if (rev === null || revPrior === null || calls === null || callsPrior === null) return null;
  if (revPrior === 0 || callsPrior === 0) return null;
  if ((callsPrior + calls) < 20) return null;

  const revChange = (rev - revPrior) / Math.abs(revPrior);
  const callChange = (calls - callsPrior) / Math.abs(callsPrior);
  // Same direction is not divergence.
  if (revChange === 0 || callChange === 0) return null;
  if (Math.sign(revChange) === Math.sign(callChange)) return null;
  if (Math.abs(revChange) < 0.15 && Math.abs(callChange) < 0.15) return null;
  if (Math.abs(rev - revPrior) < MONEY_FLOOR) return null;

  const revUp = revChange > 0;
  const severity: Severity =
    Math.abs(revChange) >= 0.3 && Math.abs(callChange) >= 0.3 ? 'HIGH' : 'NOTABLE';

  return buildFinding(
    {
      id: 'anomaly-divergence',
      findingType: 'ANOMALY',
      title: revUp
        ? 'Revenue rose while call volume fell'
        : 'Call volume rose while revenue fell',
      plainLanguageSummary:
        `Revenue ${revUp ? 'increased' : 'decreased'} ${Math.abs(Math.round(revChange * 100))}% while total calls ` +
        `${callChange > 0 ? 'increased' : 'decreased'} ${Math.abs(Math.round(callChange * 100))}%. ` +
        `The value per call therefore moved: this is a value change, not a traffic change. ` +
        `Loop cannot determine whether pricing, buyer mix, or call quality produced it.`,
      classification: 'DERIVED',
      severity,
      confidence: deriveConfidence(input.metrics.revenueCoverage, calls, 20),
      primaryMetric: 'revenue',
      currentValue: rev,
      comparisonValue: revPrior,
      absoluteChange: rev - revPrior,
      percentageChange: revChange,
      evidence: [
        {
          metricKey: 'revenue', entityType: 'window', window: input.windowLabel,
          normalizedValue: rev, classification: 'VERIFIED',
          completeness: input.metrics.revenueCoverage,
        },
        {
          metricKey: 'revenue', entityType: 'window',
          window: input.comparisonLabel ?? 'the comparison period',
          normalizedValue: revPrior, classification: 'VERIFIED',
          completeness: cmp.revenueCoverage,
        },
        {
          metricKey: 'totalCalls', entityType: 'window', window: input.windowLabel,
          normalizedValue: calls, classification: 'VERIFIED',
        },
        {
          metricKey: 'totalCalls', entityType: 'window',
          window: input.comparisonLabel ?? 'the comparison period',
          normalizedValue: callsPrior, classification: 'VERIFIED',
        },
      ],
      limitations: [
        input.history.points.length === 0 ? NO_SERIES_LIMITATION : `A historical series of ${input.history.points.length} periods is available for context.`,
        ...liveLimitation(input),
      ],
      unknowns: [
        'What changed the value per call. Pricing, buyer mix and call quality are not separable from the fields CallGrid exposes.',
      ],
      recommendedReview: 'Compare revenue per billable call by buyer across the two periods to see which buyers moved.',
      actionSafety: 'SAFE_TO_REVIEW',
      ruleId: 'anomaly-divergence',
      ruleVersion: ANOMALY_RULE_VERSION,
    },
    input,
  );
}

function profitDivergenceFinding(input: AnomalyInput): CallGridFinding | null {
  const cmp = input.comparison;
  if (!cmp) return null;
  const rev = input.metrics.revenueCents;
  const revPrior = cmp.revenueCents;
  const profit = input.metrics.profitCents;
  const profitPrior = cmp.profitCents;
  if (rev === null || revPrior === null || profit === null || profitPrior === null) return null;
  if (revPrior === 0 || profitPrior === 0) return null;

  // Profit over partial payout/cost coverage OVERSTATES margin — never build a
  // divergence claim on it.
  const coverage = input.metrics.profitCoverage;
  if (coverage !== null && coverage < 0.5) return null;

  const revChange = (rev - revPrior) / Math.abs(revPrior);
  const profitChange = (profit - profitPrior) / Math.abs(profitPrior);
  if (Math.sign(revChange) === Math.sign(profitChange)) return null;
  if (Math.abs(profitChange) < 0.15) return null;
  if (Math.abs(profit - profitPrior) < MONEY_FLOOR) return null;

  const profitFell = profitChange < 0;
  return buildFinding(
    {
      id: 'anomaly-profit-divergence',
      findingType: 'ANOMALY',
      title: profitFell ? 'Profit fell while revenue rose' : 'Profit rose while revenue fell',
      plainLanguageSummary:
        `Revenue ${revChange > 0 ? 'increased' : 'decreased'} ${Math.abs(Math.round(revChange * 100))}% while profit ` +
        `${profitFell ? 'decreased' : 'increased'} ${Math.abs(Math.round(profitChange * 100))}%. ` +
        `The cost of that revenue moved in the opposite direction to the revenue itself.`,
      classification: 'DERIVED',
      severity: profitFell ? 'HIGH' : 'NOTABLE',
      confidence: deriveConfidence(coverage, input.metrics.totalCalls ?? 0, 10),
      primaryMetric: 'profit',
      currentValue: profit,
      comparisonValue: profitPrior,
      absoluteChange: profit - profitPrior,
      percentageChange: profitChange,
      evidence: [
        {
          metricKey: 'profit', entityType: 'window', window: input.windowLabel,
          normalizedValue: profit,
          formula: 'sum(revenueCents) - sum(payoutCents) - sum(costCents)',
          formulaVersion: 'v1',
          classification: 'DERIVED', completeness: coverage,
        },
        {
          metricKey: 'profit', entityType: 'window',
          window: input.comparisonLabel ?? 'the comparison period',
          normalizedValue: profitPrior, classification: 'DERIVED',
          completeness: cmp.profitCoverage,
        },
        {
          metricKey: 'revenue', entityType: 'window', window: input.windowLabel,
          normalizedValue: rev, classification: 'VERIFIED',
          completeness: input.metrics.revenueCoverage,
        },
      ],
      limitations: [
        'Profit is only as complete as its weakest input; partial payout or cost coverage overstates it.',
        ...liveLimitation(input),
      ],
      unknowns: [
        'Which cost component moved. CallGrid reports payout and cost per call but exposes nothing about why either changed.',
      ],
      recommendedReview: 'Compare payout and cost per billable call by buyer across the two periods.',
      actionSafety: 'SAFE_TO_REVIEW',
      ruleId: 'anomaly-profit-divergence',
      ruleVersion: ANOMALY_RULE_VERSION,
    },
    input,
  );
}

/**
 * Every anomaly for the selected period.
 *
 * Distribution rules stay silent without a series rather than degrading to a
 * two-point comparison wearing an anomaly's label.
 */
export function detectAnomalies(input: AnomalyInput): CallGridFinding[] {
  const out: CallGridFinding[] = [];
  if (!input.metrics.available) return out;

  const hasSeries = input.history.points.length >= MIN_SERIES_POINTS;

  if (hasSeries) {
    const rev = outlierFinding(input, 'revenueCents', 'anomaly-revenue-outlier', 'Revenue', MONEY_FLOOR, money);
    if (rev) out.push(rev);
    const vol = outlierFinding(input, 'totalCalls', 'anomaly-volume-outlier', 'Call volume', 20, (n) =>
      n === null ? 'an unknown number' : n.toLocaleString('en-US'),
    );
    if (vol) out.push(vol);

    const osc = oscillationFinding(input);
    if (osc) out.push(osc);

    for (const dim of DIMS) out.push(...disappearanceFindings(input, dim));
  }

  const div = divergenceFinding(input);
  if (div) out.push(div);
  const profitDiv = profitDivergenceFinding(input);
  if (profitDiv) out.push(profitDiv);

  return out;
}

/** What the anomaly layer itself could not determine, for the page's unknowns section. */
export function anomalyUnknowns(input: AnomalyInput): string[] {
  if (input.history.points.length >= MIN_SERIES_POINTS) return [];
  if (input.includesLiveData) {
    return [
      'Whether this period is unusual. A historical series is only built from complete periods, and the selected period is still in progress.',
    ];
  }
  return [
    `Whether this period is unusual. Loop needs at least ${MIN_SERIES_POINTS} complete prior periods to establish a normal range, and ${input.history.points.length} were available.`,
  ];
}

export type { ActionSafety };
