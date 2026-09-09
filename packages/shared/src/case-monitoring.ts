// Watching whether it held, saying what happened, and closing only when that is
// actually established.
//
// THREE THINGS THAT MUST NOT BE ONE THING. Monitoring is a plan to observe.
// An outcome is what was observed. A resolution is a decision that the question
// is answered. Collapsing any two of them produces the failure this whole stage
// exists to avoid: a system that says "recovered" because nobody objected, or
// "resolved" because a number moved, or "caused" because two things happened in
// order.
//
// THE CASE LIFECYCLE IS NOT REDEFINED HERE. `OperationalPriorityState` already
// carries NEEDS_REVIEW, ASSIGNED, WATCHING, RESOLVED and DISMISSED, and
// `REOPENED` already exists as both an observation and a projection that clears
// `resolvedAt` and increments `reopenCount`. WATCHING IS MONITORING and REOPENED
// IS RE-ENGAGEMENT; a second lifecycle beside them would be two answers to "is
// this open", and the repository has paid for that mistake five times already.
// What was missing was never the states -- it was the plan, the verdict and the
// eligibility rule.
//
// UNKNOWN NEVER BECOMES SUCCESS. A monitoring window that ends with insufficient
// evidence concludes INCONCLUSIVE, and INCONCLUSIVE is not a pass. This is the
// single most important property in the file: a monitor that quietly succeeds on
// missing data is worse than no monitor, because somebody will believe it.
//
// NOTHING HERE ASSERTS WHY. An outcome records what happened after an
// intervention. Whether the intervention CAUSED it is a claim this platform
// cannot support from a Case, and manufacturing it would be the most expensive
// possible way to be wrong.
//
// PURE. No clock, no I/O. `now` is an argument.

import type { OperationalOutcome } from './operational-lifecycle';

export const CASE_MONITORING_RULE_VERSION = 'case-monitoring.v1';

// --- The plan --------------------------------------------------------------------------

/**
 * What is being watched, and what would count as it having held.
 *
 * EVERY FIELD IS DECLARED IN ADVANCE, DELIBERATELY. A success condition written
 * after the numbers are in is not a test, it is a rationalisation -- and the
 * whole value of monitoring is that somebody committed to what would count
 * before they knew the answer.
 */
export interface MonitoringPlan {
  /** What is being watched, in the producer's own terms. Never parsed here. */
  condition: string;
  /**
   * What it was before, when that is known.
   *
   * NULL IS A REAL ANSWER and it is not zero. A monitor with no baseline can
   * still detect a threshold breach; it cannot report a recovery, and the
   * verdict says so rather than inventing a starting point.
   */
  baseline: MonitoringMeasure | null;
  /** What would count as it having held. */
  success: MonitoringCriterion;
  /** What would count as it having failed. Distinct from "not success". */
  failure: MonitoringCriterion;
  /** The window over which the question is asked. ISO instants. */
  observationStart: string;
  observationEnd: string;
  /**
   * What evidence has to exist before the window can be judged at all.
   *
   * THE GATE THAT STOPS SILENCE READING AS SUCCESS. A window with no
   * measurement is not a window in which nothing went wrong.
   */
  requires: MonitoringEvidenceRequirement;
  /** Who set this up, and when. A plan is somebody's, never nobody's. */
  plannedByUserId: string | null;
  plannedAt: string;
  /** Why it is being watched, for a person. Carries no policy meaning. */
  note: string | null;
}

export interface MonitoringMeasure {
  /** The metric key, in the producer's vocabulary. */
  metric: string;
  value: number;
  unit: string;
  /** How many observations the value is over. Null when not applicable. */
  denominator: number | null;
}

/** A condition expressed as a comparison a machine can actually evaluate. */
export interface MonitoringCriterion {
  metric: string;
  comparison: MonitoringComparison;
  /** The number compared against. For WITHIN_PERCENT_OF_BASELINE, a percentage. */
  threshold: number;
  /** What the criterion means, for a person. Never used to decide anything. */
  statement: string;
}

export const MONITORING_COMPARISONS = [
  'AT_OR_ABOVE',
  'AT_OR_BELOW',
  /** Back inside a band around the baseline. Requires a baseline to evaluate. */
  'WITHIN_PERCENT_OF_BASELINE',
] as const;

export type MonitoringComparison = (typeof MONITORING_COMPARISONS)[number];

/** What must be true of the evidence before a window may be judged. */
export interface MonitoringEvidenceRequirement {
  /** Minimum observations in the window. Below this, the answer is INCONCLUSIVE. */
  minimumObservations: number;
  /**
   * Minimum measurement coverage, 0-1, when the producer reports coverage.
   *
   * A WINDOW MEASURED AT 40% IS NOT A WINDOW. Stage 3 already refuses to publish
   * a Headline on thin coverage; a monitor that accepted it would be a second,
   * laxer gate on the same question.
   */
  minimumCoverage: number | null;
  /** Whether the window has to have elapsed before it may be judged at all. */
  requiresCompleteWindow: boolean;
}

// --- The verdict -------------------------------------------------------------------------

export const MONITORING_VERDICTS = [
  /** The window is not over and the plan says it must be. */
  'IN_PROGRESS',
  /** The success condition was met on evidence that satisfied the requirement. */
  'HELD',
  /** The failure condition was met on evidence that satisfied the requirement. */
  'DID_NOT_HOLD',
  /**
   * Neither condition was met, on adequate evidence.
   *
   * A REAL ANSWER, AND NOT A SUCCESS. The thing being watched did neither what
   * was hoped nor what was feared, and reporting that is more useful than
   * rounding it to whichever is nearer.
   */
  'NEITHER',
  /**
   * There is not enough evidence to say.
   *
   * THE MOST IMPORTANT MEMBER OF THIS LIST. It is what a window with missing
   * measurement produces, and it must never be read as HELD.
   */
  'INCONCLUSIVE',
] as const;

export type MonitoringVerdict = (typeof MONITORING_VERDICTS)[number];

/** Why the evidence was not good enough. One reason, named. */
export const MONITORING_INSUFFICIENCIES = [
  'TOO_FEW_OBSERVATIONS',
  'COVERAGE_BELOW_REQUIREMENT',
  'WINDOW_NOT_COMPLETE',
  'NO_MEASUREMENT_AT_ALL',
  /** The criterion is relative to a baseline the plan never recorded. */
  'BASELINE_UNKNOWN',
  /** The producer reported a metric this criterion does not name. */
  'METRIC_NOT_MEASURED',
] as const;

export type MonitoringInsufficiency = (typeof MONITORING_INSUFFICIENCIES)[number];

export const MONITORING_INSUFFICIENCY_LABELS: Record<MonitoringInsufficiency, string> = {
  TOO_FEW_OBSERVATIONS: 'There were not enough observations in the window to judge it.',
  COVERAGE_BELOW_REQUIREMENT: 'Measurement coverage over the window was below what this monitor requires.',
  WINDOW_NOT_COMPLETE: 'The observation window has not finished yet.',
  NO_MEASUREMENT_AT_ALL: 'Nothing was measured in this window.',
  BASELINE_UNKNOWN: 'This monitor compares against a baseline, and no baseline was recorded.',
  METRIC_NOT_MEASURED: 'The measurement available does not cover the metric this monitor watches.',
};

/** What the producer actually measured over the window. */
export interface MonitoringObservation {
  metric: string;
  value: number;
  unit: string;
  denominator: number | null;
  /** 0-1, when the producer reports it. Null when it does not. */
  coverage: number | null;
  /** How many separate observations the value is drawn from. */
  observationCount: number;
  /** The evidence rows this reading came from, so the verdict stays traceable. */
  evidenceIds: readonly string[];
}

export interface MonitoringAssessment {
  ruleVersion: string;
  verdict: MonitoringVerdict;
  /** Present exactly when the verdict is INCONCLUSIVE. */
  insufficiency: MonitoringInsufficiency | null;
  /** The reading judged, when there was one. */
  measured: MonitoringObservation | null;
  /** Sentences, produced by the same walk that produced the verdict. */
  explanation: readonly string[];
  /** The evidence the verdict rests on. Empty when there is none, never faked. */
  evidenceIds: readonly string[];
}

export interface MonitoringInput {
  plan: MonitoringPlan;
  /** What was measured. Null when nothing was. */
  observation: MonitoringObservation | null;
  now: Date;
}

/**
 * Whether the thing being watched held.
 *
 * THE ORDER IS THE ARGUMENT. Evidence sufficiency is decided BEFORE the
 * criteria are looked at, so a comparison is never run against a number the plan
 * itself says is not good enough to compare. Checking sufficiency afterwards is
 * how a monitor comes to report success on two data points.
 *
 * NO MODEL IS CONSULTED, AND THERE IS NOWHERE FOR ONE TO ATTACH. Every branch is
 * an arithmetic comparison over declared numbers.
 */
export function assessMonitoring(input: MonitoringInput): MonitoringAssessment {
  const { plan, observation, now } = input;
  const explanation: string[] = [];
  const windowOver = now.getTime() >= Date.parse(plan.observationEnd);

  const inconclusive = (
    insufficiency: MonitoringInsufficiency,
  ): MonitoringAssessment => ({
    ruleVersion: CASE_MONITORING_RULE_VERSION,
    verdict: 'INCONCLUSIVE',
    insufficiency,
    measured: observation,
    explanation: [...explanation, MONITORING_INSUFFICIENCY_LABELS[insufficiency]],
    evidenceIds: observation?.evidenceIds ?? [],
  });

  // 1. Is the window even askable yet?
  if (!windowOver && plan.requires.requiresCompleteWindow) {
    return {
      ruleVersion: CASE_MONITORING_RULE_VERSION,
      verdict: 'IN_PROGRESS',
      insufficiency: null,
      measured: observation,
      explanation: ['The observation window has not finished, and this monitor waits for it.'],
      evidenceIds: observation?.evidenceIds ?? [],
    };
  }
  // A monitor that does NOT require a complete window is still not judgeable
  // before it starts producing readings; silence in an unfinished window is not
  // the same as a result.
  if (!windowOver && observation === null) {
    return inconclusive('WINDOW_NOT_COMPLETE');
  }

  // 2. Is there anything to judge?
  if (observation === null) return inconclusive('NO_MEASUREMENT_AT_ALL');
  if (observation.observationCount < plan.requires.minimumObservations) {
    return inconclusive('TOO_FEW_OBSERVATIONS');
  }
  if (
    plan.requires.minimumCoverage !== null &&
    (observation.coverage === null || observation.coverage < plan.requires.minimumCoverage)
  ) {
    // Coverage the producer did NOT report is treated as failing the
    // requirement, not as passing it. A monitor asked to require coverage
    // cannot be satisfied by a producer that declines to report any.
    return inconclusive('COVERAGE_BELOW_REQUIREMENT');
  }

  // 3. Does the reading even cover the metric the criteria name?
  if (observation.metric !== plan.success.metric || observation.metric !== plan.failure.metric) {
    return inconclusive('METRIC_NOT_MEASURED');
  }

  // 4. A relative criterion needs the baseline it is relative to.
  const relative =
    plan.success.comparison === 'WITHIN_PERCENT_OF_BASELINE' ||
    plan.failure.comparison === 'WITHIN_PERCENT_OF_BASELINE';
  if (relative && plan.baseline === null) return inconclusive('BASELINE_UNKNOWN');

  explanation.push(
    `Measured ${observation.value} ${observation.unit} over ${observation.observationCount} observations.`,
  );

  const met = (c: MonitoringCriterion) => criterionMet(c, observation, plan.baseline);
  const success = met(plan.success);
  const failure = met(plan.failure);

  // BOTH CANNOT BE TRUE, and if a badly written plan makes them so, failure
  // wins. Reporting a monitor as HELD when its own failure condition also fired
  // is the exact shape of a system flattering itself.
  if (failure) {
    return {
      ruleVersion: CASE_MONITORING_RULE_VERSION,
      verdict: 'DID_NOT_HOLD',
      insufficiency: null,
      measured: observation,
      explanation: [...explanation, plan.failure.statement],
      evidenceIds: observation.evidenceIds,
    };
  }
  if (success) {
    return {
      ruleVersion: CASE_MONITORING_RULE_VERSION,
      verdict: 'HELD',
      insufficiency: null,
      measured: observation,
      explanation: [...explanation, plan.success.statement],
      evidenceIds: observation.evidenceIds,
    };
  }
  return {
    ruleVersion: CASE_MONITORING_RULE_VERSION,
    verdict: 'NEITHER',
    insufficiency: null,
    measured: observation,
    explanation: [
      ...explanation,
      'Neither the success condition nor the failure condition was met.',
    ],
    evidenceIds: observation.evidenceIds,
  };
}

function criterionMet(
  criterion: MonitoringCriterion,
  observation: MonitoringObservation,
  baseline: MonitoringMeasure | null,
): boolean {
  switch (criterion.comparison) {
    case 'AT_OR_ABOVE':
      return observation.value >= criterion.threshold;
    case 'AT_OR_BELOW':
      return observation.value <= criterion.threshold;
    case 'WITHIN_PERCENT_OF_BASELINE': {
      if (baseline === null || baseline.value === 0) return false;
      const drift = Math.abs(observation.value - baseline.value) / Math.abs(baseline.value);
      return drift <= criterion.threshold;
    }
  }
}

// --- The outcome ------------------------------------------------------------------------

/**
 * What happened after the intervention -- and, explicitly, not why.
 *
 * THE ONE LINE THIS TYPE EXISTS TO DRAW. "Monetized rate returned to within 5%
 * of baseline during the monitoring window" is something Loop can support:
 * two measurements and a window. "Contacting CEM caused monetized rate to
 * recover" is a causal claim, and nothing in this platform can establish one
 * from a single Case -- there is no control, no counterfactual, and no isolation
 * of the intervention from everything else that changed that week.
 *
 * SO `causalClaim` IS ALWAYS NULL, and it is a field rather than an absence so
 * that a reader can see the refusal instead of assuming nobody thought about it.
 */
export interface CaseOutcomeView {
  ruleVersion: string;
  caseId: string;
  /** The governed outcome vocabulary. Unchanged, and not extended. */
  outcome: OperationalOutcome | null;
  /** What was measured, when anything was. Never a forecast. */
  measuredEffectCents: number | null;
  measuredEffectBasis: string | null;
  /** What Loop can say happened, as a sentence about correlation. */
  statement: string;
  /** ALWAYS NULL. See the type's header. */
  causalClaim: null;
  /** Why it is null, so the refusal is visible rather than inferred. */
  causalCaveat: string;
  /** Everything this outcome descends from. Assembled, never copied. */
  lineage: CaseOutcomeLineage;
  /** What the outcome could not establish. Carried, not hidden. */
  notEstablished: readonly string[];
}

/** Where an outcome came from. Identifiers only; every one is followable. */
export interface CaseOutcomeLineage {
  /** The Finding that was current when the outcome was recorded. */
  findingId: string | null;
  /** Recommendation options the Case recorded, and which one was selected. */
  recommendationDecisionIds: readonly string[];
  selectedRecommendationDecisionId: string | null;
  /** Work the Case pointed at. References, never copies. */
  workReferences: readonly { system: string; id: string | null }[];
  /** The monitoring window this outcome was judged over, if there was one. */
  monitoringWindow: { start: string; end: string } | null;
  monitoringVerdict: MonitoringVerdict | null;
  /** The evidence rows the outcome rests on. */
  evidenceIds: readonly string[];
  /** The observation that recorded it, so the act stays auditable. */
  observationId: string | null;
}

export const CAUSAL_CAVEAT =
  'Loop can say what happened after this was acted on. It cannot say that acting on it is ' +
  'what caused the change: there is no control, no counterfactual, and no way to separate ' +
  'this intervention from everything else that changed in the same window.';

/**
 * The safe sentence, built from what is actually recorded.
 *
 * NEVER USES A CAUSAL VERB. No "because", no "led to", no "resulted in", no
 * "caused". The sentence names the window and the measurement, and stops.
 */
export function describeOutcome(input: {
  outcome: OperationalOutcome | null;
  monitoring: MonitoringAssessment | null;
  window: { start: string; end: string } | null;
}): string {
  if (input.monitoring && input.window) {
    const window = `between ${input.window.start} and ${input.window.end}`;
    switch (input.monitoring.verdict) {
      case 'HELD':
        return `The condition being watched met its success criterion ${window}.`;
      case 'DID_NOT_HOLD':
        return `The condition being watched met its failure criterion ${window}.`;
      case 'NEITHER':
        return `The condition being watched met neither criterion ${window}.`;
      case 'INCONCLUSIVE':
        return `Loop could not establish what happened ${window}.`;
      case 'IN_PROGRESS':
        return `The observation window ${window} has not finished.`;
    }
  }
  if (input.outcome === null) return 'No outcome has been recorded for this investigation.';
  return `The recorded outcome of this investigation is ${input.outcome}.`;
}

// --- Resolution eligibility ------------------------------------------------------------------

/**
 * Everything that has to be true before Loop may close an investigation itself.
 *
 * ALL OF THEM, NOT MOST. A Case is a question somebody authorized; closing it
 * says the question is answered. Closing one on three conditions out of four is
 * Loop deciding the fourth did not matter, which is not a decision it is
 * entitled to make.
 */
export const RESOLUTION_CONDITIONS = [
  /** A Finding is established, or the Case was explicitly answered without one. */
  'QUESTION_ANSWERED',
  /** Every piece of work the Case pointed at is complete, and readable. */
  'WORK_COMPLETE',
  /** Nothing is still blocking anything the Case asked for. */
  'NOTHING_BLOCKED',
  /** Any monitoring plan has produced a verdict that is not INCONCLUSIVE. */
  'MONITORING_SETTLED',
  /** Loop could read everything it was asked about -- no dangling references. */
  'COORDINATION_COMPLETE',
] as const;

export type ResolutionCondition = (typeof RESOLUTION_CONDITIONS)[number];

export const RESOLUTION_CONDITION_LABELS: Record<ResolutionCondition, string> = {
  QUESTION_ANSWERED: 'The question this investigation was opened to answer has been answered.',
  WORK_COMPLETE: 'Everything this investigation asked for has been completed.',
  NOTHING_BLOCKED: 'Nothing this investigation asked for is still blocked.',
  MONITORING_SETTLED: 'Monitoring reached a verdict.',
  COORDINATION_COMPLETE: 'Loop could read the state of everything this investigation pointed at.',
};

export interface ResolutionEligibility {
  ruleVersion: string;
  eligible: boolean;
  /** Conditions that hold. */
  met: readonly ResolutionCondition[];
  /** Conditions that do not. Named, so a person can see what is left. */
  unmet: readonly ResolutionCondition[];
  /**
   * The outcome Loop would record. Never RECOVERED on its own initiative --
   * see below.
   */
  outcome: OperationalOutcome | null;
  explanation: readonly string[];
}

export interface ResolutionInput {
  findingEstablished: boolean;
  workAllComplete: boolean;
  /** True when the Case pointed at no work at all. Not the same as complete. */
  noWorkRequested: boolean;
  openBlockers: number;
  monitoring: MonitoringAssessment | null;
  coordinationComplete: boolean;
}

/**
 * Whether Loop may close this itself, and what it would record.
 *
 * THE OUTCOME LOOP MAY CHOOSE IS DELIBERATELY NARROW. A monitoring verdict of
 * HELD supports RECOVERED, because a declared success criterion was met on
 * adequate evidence and somebody committed to that criterion in advance. Every
 * other shape resolves to NO_ACTION_NEEDED or nothing at all. In particular
 * Loop never records PARTIALLY_RECOVERED on its own: "partially" is a judgement
 * about how much of the problem is left, and nothing here can measure that.
 *
 * A HUMAN IS NEVER BOUND BY THIS. Keeping an eligible Case open, resolving an
 * ineligible one, and reopening a resolved one are all still available, and all
 * still recorded. This says only what LOOP may do unprompted.
 */
export function assessResolutionEligibility(input: ResolutionInput): ResolutionEligibility {
  const met: ResolutionCondition[] = [];
  const unmet: ResolutionCondition[] = [];
  const explanation: string[] = [];

  const push = (condition: ResolutionCondition, holds: boolean) => {
    (holds ? met : unmet).push(condition);
    if (!holds) explanation.push(`Not yet: ${RESOLUTION_CONDITION_LABELS[condition]}`);
  };

  push('QUESTION_ANSWERED', input.findingEstablished);
  // A Case that asked for no work has nothing outstanding, which is different
  // from a Case whose work finished -- but for this condition both qualify.
  push('WORK_COMPLETE', input.noWorkRequested || input.workAllComplete);
  push('NOTHING_BLOCKED', input.openBlockers === 0);
  push(
    'MONITORING_SETTLED',
    input.monitoring === null ||
      (input.monitoring.verdict !== 'INCONCLUSIVE' && input.monitoring.verdict !== 'IN_PROGRESS'),
  );
  push('COORDINATION_COMPLETE', input.coordinationComplete);

  const eligible = unmet.length === 0;
  let outcome: OperationalOutcome | null = null;
  if (eligible) {
    if (input.monitoring?.verdict === 'HELD') {
      outcome = 'RECOVERED';
      explanation.push('A success criterion committed to in advance was met on adequate evidence.');
    } else if (input.monitoring?.verdict === 'DID_NOT_HOLD') {
      outcome = 'NOT_RECOVERED';
      explanation.push('A failure criterion committed to in advance was met on adequate evidence.');
    } else {
      // Everything settled and nothing measured a recovery. Loop is not entitled
      // to call that a recovery, and NO_ACTION_NEEDED is the honest close.
      outcome = 'NO_ACTION_NEEDED';
      explanation.push('Everything is settled, and nothing measured a recovery either way.');
    }
  }

  return {
    ruleVersion: CASE_MONITORING_RULE_VERSION,
    eligible,
    met,
    unmet,
    outcome,
    explanation,
  };
}

// --- Log vocabulary ---------------------------------------------------------------------------

/**
 * Monitoring events, as governed types rather than prose.
 *
 * MONITORING_STARTED ENTERS `WATCHING`, the lane that already exists. That two
 * observation types can enter one lane is not a parallel system -- ASSIGNED and
 * REASSIGNED both set an assignee, and REOPENED and UNASSIGNED both return a
 * Case to review. The lane is one; the reasons for entering it are several, and
 * naming them is the point of a vocabulary.
 */
export const MONITORING_EVENTS = {
  STARTED: 'MONITORING_STARTED',
  /** The plan was corrected. The previous plan stays on the log, in full. */
  REVISED: 'MONITORING_REVISED',
  /** A verdict was reached. Does NOT close the Case; that is a separate act. */
  CONCLUDED: 'MONITORING_CONCLUDED',
} as const;

export const MONITORING_STARTED_REASON =
  'Loop is watching whether this held. What would count as it having held was written down ' +
  'before the answer was known.';

export const MONITORING_REVISED_REASON =
  'The monitoring plan was corrected. The previous plan is kept on this log in full.';

export const MONITORING_CONCLUDED_REASON =
  'The monitoring window reached a verdict. A verdict is what was observed, not why it happened.';

export const AUTO_RESOLVED_REASON =
  'Loop closed this because every condition it requires to close an investigation was met. ' +
  'The conditions it checked are recorded on this row.';
