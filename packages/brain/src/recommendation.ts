// @emgloop/brain — Recommendation & Next Best Action.
//
// Sprint 12: promote Next Best Action into a platform service. Sprint 11 already
// ships a working rules-based NextBestActionService in @emgloop/database; this
// file defines the PLATFORM contract it (and future callers) conform to. Every
// recommendation is fully explainable: action, reason, supporting signals,
// confidence, priority, recommended human, recommended AI employee, suggested
// workflow, and suppressions. Rules-based only — no AI reasoning in Sprint 12.

import type { Confidence, Priority } from './types';

/** The catalog of recommendation actions the platform supports. */
export type NextBestActionKind =
  | 'assign_human'
  | 'assign_ai'
  | 'create_follow_up'
  | 'recommend_guide'
  | 'book_appointment'
  | 'escalate'
  | 'notify_dispatcher'
  | 'suppress_marketing'
  | 'recommend_product'
  | 'recommend_creator'
  | 'recommend_workflow'
  | 'recommend_channel'
  | 'operational_recommendation';

/** A single, fully-explained recommendation. */
export interface Recommendation {
  id?: string;
  organizationId: string;
  subjectId?: string; // customer/identity id
  action: NextBestActionKind;
  /** Human-readable justification. */
  reason: string;
  /** Signal keys that support this recommendation. */
  supportingSignals: string[];
  confidence: Confidence;
  priority: Priority;
  /** Suggested human assignee (user id), if applicable. */
  recommendedHuman?: string;
  /** Suggested AI Employee (id), if applicable. */
  recommendedAIEmployee?: string;
  /** Suggested workflow to run (id or name), if applicable. */
  suggestedWorkflow?: string;
  /** Actions explicitly suppressed by this recommendation (e.g. marketing). */
  suppressions: NextBestActionKind[];
}

/** Context passed to the recommendation engine for a single decision. */
export interface RecommendationContext {
  organizationId: string;
  subjectId?: string;
  /** Signal keys currently known about the subject. */
  signalKeys: string[];
  /** Canonical event type that triggered the decision. */
  eventType?: string;
  /** Channel of the triggering interaction. */
  channel?: string;
}

/** Result: an ordered list of recommendations (highest priority first). */
export interface RecommendationResult {
  recommendations: Recommendation[];
}

/** Platform contract for the Next Best Action engine. Deterministic in Sprint 12. */
export interface RecommendationEngine {
  recommend(context: RecommendationContext): Promise<RecommendationResult>;
}


// ---------------------------------------------------------------------------
// Phase 1 (Brain Boundary): the Canonical Recommendation Envelope.
//
// The interfaces above (Recommendation, RecommendationEngine) are the Sprint-12
// rules-based Next Best Action contract and remain unchanged for backward
// compatibility. The RecommendationEnvelope defined below is the PERMANENT
// canonical shape mandated by the EMG Loop Constitution (Article: "Every
// recommendation must be explainable"). Over Phase 1+ every recommendation
// produced anywhere in Loop — bid, lead-quality, buyer-performance, margin,
// vendor-scorecard, operational — inherits this envelope. It is additive: no
// existing field is removed or renamed.
// ---------------------------------------------------------------------------

import type { BrainObjectBase, Evidence } from './types';

/** A named alternative explanation the engine considered but did not choose.
 *  Loop never presents a single answer as the only possible truth. */
export interface AlternativeExplanation {
  /** Short label, e.g. "Vendor traffic degraded" vs "Buyer changed criteria". */
  hypothesis: string;
  /** Why this explanation is plausible. */
  rationale: string;
  /** Relative likelihood in [0,1] the engine assigns to this alternative. */
  likelihood: Confidence;
}

/** Attribution of a diagnosed root cause. Loop never guesses; 'unknown' is a
 *  first-class, honest answer. */
export type RootCause = 'vendor' | 'buyer' | 'emg' | 'unknown';

/** The Trust assessment attached to every recommendation. Distinct from the
 *  tenant-visibility Trust layer in trust.ts — this concerns how much we should
 *  BELIEVE a recommendation, not who may SEE it. */
export interface TrustAssessment {
  /** Overall confidence in the recommendation, [0,1]. */
  confidence: Confidence;
  /** Structured evidence that supports the recommendation. */
  evidence: Evidence[];
  /** Facts/signals we WISH we had; their absence caps confidence. Honesty
   *  about ignorance is required, never hidden. */
  missingEvidence: string[];
  /** Named data that, if collected, would most increase confidence. */
  wouldIncreaseConfidenceWith: string[];
}

/** Quantified expected effect of acting on the recommendation. */
export interface ExpectedOutcome {
  /** Human-readable statement of the expected result. */
  statement: string;
  /** Metric the outcome is measured against, e.g. 'margin_per_lead'. */
  metric?: string;
  /** Directional/absolute expected change, if estimable. */
  estimatedChange?: number;
  /** Unit of the estimate, e.g. 'usd', 'percent', 'count'. */
  unit?: string;
}

/** Risk of acting on the recommendation. */
export interface RecommendationRisk {
  /** Coarse risk band. */
  level: 'low' | 'medium' | 'high';
  /** What could go wrong if we act. */
  description: string;
  /** What could go wrong if we do NOT act (cost of inaction). */
  costOfInaction?: string;
}

/**
 * The canonical, fully-explainable recommendation. Every recommendation surface
 * in Loop inherits from this. It is a BrainObjectBase, so it is tenant-scoped,
 * auditable, versioned, and may decay via Lifespan. The Brain — never a Sensor
 * and never the data/service layer — is the sole author of these.
 */
export interface RecommendationEnvelope extends BrainObjectBase {
  /** What the platform recommends doing. */
  recommendation: string;
  /** The action kind, reusing the existing catalog for continuity. */
  action: NextBestActionKind;
  /** Why we recommend it (the diagnosis, in plain language). */
  reason: string;
  /** Diagnosed root cause; 'unknown' when evidence is insufficient. */
  rootCause: RootCause;
  /** Trust: confidence + evidence + what we are missing. */
  trust: TrustAssessment;
  /** Alternatives the engine weighed but did not select. */
  alternativesConsidered: AlternativeExplanation[];
  /** Open questions / unknowns that remain. Never silently omitted. */
  unknowns: string[];
  /** The concrete next action a human or AI employee can take. */
  suggestedAction: string;
  /** What we expect to happen if the action is taken. */
  expectedOutcome: ExpectedOutcome;
  /** Risk of acting (and of not acting). */
  risk: RecommendationRisk;
  /** Estimated business impact, in the org's terms. */
  businessImpact: string;
}
