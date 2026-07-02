// @emgloop/brain — Diagnostics → Recommendation adapter.
//
// Phase 1 (Brain Boundary). The Brain can now THINK (diagnostics.ts) and it can
// RECOMMEND (recommendation.ts / next-best-action.ts). This module is the
// type-safe bridge between them: it converts a DiagnosticAssessment into the
// inputs a Recommendation Engine consumes, so that future engines can reason
// FROM an explainable diagnosis instead of FROM raw facts.
//
//   Observations → DiagnosticAssessment → (this adapter) → Recommendation inputs
//
// This is additive and adapter-only. It is PURE (no I/O, no persistence), it
// introduces NO new decision logic, and it does NOT change the existing Next
// Best Action behavior — the current RecommendationContext-based engine keeps
// working exactly as before. The adapter only RESHAPES data the diagnosis
// already computed; it never invents recommendations. Deciding what to
// recommend remains the job of a RecommendationEngine, not of this bridge.

import type { Evidence } from './types';
import type { DiagnosticAssessment } from './diagnostics';
import type {
  RecommendationContext,
  TrustAssessment,
  RootCause,
} from './recommendation';

// ---------------------------------------------------------------------------
// 1) DiagnosticAssessment → RecommendationContext
//    Feeds the EXISTING, unchanged Next Best Action engine. Behavior-preserving:
//    the engine still receives the same shape it always has; we simply source
//    the fields from a diagnosis instead of assembling them ad hoc.
// ---------------------------------------------------------------------------

/** Optional trigger hints the caller may already know (event/channel), kept
 *  separate so the adapter stays a pure function of the assessment plus context
 *  the assessment itself does not carry. */
export interface RecommendationContextHints {
  /** Canonical event type that triggered the decision, if known. */
  eventType?: string;
  /** Channel of the triggering interaction, if known. */
  channel?: string;
  /** Subject id override; defaults to the assessment subject. */
  subjectId?: string;
}

/** Derive the signal keys the recommendation engine keys off, from the evidence
 *  the diagnosis already gathered. Deterministic and order-preserving; de-duped.
 *  A signal key is the evidence ref when present, otherwise its kind — mirroring
 *  how signals are keyed elsewhere in the Brain. */
export function signalKeysFromAssessment(assessment: DiagnosticAssessment): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  const push = (k: string | undefined): void => {
    if (!k) return;
    if (seen.has(k)) return;
    seen.add(k);
    keys.push(k);
  };
  const fromEvidence = (evidence: Evidence[] | undefined): void => {
    (evidence ?? []).forEach((e) => push(e.ref ?? e.kind));
  };
  assessment.findings.forEach((f) => fromEvidence(f.evidence));
  assessment.rootCauses.forEach((rc) => fromEvidence(rc.evidence));
  return keys;
}

/** Convert a DiagnosticAssessment into the RecommendationContext the current
 *  engine consumes. Pure; adds no decision logic. */
export function diagnosticAssessmentToRecommendationContext(
  assessment: DiagnosticAssessment,
  hints: RecommendationContextHints = {},
): RecommendationContext {
  return {
    organizationId: assessment.organizationId,
    subjectId: hints.subjectId ?? assessment.subject,
    signalKeys: signalKeysFromAssessment(assessment),
    eventType: hints.eventType,
    channel: hints.channel,
  };
}

// ---------------------------------------------------------------------------
// 2) DiagnosticAssessment → RecommendationEnvelope building blocks
//    For FUTURE envelope-based engines. These helpers project the diagnosis onto
//    the explainable fields a RecommendationEnvelope carries. They deliberately
//    stop short of authoring a full envelope: an envelope also needs the CHOSEN
//    action, expected outcome, risk, and business impact — decisions only a
//    RecommendationEngine may make. The adapter supplies the evidentiary spine;
//    the engine supplies the judgement.
// ---------------------------------------------------------------------------

/** Flatten every piece of evidence the assessment rested on, de-duped by ref. */
export function evidenceFromAssessment(assessment: DiagnosticAssessment): Evidence[] {
  const out: Evidence[] = [];
  const seen = new Set<string>();
  const consider = (evidence: Evidence[] | undefined): void => {
    (evidence ?? []).forEach((e) => {
      const key = e.ref ?? `${e.kind}:${e.description}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push(e);
    });
  };
  assessment.findings.forEach((f) => consider(f.evidence));
  assessment.rootCauses.forEach((rc) => consider(rc.evidence));
  return out;
}

/** Project the assessment's honesty about ignorance onto the envelope's
 *  string-based unknown fields. Never silently drops an unknown. */
export function unknownsFromAssessment(assessment: DiagnosticAssessment): string[] {
  return assessment.unknowns.map((u) => (u.detail ? `${u.subject}: ${u.detail}` : u.subject));
}

/** The data the Brain still wishes it had, as plain strings the envelope's
 *  Trust layer expects. */
export function missingEvidenceLabels(assessment: DiagnosticAssessment): string[] {
  return assessment.missingEvidence.map((m) => m.description || m.kind);
}

/** Build the TrustAssessment for an envelope directly from a diagnosis. The
 *  confidence is the assessment's own overall confidence — the adapter does not
 *  re-score anything. */
export function trustAssessmentFromAssessment(assessment: DiagnosticAssessment): TrustAssessment {
  return {
    confidence: assessment.confidence,
    evidence: evidenceFromAssessment(assessment),
    missingEvidence: missingEvidenceLabels(assessment),
    wouldIncreaseConfidenceWith: assessment.missingEvidence
      .filter((m) => (m.expectedInformationGain ?? 0) > 0)
      .map((m) => m.description || m.kind),
  };
}

/** The primary (most-likely-first) root cause category the diagnosis attributed,
 *  or 'unknown' when the diagnosis attributed none — 'unknown' is a first-class,
 *  honest answer, never a fallback we hide. */
export function primaryRootCause(assessment: DiagnosticAssessment): RootCause {
  return assessment.rootCauses[0]?.category ?? 'unknown';
}

/** The diagnosis-derived, evidence-backed fields a future RecommendationEngine
 *  needs to assemble a RecommendationEnvelope. This is the "spine": everything
 *  that comes from KNOWING, with nothing that comes from DECIDING. The engine
 *  fills in action / suggestedAction / expectedOutcome / risk / businessImpact. */
export interface RecommendationEnvelopeSpine {
  /** Plain-language reason, taken from the leading root cause hypothesis or, if
   *  none, the leading finding statement; empty string when the diagnosis said
   *  nothing (an honest, non-fabricated default). */
  reason: string;
  /** Diagnosed root cause category; 'unknown' when unattributed. */
  rootCause: RootCause;
  /** Trust: confidence + evidence + what is missing. */
  trust: TrustAssessment;
  /** Alternatives the diagnosis weighed, aggregated across root causes. */
  alternativesConsidered: DiagnosticAssessment['rootCauses'][number]['alternatives'];
  /** Open questions that remain, as strings. */
  unknowns: string[];
}

/** Assemble the evidentiary spine of a RecommendationEnvelope from a diagnosis.
 *  Pure; makes no recommendation and chooses no action. */
export function recommendationEnvelopeSpineFromAssessment(
  assessment: DiagnosticAssessment,
): RecommendationEnvelopeSpine {
  const leadCause = assessment.rootCauses[0];
  const leadFinding = assessment.findings[0];
  const reason = leadCause?.hypothesis ?? leadFinding?.statement ?? '';
  const alternatives = assessment.rootCauses.flatMap((rc) => rc.alternatives ?? []);
  return {
    reason,
    rootCause: primaryRootCause(assessment),
    trust: trustAssessmentFromAssessment(assessment),
    alternativesConsidered: alternatives.length > 0 ? alternatives : undefined,
    unknowns: unknownsFromAssessment(assessment),
  };
}
