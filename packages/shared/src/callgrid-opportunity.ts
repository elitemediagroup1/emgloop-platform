// The Opportunity engine.
//
// WHY OPPORTUNITIES ARE HARDER THAN RISKS, AND WHY THIS FILE IS CAUTIOUS
// A risk is an observation: "one buyer holds 71% of revenue" is a fact about data
// Loop has. An opportunity is a claim about a COUNTERFACTUAL — what would happen
// if something changed — and Loop cannot see the things that determine that:
// buyer caps, contracted volumes, vendor capacity, demand elasticity, campaign
// budgets, or whether a source's traffic is interchangeable with another's.
//
// So this engine never forecasts upside. It reports three things instead:
//
//   1. WHAT IS AT STAKE — an amount that is measured, not modelled. "$4,120 of
//      revenue sits with a single buyer" is arithmetic over observed rows.
//   2. THE OBSERVED GAP — the arithmetic difference between an entity's actual
//      performance and the period's own average, labelled as arithmetic. Never
//      "you would earn $X"; always "at the period's average rate this volume
//      corresponds to N billable calls; it produced M".
//   3. WHAT REMAINS UNKNOWN — always including the reason the gap may not be
//      closable, because a gap is not a promise.
//
// `estimatedImpactCents` is therefore EXPOSURE OR GAP, never predicted gain, and
// the field is named on the surface as such. A number presented as upside that is
// really arithmetic is the most expensive kind of dishonesty a tool like this can
// commit: someone reallocates budget against it.

import {
  deriveConfidence,
  type AffectedEntity,
  type CallGridFinding,
  type Severity,
  type SignificanceRule,
} from './callgrid-intelligence';
import { buildFinding, type EvidenceSpec, type FindingContext } from './callgrid-finding-builder';
import { MIN_SERIES_POINTS, entitySeries, historyEntityKey, mean, type HistorySeries } from './callgrid-history';
import type { MarketplaceRisk } from './callgrid-risk';

export const OPPORTUNITY_RULE_VERSION = 'v1';

/** Minimum money at stake before an opportunity is worth an operator's time ($500). */
const MONEY_FLOOR = 50_000;
/** Concentration share above which dependency is worth surfacing as an opportunity to diversify. */
const CONCENTRATION_FLOOR = 0.45;
/** How far below the period's average billable rate a source must sit to show a gap. */
const EFFICIENCY_GAP = 0.15;

export const OPPORTUNITY_SIGNIFICANCE_RULES: readonly SignificanceRule[] = [
  {
    ruleId: 'opportunity-diversification',
    version: OPPORTUNITY_RULE_VERSION,
    metric: 'revenueShare',
    minimumDataRequirements: 'Measured revenue for at least two entities in the dimension.',
    absoluteThreshold: MONEY_FLOOR,
    percentageThreshold: CONCENTRATION_FLOOR,
    minimumVolume: 0,
    baselineWindow: 'comparison_window',
    severityLogic: 'NOTABLE above 45% share, HIGH above 65%.',
    suppressionConditions: [
      'Window revenue unknown — there is no denominator.',
      'Fewer than two measured entities, which is a data limit rather than a concentration finding.',
    ],
    explanation: 'Dependency is the one opportunity Loop can size honestly: the amount at stake is measured, even though the benefit of reducing it is not.',
  },
  {
    ruleId: 'opportunity-efficiency-gap',
    version: OPPORTUNITY_RULE_VERSION,
    metric: 'billableRate',
    minimumDataRequirements: 'A source with at least 30 calls and a known period-wide billable rate.',
    absoluteThreshold: null,
    percentageThreshold: EFFICIENCY_GAP,
    minimumVolume: 30,
    baselineWindow: 'comparison_window',
    severityLogic: 'NOTABLE always — an efficiency gap is a question, not a verdict.',
    suppressionConditions: [
      'Fewer than 30 calls, where a rate is noise.',
      'The period-wide billable rate is unknown.',
    ],
    explanation: 'A source converting far below the period average is the clearest measurable gap in the data. Whether it can be closed depends on traffic mix, which is not exposed.',
  },
  {
    ruleId: 'opportunity-returning-entity',
    version: OPPORTUNITY_RULE_VERSION,
    metric: 'revenue',
    minimumDataRequirements: `An entity absent or near-zero across the middle of a ${MIN_SERIES_POINTS}+ period series and materially present now.`,
    absoluteThreshold: MONEY_FLOOR,
    percentageThreshold: null,
    minimumVolume: 0,
    baselineWindow: 'historical_series',
    severityLogic: 'INFORMATIONAL — a return is context an operator should know, not a problem.',
    suppressionConditions: ['No historical series.', 'The entity never went quiet in the observed series.'],
    explanation: 'A dormant entity resuming is materially different from a new one arriving, and the difference changes who should be contacted.',
  },
  {
    ruleId: 'opportunity-value-improving',
    version: OPPORTUNITY_RULE_VERSION,
    metric: 'revenuePerBillableCall',
    minimumDataRequirements: 'Known revenue and billable calls for the entity in both the selected and comparison periods.',
    absoluteThreshold: MONEY_FLOOR,
    percentageThreshold: 0.15,
    minimumVolume: 10,
    baselineWindow: 'comparison_window',
    severityLogic: 'INFORMATIONAL — improving value is good news and must not outrank a problem.',
    suppressionConditions: ['Either period lacks billable calls.', 'Revenue unknown in either period.'],
    explanation: 'An entity whose value per call is rising while volume holds is worth understanding before anything is changed elsewhere.',
  },
];

export type OpportunityDimension = 'buyers' | 'vendors' | 'sources' | 'campaigns';

const NOUN: Record<OpportunityDimension, { one: string; many: string; entity: AffectedEntity['entityType'] }> = {
  buyers: { one: 'buyer', many: 'buyers', entity: 'buyer' },
  vendors: { one: 'vendor', many: 'vendors', entity: 'vendor' },
  sources: { one: 'source', many: 'sources', entity: 'source' },
  campaigns: { one: 'campaign', many: 'campaigns', entity: 'campaign' },
};

export interface OpportunityRow {
  key: string;
  label: string;
  calls: number;
  monetized: number;
  revenueCents: number | null;
}

export interface OpportunityInput extends FindingContext {
  includesLiveData: boolean;
  windowRevenueCents: number | null;
  totalCalls: number | null;
  billableCalls: number | null;
  revenueCoverage: number | null;
  dimensions: Record<OpportunityDimension, readonly OpportunityRow[]>;
  comparisonByKey: Record<OpportunityDimension, ReadonlyMap<string, OpportunityRow>>;
  history: HistorySeries;
  risk: MarketplaceRisk;
}

/**
 * An opportunity, with its money framed honestly.
 *
 * `estimatedImpactCents` is EXPOSURE (what is at stake) or a measured GAP —
 * never a predicted gain. `impactBasis` names which, and the surface must render
 * that label rather than calling it upside.
 */
export interface Opportunity {
  finding: CallGridFinding;
  estimatedImpactCents: number | null;
  impactBasis: 'measured_exposure' | 'measured_gap' | 'none';
  /** Plain-language label for the money, e.g. "Revenue currently dependent on this buyer". */
  impactLabel: string;
  /** Operational lever this concerns — named, never commanded. */
  lever: string;
}

function money(cents: number | null): string {
  if (cents === null) return 'an unknown amount';
  return (cents < 0 ? '-' : '') + '$' + Math.round(Math.abs(cents) / 100).toLocaleString('en-US');
}

function liveLimitation(input: OpportunityInput): string[] {
  return input.includesLiveData
    ? ['The selected period is still in progress, so the amounts here will change before it closes.']
    : [];
}

const NOT_A_FORECAST =
  'This amount is measured from observed rows. It is what is currently at stake, NOT a prediction of what would be gained by changing anything.';

function affected(dim: OpportunityDimension, row: OpportunityRow, share: number | null): AffectedEntity[] {
  return [{
    entityType: NOUN[dim].entity,
    entityId: row.key,
    entityName: row.label,
    currentValue: row.revenueCents,
    comparisonValue: null,
    absoluteChange: null,
    contributionToChange: null,
    currentShare: share,
    comparisonShare: null,
    currentRank: null,
    comparisonRank: null,
  }];
}

/** Dependency on one entity — the one opportunity whose money can be sized honestly. */
function diversificationOpportunity(
  input: OpportunityInput,
  dim: OpportunityDimension,
): Opportunity | null {
  const windowRevenue = input.windowRevenueCents;
  if (windowRevenue === null || windowRevenue <= 0) return null;

  const measured = input.dimensions[dim].filter(
    (r): r is OpportunityRow & { revenueCents: number } => r.revenueCents !== null && r.revenueCents > 0,
  );
  // One measured entity is a data limit, not a concentration finding.
  if (measured.length < 2) return null;

  const total = measured.reduce((s, r) => s + r.revenueCents, 0);
  if (total <= 0) return null;
  const top = measured.reduce((a, b) => (b.revenueCents > a.revenueCents ? b : a));
  const share = top.revenueCents / total;
  if (share < CONCENTRATION_FLOOR) return null;
  if (top.revenueCents < MONEY_FLOOR) return null;

  const noun = NOUN[dim];
  const severity: Severity = share >= 0.65 ? 'HIGH' : 'NOTABLE';

  const finding = buildFinding(
    {
      id: `opportunity-diversification-${dim}`,
      findingType: 'OPPORTUNITY',
      title: `${Math.round(share * 100)}% of ${noun.many} revenue depends on ${top.label}`,
      plainLanguageSummary:
        `${money(top.revenueCents)} of the ${money(total)} attributed to ${noun.many} this period came from ${top.label}, ` +
        `which is ${Math.round(share * 100)}% of the measured total across ${measured.length} ${noun.many}. ` +
        `Reducing that dependency is the clearest structural improvement available, though Loop cannot size the benefit — ` +
        `whether the volume could move elsewhere depends on capacity and demand that CallGrid does not expose.`,
      classification: 'DERIVED',
      severity,
      confidence: deriveConfidence(input.revenueCoverage, measured.length, 3),
      primaryMetric: 'revenueShare',
      currentValue: Math.round(share * 1000) / 1000,
      affectedEntities: affected(dim, top, share),
      evidence: [
        {
          metricKey: 'revenue', entityType: noun.entity, entityId: top.key, entityName: top.label,
          window: input.windowLabel, normalizedValue: top.revenueCents,
          classification: 'VERIFIED', completeness: input.revenueCoverage,
          notes: `${top.calls} calls, ${top.monetized} billable.`,
        },
        {
          metricKey: 'revenueShare', entityType: noun.entity, entityId: top.key, entityName: top.label,
          window: input.windowLabel, derivedValue: Math.round(share * 1000) / 1000,
          formula: 'entity revenue / summed revenue of measured entities in the dimension',
          formulaVersion: OPPORTUNITY_RULE_VERSION, classification: 'DERIVED',
          notes: `Unpriced ${noun.many} are excluded from both numerator and denominator rather than counted as zero.`,
        },
      ],
      limitations: [
        `Computed across the ${measured.length} ${noun.many} that carried a measured revenue value.`,
        ...liveLimitation(input),
      ],
      unknowns: [
        `Whether this dependency is intentional. Loop cannot see contracts, caps or commercial arrangements.`,
        `Whether the volume could be absorbed elsewhere. Capacity and demand are not exposed at ${noun.one} grain, so no benefit can be estimated.`,
      ],
      recommendedReview: `Review how much of the ${noun.one} mix depends on ${top.label}, and evaluate whether the next-largest ${noun.many} have headroom.`,
      recommendedActionType: 'dependency-review',
      actionTarget: top.key,
      actionSafety: 'SAFE_TO_REVIEW',
      ruleId: 'opportunity-diversification',
      ruleVersion: OPPORTUNITY_RULE_VERSION,
    },
    input,
  );

  return {
    finding,
    estimatedImpactCents: top.revenueCents,
    impactBasis: 'measured_exposure',
    impactLabel: `Revenue currently dependent on ${top.label}`,
    lever: `${noun.one.replace(/^./, (c) => c.toUpperCase())} mix and traffic allocation`,
  };
}

/**
 * A source converting far below the period's own average.
 *
 * The gap is stated as arithmetic against the period average, explicitly not as a
 * forecast — traffic is not necessarily interchangeable, and that is said.
 */
function efficiencyGapOpportunity(input: OpportunityInput): Opportunity | null {
  const total = input.totalCalls;
  const billable = input.billableCalls;
  if (total === null || billable === null || total <= 0) return null;
  const periodRate = billable / total;
  if (periodRate <= 0) return null;

  const candidates = input.dimensions.sources.filter((r) => r.calls >= 30);
  if (candidates.length === 0) return null;

  // The worst converter with material volume.
  const worst = candidates
    .map((r) => ({ row: r, rate: r.calls > 0 ? r.monetized / r.calls : 0 }))
    .sort((a, b) => a.rate - b.rate)[0];
  if (!worst) return null;

  const gapRate = periodRate - worst.rate;
  if (gapRate < EFFICIENCY_GAP) return null;

  const impliedBillable = Math.round(worst.row.calls * periodRate);
  const shortfallCalls = impliedBillable - worst.row.monetized;
  if (shortfallCalls <= 0) return null;

  // Money is only attached when there is a measured revenue-per-billable-call.
  const revenuePerBillable = billable > 0 && input.windowRevenueCents !== null
    ? input.windowRevenueCents / billable
    : null;
  const gapCents = revenuePerBillable === null ? null : Math.round(shortfallCalls * revenuePerBillable);

  const finding = buildFinding(
    {
      id: 'opportunity-efficiency-gap-sources',
      findingType: 'OPPORTUNITY',
      title: `${worst.row.label} converts well below the period average`,
      plainLanguageSummary:
        `${worst.row.label} sent ${worst.row.calls.toLocaleString('en-US')} calls and ${worst.row.monetized.toLocaleString('en-US')} were billable ` +
        `(${Math.round(worst.rate * 100)}%), against a period-wide rate of ${Math.round(periodRate * 100)}%. ` +
        `At the period rate that same volume corresponds to ${impliedBillable.toLocaleString('en-US')} billable calls — an arithmetic difference of ` +
        `${shortfallCalls.toLocaleString('en-US')}. This is a gap in the numbers, not a promise: traffic from different sources is not necessarily interchangeable.`,
      classification: 'DERIVED',
      severity: 'NOTABLE',
      confidence: deriveConfidence(input.revenueCoverage, worst.row.calls, 30),
      primaryMetric: 'billableRate',
      currentValue: Math.round(worst.rate * 1000) / 1000,
      comparisonValue: Math.round(periodRate * 1000) / 1000,
      affectedEntities: affected('sources', worst.row, null),
      evidence: [
        {
          metricKey: 'billableRate', entityType: 'source', entityId: worst.row.key, entityName: worst.row.label,
          window: input.windowLabel, derivedValue: Math.round(worst.rate * 1000) / 1000,
          formula: 'billable calls / total calls, for this source',
          formulaVersion: OPPORTUNITY_RULE_VERSION, classification: 'DERIVED',
        },
        {
          metricKey: 'billableRate', entityType: 'window', window: input.windowLabel,
          derivedValue: Math.round(periodRate * 1000) / 1000,
          formula: 'billable calls / total calls, across the period',
          formulaVersion: OPPORTUNITY_RULE_VERSION, classification: 'DERIVED',
          notes: 'The benchmark is the period itself, not an external target.',
        },
      ],
      limitations: [
        'Billable rate is an efficiency measure. CallGrid exposes nothing that would make it a measure of call quality.',
        'The implied figure applies the period average to this source\'s volume. It is arithmetic, not a projection.',
        ...liveLimitation(input),
      ],
      unknowns: [
        'Whether this source\'s traffic could convert at the period rate at all. Intent, geography and timing are not exposed, and they are exactly what would determine it.',
        'Whether the gap reflects the source or the routing applied to it.',
      ],
      recommendedReview: `Compare ${worst.row.label}'s call detail against a higher-converting source before changing traffic allocation.`,
      recommendedActionType: 'source-efficiency-review',
      actionTarget: worst.row.key,
      actionSafety: 'REQUIRES_HUMAN_JUDGMENT',
      ruleId: 'opportunity-efficiency-gap',
      ruleVersion: OPPORTUNITY_RULE_VERSION,
    },
    input,
  );

  return {
    finding,
    estimatedImpactCents: gapCents,
    impactBasis: gapCents === null ? 'none' : 'measured_gap',
    impactLabel: `Arithmetic gap at the period's own billable rate`,
    lever: 'Source traffic allocation',
  };
}

/** An entity that went quiet in the series and is materially back. */
function returningEntityOpportunity(
  input: OpportunityInput,
  dim: OpportunityDimension,
): Opportunity | null {
  if (input.history.points.length < MIN_SERIES_POINTS) return null;

  for (const row of input.dimensions[dim]) {
    if (row.revenueCents === null || row.revenueCents < MONEY_FLOOR) continue;
    const key = historyEntityKey(dim, row.key);
    const series = entitySeries(input.history, key);
    // Most-recent-first. It must have been quiet in the recent past but present earlier.
    const recent = series.slice(0, Math.max(1, Math.floor(series.length / 2)));
    const older = series.slice(Math.max(1, Math.floor(series.length / 2)));
    const wasQuiet = recent.every((v) => v === null || v === 0);
    const wasPresent = older.filter((v) => v !== null && v > 0).length >= 2;
    if (!wasQuiet || !wasPresent) continue;

    const priorAvg = mean(older);
    const noun = NOUN[dim];

    const finding = buildFinding(
      {
        id: `opportunity-returning-${dim}-${row.key}`,
        findingType: 'OPPORTUNITY',
        title: `${row.label} has resumed activity`,
        plainLanguageSummary:
          `${row.label} recorded no revenue across the ${recent.length} most recent complete periods and produced ` +
          `${money(row.revenueCents)} in ${input.windowLabel.toLowerCase()}, having previously averaged ` +
          `${money(priorAvg.value === null ? null : Math.round(priorAvg.value))}. A ${noun.one} resuming is a different situation from a new one arriving, ` +
          `and it changes who is worth contacting.`,
        classification: 'DERIVED',
        severity: 'INFORMATIONAL',
        confidence: deriveConfidence(1, input.history.points.length, MIN_SERIES_POINTS),
        primaryMetric: 'revenue',
        currentValue: row.revenueCents,
        comparisonValue: priorAvg.value === null ? null : Math.round(priorAvg.value),
        affectedEntities: affected(dim, row, null),
        evidence: [
          {
            metricKey: 'revenue', entityType: noun.entity, entityId: row.key, entityName: row.label,
            window: input.windowLabel, normalizedValue: row.revenueCents, classification: 'VERIFIED',
          },
          {
            metricKey: 'revenue', entityType: noun.entity, entityId: row.key, entityName: row.label,
            window: `${recent.length} most recent complete prior periods`,
            normalizedValue: 0, classification: 'VERIFIED',
            notes: 'Those windows were read in full, so the absence is a measured zero rather than missing data.',
          },
        ],
        limitations: [
          `Based on ${input.history.points.length} complete prior periods; activity before them is not visible.`,
          ...liveLimitation(input),
        ],
        unknowns: [
          `Why the ${noun.one} resumed. CallGrid exposes no pause state, cap or schedule, so none of those can be confirmed.`,
        ],
        recommendedReview: `Contact ${row.label} to confirm what changed, and check whether the campaigns feeding them are still configured as before.`,
        recommendedActionType: 'relationship-review',
        actionTarget: row.key,
        actionSafety: 'SAFE_TO_REVIEW',
        ruleId: 'opportunity-returning-entity',
        ruleVersion: OPPORTUNITY_RULE_VERSION,
      },
      input,
    );

    return {
      finding,
      estimatedImpactCents: row.revenueCents,
      impactBasis: 'measured_exposure',
      impactLabel: `Revenue recorded this period from ${row.label}`,
      lever: `${noun.one.replace(/^./, (c) => c.toUpperCase())} relationship`,
    };
  }
  return null;
}

/** Value per billable call rising materially against the comparison period. */
function valueImprovingOpportunity(
  input: OpportunityInput,
  dim: OpportunityDimension,
): Opportunity | null {
  for (const row of input.dimensions[dim]) {
    if (row.revenueCents === null || row.monetized < 10) continue;
    const prior = input.comparisonByKey[dim].get(row.key);
    if (!prior || prior.revenueCents === null || prior.monetized < 10) continue;

    const now = row.revenueCents / row.monetized;
    const before = prior.revenueCents / prior.monetized;
    if (before <= 0) continue;
    const lift = (now - before) / before;
    if (lift < 0.15) continue;
    if (row.revenueCents < MONEY_FLOOR) continue;

    const noun = NOUN[dim];
    const finding = buildFinding(
      {
        id: `opportunity-value-${dim}-${row.key}`,
        findingType: 'OPPORTUNITY',
        title: `${row.label} is producing more value per billable call`,
        plainLanguageSummary:
          `${row.label} earned ${money(Math.round(now))} per billable call this period against ${money(Math.round(before))} in ` +
          `${(input.comparisonLabel ?? 'the comparison period').toLowerCase()}, a rise of ${Math.round(lift * 100)}% on ` +
          `${row.monetized.toLocaleString('en-US')} billable calls. The value side improved rather than the volume side.`,
        classification: 'DERIVED',
        severity: 'INFORMATIONAL',
        confidence: deriveConfidence(input.revenueCoverage, row.monetized, 10),
        primaryMetric: 'revenuePerBillableCall',
        currentValue: Math.round(now),
        comparisonValue: Math.round(before),
        absoluteChange: Math.round(now - before),
        percentageChange: lift,
        affectedEntities: affected(dim, row, null),
        evidence: [
          {
            metricKey: 'revenuePerBillableCall', entityType: noun.entity, entityId: row.key, entityName: row.label,
            window: input.windowLabel, derivedValue: Math.round(now),
            formula: 'entity revenue / entity billable calls',
            formulaVersion: OPPORTUNITY_RULE_VERSION, classification: 'DERIVED',
          },
          {
            metricKey: 'revenuePerBillableCall', entityType: noun.entity, entityId: row.key, entityName: row.label,
            window: input.comparisonLabel ?? 'the comparison period', derivedValue: Math.round(before),
            formula: 'entity revenue / entity billable calls',
            formulaVersion: OPPORTUNITY_RULE_VERSION, classification: 'DERIVED',
          },
        ],
        limitations: [
          'Both periods must carry revenue and billable counts for this entity; entities missing either are skipped.',
          ...liveLimitation(input),
        ],
        unknowns: [
          'What raised the value per call. Pricing, buyer mix and call duration are not separable from the fields CallGrid exposes.',
        ],
        recommendedReview: `Investigate what changed for ${row.label} and confirm whether it is repeatable before adjusting anything else.`,
        recommendedActionType: 'value-review',
        actionTarget: row.key,
        actionSafety: 'SAFE_TO_REVIEW',
        ruleId: 'opportunity-value-improving',
        ruleVersion: OPPORTUNITY_RULE_VERSION,
      },
      input,
    );

    return {
      finding,
      estimatedImpactCents: row.revenueCents,
      impactBasis: 'measured_exposure',
      impactLabel: `Revenue on the improving ${noun.one}`,
      lever: `${noun.one.replace(/^./, (c) => c.toUpperCase())} value per call`,
    };
  }
  return null;
}

/**
 * Every opportunity for the selected period, most material first.
 *
 * Ordering is by measured money where it exists, then by severity — a dependency
 * worth $40,000 outranks one worth $600 regardless of which fired first.
 */
export function findOpportunities(input: OpportunityInput): Opportunity[] {
  const out: Opportunity[] = [];
  if (!input.windowRevenueCents && input.windowRevenueCents !== 0) {
    // Revenue unknown: only the non-monetary rules can run honestly.
  }

  for (const dim of ['buyers', 'vendors', 'sources', 'campaigns'] as const) {
    const d = diversificationOpportunity(input, dim);
    if (d) out.push(d);
  }

  const eff = efficiencyGapOpportunity(input);
  if (eff) out.push(eff);

  for (const dim of ['buyers', 'vendors', 'sources', 'campaigns'] as const) {
    const r = returningEntityOpportunity(input, dim);
    if (r) out.push(r);
    const v = valueImprovingOpportunity(input, dim);
    if (v) out.push(v);
  }

  return out.sort((a, b) => (b.estimatedImpactCents ?? 0) - (a.estimatedImpactCents ?? 0));
}

/** The unknowns the opportunity layer itself introduces. */
export function opportunityUnknowns(opportunities: readonly Opportunity[]): string[] {
  if (opportunities.length === 0) return [];
  return [
    'The benefit of acting on any opportunity here. Loop measures what is at stake, not what would be gained — buyer caps, vendor capacity, demand and campaign budgets are all invisible to it.',
  ];
}
