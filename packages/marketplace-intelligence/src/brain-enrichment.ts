// @emgloop/marketplace-intelligence — Brain Enrichment (pure, unwired).
//
// PR #46 (Wire Brain reasoning into Marketplace Intelligence — pure, unwired).
//
// PR #43 established the canonical MarketplaceIntelligence model. PR #44 built a
// pure CallGrid assembler that projects reconciled CallGrid facts into that
// model but — honestly — leaves every Brain judgement empty and annotated with
// BRAIN_NOT_WIRED (health 'unknown', confidence at the no-diagnosis floor, no
// recommendations, no insights). PR #45 proved that assembler correct.
//
// This module is the missing reasoning step, kept deliberately pure and
// unwired. It takes an ALREADY-ASSEMBLED MarketplaceIntelligence snapshot and
// returns an ENRICHED MarketplaceIntelligence snapshot in which:
//
//   - health is graded from the evidence actually present,
//   - confidence is raised above the no-diagnosis floor only when a rule fired,
//   - recommendations are populated using the EXISTING RecommendationEnvelope
//     contract (packages/brain) — never a new shape, never invented text,
//   - insights are populated using the EXISTING BrainActivity contract, aliased
//     by MarketplaceBrainInsight — one insight per recommendation,
//   - the BRAIN_NOT_WIRED marker is removed wherever enrichment succeeds,
//   - unknowns / missingEvidence are PRESERVED wherever evidence is insufficient.
//
// Determinism & purity are structural. Given the same snapshot and the same
// caller-supplied 'now', this function returns the same enriched snapshot: no
// clock, no RNG, no I/O, no persistence, no mutation of the input, no LLM. Ids
// are derived from stable subjects, not generated. It is additive, contracts +
// pure functions only, and is not wired into any runtime path.
//
// Guardrails (unchanged from PR #43-#45): no UI, no API, no DB reads/writes, no
// schema changes, no runtime wiring, no CallGrid settings, no LLM. All Brain
// vocabulary is reused from @emgloop/brain; nothing is redeclared here.

import type { Confidence, RecommendationEnvelope, BrainActivity } from '@emgloop/brain';
import type { MarketplaceHealth } from './common';
import type { BuyerIntelligence } from './buyer-intelligence';
import type { SourceIntelligence } from './source-intelligence';
import type { MarketplaceProfitability } from './profitability';
import type { MarketplaceIntelligence } from './marketplace-intelligence';
import type { MarketplaceBrainInsight } from './brain-insight';

// ---------------------------------------------------------------------------
// The marker PR #44 stamps wherever the Brain had not yet run. Enrichment
// removes exactly this string from a collection once a snapshot (or entity) has
// been reasoned about; anything else in unknowns/missingEvidence is preserved.
// Kept in sync with callgrid-assembler.ts BRAIN_NOT_WIRED.
// ---------------------------------------------------------------------------
export const BRAIN_NOT_WIRED =
  'brain_diagnostics_not_wired: recommendations/insights intentionally empty until the Brain is connected to Marketplace Intelligence';

/** Confidence floor an un-reasoned snapshot carries (mirrors the assembler). */
export const NO_DIAGNOSIS_CONFIDENCE: Confidence = 0;

// ---------------------------------------------------------------------------
// Deterministic rule thresholds. Named constants (never magic numbers) so the
// rules are auditable and a later PR can tune them without touching logic.
// These are intentionally conservative; a rule that cannot see its evidence
// does NOT fire (the snapshot stays honestly 'unknown').
// ---------------------------------------------------------------------------
export const ENRICHMENT_THRESHOLDS = {
  /** Net profit at or below this (in the org's currency) is a profitability issue. */
  profitabilityNetProfitFloor: 0,
  /** Buyer billable rate below this fraction [0,1] is 'low billable'. */
  lowBillableRateMax: 0.5,
  /** Source reject fraction [0,1] at or above this is 'high rejection'. */
  highRejectionRateMin: 0.4,
  /** Source fulfillment fraction [0,1] below this is 'poor fulfillment'. */
  poorFulfillmentMax: 0.6,
} as const;

// ---------------------------------------------------------------------------
// A single fired rule. Internal to enrichment; it is projected into the public
// RecommendationEnvelope + BrainActivity contracts below. We never expose a new
// public shape — this is a private staging record only.
// ---------------------------------------------------------------------------
interface FiredRule {
  /** Stable machine key, used to derive deterministic ids. */
  readonly key:
    | 'profitability_issue'
    | 'low_billable_rate'
    | 'high_rejection_rate'
    | 'poor_source_fulfillment';
  /** Subject the finding concerns, e.g. 'marketplace', 'buyer:acme', 'source:cg-1'. */
  readonly subject: string;
  /** Root cause attribution, drawn only from the existing RootCause union. */
  readonly rootCause: 'vendor' | 'buyer' | 'emg' | 'unknown';
  /** Priority/severity, drawn only from the shared Priority vocabulary. */
  readonly priority: 'low' | 'normal' | 'high' | 'critical';
  /** Deterministic confidence for this finding, [0,1]. */
  readonly confidence: Confidence;
  /** Plain-language finding. Fixed template — never model-generated. */
  readonly recommendation: string;
  readonly reason: string;
  readonly suggestedAction: string;
  readonly businessImpact: string;
  /** Evidence description(s) the rule rested on. */
  readonly evidence: ReadonlyArray<string>;
  /** Signal keys supporting the finding. */
  readonly supportingSignals: ReadonlyArray<string>;
}

// ---------------------------------------------------------------------------
// Deterministic rules. Each rule reads ONLY fields already present on the
// assembled snapshot. If the field(s) a rule needs are undefined, the rule
// returns nothing (the snapshot stays honestly unknown for that subject).
// Rules never read a clock, never randomise, never mutate their input.
// ---------------------------------------------------------------------------

/** Profitability issue: net profit is known and at/below the floor. */
function ruleProfitabilityIssue(p: MarketplaceProfitability): FiredRule | undefined {
  const net = p.netProfit;
  if (net === undefined) return undefined;
  if (net > ENRICHMENT_THRESHOLDS.profitabilityNetProfitFloor) return undefined;
  return {
    key: 'profitability_issue',
    subject: 'marketplace',
    rootCause: 'emg',
    priority: net < 0 ? 'critical' : 'high',
    confidence: 0.8,
    recommendation: 'Marketplace net profit is non-positive for this window.',
    reason:
      'Aggregate net profit is at or below the profitability floor, so the marketplace is not clearing a positive margin this window.',
    suggestedAction:
      'Review buyer payouts, source costs, and telco against revenue to restore a positive net margin before scaling spend.',
    businessImpact:
      'A non-positive net margin means every additional call is sold at or below cost until the underlying economics are corrected.',
    evidence: ['profitability.netProfit = ' + String(net)],
    supportingSignals: ['profitability.net_profit'],
  };
}

/** Low billable rate: a buyer's billable rate is known and below the max. */
function ruleLowBillableRate(b: BuyerIntelligence): FiredRule | undefined {
  const rate = b.billableRate;
  if (rate === undefined) return undefined;
  if (rate >= ENRICHMENT_THRESHOLDS.lowBillableRateMax) return undefined;
  return {
    key: 'low_billable_rate',
    subject: 'buyer:' + b.buyerId,
    rootCause: 'buyer',
    priority: 'high',
    confidence: 0.75,
    recommendation:
      'Buyer ' + b.buyerName + ' has a low billable rate for this window.',
    reason:
      'The share of this buyer\'s calls that became billable is below the acceptable floor, so delivered traffic is not converting into billable outcomes.',
    suggestedAction:
      'Review this buyer\'s call handling and acceptance criteria; confirm routing quality before increasing allocation.',
    businessImpact:
      'Low billable conversion wastes otherwise-sellable calls and depresses revenue realised per delivered call.',
    evidence: ['buyer.billableRate = ' + String(rate)],
    supportingSignals: ['buyer.billable_rate'],
  };
}

/** High rejection rate: a source's reject fraction is computable and high. */
function ruleHighRejectionRate(s: SourceIntelligence): FiredRule | undefined {
  const sent = s.bidsSent;
  const accepted = s.bidsAccepted;
  // Reject fraction is only well-defined when we know how many bids were sent
  // (and it is > 0) and how many were accepted. Otherwise: stay unknown.
  if (sent === undefined || accepted === undefined || sent <= 0) return undefined;
  const rejectRate = (sent - accepted) / sent;
  if (rejectRate < ENRICHMENT_THRESHOLDS.highRejectionRateMin) return undefined;
  return {
    key: 'high_rejection_rate',
    subject: 'source:' + s.sourceId,
    rootCause: 'emg',
    priority: 'high',
    confidence: 0.7,
    recommendation:
      'Source ' + s.sourceName + ' is seeing a high bid rejection rate.',
    reason:
      'A large share of this source\'s bids are being rejected before acceptance, so most offered traffic never enters the marketplace.',
    suggestedAction:
      'Inspect the source\'s top rejection reasons and routing/tag rules; fix the dominant reject cause before adding volume.',
    businessImpact:
      'High rejection wastes acquisition effort and starves buyers of otherwise-available traffic.',
    evidence: [
      'source.bidsSent = ' + String(sent),
      'source.bidsAccepted = ' + String(accepted),
      'derived reject_rate = ' + rejectRate.toFixed(4),
    ],
    supportingSignals: ['source.bids_sent', 'source.bids_accepted'],
  };
}

/** Poor source fulfillment: fulfillment is known and below the max. */
function rulePoorSourceFulfillment(s: SourceIntelligence): FiredRule | undefined {
  const fulfillment = s.fulfillment;
  if (fulfillment === undefined) return undefined;
  if (fulfillment >= ENRICHMENT_THRESHOLDS.poorFulfillmentMax) return undefined;
  return {
    key: 'poor_source_fulfillment',
    subject: 'source:' + s.sourceId,
    rootCause: 'vendor',
    priority: 'normal',
    confidence: 0.65,
    recommendation:
      'Source ' + s.sourceName + ' is under-fulfilling expected traffic.',
    reason:
      'Delivered traffic for this source is well below the expected/committed volume, so demand is going unmet from this source.',
    suggestedAction:
      'Confirm the source\'s live capacity and commitments; rebalance demand toward better-fulfilling sources if the shortfall persists.',
    businessImpact:
      'Chronic under-fulfilment leaves buyer demand unserved and forces reliance on more expensive sources.',
    evidence: ['source.fulfillment = ' + String(fulfillment)],
    supportingSignals: ['source.fulfillment'],
  };
}

// ---------------------------------------------------------------------------
// Projection into the EXISTING Brain contracts. No new public shape is
// introduced: a FiredRule becomes a RecommendationEnvelope and a matching
// BrainActivity (aliased MarketplaceBrainInsight). Both are built purely.
// ---------------------------------------------------------------------------

function toEnvelope(
  organizationId: string,
  rule: FiredRule,
): RecommendationEnvelope {
  return {
    id: 'rec:' + rule.key + ':' + rule.subject,
    organizationId,
    visibility: 'network',
    confidence: rule.confidence,
    recommendation: rule.recommendation,
    action: 'operational_recommendation',
    reason: rule.reason,
    rootCause: rule.rootCause,
    trust: {
      confidence: rule.confidence,
      evidence: rule.evidence.map((description) => ({
        kind: 'signal',
        description,
      })),
      // Enrichment reasons over what the snapshot already carries; it does not
      // claim to have every fact. What is missing stays named, never hidden.
      missingEvidence: [],
      wouldIncreaseConfidenceWith: rule.supportingSignals.map(
        (signal) => 'trend_history:' + signal,
      ),
    },
    // Deterministic rules present exactly one diagnosis; alternatives are left
    // empty rather than fabricated.
    alternativesConsidered: [],
    unknowns: [],
    suggestedAction: rule.suggestedAction,
    expectedOutcome: {
      statement:
        'Acting on this finding is expected to move the affected metric back within a healthy range.',
    },
    risk: {
      level: 'low',
      description:
        'Acting is a review/operational step; the main risk is opportunity cost if the underlying driver is misread.',
      costOfInaction:
        'Leaving the condition unaddressed lets the negative effect persist across the window.',
    },
    businessImpact: rule.businessImpact,
  };
}

function toInsight(
  organizationId: string,
  now: Date,
  rule: FiredRule,
  envelope: RecommendationEnvelope,
): MarketplaceBrainInsight {
  const insight: BrainActivity = {
    organizationId,
    id: 'act:' + rule.key + ':' + rule.subject,
    timestamp: now,
    subject: rule.subject,
    activityType: 'recommendation',
    severity: rule.priority,
    visibility: 'network',
    recommendation: rule.recommendation,
    recommendationEnvelope: envelope,
    evidence: envelope.trust.evidence,
    confidence: rule.confidence,
    missingEvidence: [],
    alternativesConsidered: [],
    unknowns: [],
    // No stored DiagnosticAssessment backs a pure rule; the ref points at the
    // rule+subject that produced this activity, keeping provenance honest.
    assessmentRef: 'enrichment:' + rule.key + ':' + rule.subject,
  };
  return insight;
}

// ---------------------------------------------------------------------------
// Marker handling & aggregate judgements.
// ---------------------------------------------------------------------------

/** Remove exactly the BRAIN_NOT_WIRED marker; preserve every other entry and
 * original order. Enrichment "removes it where enrichment succeeds" without
 * silently dropping any real unknown/missing-evidence note. */
function stripBrainNotWired(
  items: ReadonlyArray<string>,
): ReadonlyArray<string> {
  return items.filter((item) => item !== BRAIN_NOT_WIRED);
}

/** Grade overall marketplace health from the fired rules. Purely a function of
 * the highest-priority finding; no findings that could be graded -> 'unknown'
 * is NOT returned here (see enrich): this only maps severity -> health band. */
function healthFromRules(rules: ReadonlyArray<FiredRule>): MarketplaceHealth {
  if (rules.some((r) => r.priority === 'critical')) return 'critical';
  if (rules.some((r) => r.priority === 'high')) return 'at_risk';
  if (rules.some((r) => r.priority === 'normal')) return 'watch';
  return 'healthy';
}

/** Snapshot confidence = the max rule confidence (most-certain finding drives
 * how much we trust the enriched view). Deterministic; empty -> floor. */
function confidenceFromRules(rules: ReadonlyArray<FiredRule>): Confidence {
  return rules.reduce<Confidence>(
    (max, r) => (r.confidence > max ? r.confidence : max),
    NO_DIAGNOSIS_CONFIDENCE,
  );
}

// ---------------------------------------------------------------------------
// Public entry point.
// ---------------------------------------------------------------------------

/**
 * Enrich an already-assembled MarketplaceIntelligence snapshot with Brain
 * reasoning, PURELY and DETERMINISTICALLY.
 *
 * Contract:
 *  - The input is never mutated; a new snapshot is returned.
 *  - 'now' is caller-supplied (never read from a clock) so the result is
 *    reproducible; it is used only as the insight timestamp.
 *  - Recommendations/insights are produced ONLY by the deterministic rules in
 *    this file (profitability issue, low billable rate, high rejection rate,
 *    poor source fulfillment). Nothing is invented.
 *  - Where at least one rule fires, health/confidence are graded and the
 *    BRAIN_NOT_WIRED marker is removed from unknowns/missingEvidence and
 *    metadata.note.
 *  - Where NO rule can fire (insufficient evidence), the snapshot stays
 *    honestly 'unknown' at the no-diagnosis floor and BRAIN_NOT_WIRED is
 *    preserved — enrichment never manufactures certainty it does not have.
 */
export function enrichMarketplaceIntelligence(
  snapshot: MarketplaceIntelligence,
  now: Date,
): MarketplaceIntelligence {
  const organizationId = snapshot.organizationId;

  // 1. Run every rule over the evidence already on the snapshot.
  const rules: FiredRule[] = [];

  const profitRule = ruleProfitabilityIssue(snapshot.profitability);
  if (profitRule) rules.push(profitRule);

  for (const buyer of snapshot.buyers) {
    const r = ruleLowBillableRate(buyer);
    if (r) rules.push(r);
  }

  for (const source of snapshot.sources) {
    const rejection = ruleHighRejectionRate(source);
    if (rejection) rules.push(rejection);
    const fulfillment = rulePoorSourceFulfillment(source);
    if (fulfillment) rules.push(fulfillment);
  }

  // 2. No rule fired -> insufficient evidence. Return the snapshot essentially
  //    unchanged: honest 'unknown', floor confidence, markers preserved.
  if (rules.length === 0) {
    return {
      ...snapshot,
      health: 'unknown',
      confidence: NO_DIAGNOSIS_CONFIDENCE,
      recommendations: [],
      insights: [],
      // Preserve unknowns/missingEvidence (incl. BRAIN_NOT_WIRED) verbatim.
    };
  }

  // 3. At least one rule fired -> project into the existing Brain contracts.
  const recommendations: RecommendationEnvelope[] = rules.map((rule) =>
    toEnvelope(organizationId, rule),
  );
  const insights: MarketplaceBrainInsight[] = rules.map((rule, i) =>
    toInsight(organizationId, now, rule, recommendations[i]),
  );

  // 4. Remove BRAIN_NOT_WIRED where enrichment succeeded, preserving any other
  //    honest unknown/missing-evidence entry.
  const unknowns = stripBrainNotWired(snapshot.unknowns);
  const missingEvidence = stripBrainNotWired(snapshot.missingEvidence);

  // 5. Clean the metadata.note marker without disturbing the rest of metadata.
  let metadata = snapshot.metadata;
  if (metadata && metadata.note === BRAIN_NOT_WIRED) {
    const { note: _removed, ...rest } = metadata as Record<string, unknown>;
    metadata = rest;
  }

  return {
    ...snapshot,
    health: healthFromRules(rules),
    confidence: confidenceFromRules(rules),
    recommendations,
    insights,
    unknowns,
    missingEvidence,
    metadata,
  };
}
