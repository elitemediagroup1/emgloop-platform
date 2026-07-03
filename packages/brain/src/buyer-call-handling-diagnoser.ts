// @emgloop/brain — Buyer / Call-Handling diagnoser (first concrete DiagnosticEngine).
//
// Phase 1 (First Diagnoser). This is the platform's FIRST concrete implementation
// of the DiagnosticEngine contract (diagnostics.ts). It is deliberately NARROW:
// it answers one real, CallGrid-grounded business question about call handling —
//
//     "When calls are not qualifying/billable, is the likely cause the BUYER
//      (who answers/handles the call), the VENDOR (who sends the traffic), EMG
//      (internal routing/config), or is the evidence simply insufficient?"
//
// It is DETERMINISTIC and PURE: no LLM, no I/O, no persistence, no randomness.
// Given the same observations it always returns the same DiagnosticAssessment.
// It changes NO runtime behavior: nothing here is wired into ingestion, CallGrid,
// or any page. The only entry points are this engine's pure diagnose() and a
// pure helper (buildCallHandlingObservations) that a test or a future caller may
// use to assemble the Observations this engine reads. Wiring it into a live path
// is a separate, later decision.
//
// Root-cause vocabulary: the shared RootCause union is 'vendor' | 'buyer' | 'emg'
// | 'unknown'. The user-facing category "internal" maps to 'emg' (EMG-internal
// routing/configuration). 'unknown' is a first-class, honest answer and is what
// this engine returns whenever the sample is too small or the signals conflict.

import type { Confidence, Evidence, Priority, TenantScope } from './types';
import type {
  DiagnosticAssessment,
  DiagnosticContext,
  DiagnosticEngine,
  DiagnosticRootCause,
  DiagnosticState,
  Finding,
  MissingEvidence,
  Observation,
  Unknown,
} from './diagnostics';
import type { AlternativeExplanation, RootCause } from './recommendation';

// ---------------------------------------------------------------------------
// Canonical observation subjects this diagnoser reads. Each corresponds to a
// CallGrid-derived metric that already exists in the platform today (call
// status: answer/miss/no_answer/voicemail/transfer/complete/hangup; and the
// reconciled Interaction.metadata keys durationSeconds/billable/buyer/vendor).
// The diagnoser reads these as Observations so it never touches the DB itself.
// ---------------------------------------------------------------------------

export const CALL_HANDLING_SUBJECTS = {
  /** Fraction of routed calls the buyer actually answered, [0,1]. */
  answerRate: 'buyer_answer_rate',
  /** Fraction of connected calls the BUYER hung up (vs caller), [0,1]. */
  buyerEndedRate: 'buyer_ended_rate',
  /** Fraction of connected calls the CALLER hung up, [0,1]. */
  callerEndedRate: 'caller_ended_rate',
  /** Fraction of calls that failed to route to a buyer at all, [0,1]. */
  noRouteRate: 'no_route_rate',
  /** Fraction of answered calls too short to qualify as billable, [0,1]. */
  shortCallRate: 'short_call_rate',
  /** Average answered-call duration, seconds. */
  avgDurationSeconds: 'avg_duration_seconds',
  /** Number of calls in the window (the sample size). */
  sampleSize: 'call_sample_size',
} as const;

/** Deterministic thresholds. All are explicit and documented so a reviewer can
 *  see exactly when each finding fires. Tuning these is a config decision, not a
 *  code-behavior change; they live here (not magic numbers inline) on purpose. */
export interface CallHandlingThresholds {
  /** Below this many calls, the engine refuses to guess and returns 'unknown'. */
  minSampleSize: number;
  /** answerRate at or below this is "degraded". */
  lowAnswerRate: number;
  /** buyerEndedRate at or above this is "buyer ends calls unusually often". */
  highBuyerEndedRate: number;
  /** callerEndedRate at or above this is "caller ends calls unusually often". */
  highCallerEndedRate: number;
  /** noRouteRate at or above this is "no-route rate elevated". */
  highNoRouteRate: number;
  /** shortCallRate at or above this is "duration too short to qualify". */
  highShortCallRate: number;
}

/** The default thresholds. Conservative on sample size so early, sparse data
 *  yields an honest 'unknown' rather than a confident-but-wrong attribution. */
export const DEFAULT_CALL_HANDLING_THRESHOLDS: CallHandlingThresholds = {
  minSampleSize: 20,
  lowAnswerRate: 0.6,
  highBuyerEndedRate: 0.35,
  highCallerEndedRate: 0.5,
  highNoRouteRate: 0.15,
  highShortCallRate: 0.4,
};

// ---------------------------------------------------------------------------
// Pure helpers.
// ---------------------------------------------------------------------------

/** Plain metrics a caller already has today from CallGrid-derived data. This is
 *  the shape a test/helper passes in; the engine itself only reads Observations. */
export interface CallHandlingMetrics {
  answerRate?: number;
  buyerEndedRate?: number;
  callerEndedRate?: number;
  noRouteRate?: number;
  shortCallRate?: number;
  avgDurationSeconds?: number;
  sampleSize: number;
}

/** Build the Observations this diagnoser reads from a plain metrics object.
 *  Pure and non-invasive: it does not read the DB or change any behavior; it is
 *  a convenience for tests and future callers. Each Observation carries the
 *  evidence trail back to the CallGrid interactions the metric was computed from. */
export function buildCallHandlingObservations(
  scope: TenantScope,
  metrics: CallHandlingMetrics,
  windowRef?: string,
): Observation[] {
  const evidence: Evidence[] = [
    {
      kind: 'interaction',
      ref: windowRef,
      description: 'CallGrid call interactions in the analysis window',
    },
  ];
  const make = (subject: string, value: number | undefined, unit?: string): Observation | undefined => {
    if (value === undefined || value === null || Number.isNaN(value)) return undefined;
    return {
      organizationId: scope.organizationId,
      locationId: scope.locationId,
      subject,
      value,
      unit,
      evidence,
      state: 'observed',
    };
  };
  const S = CALL_HANDLING_SUBJECTS;
  const out: Array<Observation | undefined> = [
    make(S.sampleSize, metrics.sampleSize, 'count'),
    make(S.answerRate, metrics.answerRate, 'ratio'),
    make(S.buyerEndedRate, metrics.buyerEndedRate, 'ratio'),
    make(S.callerEndedRate, metrics.callerEndedRate, 'ratio'),
    make(S.noRouteRate, metrics.noRouteRate, 'ratio'),
    make(S.shortCallRate, metrics.shortCallRate, 'ratio'),
    make(S.avgDurationSeconds, metrics.avgDurationSeconds, 'seconds'),
  ];
  return out.filter((o): o is Observation => o !== undefined);
}

/** Read a single numeric observation value by subject, or undefined if absent. */
function numeric(observations: Observation[], subject: string): number | undefined {
  const obs = observations.find((o) => o.subject === subject);
  if (!obs) return undefined;
  return typeof obs.value === 'number' ? obs.value : undefined;
}

/** Collect the union of evidence across the given observations, de-duped. */
function collectEvidence(observations: Observation[]): Evidence[] {
  const out: Evidence[] = [];
  const seen = new Set<string>();
  observations.forEach((o) => {
    (o.evidence ?? []).forEach((e) => {
      const key = e.ref ?? e.kind + ':' + e.description;
      if (seen.has(key)) return;
      seen.add(key);
      out.push(e);
    });
  });
  return out;
}

// ---------------------------------------------------------------------------
// The engine.
// ---------------------------------------------------------------------------

/** Create the Buyer / Call-Handling diagnoser. Optionally override thresholds. */
export function createBuyerCallHandlingDiagnoser(
  thresholds: CallHandlingThresholds = DEFAULT_CALL_HANDLING_THRESHOLDS,
): DiagnosticEngine {
  return {
    id: 'buyer-call-handling-diagnoser',
    diagnose(context: DiagnosticContext): DiagnosticAssessment {
      const scope: TenantScope = {
        organizationId: context.organizationId,
        locationId: context.locationId,
      };
      const obs = context.observations;
      const allEvidence = collectEvidence(obs);
      const sampleSize = numeric(obs, CALL_HANDLING_SUBJECTS.sampleSize);

      // Honest 'unknown' when we cannot responsibly diagnose.
      const insufficient = (reason: Unknown['reason'], detail: string): DiagnosticAssessment =>
        unknownAssessment(scope, context.subject, obs, allEvidence, reason, detail);

      if (obs.length === 0) {
        return insufficient('no_signal', 'No call-handling observations were provided.');
      }
      if (sampleSize === undefined) {
        return insufficient('insufficient_evidence', 'Sample size is unknown; cannot qualify any rate.');
      }
      if (sampleSize < thresholds.minSampleSize) {
        return insufficient(
          'insufficient_evidence',
          'Only ' + sampleSize + ' calls in window; below the minimum of ' +
            thresholds.minSampleSize + ' required to attribute a root cause.',
        );
      }

      const answerRate = numeric(obs, CALL_HANDLING_SUBJECTS.answerRate);
      const buyerEnded = numeric(obs, CALL_HANDLING_SUBJECTS.buyerEndedRate);
      const callerEnded = numeric(obs, CALL_HANDLING_SUBJECTS.callerEndedRate);
      const noRoute = numeric(obs, CALL_HANDLING_SUBJECTS.noRouteRate);
      const shortRate = numeric(obs, CALL_HANDLING_SUBJECTS.shortCallRate);

      const findings: Finding[] = [];
      const missing: MissingEvidence[] = [];
      const addFinding = (
        subject: string,
        statement: string,
        severity: Priority,
        confidence: Confidence,
        state: DiagnosticState = 'inferred',
      ): void => {
        findings.push({ subject, statement, severity, evidence: allEvidence, confidence, state });
      };
      const requireMetric = (present: number | undefined, kind: string, description: string): void => {
        if (present === undefined) missing.push({ kind, description, expectedInformationGain: 0.5 });
      };

      requireMetric(answerRate, 'metric', 'buyer_answer_rate for the window');
      requireMetric(buyerEnded, 'metric', 'buyer_ended_rate (who hung up) for the window');
      requireMetric(noRoute, 'metric', 'no_route_rate for the window');

      // Deterministic findings.
      if (answerRate !== undefined && answerRate <= thresholds.lowAnswerRate) {
        addFinding(
          CALL_HANDLING_SUBJECTS.answerRate,
          'Buyer answer rate is degraded (' + pct(answerRate) + ' <= ' + pct(thresholds.lowAnswerRate) + ').',
          'high',
          0.7,
        );
      }
      if (buyerEnded !== undefined && buyerEnded >= thresholds.highBuyerEndedRate) {
        addFinding(
          CALL_HANDLING_SUBJECTS.buyerEndedRate,
          'Buyer ended calls unusually often (' + pct(buyerEnded) + ' >= ' + pct(thresholds.highBuyerEndedRate) + ').',
          'high',
          0.7,
        );
      }
      if (callerEnded !== undefined && callerEnded >= thresholds.highCallerEndedRate) {
        addFinding(
          CALL_HANDLING_SUBJECTS.callerEndedRate,
          'Caller ended calls unusually often (' + pct(callerEnded) + ' >= ' + pct(thresholds.highCallerEndedRate) + ').',
          'normal',
          0.6,
        );
      }
      if (noRoute !== undefined && noRoute >= thresholds.highNoRouteRate) {
        addFinding(
          CALL_HANDLING_SUBJECTS.noRouteRate,
          'No-route rate is elevated (' + pct(noRoute) + ' >= ' + pct(thresholds.highNoRouteRate) + ').',
          'high',
          0.7,
        );
      }
      if (shortRate !== undefined && shortRate >= thresholds.highShortCallRate) {
        addFinding(
          CALL_HANDLING_SUBJECTS.shortCallRate,
          'Answered calls are too short to qualify (' + pct(shortRate) + ' >= ' + pct(thresholds.highShortCallRate) + ').',
          'normal',
          0.6,
        );
      }

      // If nothing crossed a threshold, that itself is an honest 'unknown': the
      // sample was adequate but no call-handling problem is evident here.
      if (findings.length === 0) {
        return unknownAssessment(
          scope,
          context.subject,
          obs,
          allEvidence,
          'no_signal',
          'Sample was adequate but no call-handling metric crossed a threshold.',
        );
      }

      // Deterministic root-cause classification from the findings that fired.
      const { rootCauses, alternatives, confidence, state } = classify({
        answerRate,
        buyerEnded,
        callerEnded,
        noRoute,
        shortRate,
        evidence: allEvidence,
        thresholds,
      });

      return {
        organizationId: scope.organizationId,
        locationId: scope.locationId,
        subject: context.subject,
        observations: obs,
        findings,
        rootCauses,
        unknowns: buildResidualUnknowns(missing),
        missingEvidence: missing,
        confidence,
        state,
        assessedAt: context.asOf,
      };
    },
  };
}

/** A ready-to-use instance with default thresholds. */
export const buyerCallHandlingDiagnoser: DiagnosticEngine = createBuyerCallHandlingDiagnoser();

// ---------------------------------------------------------------------------
// Classification (pure).
// ---------------------------------------------------------------------------

interface ClassifyInput {
  answerRate?: number;
  buyerEnded?: number;
  callerEnded?: number;
  noRoute?: number;
  shortRate?: number;
  evidence: Evidence[];
  thresholds: CallHandlingThresholds;
}

interface ClassifyOutput {
  rootCauses: DiagnosticRootCause[];
  alternatives: AlternativeExplanation[];
  confidence: Confidence;
  state: DiagnosticState;
}

/** Deterministic attribution. Buyer-owned signals (low answer rate, buyer hangs
 *  up, short handled calls) point to 'buyer'. Routing failure (elevated no-route)
 *  points to EMG-internal config ('emg'). Caller-driven hangups with otherwise
 *  healthy buyer behavior point to 'vendor' (traffic quality). Conflicting or
 *  weak signals return 'unknown'. */
function classify(input: ClassifyInput): ClassifyOutput {
  const t = input.thresholds;
  const buyerSignals =
    (input.answerRate !== undefined && input.answerRate <= t.lowAnswerRate ? 1 : 0) +
    (input.buyerEnded !== undefined && input.buyerEnded >= t.highBuyerEndedRate ? 1 : 0) +
    (input.shortRate !== undefined && input.shortRate >= t.highShortCallRate ? 1 : 0);
  const emgSignals = input.noRoute !== undefined && input.noRoute >= t.highNoRouteRate ? 1 : 0;
  const vendorSignals =
    input.callerEnded !== undefined && input.callerEnded >= t.highCallerEndedRate ? 1 : 0;

  const alternatives: AlternativeExplanation[] = [];
  const rootCauses: DiagnosticRootCause[] = [];

  const pushCause = (
    category: RootCause,
    hypothesis: string,
    rationale: string,
    confidence: Confidence,
  ): void => {
    rootCauses.push({ category, hypothesis, rationale, evidence: input.evidence, confidence });
  };

  // Primary attribution = the category with the most fired signals; ties and
  // no-signal cases resolve to 'unknown' (honest, never forced).
  const scores: Array<{ cat: RootCause; n: number }> = [
    { cat: 'buyer', n: buyerSignals },
    { cat: 'emg', n: emgSignals },
    { cat: 'vendor', n: vendorSignals },
  ];
  scores.sort((a, b) => b.n - a.n);

  const top = scores[0];
  const runnerUp = scores[1];
  // Under noUncheckedIndexedAccess, guard the array access explicitly. 'scores'
  // is always length 3 by construction, but we prove it to the type system.
  if (top === undefined) {
    pushCause('unknown', 'Root cause is unclear.', 'No categories to score.', 0.3);
    return { rootCauses, alternatives, confidence: 0.3, state: 'unknown' };
  }
  const tie = runnerUp !== undefined && runnerUp.n === top.n && top.n > 0;

  if (top.n === 0 || tie) {
    pushCause(
      'unknown',
      'Root cause is unclear.',
      tie
        ? 'Signals point to more than one category with equal weight; not forcing a single cause.'
        : 'No category accumulated a decisive signal.',
      0.3,
    );
    // Still record what each non-zero category would suggest, as alternatives.
    scores
      .filter((s) => s.n > 0)
      .forEach((s) => alternatives.push(altFor(s.cat, s.n)));
    return { rootCauses, alternatives, confidence: 0.3, state: 'unknown' };
  }

  pushCause(top.cat, hypothesisFor(top.cat), rationaleFor(top.cat, top.n), confidenceFor(top.n));
  scores
    .filter((s) => s.cat !== top.cat && s.n > 0)
    .forEach((s) => {
      pushCause(s.cat, hypothesisFor(s.cat), rationaleFor(s.cat, s.n), confidenceFor(s.n) * 0.6);
      alternatives.push(altFor(s.cat, s.n));
    });

  return {
    rootCauses,
    alternatives,
    confidence: confidenceFor(top.n),
    state: 'inferred',
  };
}

function altFor(cat: RootCause, n: number): AlternativeExplanation {
  return { hypothesis: hypothesisFor(cat), rationale: rationaleFor(cat, n), likelihood: confidenceFor(n) * 0.6 };
}

function hypothesisFor(cat: RootCause): string {
  switch (cat) {
    case 'buyer':
      return 'The buyer is mishandling calls (not answering, hanging up early, or short calls).';
    case 'emg':
      return 'EMG-internal routing/configuration is failing to connect calls (no-route).';
    case 'vendor':
      return 'The vendor traffic quality is poor (callers disconnect before qualifying).';
    default:
      return 'Root cause is unclear.';
  }
}

function rationaleFor(cat: RootCause, n: number): string {
  return n + ' deterministic call-handling signal(s) attributed to the ' + cat + ' category crossed threshold.';
}

/** Confidence scales with the number of concordant signals, capped so a
 *  rules-based diagnoser never claims near-certainty. */
function confidenceFor(n: number): Confidence {
  if (n >= 3) return 0.8;
  if (n === 2) return 0.7;
  if (n === 1) return 0.55;
  return 0.3;
}

// ---------------------------------------------------------------------------
// 'unknown' assessment + residual unknowns (pure).
// ---------------------------------------------------------------------------

function unknownAssessment(
  scope: TenantScope,
  subject: string,
  observations: Observation[],
  evidence: Evidence[],
  reason: Unknown['reason'],
  detail: string,
): DiagnosticAssessment {
  return {
    organizationId: scope.organizationId,
    locationId: scope.locationId,
    subject,
    observations,
    findings: [],
    rootCauses: [
      {
        category: 'unknown',
        hypothesis: 'Insufficient or inconclusive evidence to attribute a root cause.',
        rationale: detail,
        evidence,
        confidence: 0.2,
      },
    ],
    unknowns: [{ subject: 'call_handling_root_cause', reason, detail }],
    missingEvidence: [
      {
        kind: 'metric',
        description: 'More calls and/or the who-ended and routing breakdown for the window.',
        expectedInformationGain: 0.8,
      },
    ],
    confidence: 0.2,
    state: 'unknown',
  };
}

function buildResidualUnknowns(missing: MissingEvidence[]): Unknown[] {
  if (missing.length === 0) return [];
  return [
    {
      subject: 'call_handling_attribution_completeness',
      reason: 'insufficient_evidence',
      detail: 'Some call-handling metrics were absent; attribution used only the metrics present.',
    },
  ];
}

// ---------------------------------------------------------------------------
// Small formatting helper (pure).
// ---------------------------------------------------------------------------

/** Format a [0,1] ratio as a percent string for human-readable statements. */
function pct(x: number): string {
  return Math.round(x * 100) + '%';
}
