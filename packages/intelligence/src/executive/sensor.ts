// Executive Brain — the Sensor contract.
//
// A sensor is anything that feeds the Executive Brain: Marketplace today; CRM,
// Calendar, Email, Analytics, Website tomorrow. The Brain reasons over sensors
// uniformly and knows nothing about what any of them measures — that is the
// whole point of this file. Marketplace is one sensor, not a special case.
//
// A sensor is in exactly one of two states, and BOTH are first-class:
//
//   instrumented   — it has an Evidence Engine contributor, so it produced an
//                    EvidenceReport and a set of findings that reason over it.
//   uninstrumented — it does not yet, and it SAYS so, with why and what would
//                    change it. This is how the Executive Brain reports "CRM is
//                    not yet wired" instead of silently omitting it, and it is
//                    why a sensor can never contribute a confidence that no
//                    Evidence Engine computed.
//
// The strict boundary: an observation may only originate from an instrumented
// sensor's findings, and only when those findings cite metrics that CLEARED the
// Evidence Engine. A finding that cites a withheld or absent metric is dropped
// by the Brain, not trusted. See runExecutiveBrain.

import type { EvidenceReport } from '../evidence/types';
import type {
  ObservationChange,
  ObservationFact,
  ObservationRecommendation,
  ObservationSeverity,
} from './observation';

/**
 * One thing a sensor concluded, in provider-neutral terms. The sensor has
 * already done its domain reasoning; the Brain only classifies it, derives its
 * confidence from the cited evidence, and renders it.
 *
 * `citesMetricIds` is the load-bearing field: it names the Evidence Engine
 * metrics this finding stands on. The Brain requires every one of them to be
 * AVAILABLE in the sensor's report, or it suppresses the finding. That single
 * check is what makes "recommendations require evidence" and "confidence is
 * derived from the Evidence Engine" structural rather than hoped-for.
 */
export interface SensorFinding {
  id: string;
  /** 'observation' is a neutral state-of-the-world fact; 'change' states a
   * movement between two windows; the last two carry a direction. */
  kind: 'observation' | 'change' | 'risk' | 'opportunity';
  /** Plain-language statement — what happened / what is true. Never a raw table. */
  observation: string;
  /** Evidence Engine metric ids this finding reasons over. Must be non-empty and
   * every id must be available in the report, or the Brain drops the finding. */
  citesMetricIds: readonly string[];
  businessImpact: string | null;
  recommendation: ObservationRecommendation | null;
  owner: string | null;
  severity: ObservationSeverity;
  /** The business area this affects; defaults to the sensor's domain. */
  affectedArea?: string;
  /** Present only on 'change' findings: the movement between windows. */
  change?: ObservationChange | null;
  /** Extra counted facts to show on drill-down, beyond the metrics' own coverage. */
  facts?: readonly ObservationFact[];
}

/** An instrumented sensor: it produced evidence and reasoned over it. */
export interface InstrumentedSensor {
  id: string;
  label: string;
  instrumented: true;
  report: EvidenceReport;
  findings: readonly SensorFinding[];
}

/** A sensor with no Evidence Engine contributor yet. Surfaced, never omitted. */
export interface UninstrumentedSensor {
  id: string;
  label: string;
  instrumented: false;
  /** Why it is not wired, and what would wire it. Both stated plainly. */
  uninstrumented: { reason: string; unblockedBy: string | null };
}

export type ExecutiveSensor = InstrumentedSensor | UninstrumentedSensor;

/** Declare a sensor that is not yet instrumented. A convenience so callers state
 * the gap in one line rather than assembling the discriminated shape by hand. */
export function uninstrumentedSensor(
  id: string,
  label: string,
  reason: string,
  unblockedBy: string | null = null,
): UninstrumentedSensor {
  return { id, label, instrumented: false, uninstrumented: { reason, unblockedBy } };
}
