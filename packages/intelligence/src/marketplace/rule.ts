// Marketplace Intelligence — the rule contract.
//
// Phase 6 states the bar: every rule must answer what happened, why, who owns
// it, the business impact, the evidence, the confidence, and the recommended
// action — and "if a rule cannot answer those questions, do not build it."
//
// This file makes that structural rather than aspirational. A rule which cannot
// answer all seven does not compile, and one whose evidence is too thin cannot
// be published at runtime. The same approach as Truth States: make the wrong
// thing unbuildable rather than asking people to remember.
//
// WHAT THIS IS NOT
//
// It is not reporting. A finding here is never "here are your numbers" — it is
// "this is what went wrong, this is who can fix it, and this is what it cost".
// If a proposed rule would be satisfied by a table, it belongs in CallGrid's
// own reporting, not here.

import type { FailureCategory, FailureOwner } from './taxonomy';

/** The dimension a finding is attributed to. */
export type MarketplaceEntityKind = 'campaign' | 'buyer' | 'destination' | 'vendor' | 'source';

export interface MarketplaceEntity {
  kind: MarketplaceEntityKind;
  /** Provider id, when known. Null when only a label was reported. */
  externalId: string | null;
  label: string;
}

/**
 * A single piece of evidence. Counts and identifiers only — never a caller
 * number, never a raw payload.
 */
export interface RuleEvidence {
  /** What was measured, in business language. */
  statement: string;
  /** The measured value. */
  observed: number;
  /** What it was measured against. Null when there is no meaningful denominator. */
  denominator: number | null;
  /** Where the figure came from, so a reader can verify it. */
  source: string;
}

/**
 * Business impact. Deliberately NOT a free-text severity: a rule must either
 * quantify the cost or admit it cannot.
 */
export type BusinessImpact =
  | { kind: 'measured'; lostOpportunities: number; estimatedRevenueCents: number | null; basis: string }
  /** The volume is known but its value is not. Honest and common. */
  | { kind: 'volume-only'; lostOpportunities: number; whyNotPriced: string }
  /** Neither is known. A rule in this state must not recommend an action. */
  | { kind: 'unquantified'; reason: string };

/** Confidence is earned from coverage, never asserted. */
export interface RuleConfidence {
  /** [0,1]. */
  value: number;
  /** Records the rule actually saw. */
  sampleSize: number;
  /** The minimum this rule requires. Below it, the rule must not fire. */
  minimumSampleSize: number;
  /** Fraction of the population the sample covers, or null when unknown. */
  coverage: number | null;
  /** Why the confidence is what it is. */
  basis: string;
}

/**
 * A finding. Every field is REQUIRED — that is the enforcement. A rule author
 * cannot omit the owner or the evidence, because the type will not allow it.
 */
export interface MarketplaceFinding {
  id: string;
  /** 1. What happened — one sentence, business language, no provider codes. */
  whatHappened: string;
  /** 2. Why — the mechanism, not a restatement of the number. */
  why: string;
  /** 3. Who owns it. */
  owner: FailureOwner;
  /** The entity the finding is attributed to. Null only for platform-wide findings. */
  entity: MarketplaceEntity | null;
  category: FailureCategory;
  /** 4. Business impact. */
  impact: BusinessImpact;
  /** 5. Evidence. Must be non-empty — enforced at runtime by publishFinding. */
  evidence: readonly RuleEvidence[];
  /** 6. Confidence. */
  confidence: RuleConfidence;
  /** 7. Recommended action, addressed to the owner. Null when impact is unquantified. */
  recommendedAction: string | null;
  /** What the rule could NOT see. Absence of this list is itself a smell. */
  missingEvidence: readonly string[];
}

/** Why a rule declined to fire. Surfaced, never swallowed. */
export interface RuleWithheld {
  ruleId: string;
  reason: string;
  /** What would let it fire next time. */
  needs: string;
}

export type RuleOutcome =
  | { fired: true; finding: MarketplaceFinding }
  | { fired: false; withheld: RuleWithheld };

/**
 * Publish a finding, or refuse to.
 *
 * The runtime half of the contract. Types cannot express "the sample is large
 * enough" or "the evidence is non-empty", so those are checked here — and a
 * failure WITHHOLDS rather than throws, because a rule that cannot speak
 * responsibly should stay quiet, not crash the briefing.
 */
export function publishFinding(finding: MarketplaceFinding): RuleOutcome {
  const withhold = (reason: string, needs: string): RuleOutcome => ({
    fired: false,
    withheld: { ruleId: finding.id, reason, needs },
  });

  if (finding.evidence.length === 0) {
    return withhold(
      'The rule produced no evidence.',
      'At least one measured observation with a stated source.',
    );
  }

  if (finding.confidence.sampleSize < finding.confidence.minimumSampleSize) {
    return withhold(
      `Sample of ${finding.confidence.sampleSize} is below the rule's own minimum of ${finding.confidence.minimumSampleSize}.`,
      `At least ${finding.confidence.minimumSampleSize} records in the window.`,
    );
  }

  // A rate quoted without its denominator is the classic way a marketplace
  // metric misleads: 0.04% of pings and 0.04% of bids are different claims.
  const rateWithoutDenominator = finding.evidence.find(
    (e) => /%|rate\b/i.test(e.statement) && e.denominator === null,
  );
  if (rateWithoutDenominator) {
    return withhold(
      `Evidence "${rateWithoutDenominator.statement}" states a rate with no denominator.`,
      'A denominator proven comparable to the numerator.',
    );
  }

  // An unquantified impact may describe, but must never instruct: an operator
  // asked to act needs to know what acting is worth.
  if (finding.impact.kind === 'unquantified' && finding.recommendedAction !== null) {
    return withhold(
      'The rule recommends an action while unable to quantify the impact.',
      'Either a measured impact, or drop the recommendation.',
    );
  }

  if (finding.confidence.value < 0 || finding.confidence.value > 1) {
    return withhold('Confidence must be within [0,1].', 'A confidence earned from coverage.');
  }

  return { fired: true, finding };
}

/**
 * Rank findings by what is worth an executive's attention: quantified revenue
 * first, then quantified volume, then everything else — and within a tier, by
 * confidence. An unquantified finding never outranks a measured one, however
 * dramatic its wording.
 */
export function rankFindings(findings: readonly MarketplaceFinding[]): MarketplaceFinding[] {
  const tier = (f: MarketplaceFinding): number =>
    f.impact.kind === 'measured' && f.impact.estimatedRevenueCents !== null
      ? 0
      : f.impact.kind === 'measured' || f.impact.kind === 'volume-only'
        ? 1
        : 2;

  const magnitude = (f: MarketplaceFinding): number =>
    f.impact.kind === 'measured'
      ? (f.impact.estimatedRevenueCents ?? f.impact.lostOpportunities)
      : f.impact.kind === 'volume-only'
        ? f.impact.lostOpportunities
        : 0;

  return [...findings].sort(
    (a, b) =>
      tier(a) - tier(b) ||
      magnitude(b) - magnitude(a) ||
      b.confidence.value - a.confidence.value,
  );
}
