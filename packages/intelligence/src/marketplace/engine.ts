// Marketplace Intelligence Engine — reasoning, not reporting.
//
// CallGrid remains the reporting system. Loop explains WHY.
//
// Every rule here derives from VERIFIED evidence: the coverage report, which is
// computed from counted observations against the canonical MarketplaceCall
// record. No rule reads a number it cannot trace to a count.
//
// DELIBERATELY NOT IMPLEMENTED
//
// The brief lists Rate Limiting, Capacity and Bid Pricing rules, each gated on
// "WHEN verified". Bid report data has never been fetched — the endpoints are
// contract-verified but no response has ever been read — so those three rules
// have no evidence and are not built. Writing them against the OpenAPI shape
// would produce findings an executive would act on, derived from data that does
// not exist in Loop. `unbuiltRules()` names them and states what each needs, so
// the gap is visible rather than silently absent.

import {
  publishFinding,
  rankFindings,
  type MarketplaceFinding,
  type RuleOutcome,
  type RuleEvidence,
} from './rule';
import type { CapabilityCoverage, MarketplaceCoverageReport } from '../coverage';

/** What a rule needs to run. Deliberately small — a rule cannot reach for more. */
export interface RuleContext {
  coverage: MarketplaceCoverageReport;
  /** ISO timestamp, injected. The engine has no clock. */
  measuredAt: string;
}

export interface MarketplaceRule {
  id: string;
  /** One line, so an operator can see what the engine considered. */
  purpose: string;
  /** Minimum calls before this rule may speak at all. */
  minimumSampleSize: number;
  evaluate(ctx: RuleContext): RuleOutcome | null;
}

const cap = (ctx: RuleContext, id: string): CapabilityCoverage | undefined =>
  ctx.coverage.capabilities.find((c) => c.id === id);

/**
 * Confidence from coverage, never asserted.
 *
 * Capped at 0.9 for a single window — the same discipline as the CallGrid
 * module's 0.7 cap. One window is a reading, not a certainty, and a rule about
 * MISSING data can be more certain than a rule about a trend, but never total.
 */
function confidenceFrom(observed: number, total: number, sampleSize: number, minimum: number) {
  const coverage = total === 0 ? null : observed / total;
  const base = sampleSize >= minimum * 10 ? 0.9 : sampleSize >= minimum ? 0.75 : 0.5;
  return {
    value: base,
    sampleSize,
    minimumSampleSize: minimum,
    coverage,
    basis:
      `${sampleSize} call(s) examined; ` +
      (coverage === null ? 'no denominator' : `${observed} of ${total} carried the field`),
  };
}

/**
 * A coverage-gap rule.
 *
 * Shared by revenue and payout because the reasoning is identical and only the
 * business consequence differs. Duplicating it per metric would let the two
 * drift, which is how one ends up honest and the other does not.
 */
function coverageGapRule(opts: {
  id: string;
  capabilityId: string;
  metricLabel: string;
  consequence: string;
  recommendation: string;
}): MarketplaceRule {
  return {
    id: opts.id,
    purpose: `Detect when ${opts.metricLabel.toLowerCase()} is reported on only some calls.`,
    minimumSampleSize: 10,
    evaluate(ctx) {
      const c = cap(ctx, opts.capabilityId);
      if (!c || !c.ratio) return null;
      // Full coverage is not a finding. Silence is the correct output.
      if (c.status === 'available') return null;

      const { observed, total } = c.ratio;
      const missing = total - observed;

      const evidence: RuleEvidence[] = [
        {
          statement: `Calls carrying ${opts.metricLabel.toLowerCase()}`,
          observed,
          denominator: total,
          source: 'MarketplaceCall coverage observations',
        },
        {
          statement: `Calls missing ${opts.metricLabel.toLowerCase()}`,
          observed: missing,
          denominator: total,
          source: 'MarketplaceCall coverage observations',
        },
      ];

      return publishFinding({
        id: opts.id,
        whatHappened: `${opts.metricLabel} is reported on ${observed} of ${total} calls.`,
        why: `The sensor did not populate ${opts.metricLabel.toLowerCase()} on ${missing} call(s), so any total built from it counts only the ${observed} it could see.`,
        owner: 'platform',
        entity: null,
        category: 'provider',
        // The volume of affected calls is known; what those calls would have
        // been worth is NOT, because their amounts are precisely what is missing.
        impact: {
          kind: 'volume-only',
          lostOpportunities: missing,
          whyNotPriced: `${opts.consequence} The missing amounts cannot be estimated from the present ones without assuming they resemble each other.`,
        },
        evidence,
        confidence: confidenceFrom(observed, total, ctx.coverage.callsIngested, 10),
        recommendedAction: opts.recommendation,
        missingEvidence: [`${opts.metricLabel} for ${missing} call(s)`],
      });
    },
  };
}

/**
 * A capability-absent rule: Loop has no field for this at all.
 *
 * Distinct from a coverage gap. A gap means the sensor was quiet on some calls;
 * an absence means the capability cannot be reported however much data arrives,
 * so the recommendation is addressed to whoever can change that.
 */
function capabilityAbsentRule(opts: {
  id: string;
  capabilityId: string;
  capabilityLabel: string;
  consequence: string;
}): MarketplaceRule {
  return {
    id: opts.id,
    purpose: `Detect that ${opts.capabilityLabel.toLowerCase()} cannot be reported at all.`,
    minimumSampleSize: 1,
    evaluate(ctx) {
      const c = cap(ctx, opts.capabilityId);
      if (!c || c.status !== 'unavailable' || c.tier === 'not-populated') return null;

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
        evidence: [
          {
            statement: `Calls examined without ${opts.capabilityLabel.toLowerCase()}`,
            observed: ctx.coverage.callsIngested,
            denominator: ctx.coverage.callsIngested,
            source: c.citation ?? 'capability catalogue',
          },
        ],
        confidence: {
          value: 0.9,
          sampleSize: ctx.coverage.callsIngested,
          minimumSampleSize: 1,
          coverage: 1,
          basis: 'A structural absence is observable directly; no sampling is involved.',
        },
        // Unquantified impact MUST NOT instruct — publishFinding enforces this,
        // and `unblockedBy` is carried as missingEvidence instead so the path
        // forward is still visible without dressing it as a costed action.
        recommendedAction: null,
        missingEvidence: [c.unblockedBy ?? `${opts.capabilityLabel} source`],
      });
    },
  };
}

/** The rules that have verified evidence today. */
export const MARKETPLACE_RULES: readonly MarketplaceRule[] = [
  coverageGapRule({
    id: 'revenue-coverage-risk',
    capabilityId: 'revenue',
    metricLabel: 'Revenue',
    consequence: 'Reported revenue is a LOWER BOUND, and margin confidence is reduced with it.',
    recommendation:
      'Ask CallGrid why revenue is absent on these calls before treating any revenue total as final.',
  }),
  coverageGapRule({
    id: 'payout-coverage-risk',
    capabilityId: 'payout',
    metricLabel: 'Payout',
    consequence: 'Margin is revenue minus payout, so an incomplete payout inflates apparent margin.',
    recommendation:
      'Ask CallGrid why payout is absent on these calls; margin is overstated until it is complete.',
  }),
  capabilityAbsentRule({
    id: 'duplicate-detection-missing',
    capabilityId: 'duplicates',
    capabilityLabel: 'Duplicate detection',
    consequence:
      'Duplicate calls cannot be identified, so volume and revenue may both be overstated by repeats.',
  }),
  capabilityAbsentRule({
    id: 'transcript-capability-missing',
    capabilityId: 'transcripts',
    capabilityLabel: 'Transcript intelligence',
    consequence: 'Call content cannot be reasoned about at all.',
  }),
  capabilityAbsentRule({
    id: 'recording-capability-missing',
    capabilityId: 'recordings',
    capabilityLabel: 'Call recordings',
    consequence: 'A finding cannot be traced to the call that produced it.',
  }),
] as const;

/** Rules the brief asks for that have no evidence yet. Named, not hidden. */
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
  findings: MarketplaceFinding[];
  /** Rules that ran and declined, with the reason. Never silently dropped. */
  withheld: Array<{ ruleId: string; reason: string; needs: string }>;
  /** Rules not built at all, and what would let them exist. */
  unbuilt: readonly UnbuiltRule[];
  rulesEvaluated: number;
}

/**
 * Run the engine.
 *
 * Pure and deterministic: same context in, same result out. Withheld rules are
 * returned rather than discarded, because "the engine considered this and could
 * not speak" is itself information an executive needs.
 */
export function runMarketplaceIntelligence(ctx: RuleContext): EngineResult {
  const findings: MarketplaceFinding[] = [];
  const withheld: EngineResult['withheld'] = [];

  for (const rule of MARKETPLACE_RULES) {
    const outcome = rule.evaluate(ctx);
    if (outcome === null) continue; // healthy — correctly silent
    if (outcome.fired) findings.push(outcome.finding);
    else withheld.push(outcome.withheld);
  }

  return {
    findings: rankFindings(findings),
    withheld,
    unbuilt: unbuiltRules(),
    rulesEvaluated: MARKETPLACE_RULES.length,
  };
}
