// Local reconciliation — whether what we observed actually arrived.
//
// THE FACT THIS FILE EXISTS TO CARRY
//
// `ProviderObservationDay` proves Loop LOOKED at a business date. It proves
// nothing about what reached Loop, and on 2026-08-05 that gap was 107 identities
// wide: the day certified SUCCESS with 974 records read across 11 unbroken pages,
// and Loop held 867. Both statements were true simultaneously, and no query
// against production could name the difference, because the observation row
// persists a COUNT and never the identity SET.
//
// This is the second fact, and it is deliberately a SECOND one. Redefining
// SUCCESS to mean "and the data is here" would destroy the only completeness
// claim Loop currently gets right, and would re-merge two questions that took
// three investigations to separate.
//
// THE GRAIN IS THE DAY, EXPLAINED PER MEMBER. The day is what measurement gates
// on, so the verdict lives there. But the difference lives in campaigns — on
// 2026-08-05, 106 of 107 absences belonged to three campaigns with no local
// representation at all — and a day-level verdict alone would let one broken
// campaign block every objective in the organization, including objectives that
// do not measure it. Member facts are what make readiness evaluable per binding.
//
// EVERY PROVIDER-ONLY IDENTITY IS ACCOUNTED FOR, OR THE DAY IS INCONCLUSIVE. The
// four-way split must sum to the whole. An exclusion that leaves the arithmetic
// is how a real absence disappears, so the arithmetic is checked rather than
// trusted.
//
// PURE. No clock, no I/O, no persistence.

import type { BusinessDate } from './business-time';
import type { BindingDimension } from './objective-measure-binding';
import type { ResolvedExpectation } from './member-expectation';

/** Which build of the reconciliation rule produced a verdict. Stored on the fact. */
export const RECONCILIATION_RULE_VERSION = 'provider-reconciliation.v1';

// --- The verdict ---------------------------------------------------------------

/**
 * The outcome of comparing one day's provider identities against Loop's.
 *
 * Four states, and each one has a different remedy — which is the test of whether
 * a state earns its place. RECONCILED needs nothing. UNRECONCILED needs an
 * engineer. UNKNOWN_EXPECTATION needs a decision from a person who knows the
 * business. INCONCLUSIVE needs the comparison run again, because its own evidence
 * is not sound.
 */
export const RECONCILIATION_STATES = [
  /** Every provider identity is matched, or attributed to a member that was never
      going to deliver it. Nothing is unaccounted for. */
  'RECONCILED',
  /** At least one identity from an EXPECTED member did not arrive. A known,
      bounded gap: we can say how many and whose. */
  'UNRECONCILED',
  /** The comparison completed, but a member carrying absences has no declaration
      in force for that date. We cannot say whether the gap is a defect. */
  'UNKNOWN_EXPECTATION',
  /** The comparison itself cannot be trusted: a truncated provider read, an
      incoherent identity set, or records Loop holds that the provider does not.
      NOTHING may be concluded from it, in either direction. */
  'INCONCLUSIVE',
] as const;

export type ReconciliationState = (typeof RECONCILIATION_STATES)[number];

export const RECONCILIATION_STATE_LABELS: Record<ReconciliationState, string> = {
  RECONCILED: 'Every observed record is accounted for.',
  UNRECONCILED: 'Records that were expected to arrive did not.',
  UNKNOWN_EXPECTATION: 'Records are missing from a campaign nobody has declared.',
  INCONCLUSIVE: 'The comparison is not sound, so nothing can be concluded from it.',
};

/**
 * How hard each state blocks, ascending.
 *
 * INCONCLUSIVE outranks everything because it is the only state that impeaches
 * its own evidence: an UNRECONCILED day tells you something true about a gap,
 * while an INCONCLUSIVE one tells you the measurement of the gap was wrong.
 * UNKNOWN_EXPECTATION outranks UNRECONCILED because an unbounded question is
 * worse than a bounded defect — we do not yet know how large the gap is, or
 * whether it is one.
 */
export const RECONCILIATION_SEVERITY: Record<ReconciliationState, number> = {
  RECONCILED: 0,
  UNRECONCILED: 1,
  UNKNOWN_EXPECTATION: 2,
  INCONCLUSIVE: 3,
};

/** Only RECONCILED certifies. The absence of a fact certifies nothing at all. */
export function reconciliationCertifies(state: ReconciliationState | null | undefined): boolean {
  return state === 'RECONCILED';
}

/** The most severe of several states. An empty list is RECONCILED — nothing objected. */
export function mostSevereReconciliationState(
  states: readonly ReconciliationState[],
): ReconciliationState {
  let worst: ReconciliationState = 'RECONCILED';
  for (const s of states) {
    if (RECONCILIATION_SEVERITY[s] > RECONCILIATION_SEVERITY[worst]) worst = s;
  }
  return worst;
}

// --- The counts -----------------------------------------------------------------

/**
 * How each provider-only identity is accounted for.
 *
 * The whole point of the fact. "107 records are missing" is an alarm; "97 from a
 * campaign nobody has declared, 9 from campaigns that are not connected, 1 from a
 * campaign that delivers" is a work list.
 */
export interface ProviderOnlySplit {
  /** From members declared EXPECTED. THE DEFECT COUNT. */
  providerOnlyExpected: number;
  /** From members declared NOT_CONFIGURED. Correct absences; still counted. */
  providerOnlyNotConfigured: number;
  /** From members declared EXCLUDED. Deliberate; still counted, never subtracted. */
  providerOnlyExcluded: number;
  /** From members with no declaration in force. Unanswerable until somebody says. */
  providerOnlyUnknownMember: number;
}

/** One day's identity arithmetic, as persisted and as audited. */
export interface ReconciliationCounts extends ProviderOnlySplit {
  providerUnique: number;
  providerDuplicateIds: number;
  localUnique: number;
  localDuplicateIds: number;
  intersection: number;
  providerOnly: number;
  /** Identities Loop holds that the provider's bounded read did not return. */
  localOnly: number;
}

export function providerOnlySplitTotal(split: ProviderOnlySplit): number {
  return (
    split.providerOnlyExpected +
    split.providerOnlyNotConfigured +
    split.providerOnlyExcluded +
    split.providerOnlyUnknownMember
  );
}

/**
 * Whether the arithmetic holds. Empty problems means it does.
 *
 * Three equations, and a violation of any of them means the comparison is wrong
 * rather than the data is bad — which is why the caller must turn a failure here
 * into INCONCLUSIVE and not into a finding about completeness. These are the same
 * set equations the August 2026 reconciliation diagnostic refused to produce a
 * verdict without.
 */
export function countProblems(counts: ReconciliationCounts): string[] {
  const problems: string[] = [];
  const values = Object.values(counts);
  if (values.some((v) => !Number.isInteger(v) || v < 0)) {
    problems.push('every count must be a non-negative integer');
    return problems;
  }
  if (counts.intersection + counts.providerOnly !== counts.providerUnique) {
    problems.push('intersection + providerOnly !== providerUnique');
  }
  if (counts.intersection + counts.localOnly !== counts.localUnique) {
    problems.push('intersection + localOnly !== localUnique');
  }
  if (providerOnlySplitTotal(counts) !== counts.providerOnly) {
    problems.push('the provider-only split does not sum to providerOnly');
  }
  return problems;
}

export function countsCoherent(counts: ReconciliationCounts): boolean {
  return countProblems(counts).length === 0;
}

// --- The facts ------------------------------------------------------------------

/** One day's reconciliation, explained for one population member. */
export interface ReconciliationMemberFact {
  dimension: BindingDimension;
  memberExternalId: string;
  /** Identities the provider returned for this member on this day. */
  providerCount: number;
  /** Identities Loop holds for this member on this day. */
  localCount: number;
  /** Provider identities with no local counterpart. */
  providerOnly: number;
  /** What was declared for this member ON THIS DATE. Resolved, never current-state. */
  expectation: ResolvedExpectation;
}

/** One day's reconciliation. The unit measurement gates on. */
export interface ReconciliationDayFact {
  businessDate: BusinessDate;
  state: ReconciliationState;
  counts: ReconciliationCounts;
  members: readonly ReconciliationMemberFact[];
  ruleVersion: string;
}

/**
 * Derive the day's state from its parts. ONE EXPRESSION, ONE PLACE — the rule
 * `certifiesObservation` already models.
 *
 * Order matters and follows severity. An incoherent comparison is assessed before
 * anything is read from it, because a conclusion drawn from arithmetic that does
 * not add up is worse than no conclusion.
 *
 * `localOnly > 0` is INCONCLUSIVE rather than UNRECONCILED: records Loop holds
 * and the provider's bounded read did not return mean the two populations are not
 * describing the same thing, which impeaches the comparison rather than reporting
 * a gap in it.
 */
export function deriveReconciliationState(
  counts: ReconciliationCounts,
  members: readonly ReconciliationMemberFact[],
): ReconciliationState {
  if (!countsCoherent(counts)) return 'INCONCLUSIVE';
  if (counts.localOnly > 0) return 'INCONCLUSIVE';
  if (members.some((m) => m.providerOnly > 0 && m.expectation === 'UNKNOWN')) {
    return 'UNKNOWN_EXPECTATION';
  }
  if (counts.providerOnlyExpected > 0) return 'UNRECONCILED';
  return 'RECONCILED';
}

/** The member fact for one id, or undefined when the day never saw that member. */
export function memberFact(
  day: ReconciliationDayFact,
  dimension: BindingDimension,
  memberExternalId: string,
): ReconciliationMemberFact | undefined {
  return day.members.find(
    (m) => m.dimension === dimension && m.memberExternalId === memberExternalId,
  );
}
