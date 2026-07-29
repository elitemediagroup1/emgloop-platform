// The Decision Support layer.
//
// THE SHIFT THIS ENCODES
// A recommendation says "do X". Decision support says "here is what was measured,
// here is why it matters, here is what you would need to know before deciding,
// and here is the decision that deserves your review". The second is the only one
// Loop can honestly produce, because the inputs that determine the first —
// contractual caps, available inventory, budgets, commercial terms, demand
// elasticity — are not in this system.
//
// LOOP OWNS THE FACTS. OPERATORS OWN THE DECISIONS.
// Every card renders those two in physically separate blocks, so a reader can
// never mistake one for the other. `measuredFacts` come only from a finding's
// structured evidence — values a row in the database produced. `businessJudgment`
// is explicitly labelled as belonging to the operator, and nothing in it is
// phrased as an instruction.
//
// THIS IS A PROJECTION, NOT A NEW CONTRACT
// Every field below is derived from a `CallGridFinding` that already exists. No
// rule was forked, no metric redefined, no second analysis path created. If the
// engine did not conclude it, this layer cannot invent it.

import {
  SEVERITY_RANK,
  type CallGridEvidenceReference,
  type CallGridFinding,
  type Severity,
} from './callgrid-intelligence';
import type { IntelligenceScore } from './callgrid-scoring';
import { MIN_SERIES_POINTS, volatility, type SeriesStat } from './callgrid-history';
import type { Opportunity } from './callgrid-opportunity';

export const DECISION_SUPPORT_VERSION = 'v1';

// --- Review categories ----------------------------------------------------------

export const REVIEW_CATEGORIES = [
  'TRAFFIC_ALLOCATION',
  'BUYER',
  'VENDOR',
  'CAMPAIGN',
  'BID_STRATEGY',
  'SOURCE_QUALITY',
  'OPERATIONAL_INVESTIGATION',
  'DATA_QUALITY',
  'COMMERCIAL',
  'FINANCIAL',
] as const;
export type ReviewCategory = (typeof REVIEW_CATEGORIES)[number];

export const REVIEW_CATEGORY_LABEL: Record<ReviewCategory, string> = {
  TRAFFIC_ALLOCATION: 'Traffic Allocation Review',
  BUYER: 'Buyer Review',
  VENDOR: 'Vendor Review',
  CAMPAIGN: 'Campaign Review',
  BID_STRATEGY: 'Bid Strategy Review',
  SOURCE_QUALITY: 'Source Quality Review',
  OPERATIONAL_INVESTIGATION: 'Operational Investigation',
  DATA_QUALITY: 'Data Quality Review',
  COMMERCIAL: 'Commercial Review',
  FINANCIAL: 'Financial Review',
};

/**
 * Which review a finding belongs to.
 *
 * Resolved from the rule and the entity it concerns — never from free text, so a
 * reworded finding cannot silently change category. Rules are checked most
 * specific first.
 */
export function reviewCategoryOf(finding: CallGridFinding): ReviewCategory {
  const rule = finding.ruleId;
  const entity = finding.affectedEntities[0]?.entityType ?? null;

  // Data trustworthiness outranks everything: if the measurement is in doubt, the
  // review is about the data, not the business decision it would inform.
  if (rule.includes('coverage') || finding.classification === 'UNKNOWN') return 'DATA_QUALITY';

  if (rule.startsWith('bid-') || rule.includes('bid')) return 'BID_STRATEGY';
  if (rule === 'opportunity-efficiency-gap' || rule.includes('billable-efficiency')) return 'SOURCE_QUALITY';
  if (rule === 'profit-change' || rule === 'anomaly-profit-divergence' || finding.primaryMetric === 'profit') return 'FINANCIAL';
  if (rule === 'opportunity-diversification' || rule === 'entity-rising-dominance' || rule.includes('concentration')) return 'COMMERCIAL';
  if (rule === 'anomaly-entity-disappeared' || rule === 'entity-dormant' || rule === 'opportunity-returning-entity') return 'OPERATIONAL_INVESTIGATION';

  if (entity === 'buyer') return 'BUYER';
  if (entity === 'vendor') return 'VENDOR';
  if (entity === 'campaign') return 'CAMPAIGN';
  if (entity === 'source') return 'SOURCE_QUALITY';
  if (entity === 'bid_source' || entity === 'bid_destination') return 'BID_STRATEGY';

  if (finding.primaryMetric === 'totalCalls' || finding.primaryMetric === 'billableRate') return 'TRAFFIC_ALLOCATION';
  return 'OPERATIONAL_INVESTIGATION';
}

// --- Evidence strength ----------------------------------------------------------

export type EvidenceStrength = 'HIGH' | 'MODERATE' | 'LOW' | 'INSUFFICIENT';

export const EVIDENCE_STRENGTH_LABEL: Record<EvidenceStrength, string> = {
  HIGH: 'High Confidence',
  MODERATE: 'Moderate Confidence',
  LOW: 'Low Confidence',
  INSUFFICIENT: 'Insufficient Evidence',
};

export const EVIDENCE_STRENGTH_RANK: Record<EvidenceStrength, number> = {
  HIGH: 0, MODERATE: 1, LOW: 2, INSUFFICIENT: 3,
};

/**
 * How strong the evidence behind a finding is.
 *
 * Deterministic over the finding's own confidence and the completeness recorded
 * on its evidence — never a model's self-assessment. A finding the engine already
 * marked INSUFFICIENT_EVIDENCE stays insufficient regardless of arithmetic:
 * upgrading it here would let this layer overrule the rule that produced it.
 */
export function evidenceStrengthOf(finding: CallGridFinding): EvidenceStrength {
  if (finding.actionSafety === 'INSUFFICIENT_EVIDENCE') return 'INSUFFICIENT';

  const completenesses = finding.supportingEvidence
    .map((e) => e.completeness)
    .filter((c): c is number => c !== null);
  const worstCoverage = completenesses.length > 0 ? Math.min(...completenesses) : 1;

  // Coverage caps strength: a conclusion drawn over half-priced rows cannot be
  // high-confidence however tight the arithmetic is.
  const effective = Math.min(finding.confidence, 0.35 + 0.65 * worstCoverage);

  if (effective >= 0.8) return 'HIGH';
  if (effective >= 0.62) return 'MODERATE';
  if (effective >= 0.45) return 'LOW';
  return 'INSUFFICIENT';
}

// --- Review priority ------------------------------------------------------------

/**
 * When a person should look at this — displayed as "Review Priority".
 *
 * Named `ReviewUrgency` in code because `ReviewPriority` is already taken by the
 * bid module's LOW/MEDIUM/HIGH/CRITICAL ordering band. Two exported types sharing
 * one name is how a codebase grows a second vocabulary for the same idea, and
 * these are genuinely different: that one ranks bid work, this one is a timeframe.
 */
export type ReviewUrgency = 'IMMEDIATE' | 'TODAY' | 'THIS_WEEK' | 'MONITOR' | 'INFORMATIONAL';

export const REVIEW_URGENCY_LABEL: Record<ReviewUrgency, string> = {
  IMMEDIATE: 'Immediate',
  TODAY: 'Today',
  THIS_WEEK: 'This Week',
  MONITOR: 'Monitor',
  INFORMATIONAL: 'Informational',
};

export const REVIEW_URGENCY_RANK: Record<ReviewUrgency, number> = {
  IMMEDIATE: 0, TODAY: 1, THIS_WEEK: 2, MONITOR: 3, INFORMATIONAL: 4,
};

/**
 * When a person should look at this.
 *
 * Urgency requires BOTH materiality and trustworthy evidence. A CRITICAL finding
 * resting on insufficient evidence is not Immediate — it is a Data Quality
 * review, because acting urgently on a number that may be wrong is worse than
 * waiting. Good news is never urgent regardless of size.
 */
export function reviewPriorityOf(
  finding: CallGridFinding,
  strength: EvidenceStrength,
  score: IntelligenceScore | null,
): ReviewUrgency {
  if (strength === 'INSUFFICIENT') return 'MONITOR';

  const adverse =
    (finding.percentageChange !== null && finding.percentageChange < 0 &&
      (finding.primaryMetric === 'revenue' || finding.primaryMetric === 'profit' || finding.primaryMetric === 'totalCalls')) ||
    finding.findingType === 'RISK' ||
    finding.findingType === 'ANOMALY';

  // Opportunities and INFORMATIONAL findings are context, never an alarm.
  if (finding.severity === 'INFORMATIONAL') return 'INFORMATIONAL';
  if (finding.findingType === 'OPPORTUNITY' && !adverse) return 'THIS_WEEK';

  const sev = SEVERITY_RANK[finding.severity];
  const points = score?.score ?? 0;

  if (adverse && sev === SEVERITY_RANK.CRITICAL && strength === 'HIGH') return 'IMMEDIATE';
  if (adverse && (sev <= SEVERITY_RANK.HIGH || points >= 70)) return 'TODAY';
  if (adverse || points >= 50) return 'THIS_WEEK';
  if (finding.findingType === 'CONCENTRATION') return 'MONITOR';
  return 'MONITOR';
}

// --- Business impact ------------------------------------------------------------

export type ImpactKind =
  | 'revenue_change' | 'profit_change' | 'volume_change'
  | 'revenue_exposure' | 'measured_gap' | 'concentration' | 'none';

export interface BusinessImpact {
  kind: ImpactKind;
  /** Measured amount in cents. Null when this finding has no monetary dimension. */
  amountCents: number | null;
  /** What the amount IS — never "upside" or "gain". */
  label: string;
  /** One sentence stating the impact in business terms. */
  statement: string;
  /**
   * A conditional annualization, offered ONLY when the series shows the figure is
   * stable enough for the assumption to be defensible. Null otherwise, with the
   * reason — projecting a volatile figure forward is how a number becomes fiction.
   */
  annualizedCents: number | null;
  annualizationBasis: string | null;
}

const NO_IMPACT: BusinessImpact = {
  kind: 'none', amountCents: null,
  label: 'Not quantifiable',
  statement: 'This finding has no monetary dimension that Loop can measure.',
  annualizedCents: null, annualizationBasis: null,
};

function money(cents: number): string {
  return '$' + Math.round(Math.abs(cents) / 100).toLocaleString('en-US');
}

/**
 * Quantify the impact of a finding.
 *
 * `periodsPerYear` lets a caller annualize, but annualization is REFUSED unless a
 * series exists and revenue volatility is low enough that "if this persists" is a
 * defensible premise rather than a wish.
 */
export function businessImpactOf(
  finding: CallGridFinding,
  opportunity: Opportunity | null,
  context: {
    revenueSeries: readonly (number | null)[];
    periodsPerYear: number | null;
  },
): BusinessImpact {
  const base = rawImpact(finding, opportunity);
  if (base.amountCents === null || context.periodsPerYear === null || context.periodsPerYear <= 0) {
    return base;
  }

  const v: SeriesStat = volatility(context.revenueSeries);
  if (v.value === null) {
    // Always lead with WHAT was withheld, then why. The underlying statistic's
    // reason explains a failed calculation; on its own it leaves the reader
    // unaware that an annual figure was even considered and declined.
    return {
      ...base,
      annualizationBasis:
        'An annual figure is withheld: ' +
        (v.reason
          ? v.reason.charAt(0).toLowerCase() + v.reason.slice(1)
          : `it needs at least ${MIN_SERIES_POINTS} complete prior periods to show the amount is stable enough to project.`),
    };
  }
  // Above 35% period-to-period variation, "if this persists" is not a premise a
  // person should plan against, so no annual number is offered at all.
  if (v.value > 0.35) {
    return {
      ...base,
      annualizationBasis:
        `An annual figure is withheld: revenue varies by ${Math.round(v.value * 100)}% of its own average across ` +
        `${v.usablePoints} periods, so projecting this period forward would not be defensible.`,
    };
  }

  const annual = Math.round(base.amountCents * context.periodsPerYear);
  return {
    ...base,
    annualizedCents: annual,
    annualizationBasis:
      `${money(annual)} if the current rate persists for a full year (${context.periodsPerYear} periods of this length). ` +
      `Offered because revenue has held within ${Math.round(v.value * 100)}% of its average across ${v.usablePoints} periods. ` +
      `This is a conditional projection, not a forecast — it assumes nothing changes.`,
  };
}

function rawImpact(finding: CallGridFinding, opportunity: Opportunity | null): BusinessImpact {
  if (opportunity && opportunity.estimatedImpactCents !== null) {
    const isGap = opportunity.impactBasis === 'measured_gap';
    return {
      kind: isGap ? 'measured_gap' : 'revenue_exposure',
      amountCents: opportunity.estimatedImpactCents,
      label: opportunity.impactLabel,
      statement: isGap
        ? `${money(opportunity.estimatedImpactCents)} is the arithmetic difference against the period's own rate. It is a gap in the numbers, not a promise of recoverable revenue.`
        : `${money(opportunity.estimatedImpactCents)} of measured revenue is currently exposed to this. It is what is at stake, not what acting would gain.`,
      annualizedCents: null, annualizationBasis: null,
    };
  }

  const change = finding.absoluteChange;
  if (change !== null && change !== 0) {
    if (finding.primaryMetric === 'revenue') {
      return {
        kind: 'revenue_change', amountCents: change,
        label: change < 0 ? 'Measured revenue decline' : 'Measured revenue increase',
        statement: `Revenue moved by ${money(change)} against the comparison period.`,
        annualizedCents: null, annualizationBasis: null,
      };
    }
    if (finding.primaryMetric === 'profit') {
      return {
        kind: 'profit_change', amountCents: change,
        label: change < 0 ? 'Measured profit decline' : 'Measured profit increase',
        statement: `Profit moved by ${money(change)} against the comparison period.`,
        annualizedCents: null, annualizationBasis: null,
      };
    }
    if (finding.primaryMetric === 'totalCalls') {
      return {
        kind: 'volume_change', amountCents: null,
        label: 'Measured volume change',
        statement: `Call volume moved by ${Math.abs(change).toLocaleString('en-US')} calls. Loop cannot attach a value to that without a per-call revenue for the affected traffic.`,
        annualizedCents: null, annualizationBasis: null,
      };
    }
  }

  if (finding.primaryMetric === 'revenueShare' && finding.currentValue !== null) {
    return {
      kind: 'concentration', amountCents: null,
      label: 'Dependency share',
      statement: `${Math.round(finding.currentValue * 100)}% of revenue depends on this entity. The dependency is measured; the consequence of it depends on commercial terms Loop cannot see.`,
      annualizedCents: null, annualizationBasis: null,
    };
  }

  return NO_IMPACT;
}

// --- The card -------------------------------------------------------------------

/** A fact taken directly from a finding's evidence. Nothing here is interpretation. */
export interface MeasuredFact {
  metric: string;
  entity: string | null;
  window: string;
  value: string;
  /** The versioned formula, when the value was derived rather than reported. */
  formula: string | null;
  /** Directly reported by the provider, or calculated by Loop. */
  reported: boolean;
}

export interface DecisionSupportCard {
  findingId: string;
  title: string;
  category: ReviewCategory;
  evidenceStrength: EvidenceStrength;
  reviewPriority: ReviewUrgency;
  /** The measured fact, stated without interpretation. */
  observation: string;
  /** Why it matters. This is Loop's reading of the fact, and is labelled as such. */
  interpretation: string;
  businessImpact: BusinessImpact;
  /** The decision a person should evaluate. Review language only. */
  recommendedReview: string | null;
  /** What Loop does not know that prevents a stronger conclusion. First-class. */
  missingInformation: string[];
  /** Facts, from evidence only. Loop owns these. */
  measuredFacts: MeasuredFact[];
  /** What the operator must decide. Loop does not. */
  businessJudgment: string[];
  finding: CallGridFinding;
  score: IntelligenceScore | null;
  version: string;
}

function factOf(e: CallGridEvidenceReference): MeasuredFact {
  const raw = e.normalizedValue ?? e.rawValue;
  const value = e.derivedValue ?? raw;
  return {
    metric: e.metricKey,
    entity: e.entityName ?? e.entityId ?? null,
    window: e.window,
    value: value === null || value === undefined ? 'Not reported' : value.toLocaleString('en-US'),
    formula: e.formula ? `${e.formula}${e.formulaVersion ? ` (${e.formulaVersion})` : ''}` : null,
    reported: e.classification === 'VERIFIED',
  };
}

/**
 * The observation — the measured fact, with the interpretation stripped out.
 *
 * Built from structured fields rather than by slicing the summary text, so it
 * cannot drift when a rule is reworded.
 */
function observationOf(finding: CallGridFinding): string {
  const parts: string[] = [];
  const metric = finding.primaryMetric;

  if (finding.currentValue !== null) {
    const isMoney = metric === 'revenue' || metric === 'profit' || metric === 'revenuePerBillableCall';
    const cur = isMoney ? money(finding.currentValue) : finding.currentValue.toLocaleString('en-US');
    parts.push(`${metric} measured ${cur} in ${finding.currentWindow}`);
    if (finding.comparisonValue !== null && finding.comparisonWindow) {
      const prior = isMoney ? money(finding.comparisonValue) : finding.comparisonValue.toLocaleString('en-US');
      parts.push(`against ${prior} in ${finding.comparisonWindow}`);
    }
  }

  if (parts.length === 0) {
    // No numeric pair — the evidence count is still a statement of fact.
    return `Measured across ${finding.supportingEvidence.length} evidence ${finding.supportingEvidence.length === 1 ? 'point' : 'points'} for ${finding.currentWindow}.`;
  }
  return parts.join(' ') + '.';
}

/**
 * What the operator must decide, given what Loop cannot see.
 *
 * Derived from the finding's own unknowns rather than a generic list, so a card
 * never claims to be missing something it actually has.
 */
function businessJudgmentOf(finding: CallGridFinding, category: ReviewCategory): string[] {
  const out: string[] = [];
  if (finding.recommendedReview) {
    out.push(`Whether the observation above warrants a ${REVIEW_CATEGORY_LABEL[category].toLowerCase()}.`);
  }
  switch (category) {
    case 'COMMERCIAL':
      out.push('Whether the current dependency is acceptable under existing commercial terms.');
      break;
    case 'TRAFFIC_ALLOCATION':
    case 'SOURCE_QUALITY':
      out.push('Whether traffic should be allocated differently, given capacity and commitments Loop cannot see.');
      break;
    case 'FINANCIAL':
      out.push('Whether the margin movement is acceptable against the commercial terms in force.');
      break;
    case 'BID_STRATEGY':
      out.push('Whether bid configuration should change, given the strategy and floors Loop cannot see.');
      break;
    default:
      out.push('What action, if any, the observation justifies.');
  }
  return out;
}

/**
 * Project a finding into a decision support card.
 *
 * Everything is derived. If the engine did not conclude it, this cannot invent it.
 */
export function toDecisionSupportCard(
  finding: CallGridFinding,
  options: {
    score?: IntelligenceScore | null;
    opportunity?: Opportunity | null;
    revenueSeries?: readonly (number | null)[];
    periodsPerYear?: number | null;
  } = {},
): DecisionSupportCard {
  const category = reviewCategoryOf(finding);
  const evidenceStrength = evidenceStrengthOf(finding);
  const score = options.score ?? null;

  return {
    findingId: finding.id,
    title: finding.title,
    category,
    evidenceStrength,
    reviewPriority: reviewPriorityOf(finding, evidenceStrength, score),
    observation: observationOf(finding),
    interpretation: finding.plainLanguageSummary,
    businessImpact: businessImpactOf(finding, options.opportunity ?? null, {
      revenueSeries: options.revenueSeries ?? [],
      periodsPerYear: options.periodsPerYear ?? null,
    }),
    recommendedReview: finding.recommendedReview,
    // Unknowns and limitations both describe what stops a stronger conclusion, and
    // an operator does not care which bucket the engine filed them under.
    missingInformation: [...new Set([...finding.unknowns, ...finding.limitations])],
    measuredFacts: finding.supportingEvidence.map(factOf),
    businessJudgment: businessJudgmentOf(finding, category),
    finding,
    score,
    version: DECISION_SUPPORT_VERSION,
  };
}

/** Order cards the way an operator works: soonest review first, strongest evidence first. */
export function byReviewPriority(a: DecisionSupportCard, b: DecisionSupportCard): number {
  const p = REVIEW_URGENCY_RANK[a.reviewPriority] - REVIEW_URGENCY_RANK[b.reviewPriority];
  if (p !== 0) return p;
  const e = EVIDENCE_STRENGTH_RANK[a.evidenceStrength] - EVIDENCE_STRENGTH_RANK[b.evidenceStrength];
  if (e !== 0) return e;
  const s = (b.score?.score ?? 0) - (a.score?.score ?? 0);
  if (s !== 0) return s;
  return a.findingId.localeCompare(b.findingId);
}

/** Build and order a set of cards in one pass. */
export function buildDecisionSupport(
  findings: readonly { finding: CallGridFinding; score?: IntelligenceScore | null }[],
  context: {
    opportunitiesByFindingId?: ReadonlyMap<string, Opportunity>;
    revenueSeries?: readonly (number | null)[];
    periodsPerYear?: number | null;
  } = {},
): DecisionSupportCard[] {
  return findings
    .map((f) =>
      toDecisionSupportCard(f.finding, {
        score: f.score ?? null,
        opportunity: context.opportunitiesByFindingId?.get(f.finding.id) ?? null,
        revenueSeries: context.revenueSeries,
        periodsPerYear: context.periodsPerYear,
      }),
    )
    .sort(byReviewPriority);
}

export type { Severity };
