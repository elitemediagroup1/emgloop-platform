// @emgloop/brain — Call-Handling Metrics Assembler verification harness (pure).
//
// Phase 1 (Assembler verification). PR #35 introduced a framework-free
// verification harness for the Brain Activity flow; PR #36 introduced the
// Call-Handling Metrics Assembler that turns reconciled CallGrid records into a
// CallHandlingMetrics object. This module extends the same PROOF pattern to the
// assembler: it builds fixed reconciled-call records, runs the REAL assembler
// and the REAL Observe -> Diagnose -> Recommend -> Publish flow over them, and
// checks invariants with a tiny internal assert helper, returning a structured
// report.
//
// Consistent with PR #35 and the repo's tooling (only 'typecheck'/'build' via
// turbo, no test runner — and none may be added), this is a set of PURE
// functions. It performs NO I/O, NO persistence, NO DB writes, touches NO
// CallGrid path, uses NO LLM, and is NOT wired into any runtime. It compiles as
// part of the normal typecheck/build (which the green preview proves); a caller
// or a future test runner may additionally invoke
// runCallHandlingAssemblerVerification() to execute the checks at runtime.

import type { CallHandlingMetrics } from './buyer-call-handling-diagnoser';
import {
  assembleCallHandlingMetrics,
  assembleAndRunCallHandlingFlow,
} from './call-handling-metrics-assembler';
import type {
  ReconciledCallRecord,
  CallWindow,
} from './call-handling-metrics-assembler';

// ---------------------------------------------------------------------------
// Tiny, framework-free assertion helper (mirrors PR #35's self-contained style).
// ---------------------------------------------------------------------------

/** One recorded check. */
export interface AssemblerCheckResult {
  name: string;
  passed: boolean;
  detail?: string;
}

/** The result of one named scenario (a group of checks). */
export interface AssemblerScenarioResult {
  scenario: string;
  checks: AssemblerCheckResult[];
  passed: boolean;
}

/** The whole harness run. */
export interface AssemblerVerificationReport {
  passed: boolean;
  total: number;
  failures: number;
  scenarios: AssemblerScenarioResult[];
}

/** A minimal check recorder — the entire "framework". Pure: it only accumulates
 * results into its own array. */
class Checker {
  readonly checks: AssemblerCheckResult[] = [];
  ok(name: string, condition: boolean, detail?: string): void {
    this.checks.push({ name, passed: condition, detail: condition ? undefined : detail ?? 'expected true' });
  }
  eq<T>(name: string, actual: T, expected: T): void {
    const passed = actual === expected;
    this.ok(name, passed, passed ? undefined : 'expected ' + String(expected) + ', got ' + String(actual));
  }
  /** Assert a value is strictly undefined (used to prove "missing stays missing"). */
  undef(name: string, actual: unknown): void {
    this.ok(name, actual === undefined, 'expected undefined, got ' + String(actual));
  }
  /** Assert two finite numbers are equal within a small epsilon (ratios). */
  close(name: string, actual: number | undefined, expected: number): void {
    const passed = actual !== undefined && Math.abs(actual - expected) < 1e-9;
    this.ok(name, passed, 'expected ~' + expected + ', got ' + String(actual));
  }
}

function finalize(scenario: string, c: Checker): AssemblerScenarioResult {
  const passed = c.checks.every((x) => x.passed);
  return { scenario, checks: c.checks, passed };
}

// ---------------------------------------------------------------------------
// Deterministic fixtures — fixed reconciled-call records.
//
// Records are appended in fixed multiples so every count/ratio is exact and
// reproducible. No clock, no RNG.
// ---------------------------------------------------------------------------

/** Append 'n' copies of a record template with a stable synthetic id. */
function repeat(out: ReconciledCallRecord[], n: number, rec: ReconciledCallRecord): void {
  for (let i = 0; i < n; i += 1) out.push({ ...rec, id: rec.status + '-' + out.length });
}

const ATTR = { vendorId: 'vendor-A', buyerId: 'buyer-1', source: 'ppc', campaign: 'spring' };

/** A 60-call window exhibiting a BUYER-owned problem: low answer rate, buyer
 * hangs up often, short handled calls. Deterministically yields three buyer
 * signals and zero vendor/EMG signals. */
export const BUYER_ROOT_CAUSE_RECORDS: ReconciledCallRecord[] = (() => {
  const out: ReconciledCallRecord[] = [];
  repeat(out, 24, { status: 'answer', durationSeconds: 12, endedBy: 'buyer', billable: false, qualified: false, ...ATTR });
  repeat(out, 6, { status: 'complete', durationSeconds: 180, endedBy: 'caller', billable: true, qualified: true, ...ATTR });
  repeat(out, 24, { status: 'miss', endedBy: 'unknown', billable: false, qualified: false, ...ATTR });
  repeat(out, 6, { status: 'no_route', billable: false, qualified: false, ...ATTR });
  return out;
})();

/** A tiny 6-call window (below the diagnoser's minimum sample of 20), so the
 * diagnoser must honestly return 'unknown'. */
export const INSUFFICIENT_EVIDENCE_RECORDS: ReconciledCallRecord[] = (() => {
  const out: ReconciledCallRecord[] = [];
  repeat(out, 3, { status: 'answer', durationSeconds: 10, endedBy: 'buyer', ...ATTR });
  repeat(out, 3, { status: 'miss', endedBy: 'unknown', ...ATTR });
  return out;
})();

/** A 20-call window whose ANSWERED records carry NO duration, NO endedBy, and NO
 * billable/qualified flags, so the metrics that depend on those must be absent
 * (undefined) rather than fabricated as zero. */
export const MISSING_FIELDS_RECORDS: ReconciledCallRecord[] = (() => {
  const out: ReconciledCallRecord[] = [];
  repeat(out, 10, { status: 'answer' });
  repeat(out, 10, { status: 'miss' });
  return out;
})();

/** A window where every attributed record agrees, so the single attribution
 * value must be preserved. */
export const SINGLE_ATTRIBUTION_RECORDS: ReconciledCallRecord[] = (() => {
  const out: ReconciledCallRecord[] = [];
  repeat(out, 20, {
    status: 'answer',
    durationSeconds: 12,
    endedBy: 'buyer',
    vendorId: 'vendor-solo',
    buyerId: 'buyer-solo',
    source: 'ppc-solo',
    campaign: 'campaign-solo',
  });
  return out;
})();

/** A window with two distinct vendors/buyers, so attribution must be honestly
 * reported as mixed rather than collapsed to a guess. */
export const MIXED_ATTRIBUTION_RECORDS: ReconciledCallRecord[] = (() => {
  const out: ReconciledCallRecord[] = [];
  repeat(out, 15, { status: 'answer', durationSeconds: 12, endedBy: 'buyer', vendorId: 'vendor-A', buyerId: 'buyer-1' });
  repeat(out, 15, { status: 'answer', durationSeconds: 12, endedBy: 'buyer', vendorId: 'vendor-B', buyerId: 'buyer-2' });
  return out;
})();

const SCOPE = { organizationId: 'org_assembler_verify', locationId: 'loc_assembler_verify' };

function windowOf(records: ReconciledCallRecord[], windowRef: string): CallWindow {
  return { organizationId: SCOPE.organizationId, locationId: SCOPE.locationId, records, windowRef };
}

// ---------------------------------------------------------------------------
// Scenario 1: assembleCallHandlingMetrics produces the expected metrics.
// ---------------------------------------------------------------------------

function verifyExpectedMetrics(): AssemblerScenarioResult {
  const c = new Checker();
  const result = assembleCallHandlingMetrics(windowOf(BUYER_ROOT_CAUSE_RECORDS, 'w_expected'));
  const m: CallHandlingMetrics = result.metrics;

  c.eq('sampleSize equals record count', m.sampleSize, 60);
  c.eq('answered count', result.counts.answered, 30);
  c.eq('missed count', result.counts.missed, 24);
  c.eq('noRoute count', result.counts.noRoute, 6);
  // answerRate = answered / routable = 30 / (60 - 6) = 0.5555...
  c.close('answerRate = answered / routable', m.answerRate, 30 / 54);
  c.close('buyerEndedRate = 24 / 30', m.buyerEndedRate, 24 / 30);
  c.close('callerEndedRate = 6 / 30', m.callerEndedRate, 6 / 30);
  c.close('noRouteRate = 6 / 60', m.noRouteRate, 6 / 60);
  c.close('shortCallRate = 24 / 30', m.shortCallRate, 24 / 30);
  // avgDuration = (24*12 + 6*180) / 30 = (288 + 1080)/30 = 45.6
  c.close('avgDurationSeconds mean over answered-with-duration', m.avgDurationSeconds, 45.6);
  c.close('billableRate = 6 / 60', result.billableRate, 6 / 60);
  c.close('qualifiedRate = 6 / 60', result.qualifiedRate, 6 / 60);

  return finalize('assembler produces expected metrics', c);
}

// ---------------------------------------------------------------------------
// Scenario 2: missing fields remain undefined (never fabricated as zero).
// ---------------------------------------------------------------------------

function verifyMissingStaysMissing(): AssemblerScenarioResult {
  const c = new Checker();
  const result = assembleCallHandlingMetrics(windowOf(MISSING_FIELDS_RECORDS, 'w_missing'));
  const m = result.metrics;

  c.eq('sampleSize still counts every record', m.sampleSize, 20);
  // answerRate is derivable from status alone: 10 answered / 20 routable = 0.5.
  c.close('answerRate still derivable from status', m.answerRate, 0.5);
  // These depend on absent evidence and MUST be undefined, not 0.
  c.undef('buyerEndedRate undefined (no endedBy known)', m.buyerEndedRate);
  c.undef('callerEndedRate undefined (no endedBy known)', m.callerEndedRate);
  c.undef('shortCallRate undefined (no durations known)', m.shortCallRate);
  c.undef('avgDurationSeconds undefined (no durations known)', m.avgDurationSeconds);
  c.undef('billableRate undefined (no billable flags)', result.billableRate);
  c.undef('qualifiedRate undefined (no qualified flags)', result.qualifiedRate);
  // Guard against the "fabricated zero" bug explicitly.
  c.ok('buyerEndedRate is not a fabricated 0', m.buyerEndedRate !== 0);
  c.ok('shortCallRate is not a fabricated 0', m.shortCallRate !== 0);

  return finalize('missing fields remain undefined', c);
}

// ---------------------------------------------------------------------------
// Scenario 3: single attribution values are preserved.
// ---------------------------------------------------------------------------

function verifySingleAttributionPreserved(): AssemblerScenarioResult {
  const c = new Checker();
  const { attribution } = assembleCallHandlingMetrics(windowOf(SINGLE_ATTRIBUTION_RECORDS, 'w_single'));

  c.eq('vendorId preserved', attribution.vendorId, 'vendor-solo');
  c.eq('buyerId preserved', attribution.buyerId, 'buyer-solo');
  c.eq('source preserved', attribution.source, 'ppc-solo');
  c.eq('campaign preserved', attribution.campaign, 'campaign-solo');
  c.eq('not marked mixed', attribution.mixed, false);

  return finalize('single attribution preserved', c);
}

// ---------------------------------------------------------------------------
// Scenario 4: mixed attribution is honestly marked as mixed.
// ---------------------------------------------------------------------------

function verifyMixedAttribution(): AssemblerScenarioResult {
  const c = new Checker();
  const { attribution } = assembleCallHandlingMetrics(windowOf(MIXED_ATTRIBUTION_RECORDS, 'w_mixed'));

  c.eq('marked mixed', attribution.mixed, true);
  c.undef('no single vendorId collapsed', attribution.vendorId);
  c.undef('no single buyerId collapsed', attribution.buyerId);

  return finalize('mixed attribution marked honestly', c);
}

// ---------------------------------------------------------------------------
// Scenario 5 + 6: assembled metrics flow end-to-end to a buyer BrainActivity.
// ---------------------------------------------------------------------------

function verifyFlowToBuyerActivity(): AssemblerScenarioResult {
  const c = new Checker();
  const timestamp = new Date('2025-01-20T00:00:00.000Z');
  const { assembled, flow } = assembleAndRunCallHandlingFlow({
    window: windowOf(BUYER_ROOT_CAUSE_RECORDS, 'w_flow_buyer'),
    subject: 'call_handling_root_cause',
    activityId: 'act_assembler_buyer',
    timestamp,
  });
  const { assessment, envelope, activity } = flow;

  // Assembly fed the flow with the expected sample.
  c.eq('assembled sampleSize is 60', assembled.metrics.sampleSize, 60);

  // Diagnose: buyer root cause.
  c.eq('primary root cause is buyer', assessment.rootCauses[0]?.category, 'buyer');
  c.eq('assessment state is inferred', assessment.state, 'inferred');
  c.ok('at least one finding fired', assessment.findings.length > 0);

  // Recommend: envelope reflects the buyer diagnosis.
  c.eq('envelope root cause is buyer', envelope.rootCause, 'buyer');
  c.ok('envelope recommends something', envelope.recommendation.length > 0);

  // Publish: an immutable, buyer-owned BrainActivity.
  c.ok('flow produced a BrainActivity', activity !== undefined && activity !== null);
  c.eq('activity id preserved', activity.id, 'act_assembler_buyer');
  c.ok('timestamp preserved', activity.timestamp.getTime() === timestamp.getTime());
  c.eq('activityType is recommendation', activity.activityType, 'recommendation');
  c.eq('envelope preserved by reference', activity.recommendationEnvelope, envelope);
  c.eq('activity confidence mirrors envelope trust', activity.confidence, envelope.trust.confidence);
  c.ok('activity is frozen (immutable)', Object.isFrozen(activity));

  return finalize('assembled metrics flow to buyer BrainActivity', c);
}

// ---------------------------------------------------------------------------
// Scenario 7: insufficient evidence still yields an honest unknown.
// ---------------------------------------------------------------------------

function verifyInsufficientEvidenceUnknown(): AssemblerScenarioResult {
  const c = new Checker();
  const timestamp = new Date('2025-01-20T00:00:00.000Z');
  const { assembled, flow } = assembleAndRunCallHandlingFlow({
    window: windowOf(INSUFFICIENT_EVIDENCE_RECORDS, 'w_flow_unknown'),
    subject: 'call_handling_root_cause',
    activityId: 'act_assembler_unknown',
    timestamp,
  });
  const { assessment, envelope, activity } = flow;

  c.eq('assembled sampleSize is 6 (below minimum)', assembled.metrics.sampleSize, 6);
  c.eq('assessment state is unknown', assessment.state, 'unknown');
  c.eq('no findings on insufficient evidence', assessment.findings.length, 0);
  c.eq('primary root cause is unknown', assessment.rootCauses[0]?.category, 'unknown');
  c.eq('envelope root cause is unknown', envelope.rootCause, 'unknown');
  c.ok('activity still produced (honest unknown is first-class)', activity !== undefined && activity !== null);
  c.ok('activity is frozen (immutable)', Object.isFrozen(activity));

  return finalize('insufficient evidence yields unknown', c);
}

// ---------------------------------------------------------------------------
// Public entry point.
// ---------------------------------------------------------------------------

/** Run every assembler verification scenario and return a structured report.
 * Pure and deterministic: no I/O, no clock (fixtures pin the timestamp), no RNG. */
export function runCallHandlingAssemblerVerification(): AssemblerVerificationReport {
  const scenarios: AssemblerScenarioResult[] = [
    verifyExpectedMetrics(),
    verifyMissingStaysMissing(),
    verifySingleAttributionPreserved(),
    verifyMixedAttribution(),
    verifyFlowToBuyerActivity(),
    verifyInsufficientEvidenceUnknown(),
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
