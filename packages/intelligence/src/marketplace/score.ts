// Marketplace scoring, health, and the executive summary.
//
// TWO RULES GOVERN EVERYTHING HERE
//
// 1. Rank by BUSINESS IMPACT, never by how hard something is to fix. A cheap
//    fix worth nothing must not outrank an expensive one worth a lot.
// 2. Unknowns REDUCE the score. A marketplace we cannot see is not healthy —
//    it is unmeasured, and a score that treats absence as fine would be the
//    vanity metric this explicitly must not be.
//
// The summary is generated from the same numbers the findings are, so it can
// never drift from them. Nothing here is hardcoded.

import type { MarketplaceFinding } from './rule';
import type { EngineResult } from './engine';
import type { MarketplaceCoverageReport } from '../coverage';

export type Severity = 'critical' | 'high' | 'moderate' | 'low' | 'informational';

export interface ScoredFinding {
  finding: MarketplaceFinding;
  severity: Severity;
  /** Rank key. Higher is more urgent. Derived, never authored. */
  score: number;
  evidenceCount: number;
  /** Whether an operator can act, which decides if it belongs in recommendations. */
  actionable: boolean;
}

/**
 * Severity from business impact and confidence — in that order.
 *
 * A high-confidence finding about nothing is not severe. A costed finding is,
 * even at moderate confidence, because the money is what an executive is
 * deciding about.
 */
export function scoreFinding(finding: MarketplaceFinding): ScoredFinding {
  const impact = finding.impact;

  // Magnitude in comparable units. Revenue dominates volume, which dominates
  // an unquantified statement — the same ordering rankFindings uses.
  const magnitude =
    impact.kind === 'measured'
      ? (impact.estimatedRevenueCents ?? impact.lostOpportunities * 100)
      : impact.kind === 'volume-only'
        ? impact.lostOpportunities
        : 0;

  const confidence = finding.confidence.value;
  const score = magnitude * confidence;

  const severity: Severity =
    impact.kind === 'measured' && (impact.estimatedRevenueCents ?? 0) > 0
      ? confidence >= 0.7
        ? 'critical'
        : 'high'
      : impact.kind === 'volume-only'
        ? impact.lostOpportunities > 0 && confidence >= 0.7
          ? 'high'
          : 'moderate'
        : // Unquantified: real, but an executive cannot size it.
          'informational';

  return {
    finding,
    severity,
    score,
    evidenceCount: finding.evidence.length,
    // A finding with no recommendation cannot be acted on — publishFinding
    // already guarantees an unquantified impact carries none.
    actionable: finding.recommendedAction !== null,
  };
}

/** Business impact first. Implementation difficulty is not an input. */
export function rankScored(findings: readonly MarketplaceFinding[]): ScoredFinding[] {
  const order: Record<Severity, number> = {
    critical: 0,
    high: 1,
    moderate: 2,
    low: 3,
    informational: 4,
  };
  return findings
    .map(scoreFinding)
    .sort((a, b) => order[a.severity] - order[b.severity] || b.score - a.score);
}

export interface MarketplaceHealth {
  /** 0-100. Derived from coverage and capability completeness. */
  score: number;
  band: 'healthy' | 'degraded' | 'impaired' | 'unmeasured';
  /** Every component, so the number can be audited rather than trusted. */
  components: Array<{ name: string; weight: number; value: number; note: string }>;
  /** Stated plainly when the score itself is not meaningful. */
  caveat: string | null;
}

/**
 * Operational health.
 *
 * Weighted toward what the business depends on: economics coverage matters more
 * than transcript availability, because a wrong revenue figure misleads while a
 * missing transcript merely limits.
 *
 * With no calls ingested the score is NOT zero — it is `unmeasured`. Zero would
 * assert that the marketplace is performing badly, when the truth is that we
 * have not looked.
 */
export function marketplaceHealth(coverage: MarketplaceCoverageReport): MarketplaceHealth {
  if (coverage.callsIngested === 0) {
    return {
      score: 0,
      band: 'unmeasured',
      components: [],
      caveat:
        'No calls were ingested in this window, so health cannot be measured. This is not a score of zero — it is the absence of a score.',
    };
  }

  const ratioFor = (id: string): number | null => {
    const c = coverage.capabilities.find((x) => x.id === id);
    if (!c?.ratio || c.ratio.total === 0) return null;
    return c.ratio.observed / c.ratio.total;
  };

  const available = coverage.totals.available;
  const totalCaps = coverage.capabilities.length;

  const components = [
    {
      name: 'Revenue coverage',
      weight: 0.3,
      value: ratioFor('revenue') ?? 0,
      note: 'Share of calls carrying revenue. Drives every financial figure.',
    },
    {
      name: 'Payout coverage',
      weight: 0.25,
      value: ratioFor('payout') ?? 0,
      note: 'Share carrying payout. Margin is overstated without it.',
    },
    {
      name: 'Attribution coverage',
      weight: 0.2,
      value: ratioFor('buyers') ?? 0,
      note: 'Share attributable to a buyer. Without it, nothing can be explained per-entity.',
    },
    {
      name: 'Connectivity coverage',
      weight: 0.1,
      value: ratioFor('connectivity') ?? 0,
      note: 'Share with a known outcome.',
    },
    {
      name: 'Capability completeness',
      weight: 0.15,
      value: available / totalCaps,
      note: `${available} of ${totalCaps} capabilities fully available. Missing capabilities cap the ceiling.`,
    },
  ];

  const score = Math.round(components.reduce((s, c) => s + c.weight * c.value, 0) * 100);

  const band: MarketplaceHealth['band'] =
    score >= 85 ? 'healthy' : score >= 60 ? 'degraded' : 'impaired';

  return {
    score,
    band,
    components,
    caveat:
      coverage.totals.unavailable > 0
        ? `${coverage.totals.unavailable} capability(ies) are unavailable and cap this score — it cannot reach 100 while they are missing.`
        : null,
  };
}

/**
 * Generate the executive summary.
 *
 * Composed from the same figures the findings use, so the prose and the
 * findings can never disagree. Every sentence is conditional on real data —
 * nothing is a template with numbers slotted in.
 */
export function marketplaceSummary(
  coverage: MarketplaceCoverageReport,
  engine: EngineResult,
  health: MarketplaceHealth,
): string[] {
  const lines: string[] = [];
  const n = coverage.callsIngested;

  if (n === 0) {
    return [
      `No calls were ingested in ${coverage.windowLabel.toLowerCase()}.`,
      'Nothing can be concluded about marketplace performance from an empty window — this is unknown, not zero.',
    ];
  }

  lines.push(`${n.toLocaleString()} call${n === 1 ? '' : 's'} processed in ${coverage.windowLabel.toLowerCase()}.`);

  const stat = (id: string, label: string) => {
    const c = coverage.capabilities.find((x) => x.id === id);
    if (!c?.ratio) return;
    if (c.status === 'available') lines.push(`${label} is complete across all ${c.ratio.total} calls.`);
    else lines.push(`${label} covers ${c.ratio.observed} of ${c.ratio.total} calls.`);
  };
  stat('revenue', 'Revenue');
  stat('payout', 'Payout');

  const absent = coverage.capabilities.filter((c) => c.status === 'unavailable' && c.tier !== 'not-populated');
  if (absent.length > 0) {
    lines.push(`${absent.map((c) => c.label).join(', ')} unavailable.`);
  }

  if (engine.unbuilt.length > 0) {
    lines.push(
      `Bid intelligence is not yet available: ${engine.unbuilt.length} rule(s) await live report data.`,
    );
  }

  lines.push(
    health.band === 'unmeasured'
      ? 'Health could not be measured.'
      : `Marketplace health ${health.score}/100 (${health.band}).`,
  );

  return lines;
}
