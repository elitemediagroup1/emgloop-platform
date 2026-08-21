// Representative PRODUCT STATES, for designing and building surfaces against.
//
// WHY THIS EXISTS. Every state a Loop surface has to render well is reachable in
// production, and several of the most important ones are reachable only during an
// incident. Nobody should have to wait for a provider outage to find out what a
// withheld metric looks like, and nobody should build the withheld case by
// guessing at its shape.
//
// IT IS NOT A SECOND DOMAIN MODEL, AND THAT IS THE WHOLE CONSTRAINT. Every value
// below is typed as the contract the real code produces -- `HeadlineView`,
// `MaterialityWithholding`, `ReconciliationState`, `CoverageHealthStatus`,
// `ObservationSource`, `FactConvergenceDecision`. If one of those contracts
// changes shape, this file stops compiling, which is the point. A surface built
// against these fixtures is built against the real contract.
//
// NOTHING HERE IS PRODUCTION DATA. The organizations, buyers and campaigns are
// invented, the numbers are illustrative, and nothing in this file is imported by
// any production code path. It is a design and test aid.
//
// WHAT IT DELIBERATELY DOES NOT DO. It does not fabricate a briefing narrative,
// a confidence score or a recommendation Loop cannot currently produce. Where a
// state's honest content is "Loop does not know", the fixture says that, because
// a fixture that renders better than production teaches a surface to display
// something that will never arrive.

import {
  NOT_MEASURABLE_AWAITING_DATA,
  NOT_MEASURABLE_INCOMPLETE_DATA,
  type MaterialityWithholding,
  type MeasureMovement,
} from './commercial-measurement';
import type { FactConvergenceDecision } from './provider-fact-convergence';
import type { CoverageHealthStatus } from './coverage-health';
import type { HeadlineView } from './headline';
import type { ObservationSource } from './observation-source';
import type { PriorityState } from './operational-lifecycle';
import type { ReconciliationState } from './provider-reconciliation';

/** The ten states a Loop surface must render well. Named, so a review can ask for one. */
export const PRODUCT_STATES = [
  'HEALTHY_KNOWN_METRIC',
  'WITHHELD_METRIC',
  'INCOMPLETE_CAPTURE',
  'PROVIDER_FACT_CONFLICT',
  'UNKNOWN_FACT',
  'HIGH_PRIORITY_ATTENTION',
  'INFORMATIONAL_ATTENTION',
  'ACTION_AWAITING_APPROVAL',
  'RECOVERY_ISSUE',
  'NOTHING_NEEDS_ATTENTION',
] as const;

export type ProductState = (typeof PRODUCT_STATES)[number];

// --- Shared scaffolding ---------------------------------------------------------

const WINDOW = {
  currentWindowStart: '2026-08-15T04:00:00.000Z',
  currentWindowEnd: '2026-08-22T04:00:00.000Z',
  priorWindowStart: '2026-08-08T04:00:00.000Z',
  priorWindowEnd: '2026-08-15T04:00:00.000Z',
  comparisonBasis: 'Trailing 7 complete Eastern business days against the 7 before them.',
};

function headline(over: {
  id: string;
  objectiveTitle: string;
  metric: HeadlineView['measurement']['metric'];
  metricLabel: string;
  unit: HeadlineView['measurement']['unit'];
  movement: MeasureMovement;
  againstObjective: boolean;
  currentValue: number | null;
  priorValue: number | null;
  absoluteChange: number | null;
  percentageChange: number | null;
  currentDenominator: number;
  priorDenominator: number;
  currentCoverage: number | null;
  priorCoverage: number | null;
  statement: string;
  limitations: string[];
  unknowns: string[];
  detectionCount: number;
  dismissed?: { basis: HeadlineView['dismissalBasis']; byName: string };
}): HeadlineView {
  return {
    id: over.id,
    performanceObjectiveId: 'obj_fixture',
    objectiveTitle: over.objectiveTitle,
    measureBindingId: 'bind_fixture',
    measureBindingVersion: 3,
    measurement: {
      metric: over.metric,
      metricLabel: over.metricLabel,
      unit: over.unit,
      movement: over.movement,
      againstObjective: over.againstObjective,
      currentValue: over.currentValue,
      priorValue: over.priorValue,
      absoluteChange: over.absoluteChange,
      percentageChange: over.percentageChange,
      currentDenominator: over.currentDenominator,
      priorDenominator: over.priorDenominator,
      currentCoverage: over.currentCoverage,
      priorCoverage: over.priorCoverage,
      ...WINDOW,
    },
    statement: over.statement,
    limitations: over.limitations,
    unknowns: over.unknowns,
    ruleId: 'ci.objective-measure-change',
    ruleVersion: 'v1',
    producerVersion: 'ci-headline.v1',
    ruleDescription: 'A move of at least 15% over at least 200 calls in each window.',
    firstDetectedAt: '2026-08-20T11:02:00.000Z',
    lastDetectedAt: '2026-08-22T06:15:00.000Z',
    detectionCount: over.detectionCount,
    dismissedAt: over.dismissed ? '2026-08-22T09:40:00.000Z' : null,
    dismissedByUserId: over.dismissed ? 'usr_fixture' : null,
    dismissedByName: over.dismissed ? over.dismissed.byName : null,
    dismissalBasis: over.dismissed ? over.dismissed.basis : null,
    createdAt: '2026-08-20T11:02:00.000Z',
  };
}

// --- 1. A healthy, known metric ---------------------------------------------------

/**
 * Everything resolved. The number is real, the coverage is high, and the move is
 * large enough that the rule fired.
 *
 * NOTE WHAT IS STILL PRESENT: `limitations` is not empty. A measurement that
 * knows its own value still carries what it could not account for, and a surface
 * that only shows caveats when something is wrong trains people to read their
 * absence as certainty.
 */
export const HEALTHY_KNOWN_METRIC: HeadlineView = headline({
  id: 'hl_healthy',
  objectiveTitle: 'Grow Medicare answer rate',
  metric: 'MONETIZED_RATE',
  metricLabel: 'Monetized rate',
  unit: 'RATIO',
  movement: 'DECREASE',
  againstObjective: true,
  currentValue: 0.412,
  priorValue: 0.597,
  absoluteChange: -0.185,
  percentageChange: -0.31,
  currentDenominator: 3184,
  priorDenominator: 2996,
  currentCoverage: 0.98,
  priorCoverage: 0.99,
  statement: "Buyer CEM's monetized rate fell from 59.7% to 41.2% over the last 7 business days.",
  limitations: [
    'Postback destinations settle after the call, so the most recent day may still move.',
  ],
  unknowns: ['2% of calls in the current window carry no billable answer yet.'],
  detectionCount: 3,
});

// --- 2. A withheld metric ---------------------------------------------------------

/**
 * The measurement could not be made, and the reason is a named member of the
 * shipped vocabulary rather than a message.
 *
 * A WITHHELD METRIC IS A FIRST-CLASS PRODUCT STATE, not an error and not an empty
 * cell. It has a subject, a period, a reason, and something a person can do.
 */
export interface WithheldMetricState {
  objectiveTitle: string;
  metricLabel: string;
  businessDate: string;
  /** The shipped reason. A surface should render its label, never invent prose. */
  withheld: MaterialityWithholding;
  /** The display string the contract already defines for this class of withholding. */
  displayValue: string;
  /** What the surface should offer. Comes from MATERIALITY_WITHHOLDING_NEXT_ACTIONS. */
  nextActionKey: MaterialityWithholding;
}

export const WITHHELD_METRIC: WithheldMetricState = {
  objectiveTitle: 'Pest Control revenue',
  metricLabel: 'Revenue',
  businessDate: '2026-08-12',
  withheld: 'SOURCE_AUTHORITY_MISSING',
  displayValue: NOT_MEASURABLE_INCOMPLETE_DATA,
  nextActionKey: 'SOURCE_AUTHORITY_MISSING',
};

/** The other withholding shape: the data is coming, it just is not here yet. */
export const WITHHELD_METRIC_AWAITING: WithheldMetricState = {
  objectiveTitle: 'SSDI revenue',
  metricLabel: 'Revenue',
  businessDate: '2026-08-21',
  withheld: 'AUTHORITATIVE_DATA_PENDING',
  displayValue: NOT_MEASURABLE_AWAITING_DATA,
  nextActionKey: 'AUTHORITATIVE_DATA_PENDING',
};

// --- 3. Incomplete capture ---------------------------------------------------------

/**
 * The provider read did not complete, so the population is a LOWER BOUND.
 *
 * The trap this fixture exists to prevent: the counts can look reasonable. A
 * surface that renders them without the state renders a number that is quietly
 * wrong in one direction, and INCONCLUSIVE is the only honest headline.
 */
export interface CaptureState {
  businessDate: string;
  reconciliation: ReconciliationState;
  providerRecords: number;
  capturedRecords: number;
  projectedRecords: number;
  /** True when providerRecords is a floor rather than the population. */
  providerIsLowerBound: boolean;
  reason: string;
}

export const INCOMPLETE_CAPTURE: CaptureState = {
  businessDate: '2026-08-12',
  reconciliation: 'INCONCLUSIVE',
  providerRecords: 2500,
  capturedRecords: 2500,
  projectedRecords: 2500,
  providerIsLowerBound: true,
  reason:
    'The provider read stopped at its page budget while CallGrid still had pages. ' +
    'Everything below is a lower bound and nothing can be concluded from it.',
};

/** A gap that IS bounded and knowable: records expected, records absent. */
export const RECOVERY_ISSUE: CaptureState = {
  businessDate: '2026-08-11',
  reconciliation: 'UNRECONCILED',
  providerRecords: 9389,
  capturedRecords: 0,
  projectedRecords: 0,
  providerIsLowerBound: false,
  reason:
    'CallGrid holds 9,389 calls for this date and Loop captured none of them. ' +
    'Every absent record belongs to a campaign a person declared should deliver.',
};

/** The third reconciliation shape: absences nobody has declared either way. */
export const UNDECLARED_GAP: CaptureState = {
  businessDate: '2026-08-05',
  reconciliation: 'UNKNOWN_EXPECTATION',
  providerRecords: 974,
  capturedRecords: 867,
  projectedRecords: 867,
  providerIsLowerBound: false,
  reason:
    '107 records did not arrive. 9 belong to campaigns with no webhook attached and ' +
    'could not have arrived; nobody has declared whether the rest were expected to.',
};

// --- 4. A provider fact conflict ----------------------------------------------------

/**
 * Two settled provider values disagree about one call's money.
 *
 * NOTHING WAS OVERWRITTEN. The canonical value did not move, the disagreement is
 * recorded, and the resolution is a person's. A surface must not pick a side, and
 * must not hide the conflict behind whichever number it happened to load.
 */
export interface FactConflictState {
  /** A stable, non-reversible handle. The raw provider identity is not displayed. */
  identityDigest: string;
  fact: string;
  decision: FactConvergenceDecision;
  /** What Loop holds. Unchanged by the conflict. */
  storedValue: string;
  /** What the provider said this time. Recorded, not applied. */
  observedValue: string;
  observedVia: ObservationSource;
  observedAt: string;
  /** Null means the canonical value did NOT move. That is the meaning of a conflict. */
  appliedAt: string | null;
  reason: string;
}

export const PROVIDER_FACT_CONFLICT: FactConflictState = {
  identityDigest: 'a3f19c04b7d2',
  fact: 'revenue',
  decision: 'CONFLICT',
  storedValue: '1700',
  observedValue: '1500',
  observedVia: 'API_POLL',
  observedAt: '2026-08-21T14:22:00.000Z',
  appliedAt: null,
  reason: 'Two settled amounts disagree. A correction and a defect are indistinguishable from here.',
};

// --- 5. An unknown fact --------------------------------------------------------------

/**
 * The provider has not said, and its way of saying "not yet" is the same bytes as
 * its way of saying "no".
 *
 * THIS IS THE MOST DANGEROUS STATE TO RENDER CARELESSLY. `converted: null` is not
 * `false`, and a surface that shows an unchecked box or a 0% has invented a
 * business fact out of provider silence.
 */
export interface UnknownFactState {
  identityDigest: string;
  fact: string;
  decision: FactConvergenceDecision;
  storedValue: null;
  /** What arrived. Ambiguous: a pending postback and a settled no look identical. */
  observedRaw: string;
  reason: string;
}

export const UNKNOWN_FACT: UnknownFactState = {
  identityDigest: 'c81b40de55a7',
  fact: 'converted',
  decision: 'REMAIN_UNKNOWN',
  storedValue: null,
  observedRaw: '0',
  reason:
    'This destination settles by postback. CallGrid reports 0 both for a call that ' +
    'did not convert and for one whose postback has not arrived.',
};

// --- 6/7. Attention items -------------------------------------------------------------

/** A move that runs against a stated objective, still recurring, nobody has judged it. */
export const HIGH_PRIORITY_ATTENTION: HeadlineView = HEALTHY_KNOWN_METRIC;

/**
 * A move that runs WITH the objective. Real, measured, worth seeing, not a problem.
 *
 * A briefing that only ever shows bad news is a briefing people learn to dread and
 * then stop opening.
 */
export const INFORMATIONAL_ATTENTION: HeadlineView = headline({
  id: 'hl_informational',
  objectiveTitle: 'Grow Final Expense call volume',
  metric: 'CALL_VOLUME',
  metricLabel: 'Call volume',
  unit: 'COUNT',
  movement: 'INCREASE',
  againstObjective: false,
  currentValue: 4820,
  priorValue: 3910,
  absoluteChange: 910,
  percentageChange: 0.233,
  currentDenominator: 4820,
  priorDenominator: 3910,
  currentCoverage: null,
  priorCoverage: null,
  statement: 'Final Expense call volume rose from 3,910 to 4,820 over the last 7 business days.',
  limitations: [],
  unknowns: [],
  detectionCount: 1,
});

/** The same item after a person judged it. Dismissal never suppresses recurrence. */
export const DISMISSED_ATTENTION: HeadlineView = headline({
  id: 'hl_dismissed',
  objectiveTitle: 'Grow Medicare answer rate',
  metric: 'MONETIZED_RATE',
  metricLabel: 'Monetized rate',
  unit: 'RATIO',
  movement: 'DECREASE',
  againstObjective: true,
  currentValue: 0.55,
  priorValue: 0.62,
  absoluteChange: -0.07,
  percentageChange: -0.113,
  currentDenominator: 2210,
  priorDenominator: 2180,
  currentCoverage: 0.99,
  priorCoverage: 0.99,
  statement: 'Medicare monetized rate fell from 62.0% to 55.0% over the last 7 business days.',
  limitations: [],
  unknowns: [],
  detectionCount: 5,
  dismissed: { basis: 'IMMATERIAL', byName: 'Matt' },
});

// --- 8. An action awaiting approval ------------------------------------------------------

/**
 * Something Loop prepared and a human must decide on.
 *
 * NOTHING CONSEQUENTIAL HAPPENS WITHOUT THE SECOND STEP. The state below is the
 * one a surface must be able to render today; the drafting side of it is not
 * built, and this fixture does not pretend otherwise -- `draftedBody` is null and
 * a surface should show that a human still has to write it.
 */
export interface PendingActionState {
  id: string;
  title: string;
  /** The shipped priority vocabulary. Not a new one. */
  state: PriorityState;
  subject: string;
  /** What Loop is asking a person to decide. */
  question: string;
  /** Null: Loop does not draft outbound content today. */
  draftedBody: string | null;
  requiresHumanApproval: true;
  assignedToName: string | null;
}

export const ACTION_AWAITING_APPROVAL: PendingActionState = {
  id: 'pri_fixture',
  title: 'Buyer CEM monetized rate down 31%',
  state: 'NEEDS_REVIEW',
  subject: 'Buyer · CEM',
  question: 'Is this worth contacting the buyer about, or is it expected?',
  draftedBody: null,
  requiresHumanApproval: true,
  assignedToName: null,
};

// --- 9. Coverage / integration health ------------------------------------------------------

export interface CoverageState {
  organization: string;
  provider: string;
  stream: string;
  status: CoverageHealthStatus;
  /** Null when nothing has ever been proven. Not zero -- absent. */
  completedThrough: string | null;
  lagMs: number | null;
  note: string;
}

export const COVERAGE_HEALTHY: CoverageState = {
  organization: 'servicesinmycity-demo',
  provider: 'callgrid',
  stream: 'calls',
  status: 'HEALTHY',
  completedThrough: '2026-08-22T11:00:00.000Z',
  lagMs: 42 * 60 * 1000,
  note: 'Coverage is within the expected lag for an hourly cadence.',
};

export const COVERAGE_STALE: CoverageState = {
  organization: 'servicesinmycity-demo',
  provider: 'callgrid',
  stream: 'calls',
  status: 'STALE',
  completedThrough: '2026-08-19T03:00:00.000Z',
  lagMs: 3 * 24 * 60 * 60 * 1000,
  note: 'Nothing has proven coverage for three days. The poller may not be running at all.',
};

/** Before routine polling is switched on. Not an incident, and not health either. */
export const COVERAGE_NEVER_PROVEN: CoverageState = {
  organization: 'servicesinmycity-demo',
  provider: 'callgrid',
  stream: 'calls',
  status: 'NEVER_PROVEN',
  completedThrough: null,
  lagMs: null,
  note: 'No routine interval has ever been proven complete.',
};

// --- 10. Nothing needs attention --------------------------------------------------------

/**
 * The all-clear, and it must EARN the word.
 *
 * "Nothing needs attention" and "Loop could not look" are different facts, and a
 * surface that renders them the same way is the empty state that reads as an
 * all-clear. This state therefore carries what it checked and through when --
 * an empty list plus a coverage boundary is a claim; an empty list alone is not.
 */
export interface AllClearState {
  openAttentionItems: 0;
  objectivesMeasured: number;
  objectivesWithheld: number;
  coverage: CoverageState;
  reconciliationThrough: string;
  checkedAt: string;
}

export const NOTHING_NEEDS_ATTENTION: AllClearState = {
  openAttentionItems: 0,
  objectivesMeasured: 6,
  objectivesWithheld: 0,
  coverage: COVERAGE_HEALTHY,
  reconciliationThrough: '2026-08-21',
  checkedAt: '2026-08-22T11:42:00.000Z',
};

/** The look-alike it must never be confused with. Same empty list, no standing. */
export const NOTHING_KNOWN_YET: AllClearState = {
  openAttentionItems: 0,
  objectivesMeasured: 0,
  objectivesWithheld: 6,
  coverage: COVERAGE_NEVER_PROVEN,
  reconciliationThrough: '',
  checkedAt: '2026-08-22T11:42:00.000Z',
};
