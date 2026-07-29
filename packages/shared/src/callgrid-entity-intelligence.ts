// Per-entity intelligence over the historical series.
//
// The two-point rules (contribution, concentration, rank movement, inactivity,
// efficiency) already live in the engine. This module adds only what a
// DISTRIBUTION makes answerable about a single buyer, vendor, source or campaign:
//
//   new high / new low   is this the entity's best or worst period on record?
//   emerging             did it arrive recently and keep producing?
//   dormant              is it fading across periods, rather than merely down once?
//   consistency          is it steady or erratic — which changes what a delta means
//   dominance            is its share of the business rising beyond its own norm?
//
// WHY THESE ARE SEPARATE FROM A DELTA
// "Buyer X is down 20%" and "Buyer X is having its worst period in two months"
// are different claims requiring different evidence, and the second is the one an
// operator actually acts on. A delta against one prior period cannot support it.
//
// LANGUAGE RULES INHERITED AND ENFORCED
//   - Contribution, never causation.
//   - Concentration is dependency, not fault, and never a prediction about a
//     counterparty's intentions.
//   - "Dormant" and "emerging" are OBSERVATIONS of reported activity. CallGrid
//     exposes no cap, schedule, pause flag or roster, so none of those may be
//     implied as the reason.
//   - Recommendations may only ask a person to LOOK. Never to increase traffic,
//     reroute, or change a payout — Loop cannot see the constraints those depend on.

import {
  deriveConfidence,
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
  trendPerPeriod,
  volatility,
  type HistorySeries,
} from './callgrid-history';

export const ENTITY_RULE_VERSION = 'v1';

/** Minimum entity revenue before any of these fire ($250). */
const MONEY_FLOOR = 25_000;
/** Coefficient of variation above which an entity is called erratic rather than steady. */
const ERRATIC_CV = 0.5;
/** Share-of-revenue growth over an entity's own historical average that reads as rising dominance. */
const DOMINANCE_LIFT = 0.1;

export const ENTITY_SIGNIFICANCE_RULES: readonly SignificanceRule[] = [
  {
    ruleId: 'entity-record-period',
    version: ENTITY_RULE_VERSION,
    metric: 'revenue',
    minimumDataRequirements: `The entity carried revenue in at least ${MIN_SERIES_POINTS} complete prior periods.`,
    absoluteThreshold: MONEY_FLOOR,
    percentageThreshold: null,
    minimumVolume: 0,
    baselineWindow: 'historical_series',
    severityLogic: 'NOTABLE for a record low, INFORMATIONAL for a record high — a high is good news and should not outrank a problem.',
    suppressionConditions: ['No historical series.', 'The entity earned less than $250.'],
    explanation: 'A best-or-worst-on-record period is a materially different claim from a percentage delta, and it is the one that prompts action.',
  },
  {
    ruleId: 'entity-emerging',
    version: ENTITY_RULE_VERSION,
    metric: 'revenue',
    minimumDataRequirements: `A series of at least ${MIN_SERIES_POINTS} periods in which the entity is absent from the earliest half and present in the most recent.`,
    absoluteThreshold: MONEY_FLOOR,
    percentageThreshold: null,
    minimumVolume: 0,
    baselineWindow: 'historical_series',
    severityLogic: 'INFORMATIONAL — an emerging entity is context, not a problem.',
    suppressionConditions: ['No historical series.', 'The entity appeared only once.'],
    explanation: 'An entity that arrived recently and kept producing changes how its numbers should be read; a delta would present it as explosive growth from nothing.',
  },
  {
    ruleId: 'entity-dormant',
    version: ENTITY_RULE_VERSION,
    metric: 'revenue',
    minimumDataRequirements: `The entity carried revenue in at least ${MIN_SERIES_POINTS} periods with a sustained negative trend.`,
    absoluteThreshold: MONEY_FLOOR,
    percentageThreshold: null,
    minimumVolume: 0,
    baselineWindow: 'historical_series',
    severityLogic: 'NOTABLE — a sustained fade is more actionable than a single down period.',
    suppressionConditions: ['No historical series.', 'The entity is absent entirely (that is the disappearance rule, not this one).'],
    explanation: 'A fade across periods and a single bad period call for different reviews. Reporting one as the other sends a person to the wrong place.',
  },
  {
    ruleId: 'entity-consistency',
    version: ENTITY_RULE_VERSION,
    metric: 'revenue',
    minimumDataRequirements: `At least ${MIN_SERIES_POINTS} periods carrying revenue for the entity, with a non-zero mean.`,
    absoluteThreshold: MONEY_FLOOR,
    percentageThreshold: null,
    minimumVolume: 0,
    baselineWindow: 'historical_series',
    severityLogic: 'INFORMATIONAL — this qualifies how other findings should be read rather than being a finding about performance.',
    suppressionConditions: ['No historical series.'],
    explanation: 'A 20% move means something different for an entity that swings 50% routinely than for one that never moves more than 5%.',
  },
  {
    ruleId: 'entity-rising-dominance',
    version: ENTITY_RULE_VERSION,
    metric: 'revenueShare',
    minimumDataRequirements: `At least ${MIN_SERIES_POINTS} periods with a known window total and a known entity value.`,
    absoluteThreshold: null,
    percentageThreshold: DOMINANCE_LIFT,
    minimumVolume: 0,
    baselineWindow: 'historical_series',
    severityLogic: 'NOTABLE once the entity holds more than a third of revenue; INFORMATIONAL below.',
    suppressionConditions: ['No historical series.', 'Window revenue unknown in either the selected period or the series.'],
    explanation: 'A rising share is a dependency forming. It describes the shape of the business, never an expectation about the entity.',
  },
];

export type EntityDimension = 'buyers' | 'vendors' | 'sources' | 'campaigns';

const NOUN: Record<EntityDimension, { one: string; many: string; entity: AffectedEntity['entityType'] }> = {
  buyers: { one: 'buyer', many: 'buyers', entity: 'buyer' },
  vendors: { one: 'vendor', many: 'vendors', entity: 'vendor' },
  sources: { one: 'source', many: 'sources', entity: 'source' },
  campaigns: { one: 'campaign', many: 'campaigns', entity: 'campaign' },
};

export interface EntityRow {
  key: string;
  label: string;
  calls: number;
  revenueCents: number | null;
}

export interface EntityIntelligenceInput extends FindingContext {
  includesLiveData: boolean;
  windowRevenueCents: number | null;
  history: HistorySeries;
}

function money(cents: number | null): string {
  if (cents === null) return 'an unknown amount';
  return (cents < 0 ? '-' : '') + '$' + Math.round(Math.abs(cents) / 100).toLocaleString('en-US');
}

function liveLimitation(input: EntityIntelligenceInput): string[] {
  return input.includesLiveData
    ? ['The selected period is still in progress, so this may change before the period closes.']
    : [];
}

function seriesEvidence(
  dim: EntityDimension,
  row: EntityRow,
  periods: number,
  derivedValue: number | null,
  formula: string,
  notes: string,
): EvidenceSpec {
  return {
    metricKey: 'revenue',
    entityType: NOUN[dim].entity,
    entityId: row.key,
    entityName: row.label,
    window: `${periods} complete prior periods`,
    derivedValue,
    formula,
    formulaVersion: ENTITY_RULE_VERSION,
    classification: 'DERIVED',
    notes,
  };
}

function currentEvidence(dim: EntityDimension, row: EntityRow, windowLabel: string): EvidenceSpec {
  return {
    metricKey: 'revenue',
    entityType: NOUN[dim].entity,
    entityId: row.key,
    entityName: row.label,
    window: windowLabel,
    normalizedValue: row.revenueCents,
    classification: 'VERIFIED',
    notes: `${row.calls} calls in the selected period.`,
  };
}

function affected(dim: EntityDimension, row: EntityRow, comparisonValue: number | null): AffectedEntity[] {
  return [{
    entityType: NOUN[dim].entity,
    entityId: row.key,
    entityName: row.label,
    currentValue: row.revenueCents,
    comparisonValue,
    absoluteChange: row.revenueCents !== null && comparisonValue !== null ? row.revenueCents - comparisonValue : null,
    contributionToChange: null,
    currentShare: null,
    comparisonShare: null,
    currentRank: null,
    comparisonRank: null,
  }];
}

/** A record best or worst period for this entity, measured against its own history. */
function recordFinding(
  input: EntityIntelligenceInput,
  dim: EntityDimension,
  row: EntityRow,
): CallGridFinding | null {
  if (row.revenueCents === null || row.revenueCents < MONEY_FLOOR) return null;
  const key = historyEntityKey(dim, row.key);
  const series = entitySeries(input.history, key);
  const { extreme, usablePoints } = extremeVersusSeries(row.revenueCents, series);
  if (extreme === null) return null;

  const avg = mean(series);
  const noun = NOUN[dim];
  const isLow = extreme === 'LOW';

  return buildFinding(
    {
      id: `entity-record-${dim}-${row.key}`,
      findingType: isLow ? 'RISK' : 'OPPORTUNITY',
      title: `${row.label} recorded its ${isLow ? 'lowest' : 'highest'} revenue in ${usablePoints} periods`,
      plainLanguageSummary:
        `${row.label} produced ${money(row.revenueCents)} in ${input.windowLabel.toLowerCase()}, ` +
        `${isLow ? 'below' : 'above'} every one of the last ${usablePoints} complete periods ` +
        `(averaging ${money(avg.value === null ? null : Math.round(avg.value))}). ` +
        `This states where the period sits in the ${noun.one}'s own range, not what moved it.`,
      classification: 'DERIVED',
      // A record high is good news and must not outrank a problem in the brief.
      severity: (isLow ? 'NOTABLE' : 'INFORMATIONAL') as Severity,
      confidence: deriveConfidence(1, usablePoints, MIN_SERIES_POINTS),
      primaryMetric: 'revenue',
      currentValue: row.revenueCents,
      comparisonValue: avg.value === null ? null : Math.round(avg.value),
      absoluteChange: avg.value === null ? null : row.revenueCents - Math.round(avg.value),
      percentageChange: avg.value === null || avg.value === 0 ? null : (row.revenueCents - avg.value) / Math.abs(avg.value),
      affectedEntities: affected(dim, row, avg.value === null ? null : Math.round(avg.value)),
      evidence: [
        currentEvidence(dim, row, input.windowLabel),
        seriesEvidence(dim, row, usablePoints, avg.value === null ? null : Math.round(avg.value),
          'mean(entity revenue) over complete prior periods',
          `Compared against ${usablePoints} prior periods carrying a value.`),
      ],
      limitations: [
        `Measured against ${usablePoints} complete prior periods; a short series makes the range itself uncertain.`,
        ...liveLimitation(input),
      ],
      unknowns: [
        `Why this ${noun.one}'s revenue sits at the edge of its range. Caps, scheduling, routing and demand are not exposed at ${noun.one} grain.`,
      ],
      recommendedReview: `Compare ${row.label}'s call volume and campaigns against the preceding periods.`,
      actionTarget: row.key,
      actionSafety: 'SAFE_TO_REVIEW',
      ruleId: 'entity-record-period',
      ruleVersion: ENTITY_RULE_VERSION,
    },
    input,
  );
}

/** Emerging: absent from the older half of the series, present and material now. */
function emergingFinding(
  input: EntityIntelligenceInput,
  dim: EntityDimension,
  row: EntityRow,
): CallGridFinding | null {
  const points = input.history.points;
  if (points.length < MIN_SERIES_POINTS) return null;
  if (row.revenueCents === null || row.revenueCents < MONEY_FLOOR) return null;

  const key = historyEntityKey(dim, row.key);
  // Series is most-recent-first, so the OLDER half is the tail.
  const series = entitySeries(input.history, key);
  const half = Math.floor(series.length / 2);
  const older = series.slice(half);
  const recent = series.slice(0, half);

  const absentEarly = older.every((v) => v === null || v === 0);
  const presentRecently = recent.filter((v) => v !== null && v > 0).length;
  // Appearing once is noise; it must have kept producing.
  if (!absentEarly || presentRecently < 2) return null;

  const noun = NOUN[dim];
  return buildFinding(
    {
      id: `entity-emerging-${dim}-${row.key}`,
      findingType: 'OPPORTUNITY',
      title: `${row.label} is a recently emerged ${noun.one}`,
      plainLanguageSummary:
        `${row.label} recorded no revenue across the earliest ${older.length} periods observed and has produced in ` +
        `${presentRecently} of the ${recent.length} most recent, reaching ${money(row.revenueCents)} in ` +
        `${input.windowLabel.toLowerCase()}. Its percentage changes are therefore measured from a very short base.`,
      classification: 'DERIVED',
      severity: 'INFORMATIONAL',
      confidence: deriveConfidence(1, points.length, MIN_SERIES_POINTS),
      primaryMetric: 'revenue',
      currentValue: row.revenueCents,
      affectedEntities: affected(dim, row, null),
      evidence: [
        currentEvidence(dim, row, input.windowLabel),
        seriesEvidence(dim, row, points.length, presentRecently,
          'count(periods with revenue) over the most recent half of the series',
          `Absent from all ${older.length} earlier periods observed.`),
      ],
      limitations: [
        `Based on ${points.length} complete prior periods. Loop sees only periods it loaded, so the ${noun.one} may have been active before them.`,
        ...liveLimitation(input),
      ],
      unknowns: [
        `Whether this ${noun.one} is genuinely new or simply had no matching traffic earlier. CallGrid exposes no roster, so the two cannot be distinguished.`,
      ],
      recommendedReview: `Confirm whether ${row.label} is a new relationship and review the campaigns routing to it.`,
      actionTarget: row.key,
      actionSafety: 'SAFE_TO_REVIEW',
      ruleId: 'entity-emerging',
      ruleVersion: ENTITY_RULE_VERSION,
    },
    input,
  );
}

/** Dormant: still present, but on a sustained downward trend across the series. */
function dormantFinding(
  input: EntityIntelligenceInput,
  dim: EntityDimension,
  row: EntityRow,
): CallGridFinding | null {
  const key = historyEntityKey(dim, row.key);
  const series = entitySeries(input.history, key);
  // Include the current period at the front so the trend covers the whole picture.
  const withCurrent = [row.revenueCents, ...series];
  const t = trendPerPeriod(withCurrent);
  if (t.value === null || t.value > -0.15) return null;

  const avg = mean(series);
  if (avg.value === null || avg.value < MONEY_FLOOR) return null;

  const noun = NOUN[dim];
  return buildFinding(
    {
      id: `entity-dormant-${dim}-${row.key}`,
      findingType: 'RISK',
      title: `${row.label} has declined across successive periods`,
      plainLanguageSummary:
        `${row.label}'s revenue has fallen by roughly ${Math.abs(Math.round(t.value * 100))}% per period across ` +
        `${t.usablePoints} periods, reaching ${money(row.revenueCents)}. This is a sustained fade rather than a single ` +
        `down period, which is a different thing to review.`,
      classification: 'DERIVED',
      severity: 'NOTABLE',
      confidence: deriveConfidence(1, t.usablePoints, MIN_SERIES_POINTS),
      primaryMetric: 'revenue',
      currentValue: row.revenueCents,
      comparisonValue: Math.round(avg.value),
      absoluteChange: row.revenueCents === null ? null : row.revenueCents - Math.round(avg.value),
      percentageChange: t.value,
      affectedEntities: affected(dim, row, Math.round(avg.value)),
      evidence: [
        currentEvidence(dim, row, input.windowLabel),
        seriesEvidence(dim, row, t.usablePoints, Math.round(t.value * 1000) / 1000,
          'least-squares slope of entity revenue per period, as a fraction of its mean',
          `Averaged ${money(Math.round(avg.value))} across the series.`),
      ],
      limitations: [
        `Based on ${t.usablePoints} periods including the selected one.`,
        ...liveLimitation(input),
      ],
      unknowns: [
        `Why the decline is sustained. Loop cannot see whether the ${noun.one} changed caps, schedule, routing or demand — none are exposed.`,
      ],
      recommendedReview: `Contact ${row.label} to confirm whether anything changed on their side, and compare the campaigns feeding them.`,
      actionTarget: row.key,
      actionSafety: 'SAFE_TO_REVIEW',
      ruleId: 'entity-dormant',
      ruleVersion: ENTITY_RULE_VERSION,
    },
    input,
  );
}

/** How steady an entity is — which qualifies how any delta about it should be read. */
function consistencyFinding(
  input: EntityIntelligenceInput,
  dim: EntityDimension,
  row: EntityRow,
): CallGridFinding | null {
  const key = historyEntityKey(dim, row.key);
  const series = entitySeries(input.history, key);
  const v = volatility(series);
  if (v.value === null || v.value < ERRATIC_CV) return null;

  const avg = mean(series);
  if (avg.value === null || avg.value < MONEY_FLOOR) return null;

  const noun = NOUN[dim];
  return buildFinding(
    {
      id: `entity-consistency-${dim}-${row.key}`,
      findingType: 'OPERATIONAL',
      title: `${row.label}'s revenue is erratic period to period`,
      plainLanguageSummary:
        `${row.label}'s revenue has varied by ${Math.round(v.value * 100)}% of its own average across ` +
        `${v.usablePoints} complete periods. A single period's change for this ${noun.one} is therefore weak evidence ` +
        `on its own and is better read against its range.`,
      classification: 'DERIVED',
      severity: 'INFORMATIONAL',
      confidence: deriveConfidence(1, v.usablePoints, MIN_SERIES_POINTS),
      primaryMetric: 'revenue',
      currentValue: row.revenueCents,
      comparisonValue: Math.round(avg.value),
      affectedEntities: affected(dim, row, Math.round(avg.value)),
      evidence: [
        currentEvidence(dim, row, input.windowLabel),
        seriesEvidence(dim, row, v.usablePoints, Math.round(v.value * 100) / 100,
          'standard deviation / mean of entity revenue across complete prior periods',
          'A coefficient of variation above 0.5 is treated as erratic.'),
      ],
      limitations: [
        `Based on ${v.usablePoints} complete prior periods.`,
        ...liveLimitation(input),
      ],
      unknowns: [
        'What drives the variation. Seasonality, campaign scheduling and buyer-side availability are not exposed.',
      ],
      recommendedReview: `Evaluate ${row.label} against its multi-period range rather than the single prior period.`,
      actionTarget: row.key,
      actionSafety: 'SAFE_TO_REVIEW',
      ruleId: 'entity-consistency',
      ruleVersion: ENTITY_RULE_VERSION,
    },
    input,
  );
}

/** A share of revenue rising beyond the entity's own historical share. */
function dominanceFinding(
  input: EntityIntelligenceInput,
  dim: EntityDimension,
  row: EntityRow,
): CallGridFinding | null {
  const windowRevenue = input.windowRevenueCents;
  if (windowRevenue === null || windowRevenue <= 0) return null;
  if (row.revenueCents === null || row.revenueCents < MONEY_FLOOR) return null;

  const key = historyEntityKey(dim, row.key);
  const points = input.history.points;
  const historicalShares: number[] = [];
  for (const p of points) {
    const entityRev = p.entityRevenueCents[key];
    if (entityRev === null || entityRev === undefined) continue;
    if (p.revenueCents === null || p.revenueCents <= 0) continue;
    historicalShares.push(entityRev / p.revenueCents);
  }
  if (historicalShares.length < MIN_SERIES_POINTS) return null;

  const currentShare = row.revenueCents / windowRevenue;
  const priorShare = historicalShares.reduce((s, v) => s + v, 0) / historicalShares.length;
  const lift = currentShare - priorShare;
  if (lift < DOMINANCE_LIFT) return null;

  const noun = NOUN[dim];
  return buildFinding(
    {
      id: `entity-dominance-${dim}-${row.key}`,
      findingType: 'CONCENTRATION',
      title: `${row.label} now represents ${Math.round(currentShare * 100)}% of revenue`,
      plainLanguageSummary:
        `${row.label} accounts for ${Math.round(currentShare * 100)}% of revenue in ${input.windowLabel.toLowerCase()}, ` +
        `against an average of ${Math.round(priorShare * 100)}% across the last ${historicalShares.length} complete periods. ` +
        `A rising share means more of the business depends on this ${noun.one}; it says nothing about the ${noun.one}'s intentions.`,
      classification: 'DERIVED',
      severity: (currentShare >= 0.33 ? 'NOTABLE' : 'INFORMATIONAL') as Severity,
      confidence: deriveConfidence(1, historicalShares.length, MIN_SERIES_POINTS),
      primaryMetric: 'revenueShare',
      currentValue: Math.round(currentShare * 1000) / 1000,
      comparisonValue: Math.round(priorShare * 1000) / 1000,
      absoluteChange: Math.round(lift * 1000) / 1000,
      percentageChange: priorShare === 0 ? null : lift / priorShare,
      affectedEntities: affected(dim, row, null),
      evidence: [
        currentEvidence(dim, row, input.windowLabel),
        {
          metricKey: 'revenueShare',
          entityType: NOUN[dim].entity,
          entityId: row.key,
          entityName: row.label,
          window: input.windowLabel,
          derivedValue: Math.round(currentShare * 1000) / 1000,
          formula: 'entity revenue / window revenue',
          formulaVersion: ENTITY_RULE_VERSION,
          classification: 'DERIVED',
          notes: 'Numerator and denominator come from the same window read.',
        },
        seriesEvidence(dim, row, historicalShares.length, Math.round(priorShare * 1000) / 1000,
          'mean(entity revenue / window revenue) across complete prior periods',
          'Only periods where BOTH the entity value and the window total were known are included.'),
      ],
      limitations: [
        `Based on ${historicalShares.length} complete prior periods where both the entity and window totals were known.`,
        ...liveLimitation(input),
      ],
      unknowns: [
        `Whether this concentration is intentional. Loop cannot see contracts, caps or commercial arrangements.`,
      ],
      recommendedReview: `Review how much of the ${noun.many.replace(/s$/, '')} mix depends on ${row.label} before making routing or payout decisions.`,
      actionTarget: row.key,
      actionSafety: 'SAFE_TO_REVIEW',
      ruleId: 'entity-rising-dominance',
      ruleVersion: ENTITY_RULE_VERSION,
    },
    input,
  );
}

/**
 * Every series-backed finding for one dimension.
 *
 * Bounded per rule: a page listing fifteen "erratic entity" notes prioritizes
 * nothing, which is the failure this whole phase exists to fix.
 */
export function entitySeriesFindings(
  input: EntityIntelligenceInput,
  dim: EntityDimension,
  rows: readonly EntityRow[],
  limitPerRule = 2,
): CallGridFinding[] {
  if (input.history.points.length < MIN_SERIES_POINTS) return [];

  const out: CallGridFinding[] = [];
  const rules = [recordFinding, dormantFinding, dominanceFinding, emergingFinding, consistencyFinding];

  for (const rule of rules) {
    const produced: CallGridFinding[] = [];
    for (const row of rows) {
      const f = rule(input, dim, row);
      if (f) produced.push(f);
    }
    // Largest first, so the cap keeps the most material rather than the first seen.
    produced.sort((a, b) => Math.abs(b.currentValue ?? 0) - Math.abs(a.currentValue ?? 0));
    out.push(...produced.slice(0, limitPerRule));
  }
  return out;
}
