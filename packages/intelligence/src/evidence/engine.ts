// The Evidence Engine — one uniform assessment for every domain.
//
// A domain supplies observations. This derives coverage, sample size,
// confidence, freshness, contradictions and withholding from them, identically
// for Marketplace, CRM, Talent, Care and Web.
//
// The engine contains NO domain knowledge. If a rule here ever needed to know
// what a "call" or a "candidate" is, the generalisation would have failed.

import type {
  EvidenceContributor,
  EvidenceReport,
  Freshness,
  MetricEvidence,
  MetricObservation,
} from './types';

/** Confidence never reaches certainty from a single measurement. */
export const CONFIDENCE_CEILING = 0.9;

/**
 * Derive confidence.
 *
 * DERIVED, never asserted — from coverage, sample size, staleness and
 * contradictions. Exported so a domain can see exactly how its number was
 * produced rather than treating it as a black box.
 *
 * A structural absence scores at the ceiling: "this field does not exist" is
 * observable directly and involves no sampling, so it is among the most certain
 * statements the platform can make.
 */
export function deriveConfidence(input: {
  observed: number;
  total: number | null;
  sampleSize: number;
  structurallyAbsent: boolean;
  stale: boolean;
  contradictionCount: number;
}): number {
  if (input.structurallyAbsent) return CONFIDENCE_CEILING;
  // Nothing examined: no basis for any confidence at all.
  if (input.sampleSize === 0 || input.total === null || input.total === 0) return 0;

  const ratio = input.observed / input.total;
  // A small sample supports less, however complete its coverage.
  const sampleFactor = input.sampleSize >= 100 ? 1 : input.sampleSize >= 10 ? 0.85 : 0.6;
  const complete = input.observed >= input.total;

  let confidence = Math.min(CONFIDENCE_CEILING, ratio * sampleFactor * 0.9 + (complete ? 0.1 : 0));

  // Stale evidence is still evidence, but less of it.
  if (input.stale) confidence *= 0.5;
  // A contradiction is worse than an unknown: sources actively disagree.
  if (input.contradictionCount > 0) confidence *= 0.25;

  return confidence;
}

function deriveFreshness(
  observation: MetricObservation,
  measuredAt: string,
  staleAfterMs: number | null,
): Freshness {
  const sourceObservedAt = observation.sourceObservedAt ?? null;

  if (sourceObservedAt === null) {
    return {
      measuredAt,
      sourceObservedAt: null,
      ageMs: null,
      staleAfterMs,
      // NOT assumed fresh. An unknown age is unknown, and saying so is the
      // difference between a stale figure and a figure nobody checked.
      stale: false,
      note: 'The source supplied no timestamp, so age cannot be determined.',
    };
  }

  const ageMs = new Date(measuredAt).getTime() - new Date(sourceObservedAt).getTime();
  const stale = staleAfterMs !== null && ageMs > staleAfterMs;
  return {
    measuredAt,
    sourceObservedAt,
    ageMs,
    staleAfterMs,
    stale,
    note: stale ? `Evidence is older than the ${Math.round(staleAfterMs! / 1000)}s freshness policy.` : null,
  };
}

/**
 * Assess a domain's observations.
 *
 * Pure and deterministic; `measuredAt` is injected because this layer has no
 * clock. Withholding rules are uniform across every domain:
 *
 *   - nothing was examined      -> withheld (unknown is not zero)
 *   - sources contradict        -> withheld (conflicting speech beats silence)
 *   - the domain declared it unusable -> withheld (see MetricObservation.unusable)
 *
 * Partial coverage does NOT withhold. A lower bound with its coverage attached
 * is useful; discarding it would lose real information.
 */
export function assessEvidence<TInput>(
  contributor: EvidenceContributor<TInput>,
  input: TInput,
  measuredAt: string,
): EvidenceReport {
  const populationSize = contributor.populationSize(input);
  const observations = contributor.observe(input);

  const metrics: MetricEvidence[] = observations.map((o) => {
    const contradictions = o.contradictions ?? [];
    const structurallyAbsent = o.structurallyAbsent !== null;
    const unusable = o.unusable ?? null;
    const freshness = deriveFreshness(o, measuredAt, contributor.staleAfterMs);

    const derived = deriveConfidence({
      observed: o.observed,
      total: o.total,
      sampleSize: populationSize,
      structurallyAbsent,
      stale: freshness.stale,
      contradictionCount: contradictions.length,
    });

    // A metric the domain has refused carries no confidence. Leaving the
    // derived score visible would let a caller that ignores `withheld` read a
    // healthy-looking number off a metric its own domain declared unusable.
    const confidence = unusable !== null ? 0 : derived;

    const unknowns = [...(o.unknowns ?? [])];
    const missingProviderData = [...(o.missingProviderData ?? [])];

    if (structurallyAbsent && o.structurallyAbsent) {
      missingProviderData.push(o.structurallyAbsent.unblockedBy ?? o.structurallyAbsent.reason);
    }
    if (o.total !== null && o.observed < o.total) {
      missingProviderData.push(`${o.label} absent on ${o.total - o.observed} of ${o.total} record(s)`);
    }

    const nothingExamined = populationSize === 0;
    if (nothingExamined) unknowns.push(contributor.emptyScopeReason(input));

    // A STRUCTURAL absence is not withheld by an empty population. "This system
    // has no field for X" is true whether zero or a million records were
    // examined — its truth does not depend on the sample, which is why
    // deriveConfidence scores it at the ceiling. Withholding it here would
    // discard a fact the engine can state with certainty.
    const withheld =
      (nothingExamined && !structurallyAbsent) || contradictions.length > 0 || unusable !== null;

    return {
      metricId: o.metricId,
      label: o.label,
      domain: contributor.domain,
      coverage: o.total === null ? null : { observed: o.observed, total: o.total },
      sampleSize: populationSize,
      confidence,
      freshness,
      provenance: o.provenance,
      unknowns,
      contradictions,
      missingProviderData,
      withheld,
      // Ordered most-fundamental first, so the reason names the cause rather
      // than a symptom: nothing to measure beats disagreement about the
      // measurement, which beats a domain-specific refusal.
      withheldReason: nothingExamined && !structurallyAbsent
        ? contributor.emptyScopeReason(input)
        : contradictions.length > 0
          ? `Sources disagree about this metric: ${contradictions[0]!.statement}`
          : unusable !== null
            ? unusable.reason
            : null,
    };
  });

  return {
    domain: contributor.domain,
    scopeLabel: contributor.scopeLabel(input),
    measuredAt,
    populationSize,
    metrics,
    available: metrics.filter((m) => !m.withheld),
    withheld: metrics.filter((m) => m.withheld),
  };
}

/** Look up an AVAILABLE metric. Withheld metrics are unreachable by construction. */
export function availableMetric(
  report: EvidenceReport,
  metricId: string,
): MetricEvidence | undefined {
  return report.available.find((m) => m.metricId === metricId);
}
