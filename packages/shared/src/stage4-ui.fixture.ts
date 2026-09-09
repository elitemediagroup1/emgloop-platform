// The Stage 4 product states a surface has to render well — several of which are
// reachable only when something is wrong.
//
// WHY THIS EXISTS, AND WHY IT IS NOT A SECOND DOMAIN MODEL. `product-states.fixture.ts`
// already carries the Stage 1-3 states for exactly this reason, and this is its
// Stage 4 half: attention, coordination, monitoring, outcome, learning. Every
// value is typed as the contract production returns, so a contract change stops
// this file compiling. A fixture layer earns its keep only while it is the same
// shape production produces.
//
// NOTHING HERE IS PRODUCTION DATA, AND NOTHING PRODUCTION IMPORTS IT. The
// organizations, buyers and people are invented and the numbers are
// illustrative. A test asserts no production module reaches it.
//
// EVERY GOVERNED VALUE IS A REAL SHIPPED VOCABULARY MEMBER. Not a string that
// looks like one. `SLA_STATES`, `MONITORING_VERDICTS`, `ATTENTION_STATES`,
// `READINESS_OUTCOMES`, `FINDING_STATES` and the rest are imported and used, so a
// fixture cannot drift into describing a state the engines cannot produce.
//
// WHAT IT DELIBERATELY REFUSES TO SHOW. A confidence percentage, a causal claim,
// an escalation recipient, an executed sequence, revenue exposure. None of those
// exist in the backend, and a fixture that showed one would teach a surface to
// display something that will never arrive — which is the most expensive kind of
// design mistake, because it is only discovered after the screens are built.

import type {
  AttentionAssessment,
  CaseCoordinationView,
  CaseOutcomeView,
  CoordinatedWork,
  MonitoringAssessment,
  MonitoringPlan,
  ObjectiveCoverage,
  PatternView,
} from './index';
import { CASE_MONITORING_RULE_VERSION, CAUSAL_CAVEAT } from './case-monitoring';
import { ATTENTION_RULE_VERSION, assessAttention } from './attention-state';
import { CASE_COORDINATION_RULE_VERSION, WORK_OS_SYSTEM } from './case-work-coordination';
import { CASE_LEARNING_RULE_VERSION, LEARNING_REFUSALS } from './case-learning';
import { WORK_EXECUTION_RULE_VERSION } from './work-execution';

// --- Objective coverage, the input an all-clear is earned from -----------------------

const OBJECTIVES: Record<string, ObjectiveCoverage> = {
  medicare: {
    performanceObjectiveId: 'obj_medicare',
    objectiveTitle: 'Grow Medicare answer rate',
    readiness: 'READY',
    withholdings: [],
  },
  aca: {
    performanceObjectiveId: 'obj_aca',
    objectiveTitle: 'Grow ACA enrolments',
    readiness: 'READY',
    withholdings: [],
  },
  pest: {
    performanceObjectiveId: 'obj_pest',
    objectiveTitle: 'Hold Pest Control monetized rate',
    readiness: 'READY',
    withholdings: [],
  },
  // The three that cannot be measured, each for a DIFFERENT reason — because the
  // whole product point is that "waiting", "not set up" and "the evidence
  // disagrees" lead to three different next moves.
  ssdiWaiting: {
    performanceObjectiveId: 'obj_ssdi',
    objectiveTitle: 'Grow SSDI revenue per call',
    readiness: 'NOT_READY',
    withholdings: ['AUTHORITATIVE_DATA_PENDING'],
  },
  autoUnconfigured: {
    performanceObjectiveId: 'obj_auto',
    objectiveTitle: 'Grow Auto Insurance volume',
    readiness: 'CONFIG_ERROR',
    withholdings: ['SOURCE_AUTHORITY_MISSING'],
  },
  homeConflicted: {
    performanceObjectiveId: 'obj_home',
    objectiveTitle: 'Hold Home Services acceptance',
    readiness: 'INCONCLUSIVE',
    withholdings: ['RECONCILIATION_INCONCLUSIVE', 'SOURCE_AUTHORITY_CONFLICT'],
  },
};

// --- Attention: the four states a morning can be in ------------------------------------

/**
 * A GENUINE all-clear. Six objectives, every one measurable, nothing raised.
 *
 * PRODUCED BY THE REAL ASSESSOR, not hand-written. A hand-written all-clear
 * could claim a state the rule would never produce, which is the one thing a
 * fixture for this particular contract must not be able to do.
 */
export const MORNING_ALL_CLEAR: AttentionAssessment = assessAttention({
  objectives: [OBJECTIVES.medicare!, OBJECTIVES.aca!, OBJECTIVES.pest!],
  headlineCount: 0,
});

/** Nothing raised — and Loop could not see half of what it watches. */
export const MORNING_CANT_TELL: AttentionAssessment = assessAttention({
  objectives: [
    OBJECTIVES.medicare!,
    OBJECTIVES.aca!,
    OBJECTIVES.pest!,
    OBJECTIVES.ssdiWaiting!,
    OBJECTIVES.autoUnconfigured!,
    OBJECTIVES.homeConflicted!,
  ],
  headlineCount: 0,
});

/** Something is on the list, and two objectives still went unmeasured. */
export const MORNING_NEEDS_ATTENTION: AttentionAssessment = assessAttention({
  objectives: [OBJECTIVES.medicare!, OBJECTIVES.pest!, OBJECTIVES.ssdiWaiting!, OBJECTIVES.autoUnconfigured!],
  headlineCount: 3,
});

/** Nobody has told Loop what to watch. NOT a healthy morning. */
export const MORNING_NOTHING_TO_CHECK: AttentionAssessment = assessAttention({
  objectives: [],
  headlineCount: 0,
});

// --- Work coordination -------------------------------------------------------------------

function work(over: Partial<CoordinatedWork> & { id: string }): CoordinatedWork {
  return {
    system: WORK_OS_SYSTEM,
    type: 'work_instance',
    recordedAt: '2026-08-23T15:04:00.000Z',
    observationId: 'obs_work_' + over.id,
    workStatus: 'active',
    execution: null,
    blockers: [],
    unknown: null,
    ...over,
  };
}

const EXEC_BASE = {
  workStageId: 'ws_1',
  stageName: 'Contact CEM about the settlement change',
  ownerUserId: 'usr_mike',
  actionable: true,
  overdue: null,
  waiting: null,
  reminderEligible: false,
  escalationEligible: false,
  // NULL, ALWAYS. There is no reporting relationship in this platform, and a
  // fixture naming a manager would design a screen that can never be truthful.
  escalationDestinationUserId: null,
  extensions: 0,
  durations: {
    actionableMs: 4 * 3_600_000,
    waitingInternalMs: 0,
    waitingExternalMs: 0,
    blockedMs: 0,
    elapsedToCompletionMs: null,
  },
} as const;

/** Somebody is working on it, inside policy. The ordinary case. */
export const WORK_IN_PROGRESS: CaseCoordinationView = {
  ruleVersion: CASE_COORDINATION_RULE_VERSION,
  caseId: 'case_cem',
  asks: [
    {
      userId: 'usr_charlie',
      contribution: 'DECIDE',
      request: 'Decide whether to move volume while the cause is established.',
      active: true,
      askedAt: '2026-08-23T14:30:00.000Z',
    },
    {
      userId: 'usr_matt',
      contribution: 'INVESTIGATE',
      request: 'Work out whether the settlement drop is CEM-wide or source-specific.',
      active: true,
      askedAt: '2026-08-23T14:31:00.000Z',
    },
    {
      userId: 'usr_mike',
      contribution: 'RELATIONSHIP',
      request: 'Ask CEM directly whether their qualification changed.',
      active: true,
      askedAt: '2026-08-23T14:33:00.000Z',
    },
  ],
  work: [work({ id: 'a', execution: { ...EXEC_BASE, state: 'in_progress', sla: 'WITHIN_POLICY', dueAt: '2026-08-25T20:00:00.000Z', explanation: ['Actionable for 4 hours.'] } })],
  notKnown: [],
};

/** Blocked on something outside, with an expected resolution. */
export const WORK_BLOCKED: CaseCoordinationView = {
  ...WORK_IN_PROGRESS,
  work: [
    work({
      id: 'a',
      execution: {
        ...EXEC_BASE,
        state: 'blocked',
        actionable: false,
        sla: 'PAUSED_WAITING',
        dueAt: '2026-08-25T20:00:00.000Z',
        waiting: {
          reason: 'AWAITING_DEPENDENCY',
          subject: "CEM's next-day settlement sheet",
          expectedResolutionAt: '2026-08-25T13:00:00.000Z',
        },
        durations: { ...EXEC_BASE.durations, actionableMs: 2 * 3_600_000, blockedMs: 26 * 3_600_000 },
        explanation: [
          'Blocked on one thing that has to resolve first.',
          'The accountability clock is paused, and the 2 hours already spent actionable is kept.',
        ],
      },
      blockers: [
        {
          id: 'dep_1',
          kind: 'EXTERNAL_CONDITION',
          description: "Waiting for CEM's next-day settlement sheet.",
          expectedResolutionAt: '2026-08-25T13:00:00.000Z',
          dependsOnWorkInstanceId: null,
        },
      ],
    }),
  ],
};

/**
 * Actionable for over a day. Escalation-eligible, with NO destination.
 *
 * THE FIXTURE THE ESCALATION SCREEN HAS TO BE BUILT AGAINST. A design that
 * assumed a recipient would be un-shippable, and this is where that is found
 * out — at design time rather than after the screens exist.
 */
export const WORK_ESCALATION_ELIGIBLE: CaseCoordinationView = {
  ...WORK_IN_PROGRESS,
  work: [
    work({
      id: 'a',
      execution: {
        ...EXEC_BASE,
        state: 'ready',
        sla: 'ESCALATION_ELIGIBLE',
        dueAt: '2026-08-24T20:00:00.000Z',
        overdue: true,
        reminderEligible: true,
        escalationEligible: true,
        extensions: 2,
        durations: { ...EXEC_BASE.durations, actionableMs: 27 * 3_600_000 },
        explanation: [
          'Actionable for 27 hours and still unresolved, past the 24-hour escalation threshold.',
          'Loop can tell that this is eligible for escalation, but not who it should go to: this platform has no reporting relationship between people. A role is a permission level, not a manager.',
          'It is also past the time it was expected to be done.',
          'Its expected time has been moved 2 times.',
        ],
      },
    }),
  ],
};

/**
 * Work created before the execution foundation existed. UNKNOWN, not on track.
 *
 * The most likely real state on the first day this ships, and the one a UI is
 * most tempted to render as fine.
 */
export const WORK_NOT_MEASURED: CaseCoordinationView = {
  ...WORK_IN_PROGRESS,
  work: [
    work({
      id: 'a',
      execution: {
        ...EXEC_BASE,
        state: 'ready',
        sla: 'UNKNOWN',
        dueAt: null,
        durations: { actionableMs: 0, waitingInternalMs: 0, waitingExternalMs: 0, blockedMs: 0, elapsedToCompletionMs: null },
        explanation: ['Loop cannot say whether this is on track: no execution history has been recorded for it.'],
      },
      unknown: 'NOT_MEASURED',
    }),
  ],
  notKnown: [
    'Loop has no execution history for this work, so it cannot say whether it is on track.',
  ],
};

/** The reference points at work that no longer resolves. */
export const WORK_REFERENCE_DANGLING: CaseCoordinationView = {
  ...WORK_IN_PROGRESS,
  work: [work({ id: 'gone', workStatus: null, unknown: 'WORK_NOT_FOUND' })],
  notKnown: ['Loop cannot find the work this Case pointed at.'],
};

// --- Monitoring ----------------------------------------------------------------------------

export const MONITORING_PLAN: MonitoringPlan = {
  condition: "Buyer CEM's monetized rate",
  baseline: { metric: 'MONETIZED_RATE', value: 0.597, unit: 'RATIO', denominator: 2996 },
  success: {
    metric: 'MONETIZED_RATE',
    comparison: 'WITHIN_PERCENT_OF_BASELINE',
    threshold: 0.05,
    statement: 'Monetized rate returned to within 5% of baseline during the window.',
  },
  failure: {
    metric: 'MONETIZED_RATE',
    comparison: 'AT_OR_BELOW',
    threshold: 0.35,
    statement: 'Monetized rate fell to or below 35% during the window.',
  },
  observationStart: '2026-08-25T04:00:00.000Z',
  observationEnd: '2026-09-01T04:00:00.000Z',
  requires: { minimumObservations: 200, minimumCoverage: 0.95, requiresCompleteWindow: true },
  plannedByUserId: 'usr_charlie',
  plannedAt: '2026-08-24T16:20:00.000Z',
  note: 'Watching whether settlement recovers after the buyer conversation.',
};

/**
 * The window is over and Loop still cannot judge it.
 *
 * THE DEFAULT STATE TODAY, because the measurement seam is unwired. A screen
 * that renders this as anything resembling success is a screen that will lie on
 * its first day in production.
 */
export const MONITORING_INCONCLUSIVE: MonitoringAssessment = {
  ruleVersion: CASE_MONITORING_RULE_VERSION,
  verdict: 'INCONCLUSIVE',
  insufficiency: 'NO_MEASUREMENT_AT_ALL',
  measured: null,
  explanation: ['Nothing was measured in this window.'],
  evidenceIds: [],
};

export const MONITORING_HELD: MonitoringAssessment = {
  ruleVersion: CASE_MONITORING_RULE_VERSION,
  verdict: 'HELD',
  insufficiency: null,
  measured: {
    metric: 'MONETIZED_RATE',
    value: 0.581,
    unit: 'RATIO',
    denominator: 3104,
    coverage: 0.98,
    observationCount: 3104,
    evidenceIds: ['ev_monitor_1'],
  },
  explanation: [
    'Measured 0.581 RATIO over 3104 observations.',
    'Monetized rate returned to within 5% of baseline during the window.',
  ],
  evidenceIds: ['ev_monitor_1'],
};

export const MONITORING_IN_PROGRESS: MonitoringAssessment = {
  ruleVersion: CASE_MONITORING_RULE_VERSION,
  verdict: 'IN_PROGRESS',
  insufficiency: null,
  measured: null,
  explanation: ['The observation window has not finished, and this monitor waits for it.'],
  evidenceIds: [],
};

// --- Outcome ---------------------------------------------------------------------------------

/**
 * Recovery observed. Causation NOT established, and the caveat is the product.
 *
 * `causalClaim` is null in every outcome fixture, because it is null in every
 * outcome the backend can produce. A fixture with a filled-in cause would be
 * designing a screen for a Loop that does not exist.
 */
export const OUTCOME_RECOVERED_NO_CAUSE: CaseOutcomeView = {
  ruleVersion: CASE_MONITORING_RULE_VERSION,
  caseId: 'case_cem',
  outcome: 'RECOVERED',
  measuredEffectCents: 41_200_00,
  measuredEffectBasis: 'Difference in settled revenue over the monitoring window against the prior window.',
  statement: 'The condition being watched met its success criterion between 2026-08-25T04:00:00.000Z and 2026-09-01T04:00:00.000Z.',
  causalClaim: null,
  causalCaveat: CAUSAL_CAVEAT,
  lineage: {
    findingId: 'fnd_cem_qualification',
    recommendationDecisionIds: ['dec_protect', 'dec_learn', 'dec_relationship'],
    selectedRecommendationDecisionId: 'dec_relationship',
    workReferences: [{ system: WORK_OS_SYSTEM, id: 'wi_contact_cem' }],
    monitoringWindow: { start: '2026-08-25T04:00:00.000Z', end: '2026-09-01T04:00:00.000Z' },
    monitoringVerdict: 'HELD',
    evidenceIds: ['ev_monitor_1'],
    observationId: 'obs_outcome_1',
  },
  notEstablished: [],
};

/** Closed, and Loop could establish very little about what happened. */
export const OUTCOME_UNESTABLISHED: CaseOutcomeView = {
  ...OUTCOME_RECOVERED_NO_CAUSE,
  outcome: null,
  measuredEffectCents: null,
  measuredEffectBasis: null,
  statement: 'Loop could not establish what happened between 2026-08-25T04:00:00.000Z and 2026-09-01T04:00:00.000Z.',
  lineage: { ...OUTCOME_RECOVERED_NO_CAUSE.lineage, monitoringVerdict: 'INCONCLUSIVE', evidenceIds: [] },
  notEstablished: [
    'Monitoring could not establish what happened over its window.',
    'No established finding stands behind this outcome.',
  ],
};

// --- Learning ---------------------------------------------------------------------------------

/** One Case. An observation, and it says so. */
export const PATTERN_OBSERVATION: PatternView = {
  ruleVersion: CASE_LEARNING_RULE_VERSION,
  subject: 'headline:hl_cem_monetized',
  maturity: 'OBSERVATION',
  caseIds: ['case_cem'],
  chosen: [{ optionKey: 'relationship-first', count: 1 }],
  followedByRecovery: [{ optionKey: 'relationship-first', count: 1, ofMonitored: 1 }],
  cannotConclude: [LEARNING_REFUSALS.CAUSE, LEARNING_REFUSALS.PREFERENCE, LEARNING_REFUSALS.SMALL_N, LEARNING_REFUSALS.PROMOTION],
  explanation: ['1 comparable Case; 3 are needed before this is worth a person looking at.'],
};

/** Four comparable Cases. Worth a look — and still not doctrine. */
export const PATTERN_EMERGING: PatternView = {
  ruleVersion: CASE_LEARNING_RULE_VERSION,
  subject: 'headline:hl_buyer_settlement',
  maturity: 'EMERGING_PATTERN',
  caseIds: ['case_cem', 'case_apex', 'case_northwind', 'case_meridian'],
  chosen: [
    { optionKey: 'relationship-first', count: 3 },
    { optionKey: 'protect-revenue', count: 1 },
  ],
  followedByRecovery: [
    { optionKey: 'relationship-first', count: 2, ofMonitored: 2 },
    { optionKey: 'protect-revenue', count: 0, ofMonitored: 1 },
  ],
  cannotConclude: [
    LEARNING_REFUSALS.CAUSE,
    LEARNING_REFUSALS.PREFERENCE,
    LEARNING_REFUSALS.UNMEASURED,
    LEARNING_REFUSALS.PROMOTION,
  ],
  explanation: [
    '1 of 4 comparable Cases were never monitored.',
    '4 comparable Cases. Worth a person looking at; not yet how EMG operates.',
  ],
};

// --- The catalogue --------------------------------------------------------------------------

/**
 * Every Stage 4 state a surface must render, in one list.
 *
 * NAMED BY WHAT THEY MEAN TO A PERSON, not by their governed value, because the
 * reader of this list is a designer choosing which screen to look at.
 */
export const STAGE4_UI_STATES = {
  'Morning · all clear': MORNING_ALL_CLEAR,
  "Morning · can't tell": MORNING_CANT_TELL,
  'Morning · needs attention': MORNING_NEEDS_ATTENTION,
  'Morning · nothing to check': MORNING_NOTHING_TO_CHECK,
  'Work · in progress': WORK_IN_PROGRESS,
  'Work · blocked': WORK_BLOCKED,
  'Work · escalation eligible, no recipient': WORK_ESCALATION_ELIGIBLE,
  'Work · never measured': WORK_NOT_MEASURED,
  'Work · reference no longer resolves': WORK_REFERENCE_DANGLING,
  'Monitoring · inconclusive': MONITORING_INCONCLUSIVE,
  'Monitoring · held': MONITORING_HELD,
  'Monitoring · still running': MONITORING_IN_PROGRESS,
  'Outcome · recovered, cause not established': OUTCOME_RECOVERED_NO_CAUSE,
  'Outcome · nothing established': OUTCOME_UNESTABLISHED,
  'Learning · one observation': PATTERN_OBSERVATION,
  'Learning · emerging pattern': PATTERN_EMERGING,
} as const;

/** The rule versions these fixtures were written against. */
export const STAGE4_FIXTURE_RULE_VERSIONS = {
  attention: ATTENTION_RULE_VERSION,
  coordination: CASE_COORDINATION_RULE_VERSION,
  monitoring: CASE_MONITORING_RULE_VERSION,
  learning: CASE_LEARNING_RULE_VERSION,
  execution: WORK_EXECUTION_RULE_VERSION,
} as const;
