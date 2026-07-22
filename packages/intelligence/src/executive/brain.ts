// Executive Brain — the reasoning layer.
//
// It does not report data. It explains the business: what happened, why it
// happened, what matters, and what to do. It is the platform's single executive
// reasoning surface — it supersedes `assembleExecutiveBriefing`, which composed
// a CallGrid-module output and ranked opportunities/risks by a confidence the
// module asserted about itself.
//
// This layer knows nothing about any domain. It takes SENSORS, each of which
// supplies an EvidenceReport and findings, and it does four uniform things:
//
//   1. Turns each finding into an ExecutiveObservation — but ONLY when every
//      metric the finding cites is AVAILABLE in that sensor's report. A finding
//      that cites a withheld or absent metric is SUPPRESSED, with the reason,
//      never trusted. This is the strict boundary: no evidence, no observation.
//   2. Derives each observation's confidence from the Evidence Engine confidence
//      of the metrics it cites — never from anything the sensor asserted.
//   3. Classifies observations into summary / risks / opportunities /
//      recommendations, ranked by severity then confidence.
//   4. Derives System Health and Evidence Coverage from counts across sensors —
//      never authored — and reports uninstrumented sensors as exactly that.
//
// Everything is pure and deterministic: `now` is injected, ids come from the
// sensors, and given the same sensors it returns the same report. No clock, no
// I/O, no domain vocabulary.

import type { MetricEvidence } from '../evidence/types';
import {
  buildObservation,
  evidenceFromMetric,
  type ExecutiveObservation,
  type ObservationEvidence,
  type ObservationFact,
  type ObservationSeverity,
} from './observation';
import type { ExecutiveSensor, InstrumentedSensor, SensorFinding } from './sensor';
import { runCorrelations } from './correlation';

// ---------------------------------------------------------------------------
// Report shape.
// ---------------------------------------------------------------------------

/** A finding that could not become an observation, and why. Never swallowed —
 * a suppressed insight is information, and hiding it would imply the Brain saw
 * nothing when in fact it refused to speak. */
export interface SuppressedFinding {
  sensorId: string;
  findingId: string;
  observation: string;
  reason: string;
  /** What would let it become an observation next time. */
  needs: string;
}

/**
 * A sensor's connection posture, so an executive knows at a glance which systems
 * are feeding the Brain and how well. DERIVED from data presence and freshness,
 * never authored:
 *
 *   missing    — no Evidence Engine contributor (not connected at all).
 *   connected  — instrumented, but it examined nothing this window, OR nothing
 *                it saw cleared the engine yet. Wired, not yet informative.
 *   stale      — instrumented and carrying data, but at least one metric is
 *                older than the domain's freshness policy.
 *   healthy    — instrumented, examined data, and carrying trustworthy, fresh
 *                metrics.
 */
export type SensorStatus = 'healthy' | 'stale' | 'connected' | 'missing';

/** The evidential position of one sensor, for the Evidence Coverage panel. */
export interface SensorCoverage {
  sensorId: string;
  label: string;
  /** Null for an uninstrumented sensor — it has no domain evidence to speak of. */
  domain: string | null;
  instrumented: boolean;
  /** Connected/healthy/stale/missing — the first-class coverage status. */
  status: SensorStatus;
  scopeLabel: string | null;
  populationSize: number | null;
  metricsAvailable: number;
  metricsWithheld: number;
  /** Available metrics, so a reader can drill into what the Brain reasoned over. */
  available: readonly MetricEvidence[];
  /** Withheld metrics with their reasons — the honest edges. */
  withheld: readonly { label: string; reason: string }[];
  uninstrumentedReason: string | null;
  unblockedBy: string | null;
}

export interface EvidenceCoverageSummary {
  sensors: readonly SensorCoverage[];
  instrumentedSensors: number;
  totalSensors: number;
  /** How many sensors sit in each posture — the executive coverage headline. */
  statusCounts: Record<SensorStatus, number>;
  /** Mean Evidence Engine confidence across every available metric, or null when
   * nothing is measured. Null — never 0 — because unmeasured is not "certainly
   * bad". */
  overallConfidence: number | null;
}

export type HealthBand = 'healthy' | 'watch' | 'at_risk' | 'unknown';

/** Derived operating posture. Every component is stated so the band can be
 * audited rather than trusted, mirroring `marketplaceHealth`. */
export interface SystemHealth {
  band: HealthBand;
  components: readonly { name: string; detail: string }[];
  /** Stated plainly when the band itself is not a meaningful judgement. */
  caveat: string | null;
}

/**
 * The Executive Brain's output — the shape a surface renders. `summary` is
 * narrative-first (the headline observations); `risks`, `opportunities` and
 * `recommendations` are the drill-downs. All four are `ExecutiveObservation`s,
 * so nothing on this report carries a number that is not backed by evidence.
 */
export interface ExecutiveBrainReport {
  generatedAt: string;
  summary: readonly ExecutiveObservation[];
  /** Movements between the prior and current window — the What Changed panel. */
  whatChanged: readonly ExecutiveObservation[];
  /** Cross-sensor conclusions, each built from (and citing) other observations. */
  correlations: readonly ExecutiveObservation[];
  risks: readonly ExecutiveObservation[];
  opportunities: readonly ExecutiveObservation[];
  recommendations: readonly ExecutiveObservation[];
  systemHealth: SystemHealth;
  evidenceCoverage: EvidenceCoverageSummary;
  suppressed: readonly SuppressedFinding[];
  sensors: readonly { id: string; label: string; instrumented: boolean }[];
}

// ---------------------------------------------------------------------------
// Ranking.
// ---------------------------------------------------------------------------

const SEVERITY_RANK: Record<ObservationSeverity, number> = {
  critical: 0,
  high: 1,
  notable: 2,
  informational: 3,
};

/** Most severe first, then most confident. Confidence is the tie-breaker, never
 * the primary key — a costed critical at moderate confidence still outranks a
 * trivial certainty. */
function rankObservations(a: ExecutiveObservation, b: ExecutiveObservation): number {
  return (
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.confidence - a.confidence
  );
}

// ---------------------------------------------------------------------------
// Finding → observation, with the strict evidence gate.
// ---------------------------------------------------------------------------

/**
 * The coverage facts a metric already carries, expressed as drill-down rows.
 * These are what the executive view hides until evidence is expanded.
 */
function factsForMetric(m: MetricEvidence): ObservationFact[] {
  if (!m.coverage) {
    return [
      {
        statement: `${m.label} — records examined`,
        observed: m.sampleSize,
        denominator: m.sampleSize,
        source: m.provenance[0]?.sourceLabel ?? m.domain,
      },
    ];
  }
  return [
    {
      statement: `Records carrying ${m.label.toLowerCase()}`,
      observed: m.coverage.observed,
      denominator: m.coverage.total,
      source: m.provenance[0]?.sourceLabel ?? m.domain,
    },
  ];
}

/**
 * Try to turn one finding into an observation. Returns the observation, or a
 * suppression describing exactly why it could not be built. This function is the
 * strict boundary of the whole layer.
 */
function observeFinding(
  sensor: InstrumentedSensor,
  finding: SensorFinding,
  timestamp: string,
): { observation: ExecutiveObservation } | { suppressed: SuppressedFinding } {
  const suppress = (reason: string, needs: string) => ({
    suppressed: {
      sensorId: sensor.id,
      findingId: finding.id,
      observation: finding.observation,
      reason,
      needs,
    },
  });

  if (finding.citesMetricIds.length === 0) {
    return suppress(
      'The finding cites no evidence, so it cannot become an observation.',
      'At least one Evidence Engine metric this finding stands on.',
    );
  }

  const availableById = new Map(sensor.report.available.map((m) => [m.metricId, m]));
  const cited: MetricEvidence[] = [];
  for (const id of finding.citesMetricIds) {
    const metric = availableById.get(id);
    if (!metric) {
      // The metric is not available — either withheld (contradiction, empty
      // population, or a domain refusal) or absent entirely. Name why, using the
      // Evidence Engine's own reason when it withheld it. This is the path a
      // contradiction takes: a contradicted metric is withheld, so any finding
      // that leaned on it is dropped here rather than carrying a confidence the
      // engine already discounted.
      const withheld = sensor.report.withheld.find((m) => m.metricId === id);
      const why = withheld?.withheldReason ?? `Metric "${id}" is not available in this window.`;
      return suppress(
        `Cited evidence "${id}" is not available: ${why}`,
        'The cited metric to clear the Evidence Engine (be present, uncontradicted, and measured).',
      );
    }
    cited.push(metric);
  }

  const evidence: ObservationEvidence[] = cited.map((m) => evidenceFromMetric(m, factsForMetric(m)));
  // Any extra sensor-supplied facts ride on the first citation as additional
  // drill-down rows — they are context, not a new evidential claim.
  const extraFacts = finding.facts ?? [];
  if (extraFacts.length > 0 && evidence[0]) {
    evidence[0] = { ...evidence[0], facts: [...evidence[0].facts, ...extraFacts] };
  }

  return {
    observation: buildObservation({
      id: `${sensor.id}:${finding.id}`,
      kind: finding.kind,
      observation: finding.observation,
      evidence,
      businessImpact: finding.businessImpact,
      recommendation: finding.recommendation,
      owner: finding.owner,
      severity: finding.severity,
      timestamp,
      source: { sensorId: sensor.id, sensorLabel: sensor.label, domain: sensor.report.domain },
      affectedArea: finding.affectedArea ?? sensor.label,
      change: finding.change ?? null,
    }),
  };
}

// ---------------------------------------------------------------------------
// Coverage & health, both derived from counts.
// ---------------------------------------------------------------------------

function coverageForSensor(sensor: ExecutiveSensor): SensorCoverage {
  if (!sensor.instrumented) {
    return {
      sensorId: sensor.id,
      label: sensor.label,
      domain: null,
      instrumented: false,
      status: 'missing',
      scopeLabel: null,
      populationSize: null,
      metricsAvailable: 0,
      metricsWithheld: 0,
      available: [],
      withheld: [],
      uninstrumentedReason: sensor.uninstrumented.reason,
      unblockedBy: sensor.uninstrumented.unblockedBy,
    };
  }
  const { report } = sensor;
  // DERIVED, never authored: nothing examined → connected (wired, no data yet);
  // any available metric stale → stale; trustworthy metrics present → healthy;
  // data present but nothing cleared → connected.
  const anyStale = report.available.some((m) => m.freshness.stale);
  const status: SensorStatus =
    report.populationSize === 0
      ? 'connected'
      : anyStale
        ? 'stale'
        : report.available.length > 0
          ? 'healthy'
          : 'connected';
  return {
    sensorId: sensor.id,
    label: sensor.label,
    domain: report.domain,
    instrumented: true,
    status,
    scopeLabel: report.scopeLabel,
    populationSize: report.populationSize,
    metricsAvailable: report.available.length,
    metricsWithheld: report.withheld.length,
    available: report.available,
    withheld: report.withheld.map((m) => ({
      label: m.label,
      reason: m.withheldReason ?? 'Withheld by the Evidence Engine.',
    })),
    uninstrumentedReason: null,
    unblockedBy: null,
  };
}

function deriveSystemHealth(
  coverage: EvidenceCoverageSummary,
  risks: readonly ExecutiveObservation[],
): SystemHealth {
  const anyWithheld = coverage.sensors.some((s) => s.metricsWithheld > 0);

  if (coverage.instrumentedSensors === 0) {
    return {
      band: 'unknown',
      components: [{ name: 'Instrumented sensors', detail: '0 sensors are wired to the Evidence Engine.' }],
      caveat:
        'No sensor is instrumented, so system health cannot be measured. This is not a healthy score — it is the absence of one.',
    };
  }

  const severe = risks.filter((r) => r.severity === 'critical' || r.severity === 'high').length;
  const band: HealthBand = severe > 0 ? 'at_risk' : risks.length > 0 || anyWithheld ? 'watch' : 'healthy';

  const components = [
    {
      name: 'Instrumented sensors',
      detail: `${coverage.instrumentedSensors} of ${coverage.totalSensors} sensors wired.`,
    },
    { name: 'Severe risks', detail: `${severe} risk(s) at high or critical severity.` },
    { name: 'Open risks', detail: `${risks.length} risk observation(s) in total.` },
  ];

  const caveat =
    coverage.instrumentedSensors < coverage.totalSensors
      ? `${coverage.totalSensors - coverage.instrumentedSensors} sensor(s) are not yet instrumented, so this posture reflects only what is wired.`
      : anyWithheld
        ? 'Some metrics were withheld by the Evidence Engine; this posture reflects only what could be trusted.'
        : null;

  return { band, components, caveat };
}

// ---------------------------------------------------------------------------
// The entry point.
// ---------------------------------------------------------------------------

/**
 * Run the Executive Brain over a set of sensors.
 *
 * Pure and deterministic. Every observation on the returned report traces to at
 * least one metric that cleared the Evidence Engine; nothing is fabricated, and
 * an empty set of sensors (or sensors that saw nothing) yields empty observation
 * lists and an honest `unknown` posture rather than an invented summary.
 */
export function runExecutiveBrain(
  sensors: readonly ExecutiveSensor[],
  now: Date,
): ExecutiveBrainReport {
  const generatedAt = now.toISOString();

  const observations: ExecutiveObservation[] = [];
  const suppressed: SuppressedFinding[] = [];

  for (const sensor of sensors) {
    if (!sensor.instrumented) continue;
    for (const finding of sensor.findings) {
      const result = observeFinding(sensor, finding, generatedAt);
      if ('observation' in result) observations.push(result.observation);
      else suppressed.push(result.suppressed);
    }
  }

  // Cross-sensor correlations are built FROM the base observations, so they can
  // only connect signals the sensors already evidenced — never invent one. They
  // join the observation pool so they rank and surface like any other insight.
  const correlations = runCorrelations(observations, generatedAt).sort(rankObservations);
  const withCorrelations = [...observations, ...correlations];

  const risks = withCorrelations.filter((o) => o.kind === 'risk').sort(rankObservations);
  const opportunities = withCorrelations.filter((o) => o.kind === 'opportunity').sort(rankObservations);
  const whatChanged = withCorrelations.filter((o) => o.kind === 'change').sort(rankObservations);
  const recommendations = withCorrelations
    .filter((o) => o.recommendation !== null)
    .sort(rankObservations);

  // Summary is narrative-first: cross-sensor conclusions first (they explain the
  // most), then the neutral state-of-the-world facts, then the most pressing
  // risks and opportunities. A selection of real observations, never a generated
  // paragraph — an empty summary is the honest output of an empty window.
  const baseline = withCorrelations.filter((o) => o.kind === 'observation').sort(rankObservations);
  const summary = [...correlations, ...baseline, ...risks, ...opportunities];

  const sensorCoverages = sensors.map(coverageForSensor);
  const instrumentedSensors = sensorCoverages.filter((s) => s.instrumented).length;
  const allAvailable = sensorCoverages.flatMap((s) => s.available);
  const overallConfidence =
    allAvailable.length === 0
      ? null
      : allAvailable.reduce((sum, m) => sum + m.confidence, 0) / allAvailable.length;

  const statusCounts: Record<SensorStatus, number> = { healthy: 0, stale: 0, connected: 0, missing: 0 };
  for (const s of sensorCoverages) statusCounts[s.status] += 1;

  const evidenceCoverage: EvidenceCoverageSummary = {
    sensors: sensorCoverages,
    instrumentedSensors,
    totalSensors: sensors.length,
    statusCounts,
    overallConfidence,
  };

  return {
    generatedAt,
    summary,
    whatChanged,
    correlations,
    risks,
    opportunities,
    recommendations,
    // Correlations are cross-sensor risks; include them in the health read.
    systemHealth: deriveSystemHealth(evidenceCoverage, [...risks, ...correlations]),
    evidenceCoverage,
    suppressed,
    sensors: sensors.map((s) => ({ id: s.id, label: s.label, instrumented: s.instrumented })),
  };
}
