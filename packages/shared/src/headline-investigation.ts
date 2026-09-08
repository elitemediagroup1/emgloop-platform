// Turning a Headline into an authorized investigation — the pure part.
//
// A HEADLINE IS AN ATTENTION SURFACE. A CASE IS AN AUTHORIZED INVESTIGATION.
// Loop produces the first on its own; only a person produces the second. Every
// other path — generating a Headline, viewing one, opening its evidence, an
// eventual model recommending that somebody look — creates nothing. That is not
// a policy this file enforces; it is a consequence of there being exactly one
// function anywhere that derives an investigation identity, and it living behind
// a service that requires an attributed human.
//
// WHY THIS IS PURE. The identity of an investigation, the severity a Headline
// maps to, and the vocabulary of what a promotion can do are decisions, not I/O.
// Keeping them here means they can be exercised without a database and cannot
// drift between the service and whatever calls it.
//
// VOCABULARY. `Case` is the product's word. The architecture's word is
// `OperationalPriority`, and nothing here renames it: the Decision Center is
// producer-neutral platform machinery that CallGrid, accounting and website
// intelligence all open threads in, and renaming it after one producer's product
// language would be the wrong direction of coupling. This file names the act
// (`promote`), not the destination.

import { CASE_EVENT_REASONS, isCaseEvent } from './case-observation';

/** How a promotion attempt ended. Four answers, and only one of them writes. */
export const PROMOTION_OUTCOMES = [
  /** A new investigation was opened by this authorization. */
  'PROMOTED',
  /**
   * This Headline is already under investigation, so nothing was written.
   *
   * NOT AN ERROR. A person pressing the same button twice, or two people
   * pressing it at once, both mean the same thing: the organization has decided
   * to look at this. The second attempt returns the investigation that exists.
   */
  'ALREADY_INVESTIGATING',
  /**
   * No such Headline in this organization.
   *
   * NOT-FOUND, NEVER FORBIDDEN. A Headline belonging to another tenant answers
   * exactly as a Headline that does not exist, so the response cannot be used to
   * discover that other tenants have one.
   */
  'HEADLINE_NOT_FOUND',
  /** The request could not name a human. Nothing was read and nothing written. */
  'NO_AUTHORIZING_HUMAN',
] as const;

export type PromotionOutcome = (typeof PROMOTION_OUTCOMES)[number];

/** True when this outcome means an investigation exists to navigate to. */
export function promotionOpenedOrFoundCase(outcome: PromotionOutcome): boolean {
  return outcome === 'PROMOTED' || outcome === 'ALREADY_INVESTIGATING';
}

/**
 * The producer name a promoted Headline opens its investigation under.
 *
 * The Decision Center keys identity on `(organization, sourceSystem,
 * recurrenceKey)`, so this is half of what makes a promotion idempotent. It names
 * COMMERCIAL INTELLIGENCE rather than CallGrid: the Headline is a CI concept and
 * a second CallGrid-shaped producer string would make the queue lie about where
 * the thread came from.
 */
export const INVESTIGATION_PRODUCER = 'commercial-intelligence';

/** Which build authorized it, so the log stays interpretable after this changes. */
export const INVESTIGATION_PRODUCER_VERSION = 'headline-investigation.v1';

/**
 * The stable identity of the investigation into one Headline.
 *
 * DERIVED FROM THE HEADLINE, NEVER FROM A CLOCK. That is what makes pressing
 * Investigate twice land on the same row instead of opening a second
 * investigation into the same thing, and it is the same discipline the Decision
 * Center already requires of every producer.
 *
 * ONE HEADLINE, ONE INVESTIGATION. The product today has no notion of two
 * investigations into one Headline under different questions. If it ever does,
 * this function is where that distinction would enter — as a second component of
 * the key, deliberately, so the change is visible rather than emergent.
 */
export function investigationRecurrenceKey(headlineId: string): string {
  return `headline:${headlineId}`;
}

/**
 * The idempotency key for the opening detection row.
 *
 * The Decision Center uses this to make a repeated open a no-op at the database
 * rather than in a caller's `if`. A promotion has no analysis period to name — the
 * authorization IS the event — so the key is the Headline, which makes a
 * concurrent double-press collide and resolve instead of appending twice.
 */
export function investigationDetectionKey(headlineId: string): string {
  return `promotion:${headlineId}`;
}

/**
 * How a Headline's measured development maps onto the shared severity scale.
 *
 * A BOUNDARY MAPPING, AND A DELIBERATELY MODEST ONE. The Decision Center's scale
 * is shared across producers so a cross-producer queue can rank against itself,
 * and producers map their own scale in at the boundary. What a Headline actually
 * knows is whether the move ran against a stated objective — a fact about
 * arithmetic and a human's own declared intent. It does NOT know that a move is
 * HIGH or CRITICAL to the business, so this never returns those: claiming them
 * would be Loop asserting a business judgement it has no standing to make.
 *
 * A person can raise it afterwards. `priority` is separately settable and exists
 * precisely so operator urgency and producer severity never have to agree.
 */
export function severityForHeadline(againstObjective: boolean): 'NOTABLE' | 'INFORMATIONAL' {
  return againstObjective ? 'NOTABLE' : 'INFORMATIONAL';
}

/**
 * Why the investigation was opened, in the log's own words.
 *
 * SAYS WHAT AUTHORIZATION MEANS AND WHAT IT DOES NOT. A person choosing
 * Investigate is saying this deserves organizational attention. They are NOT
 * saying the Headline is correct — those are different facts, and a reason line
 * that blurred them would let a later reader treat a human's curiosity as a
 * human's endorsement.
 */
/**
 * Whether one observation IS the authorization that opened this investigation.
 *
 * THE REASON LINE IS THE SEMANTIC, because the vocabulary has no member for it
 * yet. `REVIEWED` is the existing type for a person having looked and formed a
 * view, and an operator can record one on any thread at any time -- so
 * HUMAN + REVIEWED alone is not authorization, it is somebody reading. What makes
 * this row the authorization is that the promotion wrote
 * INVESTIGATION_AUTHORIZED_REASON onto it.
 *
 * ONE PREDICATE, TWO READERS. The promotion uses it to decide whether an
 * interrupted attempt still needs its human row, and the Case Brief uses it to
 * answer "who authorized this, and when". Two spellings would eventually give two
 * answers to one question, and the answer matters.
 *
 * THE DEDICATED OBSERVATION TYPE NOW EXISTS. This predicate used to be the only
 * thing standing between "somebody read this" and "somebody authorized an
 * investigation", because both were REVIEWED rows telling apart by a sentence.
 * `INVESTIGATION_AUTHORIZED` carries the meaning now, and this delegates to the
 * one module that also knows how the pre-migration rows were written.
 *
 * IT STILL CHECKS THE ACTOR. A machine writing the word is not a person
 * deciding, and the type did not change that.
 */
export function isInvestigationAuthorization(observation: {
  actorType: string;
  observationType: string;
  reason: string | null;
}): boolean {
  return isCaseEvent(observation, 'INVESTIGATION_AUTHORIZED');
}

/**
 * The line written onto the authorization row, for a person reading a timeline.
 *
 * NO LONGER LOAD-BEARING. Until the vocabulary migration this sentence WAS the
 * distinction; `INVESTIGATION_AUTHORIZED` now is, and this is description.
 * It is kept exactly as written, and still written, so history spanning the
 * migration reads continuously.
 */
export const INVESTIGATION_AUTHORIZED_REASON = CASE_EVENT_REASONS.INVESTIGATION_AUTHORIZED;
