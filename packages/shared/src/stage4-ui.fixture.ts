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
// `READINESS_OUTCOMES`, `FINDING_EVIDENCE_STATES` and the rest are imported and used, so a
// fixture cannot drift into describing a state the engines cannot produce.
//
// WHAT IT DELIBERATELY REFUSES TO SHOW. A confidence percentage, a causal claim,
// an escalation recipient, an executed sequence, revenue exposure. None of those
// exist in the backend, and a fixture that showed one would teach a surface to
// display something that will never arrive — which is the most expensive kind of
// design mistake, because it is only discovered after the screens are built.

import type {
  AttentionAssessment,
  BusinessDate,
  CaseCoordinationView,
  CaseFindingView,
  CaseOutcomeView,
  CoordinatedWork,
  FindingClaimKind,
  FindingEvidenceRef,
  FindingLineageEntry,
  FindingReasoning,
  FindingRecordFacts,
  MeasurementReadiness,
  MonitoringAssessment,
  MonitoringPlan,
  ObjectiveCoverage,
  PatternView,
  ProviderObservationStatus,
} from './index';
import { CASE_MONITORING_RULE_VERSION, CAUSAL_CAVEAT } from './case-monitoring';
import { ATTENTION_RULE_VERSION, assessAttention } from './attention-state';
import { CASE_COORDINATION_RULE_VERSION, WORK_OS_SYSTEM } from './case-work-coordination';
import { CASE_LEARNING_RULE_VERSION, LEARNING_REFUSALS } from './case-learning';
import { WORK_EXECUTION_RULE_VERSION } from './work-execution';
import { assessReadiness } from './measurement-readiness';
import { assessWindowObservation } from './provider-observation';
import {
  FINDING_CONTRADICTION_NONE,
  FINDING_ESTABLISHMENT_RULE_VERSION,
  FINDING_INELIGIBILITY_LABELS,
  FINDING_INFERENCE_UNAVAILABLE,
  assessFindingEstablishment,
  findEvidenceContradictions,
  findingEvidenceState,
  findingJudgment,
  findingLifecycle,
} from './case-finding';

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

// --- Findings: what the evidence supports, and separately what a person decided ---------

// THE VERDICTS ARE REAL. Nothing below hand-writes a `MeasurementReadiness` or an
// establishment: a two-day window goes through `assessReadiness`, the claim goes
// through `assessFindingEstablishment`, and the three axes come out of the same
// functions the service uses. A fixture that could say ESTABLISHED on its own
// say-so would be the one place in this file the gate did not apply.

const FINDING_DATES: BusinessDate[] = ['2026-08-24', '2026-08-25'];
const FINDING_CAMPAIGN = 'camp-cem-ssdi';

function findingReadiness(unobserved: BusinessDate | null): MeasurementReadiness {
  const byDate = new Map<BusinessDate, ProviderObservationStatus>();
  for (const d of FINDING_DATES) if (d !== unobserved) byDate.set(d, 'SUCCESS');
  return assessReadiness({
    metric: 'REVENUE',
    dates: FINDING_DATES,
    observation: assessWindowObservation(FINDING_DATES, byDate),
    partitions: [{ dimension: 'CAMPAIGN', memberExternalId: FINDING_CAMPAIGN, localCalls: 412 }],
    unattributedCalls: 0,
    reconciliation: FINDING_DATES.map((businessDate) => ({
      businessDate,
      state: 'RECONCILED',
      counts: {
        providerUnique: 206,
        providerDuplicateIds: 0,
        localUnique: 206,
        localDuplicateIds: 0,
        intersection: 206,
        providerOnly: 0,
        localOnly: 0,
        providerOnlyExpected: 0,
        providerOnlyNotConfigured: 0,
        providerOnlyExcluded: 0,
        providerOnlyUnknownMember: 0,
      },
      members: [
        {
          dimension: 'CAMPAIGN',
          memberExternalId: FINDING_CAMPAIGN,
          providerCount: 206,
          localCount: 206,
          providerOnly: 0,
          expectation: 'EXPECTED',
        },
      ],
      ruleVersion: 'provider-reconciliation.v1',
    })),
    authorities: [
      {
        dimension: 'CAMPAIGN',
        memberExternalId: FINDING_CAMPAIGN,
        metric: 'REVENUE',
        sourceKey: 'provider-calls',
        effectiveFrom: '2026-01-01',
        effectiveTo: null,
      },
    ],
    sources: [
      {
        key: 'provider-calls',
        kind: 'PROVIDER_STREAM',
        displayName: 'Call provider',
        supportedMetrics: ['CALL_VOLUME', 'REVENUE'],
        measureDefinitionIds: { CALL_VOLUME: 'calls.provider.v1', REVENUE: 'revenue.provider.v1' },
        provider: 'callgrid',
        stream: 'calls',
      },
    ],
    outcomeDays: [],
  });
}

/** A window every day of which was observed and reconciled. */
const FINDING_READY = findingReadiness(null);
/** The same window with its second day never observed. */
const FINDING_NOT_READY = findingReadiness('2026-08-25');

const FINDING_EVIDENCE: FindingEvidenceRef[] = [
  {
    id: 'ev_ssdi_revenue',
    source: 'commercial-intelligence',
    metricKey: 'REVENUE',
    window: '2026-08-24..2026-08-25',
    value: 18_420,
    completeness: 1,
  },
];

/** Nobody has judged it. */
const UNJUDGED: FindingRecordFacts = {
  status: 'PROPOSED',
  supersededById: null,
  acceptedBy: null,
  acceptedAt: null,
  rejectedBy: null,
  rejectedAt: null,
};
const ACCEPTED_BY_LEXI: FindingRecordFacts = {
  ...UNJUDGED,
  status: 'ACCEPTED',
  acceptedBy: 'user_lexi',
  acceptedAt: '2026-08-26T14:05:00.000Z',
};
const REJECTED_BY_CHARLIE: FindingRecordFacts = {
  ...UNJUDGED,
  status: 'REJECTED',
  rejectedBy: 'user_charlie',
  rejectedAt: '2026-08-26T15:40:00.000Z',
};

function findingView(input: {
  id: string;
  claim: string;
  conclusion: string | null;
  claimKind: FindingClaimKind;
  facts: FindingRecordFacts;
  readiness: MeasurementReadiness;
  lineage?: FindingLineageEntry[];
}): CaseFindingView {
  const lifecycle = findingLifecycle(input.facts);
  const current = lifecycle === 'CURRENT';
  const contradicting = findEvidenceContradictions(FINDING_EVIDENCE);
  const establishment = assessFindingEstablishment({
    claimKind: input.claimKind,
    current,
    // As the service does it: only a current, measurement-backed claim is ever
    // put in front of a Stage 3 verdict.
    readiness: input.claimKind === 'MEASUREMENT_BACKED' && current ? input.readiness : null,
    supporting: FINDING_EVIDENCE,
    contradicting,
  });
  const missing = current ? establishment.reasons.map((r) => FINDING_INELIGIBILITY_LABELS[r]) : [];
  const reasoning: FindingReasoning = {
    known: FINDING_EVIDENCE.map((e) => ({ text: `${e.metricKey} (${e.window})`, evidenceId: e.id })),
    inferred: [],
    missing,
    contradictory: contradicting,
    unavailable: {
      INFERRED: FINDING_INFERENCE_UNAVAILABLE,
      ...(contradicting.length === 0 ? { CONTRADICTORY: FINDING_CONTRADICTION_NONE } : {}),
      ...(missing.length === 0
        ? { MISSING: 'Nothing is currently standing between this finding and its evidence.' }
        : {}),
    },
  };
  return {
    findingId: input.id,
    caseId: 'case_ssdi_revenue',
    claim: input.claim,
    conclusion: input.conclusion,
    claimKind: input.claimKind,
    generatedBy: 'DETERMINISTIC_RULE',
    evidenceState: findingEvidenceState(establishment),
    judgment: findingJudgment(input.facts),
    lifecycle,
    establishment,
    reasoning,
    supporting: FINDING_EVIDENCE,
    createdAt: '2026-08-26T09:00:00.000Z',
    supportingWindowStart: '2026-08-24T04:00:00.000Z',
    supportingWindowEnd: '2026-08-26T04:00:00.000Z',
    ruleVersion: FINDING_ESTABLISHMENT_RULE_VERSION,
    lineage: input.lineage ?? [],
  };
}

const SSDI_CLAIM = 'SSDI revenue per call fell over the two days after one buyer stopped settling.';

/** The evidence establishes it, and a person agreed. Two facts, not one. */
export const FINDING_ESTABLISHED_ACCEPTED: CaseFindingView = findingView({
  id: 'fnd_ssdi_established_accepted',
  claim: SSDI_CLAIM,
  conclusion: null,
  claimKind: 'MEASUREMENT_BACKED',
  facts: ACCEPTED_BY_LEXI,
  readiness: FINDING_READY,
});

/**
 * The evidence establishes it, and a person rejected it. STILL ESTABLISHED:
 * disagreeing with a claim does not weaken the evidence under it.
 */
export const FINDING_ESTABLISHED_REJECTED: CaseFindingView = findingView({
  id: 'fnd_ssdi_established_rejected',
  claim: SSDI_CLAIM,
  conclusion: null,
  claimKind: 'MEASUREMENT_BACKED',
  facts: REJECTED_BY_CHARLIE,
  readiness: FINDING_READY,
});

/**
 * A person accepted a claim there is no governed standard to establish. STILL
 * DEVELOPING, and the refusal says why: acceptance is a judgment, not evidence.
 */
export const FINDING_DEVELOPING_ACCEPTED: CaseFindingView = findingView({
  id: 'fnd_buyer_relationship_accepted',
  claim: 'The buyer is deprioritizing SSDI volume ahead of a contract renegotiation.',
  conclusion: null,
  claimKind: 'NON_MEASUREMENT',
  facts: ACCEPTED_BY_LEXI,
  readiness: FINDING_READY,
});

/**
 * Part of the window was never observed, and a person rejected the claim. The
 * two are independent: it would be developing whatever anybody decided, and it
 * still carries the superseded claim it replaced, with that claim's own judgment.
 */
export const FINDING_DEVELOPING_REJECTED: CaseFindingView = findingView({
  id: 'fnd_ssdi_developing_rejected',
  claim: SSDI_CLAIM,
  conclusion: null,
  claimKind: 'MEASUREMENT_BACKED',
  facts: REJECTED_BY_CHARLIE,
  readiness: FINDING_NOT_READY,
  lineage: [
    {
      findingId: 'fnd_ssdi_first_reading',
      claim: 'SSDI revenue per call fell because answer rates dropped.',
      conclusion: null,
      lifecycle: findingLifecycle({ ...ACCEPTED_BY_LEXI, supersededById: 'fnd_ssdi_developing_rejected' }),
      judgment: findingJudgment({ ...ACCEPTED_BY_LEXI, supersededById: 'fnd_ssdi_developing_rejected' }),
      generatedBy: 'DETERMINISTIC_RULE',
      createdAt: '2026-08-25T09:00:00.000Z',
      supersededById: 'fnd_ssdi_developing_rejected',
    },
  ],
});

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
  'Finding · established, and a person accepted it': FINDING_ESTABLISHED_ACCEPTED,
  'Finding · established, and a person rejected it': FINDING_ESTABLISHED_REJECTED,
  'Finding · developing, and a person accepted it': FINDING_DEVELOPING_ACCEPTED,
  'Finding · developing, and a person rejected it': FINDING_DEVELOPING_REJECTED,
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
  findingEstablishment: FINDING_ESTABLISHMENT_RULE_VERSION,
} as const;
