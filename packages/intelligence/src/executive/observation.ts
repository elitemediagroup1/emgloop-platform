// Executive Brain — the canonical Observation model.
//
// This is the ONE shape the Executive Brain reasons in. It supersedes the two
// older executive units — the CallGrid module's `RecommendationEnvelope`
// opportunities/risks and its `IntelligenceChange` "what changed" list — which
// each described a different slice of the same thing and carried a confidence
// the module asserted about itself. An Observation unifies them: one narrative
// unit, with the evidence behind it, the impact it implies, an optional action,
// and a confidence that is DERIVED from the Evidence Engine rather than authored.
//
// WHY THIS EXISTS, STATED AS INVARIANTS (the type is the enforcement):
//
//   - An Observation cannot exist without evidence. `evidence` is non-empty by
//     construction — `buildObservation` refuses to assemble one otherwise. "No
//     evidence, no observation" is the strict rule of this layer, and it is why
//     the Executive Brain can never fabricate an insight.
//   - Confidence is DERIVED, never asserted. It is the weakest-link of the
//     Evidence Engine confidences of the metrics an observation cites — see
//     `deriveObservationConfidence`. A caller cannot pass a confidence in.
//   - Unknown stays unknown. An observation is only ever built over metrics that
//     CLEARED the Evidence Engine's withholding rules; a withheld or absent
//     metric never reaches here, so a zero is never dressed as a reading.
//
// PROVIDER-NEUTRAL BY CONSTRUCTION. Nothing here mentions marketplace, calls,
// buyers or CallGrid. A sensor supplies findings; this shape is the same whether
// the sensor is Marketplace, CRM, Calendar, Email, Analytics or Website.

import type { EvidenceCoverage, MetricEvidence, Provenance } from '../evidence/types';

/** What class of thing an observation is. `observation` is a neutral state-of-
 * the-world fact (summary material); `change` states a movement between two
 * windows (What Changed); `correlation` is a cross-sensor conclusion built from
 * other observations; the last two carry a direction. */
export type ObservationKind =
  | 'observation'
  | 'change'
  | 'correlation'
  | 'risk'
  | 'opportunity';

/**
 * A movement between the prior and current window. Present ONLY on `change`
 * observations. `changePercent` is null — never 0-filled — when the prior value
 * was 0, because a percentage change from nothing is undefined, not infinite.
 */
export interface ObservationChange {
  metricId: string;
  current: number;
  prior: number | null;
  direction: 'up' | 'down' | 'flat';
  changePercent: number | null;
}

/**
 * How much an observation matters. Derived by the sensor from business impact,
 * NOT from how loud its wording is. `informational` is a real, common answer:
 * a true statement an executive cannot size.
 */
export type ObservationSeverity = 'critical' | 'high' | 'notable' | 'informational';

/** Which sensor an observation came from. The domain keeps it auditable across
 * a multi-sensor briefing without the Brain knowing what the sensor measures. */
export interface ObservationSource {
  sensorId: string;
  sensorLabel: string;
  /** 'marketplace' | 'crm' | 'calendar' | 'email' | 'analytics' | 'website' | … */
  domain: string;
}

/**
 * One raw, counted fact behind an observation. This is what the executive view
 * hides until evidence is expanded — the NO-RAW-REPORTS rule. A bid %, a won %,
 * a row count lives HERE, never in `ExecutiveObservation.observation`.
 */
export interface ObservationFact {
  /** What was measured, in business language. */
  statement: string;
  observed: number;
  /** What it was measured against, or null when there is no meaningful one. */
  denominator: number | null;
  /** Where the figure came from, so a reader can verify it. */
  source: string;
}

/**
 * One evidential citation. It references an Evidence Engine metric that cleared
 * Layer 1 — carrying that metric's DERIVED confidence, coverage and provenance —
 * and the plain facts a reader sees only on drill-down.
 */
export interface ObservationEvidence {
  metricId: string;
  label: string;
  domain: string;
  /** The Evidence Engine's derived confidence for THIS metric. Never authored. */
  confidence: number;
  coverage: EvidenceCoverage | null;
  provenance: readonly Provenance[];
  /** Counted facts, shown only when the reader expands the evidence. */
  facts: readonly ObservationFact[];
}

/** The concrete "do this" attached to an observation. Optional — many true
 * observations warrant no action, and inventing one would be dishonest. */
export interface ObservationRecommendation {
  /** What to do, addressed to the owner. */
  action: string;
  /** What acting is expected to achieve, stated honestly (may be directional). */
  expectedImpact: string;
  owner: string | null;
}

/**
 * The canonical executive observation. Every field the mission requires is
 * present: Observation, Evidence, Business Impact, Recommendation (optional),
 * Confidence, Owner (optional), Severity, Timestamp, Source.
 */
export interface ExecutiveObservation {
  id: string;
  kind: ObservationKind;
  /** 1. Observation — what happened / what is true, in plain language. */
  observation: string;
  /** 2. Evidence — non-empty by construction. */
  evidence: readonly ObservationEvidence[];
  /** 3. Business Impact — why it matters, or null when it genuinely cannot be stated. */
  businessImpact: string | null;
  /** 4. Recommendation — optional. */
  recommendation: ObservationRecommendation | null;
  /** 5. Confidence — DERIVED from the cited evidence, in [0,1]. */
  confidence: number;
  /** 6. Owner — optional. */
  owner: string | null;
  /** 7. Severity. */
  severity: ObservationSeverity;
  /** 8. Timestamp — ISO, injected (this layer has no clock). */
  timestamp: string;
  /** 9. Source. */
  source: ObservationSource;
  /** The business area this affects, for the executive Details panel. Falls back
   * to the source domain when a sensor names nothing more specific. */
  affectedArea: string;
  /** Present only on `change` observations: the movement between windows. */
  change: ObservationChange | null;
}

/**
 * Derive an observation's confidence from its evidence.
 *
 * Weakest-link: a conclusion is only as trustworthy as the least trustworthy
 * metric it stands on. Taking the minimum (rather than an average) refuses to
 * let a single well-covered metric paper over a shaky one it was reasoned
 * alongside.
 *
 * Throws on empty evidence — that is a construction bug the Brain prevents by
 * suppressing evidence-less findings BEFORE they reach here. Surfacing it loudly
 * in a pure function is the point: the invariant is not "please remember", it is
 * "this cannot be built wrong".
 */
export function deriveObservationConfidence(
  evidence: readonly Pick<ObservationEvidence, 'confidence'>[],
): number {
  if (evidence.length === 0) {
    throw new Error('deriveObservationConfidence: an observation requires at least one evidence citation.');
  }
  return evidence.reduce((min, e) => Math.min(min, e.confidence), Number.POSITIVE_INFINITY);
}

/** Project an Evidence Engine metric into an observation citation. Pure. */
export function evidenceFromMetric(
  metric: MetricEvidence,
  facts: readonly ObservationFact[],
): ObservationEvidence {
  return {
    metricId: metric.metricId,
    label: metric.label,
    domain: metric.domain,
    confidence: metric.confidence,
    coverage: metric.coverage,
    provenance: metric.provenance,
    facts,
  };
}

/** Everything needed to author one observation, minus the derived confidence. */
export interface ObservationSpec {
  id: string;
  kind: ObservationKind;
  observation: string;
  evidence: readonly ObservationEvidence[];
  businessImpact: string | null;
  recommendation: ObservationRecommendation | null;
  owner: string | null;
  severity: ObservationSeverity;
  timestamp: string;
  source: ObservationSource;
  /** Optional; defaults to the source domain when omitted. */
  affectedArea?: string;
  change?: ObservationChange | null;
}

/**
 * The ONLY constructor for an ExecutiveObservation. Confidence is derived here,
 * not passed in, so no caller can assert one. Evidence must be non-empty; the
 * derivation enforces it. Frozen, because a point-in-time executive statement
 * must never be edited in place.
 */
export function buildObservation(spec: ObservationSpec): ExecutiveObservation {
  const confidence = deriveObservationConfidence(spec.evidence);
  return Object.freeze({
    id: spec.id,
    kind: spec.kind,
    observation: spec.observation,
    evidence: spec.evidence,
    businessImpact: spec.businessImpact,
    recommendation: spec.recommendation,
    confidence,
    owner: spec.owner,
    severity: spec.severity,
    timestamp: spec.timestamp,
    source: spec.source,
    affectedArea: spec.affectedArea ?? spec.source.domain,
    change: spec.change ?? null,
  });
}

/** Signed percentage change from prior→current, or null when prior is 0 (a
 * change from nothing has no defined percentage, and we refuse to invent one). */
export function changePercentOf(current: number, prior: number | null): number | null {
  if (prior === null || prior === 0) return null;
  return ((current - prior) / Math.abs(prior)) * 100;
}

/** Direction of a movement, with a dead-band so trivial noise reads 'flat'. */
export function directionOf(
  current: number,
  prior: number | null,
  deadBand = 0,
): 'up' | 'down' | 'flat' {
  if (prior === null) return 'flat';
  const d = current - prior;
  if (Math.abs(d) <= deadBand) return 'flat';
  return d > 0 ? 'up' : 'down';
}
