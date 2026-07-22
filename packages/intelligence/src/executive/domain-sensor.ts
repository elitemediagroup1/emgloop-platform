// Executive Brain — the reusable domain-sensor builder.
//
// Marketplace was hand-wired (marketplace/executive-sensor.ts). Every other
// domain — CRM, Website, Loop Activity, Users — has the same shape: read
// windowed counts, assess them through the Evidence Engine, and emit findings.
// This builder captures that shape once so a new sensor is a few dozen lines of
// "here are my counts", not a bespoke engine.
//
// Given per-metric counts for the current window (and optionally the prior one)
// it produces an ExecutiveSensor whose EvidenceReport is real Evidence Engine
// output, and it AUTO-GENERATES two kinds of finding:
//
//   - coverage-gap RISK — when a metric is reported on only some of its
//     population (observed < total), the same discipline as the marketplace
//     coverage rules.
//   - What-Changed OBSERVATION — when a metric moved between the prior and
//     current window, stated as a fact with the delta attached.
//
// Both cite the metric they stand on, so the Brain's strict gate applies
// uniformly: if the metric was withheld (empty window, contradiction, staleness
// beyond policy), the finding is dropped rather than asserting a change or a gap
// it cannot evidence. Pure; `measuredAt` is injected.

import { assessEvidence } from '../evidence/engine';
import type { EvidenceContributor, MetricObservation, Provenance } from '../evidence/types';
import { changePercentOf, directionOf, type ObservationSeverity } from './observation';
import type { ExecutiveSensor, SensorFinding } from './sensor';

/** One metric a domain sensor reports, as counts. */
export interface DomainMetricInput {
  metricId: string;
  label: string;
  /** Records carrying this metric in the current window (or the count itself). */
  observed: number;
  /** The population/denominator, or null when there is no meaningful one. */
  total: number | null;
  /** The same metric's `observed` in the prior window, for What Changed. Omit
   * when no comparable prior window exists — then no change is claimed. */
  prior?: number | null;
  provenance: readonly Provenance[];
  /** Set when the metric CANNOT exist in this system (no field, no source). */
  structurallyAbsent?: { reason: string; unblockedBy: string | null } | null;
  /** When the source says the data was current, if it says. Drives staleness. */
  sourceObservedAt?: string | null;
  /** When true and observed < total, raise a coverage-gap risk. */
  raiseCoverageGap?: boolean;
  /** When true and a prior exists, emit a What-Changed observation. */
  trackChange?: boolean;
  /** Human phrasing for narratives, e.g. "New customers". Defaults to `label`. */
  narrative?: string;
  /** Business-impact text for a coverage gap on this metric. */
  gapImpact?: string;
  /** Recommendation for a coverage gap on this metric, addressed to the owner. */
  gapRecommendation?: string;
  /** Owner of a finding on this metric. */
  owner?: string | null;
}

export interface DomainSensorSpec {
  id: string;
  label: string;
  domain: string;
  scopeLabel: string;
  /** Records in the population examined. Drives sample-size gating. */
  populationSize: number;
  /** Beyond this age the domain considers its evidence stale. Null = no policy. */
  staleAfterMs: number | null;
  /** The domain's own sentence for "nothing was examined". */
  emptyScopeReason: string;
  measuredAt: string;
  /** Business area for the Details panel; defaults to `label`. */
  affectedArea?: string;
  metrics: readonly DomainMetricInput[];
  /** Caller-authored findings, each of which must cite metric ids. */
  extraFindings?: readonly SensorFinding[];
}

/** Grade a percentage magnitude into a severity band (deterministic). */
function severityOfChange(pct: number | null): ObservationSeverity {
  if (pct === null) return 'notable';
  const mag = Math.abs(pct);
  if (mag >= 40) return 'high';
  if (mag >= 15) return 'notable';
  return 'informational';
}

function changeNarrative(name: string, dir: 'up' | 'down' | 'flat', pct: number | null): string {
  const verb = dir === 'up' ? 'rose' : dir === 'down' ? 'fell' : 'held steady';
  if (pct === null || dir === 'flat') return `${name} ${verb} versus the prior window.`;
  return `${name} ${verb} ${Math.abs(Math.round(pct))}% versus the prior window.`;
}

/**
 * Build an ExecutiveSensor from windowed domain counts. The EvidenceReport is
 * produced by the Evidence Engine; findings are generated from the metrics plus
 * anything the caller supplied. Pure and deterministic.
 */
export function buildDomainSensor(spec: DomainSensorSpec): ExecutiveSensor {
  const observations: MetricObservation[] = spec.metrics.map((m) => ({
    metricId: m.metricId,
    label: m.label,
    observed: m.observed,
    // A pure count (no denominator) is expressed to the Evidence Engine as
    // COMPLETE self-coverage: we counted all of what we counted. Without this it
    // would score 0 confidence (the engine reserves that for an UNKNOWN
    // denominator), which would make a real, exact count look untrustworthy. The
    // count's confidence then comes honestly from the sensor's sample size. The
    // raw value is still carried on the change/facts, never lost.
    total: m.total === null ? m.observed : m.total,
    structurallyAbsent: m.structurallyAbsent ?? null,
    provenance: m.provenance,
    sourceObservedAt: m.sourceObservedAt ?? null,
  }));

  const contributor: EvidenceContributor<null> = {
    domain: spec.domain,
    populationSize: () => spec.populationSize,
    scopeLabel: () => spec.scopeLabel,
    staleAfterMs: spec.staleAfterMs,
    emptyScopeReason: () => spec.emptyScopeReason,
    observe: () => observations,
  };

  const report = assessEvidence(contributor, null, spec.measuredAt);
  const affectedArea = spec.affectedArea ?? spec.label;
  const findings: SensorFinding[] = [];

  for (const m of spec.metrics) {
    const name = m.narrative ?? m.label;

    // What Changed — a movement between two windows, stated as a fact.
    if (m.trackChange && m.prior !== undefined && m.prior !== null) {
      const dir = directionOf(m.observed, m.prior);
      if (dir !== 'flat') {
        const pct = changePercentOf(m.observed, m.prior);
        findings.push({
          id: `${m.metricId}-change`,
          kind: 'change',
          observation: changeNarrative(name, dir, pct),
          citesMetricIds: [m.metricId],
          businessImpact: null,
          recommendation: null,
          owner: m.owner ?? null,
          severity: severityOfChange(pct),
          affectedArea,
          change: { metricId: m.metricId, current: m.observed, prior: m.prior, direction: dir, changePercent: pct },
          facts: [
            { statement: `${name} — prior window`, observed: m.prior, denominator: null, source: spec.label },
            { statement: `${name} — current window`, observed: m.observed, denominator: null, source: spec.label },
          ],
        });
      }
    }

    // Coverage gap — a metric reported on only part of its population.
    if (m.raiseCoverageGap && m.total !== null && m.observed < m.total) {
      const missing = m.total - m.observed;
      findings.push({
        id: `${m.metricId}-coverage-gap`,
        kind: 'risk',
        observation: `${m.label} is present on ${m.observed} of ${m.total} record(s).`,
        citesMetricIds: [m.metricId],
        businessImpact:
          m.gapImpact ?? `${missing} record(s) carry no ${m.label.toLowerCase()}, so any figure built from it is a lower bound.`,
        recommendation: m.gapRecommendation
          ? { action: m.gapRecommendation, expectedImpact: `Closes the gap on ${missing} record(s).`, owner: m.owner ?? null }
          : null,
        owner: m.owner ?? null,
        severity: 'notable',
        affectedArea,
        facts: [
          { statement: `Records carrying ${m.label.toLowerCase()}`, observed: m.observed, denominator: m.total, source: spec.label },
          { statement: `Records missing ${m.label.toLowerCase()}`, observed: missing, denominator: m.total, source: spec.label },
        ],
      });
    }
  }

  if (spec.extraFindings) findings.push(...spec.extraFindings);

  return { id: spec.id, label: spec.label, instrumented: true, report, findings };
}
