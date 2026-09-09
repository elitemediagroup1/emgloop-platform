// What a person reads, mapped from what the system knows — in one direction
// only.
//
// THE RULE. Backend states stay authoritative and keep their names.
// `SOURCE_AUTHORITY_MISSING`, `RECONCILIATION_INCONCLUSIVE` and
// `MEASURE_NOT_SUPPORTED_BY_SOURCE` are precise, they are what the gate actually
// decided, and renaming them for the sake of a friendlier screen would make the
// logs and the UI describe different systems. This file translates; it never
// redefines.
//
// AND IT NEVER COLLAPSES TWO STATES THAT NEED DIFFERENT ACTIONS. The tempting
// version of this file maps thirteen withholdings onto three friendly words and
// loses the difference between "a job did not run" and "nobody has said which
// source owns this number". The first is fixed by an operator in ten minutes;
// the second needs a decision. So the mapping is deliberately many-to-several,
// every label carries the technical state it came from, and the grouping is by
// WHO CAN ACT rather than by how it sounds.
//
// PRESENTATION IS NOT AUTHORITY. Nothing in this file is stored, compared,
// or branched on. A caller that switched on a product label instead of the
// governed state would have moved a decision into the presentation layer, and a
// test asserts the labels are absent from every service.
//
// PURE. No clock, no I/O.

import type { ReadinessOutcome, ReadinessWithholding } from './measurement-readiness';
import type { AttentionState } from './attention-state';
import type { SlaState, WorkExecutionState } from './work-execution';
import type { MonitoringVerdict } from './case-monitoring';

export const PRODUCT_LANGUAGE_VERSION = 'product-language.v1';

/**
 * What a person is being told, at the level they can act on.
 *
 * FIVE, AND EACH ONE IMPLIES A DIFFERENT NEXT MOVE. That is the test for whether
 * a sixth belongs: if two states lead to the same action by the same person,
 * they can share a label; if they do not, they must not.
 */
export const PRODUCT_TONES = [
  /** Established. Loop stands behind it. */
  'VERIFIED',
  /** Real, and partial. Some of it is known and some is not. */
  'INCOMPLETE',
  /** Loop is waiting on something that is expected to arrive. Nobody must act. */
  'WAITING_FOR_DATA',
  /** Somebody has to decide or configure something. Loop cannot proceed alone. */
  'NEEDS_SETUP',
  /** The evidence disagrees with itself. Neither waiting nor configuring helps. */
  'CONFLICTING',
] as const;

export type ProductTone = (typeof PRODUCT_TONES)[number];

/** One thing to say, and the governed state it came from. */
export interface ProductLabel {
  tone: ProductTone;
  /** The short human word. */
  label: string;
  /** One sentence saying what it means for the reader. */
  detail: string;
  /**
   * The authoritative state this was translated FROM, verbatim.
   *
   * CARRIED ON EVERY LABEL, deliberately. A support conversation, a bug report
   * and a log line all need the real name, and a UI that only ever showed
   * "Waiting for data" would make three different outages indistinguishable to
   * the person trying to fix them.
   */
  from: string;
}

// --- Readiness ---------------------------------------------------------------------------

/**
 * The thirteen Stage 3 withholdings, grouped by WHO CAN ACT.
 *
 * This is the same axis `READINESS_OUTCOMES` already chose — "NOT_READY: an
 * operation fixes it; CONFIG_ERROR: a person must decide" — applied one level
 * down, so the product language and the engine agree about what kind of problem
 * something is rather than each having its own opinion.
 */
export const WITHHOLDING_LANGUAGE: Record<ReadinessWithholding, ProductLabel> = {
  WINDOW_NOT_OBSERVED: {
    tone: 'WAITING_FOR_DATA', label: 'Waiting for data',
    detail: 'Loop has not yet seen the period this covers.',
    from: 'WINDOW_NOT_OBSERVED',
  },
  RECONCILIATION_MISSING: {
    tone: 'WAITING_FOR_DATA', label: 'Waiting for data',
    detail: 'Loop has not confirmed that everything the provider held actually arrived.',
    from: 'RECONCILIATION_MISSING',
  },
  RECONCILIATION_INCONCLUSIVE: {
    tone: 'CONFLICTING', label: 'Conflicting evidence',
    detail: 'What arrived and what the provider says it sent do not agree.',
    from: 'RECONCILIATION_INCONCLUSIVE',
  },
  CAMPAIGN_EXPECTATION_UNKNOWN: {
    tone: 'NEEDS_SETUP', label: 'Not set up',
    detail: 'Nobody has said whether this campaign was expected to run.',
    from: 'CAMPAIGN_EXPECTATION_UNKNOWN',
  },
  CAMPAIGN_EXPECTATION_CONTRADICTED: {
    tone: 'CONFLICTING', label: 'Conflicting evidence',
    detail: 'A campaign expected to be quiet produced activity, or the reverse.',
    from: 'CAMPAIGN_EXPECTATION_CONTRADICTED',
  },
  POPULATION_INCOMPLETE: {
    tone: 'INCOMPLETE', label: 'Incomplete',
    detail: 'Part of what this measures is missing, so the number would understate it.',
    from: 'POPULATION_INCOMPLETE',
  },
  SOURCE_AUTHORITY_MISSING: {
    tone: 'NEEDS_SETUP', label: 'Source not configured',
    detail: 'Nobody has said which system owns this number.',
    from: 'SOURCE_AUTHORITY_MISSING',
  },
  SOURCE_AUTHORITY_CONFLICT: {
    tone: 'CONFLICTING', label: 'Conflicting sources',
    detail: 'Two systems both claim to own this number.',
    from: 'SOURCE_AUTHORITY_CONFLICT',
  },
  MEASURE_NOT_SUPPORTED_BY_SOURCE: {
    tone: 'NEEDS_SETUP', label: 'Source not configured',
    detail: 'The system that owns this does not report the figure being asked for.',
    from: 'MEASURE_NOT_SUPPORTED_BY_SOURCE',
  },
  AUTHORITATIVE_DATA_PENDING: {
    tone: 'WAITING_FOR_DATA', label: 'Waiting for data',
    detail: 'The authoritative figures for this period have not arrived yet.',
    from: 'AUTHORITATIVE_DATA_PENDING',
  },
  AUTHORITATIVE_DATA_INCOMPLETE: {
    tone: 'INCOMPLETE', label: 'Incomplete',
    detail: 'The authoritative figures arrived, and they do not cover all of it.',
    from: 'AUTHORITATIVE_DATA_INCOMPLETE',
  },
  MIXED_SOURCE_AGGREGATION_UNSUPPORTED: {
    tone: 'NEEDS_SETUP', label: 'Cannot be combined',
    detail: 'This would mix figures from systems that cannot be added together.',
    from: 'MIXED_SOURCE_AGGREGATION_UNSUPPORTED',
  },
  CALL_UNATTRIBUTED: {
    tone: 'INCOMPLETE', label: 'Incomplete',
    detail: 'Some activity could not be attributed to anything this measures.',
    from: 'CALL_UNATTRIBUTED',
  },
};

export const READINESS_LANGUAGE: Record<ReadinessOutcome, ProductLabel> = {
  READY: {
    tone: 'VERIFIED', label: 'Verified',
    detail: 'Loop measured this and stands behind the figure.',
    from: 'READY',
  },
  NOT_READY: {
    tone: 'WAITING_FOR_DATA', label: 'Waiting for data',
    detail: 'Something has to run or arrive before this can be measured.',
    from: 'NOT_READY',
  },
  CONFIG_ERROR: {
    tone: 'NEEDS_SETUP', label: 'Not set up',
    detail: 'Somebody has to decide something Loop cannot work out on its own.',
    from: 'CONFIG_ERROR',
  },
  INCONCLUSIVE: {
    tone: 'CONFLICTING', label: 'Conflicting evidence',
    detail: 'The evidence disagrees with itself. Waiting will not resolve it.',
    from: 'INCONCLUSIVE',
  },
};

// --- Execution ---------------------------------------------------------------------------

export const EXECUTION_LANGUAGE: Record<WorkExecutionState, ProductLabel> = {
  pending: { tone: 'WAITING_FOR_DATA', label: 'Not started', detail: 'Nobody has reached this step yet.', from: 'pending' },
  ready: { tone: 'VERIFIED', label: 'Ready', detail: 'Somebody can act on this now.', from: 'ready' },
  in_progress: { tone: 'VERIFIED', label: 'In progress', detail: 'Somebody is working on it.', from: 'in_progress' },
  waiting_internal: { tone: 'INCOMPLETE', label: 'Waiting on us', detail: 'Somebody here owes an input before this can move.', from: 'waiting_internal' },
  waiting_external: { tone: 'INCOMPLETE', label: 'Waiting on them', detail: 'Somebody outside owes a response before this can move.', from: 'waiting_external' },
  blocked: { tone: 'INCOMPLETE', label: 'Blocked', detail: 'Something named has to resolve first.', from: 'blocked' },
  completed: { tone: 'VERIFIED', label: 'Done', detail: 'This is finished.', from: 'completed' },
  skipped: { tone: 'VERIFIED', label: 'Skipped', detail: 'This step was deliberately not done.', from: 'skipped' },
};

export const SLA_LANGUAGE: Record<SlaState, ProductLabel> = {
  WITHIN_POLICY: { tone: 'VERIFIED', label: 'On track', detail: 'Inside the time this is expected to take.', from: 'WITHIN_POLICY' },
  REMINDER_ELIGIBLE: { tone: 'INCOMPLETE', label: 'Overdue', detail: 'This has been actionable for a while and has not moved.', from: 'REMINDER_ELIGIBLE' },
  ESCALATION_ELIGIBLE: { tone: 'INCOMPLETE', label: 'Badly overdue', detail: 'This has been actionable for a day and has not moved.', from: 'ESCALATION_ELIGIBLE' },
  PAUSED_WAITING: { tone: 'INCOMPLETE', label: 'Paused', detail: 'The clock is paused while this legitimately waits.', from: 'PAUSED_WAITING' },
  CLOSED: { tone: 'VERIFIED', label: 'Done', detail: 'Nothing further is expected.', from: 'CLOSED' },
  // NOT "on track". Unmeasured work is unknown, and the product word has to say
  // so or the whole point of the UNKNOWN state is lost at the last step.
  UNKNOWN: { tone: 'INCOMPLETE', label: 'Not measured', detail: 'Loop has no history for this, so it cannot say whether it is on track.', from: 'UNKNOWN' },
};

export const MONITORING_LANGUAGE: Record<MonitoringVerdict, ProductLabel> = {
  IN_PROGRESS: { tone: 'WAITING_FOR_DATA', label: 'Still watching', detail: 'The window has not finished.', from: 'IN_PROGRESS' },
  HELD: { tone: 'VERIFIED', label: 'It held', detail: 'What was hoped for happened, measured against a standard set in advance.', from: 'HELD' },
  DID_NOT_HOLD: { tone: 'VERIFIED', label: 'It did not hold', detail: 'What was feared happened, measured against a standard set in advance.', from: 'DID_NOT_HOLD' },
  NEITHER: { tone: 'INCOMPLETE', label: 'Neither', detail: 'Neither the hoped-for nor the feared outcome happened.', from: 'NEITHER' },
  // NOT collapsed into NEITHER. "It did neither" and "Loop could not tell" are
  // completely different facts, and one of them means somebody should look at
  // the measurement.
  INCONCLUSIVE: { tone: 'WAITING_FOR_DATA', label: "Couldn't tell", detail: 'There was not enough evidence to judge the window.', from: 'INCONCLUSIVE' },
};

export const ATTENTION_LANGUAGE: Record<AttentionState, ProductLabel> = {
  NEEDS_ATTENTION: { tone: 'VERIFIED', label: 'Needs your attention', detail: 'There is something on your list.', from: 'NEEDS_ATTENTION' },
  ALL_CLEAR: { tone: 'VERIFIED', label: 'All clear', detail: 'Loop checked everything it watches and found nothing.', from: 'ALL_CLEAR' },
  // NEVER "all clear". This is the whole reason the two states are separate.
  INSUFFICIENT_COVERAGE: { tone: 'INCOMPLETE', label: "Can't tell", detail: 'Some of what Loop watches could not be measured.', from: 'INSUFFICIENT_COVERAGE' },
  NOTHING_TO_CHECK: { tone: 'NEEDS_SETUP', label: 'Nothing to check', detail: 'Nobody has told Loop what to watch.', from: 'NOTHING_TO_CHECK' },
};

/**
 * Every label, by the governed state it translates.
 *
 * ONE LOOKUP, SO A SURFACE NEVER BUILDS ITS OWN. A second mapping in the web app
 * is how "Verified" and "Confirmed" end up on two screens meaning the same
 * thing, which is the exact class of drift this repository already carries three
 * of.
 */
export function productLabel(state: string): ProductLabel | null {
  return (
    (WITHHOLDING_LANGUAGE as Record<string, ProductLabel>)[state] ??
    (READINESS_LANGUAGE as Record<string, ProductLabel>)[state] ??
    (EXECUTION_LANGUAGE as Record<string, ProductLabel>)[state] ??
    (SLA_LANGUAGE as Record<string, ProductLabel>)[state] ??
    (MONITORING_LANGUAGE as Record<string, ProductLabel>)[state] ??
    (ATTENTION_LANGUAGE as Record<string, ProductLabel>)[state] ??
    // NULL RATHER THAN A GUESS. A state with no label is a state somebody added
    // without deciding what to call it, and rendering the raw enum is better
    // than rendering a plausible-sounding word for something nobody chose.
    null
  );
}
