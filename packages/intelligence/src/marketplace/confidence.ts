// LAYER 1 — The Confidence Engine.
//
// One job: measure how trustworthy every metric is. It reaches no conclusions
// about the business and recommends nothing. It answers only "how much can this
// number be relied upon, and what is missing from it".
//
// WHY THIS IS A SEPARATE LAYER
//
// Previously each rule assessed its own trustworthiness inline. That meant every
// new rule re-implemented the judgement, and two rules could disagree about how
// reliable the same metric was — one treating 95/108 revenue coverage as usable
// and another not. Trustworthiness is a property of the METRIC, not of whoever
// happens to be reading it, so it is measured once, here.
//
// The consequence that matters: a metric this layer WITHHOLDS is not passed to
// Layer 2 at all. Rules depending on it are suppressed automatically, because
// the value is never in their reach — not because they remembered to check.
//
// This is the platform standard for every future intelligence module.

import type { CapabilityCoverage, CoverageRatio, MarketplaceCoverageReport } from '../coverage';
import type { RuleEvidence } from './rule';

/** What Layer 1 knows about a single metric. */
export interface MetricConfidence {
  /** Stable id — matches the capability id it derives from. */
  metricId: string;
  label: string;
  /** [0,1], earned from coverage and sample size. Never asserted. */
  confidence: number;
  /** Observed vs examined. Null when there is no meaningful denominator. */
  coverage: CoverageRatio | null;
  /** The counted observations behind the number. */
  evidence: readonly RuleEvidence[];
  /** What is not known about this metric. */
  unknowns: readonly string[];
  /** Specifically: data the PROVIDER did not supply. */
  missingProviderData: readonly string[];
  /** Records examined. Drives sample-size gating in Layer 2. */
  sampleSize: number;
  /**
   * True when this metric must not be reasoned over at all. A withheld metric
   * is not handed to Layer 2, so no rule can read it.
   */
  withheld: boolean;
  withheldReason: string | null;
}

export interface ConfidenceReport {
  measuredAt: string;
  windowLabel: string;
  callsIngested: number;
  /** Every metric assessed, withheld or not. */
  metrics: readonly MetricConfidence[];
  /** Metrics safe to reason over. Layer 2 receives ONLY these. */
  available: readonly MetricConfidence[];
  /** Metrics withheld, with reasons. Surfaced, never dropped. */
  withheld: readonly MetricConfidence[];
}

/**
 * Confidence from coverage and sample size.
 *
 * Capped at 0.9: one window is a reading, not a certainty. A metric about a
 * STRUCTURAL absence can be near-certain — the field either exists or it does
 * not — but a metric about observed data cannot exceed what its sample supports.
 */
function earnedConfidence(c: CapabilityCoverage, callsIngested: number): number {
  if (c.status === 'unavailable' && c.tier !== 'not-populated') {
    // A structural absence is observed directly; there is no sampling involved.
    return 0.9;
  }
  if (c.status === 'undetermined') return 0;

  const ratio = c.ratio && c.ratio.total > 0 ? c.ratio.observed / c.ratio.total : 0;
  const sampleFactor = callsIngested >= 100 ? 1 : callsIngested >= 10 ? 0.85 : 0.6;
  // Full coverage on a large sample tops out at 0.9, never 1.0.
  return Math.min(0.9, ratio * sampleFactor * 0.9 + (c.status === 'available' ? 0.1 : 0));
}

/**
 * Assess every metric.
 *
 * Pure and deterministic. `measuredAt` is injected — this layer has no clock.
 */
export function assessConfidence(
  coverage: MarketplaceCoverageReport,
  measuredAt: string,
): ConfidenceReport {
  const metrics: MetricConfidence[] = coverage.capabilities.map((c) => {
    const evidence: RuleEvidence[] = c.ratio
      ? [
          {
            statement: `Calls carrying ${c.label.toLowerCase()}`,
            observed: c.ratio.observed,
            denominator: c.ratio.total,
            source: 'MarketplaceCall coverage observations',
          },
          {
            statement: `Calls missing ${c.label.toLowerCase()}`,
            observed: c.ratio.total - c.ratio.observed,
            denominator: c.ratio.total,
            source: 'MarketplaceCall coverage observations',
          },
        ]
      : [
          {
            statement: `Calls examined without ${c.label.toLowerCase()}`,
            observed: coverage.callsIngested,
            denominator: coverage.callsIngested,
            source: c.citation ?? 'capability catalogue',
          },
        ];

    const unknowns: string[] = [];
    const missingProviderData: string[] = [];

    if (c.status === 'undetermined') {
      unknowns.push(`Coverage cannot be determined: ${c.evidence}`);
    }
    if (c.ratio && c.ratio.observed < c.ratio.total) {
      missingProviderData.push(
        `${c.label} absent on ${c.ratio.total - c.ratio.observed} of ${c.ratio.total} calls`,
      );
    }
    if (c.status === 'unavailable' && c.tier !== 'not-populated') {
      missingProviderData.push(c.unblockedBy ?? `${c.label} has no source in Loop`);
    }

    // A metric is withheld ONLY when it cannot be reasoned over at all. A
    // partial metric is NOT withheld — it is usable with its coverage attached,
    // which is the distinction that keeps a lower bound useful instead of
    // discarding it.
    const withheld = c.status === 'undetermined';

    return {
      metricId: c.id,
      label: c.label,
      confidence: earnedConfidence(c, coverage.callsIngested),
      coverage: c.ratio,
      evidence,
      unknowns,
      missingProviderData,
      sampleSize: coverage.callsIngested,
      withheld,
      withheldReason: withheld
        ? `No calls were ingested in ${coverage.windowLabel.toLowerCase()}, so this metric has nothing to measure. Unknown is not zero.`
        : null,
    };
  });

  return {
    measuredAt,
    windowLabel: coverage.windowLabel,
    callsIngested: coverage.callsIngested,
    metrics,
    available: metrics.filter((m) => !m.withheld),
    withheld: metrics.filter((m) => m.withheld),
  };
}

/** Look up an AVAILABLE metric. Withheld metrics are unreachable by construction. */
export function availableMetric(
  report: ConfidenceReport,
  metricId: string,
): MetricConfidence | undefined {
  return report.available.find((m) => m.metricId === metricId);
}
