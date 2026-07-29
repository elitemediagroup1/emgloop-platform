// CallGrid Intelligence — the finding, evidence and significance contracts.
//
// CallGrid reports the marketplace; Loop explains it. This module defines what an
// explanation is allowed to be. Every statement the product makes about the
// business is a `CallGridFinding`, and a finding that cannot name its evidence,
// its limitations and the rule that produced it is not a finding — it is an
// opinion, and this platform does not ship opinions as intelligence.
//
// Three rules are enforced by the types, not by review:
//   1. No finding without evidence  (`supportingEvidence` is non-empty by check)
//   2. No finding without a rule id + version (so any conclusion is reproducible)
//   3. No recommendation outside the safe vocabulary (see RECOMMENDATION_VERBS)
//
// Pure declarations. No I/O, no clock — `now` is passed in by the caller.

import type { MetricClassification } from './callgrid-metric-contract';

export type { MetricClassification };

// --- Finding taxonomy ---------------------------------------------------------

export const FINDING_TYPES = [
  'CHANGE',          // a headline metric moved
  'DRIVER',          // an entity accounted for a share of that move
  'RISK',
  'OPPORTUNITY',
  'ANOMALY',
  'CONCENTRATION',   // dependency on a small number of entities
  'MARGIN',
  'VOLUME',
  'QUALITY',
  'BID_REJECTION',   // source-grain bid outcome
  'BID_DESTINATION', // destination-grain ping outcome
  'OPERATIONAL',
  'UNKNOWN',
] as const;
export type FindingType = (typeof FINDING_TYPES)[number];

export const SEVERITIES = ['INFORMATIONAL', 'NOTABLE', 'HIGH', 'CRITICAL'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const SEVERITY_RANK: Record<Severity, number> = {
  CRITICAL: 0, HIGH: 1, NOTABLE: 2, INFORMATIONAL: 3,
};

/**
 * How safe it is to act on a finding.
 *
 * Nothing here authorises an action. The strongest verdict is still only
 * "safe to review" — Loop surfaces what a person should look at, and the person
 * decides what to change.
 */
export const ACTION_SAFETY = [
  'SAFE_TO_REVIEW',
  'REQUIRES_HUMAN_JUDGMENT',
  'INSUFFICIENT_EVIDENCE',
  'NO_ACTION',
] as const;
export type ActionSafety = (typeof ACTION_SAFETY)[number];

export type EntityType = 'buyer' | 'vendor' | 'source' | 'campaign' | 'bid_source' | 'bid_destination' | 'window';

// --- Evidence -----------------------------------------------------------------

export type EvidenceSourceType = 'call_projection' | 'bid_source_snapshot' | 'ping_destination_snapshot' | 'derived';

/**
 * One inspectable fact behind a finding. The evidence drawer renders these; if a
 * number cannot be traced to one of these rows, it may not appear on screen.
 */
export interface CallGridEvidenceReference {
  id: string;
  findingId: string;
  sourceType: EvidenceSourceType;
  /** The provider report or canonical service the value came from. */
  providerReport: string;
  metricKey: string;
  entityType: EntityType;
  entityId: string | null;
  entityName: string | null;
  /** Which period this value describes, in operator language. */
  window: string;
  /** The provider field, when the value maps to one. */
  providerField: string | null;
  /** The value as the provider expressed it (cents, counts, percent points). */
  rawValue: number | null;
  /** The value after normalization into our units. */
  normalizedValue: number | null;
  /** The value after our formula, when the metric is DERIVED. */
  derivedValue: number | null;
  formula: string | null;
  formulaVersion: string | null;
  classification: MetricClassification;
  /** Fraction of the population that reported the value, when partial. */
  completeness: number | null;
  notes: string | null;
}

// --- Affected entities and drivers ---------------------------------------------

export interface AffectedEntity {
  entityType: EntityType;
  entityId: string;
  entityName: string;
  currentValue: number | null;
  comparisonValue: number | null;
  absoluteChange: number | null;
  /** Share (0–1) of the window's total change this entity accounts for. */
  contributionToChange: number | null;
  currentShare: number | null;
  comparisonShare: number | null;
  currentRank: number | null;
  comparisonRank: number | null;
}

// --- The finding ---------------------------------------------------------------

export interface CallGridFinding {
  id: string;
  findingType: FindingType;
  title: string;
  /** One or two sentences an operator can read without knowing the vocabulary. */
  plainLanguageSummary: string;
  classification: MetricClassification;
  severity: Severity;
  /** 0–1. Deterministic: derived from data completeness and sample size, never
   *  from a model's self-assessment. */
  confidence: number;
  currentWindow: string;
  comparisonWindow: string | null;
  primaryMetric: string;
  currentValue: number | null;
  comparisonValue: number | null;
  absoluteChange: number | null;
  percentageChange: number | null;
  affectedEntities: AffectedEntity[];
  /** Contributing entities, most significant first. */
  drivers: AffectedEntity[];
  supportingEvidence: CallGridEvidenceReference[];
  /** What constrains this conclusion — always populated, never an empty gesture. */
  limitations: string[];
  /** What Loop specifically cannot determine about this finding. */
  unknowns: string[];
  /** What a person should go and check. Review language only. */
  recommendedReview: string | null;
  recommendedActionType: string | null;
  actionTarget: string | null;
  actionSafety: ActionSafety;
  createdAt: string; // ISO, from the injected clock
  ruleId: string;
  ruleVersion: string;
}

// --- Recommendation safety ------------------------------------------------------
// A recommendation may tell someone to go and LOOK at something. It may never
// tell them to change a bid, a cap, a route or a payout, because Loop cannot see
// the constraints those decisions depend on.

export const RECOMMENDATION_VERBS = [
  'Review', 'Investigate', 'Confirm', 'Compare', 'Check',
  'Evaluate', 'Monitor', 'Contact', 'Consider', 'Validate',
] as const;
export type RecommendationVerb = (typeof RECOMMENDATION_VERBS)[number];

/** Verbs that assert an outcome Loop cannot support. Kept explicit so the test
 *  suite can prove no generated copy uses one. */
export const FORBIDDEN_RECOMMENDATION_VERBS = [
  'Increase', 'Decrease', 'Pause', 'Resume', 'Reroute', 'Raise', 'Lower',
  'Optimize', 'Recover', 'Guarantee', 'Boost', 'Scale',
] as const;

/** True when a recommendation opens with an approved verb. */
export function isSafeRecommendation(text: string): boolean {
  const first = text.trim().split(/\s+/)[0]?.replace(/[^A-Za-z]/g, '') ?? '';
  return (RECOMMENDATION_VERBS as readonly string[]).includes(first);
}

// --- Significance ----------------------------------------------------------------
// Thresholds live here, versioned and inspectable — never inline in a component.
// "Revenue fell 3%" is not news; "revenue fell 31% and one buyer accounts for
// most of it" is. The registry is what separates the two, and changing a number
// here is an auditable change to how the product judges importance.

export interface SignificanceRule {
  ruleId: string;
  version: string;
  /** The metric this rule judges. */
  metric: string;
  /** What must be true before the rule may fire at all. */
  minimumDataRequirements: string;
  /** Minimum absolute movement to be considered, in the metric's own unit
   *  (cents for money, calls for volume). Null when only relative change matters. */
  absoluteThreshold: number | null;
  /** Minimum relative movement (fraction). Null when only absolute matters. */
  percentageThreshold: number | null;
  /** Minimum population before a change is trustworthy at all. */
  minimumVolume: number;
  /** Which window the comparison is drawn from. */
  baselineWindow: 'comparison_window' | 'latest_snapshot';
  /** How severity escalates once the rule fires. */
  severityLogic: string;
  /** When the rule must stay silent even though its thresholds were met. */
  suppressionConditions: string[];
  /** Why this rule exists, in plain language. */
  explanation: string;
}

const MONEY_MIN = 25_000; // $250 — below this a percentage swing is noise

export const CALLGRID_SIGNIFICANCE_RULES: readonly SignificanceRule[] = [
  {
    ruleId: 'revenue-change',
    version: 'v1',
    metric: 'revenue',
    minimumDataRequirements: 'Both windows read successfully and the comparison revenue is known and non-zero.',
    absoluteThreshold: MONEY_MIN,
    percentageThreshold: 0.1,
    minimumVolume: 10, // calls in the comparison window
    baselineWindow: 'comparison_window',
    severityLogic: 'NOTABLE at 10%, HIGH at 25%, CRITICAL at 40% — each also requiring the absolute threshold, so a large swing on a tiny base stays quiet.',
    suppressionConditions: [
      'Comparison revenue is 0 or unknown (no baseline to change from).',
      'Fewer than 10 calls in the comparison window.',
      'Revenue coverage below 50% in either window — the totals are lower bounds and the change may be an artefact of what was priced.',
    ],
    explanation: 'Revenue is the headline. A move that is both proportionally and absolutely material is worth an operator\'s attention; one that is only proportionally large is usually a small base.',
  },
  {
    ruleId: 'profit-change',
    version: 'v1',
    metric: 'profit',
    minimumDataRequirements: 'Profit known in both windows with payout and cost coverage above 50%.',
    absoluteThreshold: MONEY_MIN,
    percentageThreshold: 0.15,
    minimumVolume: 10,
    baselineWindow: 'comparison_window',
    severityLogic: 'NOTABLE at 15%, HIGH at 30%, CRITICAL at 50%.',
    suppressionConditions: [
      'Profit unknown in either window.',
      'Payout or cost coverage below 50% — partial coverage overstates profit and would invent a margin story.',
    ],
    explanation: 'Margin can deteriorate while revenue holds. Profit is only trustworthy when its cost inputs are reported, so this rule is stricter about coverage than the revenue rule.',
  },
  {
    ruleId: 'volume-change',
    version: 'v1',
    metric: 'totalCalls',
    minimumDataRequirements: 'Both windows read successfully.',
    absoluteThreshold: 20,
    percentageThreshold: 0.15,
    minimumVolume: 20,
    baselineWindow: 'comparison_window',
    severityLogic: 'NOTABLE at 15%, HIGH at 30%. Volume alone never reaches CRITICAL — it is context for a revenue finding, not an emergency on its own.',
    suppressionConditions: ['Fewer than 20 calls in the comparison window.'],
    explanation: 'Call volume explains whether a revenue move was about how many calls arrived or what each one was worth.',
  },
  {
    ruleId: 'entity-contribution',
    version: 'v1',
    metric: 'contributionToChange',
    minimumDataRequirements: 'A significant window-level change, and entity changes that reconcile to it.',
    absoluteThreshold: MONEY_MIN,
    percentageThreshold: 0.25, // share of the total change
    minimumVolume: 5,
    baselineWindow: 'comparison_window',
    severityLogic: 'Inherits the severity of the window-level change it explains, capped at HIGH.',
    suppressionConditions: [
      'The window did not move significantly — there is nothing to attribute.',
      'The entity accounts for less than 25% of the move.',
      'Fewer than 5 calls for the entity across both windows.',
    ],
    explanation: 'Naming which entities moved converts a percentage into something a person can act on. It establishes contribution, never cause.',
  },
  {
    ruleId: 'revenue-concentration',
    version: 'v1',
    metric: 'revenueShare',
    minimumDataRequirements: 'Known window revenue and at least two entities in the dimension.',
    absoluteThreshold: null,
    percentageThreshold: 0.4, // single entity share
    minimumVolume: 20,
    baselineWindow: 'comparison_window',
    severityLogic: 'NOTABLE at 40% single-entity share, HIGH at 55%, CRITICAL at 70%.',
    suppressionConditions: [
      'Only one entity exists in the dimension — concentration is definitional, not a finding.',
      'Fewer than 20 calls in the window.',
    ],
    explanation: 'Concentration describes operational dependency, not health. A high share is worth knowing because continuity risk sits behind it — not because it is inherently bad.',
  },
  {
    ruleId: 'entity-inactive',
    version: 'v1',
    metric: 'revenue',
    minimumDataRequirements: 'The entity produced meaningful revenue in the comparison window and none in the selected window.',
    absoluteThreshold: MONEY_MIN * 2,
    percentageThreshold: null,
    minimumVolume: 5,
    baselineWindow: 'comparison_window',
    severityLogic: 'HIGH when the entity was a top-five contributor, NOTABLE otherwise.',
    suppressionConditions: [
      'The selected window is still in progress and shorter than a full day — an entity that has not appeared yet has not gone away.',
      'The entity produced less than $500 in the comparison window.',
    ],
    explanation: 'An entity that was producing and now is not is the single most actionable pattern in the data — but Loop can only observe the absence, never why.',
  },
  {
    ruleId: 'billable-efficiency',
    version: 'v1',
    metric: 'billableRate',
    minimumDataRequirements: 'At least 30 calls in each window.',
    absoluteThreshold: null,
    percentageThreshold: 0.2, // relative change in the rate
    minimumVolume: 30,
    baselineWindow: 'comparison_window',
    severityLogic: 'NOTABLE at a 20% relative change, HIGH at 35%.',
    suppressionConditions: ['Fewer than 30 calls in either window — billable rate is unstable on small samples.'],
    explanation: 'Billable rate shows whether arriving calls are converting into billable ones. It is an efficiency measure; the provider does not expose anything that would make it a quality measure.',
  },
  {
    ruleId: 'value-per-call',
    version: 'v1',
    metric: 'revenuePerBillableCall',
    minimumDataRequirements: 'Billable calls and known revenue in both windows.',
    absoluteThreshold: 500, // $5 per call
    percentageThreshold: 0.15,
    minimumVolume: 20,
    baselineWindow: 'comparison_window',
    severityLogic: 'NOTABLE at 15%, HIGH at 30%.',
    suppressionConditions: ['Fewer than 20 billable calls in either window.'],
    explanation: 'Separating value-per-call from volume is what distinguishes "fewer calls" from "cheaper calls" — two problems with entirely different responses.',
  },
  {
    ruleId: 'rank-movement',
    version: 'v1',
    metric: 'rankChange',
    minimumDataRequirements: 'The entity appears in both ranked collections.',
    absoluteThreshold: 3, // places moved
    percentageThreshold: null,
    minimumVolume: 10,
    baselineWindow: 'comparison_window',
    severityLogic: 'INFORMATIONAL unless the entity left or entered the top five, then NOTABLE.',
    suppressionConditions: [
      'The entity is absent from one window — that is an entry or an exit, reported by its own rule.',
      'Fewer than ten entities in the dimension, where rank moves are mostly noise.',
    ],
    explanation: 'Rank movement shows a shift in the shape of the marketplace that a total can hide.',
  },
  {
    ruleId: 'bid-outcome-volume',
    version: 'v1',
    metric: 'rejectedOpportunities',
    minimumDataRequirements: 'A synchronized bid snapshot with reported counts.',
    absoluteThreshold: 100,
    percentageThreshold: 0.15, // share of the grain's total outcomes
    minimumVolume: 100,
    baselineWindow: 'latest_snapshot',
    severityLogic: 'NOTABLE above 15% share of its grain, HIGH above 30%, and one step higher when the category is potentially preventable rather than expected configuration.',
    suppressionConditions: [
      'No bid snapshot synchronized.',
      'Fewer than 100 outcomes in the snapshot — small snapshots produce misleading shares.',
    ],
    explanation: 'Bid rejections are mostly configuration working as intended. Ranking by volume alone would put the expected ones first, so preventability shifts severity.',
  },
  {
    ruleId: 'bid-win-rate',
    version: 'v1',
    metric: 'sourceWinRate',
    minimumDataRequirements: 'At least 50 submitted bids for the source in the snapshot.',
    absoluteThreshold: null,
    percentageThreshold: 0.1,
    minimumVolume: 50,
    baselineWindow: 'latest_snapshot',
    severityLogic: 'INFORMATIONAL — a win rate is context for review, never an alert on its own.',
    suppressionConditions: ['Fewer than 50 submitted bids — win rate is meaningless on a small sample.'],
    explanation: 'Win rate must use submitted bids as its denominator. The minimum sample exists because a source with three bids and one win reads as 33% and means nothing.',
  },
];

const RULE_BY_ID = new Map(CALLGRID_SIGNIFICANCE_RULES.map((r) => [r.ruleId, r] as const));

export function significanceRule(ruleId: string): SignificanceRule | null {
  return RULE_BY_ID.get(ruleId) ?? null;
}

/**
 * Grade a relative change against a rule's escalation ladder.
 *
 * `ladder` is [notable, high, critical] as fractions. A level of null means the
 * rule does not escalate that far. Returns null when the change does not clear
 * the rule's floor at all — the caller must then emit nothing.
 */
export function gradeSeverity(
  relative: number,
  ladder: [number, number | null, number | null],
): Severity | null {
  const magnitude = Math.abs(relative);
  const [notable, high, critical] = ladder;
  if (critical !== null && magnitude >= critical) return 'CRITICAL';
  if (high !== null && magnitude >= high) return 'HIGH';
  if (magnitude >= notable) return 'NOTABLE';
  return null;
}

/** Raise a severity by one step (used when a bid category is preventable). */
export function escalate(severity: Severity): Severity {
  if (severity === 'INFORMATIONAL') return 'NOTABLE';
  if (severity === 'NOTABLE') return 'HIGH';
  return 'CRITICAL';
}

/** Cap a severity at a ceiling (a contribution never outranks the change it explains). */
export function capSeverity(severity: Severity, ceiling: Severity): Severity {
  return SEVERITY_RANK[severity] < SEVERITY_RANK[ceiling] ? ceiling : severity;
}

/**
 * Deterministic confidence: how much of the underlying population actually
 * carried the values behind a finding, damped by sample size.
 *
 * This is arithmetic over coverage, not a judgement. A finding over fully-covered
 * data with a large sample approaches 1; thin or partial data drags it down and
 * the surface can then present the finding with the caution it deserves.
 */
export function deriveConfidence(
  completeness: number | null,
  sampleSize: number,
  minimumSample: number,
): number {
  const cov = completeness === null ? 1 : Math.max(0, Math.min(1, completeness));
  const sample = minimumSample <= 0 ? 1 : Math.min(1, sampleSize / (minimumSample * 4));
  // Never claim more than 95%: every conclusion here is an observation of a
  // provider's reporting, not a measurement of the world.
  return Math.round(Math.min(0.95, 0.35 + 0.4 * cov + 0.25 * sample) * 100) / 100;
}

// --- Structural guarantees --------------------------------------------------------

/**
 * A finding is only well-formed if it can be checked. This is called by the
 * engine on everything it emits, so a rule that forgets its evidence fails loudly
 * in tests rather than shipping an unfalsifiable claim.
 */
export function findingViolations(finding: CallGridFinding): string[] {
  const problems: string[] = [];
  if (finding.supportingEvidence.length === 0) problems.push('no supporting evidence');
  if (!finding.ruleId) problems.push('no ruleId');
  if (!finding.ruleVersion) problems.push('no ruleVersion');
  if (finding.limitations.length === 0) problems.push('no stated limitations');
  if (finding.confidence < 0 || finding.confidence > 1) problems.push('confidence out of range');
  if (finding.recommendedReview && !isSafeRecommendation(finding.recommendedReview)) {
    problems.push(`unsafe recommendation verb: "${finding.recommendedReview.split(/\s+/)[0]}"`);
  }
  if (finding.classification === 'UNKNOWN' && finding.unknowns.length === 0) {
    problems.push('classified UNKNOWN without saying what is unknown');
  }
  return problems;
}

// --- Unknowns ----------------------------------------------------------------------

/** Something the product cannot determine, shown where it affects interpretation. */
export interface IntelligenceUnknown {
  id: string;
  /** What cannot be determined. */
  statement: string;
  /** Why — the provider or grain limitation behind it. */
  reason: string;
}
