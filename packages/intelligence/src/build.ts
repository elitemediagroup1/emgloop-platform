// @emgloop/intelligence — pure builders for the Brain's canonical contracts.
//
// A module never invents a new "insight" or "recommendation" shape: it emits
// the Brain's own `RecommendationEnvelope` (the fully-explainable recommendation
// every surface in Loop reads) and `BrainActivity` (the immutable output record
// the Executive Briefing projects). These builders are the ONLY place the
// intelligence package constructs those objects, so the honesty invariants —
// evidence present, confidence carried, unknowns/missingEvidence never dropped —
// live in one auditable spot. All pure; identity/time are passed in.

import type {
  BrainActivity,
  BrainActivityType,
  Confidence,
  Evidence,
  NextBestActionKind,
  Priority,
  RecommendationEnvelope,
  RootCause,
  Visibility,
  AlternativeExplanation,
  ExpectedOutcome,
  RecommendationRisk,
} from '@emgloop/brain';

/** Everything needed to author one fully-explained recommendation. Mirrors
 * `RecommendationEnvelope` but flattens the Trust block into simple lists so
 * callers cannot forget the honesty fields. */
export interface EnvelopeSpec {
  organizationId: string;
  locationId?: string;
  visibility?: Visibility;
  recommendation: string;
  action: NextBestActionKind;
  reason: string;
  rootCause: RootCause;
  confidence: Confidence;
  evidence: Evidence[];
  missingEvidence: string[];
  wouldIncreaseConfidenceWith?: string[];
  alternativesConsidered?: AlternativeExplanation[];
  unknowns: string[];
  suggestedAction: string;
  expectedOutcome: ExpectedOutcome;
  risk: RecommendationRisk;
  businessImpact: string;
}

/** Build a canonical, tenant-scoped RecommendationEnvelope. Pure. */
export function buildEnvelope(spec: EnvelopeSpec): RecommendationEnvelope {
  return {
    organizationId: spec.organizationId,
    ...(spec.locationId ? { locationId: spec.locationId } : {}),
    visibility: spec.visibility ?? 'private',
    confidence: spec.confidence,
    recommendation: spec.recommendation,
    action: spec.action,
    reason: spec.reason,
    rootCause: spec.rootCause,
    trust: {
      confidence: spec.confidence,
      evidence: spec.evidence,
      missingEvidence: spec.missingEvidence,
      wouldIncreaseConfidenceWith: spec.wouldIncreaseConfidenceWith ?? [],
    },
    alternativesConsidered: spec.alternativesConsidered ?? [],
    unknowns: spec.unknowns,
    suggestedAction: spec.suggestedAction,
    expectedOutcome: spec.expectedOutcome,
    risk: spec.risk,
    businessImpact: spec.businessImpact,
  };
}

/** Inputs to project an envelope into an immutable BrainActivity. */
export interface ActivitySpec {
  envelope: RecommendationEnvelope;
  id: string;
  timestamp: Date;
  subject: string;
  severity: Priority;
  activityType: BrainActivityType;
}

/**
 * Project a RecommendationEnvelope into an immutable BrainActivity. This mirrors
 * `@emgloop/brain`'s own publisher (brain-activity.ts) but is driven directly
 * from an envelope a module authored, rather than from a DiagnosticAssessment —
 * every honesty field is copied through, nothing is fabricated, and the result
 * is frozen so the point-in-time record can never be edited in place.
 */
export function buildActivity(spec: ActivitySpec): BrainActivity {
  const { envelope } = spec;
  const activity: BrainActivity = {
    organizationId: envelope.organizationId,
    ...(envelope.locationId ? { locationId: envelope.locationId } : {}),
    id: spec.id,
    timestamp: spec.timestamp,
    subject: spec.subject,
    activityType: spec.activityType,
    severity: spec.severity,
    visibility: envelope.visibility,
    recommendation: envelope.recommendation,
    recommendationEnvelope: envelope,
    evidence: envelope.trust.evidence,
    confidence: envelope.trust.confidence,
    missingEvidence: envelope.trust.missingEvidence,
    alternativesConsidered: envelope.alternativesConsidered,
    unknowns: envelope.unknowns,
    assessmentRef: `${spec.id}:${spec.subject}`,
  };
  return Object.freeze(activity);
}

/** A convenience evidence row from a real value we observed. */
export function evidenceRow(description: string, ref?: string): Evidence {
  return { kind: 'metric', description, ...(ref ? { ref } : {}) };
}
