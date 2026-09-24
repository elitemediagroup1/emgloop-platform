// Where a Headline stands -- a PROJECTION over two authorities, never a state.
//
// WHAT THIS IS. One pure function that answers "where does this Headline stand
// right now" by reading TWO records that already exist and combining them:
//
//   the Headline        open or dismissed, with a basis  (`headline.ts`)
//   the Case, if any    the OperationalPriority opened from it -- its lane, its
//                       outcome, when it closed          (`operational-lifecycle.ts`)
//
// WHAT THIS IS NOT, AND WHY IT MATTERS. It is NOT a Headline lifecycle. The
// Headline contract says so in its own header: a Headline is "a persisted object
// with no work lifecycle, and the distinction is the entire design". Nothing in
// this file is stored. There is no column for the answer, no transition, no
// state machine, no event, and no way to set a situation -- it is re-derived on
// every read from the two records that own the facts, so it can never disagree
// with either of them and can never be edited into a lie. The moment somebody
// proposes persisting the result, the right answer is the tripwire in
// `headline.ts`: the thing being modelled is a Decision, and `OperationalPriority`
// already is one.
//
// WHY A HEADLINE NEVER "RESOLVES" ON ITS OWN. Resolution is a Case's word. A
// Headline records that something measurable changed and keeps being resighted
// whether or not anyone acted; whether the ORGANIZATION dealt with it is a fact
// about the investigation, which is why RESOLVED here requires the Case's lane to
// say RESOLVED -- an outcome or a `resolvedAt` alone does not make it so, and a
// reopened Case (lane back to NEEDS_REVIEW, `resolvedAt` cleared by the
// projection) reads as under investigation again.
//
// WHY SET ASIDE BEATS A CASE. Dismissal is a person's attention feedback about
// THIS Headline: "this did not need my attention". That statement stands whatever
// happened in the Decision Center, and a surface that showed such a Headline as
// "under investigation" would be overriding the one judgement a person made about
// it directly. The Case still exists and is still linked; the situation says what
// the person said.
//
// RESOLVED DOES NOT MEAN DELETED. Every situation is a place in one list. A
// resolved, dismissed or set-aside Headline is history the workspace keeps and
// shows, not a row that goes away.
//
// PRISMA-FREE, PURE. No clock, no I/O, no store.

import type { HeadlineDismissalBasis } from './headline';
import type { OperationalOutcome, PriorityState } from './operational-lifecycle';
import { isClosed } from './operational-lifecycle';

export const HEADLINE_SITUATION_VERSION = 'headline-situation.v1';

/**
 * The five places a Headline can stand. Derived, in this order of precedence:
 * the Headline's own dismissal first, then the Case's lane, then nothing.
 */
export const HEADLINE_SITUATIONS = [
  /** Measured, open, and nobody has decided anything about it. */
  'NEW',
  /** A person authorized an investigation and its Case is still open. */
  'UNDER_INVESTIGATION',
  /** The Case closed, having acted. Its lane says RESOLVED. */
  'RESOLVED',
  /** The Case closed because it did not need action. Its lane says DISMISSED. */
  'DISMISSED_BY_INVESTIGATION',
  /** A person recorded that this Headline did not need attention, with a basis. */
  'SET_ASIDE',
] as const;

export type HeadlineSituation = (typeof HEADLINE_SITUATIONS)[number];

export function isHeadlineSituation(v: string): v is HeadlineSituation {
  return (HEADLINE_SITUATIONS as readonly string[]).includes(v);
}

/** The Headline facts the projection reads. Nothing else on the record matters to it. */
export interface HeadlineStandingInput {
  dismissedAt: string | null;
  dismissalBasis: HeadlineDismissalBasis | null;
}

/**
 * The Case facts the projection reads -- the lifecycle columns the Decision
 * Center projects from its own append-only log. Read, never written, here.
 */
export interface CaseStandingInput {
  state: PriorityState;
  outcome: OperationalOutcome | null;
  resolvedAt: string | null;
}

/**
 * Where the Headline stands, from the two authorities.
 *
 * `kase` is null when no investigation was ever opened from this Headline. It is
 * spelled that way because `case` is a reserved word, and because the product's
 * word for an OperationalPriority is Case.
 */
export function headlineSituation(
  headline: HeadlineStandingInput,
  kase: CaseStandingInput | null,
): HeadlineSituation {
  // THE PERSON'S OWN JUDGEMENT ABOUT THIS HEADLINE COMES FIRST. See the header.
  if (headline.dismissedAt !== null) return 'SET_ASIDE';
  if (kase === null) return 'NEW';
  // THE LANE DECIDES, not the outcome column and not `resolvedAt`. Both are set
  // by the same projection that sets the lane, and a reopen clears the lane while
  // the log keeps the earlier close -- so the lane is the only column that says
  // what is true NOW.
  if (!isClosed(kase.state)) return 'UNDER_INVESTIGATION';
  return kase.state === 'RESOLVED' ? 'RESOLVED' : 'DISMISSED_BY_INVESTIGATION';
}

/** True while something can still happen to it: nobody has closed the question. */
export function isCurrentSituation(situation: HeadlineSituation): boolean {
  return situation === 'NEW' || situation === 'UNDER_INVESTIGATION';
}

/**
 * The three sections of the Headlines workspace. One list, three places, and
 * nothing falls off the end: history is a section, not an archive.
 */
export const HEADLINE_SECTIONS = ['CURRENT', 'INVESTIGATING', 'HISTORY'] as const;
export type HeadlineSection = (typeof HEADLINE_SECTIONS)[number];

export function headlineSection(situation: HeadlineSituation): HeadlineSection {
  switch (situation) {
    case 'NEW':
      return 'CURRENT';
    case 'UNDER_INVESTIGATION':
      return 'INVESTIGATING';
    case 'RESOLVED':
    case 'DISMISSED_BY_INVESTIGATION':
    case 'SET_ASIDE':
      return 'HISTORY';
  }
}

/**
 * What the workspace may offer on a Headline in each situation.
 *
 * ONLY A NEW HEADLINE TAKES A DECISION. Investigate and Set aside are answers to
 * "does this deserve attention", and that question is closed the moment a
 * person answers it either way. Everything else is a link to the record that now
 * carries the answer.
 */
export function headlineAcceptsDecision(situation: HeadlineSituation): boolean {
  return situation === 'NEW';
}
