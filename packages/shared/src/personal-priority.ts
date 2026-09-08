// How much this matters to the BUSINESS, and how much it matters to YOU, kept
// permanently apart.
//
// THE ONE THING THIS FILE EXISTS TO PREVENT. There is enormous pressure, the
// moment a queue has to be ordered, to compute a single number and sort by it.
// The moment that happens, "a 31% revenue fall nobody is handling" and "a small
// data-quality question that three people are waiting on you to answer" get
// mixed into one figure, and neither question can be asked again. So this
// contract carries TWO fields that are never combined, and provides no function
// that reduces them to one.
//
//   BUSINESS SIGNIFICANCE   How much this matters to the organization. Already
//                           answered by `severity`, whether the move ran against
//                           a stated objective, and the measured size of it.
//   PERSONAL RELEVANCE      Why this is YOUR problem right now. Answered by
//                           facts about your relationship to the case: you were
//                           asked to decide it, you own it, it was measured
//                           against your objective.
//
// NEITHER IS A SCORE. Significance is the shipped severity vocabulary. Relevance
// is a TIER derived from membership facts, each of which is a row somebody can
// point at -- not a weighting of features. A person asking "why did Loop put this
// first" gets sentences naming the rows, which is the only answer that survives
// being wrong.
//
// WHAT IS DELIBERATELY NOT AN INPUT. Revenue exposure per person, commercial
// potential, client relationship value and "how busy is this employee" are all
// listed in the product brief and none of them exists in this schema. Inventing
// any of them would put a fabricated business fact at the top of somebody's day,
// which is the exact failure this platform's principles name first. They are
// recorded below as missing rather than approximated.
//
// PURE. No clock, no I/O, no randomness.

import type { DecisionSeverity } from './decision-contract';
import { DECISION_SEVERITY_RANK } from './decision-contract';
import type { CaseContribution } from './case-participation';
import { contributionIsAwaited } from './case-participation';

export const PERSONAL_PRIORITY_RULE_VERSION = 'personal-priority.v1';

// --- Why this is yours ------------------------------------------------------------

/**
 * The kinds of relationship a person can have to an investigation.
 *
 * ORDERED BY HOW DIRECTLY THE PERSON IS BEING ASKED FOR SOMETHING, strongest
 * first, and every member is a ROW SOMEBODY CAN POINT AT rather than an inference:
 *
 *   AWAITED_DECISION   You were asked to decide or approve, and not released.
 *                      The investigation is waiting on you specifically.
 *   ASKED_TO_HELP      You were asked to contribute something else.
 *   ACCOUNTABLE        You are the owner: you answer for this reaching an outcome.
 *   WORKING_IT         You are the assignee: you are actively working it.
 *   YOUR_OBJECTIVE     It was measured against an objective you own.
 *   ORGANIZATION_WIDE  Nothing connects you to it personally. It may still be the
 *                      most important thing happening.
 *
 * ACCOUNTABLE SITS BELOW BEING ASKED, AND THAT IS DELIBERATE. An owner carries
 * every open case they own; being asked for a specific decision on one of them is
 * the thing that should surface today. Ownership is a standing relationship,
 * being awaited is an event.
 */
export const RELEVANCE_TIERS = [
  'AWAITED_DECISION',
  'ASKED_TO_HELP',
  'ACCOUNTABLE',
  'WORKING_IT',
  'YOUR_OBJECTIVE',
  'ORGANIZATION_WIDE',
] as const;
export type RelevanceTier = (typeof RELEVANCE_TIERS)[number];

export const RELEVANCE_TIER_RANK: Record<RelevanceTier, number> = {
  AWAITED_DECISION: 0,
  ASKED_TO_HELP: 1,
  ACCOUNTABLE: 2,
  WORKING_IT: 3,
  YOUR_OBJECTIVE: 4,
  ORGANIZATION_WIDE: 5,
};

export const RELEVANCE_TIER_LABELS: Record<RelevanceTier, string> = {
  AWAITED_DECISION: 'Waiting on you',
  ASKED_TO_HELP: 'You were asked to help',
  ACCOUNTABLE: 'You own this',
  WORKING_IT: 'You are working this',
  YOUR_OBJECTIVE: 'Measured against your objective',
  ORGANIZATION_WIDE: 'Not assigned to you',
};

/**
 * One reason this case is relevant to this person, and the row it came from.
 *
 * EVERY REASON NAMES ITS SOURCE. That is what makes "why is this first"
 * answerable: a surface renders the sentence, and an operator who disagrees can
 * go and look at the exact row that produced it.
 */
export interface RelevanceReason {
  tier: RelevanceTier;
  /** One sentence, in plain language. */
  statement: string;
  /** Which table the fact came from. Never a computation. */
  source: 'CASE_PARTICIPANT' | 'CASE_OWNER' | 'CASE_ASSIGNEE' | 'PERFORMANCE_OBJECTIVE';
  /** The row's id, so the claim is checkable. */
  sourceId: string | null;
}

// --- How much it matters to the business -------------------------------------------

/**
 * The organization's stake, assembled from what is already recorded.
 *
 * NO NEW VOCABULARY. `severity` is the shipped `DECISION_SEVERITIES` value the
 * producer mapped in at the boundary; `againstObjective` is a fact about
 * arithmetic and a human's stated intent; `measuredImpactCents` is whatever was
 * actually measured, and NULL when nothing was -- never a forecast, never zero.
 */
export interface BusinessSignificance {
  severity: DecisionSeverity;
  /** True when the move ran against a stated objective. A fact, not a judgement. */
  againstObjective: boolean | null;
  /**
   * What was measured, in cents. NULL MEANS NOBODY MEASURED IT.
   *
   * Distinct from zero, which would mean "measured, and it was nothing". Today
   * this is null on almost every investigation, and the contract says so rather
   * than substituting a plausible number.
   */
  measuredImpactCents: number | null;
  /** The measured relative move, as a fraction. Null when there was no baseline. */
  percentageChange: number | null;
}

// --- The two answers, side by side --------------------------------------------------

/**
 * What one investigation is worth to the business, and why it is this person's,
 * kept apart.
 *
 * THERE IS NO COMBINED FIELD, AND NO FUNCTION IN THIS FILE PRODUCES ONE. A
 * surface that wants a single list sorts by `compareForUser`, which is a stated
 * ordering over the two, not a weighting of them -- and it can always show why.
 */
export interface PersonalPriorityView {
  caseId: string;
  userId: string;
  ruleVersion: string;
  significance: BusinessSignificance;
  /** The strongest relationship this person has to the case. */
  tier: RelevanceTier;
  /** Every relationship, strongest first. Each names the row behind it. */
  reasons: readonly RelevanceReason[];
  /**
   * What Loop could not take into account.
   *
   * FIRST-CLASS, BECAUSE THE LIST IS LONG AND MATTERS. An operator seeing a
   * ranking should know it does not know what a client is worth or how much
   * revenue is exposed, rather than assuming it weighed them.
   */
  notConsidered: readonly string[];
}

/**
 * What a ranking cannot yet account for, stated once.
 *
 * Every entry is something the product brief asks for and this schema does not
 * record. They are listed rather than approximated: a ranking that silently
 * ignores client value looks identical to one that weighed it and found it small.
 */
export const PRIORITY_NOT_CONSIDERED: readonly string[] = [
  'How much revenue is exposed here. No investigation records that today.',
  'What this client or partner relationship is worth. Loop holds no relationship value.',
  'What this could be worth if it goes well. Loop measures what happened, not potential.',
  'How much else this person is already carrying. Nothing measures workload.',
  'Who reports to whom. This platform has no reporting relationship, so nothing escalates.',
];

// --- Deriving it ---------------------------------------------------------------------

export interface PersonalPriorityInput {
  caseId: string;
  userId: string;
  significance: BusinessSignificance;
  /** This person's live participation on the case, if any. */
  participation: readonly {
    id: string;
    contribution: CaseContribution;
    request: string;
    active: boolean;
  }[];
  ownerUserId: string | null;
  assigneeUserId: string | null;
  /** The objective this case was measured against, when it was measured at all. */
  objective: { id: string; scopeUserId: string | null } | null;
}

/**
 * Why this investigation is this person's, and how much it is worth to the
 * business — as two answers.
 *
 * TOTAL AND DETERMINISTIC. Every person has a tier, including
 * ORGANIZATION_WIDE, so a queue never silently drops a case because nobody was
 * connected to it. Reasons accumulate in tier order; the tier is the strongest
 * one present.
 */
export function assessPersonalPriority(input: PersonalPriorityInput): PersonalPriorityView {
  const reasons: RelevanceReason[] = [];

  for (const p of input.participation) {
    if (!p.active) continue;
    const awaited = contributionIsAwaited(p.contribution);
    reasons.push({
      tier: awaited ? 'AWAITED_DECISION' : 'ASKED_TO_HELP',
      statement: awaited
        ? `This is waiting on you: ${p.request}`
        : `You were asked to help: ${p.request}`,
      source: 'CASE_PARTICIPANT',
      sourceId: p.id,
    });
  }

  if (input.ownerUserId === input.userId) {
    reasons.push({
      tier: 'ACCOUNTABLE',
      statement: 'You answer for this reaching an outcome.',
      source: 'CASE_OWNER',
      sourceId: input.caseId,
    });
  }
  if (input.assigneeUserId === input.userId) {
    reasons.push({
      tier: 'WORKING_IT',
      statement: 'You are the person working this.',
      source: 'CASE_ASSIGNEE',
      sourceId: input.caseId,
    });
  }
  if (input.objective?.scopeUserId && input.objective.scopeUserId === input.userId) {
    reasons.push({
      tier: 'YOUR_OBJECTIVE',
      statement: 'This was measured against an objective you own.',
      source: 'PERFORMANCE_OBJECTIVE',
      sourceId: input.objective.id,
    });
  }

  reasons.sort((a, b) => RELEVANCE_TIER_RANK[a.tier] - RELEVANCE_TIER_RANK[b.tier]);
  const strongest = reasons[0]?.tier ?? 'ORGANIZATION_WIDE';

  return {
    caseId: input.caseId,
    userId: input.userId,
    ruleVersion: PERSONAL_PRIORITY_RULE_VERSION,
    significance: input.significance,
    tier: strongest,
    reasons,
    notConsidered: PRIORITY_NOT_CONSIDERED,
  };
}

// --- Ordering, and why it is not a score ----------------------------------------------

/**
 * The declared order for one person's queue.
 *
 * RELEVANCE FIRST, THEN SIGNIFICANCE, AND THAT ORDER IS A PRODUCT DECISION
 * WRITTEN DOWN RATHER THAN A WEIGHTING. Three people waiting on your decision
 * about a NOTABLE case should reach you before a CRITICAL case nobody has asked
 * you about — because the second one is somebody else's to move, and a queue that
 * put it first would show you a wall of things you cannot act on.
 *
 * NO COEFFICIENTS, NO SUM, NO SCORE. Comparing two items is a lexicographic walk
 * over three named facts, so the answer to "why is this above that" is always one
 * of exactly three sentences. Ties are left in the caller's order rather than
 * broken by an invented rule.
 */
export function compareForUser(a: PersonalPriorityView, b: PersonalPriorityView): number {
  const tier = RELEVANCE_TIER_RANK[a.tier] - RELEVANCE_TIER_RANK[b.tier];
  if (tier !== 0) return tier;
  // ASCENDING, BECAUSE `DECISION_SEVERITY_RANK` PUTS CRITICAL AT 0. Subtracting
  // the other way round sorts the least severe case to the top, which is exactly
  // the bug this comment exists to stop somebody reintroducing.
  const severity =
    DECISION_SEVERITY_RANK[a.significance.severity] - DECISION_SEVERITY_RANK[b.significance.severity];
  if (severity !== 0) return severity;
  // AGAINST A STATED OBJECTIVE OUTRANKS WITH IT, at equal severity: a move in the
  // direction somebody said they wanted is not the thing to look at first.
  const against = Number(b.significance.againstObjective ?? false) - Number(a.significance.againstObjective ?? false);
  return against;
}

export const PRIORITY_COMPARISON_REASONS = {
  TIER: 'It is more directly yours: you were asked for something on it.',
  SEVERITY: 'You are equally connected to both, and this one is more severe.',
  AGAINST_OBJECTIVE:
    'Both are equally severe, and this one moved against something the business said it wanted.',
  TIED: 'Nothing separates them, so the order they arrived in is kept.',
} as const;
export type PriorityComparisonReason = keyof typeof PRIORITY_COMPARISON_REASONS;

/**
 * Why one item sits above another, in one sentence.
 *
 * THE SAME WALK AS `compareForUser`, so the explanation cannot disagree with the
 * ordering. If these two functions ever diverge, the explanation is a
 * rationalisation and the product is lying about its own reasoning.
 */
export function explainOrder(
  a: PersonalPriorityView,
  b: PersonalPriorityView,
): { reason: PriorityComparisonReason; statement: string } {
  const reason: PriorityComparisonReason =
    RELEVANCE_TIER_RANK[a.tier] !== RELEVANCE_TIER_RANK[b.tier]
      ? 'TIER'
      : DECISION_SEVERITY_RANK[a.significance.severity] !==
          DECISION_SEVERITY_RANK[b.significance.severity]
        ? 'SEVERITY'
        : (a.significance.againstObjective ?? false) !== (b.significance.againstObjective ?? false)
          ? 'AGAINST_OBJECTIVE'
          : 'TIED';
  return { reason, statement: PRIORITY_COMPARISON_REASONS[reason] };
}

/**
 * One person's queue, ordered.
 *
 * A STABLE SORT OVER A DECLARED COMPARATOR. Two items nothing separates keep the
 * order they arrived in, rather than being shuffled by a tie-break nobody chose.
 */
export function orderForUser(
  items: readonly PersonalPriorityView[],
): readonly PersonalPriorityView[] {
  return [...items].sort(compareForUser);
}
