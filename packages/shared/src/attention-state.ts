// "Nothing needs your attention" and "I can't tell whether anything does" are
// different sentences, and Loop must never say the first when it means the
// second.
//
// THE FAILURE THIS PREVENTS. An empty Headline list has two causes. Either Loop
// looked at every objective, had current measurement for all of them, and found
// nothing worth raising — or a poller stopped, a source lost its authority, a
// window never completed, and Loop had nothing to look at. Both render as zero
// rows. One is good news and the other is an outage, and a surface that shows
// the same empty state for both will eventually show a clean dashboard through
// a week of missing data. That has already happened here once: eight migrations
// sat unapplied for three weeks because nothing said "I have not checked".
//
// SO AN ALL-CLEAR IS EARNED, NEVER INFERRED FROM ABSENCE. It requires that every
// active objective was actually measurable — Stage 3's own verdict, unchanged
// and re-read — and it names how many were checked. Anything less is
// INSUFFICIENT_COVERAGE, which is not an error state and not a warning; it is
// Loop declining to make a claim it has not earned.
//
// NO MODEL DECIDES THIS. Whether the system has enough evidence to say "nothing
// requires attention" is a count over governed verdicts. It stays a count.
//
// PURE. No clock, no I/O. `now` is not even needed: the caller supplies the
// verdicts it read.

import type { ReadinessOutcome } from './measurement-readiness';

export const ATTENTION_RULE_VERSION = 'attention-state.v1';

export const ATTENTION_STATES = [
  /**
   * There is something to look at. The list is not empty.
   *
   * FIRST IN THE ORDER, DELIBERATELY. A Headline exists only when Stage 3 said
   * the measurement behind it was ready, so its presence is never in doubt even
   * if other objectives are unmeasurable.
   */
  'NEEDS_ATTENTION',
  /**
   * Nothing needs attention, AND Loop could see everything it was asked to see.
   *
   * The only state that is genuinely good news, and the only one that requires
   * a positive answer from every objective rather than the absence of a
   * negative one.
   */
  'ALL_CLEAR',
  /**
   * Loop cannot tell. Some objectives could not be measured.
   *
   * NOT AN ERROR AND NOT A WARNING. It is a refusal to claim something that has
   * not been established, and it is the honest reading of most real mornings.
   */
  'INSUFFICIENT_COVERAGE',
  /**
   * There is nothing to check, because nobody has said what they are trying to
   * accomplish.
   *
   * A REAL FOURTH STATE, and a different conversation. "Everything is fine" and
   * "you have not told me what to watch" are both empty screens and completely
   * different problems, and collapsing them would let a brand-new organization
   * read as a healthy one.
   */
  'NOTHING_TO_CHECK',
] as const;

export type AttentionState = (typeof ATTENTION_STATES)[number];

/** One objective and whether Loop could actually measure it. */
export interface ObjectiveCoverage {
  performanceObjectiveId: string;
  objectiveTitle: string;
  /**
   * Stage 3's verdict, unchanged. NULL means no verdict could be obtained at
   * all — no binding, no source authority, nothing to ask.
   *
   * NULL IS NOT READY. A caller that could not obtain a verdict has not shown
   * the objective was measurable, and the difference between those is the whole
   * point of this file.
   */
  readiness: ReadinessOutcome | null;
  /** The Stage 3 refusals behind a non-READY verdict, carried unchanged. */
  withholdings: readonly string[];
}

export interface AttentionAssessment {
  ruleVersion: string;
  state: AttentionState;
  /** How many objectives Loop was asked to watch. */
  objectivesConsidered: number;
  /** How many it could actually measure. */
  objectivesMeasurable: number;
  /** The ones it could not, by name, so the gap is actionable rather than a number. */
  unmeasurable: readonly ObjectiveCoverage[];
  /** How many Headlines are open. */
  headlineCount: number;
  /** The sentence a surface can render, produced by the same walk as the state. */
  statement: string;
  /** What this assessment could not establish. Empty on ALL_CLEAR, by definition. */
  notKnown: readonly string[];
}

export interface AttentionInput {
  /** Every ACTIVE objective in the organization, with its readiness verdict. */
  objectives: readonly ObjectiveCoverage[];
  /** Open Headlines. Only the count is needed; the list is rendered elsewhere. */
  headlineCount: number;
}

/**
 * Whether Loop may say "nothing needs your attention".
 *
 * THE ORDER IS THE ARGUMENT.
 *
 *   1. A Headline outranks everything. Something is on the list, and coverage
 *      elsewhere does not change that.
 *   2. No objectives at all is NOTHING_TO_CHECK, before coverage is considered —
 *      an empty organization trivially has 100% coverage of nothing, and calling
 *      that all-clear would be the most literal possible way to be wrong.
 *   3. Any unmeasurable objective is INSUFFICIENT_COVERAGE. ANY, not most: one
 *      objective Loop could not see is one place a problem could be sitting.
 *   4. Only then, ALL_CLEAR — and it names what it checked.
 */
export function assessAttention(input: AttentionInput): AttentionAssessment {
  const considered = input.objectives.length;
  const unmeasurable = input.objectives.filter((o) => o.readiness !== 'READY');
  const measurable = considered - unmeasurable.length;

  const base = {
    ruleVersion: ATTENTION_RULE_VERSION,
    objectivesConsidered: considered,
    objectivesMeasurable: measurable,
    unmeasurable,
    headlineCount: input.headlineCount,
  };

  if (input.headlineCount > 0) {
    return {
      ...base,
      state: 'NEEDS_ATTENTION',
      statement:
        input.headlineCount === 1
          ? 'One thing needs your attention.'
          : `${input.headlineCount} things need your attention.`,
      // COVERAGE GAPS ARE STILL REPORTED. Something being on the list does not
      // mean everything was looked at, and a person acting on one Headline
      // should still know two objectives went unmeasured.
      notKnown: unmeasurable.length > 0 ? [coverageGap(unmeasurable, considered)] : [],
    };
  }

  if (considered === 0) {
    return {
      ...base,
      state: 'NOTHING_TO_CHECK',
      statement:
        'Loop has nothing to check: no active objective says what this organization is trying ' +
        'to accomplish.',
      notKnown: ['Nothing has been declared for Loop to watch.'],
    };
  }

  if (unmeasurable.length > 0) {
    return {
      ...base,
      state: 'INSUFFICIENT_COVERAGE',
      statement:
        "Loop can't determine whether anything requires attention. " +
        `${unmeasurable.length} of ${considered} ${considered === 1 ? 'objective has' : 'objectives have'} ` +
        'incomplete measurement coverage.',
      notKnown: [coverageGap(unmeasurable, considered)],
    };
  }

  return {
    ...base,
    state: 'ALL_CLEAR',
    statement:
      'No material changes require your attention. Loop checked ' +
      `${considered} active ${considered === 1 ? 'objective' : 'objectives'} and every eligible ` +
      'measurement window is current.',
    // EMPTY BY DEFINITION. An all-clear with a caveat is not an all-clear, and
    // this is the one state where that list must be empty.
    notKnown: [],
  };
}

function coverageGap(unmeasurable: readonly ObjectiveCoverage[], considered: number): string {
  const named = unmeasurable
    .slice(0, 3)
    .map((o) => o.objectiveTitle)
    .join(', ');
  const more = unmeasurable.length > 3 ? ` and ${unmeasurable.length - 3} more` : '';
  return (
    `${unmeasurable.length} of ${considered} objectives could not be measured: ${named}${more}.`
  );
}

/**
 * Whether this assessment is a claim that nothing is wrong.
 *
 * ONE PLACE, SO NOBODY WRITES `state !== 'NEEDS_ATTENTION'`. That comparison is
 * true for INSUFFICIENT_COVERAGE and NOTHING_TO_CHECK, and a surface that used
 * it would render an unmeasured morning as a clean one — which is exactly the
 * defect this whole file exists to prevent.
 */
export function isAllClear(assessment: Pick<AttentionAssessment, 'state'>): boolean {
  return assessment.state === 'ALL_CLEAR';
}
