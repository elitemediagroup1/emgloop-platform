// The Headline contract, v1 -- a measured development in an objective's world.
//
// WHAT A HEADLINE IS. "Something measurable changed in this objective's world,
// and here is the evidence." That is the whole of it.
//
// WHAT A HEADLINE IS NOT. It is NOT a Decision. A Decision means the organization
// has judged a matter and is doing something about it, and that judgement is a
// human act performed later, on purpose, in the Decision Center. A Headline
// carries awareness; it carries no obligation.
//
// THIS IS A PERSISTED OBJECT WITH NO WORK LIFECYCLE, and the distinction is the
// entire design. A Headline may never gain:
//
//   ownerUserId · assigneeUserId · a queue lane · a state machine ·
//   OperationalOutcome · a reopen counter · an observation log · Work OS behaviour
//
// The moment any of those is proposed, the right answer is that the thing being
// modelled is a Decision and `OperationalPriority` already exists for it. That is
// the tripwire, and it is written here so a later reader hits it before the
// migration does.
//
// WHY IT IS NOT AN OperationalPriority TODAY. Because the Decision Center's
// vocabulary is a PROBLEM vocabulary: `impactLabel` is documented as "exposure,
// decline, gap. Never 'upside'", and every `OperationalOutcome` member is a
// remediation verb. "Roofing lead revenue rose 38%" is real, important, and has
// nowhere honest to sit in a lane that ends in RESOLVED. Separating the two also
// keeps two different learning signals apart: whether something deserved
// ATTENTION, and whether ACTING on it worked.
//
// IDENTITY IS TIMESTAMP-FREE. A persisting condition resights the same Headline
// rather than producing one row per period -- the discipline
// `OperationalPriority.recurrenceKey` established ("never from a timestamp ...
// which is what makes 'this is the third time this month' a fact rather than an
// impression"). The window a measurement covers is EVIDENCE, not identity.
//
// PRISMA-FREE, deliberately, like every other contract in this package.

import type { MeasureMetric, MeasureUnit } from './objective-measure-binding';
import type { MeasureMovement } from './commercial-measurement';

export const HEADLINE_CONTRACT_VERSION = 'headline.v1';

// --- Dismissal ------------------------------------------------------------------

/**
 * Why a human dismissed a Headline. ATTENTION FEEDBACK, NOT AN OUTCOME.
 *
 * DELIBERATELY NOT `OperationalOutcome`, and the two must never be merged. That
 * vocabulary answers "what happened when we acted" -- RECOVERED, ACCEPTED_RISK,
 * NO_ACTION_NEEDED, CONVERTED_TO_WORK. This one answers a question asked BEFORE
 * anybody acted: "was this worth putting in front of me at all?"
 *
 * Exactly two members, because they drive two different fixes:
 *
 *   WRONG       -- retune DETECTION. The binding, the population, the arithmetic
 *                  or the threshold produced something that is not true.
 *   IMMATERIAL  -- retune ATTENTION. It is true and correctly computed, and it
 *                  still was not worth surfacing.
 *
 * ACCEPTED_RISK and NO_ACTION_NEEDED are absent on purpose: both assert a
 * judgement about what the organization will DO, which is Decision semantics and
 * belongs to a promotion Stage 3 v1 does not implement.
 */
export const HEADLINE_DISMISSAL_BASES = ['WRONG', 'IMMATERIAL'] as const;
export type HeadlineDismissalBasis = (typeof HEADLINE_DISMISSAL_BASES)[number];

export function isHeadlineDismissalBasis(v: string): v is HeadlineDismissalBasis {
  return (HEADLINE_DISMISSAL_BASES as readonly string[]).includes(v);
}

export const HEADLINE_DISMISSAL_BASIS_LABELS: Record<HeadlineDismissalBasis, string> = {
  WRONG: 'Loop got this wrong',
  IMMATERIAL: 'Correct, but not worth surfacing',
};

export const HEADLINE_DISMISSAL_BASIS_HELP: Record<HeadlineDismissalBasis, string> = {
  WRONG: 'The measurement, the selected population or the detection itself was incorrect.',
  IMMATERIAL: 'The measurement is right. This simply did not need my attention.',
};

// --- Identity -------------------------------------------------------------------

/**
 * The recurrence key: what makes tomorrow's sighting the SAME development.
 *
 * Composed from the binding version, the metric, the rule and the DIRECTION of
 * the move -- and from no timestamp, ever.
 *
 * Why the binding version is in the key: superseding a binding changes what is
 * being measured, so the development after the change is genuinely a different
 * one. Starting a fresh lineage is honest; silently continuing the old row under
 * a new definition would make its history unreadable.
 *
 * Why the movement is in the key: "revenue fell" and "revenue rose" are two
 * different statements about the world. An oscillating measure should produce two
 * Headlines that each accumulate their own recurrence, not one row whose meaning
 * inverts week to week.
 */
export function headlineRecurrenceKey(input: {
  measureBindingId: string;
  metric: MeasureMetric;
  ruleId: string;
  movement: MeasureMovement;
}): string {
  return [input.measureBindingId, input.metric, input.ruleId, input.movement].join(':');
}

/**
 * The per-period detection key: what makes a re-run idempotent.
 *
 * Derived from the START of the completed comparison window, as an Eastern
 * calendar date, so every run over the same completed period produces the same
 * key no matter how many times a server-rendered page is refreshed. This is the
 * same device `OperationalObservation.detectionKey` uses, and it exists for the
 * same reason: without it, a refresh manufactures a sighting.
 *
 * The date is formatted from the window boundary the caller already resolved
 * through `business-time.ts`; this function does not consult a clock.
 */
export function headlineDetectionKey(currentWindowStart: Date): string {
  return `ci-7d:${currentWindowStart.toISOString().slice(0, 10)}`;
}

// --- The view --------------------------------------------------------------------

/**
 * One Headline, as every caller outside the persistence layer sees it.
 *
 * FACT AND FRAMING ARE STRUCTURALLY SEPARATE, the shape `CommercialSignalView`
 * established. `measurement` is what was computed; `statement` is a sentence
 * composed from it for a human to read. A reader must always be able to check the
 * second against the first, and nothing downstream may consume the sentence.
 *
 * Dates are ISO strings, matching every other repository view in this platform.
 */
export interface HeadlineView {
  id: string;
  performanceObjectiveId: string;
  /** Denormalized for display only -- the objective's title is the objective's. */
  objectiveTitle: string | null;
  /** The EXACT binding version this was produced under. Never the latest one. */
  measureBindingId: string;
  measureBindingVersion: number;

  /** WHAT LOOP MEASURED. Every field traces to rows in the source domain. */
  measurement: {
    metric: MeasureMetric;
    metricLabel: string;
    unit: MeasureUnit;
    movement: MeasureMovement;
    /** True when the move runs against the objective's stated direction. */
    againstObjective: boolean;
    currentValue: number | null;
    priorValue: number | null;
    absoluteChange: number | null;
    /** A fraction, not a percentage. Null when there was no non-zero baseline. */
    percentageChange: number | null;
    currentDenominator: number;
    priorDenominator: number;
    /** 0-1, or null where the metric has no coverage concept. */
    currentCoverage: number | null;
    priorCoverage: number | null;
    comparisonBasis: string;
    currentWindowStart: string;
    currentWindowEnd: string;
    priorWindowStart: string;
    priorWindowEnd: string;
  };

  /**
   * The measured development in one line. DISPLAY ONLY.
   *
   * Composed deterministically from the numbers above. NO EVALUATOR, RULE OR
   * FUTURE MEASUREMENT MAY READ THIS FIELD -- it contains Loop's own words, and
   * Stage 2 already shipped a defect where CI-authored text became the evidence
   * for CI's own conclusion. Loop may explain its evidence; it may not
   * manufacture the evidence that justifies it.
   */
  statement: string;

  /** What this measurement cannot support, and what it leaves open. */
  limitations: string[];
  unknowns: string[];

  /** Which rule fired, at which version, from which build of the producer. */
  ruleId: string;
  ruleVersion: string;
  producerVersion: string;
  /** The rule's own threshold, stated so a reader can check it was met. */
  ruleDescription: string;

  /** Recurrence. Established once; only these three ever move. */
  firstDetectedAt: string;
  lastDetectedAt: string;
  detectionCount: number;

  /** Attention feedback. Dismissal never reopens and never suppresses recurrence. */
  dismissedAt: string | null;
  dismissedByUserId: string | null;
  dismissedByName: string | null;
  dismissalBasis: HeadlineDismissalBasis | null;

  createdAt: string;
}

/** True when a Headline is still being detected and nobody has dismissed it. */
export function isHeadlineOpen(h: Pick<HeadlineView, 'dismissedAt'>): boolean {
  return h.dismissedAt === null;
}

/**
 * How the move reads in one word, for a surface that wants a chip.
 *
 * Describes the RELATIONSHIP TO THE STATED DIRECTION, never a judgement about the
 * business. "Against the objective" is a fact about arithmetic and a human's own
 * declared intent; "bad" would be a claim Loop has no standing to make.
 */
export function headlineTone(h: Pick<HeadlineView, 'measurement'>): 'WITH' | 'AGAINST' {
  return h.measurement.againstObjective ? 'AGAINST' : 'WITH';
}

export const HEADLINE_TONE_LABELS: Record<'WITH' | 'AGAINST', string> = {
  WITH: 'With the objective',
  AGAINST: 'Against the objective',
};
