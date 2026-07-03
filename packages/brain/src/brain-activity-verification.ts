// @emgloop/brain — Brain Activity verification harness (pure, framework-free).
//
// Phase 1 (Brain Output verification). This module PROVES, deterministically and
// without any test framework, that the Observe -> Diagnose -> Recommend -> Publish
// pipeline composes correctly and that a published BrainActivity faithfully
// preserves the reasoning it was built from.
//
// The repo intentionally ships no test runner (only 'typecheck'/'build' via
// turbo), and the task forbids introducing one. So this harness is a set of PURE
// functions: it builds fixed inputs, runs the real Brain code over them, and
// checks invariants with a tiny internal assert helper, returning a structured
// VerificationReport. It performs NO I/O, NO persistence, NO DB writes, touches
// NO CallGrid path, uses NO LLM, and is NOT wired into any runtime. It compiles
// as part of the normal typecheck/build, which is what the green preview proves;
// a caller (or a future test runner) may additionally invoke
// runBrainActivityVerification() to execute the checks at runtime.

import type { TenantScope } from './types';
import type { DiagnosticAssessment } from './diagnostics';
import type { RecommendationEnvelope } from './recommendation';
import type { BrainActivity } from './brain-activity';
import {
  demonstrateBrainActivityFlow,
  publishBrainActivity,
} from './brain-activity';
import { recommendationEnvelopeSpineFromAssessment } from './diagnostics-recommendation';
import { buyerCallHandlingDiagnoser, buildCallHandlingObservations } from './buyer-call-handling-diagnoser';
import type { CallHandlingMetrics } from './buyer-call-handling-diagnoser';

// ---------------------------------------------------------------------------
// Tiny, framework-free assertion helper.
// ---------------------------------------------------------------------------

/** One recorded check. */
export interface CheckResult {
  name: string;
  passed: boolean;
  detail?: string;
}

/** The result of one named scenario (a group of checks). */
export interface ScenarioResult {
  scenario: string;
  checks: CheckResult[];
  passed: boolean;
}

/** The whole harness run. */
export interface VerificationReport {
  passed: boolean;
  total: number;
  failures: number;
  scenarios: ScenarioResult[];
}

/** A minimal check recorder — the entire "framework". Pure: it only accumulates
 * results into the array it is given. */
class Checker {
  readonly checks: CheckResult[] = [];
  ok(name: string, condition: boolean, detail?: string): void {
    this.checks.push({ name, passed: condition, detail: condition ? undefined : detail ?? 'expected true' });
  }
  eq<T>(name: string, actual: T, expected: T): void {
    const passed = actual === expected;
    this.ok(name, passed, passed ? undefined : 'expected ' + String(expected) + ', got ' + String(actual));
  }
}

// ---------------------------------------------------------------------------
// Deterministic fixtures.
// ---------------------------------------------------------------------------

const SCOPE: TenantScope = { organizationId: 'org_verify', locationId: 'loc_verify' };

/** Metrics that fire three BUYER-owned signals (low answer rate, buyer hangs up,
 * short handled calls) with a healthy sample, so the diagnoser must attribute a
 * 'buyer' root cause. Chosen so no EMG (no-route) or vendor (caller-ended)
 * signal fires. */
export const BUYER_ROOT_CAUSE_METRICS: CallHandlingMetrics = {
  sampleSize: 120,
  answerRate: 0.4,
  buyerEndedRate: 0.5,
  callerEndedRate: 0.1,
  noRouteRate: 0.05,
  shortCallRate: 0.6,
  avgDurationSeconds: 25,
};

/** Metrics with a sample below the minimum, so the diagnoser must return an
 * honest 'unknown' rather than guessing. */
export const INSUFFICIENT_EVIDENCE_METRICS: CallHandlingMetrics = {
  sampleSize: 5,
  answerRate: 0.4,
  buyerEndedRate: 0.5,
};

// ---------------------------------------------------------------------------
// Scenario 1 + 2: the diagnoser produces the right kind of assessment.
// ---------------------------------------------------------------------------

function verifyBuyerRootCauseAssessment(): ScenarioResult {
  const c = new Checker();
  const observations = buildCallHandlingObservations(SCOPE, BUYER_ROOT_CAUSE_METRICS, 'window_buyer');
  const assessment: DiagnosticAssessment = buyerCallHandlingDiagnoser.diagnose({
    organizationId: SCOPE.organizationId,
    locationId: SCOPE.locationId,
    subject: 'buyer_call_handling',
    observations,
  });
  const primary = assessment.rootCauses[0];
  c.ok('produced at least one root cause', assessment.rootCauses.length > 0);
  c.eq('primary root cause is buyer', primary?.category, 'buyer');
  c.eq('assessment state is inferred', assessment.state, 'inferred');
  c.ok('at least one finding fired', assessment.findings.length > 0);
  c.ok('confidence is in [0,1]', assessment.confidence >= 0 && assessment.confidence <= 1);
  c.ok('every finding carries evidence', assessment.findings.every((f) => f.evidence.length > 0));
  return finalize('buyer root cause diagnosis', c);
}

function verifyUnknownAssessment(): ScenarioResult {
  const c = new Checker();
  const observations = buildCallHandlingObservations(SCOPE, INSUFFICIENT_EVIDENCE_METRICS, 'window_unknown');
  const assessment: DiagnosticAssessment = buyerCallHandlingDiagnoser.diagnose({
    organizationId: SCOPE.organizationId,
    locationId: SCOPE.locationId,
    subject: 'buyer_call_handling',
    observations,
  });
  c.eq('assessment state is unknown', assessment.state, 'unknown');
  c.eq('no findings on insufficient evidence', assessment.findings.length, 0);
  c.eq('primary root cause is unknown', assessment.rootCauses[0]?.category, 'unknown');
  c.ok('names at least one unknown', assessment.unknowns.length > 0);
  c.ok('asks for at least one missing evidence', assessment.missingEvidence.length > 0);
  c.ok('confidence is modest (<= 0.5)', assessment.confidence <= 0.5);
  return finalize('honest unknown diagnosis', c);
}

// ---------------------------------------------------------------------------
// Scenario 3 + 4: the assessment flows to a BrainActivity that preserves fields.
// ---------------------------------------------------------------------------

function verifyFlowAndPreservation(): ScenarioResult {
  const c = new Checker();
  const timestamp = new Date('2025-01-01T00:00:00.000Z');
  const result = demonstrateBrainActivityFlow({
    scope: SCOPE,
    metrics: BUYER_ROOT_CAUSE_METRICS,
    subject: 'buyer_call_handling',
    activityId: 'act_verify_1',
    timestamp,
    windowRef: 'window_buyer',
  });
  const { assessment, envelope, activity } = result;

  // The adapter spine is derived from the same assessment the activity carries.
  const spine = recommendationEnvelopeSpineFromAssessment(assessment);

  // Flow reached a BrainActivity.
  c.ok('flow produced a BrainActivity', activity !== undefined && activity !== null);
  c.eq('activity id preserved', activity.id, 'act_verify_1');
  c.ok('timestamp preserved', activity.timestamp.getTime() === timestamp.getTime());
  c.eq('subject preserved', activity.subject, 'buyer_call_handling');

  // Field preservation: activity mirrors the envelope it was published from.
  c.eq('type is recommendation (envelope recommends)', activity.activityType, 'recommendation');
  c.ok('severity is a valid Priority', ['low', 'normal', 'high', 'critical'].includes(activity.severity));
  c.eq('severity reflects highest finding (high)', activity.severity, 'high');
  c.eq('confidence preserved from envelope trust', activity.confidence, envelope.trust.confidence);
  c.eq('evidence preserved from envelope trust', activity.evidence, envelope.trust.evidence);
  c.eq('missing evidence preserved', activity.missingEvidence, envelope.trust.missingEvidence);
  c.eq('alternatives preserved from envelope', activity.alternativesConsidered, envelope.alternativesConsidered);
  c.eq('unknowns preserved from envelope', activity.unknowns, envelope.unknowns);
  c.eq('recommendation text preserved', activity.recommendation, envelope.recommendation);
  c.ok('recommendation envelope preserved by reference', activity.recommendationEnvelope === envelope);
  c.eq('assessmentRef points at the source subject/id', activity.assessmentRef, assessment.id ?? assessment.subject);

  // The spine's root cause agrees with the envelope the activity carries.
  c.eq('spine root cause matches envelope root cause', spine.rootCause, envelope.rootCause);

  return finalize('flow + field preservation', c);
}

// ---------------------------------------------------------------------------
// Scenario 5: BrainActivity is immutable / frozen.
// ---------------------------------------------------------------------------

function verifyImmutability(): ScenarioResult {
  const c = new Checker();
  const timestamp = new Date('2025-01-01T00:00:00.000Z');
  const activity: BrainActivity = publishBrainActivity({
    assessment: buildAssessmentFor(BUYER_ROOT_CAUSE_METRICS),
    envelope: buildEnvelopeFor(BUYER_ROOT_CAUSE_METRICS),
    id: 'act_verify_frozen',
    timestamp,
  });

  c.ok('activity is frozen', Object.isFrozen(activity));

  // A mutation attempt must not change the object. In strict-mode ESM this
  // throws; we tolerate either a throw or a silent no-op and assert the value
  // is unchanged afterward.
  const before = activity.recommendation;
  let threw = false;
  try {
    // @ts-expect-error — intentionally testing that the readonly field cannot change.
    activity.recommendation = 'MUTATED';
  } catch {
    threw = true;
  }
  c.ok('mutation threw or was ignored', threw || activity.recommendation === before);
  c.eq('recommendation unchanged after mutation attempt', activity.recommendation, before);

  return finalize('immutability', c);
}

// ---------------------------------------------------------------------------
// Shared builders (pure).
// ---------------------------------------------------------------------------

function buildAssessmentFor(metrics: CallHandlingMetrics): DiagnosticAssessment {
  const observations = buildCallHandlingObservations(SCOPE, metrics, 'window_shared');
  return buyerCallHandlingDiagnoser.diagnose({
    organizationId: SCOPE.organizationId,
    locationId: SCOPE.locationId,
    subject: 'buyer_call_handling',
    observations,
  });
}

function buildEnvelopeFor(metrics: CallHandlingMetrics): RecommendationEnvelope {
  // Reuse the demonstration's fully-built envelope so this harness always tests
  // the SAME envelope shape the public flow produces.
  return demonstrateBrainActivityFlow({
    scope: SCOPE,
    metrics,
    subject: 'buyer_call_handling',
    activityId: 'act_env',
    timestamp: new Date('2025-01-01T00:00:00.000Z'),
    windowRef: 'window_shared',
  }).envelope;
}

function finalize(scenario: string, c: Checker): ScenarioResult {
  const passed = c.checks.every((x) => x.passed);
  return { scenario, checks: c.checks, passed };
}

// ---------------------------------------------------------------------------
// Public entry point.
// ---------------------------------------------------------------------------

/** Run every verification scenario and return a structured report. Pure and
 * deterministic: no I/O, no clock (fixtures pin the timestamp), no RNG. */
export function runBrainActivityVerification(): VerificationReport {
  const scenarios: ScenarioResult[] = [
    verifyBuyerRootCauseAssessment(),
    verifyUnknownAssessment(),
    verifyFlowAndPreservation(),
    verifyImmutability(),
  ];
  const all = scenarios.flatMap((s) => s.checks);
  const failures = all.filter((x) => !x.passed).length;
  return {
    passed: failures === 0,
    total: all.length,
    failures,
    scenarios,
  };
}
