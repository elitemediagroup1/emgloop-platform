// @emgloop/brain — Brain Activity (the canonical output layer of the Brain).
//
// Phase 1 (Brain Output). The Brain can now Observe (facts.ts, diagnostics.ts),
// Diagnose (diagnostics.ts + concrete diagnosers such as
// buyer-call-handling-diagnoser.ts), and it can shape a Recommendation
// (recommendation.ts + diagnostics-recommendation.ts). What it still lacks is a
// STANDARD way to PUBLISH its reasoning so the rest of the platform can consume
// it uniformly. This module introduces that standard: BrainActivity.
//
//   Observations
//        v
//   DiagnosticAssessment
//        v
//   RecommendationEnvelope
//        v
//   BrainActivity   <- this file (the Brain's single, canonical output)
//        v
//   (Consumers: workspaces, notifications, daily briefings, experiment/knowledge engines)
//
// A BrainActivity is an IMMUTABLE, point-in-time record of one thing the Brain
// noticed and reasoned about. It is the ONLY shape a consumer should need to
// display, route, or act on the Brain's output — every future diagnoser, on any
// subject, publishes the same shape. Consumers therefore never reach back into
// diagnostics or recommendation internals; they read BrainActivity.
//
// This file is additive, contracts + pure functions only: no AI, no I/O, no
// persistence, no DB coupling, no schema changes, and it is not wired into any
// runtime path. Producing a BrainActivity is a PURE projection of a diagnosis
// plus its recommendation envelope; it introduces NO new decision logic.

import type { Confidence, Metadata, Priority, TenantScope, Visibility } from './types';
import type { AlternativeExplanation, RecommendationContext, RecommendationEnvelope } from './recommendation';
import type { DiagnosticAssessment } from './diagnostics';
import { buyerCallHandlingDiagnoser, buildCallHandlingObservations } from './buyer-call-handling-diagnoser';
import type { CallHandlingMetrics } from './buyer-call-handling-diagnoser';
import {
  recommendationEnvelopeSpineFromAssessment,
  diagnosticAssessmentToRecommendationContext,
} from './diagnostics-recommendation';

// ---------------------------------------------------------------------------
// Model.
// ---------------------------------------------------------------------------

/** What kind of thing the Brain published. Additive union: new diagnosers add
 * their own activity types over time without changing this contract's shape. */
export type BrainActivityType =
  | 'diagnosis'
  | 'recommendation'
  | 'observation'
  | 'alert'
  | 'unknown';

/** Severity band for triage/routing, reusing the shared Priority vocabulary so
 * the whole platform ranks Brain output the same way it ranks everything else. */
export type BrainActivitySeverity = Priority;

/**
 * The canonical, IMMUTABLE output of the Brain. It represents a single
 * point-in-time business observation the Brain made and reasoned about, carrying
 * everything a consumer needs to understand and trust it WITHOUT re-deriving
 * anything: the recommendation and its full envelope, the evidence, the
 * confidence, what is still missing, the alternatives weighed, and a reference
 * back to the DiagnosticAssessment it came from.
 *
 * Immutability is enforced structurally: every field is 'readonly' and every
 * collection is a ReadonlyArray. A BrainActivity is a fact about a moment; it is
 * never edited in place. A later reading of the same subject produces a NEW
 * BrainActivity, it does not mutate this one.
 */
export interface BrainActivity extends TenantScope {
  /** Stable, unique identifier for this activity. */
  readonly id: string;
  /** When the Brain produced this activity (point-in-time). */
  readonly timestamp: Date;
  /** The subject/scope this activity concerns (matches the assessment subject). */
  readonly subject: string;
  /** What kind of activity this is. */
  readonly activityType: BrainActivityType;
  /** Triage severity for consumers (notifications, workspaces, briefings). */
  readonly severity: BrainActivitySeverity;
  /** Visibility for the Trust layer; inherited from the recommendation envelope. */
  readonly visibility: Visibility;
  /** Plain-language recommendation text. Empty string when the Brain reached an
   * honest 'unknown' and recommended nothing — never fabricated. */
  readonly recommendation: string;
  /** The full, explainable recommendation envelope this activity carries. */
  readonly recommendationEnvelope: RecommendationEnvelope;
  /** The evidence the Brain rested on, flattened from the diagnosis. */
  readonly evidence: RecommendationEnvelope['trust']['evidence'];
  /** Overall confidence in this activity, [0,1]. */
  readonly confidence: Confidence;
  /** What the Brain still wishes it had. Never silently omitted. */
  readonly missingEvidence: ReadonlyArray<string>;
  /** Alternatives the Brain considered but did not select. */
  readonly alternativesConsidered: ReadonlyArray<AlternativeExplanation>;
  /** Open questions that remain. */
  readonly unknowns: ReadonlyArray<string>;
  /** Reference back to the DiagnosticAssessment this activity was published from,
   * so a consumer can trace provenance without the Brain leaking internals. */
  readonly assessmentRef: string;
  /** Optional carry-through metadata. */
  readonly metadata?: Metadata;
}

// ---------------------------------------------------------------------------
// Publisher (pure).
// ---------------------------------------------------------------------------

/** The inputs a publisher projects into a BrainActivity: the diagnosis (what the
 * Brain knows) and the recommendation envelope (what it would do about it). */
export interface PublishBrainActivityInput {
  /** The explainable diagnosis. */
  assessment: DiagnosticAssessment;
  /** The recommendation envelope built from that diagnosis. */
  envelope: RecommendationEnvelope;
  /** Deterministic identity/time inputs the caller supplies so the projection
   * stays a PURE function (no clock, no RNG inside the publisher). */
  id: string;
  timestamp: Date;
  /** Optional override of the activity type; inferred from the envelope/diagnosis
   * when omitted. */
  activityType?: BrainActivityType;
  /** Optional reference id for the source assessment; defaults to assessment.id. */
  assessmentRef?: string;
}

/** The permanent contract every Brain-output publisher conforms to. Pure by
 * construction: given the same input it returns the same BrainActivity. */
export interface BrainActivityPublisher {
  /** Stable identifier of the publisher. */
  readonly id: string;
  /** Project a diagnosis + envelope into an immutable BrainActivity. Pure. */
  publish(input: PublishBrainActivityInput): BrainActivity;
}

/** Map an envelope + diagnosis to a coarse activity type, deterministically.
 * An honest 'unknown' state with no findings surfaces as 'unknown'; an envelope
 * that recommends an action surfaces as 'recommendation'; otherwise a diagnosis
 * with findings surfaces as 'diagnosis'. */
function inferActivityType(
  assessment: DiagnosticAssessment,
  envelope: RecommendationEnvelope,
): BrainActivityType {
  if (assessment.state === 'unknown' && assessment.findings.length === 0) return 'unknown';
  if (envelope.recommendation.length > 0) return 'recommendation';
  if (assessment.findings.length > 0) return 'diagnosis';
  return 'observation';
}

/** Derive a triage severity from the diagnosis findings, deterministically. The
 * highest finding severity wins; with no findings the activity is 'low'. The
 * publisher does not invent severity — it reflects what the diagnosis stated. */
function inferSeverity(assessment: DiagnosticAssessment): BrainActivitySeverity {
  const rank: Record<Priority, number> = { low: 0, normal: 1, high: 2, critical: 3 };
  let best: Priority = 'low';
  assessment.findings.forEach((f) => {
    if (rank[f.severity] > rank[best]) best = f.severity;
  });
  return best;
}

/**
 * Create a Brain Activity publisher. The returned publisher is a pure projection
 * from (DiagnosticAssessment, RecommendationEnvelope) to an immutable
 * BrainActivity. It performs NO persistence, NO I/O, and makes NO new decision:
 * every field is copied or shallow-projected from data the diagnosis and the
 * envelope already computed. Wiring the result to a store, a feed, or a UI is a
 * separate, later decision made outside the Brain.
 */
export function createBrainActivityPublisher(
  publisherId = 'brain-activity-publisher',
): BrainActivityPublisher {
  return {
    id: publisherId,
    publish(input: PublishBrainActivityInput): BrainActivity {
      const { assessment, envelope } = input;
      const activity: BrainActivity = {
        organizationId: assessment.organizationId,
        locationId: assessment.locationId,
        id: input.id,
        timestamp: input.timestamp,
        subject: assessment.subject,
        activityType: input.activityType ?? inferActivityType(assessment, envelope),
        severity: inferSeverity(assessment),
        visibility: envelope.visibility,
        recommendation: envelope.recommendation,
        recommendationEnvelope: envelope,
        evidence: envelope.trust.evidence,
        confidence: envelope.trust.confidence,
        missingEvidence: envelope.trust.missingEvidence,
        alternativesConsidered: envelope.alternativesConsidered,
        unknowns: envelope.unknowns,
        assessmentRef: input.assessmentRef ?? assessment.id ?? assessment.subject,
        metadata: assessment.metadata,
      };
      // Freeze so the immutability contract is observable at runtime too. The
      // returned object is a point-in-time fact and must never be edited.
      return Object.freeze(activity);
    },
  };
}

/** A ready-to-use publisher with the default id. */
export const brainActivityPublisher: BrainActivityPublisher = createBrainActivityPublisher();

/** Convenience one-shot: publish a single BrainActivity with the default
 * publisher. Pure; identity/time are caller-supplied. */
export function publishBrainActivity(input: PublishBrainActivityInput): BrainActivity {
  return brainActivityPublisher.publish(input);
}

// ---------------------------------------------------------------------------
// Demonstration (pure, deterministic).
//
// Shows the full Observe -> Diagnose -> Recommend -> Publish flow end-to-end
// using the Buyer/Call-Handling diagnoser from PR #33. This is a PURE example:
// it touches no DB, no CallGrid, no clock and no RNG (identity/time are passed
// in), so given the same metrics it always yields the same BrainActivity. It
// exists to prove the pipeline composes; it is not wired into any runtime path.
// ---------------------------------------------------------------------------

/** The deterministic identity/time a caller supplies for a reproducible demo. */
export interface BrainActivityDemoInputs {
  scope: TenantScope;
  metrics: CallHandlingMetrics;
  subject: string;
  activityId: string;
  timestamp: Date;
  windowRef?: string;
}

/** Everything the demo produced, so a test can assert on each stage. */
export interface BrainActivityDemoResult {
  assessment: DiagnosticAssessment;
  recommendationContext: RecommendationContext;
  envelope: RecommendationEnvelope;
  activity: BrainActivity;
}

/**
 * Assemble observations from plain CallGrid-derived metrics, diagnose them,
 * build a full RecommendationEnvelope from the diagnosis (using the PR #32
 * adapter for the evidentiary spine and supplying the DECISION fields here, as
 * only a recommendation author may), then publish an immutable BrainActivity.
 * Pure and deterministic.
 */
export function demonstrateBrainActivityFlow(
  inputs: BrainActivityDemoInputs,
): BrainActivityDemoResult {
  // Observe.
  const observations = buildCallHandlingObservations(inputs.scope, inputs.metrics, inputs.windowRef);

  // Diagnose (deterministic, PR #33).
  const assessment = buyerCallHandlingDiagnoser.diagnose({
    organizationId: inputs.scope.organizationId,
    locationId: inputs.scope.locationId,
    subject: inputs.subject,
    observations,
  });

  // Recommend. The adapter (PR #32) supplies the evidentiary SPINE from the
  // diagnosis; the DECISION fields (action, suggestedAction, outcome, risk,
  // impact) are authored here — the adapter never invents recommendations.
  const spine = recommendationEnvelopeSpineFromAssessment(assessment);
  const recommendationContext = diagnosticAssessmentToRecommendationContext(assessment);
  const isUnknown = spine.rootCause === 'unknown';
  const envelope: RecommendationEnvelope = {
    organizationId: assessment.organizationId,
    locationId: assessment.locationId,
    visibility: 'private',
    recommendation: isUnknown
      ? 'Collect more call data before attributing a cause.'
      : 'Review buyer call handling for the affected window.',
    action: isUnknown ? 'operational_recommendation' : 'escalate',
    reason: spine.reason,
    rootCause: spine.rootCause,
    trust: spine.trust,
    alternativesConsidered: spine.alternativesConsidered ?? [],
    unknowns: spine.unknowns,
    suggestedAction: isUnknown
      ? 'Extend the analysis window until the minimum sample size is met.'
      : 'Escalate to the buyer performance owner with the evidence attached.',
    expectedOutcome: {
      statement: isUnknown
        ? 'A larger sample enables a confident attribution next pass.'
        : 'Addressing call handling improves qualification/billable rate.',
      metric: 'billable_rate',
    },
    risk: {
      level: isUnknown ? 'low' : 'medium',
      description: isUnknown
        ? 'Acting on an unknown cause could misattribute; we wait instead.'
        : 'Escalating on partial evidence may create noise if unwarranted.',
      costOfInaction: 'Continued non-billable calls erode margin.',
    },
    businessImpact: 'Protects billable-call margin on this traffic.',
  };

  // Publish (this file). Immutable, point-in-time.
  const activity = publishBrainActivity({
    assessment,
    envelope,
    id: inputs.activityId,
    timestamp: inputs.timestamp,
  });

  return { assessment, recommendationContext, envelope, activity };
}
