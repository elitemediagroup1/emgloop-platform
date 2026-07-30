// The CallGrid Intelligence Engine — deterministic, pure, evidence-first.
//
// It consumes ONLY canonical report output. It never queries a provider, never
// defines a metric formula of its own (those live in the metric contract), never
// invents a threshold (those live in the significance registry), and never calls
// a language model. Given the same reports and the same `now`, it produces the
// same findings, every time — which is what makes a conclusion checkable.
//
// The engine's job is to answer, for the selected period:
//   what happened · what changed · why · does it matter · who contributed ·
//   what should be investigated · what action is reasonable · what is unknown
//
// House rules encoded here:
//   - Contribution is not causation. An entity is "the largest contributor to"
//     a decline; it never "caused" one.
//   - An entity missing from a window has a PROVEN zero for it (the whole window
//     was read). An entity present with a null value is UNKNOWN and is excluded
//     from arithmetic rather than counted as zero.
//   - Every emitted finding carries evidence, limitations and a rule version.

import {
  absoluteChange, percentageChange, contributionToChange, revenuePerBillableCall,
  billableRate, share as shareOf, coverage,
} from './callgrid-metric-contract';
import {
  type CallGridFinding, type CallGridEvidenceReference, type AffectedEntity,
  type Severity, type FindingType, type ActionSafety, type EntityType,
  type IntelligenceUnknown, type MetricClassification,
  SEVERITY_RANK, gradeSeverity, capSeverity, deriveConfidence, findingViolations,
} from './callgrid-intelligence';
import type { CallGridComparisonBasis } from './callgrid-window';
import {
  buildFinding, type EvidenceSpec, type FindingSpec, CALL_REPORT,
} from './callgrid-finding-builder';
import {
  EMPTY_SERIES, seriesOf, historyEntityKey, type HistorySeries,
} from './callgrid-history';
import { detectAnomalies } from './callgrid-anomaly';
import {
  rankFindings, recurrenceKey, type ScoredFinding,
} from './callgrid-scoring';
import {
  assessMarketplaceRisk, riskUnknowns, type MarketplaceRisk, type RiskDimRow,
} from './callgrid-risk';
import { entitySeriesFindings, type EntityRow } from './callgrid-entity-intelligence';
import {
  assessBusinessHealth, healthUnknowns,
  type BusinessHealth, type HealthDimRow, type HealthScore, type HealthDimensionId,
} from './callgrid-health';
import {
  findOpportunities, opportunityUnknowns, type Opportunity, type OpportunityRow,
} from './callgrid-opportunity';
import { buildDecisionSupport, type DecisionSupportCard } from './callgrid-decision-support';
import { reasonAboutFindings, type OperationalReasoning } from './callgrid-reasoning';
import {
  buildQueue, buildBriefing, queueUnknowns,
  type SituationQueue, type Briefing,
} from './callgrid-situation';

// --- Engine input (the canonical report, as a contract) ------------------------

export interface IntelligenceMetrics {
  available: boolean;
  totalCalls: number | null;
  billableCalls: number | null;
  revenueCents: number | null;
  profitCents: number | null;
  revenueCoverage: number | null;
  profitCoverage: number | null;
}

export interface IntelligenceDimRow {
  key: string;
  label: string;
  calls: number;
  monetized: number;
  converted: number;
  revenueCents: number | null;
  payoutCents: number | null;
  costCents: number | null;
  marginCents: number | null;
  revenueCoverage: number | null;
}

export type IntelligenceDimension = 'buyers' | 'vendors' | 'sources' | 'campaigns';

export interface IntelligenceInput {
  /** Injected clock — the engine is pure and never reads the system time. */
  now: Date;
  reportOk: boolean;
  /** Operator-facing period label, e.g. "Today · Live". */
  windowLabel: string;
  comparisonLabel: string | null;
  comparisonBasis: CallGridComparisonBasis;
  /** True when the selected window is still in progress. */
  includesLiveData: boolean;
  metrics: IntelligenceMetrics;
  comparison: IntelligenceMetrics | null;
  dimensions: Record<IntelligenceDimension, IntelligenceDimRow[]>;
  comparisonDimensions: Record<IntelligenceDimension, IntelligenceDimRow[]>;
  /**
   * Complete prior periods, most-recent-first. Optional: every distribution rule
   * degrades to silence without it rather than to a two-point guess, so a caller
   * that cannot afford the extra reads still gets correct (narrower) intelligence.
   */
  history?: HistorySeries;
  /** Provider-reported bid reject rate (0–1) for the risk model. Null when unreported. */
  bidRejectRate?: number | null;
  /** Rate-limited share of destination failures (0–1) for the risk model. */
  rateLimitedShare?: number | null;
  /**
   * Comparison rows keyed by entity, per dimension. Optional: the rules that need
   * a per-entity prior (value-per-call movement) skip the entity rather than
   * guessing when it is absent.
   */
  comparisonByKey?: Record<IntelligenceDimension, ReadonlyMap<string, IntelligenceDimRow>>;
  /**
   * How many windows of this length fit in a year. Supplied by the adapter from
   * the resolved window's Eastern span. Null suppresses every annualization —
   * the decision-support layer then states that rather than guessing a cadence.
   */
  periodsPerYear?: number | null;
}

// --- Engine output ----------------------------------------------------------------

export interface ExecutiveSummary {
  /** The one sentence that answers "what happened this period". */
  headline: string;
  /** The primary performance finding, when one is significant. */
  primaryChange: CallGridFinding | null;
  drivers: CallGridFinding[];
  topConcern: CallGridFinding | null;
  topOpportunity: CallGridFinding | null;
  /** Ordered review list — what a person should look at first. */
  recommendedReviews: string[];
}

/**
 * The Executive Intelligence Brief — at most five findings, ordered by
 * Intelligence Score rather than severity alone.
 *
 * FIVE IS A CEILING, NOT A TARGET. A quiet period yields fewer, and a period with
 * nothing evidence-backed to say yields none. Padding the brief to five would
 * make the count meaningless and train an executive to skim it.
 */
export interface ExecutiveBrief {
  /** At most five, highest Intelligence Score first. */
  items: ScoredFinding[];
  /** Findings that were produced and scored but did not make the top five. */
  omittedCount: number;
  /**
   * Stated when the brief is empty — never left blank, because a blank section
   * reads as a failure rather than as "nothing crossed the bar".
   */
  emptyReason: string | null;
  /**
   * True when scoring ran without a historical series, so novelty could not be
   * measured and the ordering rests on fewer components.
   */
  scoredWithoutHistory: boolean;
}

export interface CallGridIntelligence {
  executiveSummary: ExecutiveSummary;
  /** The five-item attention-ordered brief. */
  brief: ExecutiveBrief;
  /** Structural fragility of the marketplace, with every factor's determinacy. */
  risk: MarketplaceRisk;
  /** Business health across seven dimensions plus an overall. UNKNOWN, never HEALTHY, when unmeasurable. */
  health: BusinessHealth;
  /** Opportunities with measured exposure or gap — never a forecast of upside. */
  opportunityFindings: Opportunity[];
  /**
   * Decision support cards, ordered by review priority.
   *
   * A projection over `ranked` — it separates measured fact from Loop's reading of
   * it, states what information is missing, and names the review a person should
   * make. Loop owns the facts; the operator owns the decision.
   */
  decisionSupport: DecisionSupportCard[];
  /**
   * Findings understood as a connected system: relations, clusters, the
   * chronological feed, entity stability, the logical graph and the Business
   * Story. Consumes findings; produces no metric of its own.
   */
  reasoning: OperationalReasoning;
  /**
   * The operator's queue — findings MERGED into Situations, then ranked.
   *
   * This is the surface's primary input and the reason the ordering inverted:
   * `ranked` scores individual findings, so one business event competes with
   * itself several times over. `queue` scores the merged event, so what reaches
   * an operator is one row per thing that is actually happening.
   */
  queue: SituationQueue;
  /** The briefing, assembled from `queue` — one source, two renderings. */
  briefing: Briefing;
  /** Every finding produced, severity-ordered. */
  findings: CallGridFinding[];
  /** Every finding with its Intelligence Score, attention-ordered. */
  ranked: ScoredFinding[];
  changes: CallGridFinding[];
  drivers: CallGridFinding[];
  risks: CallGridFinding[];
  opportunities: CallGridFinding[];
  anomalies: CallGridFinding[];
  investigations: CallGridFinding[];
  unknowns: IntelligenceUnknown[];
  evidenceReferences: CallGridEvidenceReference[];
}

// --- Formatting (pure) --------------------------------------------------------------

const DIM_NOUN: Record<IntelligenceDimension, { one: string; many: string; entity: EntityType }> = {
  buyers: { one: 'buyer', many: 'buyers', entity: 'buyer' },
  vendors: { one: 'vendor', many: 'vendors', entity: 'vendor' },
  sources: { one: 'source', many: 'sources', entity: 'source' },
  campaigns: { one: 'campaign', many: 'campaigns', entity: 'campaign' },
};

function money(cents: number | null): string {
  if (cents === null) return 'an unknown amount';
  const sign = cents < 0 ? '-' : '';
  return sign + '$' + Math.round(Math.abs(cents) / 100).toLocaleString('en-US');
}
function count(n: number | null): string {
  return n === null ? 'an unknown number' : n.toLocaleString('en-US');
}
function pct(fraction: number | null): string {
  return fraction === null ? 'an unknown amount' : Math.abs(Math.round(fraction * 100)) + '%';
}
function direction(change: number): 'increased' | 'decreased' | 'held steady' {
  return change > 0 ? 'increased' : change < 0 ? 'decreased' : 'held steady';
}

// --- Evidence + finding construction --------------------------------------------------

/**
 * Finding construction moved to `callgrid-finding-builder.ts` when anomaly and
 * opportunity analysis arrived — three emitters, one builder. This stays as a
 * thin alias so the ~40 call sites below read unchanged.
 */
function makeFinding(spec: FindingSpec, input: IntelligenceInput): CallGridFinding {
  return buildFinding(spec, input);
}

/** The comparison caveat that applies to every finding on an in-progress window. */
function liveLimitation(input: IntelligenceInput): string[] {
  if (!input.includesLiveData) return [];
  return [
    input.comparisonBasis === 'elapsed_matched'
      ? `The selected period is still in progress. ${input.comparisonLabel ?? 'The comparison'} is measured to the same point, so the two cover equal elapsed time, but both remain partial.`
      : 'The selected period is still in progress and the comparison is a completed period, so the two are not directly comparable.',
  ];
}

// --- Entity change algebra --------------------------------------------------------

interface EntityDelta {
  key: string;
  label: string;
  current: IntelligenceDimRow | null;
  prior: IntelligenceDimRow | null;
  /** Revenue now, where absence from the window is a proven zero. */
  currentRevenue: number | null;
  priorRevenue: number | null;
  revenueChange: number | null;
  currentCalls: number;
  priorCalls: number;
  callChange: number;
  currentRank: number | null;
  priorRank: number | null;
}

/**
 * Join the two windows for a dimension.
 *
 * An entity ABSENT from a window genuinely produced nothing in it — the whole
 * window was read, so zero is proven. An entity PRESENT with a null revenue was
 * never priced, so its revenue stays unknown and it is excluded from revenue
 * arithmetic instead of silently counting as zero.
 */
function entityDeltas(
  current: readonly IntelligenceDimRow[],
  prior: readonly IntelligenceDimRow[],
): EntityDelta[] {
  const curByKey = new Map(current.map((r) => [r.key, r] as const));
  const priByKey = new Map(prior.map((r) => [r.key, r] as const));
  const curRank = new Map(current.map((r, i) => [r.key, i + 1] as const));
  const priRank = new Map(prior.map((r, i) => [r.key, i + 1] as const));

  const keys = new Set([...curByKey.keys(), ...priByKey.keys()]);
  const out: EntityDelta[] = [];
  for (const key of keys) {
    const c = curByKey.get(key) ?? null;
    const p = priByKey.get(key) ?? null;
    // Absent → proven 0. Present but unpriced → unknown.
    const currentRevenue = c === null ? 0 : c.revenueCents;
    const priorRevenue = p === null ? 0 : p.revenueCents;
    out.push({
      key,
      label: c?.label ?? p?.label ?? key,
      current: c,
      prior: p,
      currentRevenue,
      priorRevenue,
      revenueChange: absoluteChange(currentRevenue, priorRevenue),
      currentCalls: c?.calls ?? 0,
      priorCalls: p?.calls ?? 0,
      callChange: (c?.calls ?? 0) - (p?.calls ?? 0),
      currentRank: curRank.get(key) ?? null,
      priorRank: priRank.get(key) ?? null,
    });
  }
  return out;
}

function toAffected(d: EntityDelta, entityType: EntityType, windowChange: number | null, curTotal: number | null, priTotal: number | null): AffectedEntity {
  return {
    entityType,
    entityId: d.key,
    entityName: d.label,
    currentValue: d.currentRevenue,
    comparisonValue: d.priorRevenue,
    absoluteChange: d.revenueChange,
    contributionToChange: contributionToChange(d.revenueChange, windowChange),
    currentShare: shareOf(d.currentRevenue, curTotal),
    comparisonShare: shareOf(d.priorRevenue, priTotal),
    currentRank: d.currentRank,
    comparisonRank: d.priorRank,
  };
}

function totalRevenue(rows: readonly IntelligenceDimRow[]): number | null {
  let total = 0;
  let reported = 0;
  for (const r of rows) {
    if (r.revenueCents !== null) { total += r.revenueCents; reported += 1; }
  }
  return reported > 0 ? total : null;
}

// --- A. Overall performance change ----------------------------------------------

interface HeadlineSpec {
  metricKey: string;
  label: string;
  ruleId: string;
  ladder: [number, number | null, number | null];
  minAbsolute: number;
  minVolume: number;
  format: (v: number | null) => string;
  findingType: FindingType;
  current: number | null;
  comparison: number | null;
  coverage: number | null;
  /** Coverage below this suppresses the finding entirely. */
  minCoverage: number;
  providerFields: string[];
  formula: string;
}

function headlineFinding(spec: HeadlineSpec, input: IntelligenceInput): CallGridFinding | null {
  const cmp = input.comparison;
  if (!input.metrics.available || !cmp?.available) return null;
  if (spec.current === null || spec.comparison === null) return null;

  const calls = cmp.totalCalls ?? 0;
  if (calls < spec.minVolume) return null;
  if (spec.coverage !== null && spec.coverage < spec.minCoverage) return null;

  const abs = absoluteChange(spec.current, spec.comparison);
  const rel = percentageChange(spec.current, spec.comparison);
  if (abs === null || rel === null) return null;
  if (Math.abs(abs) < spec.minAbsolute) return null;

  const severity = gradeSeverity(rel, spec.ladder);
  if (severity === null) return null;

  const dir = direction(abs);
  const id = `change:${spec.metricKey}`;
  const cmpLabel = input.comparisonLabel ?? 'the comparison period';

  const limitations = [
    ...liveLimitation(input),
    ...(spec.coverage !== null && spec.coverage < 1
      ? [`${Math.round(spec.coverage * 100)}% of calls in the selected period carried a ${spec.label.toLowerCase()} value, so the total is a lower bound.`]
      : []),
  ];
  if (limitations.length === 0) {
    limitations.push('Both periods were read from the same reporting source with the same window rules.');
  }

  return makeFinding({
    id,
    findingType: spec.findingType,
    title: `${spec.label} ${dir} ${pct(rel)}`,
    plainLanguageSummary:
      `${spec.label} ${dir} from ${spec.format(spec.comparison)} to ${spec.format(spec.current)} — ` +
      `${dir === 'held steady' ? 'no change' : `a change of ${spec.format(Math.abs(abs))} (${pct(rel)})`} versus ${cmpLabel.toLowerCase()}.`,
    classification: 'DERIVED',
    severity,
    confidence: deriveConfidence(spec.coverage, calls, spec.minVolume),
    primaryMetric: spec.metricKey,
    currentValue: spec.current,
    comparisonValue: spec.comparison,
    absoluteChange: abs,
    percentageChange: rel,
    evidence: [
      {
        metricKey: spec.metricKey, entityType: 'window', window: input.windowLabel,
        providerField: spec.providerFields.join(', '),
        normalizedValue: spec.current, derivedValue: spec.current,
        formula: spec.formula, formulaVersion: 'v1',
        classification: 'DERIVED', completeness: spec.coverage,
      },
      {
        metricKey: spec.metricKey, entityType: 'window', window: cmpLabel,
        providerField: spec.providerFields.join(', '),
        normalizedValue: spec.comparison, derivedValue: spec.comparison,
        formula: spec.formula, formulaVersion: 'v1',
        classification: 'DERIVED', completeness: cmp.revenueCoverage,
      },
      {
        metricKey: 'percentageChange', entityType: 'window', window: `${input.windowLabel} vs ${cmpLabel}`,
        derivedValue: rel, formula: '(current - comparison) / comparison', formulaVersion: 'v1',
        classification: 'DERIVED', sourceType: 'derived',
        notes: input.comparisonBasis === 'elapsed_matched'
          ? 'Both periods cover the same elapsed time.'
          : 'Both periods are complete and of equal length.',
      },
    ],
    limitations,
    unknowns: [],
    recommendedReview: null,
    actionSafety: 'SAFE_TO_REVIEW',
    ruleId: spec.ruleId,
    ruleVersion: 'v1',
  }, input);
}

// --- B. Contribution analysis -------------------------------------------------------

function contributionFindings(
  input: IntelligenceInput,
  dim: IntelligenceDimension,
  windowChange: number,
  parentSeverity: Severity,
): CallGridFinding[] {
  const noun = DIM_NOUN[dim];
  const cur = input.dimensions[dim];
  const pri = input.comparisonDimensions[dim];
  if (cur.length === 0 && pri.length === 0) return [];

  const curTotal = totalRevenue(cur);
  const priTotal = totalRevenue(pri);
  const deltas = entityDeltas(cur, pri);

  // Rank by how much of the window's move each entity accounts for, in the same
  // direction as the move itself.
  const sameDirection = deltas.filter((d) => {
    if (d.revenueChange === null || d.revenueChange === 0) return false;
    return windowChange > 0 ? d.revenueChange > 0 : d.revenueChange < 0;
  });
  const ranked = sameDirection
    .map((d) => ({ d, contribution: contributionToChange(d.revenueChange, windowChange) }))
    .filter((x): x is { d: EntityDelta; contribution: number } => x.contribution !== null)
    .sort((a, b) => b.contribution - a.contribution);

  const out: CallGridFinding[] = [];
  for (const { d, contribution } of ranked.slice(0, 3)) {
    // Registry floor: at least a quarter of the move, and a real sample.
    if (contribution < 0.25) continue;
    if (d.currentCalls + d.priorCalls < 5) continue;
    if (Math.abs(d.revenueChange!) < 25_000) continue;

    const fell = windowChange < 0;
    const id = `driver:${dim}:${d.key}`;
    out.push(makeFinding({
      id,
      findingType: 'DRIVER',
      title: `${d.label} accounts for ${pct(contribution)} of the ${fell ? 'decline' : 'increase'}`,
      // Deliberate wording: "the largest contributor to", never "caused".
      plainLanguageSummary:
        `${d.label} is the largest ${noun.one} contributor to the revenue ${fell ? 'decline' : 'increase'}, ` +
        `accounting for ${pct(contribution)} of it — ${money(d.priorRevenue)} to ${money(d.currentRevenue)}. ` +
        `This establishes contribution, not cause.`,
      classification: 'DERIVED',
      // Registry rule: a driver inherits the severity of the change it explains,
      // capped at HIGH — an explanation never outranks the thing being explained.
      severity: capSeverity(parentSeverity, 'HIGH'),
      confidence: deriveConfidence(d.current?.revenueCoverage ?? null, d.currentCalls + d.priorCalls, 5),
      primaryMetric: 'contributionToChange',
      currentValue: d.currentRevenue,
      comparisonValue: d.priorRevenue,
      absoluteChange: d.revenueChange,
      percentageChange: percentageChange(d.currentRevenue, d.priorRevenue),
      affectedEntities: [toAffected(d, noun.entity, windowChange, curTotal, priTotal)],
      drivers: [toAffected(d, noun.entity, windowChange, curTotal, priTotal)],
      evidence: [
        {
          metricKey: 'revenue', entityType: noun.entity, entityId: d.key, entityName: d.label,
          window: input.windowLabel, providerField: 'revenueCents',
          normalizedValue: d.currentRevenue, classification: d.currentRevenue === null ? 'UNKNOWN' : 'DERIVED',
          completeness: d.current?.revenueCoverage ?? null,
          notes: d.current === null ? 'No calls attributed to this entity in the selected period.' : null,
        },
        {
          metricKey: 'revenue', entityType: noun.entity, entityId: d.key, entityName: d.label,
          window: input.comparisonLabel ?? 'comparison period', providerField: 'revenueCents',
          normalizedValue: d.priorRevenue, classification: d.priorRevenue === null ? 'UNKNOWN' : 'DERIVED',
          completeness: d.prior?.revenueCoverage ?? null,
          notes: d.prior === null ? 'No calls attributed to this entity in the comparison period.' : null,
        },
        {
          metricKey: 'contributionToChange', entityType: noun.entity, entityId: d.key, entityName: d.label,
          window: `${input.windowLabel} vs ${input.comparisonLabel ?? 'comparison period'}`,
          derivedValue: contribution, formula: 'entity.absoluteChange / window.absoluteChange',
          formulaVersion: 'v1', classification: 'DERIVED', sourceType: 'derived',
        },
      ],
      limitations: [
        'Contribution is arithmetic, not attribution of cause. Other movements may offset or amplify it.',
        ...liveLimitation(input),
      ],
      unknowns: [
        `CallGrid does not expose why this ${noun.one}'s volume or value changed — capacity, scheduling, routing, demand and configuration are all invisible at this grain.`,
      ],
      recommendedReview: `Review this ${noun.one}'s activity for the period and confirm whether the change was expected.`,
      recommendedActionType: 'REVIEW_ENTITY',
      actionTarget: `${dim}:${d.key}`,
      actionSafety: 'SAFE_TO_REVIEW',
      ruleId: 'entity-contribution',
      ruleVersion: 'v1',
    }, input));
  }
  return out;
}

// --- C. Volume versus value ------------------------------------------------------

function volumeVersusValue(input: IntelligenceInput): CallGridFinding | null {
  const cur = input.metrics;
  const pri = input.comparison;
  if (!cur.available || !pri?.available) return null;

  const revChange = percentageChange(cur.revenueCents, pri.revenueCents);
  const callChange = percentageChange(cur.totalCalls, pri.totalCalls);
  const curValue = revenuePerBillableCall(cur.revenueCents, cur.billableCalls ?? 0);
  const priValue = revenuePerBillableCall(pri.revenueCents, pri.billableCalls ?? 0);
  const valueChange = percentageChange(curValue, priValue);
  const profitChange = percentageChange(cur.profitCents, pri.profitCents);

  if ((pri.totalCalls ?? 0) < 20) return null;

  const STABLE = 0.1;
  const MOVED = 0.15;

  let interpretation: string | null = null;
  let severity: Severity = 'INFORMATIONAL';
  let findingType: FindingType = 'VOLUME';
  let review: string | null = null;

  if (revChange !== null && callChange !== null && valueChange !== null
      && revChange <= -MOVED && callChange <= -MOVED && Math.abs(valueChange) < STABLE) {
    interpretation =
      `Revenue fell ${pct(revChange)} while calls fell ${pct(callChange)} and revenue per billable call held steady ` +
      `(${money(priValue)} to ${money(curValue)}). The decline appears volume-driven rather than price-driven.`;
    severity = 'NOTABLE';
    findingType = 'VOLUME';
    review = 'Review where call volume came from in both periods to confirm the drop is a supply change.';
  } else if (revChange !== null && profitChange !== null
      && Math.abs(revChange) < STABLE && profitChange <= -MOVED) {
    interpretation =
      `Revenue held steady (${pct(revChange)}) while profit fell ${pct(profitChange)}. Margin deterioration should be reviewed.`;
    severity = 'HIGH';
    findingType = 'MARGIN';
    review = 'Review payout and cost per call for the period to confirm where margin was lost.';
  } else if (revChange !== null && callChange !== null && valueChange !== null
      && callChange >= MOVED && revChange < STABLE) {
    interpretation =
      `Calls rose ${pct(callChange)} but revenue moved only ${pct(revChange)}, and revenue per billable call ` +
      `${direction(valueChange)} ${pct(valueChange)}. Additional volume is producing less revenue per call.`;
    severity = 'NOTABLE';
    findingType = 'VOLUME';
    review = 'Compare the mix of sources and campaigns behind the additional volume against the prior period.';
  } else if (revChange !== null && profitChange !== null
      && Math.abs(revChange) < STABLE && profitChange >= MOVED) {
    interpretation =
      `Profit rose ${pct(profitChange)} on flat revenue (${pct(revChange)}). Margin efficiency improved.`;
    severity = 'INFORMATIONAL';
    findingType = 'MARGIN';
    review = 'Confirm which entities drove the margin improvement so the change can be sustained deliberately.';
  }

  if (interpretation === null) return null;

  // Profit-based interpretations are only allowed when profit is genuinely supported.
  if (findingType === 'MARGIN') {
    const cov = Math.min(cur.profitCoverage ?? 0, pri.profitCoverage ?? 0);
    if (cov < 0.5) return null;
  }

  return makeFinding({
    id: 'inference:volume-value',
    findingType,
    title: findingType === 'MARGIN' ? 'Margin moved independently of revenue' : 'Volume and value moved differently',
    plainLanguageSummary: interpretation,
    // An interpretation of verified movements — inference, and labelled as such.
    classification: 'INFERRED',
    severity,
    confidence: deriveConfidence(cur.revenueCoverage, pri.totalCalls ?? 0, 20),
    primaryMetric: findingType === 'MARGIN' ? 'profit' : 'revenuePerBillableCall',
    currentValue: findingType === 'MARGIN' ? cur.profitCents : curValue,
    comparisonValue: findingType === 'MARGIN' ? pri.profitCents : priValue,
    percentageChange: findingType === 'MARGIN' ? profitChange : valueChange,
    evidence: [
      { metricKey: 'revenue', entityType: 'window', window: input.windowLabel, normalizedValue: cur.revenueCents, classification: 'DERIVED', completeness: cur.revenueCoverage, providerField: 'revenueCents' },
      { metricKey: 'revenue', entityType: 'window', window: input.comparisonLabel ?? 'comparison period', normalizedValue: pri.revenueCents, classification: 'DERIVED', completeness: pri.revenueCoverage, providerField: 'revenueCents' },
      { metricKey: 'totalCalls', entityType: 'window', window: input.windowLabel, normalizedValue: cur.totalCalls, classification: 'VERIFIED', providerField: 'sourceOccurredAt' },
      { metricKey: 'totalCalls', entityType: 'window', window: input.comparisonLabel ?? 'comparison period', normalizedValue: pri.totalCalls, classification: 'VERIFIED', providerField: 'sourceOccurredAt' },
      { metricKey: 'revenuePerBillableCall', entityType: 'window', window: input.windowLabel, derivedValue: curValue, formula: 'revenue / billableCalls', formulaVersion: 'v1', classification: curValue === null ? 'UNKNOWN' : 'DERIVED', sourceType: 'derived' },
      { metricKey: 'revenuePerBillableCall', entityType: 'window', window: input.comparisonLabel ?? 'comparison period', derivedValue: priValue, formula: 'revenue / billableCalls', formulaVersion: 'v1', classification: priValue === null ? 'UNKNOWN' : 'DERIVED', sourceType: 'derived' },
    ],
    limitations: [
      'This is an interpretation of how the verified metrics moved together, not an observed cause.',
      ...liveLimitation(input),
    ],
    unknowns: ['CallGrid does not report why volume or per-call value changed, so the mechanism behind this pattern is not established.'],
    recommendedReview: review,
    recommendedActionType: 'REVIEW_PERIOD',
    actionSafety: 'REQUIRES_HUMAN_JUDGMENT',
    ruleId: findingType === 'MARGIN' ? 'profit-change' : 'value-per-call',
    ruleVersion: 'v1',
  }, input);
}

// --- D. Concentration ---------------------------------------------------------------

function concentrationFinding(input: IntelligenceInput, dim: IntelligenceDimension): CallGridFinding | null {
  const noun = DIM_NOUN[dim];
  const rows = input.dimensions[dim];
  if (rows.length < 2) return null; // one entity is definitional, not a finding
  if ((input.metrics.totalCalls ?? 0) < 20) return null;

  const total = totalRevenue(rows);
  const top = rows[0];
  if (!top || total === null || total <= 0 || top.revenueCents === null) return null;

  const topShare = shareOf(top.revenueCents, total);
  if (topShare === null) return null;

  const severity = gradeSeverity(topShare, [0.4, 0.55, 0.7]);
  if (severity === null) return null;

  const top3 = rows.slice(0, 3).reduce((s, r) => s + (r.revenueCents ?? 0), 0);
  const top3Share = shareOf(top3, total);

  const priorRows = input.comparisonDimensions[dim];
  const priorTotal = totalRevenue(priorRows);
  const priorTopShare = priorRows[0] ? shareOf(priorRows[0].revenueCents, priorTotal) : null;

  return makeFinding({
    id: `concentration:${dim}`,
    findingType: 'CONCENTRATION',
    title: `${top.label} represents ${pct(topShare)} of ${noun.one} revenue`,
    plainLanguageSummary:
      `Revenue is concentrated: ${top.label} accounts for ${pct(topShare)} of ${noun.one} revenue this period` +
      (top3Share !== null && rows.length > 3 ? `, and the top three for ${pct(top3Share)}` : '') +
      `. That is an operational dependency to be aware of, not a problem in itself.`,
    classification: 'DERIVED',
    severity,
    confidence: deriveConfidence(input.metrics.revenueCoverage, input.metrics.totalCalls ?? 0, 20),
    primaryMetric: 'revenueShare',
    currentValue: topShare,
    comparisonValue: priorTopShare,
    absoluteChange: priorTopShare === null ? null : topShare - priorTopShare,
    affectedEntities: [{
      entityType: noun.entity, entityId: top.key, entityName: top.label,
      currentValue: top.revenueCents, comparisonValue: priorRows.find((r) => r.key === top.key)?.revenueCents ?? null,
      absoluteChange: null, contributionToChange: null,
      currentShare: topShare, comparisonShare: priorTopShare,
      currentRank: 1, comparisonRank: priorRows.findIndex((r) => r.key === top.key) + 1 || null,
    }],
    evidence: [
      { metricKey: 'revenue', entityType: noun.entity, entityId: top.key, entityName: top.label, window: input.windowLabel, providerField: 'revenueCents', normalizedValue: top.revenueCents, classification: 'DERIVED', completeness: top.revenueCoverage },
      { metricKey: 'revenue', entityType: 'window', window: input.windowLabel, providerField: 'revenueCents', normalizedValue: total, classification: 'DERIVED', completeness: input.metrics.revenueCoverage, notes: `Total across ${rows.length} ${noun.many} observed this period.` },
      { metricKey: 'revenueShare', entityType: noun.entity, entityId: top.key, entityName: top.label, window: input.windowLabel, derivedValue: topShare, formula: 'entity.revenue / window.revenue', formulaVersion: 'v1', classification: 'DERIVED', sourceType: 'derived' },
    ],
    limitations: [
      `Only ${noun.many} with calls in this period are counted — CallGrid exposes no roster, so a configured but idle ${noun.one} is invisible.`,
      'Concentration measures dependency. It is not a judgement that the relationship is unhealthy.',
      ...liveLimitation(input),
    ],
    unknowns: [
      `Whether this ${noun.one} has capacity limits, contractual caps, or a replacement available is not exposed by CallGrid.`,
    ],
    recommendedReview: `Confirm continuity arrangements and what would absorb this volume if ${top.label} paused.`,
    recommendedActionType: 'REVIEW_ENTITY',
    actionTarget: `${dim}:${top.key}`,
    actionSafety: 'SAFE_TO_REVIEW',
    ruleId: 'revenue-concentration',
    ruleVersion: 'v1',
  }, input);
}

// --- E/F. Inactivity, entry, and rank movement --------------------------------------

function lifecycleFindings(input: IntelligenceInput, dim: IntelligenceDimension): CallGridFinding[] {
  const noun = DIM_NOUN[dim];
  const cur = input.dimensions[dim];
  const pri = input.comparisonDimensions[dim];
  if (pri.length === 0) return [];

  const deltas = entityDeltas(cur, pri);
  const out: CallGridFinding[] = [];

  // Former producers with no activity this period.
  const gone = deltas
    .filter((d) => d.current === null && (d.priorRevenue ?? 0) >= 50_000 && d.priorCalls >= 5)
    .sort((a, b) => (b.priorRevenue ?? 0) - (a.priorRevenue ?? 0));

  for (const d of gone.slice(0, 2)) {
    const wasTopFive = d.priorRank !== null && d.priorRank <= 5;
    out.push(makeFinding({
      id: `inactive:${dim}:${d.key}`,
      findingType: 'RISK',
      title: `${d.label} has no activity this period`,
      plainLanguageSummary:
        `${d.label} produced ${money(d.priorRevenue)} across ${count(d.priorCalls)} calls in ${(input.comparisonLabel ?? 'the comparison period').toLowerCase()}, ` +
        `and has no calls attributed in the selected period.`,
      classification: 'DERIVED',
      severity: wasTopFive ? 'HIGH' : 'NOTABLE',
      confidence: deriveConfidence(d.prior?.revenueCoverage ?? null, d.priorCalls, 5),
      primaryMetric: 'revenue',
      currentValue: 0,
      comparisonValue: d.priorRevenue,
      absoluteChange: d.revenueChange,
      affectedEntities: [toAffected(d, noun.entity, null, totalRevenue(cur), totalRevenue(pri))],
      evidence: [
        { metricKey: 'revenue', entityType: noun.entity, entityId: d.key, entityName: d.label, window: input.comparisonLabel ?? 'comparison period', providerField: 'revenueCents', normalizedValue: d.priorRevenue, classification: 'DERIVED', completeness: d.prior?.revenueCoverage ?? null },
        { metricKey: 'totalCalls', entityType: noun.entity, entityId: d.key, entityName: d.label, window: input.windowLabel, normalizedValue: 0, classification: 'VERIFIED', notes: 'The full window was read; no calls were attributed to this entity in it.' },
      ],
      limitations: [
        'Absence in the reporting window is what is observed. Whether the relationship changed is not.',
        ...liveLimitation(input),
      ],
      unknowns: [
        `CallGrid does not expose whether this ${noun.one} was paused, reached a cap, changed schedule, or simply received no matching traffic.`,
      ],
      recommendedReview: `Contact the ${noun.one} or check its configuration to confirm whether this absence was expected.`,
      recommendedActionType: 'REVIEW_ENTITY',
      actionTarget: `${dim}:${d.key}`,
      actionSafety: 'SAFE_TO_REVIEW',
      ruleId: 'entity-inactive',
      ruleVersion: 'v1',
    }, input));
  }

  // Significant rank movement among entities present in both periods.
  if (cur.length >= 10) {
    const moved = deltas
      .filter((d) => d.currentRank !== null && d.priorRank !== null && Math.abs(d.priorRank - d.currentRank) >= 3)
      .filter((d) => (d.priorRank! <= 5) !== (d.currentRank! <= 5)) // entered or left the top five
      .sort((a, b) => Math.abs(b.priorRank! - b.currentRank!) - Math.abs(a.priorRank! - a.currentRank!));

    for (const d of moved.slice(0, 2)) {
      const rose = d.currentRank! < d.priorRank!;
      out.push(makeFinding({
        id: `rank:${dim}:${d.key}`,
        findingType: rose ? 'OPPORTUNITY' : 'CHANGE',
        title: `${d.label} moved from #${d.priorRank} to #${d.currentRank} by revenue`,
        plainLanguageSummary:
          `${d.label} ${rose ? 'rose' : 'fell'} from #${d.priorRank} to #${d.currentRank} in the ${noun.one} revenue ranking ` +
          `(${money(d.priorRevenue)} to ${money(d.currentRevenue)}).`,
        classification: 'DERIVED',
        severity: 'NOTABLE',
        confidence: deriveConfidence(d.current?.revenueCoverage ?? null, d.currentCalls + d.priorCalls, 10),
        primaryMetric: 'rankChange',
        currentValue: d.currentRank,
        comparisonValue: d.priorRank,
        absoluteChange: d.priorRank! - d.currentRank!,
        affectedEntities: [toAffected(d, noun.entity, null, totalRevenue(cur), totalRevenue(pri))],
        evidence: [
          { metricKey: 'rankChange', entityType: noun.entity, entityId: d.key, entityName: d.label, window: `${input.windowLabel} vs ${input.comparisonLabel ?? 'comparison period'}`, derivedValue: d.priorRank! - d.currentRank!, formula: 'comparisonRank - currentRank', formulaVersion: 'v1', classification: 'DERIVED', sourceType: 'derived', notes: `Both ranks come from the same revenue-ranked ${noun.one} report the ${noun.one} table displays.` },
          { metricKey: 'revenue', entityType: noun.entity, entityId: d.key, entityName: d.label, window: input.windowLabel, providerField: 'revenueCents', normalizedValue: d.currentRevenue, classification: 'DERIVED', completeness: d.current?.revenueCoverage ?? null },
          { metricKey: 'revenue', entityType: noun.entity, entityId: d.key, entityName: d.label, window: input.comparisonLabel ?? 'comparison period', providerField: 'revenueCents', normalizedValue: d.priorRevenue, classification: 'DERIVED', completeness: d.prior?.revenueCoverage ?? null },
        ],
        limitations: [
          'Rank reflects position relative to other entities, which can move without this one changing.',
          ...liveLimitation(input),
        ],
        unknowns: [`Why this ${noun.one}'s position changed is not established by the ranking alone.`],
        recommendedReview: `Compare this ${noun.one}'s own revenue trend against the ${noun.many} around it before treating the move as its own.`,
        recommendedActionType: 'REVIEW_ENTITY',
        actionTarget: `${dim}:${d.key}`,
        actionSafety: 'SAFE_TO_REVIEW',
        ruleId: 'rank-movement',
        ruleVersion: 'v1',
      }, input));
    }
  }

  return out;
}

// --- H. Billable efficiency ------------------------------------------------------

function billableEfficiencyFinding(input: IntelligenceInput): CallGridFinding | null {
  const cur = input.metrics;
  const pri = input.comparison;
  if (!cur.available || !pri?.available) return null;
  if ((cur.totalCalls ?? 0) < 30 || (pri.totalCalls ?? 0) < 30) return null;

  const curRate = billableRate(cur.billableCalls ?? 0, cur.totalCalls ?? 0);
  const priRate = billableRate(pri.billableCalls ?? 0, pri.totalCalls ?? 0);
  const rel = percentageChange(curRate, priRate);
  if (rel === null) return null;

  const severity = gradeSeverity(rel, [0.2, 0.35, null]);
  if (severity === null) return null;

  const worse = rel < 0;
  return makeFinding({
    id: 'efficiency:billable-rate',
    findingType: 'OPERATIONAL',
    title: `Billable rate ${direction(rel)} ${pct(rel)}`,
    plainLanguageSummary:
      `${pct(curRate)} of calls were billable this period, against ${pct(priRate)} in ` +
      `${(input.comparisonLabel ?? 'the comparison period').toLowerCase()} — ${count(cur.billableCalls)} of ${count(cur.totalCalls)} calls, ` +
      `versus ${count(pri.billableCalls)} of ${count(pri.totalCalls)}.`,
    classification: 'DERIVED',
    severity,
    confidence: deriveConfidence(1, cur.totalCalls ?? 0, 30),
    primaryMetric: 'billableRate',
    currentValue: curRate,
    comparisonValue: priRate,
    percentageChange: rel,
    evidence: [
      { metricKey: 'billableCalls', entityType: 'window', window: input.windowLabel, providerField: 'monetized', normalizedValue: cur.billableCalls, classification: 'VERIFIED' },
      { metricKey: 'totalCalls', entityType: 'window', window: input.windowLabel, normalizedValue: cur.totalCalls, classification: 'VERIFIED' },
      { metricKey: 'billableCalls', entityType: 'window', window: input.comparisonLabel ?? 'comparison period', providerField: 'monetized', normalizedValue: pri.billableCalls, classification: 'VERIFIED' },
      { metricKey: 'totalCalls', entityType: 'window', window: input.comparisonLabel ?? 'comparison period', normalizedValue: pri.totalCalls, classification: 'VERIFIED' },
      { metricKey: 'billableRate', entityType: 'window', window: input.windowLabel, derivedValue: curRate, formula: 'billableCalls / totalCalls', formulaVersion: 'v1', classification: 'DERIVED', sourceType: 'derived' },
    ],
    limitations: [
      // The spec is explicit: this is efficiency, not quality.
      'Billable rate reflects how many calls met billing criteria. CallGrid does not expose why a call was not billable, so this is not a measure of call quality.',
      ...liveLimitation(input),
    ],
    unknowns: ['Whether the change came from traffic mix, buyer acceptance rules, or call duration is not exposed at this grain.'],
    recommendedReview: worse
      ? 'Compare the source and vendor mix between the two periods to see whether the traffic composition changed.'
      : 'Confirm which sources improved so the change can be understood rather than assumed.',
    recommendedActionType: 'REVIEW_PERIOD',
    actionSafety: 'SAFE_TO_REVIEW',
    ruleId: 'billable-efficiency',
    ruleVersion: 'v1',
  }, input);
}

// --- Unknowns ----------------------------------------------------------------------

function windowUnknowns(input: IntelligenceInput): IntelligenceUnknown[] {
  const out: IntelligenceUnknown[] = [];

  if (!input.metrics.available) {
    out.push({
      id: 'unknown:read-failed',
      statement: 'Call reporting could not be read for this period.',
      reason: 'The economics source did not respond. No figure is shown rather than a zero that would look like real activity.',
    });
    return out;
  }

  if (input.metrics.revenueCents === null && (input.metrics.totalCalls ?? 0) > 0) {
    out.push({
      id: 'unknown:revenue',
      statement: 'Revenue is unknown for this period even though calls were recorded.',
      reason: 'No call in the window carried a revenue value. That is reported as Unknown, never as $0.',
    });
  }

  const cov = input.metrics.revenueCoverage;
  if (cov !== null && cov < 1 && cov > 0) {
    out.push({
      id: 'unknown:revenue-coverage',
      statement: `Only ${Math.round(cov * 100)}% of calls carried a revenue value, so revenue and profit are lower bounds.`,
      reason: 'Totals sum the calls that were priced. Calls without a value add nothing rather than being counted as zero.',
    });
  }

  const profitCov = input.metrics.profitCoverage;
  if (profitCov !== null && profitCov < 0.5) {
    out.push({
      id: 'unknown:profit-coverage',
      statement: 'Profit is not reliable for this period.',
      reason: 'Payout or cost is missing on most calls. Profit computed over them would overstate margin, so margin findings are withheld.',
    });
  }

  if (!input.comparison) {
    out.push({
      id: 'unknown:no-comparison',
      statement: 'No comparison period is defined for this selection.',
      reason: 'Change, contribution and rank movement all need two periods, so none are produced.',
    });
  }

  out.push({
    id: 'unknown:causation',
    statement: 'Loop can identify which entities contributed to a change, but not what caused it.',
    reason: 'CallGrid reports outcomes, not the buyer capacity, caps, routing decisions, scheduling or demand conditions behind them.',
  });

  out.push({
    id: 'unknown:roster',
    statement: 'Entity counts describe who appeared this period, not who is configured.',
    reason: 'CallGrid exposes no roster endpoint, so a configured but idle buyer, vendor, source or campaign cannot be seen.',
  });

  if (input.includesLiveData) {
    out.push({
      id: 'unknown:in-progress',
      statement: 'This period is still in progress.',
      reason: input.comparisonBasis === 'elapsed_matched'
        ? 'The comparison is cut at the same elapsed point so the two are like-for-like, but both figures will keep moving.'
        : 'Figures will keep moving until the period completes.',
    });
  }

  return out;
}

// --- The engine ---------------------------------------------------------------------

const DIMENSIONS: IntelligenceDimension[] = ['buyers', 'vendors', 'sources', 'campaigns'];

function bySeverity(a: CallGridFinding, b: CallGridFinding): number {
  const s = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
  return s !== 0 ? s : b.confidence - a.confidence;
}

/**
 * Analyze one reporting period.
 *
 * Returns only what the data supports: on a quiet period with no significant
 * movement this legitimately returns no findings, and the surface says so rather
 * than manufacturing something to fill the panel.
 */
export function analyzeCallGrid(input: IntelligenceInput): CallGridIntelligence {
  const findings: CallGridFinding[] = [];
  const history = input.history ?? EMPTY_SERIES;

  if (input.reportOk && input.metrics.available) {
    // A — headline performance changes.
    const revenueChange = headlineFinding({
      metricKey: 'revenue', label: 'Revenue', ruleId: 'revenue-change',
      ladder: [0.1, 0.25, 0.4], minAbsolute: 25_000, minVolume: 10, minCoverage: 0.5,
      format: money, findingType: 'CHANGE',
      current: input.metrics.revenueCents, comparison: input.comparison?.revenueCents ?? null,
      coverage: input.metrics.revenueCoverage,
      providerFields: ['revenueCents'], formula: 'sum(revenueCents) where revenueCents IS NOT NULL',
    }, input);

    const profitChange = headlineFinding({
      metricKey: 'profit', label: 'Profit', ruleId: 'profit-change',
      ladder: [0.15, 0.3, 0.5], minAbsolute: 25_000, minVolume: 10, minCoverage: 0.5,
      format: money, findingType: 'MARGIN',
      current: input.metrics.profitCents, comparison: input.comparison?.profitCents ?? null,
      coverage: input.metrics.profitCoverage,
      providerFields: ['revenueCents', 'payoutCents', 'costCents'],
      formula: 'sum(revenueCents) - sum(payoutCents) - sum(costCents)',
    }, input);

    const volumeChange = headlineFinding({
      metricKey: 'totalCalls', label: 'Total calls', ruleId: 'volume-change',
      ladder: [0.15, 0.3, null], minAbsolute: 20, minVolume: 20, minCoverage: 0,
      format: count, findingType: 'VOLUME',
      current: input.metrics.totalCalls, comparison: input.comparison?.totalCalls ?? null,
      coverage: null,
      providerFields: ['sourceOccurredAt'], formula: 'count(calls in window)',
    }, input);

    for (const f of [revenueChange, profitChange, volumeChange]) if (f) findings.push(f);

    // B — who contributed to the headline revenue move.
    if (revenueChange?.absoluteChange != null && revenueChange.absoluteChange !== 0) {
      for (const dim of DIMENSIONS) {
        findings.push(...contributionFindings(input, dim, revenueChange.absoluteChange, revenueChange.severity));
      }
    }

    // C — volume versus value interpretation.
    const vv = volumeVersusValue(input);
    if (vv) findings.push(vv);

    // D — concentration (buyers and campaigns carry the commercial dependency).
    for (const dim of ['buyers', 'campaigns'] as const) {
      const f = concentrationFinding(input, dim);
      if (f) findings.push(f);
    }

    // E/F — inactivity and rank movement.
    for (const dim of DIMENSIONS) findings.push(...lifecycleFindings(input, dim));

    // H — billable efficiency.
    const eff = billableEfficiencyFinding(input);
    if (eff) findings.push(eff);

    // I — per-entity series findings: record periods, sustained fades, rising
    // dominance, emergence and consistency. Silent without a series.
    for (const dim of DIMENSIONS) {
      findings.push(...entitySeriesFindings(
        {
          now: input.now,
          windowLabel: input.windowLabel,
          comparisonLabel: input.comparisonLabel,
          includesLiveData: input.includesLiveData,
          windowRevenueCents: input.metrics.revenueCents,
          history,
        },
        dim,
        toEntityRows(input.dimensions[dim]),
        // One per rule per dimension on the Overview — four dimensions at two each
        // would bury the headline the brief exists to surface.
        1,
      ));
    }

    // J — anomalies. Distribution rules stay silent without a series rather than
    // degrading into a two-point comparison wearing an anomaly's label.
    findings.push(...detectAnomalies({
      now: input.now,
      windowLabel: input.windowLabel,
      comparisonLabel: input.comparisonLabel,
      includesLiveData: input.includesLiveData,
      metrics: input.metrics,
      comparison: input.comparison,
      dimensions: input.dimensions,
      history,
    }));
  }

  findings.sort(bySeverity);

  const changes = findings.filter((f) => f.findingType === 'CHANGE' || f.findingType === 'VOLUME' || f.findingType === 'MARGIN');
  const drivers = findings.filter((f) => f.findingType === 'DRIVER');
  const risks = findings.filter(
    (f) => f.findingType === 'RISK' || f.findingType === 'CONCENTRATION'
      || (f.findingType === 'MARGIN' && (f.percentageChange ?? 0) < 0)
      || (f.findingType === 'CHANGE' && (f.percentageChange ?? 0) < 0 && SEVERITY_RANK[f.severity] <= SEVERITY_RANK['NOTABLE']),
  );
  const opportunities = findings.filter(
    (f) => f.findingType === 'OPPORTUNITY'
      || (f.findingType === 'CHANGE' && (f.percentageChange ?? 0) > 0)
      || (f.findingType === 'MARGIN' && (f.percentageChange ?? 0) > 0),
  );
  const investigations = findings.filter((f) => f.recommendedReview !== null);

  const anomalies = findings.filter((f) => f.findingType === 'ANOMALY');

  const primaryChange = findings.find((f) => f.primaryMetric === 'revenue' && f.findingType === 'CHANGE') ?? null;
  const topConcern = risks[0] ?? null;
  const topOpportunity = opportunities[0] ?? null;

  const headline = buildHeadline(input, primaryChange);

  // --- Risk -------------------------------------------------------------------
  const toRiskRows = (rows: IntelligenceDimRow[]): RiskDimRow[] =>
    rows.map((r) => ({
      key: r.key, label: r.label, calls: r.calls,
      revenueCents: r.revenueCents, marginCents: r.marginCents,
    }));

  const risk = assessMarketplaceRisk({
    buyers: toRiskRows(input.dimensions.buyers),
    vendors: toRiskRows(input.dimensions.vendors),
    sources: toRiskRows(input.dimensions.sources),
    campaigns: toRiskRows(input.dimensions.campaigns),
    windowRevenueCents: input.metrics.revenueCents,
    revenueSeries: seriesOf(history, 'revenueCents'),
    bidRejectRate: input.bidRejectRate ?? null,
    rateLimitedShare: input.rateLimitedShare ?? null,
    includesLiveData: input.includesLiveData,
  });

  // --- Attention ordering -----------------------------------------------------
  // Recurrence is only knowable with a series. Passing null (rather than an empty
  // map) is what makes the novelty component WITHHOLD itself instead of scoring
  // every finding as brand new.
  const recurrence = history.points.length > 0 ? buildRecurrence(input, history) : null;
  const ranked = rankFindings(findings, {
    windowRevenueCents: input.metrics.revenueCents,
    recurrence,
    recurrenceWindow: recurrence ? history.points.length : null,
  });

  const briefItems = ranked.slice(0, 5);

  // --- Health -----------------------------------------------------------------
  // Consumes the risk model rather than recomputing concentration: a health panel
  // that disagreed with the risk panel would be worse than no health panel.
  const toHealthRows = (rows: IntelligenceDimRow[]): HealthDimRow[] =>
    rows.map((r) => ({ key: r.key, label: r.label, calls: r.calls, monetized: r.monetized, revenueCents: r.revenueCents }));

  const health = assessBusinessHealth({
    metrics: input.metrics,
    risk,
    revenueSeries: seriesOf(history, 'revenueCents'),
    profitSeries: seriesOf(history, 'profitCents'),
    callSeries: seriesOf(history, 'totalCalls'),
    dimensions: {
      buyers: toHealthRows(input.dimensions.buyers),
      vendors: toHealthRows(input.dimensions.vendors),
      campaigns: toHealthRows(input.dimensions.campaigns),
      sources: toHealthRows(input.dimensions.sources),
    },
    includesLiveData: input.includesLiveData,
  });

  // --- Opportunities ----------------------------------------------------------
  const toOppRows = (rows: IntelligenceDimRow[]): OpportunityRow[] =>
    rows.map((r) => ({ key: r.key, label: r.label, calls: r.calls, monetized: r.monetized, revenueCents: r.revenueCents }));

  const emptyByKey = new Map<string, OpportunityRow>();
  const byKey = (dim: IntelligenceDimension): ReadonlyMap<string, OpportunityRow> => {
    const src = input.comparisonByKey?.[dim];
    if (!src) return emptyByKey;
    const out = new Map<string, OpportunityRow>();
    for (const [k, r] of src) {
      out.set(k, { key: r.key, label: r.label, calls: r.calls, monetized: r.monetized, revenueCents: r.revenueCents });
    }
    return out;
  };

  const opportunityFindings = (input.reportOk && input.metrics.available)
    ? findOpportunities({
        now: input.now,
        windowLabel: input.windowLabel,
        comparisonLabel: input.comparisonLabel,
        includesLiveData: input.includesLiveData,
        windowRevenueCents: input.metrics.revenueCents,
        totalCalls: input.metrics.totalCalls,
        billableCalls: input.metrics.billableCalls,
        revenueCoverage: input.metrics.revenueCoverage,
        dimensions: {
          buyers: toOppRows(input.dimensions.buyers),
          vendors: toOppRows(input.dimensions.vendors),
          sources: toOppRows(input.dimensions.sources),
          campaigns: toOppRows(input.dimensions.campaigns),
        },
        comparisonByKey: {
          buyers: byKey('buyers'), vendors: byKey('vendors'),
          sources: byKey('sources'), campaigns: byKey('campaigns'),
        },
        history,
        risk,
      })
    : [];

  // --- Decision support -------------------------------------------------------
  const oppByFindingId = new Map(opportunityFindings.map((o) => [o.finding.id, o] as const));
  const decisionSupport = buildDecisionSupport(ranked, {
    opportunitiesByFindingId: oppByFindingId,
    revenueSeries: seriesOf(history, 'revenueCents'),
    periodsPerYear: input.periodsPerYear ?? null,
  });

  // --- Reasoning --------------------------------------------------------------
  // Runs over findings the engine already produced. It can establish arithmetic
  // attribution and formula lineage; it can never establish mechanism.
  const reasoning = reasonAboutFindings({
    findings,
    history,
    selectedPeriodLabel: input.windowLabel,
    includesLiveData: input.includesLiveData,
    entities: DIMENSIONS.flatMap((dim) =>
      input.dimensions[dim].slice(0, 5).map((r) => ({
        dimension: dim, key: r.key, name: r.label, revenueCents: r.revenueCents,
      })),
    ),
  });

  // --- The queue --------------------------------------------------------------
  // Merge BEFORE rank. `reasoning.clusters` already unions findings over measured
  // relations only; this is where that stops being a view and becomes the unit of
  // the product. Assembled here rather than in the surface so the Overview and a
  // subpage cannot disagree about what one Situation is.
  const queue = buildQueue(
    { reasoning, ranked, decisionSupport, opportunities: opportunityFindings },
    { reportOk: input.reportOk, periodLabel: input.windowLabel },
  );
  const briefing = buildBriefing(queue, { periodLabel: input.windowLabel });

  return {
    executiveSummary: {
      headline,
      primaryChange,
      drivers: drivers.slice(0, 3),
      topConcern,
      topOpportunity,
      recommendedReviews: investigations
        .slice(0, 3)
        .map((f) => f.recommendedReview!)
        .filter((r, i, all) => all.indexOf(r) === i),
    },
    brief: {
      items: briefItems,
      omittedCount: Math.max(0, ranked.length - briefItems.length),
      emptyReason: briefItems.length === 0 ? emptyBriefReason(input) : null,
      scoredWithoutHistory: recurrence === null,
    },
    risk,
    health,
    opportunityFindings,
    decisionSupport,
    reasoning,
    queue,
    briefing,
    findings,
    ranked,
    changes,
    drivers,
    risks,
    opportunities,
    anomalies,
    investigations,
    unknowns: [
      ...windowUnknowns(input),
      ...historyUnknowns(input, history),
      ...riskUnknownEntries(risk),
      ...healthUnknownEntries(health),
      ...opportunityUnknownEntries(opportunityFindings),
      ...reasoningUnknownEntries(reasoning),
      ...queueUnknowns(queue),
    ],
    evidenceReferences: findings.flatMap((f) => f.supportingEvidence),
  };
}

/**
 * How often each finding's rule+entity also fired across the historical series.
 *
 * Built by re-deriving, per prior period, only what is cheap and unambiguous:
 * whether that entity carried revenue at all. This deliberately under-claims —
 * it establishes that an entity was PRESENT and material before, not that the
 * identical finding fired. Over-claiming recurrence would suppress genuinely new
 * findings, which is the more damaging error.
 */
function buildRecurrence(input: IntelligenceInput, history: HistorySeries): Map<string, number> {
  const counts = new Map<string, number>();
  for (const dim of DIMENSIONS) {
    for (const row of input.dimensions[dim]) {
      const seriesKey = historyEntityKey(dim, row.key);
      const appearances = history.points.filter((p) => {
        const rev = p.entityRevenueCents[seriesKey];
        return rev !== undefined && rev !== null && rev > 0;
      }).length;
      // Same identity shape the scorer uses, so a lookup cannot silently miss.
      for (const ruleId of ['entity-contribution', 'entity-inactive', 'rank-movement', 'anomaly-entity-disappeared']) {
        counts.set(`${ruleId}::${row.key}`, appearances);
      }
    }
  }
  return counts;
}

/** Why the brief is empty — always specific, never a shrug. */
function emptyBriefReason(input: IntelligenceInput): string {
  if (!input.reportOk || !input.metrics.available) {
    return 'CallGrid reporting could not be read for this period, so no finding could be produced.';
  }
  if ((input.metrics.totalCalls ?? 0) === 0) {
    return `No calls were recorded in ${input.windowLabel.toLowerCase()}, so there is nothing to analyse.`;
  }
  if (!input.comparison) {
    return 'No comparison period is defined for this window, so no change could be evaluated.';
  }
  return 'No evidence-backed finding crossed the significance thresholds for this period.';
}

/** What the absence (or presence) of a series means for interpretation. */
function historyUnknowns(input: IntelligenceInput, history: HistorySeries): IntelligenceUnknown[] {
  if (history.points.length >= 4) return [];
  return [
    {
      id: 'no-historical-series',
      statement: 'Whether this period is unusual for this business, or simply different from the one before it.',
      reason: input.includesLiveData
        ? 'A historical range is built only from complete periods, and the selected period is still in progress. Select a completed period to establish one.'
        : `Loop needs at least 4 complete prior periods to establish a normal range; ${history.points.length} were available.`,
    },
  ];
}

function riskUnknownEntries(risk: MarketplaceRisk): IntelligenceUnknown[] {
  return riskUnknowns(risk).map((statement, i) => ({
    id: `risk-unknown-${i + 1}`,
    statement,
    reason: 'The risk model withholds a factor it cannot measure rather than scoring it as safe.',
  }));
}

/** The one sentence at the top of the page. Honest when there is nothing to say. */
function buildHeadline(input: IntelligenceInput, primary: CallGridFinding | null): string {
  if (!input.reportOk || !input.metrics.available) {
    return 'CallGrid reporting could not be read for this period.';
  }
  if ((input.metrics.totalCalls ?? 0) === 0) {
    return `No calls were recorded in ${input.windowLabel.toLowerCase()}.`;
  }
  if (primary) return primary.plainLanguageSummary;
  if (!input.comparison) {
    return `${count(input.metrics.totalCalls)} calls and ${money(input.metrics.revenueCents)} in revenue for this period. No comparison period is defined, so no change can be reported.`;
  }
  return (
    `${count(input.metrics.totalCalls)} calls and ${money(input.metrics.revenueCents)} in revenue. ` +
    `No change large enough to flag against ${(input.comparisonLabel ?? 'the comparison period').toLowerCase()}.`
  );
}

// --- Per-dimension intelligence (the subpages) -----------------------------------------

export interface DimensionIntelligence {
  findings: CallGridFinding[];
  unknowns: IntelligenceUnknown[];
  /** Ranked contribution table for the dimension. */
  contributions: AffectedEntity[];
  /** Findings with their Intelligence Score, attention-ordered. */
  ranked: ScoredFinding[];
  /** This dimension's health score. UNKNOWN, never HEALTHY, when unmeasurable. */
  health: HealthScore;
  /** Opportunities scoped to this dimension, most material first. */
  opportunities: Opportunity[];
  /** Risks scoped to this dimension. */
  risks: CallGridFinding[];
  /** Decision support cards for this dimension, ordered by review priority. */
  decisionSupport: DecisionSupportCard[];
  /** Reasoning scoped to this dimension's findings and entities. */
  reasoning: OperationalReasoning;
}

/**
 * The intelligence for one dimension page. Same engine, same rules, scoped to one
 * dimension — Buyers and the Overview cannot disagree because neither has its own
 * analysis path.
 */
export function analyzeDimension(input: IntelligenceInput, dim: IntelligenceDimension): DimensionIntelligence {
  const noun = DIM_NOUN[dim];
  const findings: CallGridFinding[] = [];
  const cur = input.dimensions[dim];
  const pri = input.comparisonDimensions[dim];

  const windowChange = absoluteChange(input.metrics.revenueCents, input.comparison?.revenueCents ?? null);

  if (input.reportOk && input.metrics.available) {
    if (windowChange !== null && windowChange !== 0) {
      findings.push(...contributionFindings(input, dim, windowChange, 'NOTABLE'));
    }
    const conc = concentrationFinding(input, dim);
    if (conc) findings.push(conc);
    findings.push(...lifecycleFindings(input, dim));
    findings.push(...efficiencyMovers(input, dim));

    // The dimension page has room for more than the Overview, so it takes the
    // default cap rather than the Overview's one-per-rule.
    findings.push(...entitySeriesFindings(
      {
        now: input.now,
        windowLabel: input.windowLabel,
        comparisonLabel: input.comparisonLabel,
        includesLiveData: input.includesLiveData,
        windowRevenueCents: input.metrics.revenueCents,
        history: input.history ?? EMPTY_SERIES,
      },
      dim,
      toEntityRows(cur),
    ));
  }

  findings.sort(bySeverity);

  const curTotal = totalRevenue(cur);
  const priTotal = totalRevenue(pri);
  const contributions = entityDeltas(cur, pri)
    .map((d) => toAffected(d, noun.entity, windowChange, curTotal, priTotal))
    .sort((a, b) => Math.abs(b.absoluteChange ?? 0) - Math.abs(a.absoluteChange ?? 0));

  const unknowns: IntelligenceUnknown[] = [
    {
      id: `unknown:${dim}:roster`,
      statement: `Only ${noun.many} with calls in this period appear.`,
      reason: `CallGrid exposes no ${noun.one} roster, so a configured ${noun.one} with no calls cannot be distinguished from one that does not exist.`,
    },
    {
      id: `unknown:${dim}:cause`,
      statement: `Loop cannot determine why an individual ${noun.one}'s volume or revenue changed.`,
      reason: `Capacity, caps, scheduling, routing and demand are not exposed at ${noun.one} grain.`,
    },
  ];

  if (dim === 'campaigns' || dim === 'vendors') {
    unknowns.push({
      id: `unknown:${dim}:margin`,
      statement: `Profit is not reliably attributable at ${noun.one} grain.`,
      reason: 'Payout and cost are recorded per call. Splitting them across entities by revenue share would be an assumption, not a measurement.',
    });
  }

  // Health and opportunities reuse the SAME models the Overview uses, scoped to
  // this dimension — a buyer health badge that disagreed with the Overview's
  // would be a second source of truth, which is the failure mode this repo is
  // most prone to.
  const full = analyzeCallGrid(input);
  const healthId: HealthDimensionId =
    dim === 'buyers' ? 'buyer' : dim === 'vendors' ? 'vendor'
      : dim === 'campaigns' ? 'campaign' : 'source';
  const health = full.health.dimensions.find((d) => d.id === healthId) ?? full.health.overall;

  const opportunities = full.opportunityFindings.filter((o) =>
    o.finding.affectedEntities.some((e) => e.entityType === noun.entity)
    || o.finding.id.includes(dim),
  );

  const ranked = rankFindings(findings, {
    windowRevenueCents: input.metrics.revenueCents,
    recurrence: null,
    recurrenceWindow: null,
  });

  const risks = findings.filter(
    (f) => f.findingType === 'RISK' || f.findingType === 'CONCENTRATION'
      || (f.findingType === 'MARGIN' && (f.percentageChange ?? 0) < 0),
  );

  const dimOppByFindingId = new Map(opportunities.map((o) => [o.finding.id, o] as const));
  const decisionSupport = buildDecisionSupport(ranked, {
    opportunitiesByFindingId: dimOppByFindingId,
    revenueSeries: seriesOf(input.history ?? EMPTY_SERIES, 'revenueCents'),
    periodsPerYear: input.periodsPerYear ?? null,
  });

  const dimReasoning = reasonAboutFindings({
    findings,
    history: input.history ?? EMPTY_SERIES,
    selectedPeriodLabel: input.windowLabel,
    includesLiveData: input.includesLiveData,
    entities: cur.slice(0, 8).map((r) => ({
      dimension: dim, key: r.key, name: r.label, revenueCents: r.revenueCents,
    })),
  });

  return {
    findings, unknowns, contributions, ranked, health, opportunities, risks,
    decisionSupport, reasoning: dimReasoning,
  };
}

/** Entities whose revenue per billable call moved most — the efficiency story a
 *  dimension page needs, separate from raw volume. */
function efficiencyMovers(input: IntelligenceInput, dim: IntelligenceDimension): CallGridFinding[] {
  const noun = DIM_NOUN[dim];
  const cur = input.dimensions[dim];
  const priByKey = new Map(input.comparisonDimensions[dim].map((r) => [r.key, r] as const));

  const moves = cur
    .map((r) => {
      const p = priByKey.get(r.key);
      if (!p) return null;
      // Both sides need a real per-call value and a usable sample.
      if (r.monetized < 10 || p.monetized < 10) return null;
      const curValue = revenuePerBillableCall(r.revenueCents, r.monetized);
      const priValue = revenuePerBillableCall(p.revenueCents, p.monetized);
      const rel = percentageChange(curValue, priValue);
      if (rel === null || Math.abs(rel) < 0.15) return null;
      return { row: r, prior: p, curValue, priValue, rel };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort((a, b) => Math.abs(b.rel) - Math.abs(a.rel));

  return moves.slice(0, 2).map((m) => {
    const improved = m.rel > 0;
    return makeFinding({
      id: `efficiency:${dim}:${m.row.key}`,
      findingType: improved ? 'OPPORTUNITY' : 'RISK',
      title: `${m.row.label} revenue per billable call ${direction(m.rel)} ${pct(m.rel)}`,
      plainLanguageSummary:
        `${m.row.label} earned ${money(m.curValue)} per billable call this period, against ${money(m.priValue)} in ` +
        `${(input.comparisonLabel ?? 'the comparison period').toLowerCase()} — across ${count(m.row.monetized)} and ${count(m.prior.monetized)} billable calls respectively.`,
      classification: 'DERIVED',
      severity: Math.abs(m.rel) >= 0.3 ? 'NOTABLE' : 'INFORMATIONAL',
      confidence: deriveConfidence(m.row.revenueCoverage, m.row.monetized + m.prior.monetized, 10),
      primaryMetric: 'revenuePerBillableCall',
      currentValue: m.curValue,
      comparisonValue: m.priValue,
      percentageChange: m.rel,
      evidence: [
        { metricKey: 'revenue', entityType: noun.entity, entityId: m.row.key, entityName: m.row.label, window: input.windowLabel, providerField: 'revenueCents', normalizedValue: m.row.revenueCents, classification: 'DERIVED', completeness: m.row.revenueCoverage },
        { metricKey: 'billableCalls', entityType: noun.entity, entityId: m.row.key, entityName: m.row.label, window: input.windowLabel, providerField: 'monetized', normalizedValue: m.row.monetized, classification: 'VERIFIED' },
        { metricKey: 'revenuePerBillableCall', entityType: noun.entity, entityId: m.row.key, entityName: m.row.label, window: input.windowLabel, derivedValue: m.curValue, formula: 'revenue / billableCalls', formulaVersion: 'v1', classification: 'DERIVED', sourceType: 'derived' },
        { metricKey: 'revenuePerBillableCall', entityType: noun.entity, entityId: m.row.key, entityName: m.row.label, window: input.comparisonLabel ?? 'comparison period', derivedValue: m.priValue, formula: 'revenue / billableCalls', formulaVersion: 'v1', classification: 'DERIVED', sourceType: 'derived' },
      ],
      limitations: [
        'Per-call value can move because the mix of calls changed, without any individual price changing.',
        ...liveLimitation(input),
      ],
      unknowns: [`CallGrid does not expose the pricing or acceptance rules behind this ${noun.one}'s per-call value.`],
      recommendedReview: improved
        ? `Confirm what changed in this ${noun.one}'s traffic before assuming the improvement will persist.`
        : `Review this ${noun.one}'s call mix and pricing for the period.`,
      recommendedActionType: 'REVIEW_ENTITY',
      actionTarget: `${dim}:${m.row.key}`,
      actionSafety: 'SAFE_TO_REVIEW',
      ruleId: 'value-per-call',
      ruleVersion: 'v1',
    }, input);
  });
}

// --- Self-check -------------------------------------------------------------------

/** Every violation across a set of findings — used by the test suite to prove no
 *  rule can emit an unevidenced, unversioned or unsafely-worded conclusion. */
export function allFindingViolations(findings: readonly CallGridFinding[]): string[] {
  return findings.flatMap((f) => findingViolations(f).map((v) => `${f.id}: ${v}`));
}

export { coverage };

/** Project canonical dimension rows onto the entity-intelligence contract. */
function toEntityRows(rows: readonly IntelligenceDimRow[]): EntityRow[] {
  return rows.map((r) => ({
    key: r.key, label: r.label, calls: r.calls, revenueCents: r.revenueCents,
  }));
}


function healthUnknownEntries(health: BusinessHealth): IntelligenceUnknown[] {
  return healthUnknowns(health).map((statement, i) => ({
    id: `health-unknown-${i + 1}`,
    statement,
    reason: 'A health dimension whose signals could not be measured is reported Unknown, never Healthy — a green badge over absent data is worse than no badge.',
  }));
}

function opportunityUnknownEntries(opportunities: readonly Opportunity[]): IntelligenceUnknown[] {
  return opportunityUnknowns(opportunities).map((statement, i) => ({
    id: `opportunity-unknown-${i + 1}`,
    statement,
    reason: 'Opportunity amounts are measured exposure or an arithmetic gap. Loop never forecasts what would be gained.',
  }));
}


function reasoningUnknownEntries(reasoning: OperationalReasoning): IntelligenceUnknown[] {
  return reasoning.unknowns.map((statement, i) => ({
    id: `reasoning-unknown-${i + 1}`,
    statement,
    reason: 'The reasoning layer relates findings by arithmetic attribution and metric-formula lineage. Neither establishes mechanism, so no relationship it reports is a causal claim.',
  }));
}
