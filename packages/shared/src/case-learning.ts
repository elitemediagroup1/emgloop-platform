// What EMG may learn from what it did — and the four things it may never
// conclude from it.
//
// THE FOUNDATION, AND DELIBERATELY NOT AN ENGINE. What this builds is the
// structured record: what Loop recommended, what a person chose instead, what
// sequence was actually carried out where that is knowable, what happened
// afterwards, and what the evidence looked like at the time. That record is the
// thing a future comparison needs and the thing nobody can reconstruct later.
// The comparison itself is a separate decision with a separate approval.
//
// FOUR REFUSALS, EACH OF WHICH IS EASY TO GET WRONG:
//
//   1. ONE SUCCESSFUL CASE IS NOT A POLICY. A pattern seen once is an anecdote,
//      and a system that promoted it would encode the first thing that happened
//      to work as the way EMG operates.
//   2. SEQUENCE DOES NOT IMPLY CAUSE. "They contacted the buyer and then it
//      recovered" is two facts in an order. Turning that into "contacting the
//      buyer works" requires a counterfactual nothing here has.
//   3. AGREEMENT IS NOT EVIDENCE. That people repeatedly chose the same option
//      says what people prefer, not what works. Both are worth knowing and they
//      are not the same measurement, so they are counted separately.
//   4. NOTHING BECOMES DOCTRINE WITHOUT A PERSON. The top maturity is reachable
//      only by explicit human approval, and no function here can set it.
//
// PURE. No clock, no I/O. `now` is an argument where one is needed.

import type { MonitoringVerdict } from './case-monitoring';
import type { OperationalOutcome } from './operational-lifecycle';

export const CASE_LEARNING_RULE_VERSION = 'case-learning.v1';

// --- What is observed --------------------------------------------------------------------

/**
 * One Case, reduced to the facts a later comparison would need.
 *
 * EVERY FIELD IS SOMETHING ALREADY RECORDED. Nothing here is derived from
 * judgement, and nothing is filled in when it is absent: a Case where nobody
 * selected an option carries `selected: null`, not a guess at what they probably
 * would have picked.
 */
export interface LearningObservation {
  caseId: string;
  /** What the Case was about, as the producer's own comparability key. */
  subject: string;
  /** What Loop proposed, in the order it ranked them. Preserved exactly. */
  machineOptions: readonly LearningOption[];
  /** What a person chose, when they chose. Null when nobody did. */
  selected: LearningOption | null;
  /** What a person proposed instead, when they revised. Null when nobody did. */
  revised: LearningOption | null;
  /**
   * The sequence actually carried out, WHERE THAT IS KNOWABLE.
   *
   * Null is the common case and it is honest. Loop knows what was selected; it
   * knows work was created; it does not generally know what somebody did. A
   * learning record that assumed the selected sequence was the executed one
   * would be inventing the single fact the whole comparison turns on.
   */
  executed: readonly string[] | null;
  outcome: OperationalOutcome | null;
  monitoringVerdict: MonitoringVerdict | null;
  /** What the evidence looked like when the decision was made. Not now. */
  evidenceAtDecision: LearningEvidenceState;
  /** When the Case closed, when it did. */
  closedAt: string | null;
}

export interface LearningOption {
  key: string;
  label: string;
  posture: string;
  /** The ranked position Loop gave it. 1 is Loop's own first choice. */
  rank: number;
  /** The action verbs, in order. The shape a later comparison reads. */
  actions: readonly string[];
}

export interface LearningEvidenceState {
  /** Whether a Finding was established when the decision was taken. */
  findingEstablished: boolean;
  /** The Stage 3 verdict at the time, when one was recorded. */
  readinessOutcome: string | null;
  /** How many pieces of supporting evidence stood behind it. */
  supportingCount: number;
}

// --- Comparability ---------------------------------------------------------------------

/**
 * When two Cases count as the same kind of situation.
 *
 * DETERMINISTIC AND NARROW, on purpose. Two Cases are comparable when they are
 * about the same subject in the producer's own terms. Anything looser -- "these
 * feel similar", an embedding, a model's judgement -- would make the
 * denominator of every pattern below unfalsifiable, and a pattern with an
 * unfalsifiable denominator is a number that cannot be argued with.
 *
 * THE PRODUCER OWNS THE KEY. This never parses it. A producer that wants
 * broader or narrower comparability changes what it writes, visibly, rather than
 * this file guessing on its behalf.
 */
export function comparableKey(subject: string): string {
  return subject.trim().toLowerCase();
}

export function groupComparable(
  observations: readonly LearningObservation[],
): Map<string, LearningObservation[]> {
  const groups = new Map<string, LearningObservation[]>();
  for (const o of observations) {
    const key = comparableKey(o.subject);
    groups.set(key, [...(groups.get(key) ?? []), o]);
  }
  return groups;
}

// --- Maturity -----------------------------------------------------------------------------

/**
 * How far something has got from "we did this once".
 *
 * THE TOP RUNG IS NOT REACHABLE BY COUNTING. `assessPattern` can return
 * OBSERVATION and EMERGING_PATTERN; it can never return
 * ESTABLISHED_OPERATING_PATTERN, and there is no threshold that would produce
 * one. That state exists only when a person promotes it, which is the whole
 * point of having three rungs rather than a percentage.
 */
export const PATTERN_MATURITIES = [
  /** It happened. Once, or a few times, with no claim attached. */
  'OBSERVATION',
  /** It has happened enough times, comparably, to be worth a person looking. */
  'EMERGING_PATTERN',
  /** A person decided this is how EMG operates. NEVER set by any function here. */
  'ESTABLISHED_OPERATING_PATTERN',
] as const;

export type PatternMaturity = (typeof PATTERN_MATURITIES)[number];

export const PATTERN_MATURITY_LABELS: Record<PatternMaturity, string> = {
  OBSERVATION: 'Seen',
  EMERGING_PATTERN: 'Worth a look',
  ESTABLISHED_OPERATING_PATTERN: 'How we operate',
};

/**
 * How many comparable Cases before something is worth a person's attention.
 *
 * THREE, AND THE NUMBER IS ARBITRARY IN A WAY THAT IS STATED RATHER THAN HIDDEN.
 * It is not derived from anything -- there is no power calculation here and
 * pretending otherwise would be worse than admitting it. It exists to stop one
 * Case reading as a trend, and it can be argued with because it is one named
 * constant rather than a threshold buried in a scoring function.
 */
export const EMERGING_PATTERN_MINIMUM = 3;

/** What a pattern may and may not say about itself. */
export interface PatternView {
  ruleVersion: string;
  /** The comparability key these Cases share. */
  subject: string;
  maturity: PatternMaturity;
  /** Every Case behind it, so the claim is always followable to its instances. */
  caseIds: readonly string[];
  /**
   * How often each option was CHOSEN. A statement about preference.
   *
   * DELIBERATELY SEPARATE FROM THE NEXT FIELD. What people pick and what
   * measurably worked are different measurements, and averaging them into one
   * "effectiveness" number would make agreement look like evidence.
   */
  chosen: readonly { optionKey: string; count: number }[];
  /**
   * How often each option was followed by a monitored recovery. A statement
   * about correlation, and NOT about cause.
   */
  followedByRecovery: readonly { optionKey: string; count: number; ofMonitored: number }[];
  /** What this pattern is not entitled to claim. Carried, never omitted. */
  cannotConclude: readonly string[];
  /** Why it is at the maturity it is. */
  explanation: readonly string[];
}

export const LEARNING_REFUSALS = {
  CAUSE:
    'This says what followed what. It does not say what caused what: there is no control and ' +
    'no counterfactual behind any of these Cases.',
  PREFERENCE:
    'How often an option was chosen says what people prefer, not what works. The two are ' +
    'counted separately here for that reason.',
  PROMOTION:
    'No number of comparable Cases makes this how EMG operates. That is a decision a person ' +
    'takes, and Loop cannot take it.',
  SMALL_N:
    'This rests on too few comparable Cases to be more than an observation.',
  UNMEASURED:
    'Some of these Cases were never monitored, so what happened afterwards is unknown for ' +
    'them rather than neutral.',
} as const;

/**
 * What a group of comparable Cases amounts to.
 *
 * COUNTS AND REFUSALS, AND NOTHING BETWEEN THEM. There is no score, no
 * confidence and no ranking of options by "effectiveness" -- every one of those
 * would be a claim about cause wearing a number, and the whole file exists to
 * refuse that one claim.
 */
export function assessPattern(
  subject: string,
  observations: readonly LearningObservation[],
): PatternView {
  const cannotConclude: string[] = [LEARNING_REFUSALS.CAUSE, LEARNING_REFUSALS.PREFERENCE];
  const explanation: string[] = [];

  const chosenCounts = new Map<string, number>();
  for (const o of observations) {
    if (!o.selected) continue;
    chosenCounts.set(o.selected.key, (chosenCounts.get(o.selected.key) ?? 0) + 1);
  }

  const monitored = observations.filter((o) => o.monitoringVerdict !== null);
  const recoveryCounts = new Map<string, { count: number; ofMonitored: number }>();
  for (const o of monitored) {
    if (!o.selected) continue;
    const current = recoveryCounts.get(o.selected.key) ?? { count: 0, ofMonitored: 0 };
    recoveryCounts.set(o.selected.key, {
      // HELD is the only verdict that counts as the thing having recovered, and
      // it counts because somebody committed to the criterion in advance.
      count: current.count + (o.monitoringVerdict === 'HELD' ? 1 : 0),
      ofMonitored: current.ofMonitored + 1,
    });
  }

  if (monitored.length < observations.length) {
    // NOT NEUTRAL, UNKNOWN. A Case nobody monitored did not "not recover"; it
    // was not looked at, and folding those into a denominator would quietly make
    // every option look worse or better depending on which way you rounded.
    cannotConclude.push(LEARNING_REFUSALS.UNMEASURED);
    explanation.push(
      `${observations.length - monitored.length} of ${observations.length} comparable Cases were never monitored.`,
    );
  }

  const maturity: PatternMaturity =
    observations.length >= EMERGING_PATTERN_MINIMUM ? 'EMERGING_PATTERN' : 'OBSERVATION';
  if (maturity === 'OBSERVATION') {
    cannotConclude.push(LEARNING_REFUSALS.SMALL_N);
    explanation.push(
      `${observations.length} comparable ${observations.length === 1 ? 'Case' : 'Cases'}; ` +
        `${EMERGING_PATTERN_MINIMUM} are needed before this is worth a person looking at.`,
    );
  } else {
    explanation.push(
      `${observations.length} comparable Cases. Worth a person looking at; not yet how EMG operates.`,
    );
  }
  // ALWAYS, AT EVERY MATURITY. There is no count at which promotion becomes
  // automatic, so the refusal never drops off.
  cannotConclude.push(LEARNING_REFUSALS.PROMOTION);

  return {
    ruleVersion: CASE_LEARNING_RULE_VERSION,
    subject,
    maturity,
    caseIds: observations.map((o) => o.caseId),
    chosen: [...chosenCounts].map(([optionKey, count]) => ({ optionKey, count })),
    followedByRecovery: [...recoveryCounts].map(([optionKey, v]) => ({ optionKey, ...v })),
    cannotConclude,
    explanation,
  };
}

// --- The organizational knowledge boundary --------------------------------------------------

/**
 * WHERE DURABLE KNOWLEDGE ALREADY LIVES, and why Stage 4 does not build another.
 *
 * `KnowledgeAssertion` is the platform's authority for what EMG durably knows.
 * It carries `assertionClass: ORGANIZATIONAL`, a status that starts at PROPOSED
 * and only a person moves to ACTIVE, explicit supersession rather than deletion,
 * effective dating, permitted purposes and a consent basis. Its own header
 * records that a class is "NEVER silently promoted -- an inferred belief must
 * not read back as a declared fact", which is precisely the rule Stage 4 needs.
 *
 * SO STAGE 4 NOMINATES INTO IT AND DOES NOT DUPLICATE IT. A second store for
 * "things EMG has learned" would be a second Brain, and this repository already
 * carries the cost of every parallel system it has built.
 */
export const KNOWLEDGE_AUTHORITY = 'KnowledgeAssertion' as const;

/**
 * A pattern proposed for promotion into durable organizational knowledge.
 *
 * A PROPOSAL, AND NOTHING IS WRITTEN. Building this does not create an
 * assertion, and no function in Stage 4 does. Promotion in v1 requires explicit
 * human approval, and the honest expression of that is a boundary a person
 * crosses rather than a status a machine sets.
 */
export interface KnowledgeNomination {
  ruleVersion: string;
  /** What is being proposed, in one line a person can accept or reject. */
  claim: string;
  /** The pattern behind it, in full, including everything it cannot conclude. */
  pattern: PatternView;
  /** Where it would go, if a person accepted it. */
  destination: typeof KNOWLEDGE_AUTHORITY;
  /** The class it would be written as. Never anything stronger. */
  assertionClass: 'ORGANIZATIONAL';
  /** The status it would be created in. A person moves it on from there. */
  proposedStatus: 'PROPOSED';
  /** What stops this being written today. Empty is not the same as approved. */
  blockers: readonly NominationBlocker[];
}

/**
 * What stands between a nomination and an assertion.
 *
 * THE FIRST IS A SCHEMA FACT, NOT A POLICY. `knowledge_assertions.subjectIdentityId`
 * is a required column: every assertion is ABOUT a CognitiveIdentity. An
 * operating pattern -- "reaching the buyer before moving volume tends to precede
 * recovery" -- is about a way of working, not about a person or an account, and
 * there is no identity to name. Fabricating one to satisfy the column would put
 * a non-entity into the identity graph and force every identity query to filter
 * it out, which is exactly the reasoning `state_change_outbox.identityId`
 * already records for staying nullable.
 *
 * THAT IS A REAL BLOCKER AND IT IS REPORTED RATHER THAN WORKED AROUND. Making
 * the column nullable is a decision about the knowledge graph's shape, taken by
 * whoever owns it, not a side effect of Stage 4 wanting somewhere to write.
 */
export const NOMINATION_BLOCKERS = [
  'NO_IDENTITY_SUBJECT',
  'NOT_MATURE_ENOUGH',
  'HUMAN_APPROVAL_REQUIRED',
] as const;

export type NominationBlocker = (typeof NOMINATION_BLOCKERS)[number];

export const NOMINATION_BLOCKER_LABELS: Record<NominationBlocker, string> = {
  NO_IDENTITY_SUBJECT:
    'Durable knowledge is recorded about a subject, and an operating pattern is about a way of ' +
    'working rather than about anyone. There is nothing to name as its subject.',
  NOT_MATURE_ENOUGH:
    'This has not been seen in enough comparable Cases to be proposed as organizational knowledge.',
  HUMAN_APPROVAL_REQUIRED:
    'Promotion into durable organizational knowledge is a decision a person takes. Loop proposes it.',
};

/**
 * Propose a pattern for promotion. WRITES NOTHING, BY CONSTRUCTION.
 *
 * `HUMAN_APPROVAL_REQUIRED` is always present, at every maturity and every
 * count. It is not a condition that clears; it is the shape of the boundary.
 */
export function nominateForKnowledge(pattern: PatternView, claim: string): KnowledgeNomination {
  const blockers: NominationBlocker[] = [];
  if (pattern.maturity === 'OBSERVATION') blockers.push('NOT_MATURE_ENOUGH');
  // Always, and in this order, so a reader sees the schema fact before the
  // policy one.
  blockers.push('NO_IDENTITY_SUBJECT', 'HUMAN_APPROVAL_REQUIRED');

  return {
    ruleVersion: CASE_LEARNING_RULE_VERSION,
    claim,
    pattern,
    destination: KNOWLEDGE_AUTHORITY,
    assertionClass: 'ORGANIZATIONAL',
    proposedStatus: 'PROPOSED',
    blockers,
  };
}

// --- Cross-objective relevance ----------------------------------------------------------------

/**
 * A Finding established for one objective may matter to another.
 *
 * WHAT THIS IS ALLOWED TO DO. Say that an objective elsewhere in the SAME
 * organization measures the same thing, so somebody looking at that objective
 * would want to know. That is a routing observation over facts already in the
 * schema: an objective's measure binding names its metric.
 *
 * WHAT IT IS NOT ALLOWED TO DO. Open a Case, raise an Opportunity, or bypass the
 * Headline → human Investigate gate. Cross-domain relevance is a reason for
 * somebody to be shown a Headline, and a person still decides whether it becomes
 * an investigation. Anything else would let a Finding in one part of the
 * business quietly create work in another.
 *
 * TENANT-SCOPED BY ITS INPUT. This is pure and compares what it is given; the
 * caller loads objectives within one organization, which is the only place that
 * scope can be enforced.
 */
export interface ObjectiveRelevance {
  performanceObjectiveId: string;
  objectiveTitle: string;
  /** Why it is relevant, as a value rather than a sentence. */
  basis: RelevanceBasis;
  /** The metric they share. */
  metric: string;
  /** Whose objective it is, when it belongs to a person. */
  scopeUserId: string | null;
  /** What a person would have to do for this to become an investigation. */
  requires: string;
}

export const RELEVANCE_BASES = [
  /** The other objective measures the same metric. */
  'SHARED_METRIC',
] as const;

export type RelevanceBasis = (typeof RELEVANCE_BASES)[number];

export const RELEVANCE_REQUIRES_AUTHORIZATION =
  'A person would have to authorize an investigation from a Headline. Relevance is a reason ' +
  'to look, not a decision to act.';

export function findRelevantObjectives(input: {
  /** The objective the Finding was established against. Excluded from results. */
  originObjectiveId: string;
  metric: string;
  /** Active objectives in the SAME organization, with the metric each measures. */
  candidates: readonly {
    id: string;
    title: string;
    metric: string;
    scopeUserId: string | null;
    active: boolean;
  }[];
}): ObjectiveRelevance[] {
  return input.candidates
    .filter(
      (c) =>
        c.active &&
        c.id !== input.originObjectiveId &&
        // Exact metric equality, deliberately. A fuzzy match here would be a
        // model's judgement wearing a string comparison, and the result would be
        // a Headline shown to somebody for a reason nobody could check.
        c.metric === input.metric,
    )
    .map((c) => ({
      performanceObjectiveId: c.id,
      objectiveTitle: c.title,
      basis: 'SHARED_METRIC' as const,
      metric: input.metric,
      scopeUserId: c.scopeUserId,
      requires: RELEVANCE_REQUIRES_AUTHORIZATION,
    }));
}
