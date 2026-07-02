// @emgloop/brain — the Diagnostic Engine (reasoning vocabulary).
//
// Phase 1 (Diagnostic Foundation). The Brain already knows how to RECOMMEND
// (recommendation.ts, next-best-action.ts). Before a recommendation can be
// trustworthy, the Brain must first know how to THINK — to move from raw,
// interpretation-free Facts to an explainable understanding of what is true,
// what it means, and why. This file establishes the PERMANENT diagnostic
// vocabulary and engine contract for that reasoning. It is additive and
// contracts-only: no AI, no provider logic, no DB coupling, no schema changes.
// Concrete diagnosers arrive in later phases.
//
// Constitutional pipeline (this file implements the Observe -> Diagnose span):
//
//   Observe -> Understand -> Diagnose -> Recommend -> Experiment -> Learn
//
// Facts (Observe) are captured by Sensors and re-exported from facts.ts. This
// engine consumes Observations derived from those Facts/Signals, produces
// Findings, attributes RootCauses with Evidence and Confidence, names what it
// does NOT know (Unknown / MissingEvidence), and emits a single explainable
// DiagnosticAssessment. The Recommendation Engine is intended to eventually
// consume DiagnosticAssessment objects instead of raw facts.
//
// Reuse over redeclaration: Evidence, Confidence, AlternativeExplanation and the
// narrow RootCause attribution union already exist in the Brain and are imported
// here rather than duplicated, so there is exactly one source of truth per idea.

import type { Confidence, Evidence, Priority, TenantScope, Metadata } from './types';
import type { AlternativeExplanation, RootCause } from './recommendation';

// ---------------------------------------------------------------------------
// Observe — what the Brain perceives, before interpretation.
// ---------------------------------------------------------------------------

/** The lifecycle qualifier every diagnostic object carries. 'unknown' is a
 *  first-class, honest state — the Brain never fabricates certainty. */
export type DiagnosticState = 'observed' | 'inferred' | 'confirmed' | 'unknown';

/** A single perceived data point the Brain will reason about. An Observation is
 *  one step above a raw Fact: it is scoped to a subject and carries the evidence
 *  trail back to the Fact(s)/Signal(s) that produced it, but it asserts no
 *  meaning yet. Meaning is added by a Finding. */
export interface Observation extends TenantScope {
  /** Stable id of this observation, if persisted. */
  id?: string;
  /** What is being observed, e.g. 'lead_response_time', 'call_conversion'. */
  subject: string;
  /** The observed value, kept opaque so any metric/dimension can be carried. */
  value: string | number | boolean | null;
  /** Optional unit for numeric values, e.g. 'seconds', 'usd', 'percent'. */
  unit?: string;
  /** When the observation was made. */
  observedAt?: Date;
  /** The evidence (Facts/Signals) this observation was derived from. */
  evidence: Evidence[];
  /** Perception state; defaults conceptually to 'observed'. */
  state?: DiagnosticState;
  metadata?: Metadata;
}

// ---------------------------------------------------------------------------
// Understand — the explicit representation of what is NOT known.
// ---------------------------------------------------------------------------

/** A first-class representation of ignorance. Loop treats "we don't know" as a
 *  real, reportable outcome rather than a silent gap. An Unknown names the thing
 *  that could not be determined and (optionally) why. */
export interface Unknown {
  /** What could not be determined, e.g. 'attribution_source'. */
  subject: string;
  /** Why it is unknown, e.g. 'no_signal', 'conflicting_evidence', 'stale_data'. */
  reason: 'no_signal' | 'insufficient_evidence' | 'conflicting_evidence' | 'stale_data' | 'not_yet_computed' | 'other';
  /** Optional human-readable elaboration. */
  detail?: string;
}

/** A named piece of evidence that, if collected, would most reduce an Unknown or
 *  raise confidence in a Finding. This is how the Brain asks better questions. */
export interface MissingEvidence {
  /** The kind of evidence needed, mirroring Evidence.kind, e.g. 'signal'. */
  kind: string;
  /** Human-readable description of what to collect and why it matters. */
  description: string;
  /** How much collecting it is expected to help, [0,1]. */
  expectedInformationGain?: Confidence;
}

// ---------------------------------------------------------------------------
// Diagnose — interpretation, attribution, and the assessment envelope.
// ---------------------------------------------------------------------------

/** An interpreted statement about the subject: what the Observations MEAN. A
 *  Finding is explainable by construction — it always carries the evidence it
 *  rests on and a confidence it does not overstate. */
export interface Finding {
  /** Stable id of this finding, if persisted. */
  id?: string;
  /** The subject this finding concerns, matching Observation.subject. */
  subject: string;
  /** The interpreted statement, e.g. 'response time regressed 3x week-over-week'. */
  statement: string;
  /** How severe/important this finding is, reusing the shared Priority band. */
  severity: Priority;
  /** Evidence backing the interpretation. */
  evidence: Evidence[];
  /** Confidence in the finding itself, [0,1]. */
  confidence: Confidence;
  /** Interpretation state; 'unknown' when the data is present but ambiguous. */
  state: DiagnosticState;
}

/** A structured, explainable attribution of WHY a Finding is happening. Distinct
 *  from the narrow RootCause union in recommendation.ts (which this references):
 *  DiagnosticRootCause is the rich object the engine builds, the union is the
 *  coarse category it resolves to. Loop always surfaces the alternatives it
 *  considered and the evidence it weighed, so no single cause is presented as
 *  the only possible truth. */
export interface DiagnosticRootCause {
  /** Coarse attribution category (vendor | buyer | emg | unknown). */
  category: RootCause;
  /** Human-readable hypothesis for the cause. */
  hypothesis: string;
  /** Why the engine believes this, with its supporting evidence. */
  rationale: string;
  evidence: Evidence[];
  /** Confidence the engine assigns to this attribution, [0,1]. */
  confidence: Confidence;
  /** Named alternatives the engine considered but did not select. */
  alternatives?: AlternativeExplanation[];
}

/** The single, explainable output of a diagnosis pass over one subject/scope.
 *  This is the object the Recommendation Engine is intended to consume instead
 *  of raw facts: it contains what was observed, what it means, why, how sure the
 *  Brain is, and — honestly — what it still does not know. */
export interface DiagnosticAssessment extends TenantScope {
  /** Stable id of this assessment, if persisted. */
  id?: string;
  /** The subject/scope this assessment covers. */
  subject: string;
  /** The observations this diagnosis reasoned over. */
  observations: Observation[];
  /** The interpreted findings. */
  findings: Finding[];
  /** The attributed root cause(s), most-likely first. */
  rootCauses: DiagnosticRootCause[];
  /** What the Brain could not determine — never omitted, never faked. */
  unknowns: Unknown[];
  /** Evidence the Brain still wants, to improve the next assessment. */
  missingEvidence: MissingEvidence[];
  /** Overall confidence in the assessment as a whole, [0,1]. */
  confidence: Confidence;
  /** Assessment state; 'unknown' is valid and expected early in a subject's life. */
  state: DiagnosticState;
  /** When the assessment was produced. */
  assessedAt?: Date;
  metadata?: Metadata;
}

// ---------------------------------------------------------------------------
// Engine contract — the interface future diagnosers implement.
// ---------------------------------------------------------------------------

/** The input to a diagnosis pass. Provider/DB-agnostic: callers assemble the
 *  observations (from Facts/Signals) and hand them to the engine. */
export interface DiagnosticContext extends TenantScope {
  /** The subject/scope to diagnose. */
  subject: string;
  /** Observations to reason over. May be empty — the engine must then return an
   *  honest 'unknown' assessment rather than inventing findings. */
  observations: Observation[];
  /** Optional as-of time for reproducible diagnosis. */
  asOf?: Date;
  metadata?: Metadata;
}

/** The permanent contract every diagnoser conforms to. Implementations are
 *  deterministic in this phase (rules-based); model-driven diagnosers can
 *  satisfy the same interface later without changing callers. A diagnoser MUST:
 *  - be pure with respect to its input (no I/O, no persistence);
 *  - never fabricate certainty — return Unknown/MissingEvidence honestly;
 *  - always attach Evidence to every Finding and RootCause it emits. */
export interface DiagnosticEngine {
  /** Stable identifier of the diagnoser, e.g. 'lead-response-diagnoser'. */
  readonly id: string;
  /** Produce a single explainable assessment for the given context. Pure. */
  diagnose(context: DiagnosticContext): DiagnosticAssessment;
}
