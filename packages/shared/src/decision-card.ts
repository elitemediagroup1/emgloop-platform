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
import type { LifecycleHistory, OperationalOutcome, PriorityState } from './operational-lifecycle';

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
  out.push({ value: 'MERGED', label: 'Merged into another decision' });
  out.push({ value: 'SUPPRESSED', label: 'Real, and Loop should stop raising it' });
  out.push({ value: 'EXPIRED', label: 'Stopped on its own before anyone acted' });
  out.push({ value: 'UNKNOWN', label: 'Too early to tell — no known outcome yet' });

  return out;
}

// --- Outcome choices, grouped -------------------------------------------------
//
// The same outcomes, bucketed by the question an operator is actually answering:
// did we act, was it fine, was Loop wrong, is it tracked elsewhere. A flat list
// of thirteen enum labels is a data-entry form; four short groups is a question.
//
// The grouping is presentation ONLY. Every value still posts the same enum to
// the same server action, and no group narrows the set — a test asserts that
// grouping conserves every choice, for the same reason tiering conserves every
// decision.

export type OutcomeGroupKey = 'ACTED' | 'ACCEPTED' | 'WRONG' | 'ELSEWHERE' | 'OPEN';

export interface OutcomeChoiceGroup {
  key: OutcomeGroupKey;
  label: string;
  choices: ExpectedOutcome[];
}

const OUTCOME_GROUP: Record<OperationalOutcome, OutcomeGroupKey> = {
  RECOVERED: 'ACTED',
  PARTIALLY_RECOVERED: 'ACTED',
  NOT_RECOVERED: 'ACTED',
  NO_ACTION_NEEDED: 'ACCEPTED',
  ACCEPTED_RISK: 'ACCEPTED',
  NOT_ACTIONABLE: 'ACCEPTED',
  FALSE_POSITIVE: 'WRONG',
  DUPLICATE: 'ELSEWHERE',
  MERGED: 'ELSEWHERE',
  SUPPRESSED: 'ELSEWHERE',
  CONVERTED_TO_WORK: 'ELSEWHERE',
  EXPIRED: 'OPEN',
  UNKNOWN: 'OPEN',
};

const OUTCOME_GROUP_LABEL: Record<OutcomeGroupKey, string> = {
  ACTED: 'Someone acted',
  ACCEPTED: 'No action was needed',
  WRONG: 'Loop was wrong',
  ELSEWHERE: 'Handled somewhere else',
  OPEN: 'Ended on its own, or not yet known',
};

/**
 * The outcomes for this decision, grouped for a single intentional choice.
 *
 * Group ORDER is inherited from `expectedOutcomes`, not fixed here, so the rule
 * that a weakly-evidenced decision leads with "Loop should not have raised this"
 * survives the regrouping instead of being quietly reversed by an alphabetical
 * table. There is one source of truth for which endings are offered and in what
 * order; this only decides where the dividing lines fall.
 */
export function outcomeChoices(situation: Situation): OutcomeChoiceGroup[] {
  const ordered = expectedOutcomes(situation);
  const groups = new Map<OutcomeGroupKey, ExpectedOutcome[]>();

  for (const choice of ordered) {
    const key = OUTCOME_GROUP[choice.value];
    const bucket = groups.get(key);
    // `expectedOutcomes` deliberately positions FALSE_POSITIVE by evidence
    // strength, so it can appear once in either of two places. Keep the first.
    if (bucket) {
      if (!bucket.some((c) => c.value === choice.value)) bucket.push(choice);
      continue;
    }
    groups.set(key, [choice]);
  }

  return [...groups.entries()].map(([key, choices]) => ({
    key,
    label: OUTCOME_GROUP_LABEL[key],
    choices,
  }));
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

// --- Ownership ----------------------------------------------------------------
//
// Owner, assignee and state are three independent dimensions in the engine, and
// the surface rendered them in four different places with four different
// vocabularies — the state badge showed the assignee, a chip showed the owner
// labelled "accountable", the standing block showed the owner labelled "status".
// A reader glancing at a card could not tell who ANSWERS for something from who
// is DOING it, which is the whole distinction those two columns exist to carry.
//
// One function, one vocabulary, every surface.

/** Where a decision stands as a person would describe it. */
export type OwnershipStanding = 'UNOWNED' | 'OWNED' | 'IN_PROGRESS' | 'CLOSED';

export interface Ownership {
  standing: OwnershipStanding;
  /** Who answers for it. Accountability, and it changes rarely. */
  accountable: string | null;
  /** Who is working it now. Execution, and it changes often. */
  working: string | null;
  /** The badge. Short enough to sit beside a title. */
  label: string;
  /** The full sentence, for the places that have room for one. */
  detail: string;
}

export function ownershipOf(input: {
  state: PriorityState;
  accountable: string | null;
  working: string | null;
}): Ownership {
  const { state, accountable, working } = input;

  if (state === 'RESOLVED' || state === 'DISMISSED') {
    return {
      standing: 'CLOSED',
      accountable,
      working: null,
      label: state === 'RESOLVED' ? 'Resolved' : 'Dismissed',
      detail: accountable
        ? `Closed. ${accountable} answered for it.`
        : 'Closed. Nobody was recorded as accountable.',
    };
  }

  if (working) {
    return {
      standing: 'IN_PROGRESS',
      accountable,
      working,
      label: `${working} is on it`,
      detail:
        accountable && accountable !== working
          ? `${working} is working it. ${accountable} answers for it.`
          : `${working} is working it, and answers for it.`,
    };
  }

  if (accountable) {
    return {
      standing: 'OWNED',
      accountable,
      working: null,
      label: `${accountable} owns it`,
      detail: `${accountable} answers for it. Nobody is recorded as working it yet.`,
    };
  }

  return {
    standing: 'UNOWNED',
    accountable: null,
    working: null,
    label: 'Nobody owns this',
    // Said plainly on purpose. An unowned decision is the one thing on the page
    // most likely to be nobody's problem until it is everybody's.
    detail: 'No one answers for this yet. Assigning it is the decision.',
  };
}

// --- How this went last time --------------------------------------------------

/**
 * What happened the last time somebody closed this, in one sentence.
 *
 * Shown BEFORE the resolve control, because an operator about to close something
 * for the fourth time should see that the previous three resolutions did not
 * hold. This is the payoff of an append-only log: nothing here is computed, it
 * is read back.
 *
 * Returns null when there is no prior closure — never a placeholder, because
 * "first time" is already said by the card's own standing block.
 */
export function priorClosure(
  history: LifecycleHistory | null,
  labelOf: (outcome: OperationalOutcome) => string,
): string | null {
  if (!history) return null;

  const recorded = history.recordedOutcomes.filter((o) => o.outcome !== null);
  const last = recorded.length > 0 ? recorded[recorded.length - 1] : null;
  if (!last?.outcome) return null;

  const parts = [`Last recorded outcome: ${labelOf(last.outcome).toLowerCase()}.`];

  if (history.timesReopened > 0) {
    parts.push(
      `It came back ${history.timesReopened} time${history.timesReopened === 1 ? '' : 's'} after being closed.`,
    );
  }
  if (last.cents !== null) {
    const amount = '$' + Math.round(Math.abs(last.cents) / 100).toLocaleString('en-US');
    parts.push(`${amount} was measured against it.`);
  }

  return parts.join(' ');
}

// --- Unknowns, grouped --------------------------------------------------------
//
// A flat list of a dozen caveats reads as a wall and gets skipped, which is the
// worst possible outcome for the block that makes the rest of the page
// believable. Grouping turns it from a disclaimer into something an operator can
// learn the shape of: what the DATA cannot say, what the BUSINESS does that Loop
// cannot see, what needs TIME, and where Loop's own model withheld.
//
// The grouping keys off the stable ids the engines already emit. It invents no
// taxonomy of its own and adds no field to the contract — and `unknownGroupOf`
// is exported so a test can walk every id the engines produce and fail when one
// falls through to OTHER. Without that guard this table would silently rot the
// first time a rule is added, which is exactly how a presentation layer starts
// lying about coverage.

export type UnknownGroupKey = 'DATA' | 'BUSINESS' | 'HISTORICAL' | 'PLATFORM' | 'OTHER';

export interface UnknownGroup {
  key: UnknownGroupKey;
  label: string;
  /** What this group means, so the list teaches rather than warns. */
  blurb: string;
  items: { id: string; statement: string; reason: string }[];
}

const UNKNOWN_GROUP_BY_ID: Record<string, UnknownGroupKey> = {
  // What the provider did or did not report.
  'unknown:read-failed': 'DATA',
  'unknown:revenue': 'DATA',
  'unknown:revenue-coverage': 'DATA',
  'unknown:profit-coverage': 'DATA',
  'unknown:roster': 'DATA',
  'bid-unknown:revenue': 'DATA',
  'bid-unknown:grain': 'DATA',
  'bid-unknown:accepted-denominator': 'DATA',
  'bid-unknown:period': 'DATA',
  // How the business actually operates, which no report describes.
  'unknown:causation': 'BUSINESS',
  'bid-unknown:fallback': 'BUSINESS',
  // Things that need more time, or a second period, before they can be said.
  'no-historical-series': 'HISTORICAL',
  'bid-unknown:history': 'HISTORICAL',
  'unknown:no-comparison': 'HISTORICAL',
  'unknown:in-progress': 'HISTORICAL',
};

const UNKNOWN_GROUP_LABEL: Record<UnknownGroupKey, string> = {
  DATA: 'What the data does not carry',
  BUSINESS: 'What Loop cannot see about the business',
  HISTORICAL: 'What needs more time',
  PLATFORM: 'Where Loop held back on purpose',
  OTHER: 'Everything else Loop could not determine',
};

const UNKNOWN_GROUP_BLURB: Record<UnknownGroupKey, string> = {
  DATA: 'The provider did not report these fields. Loop shows them as unknown rather than as zero.',
  BUSINESS: 'Routing, caps, budgets, schedules and intent are decisions people make outside any report Loop reads.',
  HISTORICAL: 'These become answerable as periods complete. Nothing is wrong; there is not enough history yet.',
  PLATFORM: 'A model that cannot measure a factor withholds it rather than scoring it safe. This is what it withheld.',
  OTHER: 'Recorded so nothing is dropped. If anything lands here, its group is missing from the table.',
};

/** Which group an unknown belongs to, by the id its engine emitted. */
export function unknownGroupOf(id: string): UnknownGroupKey {
  const exact = UNKNOWN_GROUP_BY_ID[id];
  if (exact) return exact;
  // Risk unknowns are emitted with an index (`risk-unknown-1`, `-2`, …), so they
  // are matched by prefix rather than enumerated.
  if (id.startsWith('risk-unknown')) return 'PLATFORM';
  return 'OTHER';
}

const UNKNOWN_GROUP_ORDER: readonly UnknownGroupKey[] = [
  'DATA',
  'BUSINESS',
  'HISTORICAL',
  'PLATFORM',
  'OTHER',
];

/**
 * Bucket unknowns for display. Conserves every item, like every other tiering
 * function here — an empty group is dropped, an unrecognised id is not.
 */
export function groupUnknowns(
  unknowns: readonly { id: string; statement: string; reason: string }[],
): UnknownGroup[] {
  return UNKNOWN_GROUP_ORDER.map((key) => ({
    key,
    label: UNKNOWN_GROUP_LABEL[key],
    blurb: UNKNOWN_GROUP_BLURB[key],
    items: unknowns.filter((u) => unknownGroupOf(u.id) === key).map((u) => ({ ...u })),
  })).filter((g) => g.items.length > 0);
}

// --- Today's story ------------------------------------------------------------

export interface StoryDigest {
  /** The first sentence, promoted to a headline. */
  headline: string;
  /** Up to three whole cluster narratives. Never truncated — see below. */
  bullets: string[];
  /** The remainder of the narrative, verbatim, behind "Read more". */
  rest: string | null;
  /** Bullets not shown, disclosed rather than dropped. */
  moreCount: number;
}

/**
 * The business narrative as a headline and three bullets instead of a paragraph.
 *
 * Bullets are WHOLE cluster narratives. Truncating them to fit a bullet is the
 * one thing this must not do: these sentences carry their own hedging ("cannot
 * be attributed", "over 3 complete periods"), and a clipped hedge reads as a
 * confident claim. If a narrative is long, it stays long.
 *
 * The headline is a split of an existing deterministic string, never a new one.
 * When the text will not split cleanly the whole story becomes the headline and
 * `rest` is null — a page with one long sentence is fine; an invented short one
 * is not.
 */
export function storyDigest(
  businessStory: string,
  narratives: readonly string[],
  maxBullets = 3,
): StoryDigest {
  const story = businessStory.trim();
  // First sentence: terminal punctuation, whitespace, then a new sentence. The
  // lookahead keeps decimals ("18.4%") and money ("$1,980.50") from splitting.
  const match = /^(.+?[.!?])\s+(?=["“(]?[A-Z0-9$])/.exec(story);
  const headline = match?.[1] ?? story;
  const rest = match ? story.slice(match[0].length).trim() : '';

  const bullets = narratives.slice(0, Math.max(0, maxBullets)).map((n) => n.trim());

  return {
    headline,
    bullets,
    rest: rest.length > 0 ? rest : null,
    moreCount: Math.max(0, narratives.length - bullets.length),
  };
}
