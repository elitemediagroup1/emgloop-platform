// LAYER 2 — The Marketplace Intelligence Engine.
//
// Layer 1 is now the PLATFORM Evidence Engine (../evidence), not a
// marketplace-specific confidence layer. Marketplace is its first contributor;
// CRM, Talent, Care and Web join by writing a contributor of the same shape,
// with no change to either layer.
//
// Reasoning, not reporting. CallGrid remains the reporting system.
//
// TWO-LAYER CONTRACT
//
//   Layer 1 (evidence/)      owns coverage, sample size, confidence, freshness,
//                            provenance, unknowns, contradictions, missing data
//   Layer 2 (this file)      reasons ONLY over metrics that cleared Layer 1
//
// Every rule declares what it requires — which metrics, minimum confidence,
// minimum sample size, coverage requirement — and the engine checks those
// BEFORE calling `evaluate`. A rule whose metric was withheld is never
// evaluated, because the metric is not in the context it receives.
//
// That is the structural point of the split. Previously a rule assessed its own
// trustworthiness inline, so two rules could disagree about the same metric and
// nothing stopped one from reading a number it should not have. Now the value
// is simply absent, and suppression is automatic rather than remembered.
//
// DELIBERATELY NOT IMPLEMENTED
//
// Rate Limiting, Capacity and Bid Pricing are gated on "WHEN verified". The bid
// endpoints are contract-verified but no response has ever been read, so those
// rules have no evidence. `unbuiltRules()` names them and what each needs.

import { publishFinding, rankFindings, type MarketplaceFinding, type RuleOutcome } from './rule';
import { assessEvidence, availableMetric } from '../evidence/engine';
import type { EvidenceReport, MetricEvidence } from '../evidence/types';
import { marketplaceEvidenceContributor } from './evidence';
import type { MarketplaceCoverageReport, CapabilityCoverage } from '../coverage';

/**
 * What a rule declares it needs. Checked by the engine, not by the rule.
 * Every field is REQUIRED — a rule cannot decline to state its requirements.
 */
export interface RuleRequirements {
  /** Metric ids this rule reads. All must be available, or the rule is suppressed. */
  metrics: readonly string[];
  /** Minimum confidence each required metric must carry. */
  minimumConfidence: number;
  /** Minimum records examined before the rule may speak. */
  minimumSampleSize: number;
  /**
   * Minimum observed/total ratio, or null when the rule reasons about ABSENCE
   * and therefore has no coverage floor to meet.
   */
  coverageRequirement: number | null;
}

/** The context a rule receives. It contains ONLY metrics that cleared Layer 1. */
export interface GatedContext {
  evidence: EvidenceReport;
  /** Guaranteed available: the engine verified it before calling evaluate. */
  metric(metricId: string): MetricEvidence;
  /** The underlying capability, for reason/citation text. */
  capability(metricId: string): CapabilityCoverage | undefined;
  /**
   * The measured scalar behind a metric, when the domain has one.
   *
   * Kept OUT of `MetricEvidence` deliberately. The Evidence Engine records the
   * evidential position on a metric — where it came from, how complete it is,
   * whether it can be trusted — not the quantity itself. Coverage metrics have
   * no single scalar at all, so a `value` on the platform type would be null
   * for the domain that engine was written for.
   *
   * Returns null when the domain supplies no value for this metric. A rule must
   * treat null as unknown, never as zero.
   */
  value(metricId: string): number | null;
}

export interface MarketplaceRule {
  id: string;
  purpose: string;
  /** Who a finding from this rule is addressed to. */
  owner: MarketplaceFinding['owner'];
  requires: RuleRequirements;
  evaluate(ctx: GatedContext): RuleOutcome | null;
}

/** Why a rule did not run or did not speak. */
export interface RuleSuppression {
  ruleId: string;
  reason: string;
  needs: string;
  /** Which layer stopped it — makes the two-layer flow auditable. */
  suppressedBy: 'confidence-engine' | 'intelligence-engine';
}

/**
 * Project platform evidence onto the rule-facing evidence shape.
 *
 * The Evidence Engine records provenance and coverage; a finding needs
 * countable statements. This keeps the two concerns separate rather than making
 * the platform layer emit finding-shaped prose.
 */
function coverageEvidence(m: MetricEvidence) {
  const source = m.provenance[0]?.citation ?? m.provenance[0]?.sourceLabel ?? 'evidence engine';
  if (!m.coverage) {
    return [
      {
        statement: `Records examined without ${m.label.toLowerCase()}`,
        observed: m.sampleSize,
        denominator: m.sampleSize,
        source,
      },
    ];
  }
  const total = m.coverage.total;
  return [
    {
      statement: `Calls carrying ${m.label.toLowerCase()}`,
      observed: m.coverage.observed,
      denominator: total,
      source: 'MarketplaceCall coverage observations',
    },
    {
      statement: `Calls missing ${m.label.toLowerCase()}`,
      // An unknown denominator means the missing count is unknowable too —
      // reporting 0 would claim nothing is missing.
      observed: total === null ? 0 : total - m.coverage.observed,
      denominator: total,
      source: 'MarketplaceCall coverage observations',
    },
  ];
}

function coverageGapRule(opts: {
  id: string;
  metricId: string;
  metricLabel: string;
  consequence: string;
  recommendation: string;
}): MarketplaceRule {
  return {
    id: opts.id,
    purpose: `Detect when ${opts.metricLabel.toLowerCase()} is reported on only some calls.`,
    owner: 'platform',
    requires: {
      metrics: [opts.metricId],
      minimumConfidence: 0.5,
      minimumSampleSize: 10,
      // No floor: the rule exists precisely to report LOW coverage.
      coverageRequirement: null,
    },
    evaluate(ctx) {
      const m = ctx.metric(opts.metricId);
      // A null denominator means coverage cannot be judged, so this rule — which
      // exists to report PARTIAL coverage — has nothing it can honestly say.
      if (!m.coverage || m.coverage.total === null) return null;
      const { observed } = m.coverage;
      const total: number = m.coverage.total;
      // Full coverage is not a finding. Silence is the correct output.
      if (observed >= total) return null;
      const missing = total - observed;

      return publishFinding({
        id: opts.id,
        whatHappened: `${opts.metricLabel} is reported on ${observed} of ${total} calls.`,
        why: `The sensor did not populate ${opts.metricLabel.toLowerCase()} on ${missing} call(s), so any total built from it counts only the ${observed} it could see.`,
        owner: 'platform',
        entity: null,
        category: 'provider',
        impact: {
          kind: 'volume-only',
          lostOpportunities: missing,
          whyNotPriced: `${opts.consequence} The missing amounts cannot be estimated from the present ones without assuming they resemble each other.`,
        },
        evidence: coverageEvidence(m),
        confidence: {
          value: 0.9,
          sampleSize: m.sampleSize,
          minimumSampleSize: 10,
          coverage: total === 0 ? null : observed / total,
          basis: `${m.sampleSize} call(s) examined; ${observed} of ${total} carried the field`,
        },
        recommendedAction: opts.recommendation,
        missingEvidence: [`${opts.metricLabel} for ${missing} call(s)`],
      });
    },
  };
}

function capabilityAbsentRule(opts: {
  id: string;
  metricId: string;
  capabilityLabel: string;
  consequence: string;
}): MarketplaceRule {
  return {
    id: opts.id,
    purpose: `Detect that ${opts.capabilityLabel.toLowerCase()} cannot be reported at all.`,
    owner: 'platform',
    requires: {
      metrics: [opts.metricId],
      // ZERO, deliberately. Layer 1 measures how trustworthy a metric's VALUE
      // is, and an absence rule does not read the value — it reads the
      // capability's STATUS. A metric populated on no calls scores 0 confidence,
      // which is exactly the condition this rule exists to report; treating that
      // as a disqualifier would suppress the rule precisely when it has
      // something to say.
      minimumConfidence: 0,
      minimumSampleSize: 1,
      // Reasons about ABSENCE — a coverage floor would be incoherent.
      coverageRequirement: null,
    },
    evaluate(ctx) {
      const c = ctx.capability(opts.metricId);
      if (!c || c.status !== 'unavailable' || c.tier === 'not-populated') return null;
      const m = ctx.metric(opts.metricId);

      return publishFinding({
        id: opts.id,
        whatHappened: `${opts.capabilityLabel} is not available in Loop.`,
        why: c.reason ?? 'The capability has no source.',
        owner: c.tier === 'not-ingested' ? 'platform' : 'unknown',
        entity: null,
        category: c.tier === 'not-specified' ? 'unknown' : 'provider',
        impact: {
          kind: 'unquantified',
          reason: `${opts.consequence} The volume affected cannot be counted, because the field that would count it is the one missing.`,
        },
        evidence: coverageEvidence(m),
        confidence: {
          value: 0.9,
          sampleSize: m.sampleSize,
          minimumSampleSize: 1,
          coverage: 1,
          basis: 'A structural absence is observable directly; no sampling is involved.',
        },
        // Unquantified impact must never instruct — publishFinding enforces it.
        recommendedAction: null,
        missingEvidence: m.missingProviderData.length > 0 ? m.missingProviderData : [`${opts.capabilityLabel} source`],
      });
    },
  };
}

/** The rules that have verified evidence today. Business logic UNCHANGED. */
export const MARKETPLACE_RULES: readonly MarketplaceRule[] = [
  coverageGapRule({
    id: 'revenue-coverage-risk',
    metricId: 'revenue',
    metricLabel: 'Revenue',
    consequence: 'Reported revenue is a LOWER BOUND, and margin confidence is reduced with it.',
    recommendation:
      'Ask CallGrid why revenue is absent on these calls before treating any revenue total as final.',
  }),
  coverageGapRule({
    id: 'payout-coverage-risk',
    metricId: 'payout',
    metricLabel: 'Payout',
    consequence: 'Margin is revenue minus payout, so an incomplete payout inflates apparent margin.',
    recommendation:
      'Ask CallGrid why payout is absent on these calls; margin is overstated until it is complete.',
  }),
  capabilityAbsentRule({
    id: 'duplicate-detection-missing',
    metricId: 'duplicates',
    capabilityLabel: 'Duplicate detection',
    consequence:
      'Duplicate calls cannot be identified, so volume and revenue may both be overstated by repeats.',
  }),
  capabilityAbsentRule({
    id: 'transcript-capability-missing',
    metricId: 'transcripts',
    capabilityLabel: 'Transcript intelligence',
    consequence: 'Call content cannot be reasoned about at all.',
  }),
  capabilityAbsentRule({
    id: 'recording-capability-missing',
    metricId: 'recordings',
    capabilityLabel: 'Call recordings',
    consequence: 'A finding cannot be traced to the call that produced it.',
  }),
] as const;

export interface UnbuiltRule {
  id: string;
  purpose: string;
  needs: string;
}

export const unbuiltRules = (): readonly UnbuiltRule[] => [
  {
    id: 'rate-limiting',
    purpose: 'Identify destinations losing opportunity to throughput limits.',
    needs: 'A live /api/reports/pingStats response. The contract is verified; no response has been read.',
  },
  {
    id: 'capacity',
    purpose: 'Identify buyers whose caps are exhausting demand.',
    needs: 'A live /api/reports/bidStats/rejections response.',
  },
  {
    id: 'bid-pricing',
    purpose: 'Identify entities bidding below the observed winning threshold.',
    needs:
      'A live /api/reports/bidStats response, plus confirmation of whether its money fields are dollars or minor units.',
  },
];

export interface EngineResult {
  /** Layer 1's output, so the whole chain is auditable. */
  evidence: EvidenceReport;
  findings: MarketplaceFinding[];
  /** Rules stopped before or during evaluation, each naming the layer. */
  withheld: RuleSuppression[];
  unbuilt: readonly UnbuiltRule[];
  rulesEvaluated: number;
}

/**
 * Check a rule's declared requirements against Layer 1.
 *
 * Returns null when the rule may run. This is where automatic suppression
 * happens: a withheld metric never reaches the rule.
 */
function checkRequirements(
  rule: MarketplaceRule,
  evidence: EvidenceReport,
): RuleSuppression | null {
  // Order matters, and it is semantic rather than arbitrary:
  //
  //   1. Did Layer 1 withhold the metric entirely? Most fundamental — the value
  //      does not exist to reason over, so nothing else is worth checking.
  //   2. Is the sample large enough for THIS rule? A rule's own declared floor.
  //   3. Is confidence high enough? Only meaningful once the sample supports it,
  //      because with too few records low confidence is a CONSEQUENCE of the
  //      small sample rather than an independent problem.
  //   4. Coverage requirement.
  //
  // Reporting them out of order would name a symptom instead of a cause.

  // 1. Withheld by Layer 1.
  for (const metricId of rule.requires.metrics) {
    if (availableMetric(evidence, metricId)) continue;
    const w = evidence.withheld.find((m) => m.metricId === metricId);
    return {
      ruleId: rule.id,
      reason: w
        ? `Required metric "${metricId}" was withheld by the confidence engine: ${w.withheldReason}`
        : `Required metric "${metricId}" is not assessed.`,
      needs: `Metric "${metricId}" available with confidence >= ${rule.requires.minimumConfidence}.`,
      suppressedBy: 'confidence-engine',
    };
  }

  // 2. The rule's own sample floor.
  if (evidence.populationSize < rule.requires.minimumSampleSize) {
    return {
      ruleId: rule.id,
      reason: `Sample of ${evidence.populationSize} is below this rule's declared minimum of ${rule.requires.minimumSampleSize}.`,
      // "records", not "calls": this gate is shared with auction reporting,
      // whose population is report rows. Naming one domain's unit here would
      // make the other domain's suppression message read as a lie.
      needs: `At least ${rule.requires.minimumSampleSize} records in the window.`,
      suppressedBy: 'intelligence-engine',
    };
  }

  // 3 and 4. Trust in the metric itself.
  for (const metricId of rule.requires.metrics) {
    const metric = availableMetric(evidence, metricId)!;

    if (metric.confidence < rule.requires.minimumConfidence) {
      return {
        ruleId: rule.id,
        reason: `Metric "${metricId}" carries confidence ${metric.confidence.toFixed(2)}, below this rule's declared minimum of ${rule.requires.minimumConfidence}.`,
        needs: `Higher coverage or a larger sample for "${metricId}".`,
        suppressedBy: 'confidence-engine',
      };
    }

    if (
      rule.requires.coverageRequirement !== null &&
      (!metric.coverage ||
        metric.coverage.total === null ||
        metric.coverage.total === 0 ||
        metric.coverage.observed / metric.coverage.total < rule.requires.coverageRequirement)
    ) {
      return {
        ruleId: rule.id,
        reason: `Metric "${metricId}" does not meet the rule's coverage requirement of ${rule.requires.coverageRequirement}.`,
        needs: `Coverage of at least ${rule.requires.coverageRequirement} for "${metricId}".`,
        suppressedBy: 'confidence-engine',
      };
    }
  }

  return null;
}

/**
 * Run both layers.
 *
 * Flow:  coverage -> Layer 1 assesses every metric -> for each rule, check its
 * declared requirements -> suppressed rules never evaluate -> surviving rules
 * receive a context containing ONLY available metrics -> publishFinding applies
 * the seven-question contract.
 */
export function runMarketplaceIntelligence(input: {
  coverage: MarketplaceCoverageReport;
  measuredAt: string;
}): EngineResult {
  // --- Layer 1: the platform Evidence Engine -------------------------------
  const evidence = assessEvidence(
    marketplaceEvidenceContributor,
    { coverage: input.coverage },
    input.measuredAt,
  );

  // --- Layer 2 -------------------------------------------------------------
  return {
    ...runRules(MARKETPLACE_RULES, evidence, (metricId) =>
      input.coverage.capabilities.find((c) => c.id === metricId)),
    evidence,
    unbuilt: unbuiltRules(),
  };
}

/**
 * Layer 2, over any rule set and any Layer 1 report.
 *
 * Extracted from `runMarketplaceIntelligence` so auction reporting runs through
 * THIS gate rather than growing a second one beside it. A second gate would
 * drift — and the first thing to drift would be the suppression rules, which is
 * the one part of this system whose whole purpose is to be strict.
 *
 * Behaviour is unchanged for the marketplace caller: same order of checks, same
 * suppression reasons, same `publishFinding` contract.
 */
export function runRules(
  rules: readonly MarketplaceRule[],
  evidence: EvidenceReport,
  capabilityFor: (metricId: string) => CapabilityCoverage | undefined = () => undefined,
  valueFor: (metricId: string) => number | null = () => null,
): Omit<EngineResult, 'evidence' | 'unbuilt'> {
  const findings: MarketplaceFinding[] = [];
  const withheld: RuleSuppression[] = [];

  const ctx: GatedContext = {
    evidence,
    metric(metricId) {
      const m = availableMetric(evidence, metricId);
      if (!m) {
        // Unreachable: checkRequirements ran first. Loud rather than silent, so
        // a future refactor that bypasses the gate fails visibly.
        throw new Error(
          `Rule read metric "${metricId}" without clearing the confidence engine. ` +
            'This indicates the requirement gate was bypassed.',
        );
      }
      return m;
    },
    capability: capabilityFor,
    value: valueFor,
  };

  for (const rule of rules) {
    const suppression = checkRequirements(rule, evidence);
    if (suppression) {
      withheld.push(suppression);
      continue; // evaluate() is never called
    }

    const outcome = rule.evaluate(ctx);
    if (outcome === null) continue; // healthy — correctly silent
    if (outcome.fired) findings.push(outcome.finding);
    else
      withheld.push({
        ruleId: outcome.withheld.ruleId,
        reason: outcome.withheld.reason,
        needs: outcome.withheld.needs,
        suppressedBy: 'intelligence-engine',
      });
  }

  return { findings: rankFindings(findings), withheld, rulesEvaluated: rules.length };
}
