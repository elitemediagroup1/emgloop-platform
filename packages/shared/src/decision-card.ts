// The decision card — what an operator sees before expanding anything.
//
// PRESENTATION ONLY. Nothing here measures, scores, ranks or concludes. Every
// value is a re-arrangement of something the engine already decided, and every
// function returns null rather than inventing a sentence when the underlying
// facts are absent. If a string here could not be traced back to a measured
// field, it would be exactly the fabrication the whole product is built against.
//
// The card answers three questions in the order an operator asks them:
//   1. How much can I trust this?      -> confidenceOf
//   2. Why does it matter?             -> whyItMatters
//   3. How can this end?               -> expectedOutcomes
//
// Pure: no clock, no I/O. Lives in @emgloop/shared so the composition is tested
// rather than assembled inline in JSX where it cannot be.

import type { Situation } from './callgrid-situation';
import {
  EVIDENCE_STRENGTH_LABEL,
  EVIDENCE_STRENGTH_RANK,
  type EvidenceStrength,
} from './callgrid-decision-support';
import type { OperationalOutcome } from './operational-lifecycle';

// --- Confidence ---------------------------------------------------------------

export interface DecisionConfidence {
  strength: EvidenceStrength;
  label: string;
  /**
   * What the strength is BASED ON, in countable terms. An operator who disagrees
   * with a confidence badge needs to see what produced it, or the badge is just
   * a colour.
   */
  basis: string[];
  /**
   * Present when the ordering itself was made on partial information. Distinct
   * from evidence strength: a finding can rest on excellent evidence while the
   * ranking that put it first ran on half its inputs.
   */
  determinacyNote: string | null;
}

/**
 * How much an operator should trust this decision.
 *
 * The strength is the WORST across the merged findings, never the best or the
 * average. A Situation is a claim about all of its members, so it can only be as
 * trustworthy as its weakest one — and averaging would let two strong findings
 * launder a third that the engine explicitly declared insufficient.
 */
export function confidenceOf(situation: Situation): DecisionConfidence {
  const strengths = situation.cards.map((c) => c.evidenceStrength);
  const strength: EvidenceStrength = strengths.length
    ? strengths.reduce((worst, s) =>
        EVIDENCE_STRENGTH_RANK[s] > EVIDENCE_STRENGTH_RANK[worst] ? s : worst,
      )
    : 'INSUFFICIENT';

  const evidenceCount = situation.observations.reduce(
    (n, f) => n + f.supportingEvidence.length,
    0,
  );
  const entities = new Set(
    situation.observations.flatMap((f) => f.affectedEntities.map((e) => e.entityId)),
  );

  const basis: string[] = [];
  basis.push(
    `${situation.observationCount} observation${situation.observationCount === 1 ? '' : 's'} merged`,
  );
  if (evidenceCount > 0) {
    basis.push(`${evidenceCount} measured value${evidenceCount === 1 ? '' : 's'}`);
  }
  if (entities.size > 1) basis.push(`${entities.size} entities affected`);

  // Limitations are part of the basis, not a footnote. A confidence badge shown
  // beside a hidden caveat is how a hedged claim becomes a confident one.
  const limitations = new Set(situation.observations.flatMap((f) => f.limitations));
  if (limitations.size > 0) {
    basis.push(`${limitations.size} stated limitation${limitations.size === 1 ? '' : 's'}`);
  }
  if (situation.escalation.withheld) {
    basis.push('no prior-period comparison in this analysis');
  }

  const determinacy = situation.score.determinacy;
  return {
    strength,
    label: EVIDENCE_STRENGTH_LABEL[strength],
    basis,
    determinacyNote:
      determinacy < 1
        ? `Ranked on ${Math.round(determinacy * 100)}% of the scoring model — the rest could not be measured for this period.`
        : null,
  };
}

// --- Why this matters ---------------------------------------------------------

/**
 * The operational consequence, in one sentence.
 *
 * Operators think in consequences, not in deltas: "1039 moved from #1 to #6"
 * means nothing until it is "44% of buyer revenue now sits with one buyer".
 *
 * Composed ONLY from what the engine measured. `ifIgnored` is arithmetic on an
 * observed rate under a stated condition; `impact.statement` states measured
 * exposure. Neither is a forecast, and there is deliberately no branch here that
 * says what ACTING would achieve — that needs a counterfactual whose constraints
 * (contracts, capacity, budgets, intent) Loop cannot see, and a number there
 * would be read as a recovery estimate.
 *
 * Returns null when the Situation carries no measurable consequence, so the card
 * omits the block rather than filling it with a restatement of the title.
 */
export function whyItMatters(situation: Situation): string | null {
  const impact = situation.impact;

  // An exposure or concentration statement already IS the consequence.
  if (
    impact.amountCents !== null
    && (impact.kind === 'revenue_exposure' || impact.kind === 'concentration')
  ) {
    return impact.statement;
  }

  // Otherwise the strongest measured consequence is what continues if nobody
  // acts — which the engine only produces when it can do the arithmetic.
  if (situation.ifIgnored) return situation.ifIgnored;

  if (impact.amountCents !== null) return impact.statement;

  return null;
}

// --- Expected outcome ---------------------------------------------------------

export interface ExpectedOutcome {
  value: OperationalOutcome;
  label: string;
}

/**
 * The ways this decision can legitimately end.
 *
 * Every decision should have a visible end, so an operator opening a card knows
 * what "done" looks like before starting. These are not suggestions and Loop
 * does not predict which one will happen — they are the lifecycle's terminal
 * states, phrased in business language.
 *
 * The set is narrowed by what the engine actually established: a Situation with
 * insufficient evidence offers "Loop should not have raised it" prominently,
 * because that is the most likely honest ending and burying it would suppress
 * the feedback the intelligence needs most.
 */
export function expectedOutcomes(situation: Situation): ExpectedOutcome[] {
  const measurable = situation.impact.amountCents !== null;
  const weak =
    situation.cards.some((c) => c.evidenceStrength === 'INSUFFICIENT')
    || situation.cards.every((c) => c.evidenceStrength === 'LOW');

  const out: ExpectedOutcome[] = [];

  if (weak) {
    out.push({ value: 'FALSE_POSITIVE', label: 'Loop should not have raised this' });
  }

  out.push({ value: 'NO_ACTION_NEEDED', label: 'Confirmed acceptable — no action needed' });

  if (measurable) {
    out.push({ value: 'RECOVERED', label: 'Acted, and the measure returned' });
    out.push({ value: 'PARTIALLY_RECOVERED', label: 'Acted, and it partly returned' });
    out.push({ value: 'NOT_RECOVERED', label: 'Acted, and it did not return' });
  }

  out.push({ value: 'ACCEPTED_RISK', label: 'Real, and the business accepts it' });
  out.push({ value: 'NOT_ACTIONABLE', label: 'Real, and nothing can be done' });
  out.push({ value: 'CONVERTED_TO_WORK', label: 'Became work somewhere else' });

  if (!weak) {
    out.push({ value: 'FALSE_POSITIVE', label: 'Loop should not have raised this' });
  }

  out.push({ value: 'DUPLICATE', label: 'Already tracked by another decision' });
  out.push({ value: 'UNKNOWN', label: 'Closed without a known outcome' });

  return out;
}

// --- Tiering ------------------------------------------------------------------
//
// Nothing is ever hidden behind "N more tracked". Everything is on the page; the
// difference is how much room it gets. An operator who suspects the product is
// withholding items stops trusting the count, and then stops trusting the queue.

export type DecisionTier = 'PRIMARY' | 'ACTIVE' | 'MONITORING' | 'CLOSED';

export interface TieredDecisions<T> {
  /** The few that get full cards. */
  primary: T[];
  /** Still undecided, compact. */
  active: T[];
  /** Owned or watched — someone has it; one line each. */
  monitoring: T[];
  /** Closed this period, collapsed. */
  closed: T[];
}

export const PRIMARY_TIER_SIZE = 3;

/**
 * Split decisions into visual tiers WITHOUT dropping any.
 *
 * The counts are conserved by construction and asserted by test: the four tiers
 * always sum to the input length. This is the guarantee that makes the queue an
 * inbox rather than a report — a report may summarise, an inbox may not.
 */
export function tierDecisions<T>(
  items: readonly T[],
  classify: (item: T) => { undecided: boolean; closed: boolean },
  primarySize: number = PRIMARY_TIER_SIZE,
): TieredDecisions<T> {
  const primary: T[] = [];
  const active: T[] = [];
  const monitoring: T[] = [];
  const closed: T[] = [];

  for (const item of items) {
    const c = classify(item);
    if (c.closed) closed.push(item);
    else if (!c.undecided) monitoring.push(item);
    else if (primary.length < Math.max(0, primarySize)) primary.push(item);
    else active.push(item);
  }

  return { primary, active, monitoring, closed };
}
