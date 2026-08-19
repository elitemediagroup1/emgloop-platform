// Provider member expectation — the fact that separates absence from failure.
//
// THE DISTINCTION THIS FILE EXISTS TO CARRY
//
// On 2026-08-05 CallGrid held 974 call identities for one Eastern day and Loop
// held 867. The 107 that never arrived were not one thing: 9 of them came from
// two campaigns the production webhook was never attached to — verified in the
// provider's own interface — and could not have arrived. The rest came from
// campaigns that do deliver, and their absence is a different fact entirely.
//
// Both look identical from inside Loop: a row that is not there. Until a human
// says which is which, "the campaign is not connected" and "the delivery failed"
// are the same observation, and a completeness rule built on that observation
// will either cry wolf about every unconnected campaign or stay silent through a
// real outage. This file is the vocabulary for saying which.
//
// EXPECTATION IS DECLARED, NEVER INFERRED. Nothing here reads traffic. A campaign
// that delivered yesterday does not thereby become expected today, because the
// inverse would be catastrophic: a campaign that BROKE would silently un-expect
// itself the moment it stopped delivering, and the alarm would disarm exactly
// when it was needed. Observed delivery is evidence a person may weigh; it is
// never the declaration.
//
// UNKNOWN IS THE ABSENCE OF A DECLARATION, and it is never a stored value —
// the convention `ProviderObservationDay` already established, where the absence
// of a row certifies nothing. An undeclared member fails closed.
//
// PURE. No clock, no I/O, no persistence. Persistence is a later PR; this is the
// contract it will store.

import { isEffectiveOn, isEffectiveRangeValid, type BusinessDate, type EffectiveDateRange } from './business-time';
import { isBindingDimension, type BindingDimension } from './objective-measure-binding';

export const MEMBER_EXPECTATION_CONTRACT_VERSION = 'member-expectation.v1';

// --- What a declaration can say -----------------------------------------------

/**
 * The three things a human can declare about one provider population member.
 *
 * A CLOSED VOCABULARY, and the absences are deliberate. There is no `DISABLED`:
 * that is provider-side lifecycle Loop cannot observe, and a state Loop cannot
 * verify is a state Loop will eventually guess. There is no `UNKNOWN`: see the
 * header — unknown is the absence of a row.
 */
export const MEMBER_EXPECTATION_STATES = [
  /** Records from this member SHOULD reach Loop. Their absence is a defect. */
  'EXPECTED',
  /** The member exists at the provider but is not connected to Loop's ingestion
      path. Their absence is CORRECT, and must never be reported as a defect. */
  'NOT_CONFIGURED',
  /** Reachable, and deliberately outside the measurement population. Requires a
      named reason: an exclusion nobody has to justify is a place to hide. */
  'EXCLUDED',
] as const;

export type MemberExpectationState = (typeof MEMBER_EXPECTATION_STATES)[number];

/**
 * Whether a stored string is a declarable state.
 *
 * FOR THE READ PATH, not the write path. A persistence layer holds these
 * vocabularies as text so widening one is a contract change rather than
 * production DDL, which means a row can outlive the vocabulary that wrote it.
 * An unrecognised value must resolve UNKNOWN rather than be handed onward as if
 * it meant something, so the guard fails closed. 'UNKNOWN' is not a member here
 * and never will be.
 */
export function isMemberExpectationState(value: unknown): value is MemberExpectationState {
  return typeof value === 'string' && (MEMBER_EXPECTATION_STATES as readonly string[]).includes(value);
}

/**
 * What a resolver returns. `UNKNOWN` is not declarable and not storable — it is
 * what "no declaration was in force on that date" resolves to, and it blocks.
 */
export type ResolvedExpectation = MemberExpectationState | 'UNKNOWN';

export const MEMBER_EXPECTATION_STATE_LABELS: Record<ResolvedExpectation, string> = {
  EXPECTED: 'Expected — records from this campaign should reach Loop.',
  NOT_CONFIGURED: 'Not connected to Loop. Records from this campaign are not expected to arrive.',
  EXCLUDED: 'Deliberately outside the measurement population.',
  UNKNOWN: 'Nobody has said whether this campaign was expected on this date.',
};

/**
 * Why a reachable member is excluded from measurement.
 *
 * A CLOSED VOCABULARY, shipped deliberately small. Every member here names a
 * real, checkable business situation; adding one is a change to this file WITH a
 * business case, exactly as `MEASURE_METRICS` requires for a sixth measure. A
 * free-text reason would make `EXCLUDED` a shrug, and a shrug is how a delivery
 * failure gets filed as a decision.
 */
export const MEMBER_EXCLUSION_REASONS = [
  /** Traffic generated to test the integration, not real commercial activity. */
  'TEST_TRAFFIC',
  /** House or internal traffic that is not part of the measured business. */
  'INTERNAL_TRAFFIC',
] as const;

export type MemberExclusionReason = (typeof MEMBER_EXCLUSION_REASONS)[number];

/** Whether a stored string names a real exclusion reason. Fails closed. */
export function isMemberExclusionReason(value: unknown): value is MemberExclusionReason {
  return typeof value === 'string' && (MEMBER_EXCLUSION_REASONS as readonly string[]).includes(value);
}

export const MEMBER_EXCLUSION_REASON_LABELS: Record<MemberExclusionReason, string> = {
  TEST_TRAFFIC: 'Test traffic',
  INTERNAL_TRAFFIC: 'Internal or house traffic',
};

/**
 * How the declaration was arrived at. Stored so a conclusion drawn from a weaker
 * basis carries that weakness with it.
 */
export const MEMBER_EXPECTATION_BASES = [
  /** Somebody read the provider's configuration and reported what it says. */
  'PROVIDER_CONFIG_VERIFIED',
  /** Somebody stated it from knowledge of the business. A memory, recorded as one. */
  'OPERATOR_DECLARED',
] as const;

export type MemberExpectationBasis = (typeof MEMBER_EXPECTATION_BASES)[number];

/** Whether a stored string names a real basis. Fails closed. */
export function isMemberExpectationBasis(value: unknown): value is MemberExpectationBasis {
  return typeof value === 'string' && (MEMBER_EXPECTATION_BASES as readonly string[]).includes(value);
}

// --- The declaration ----------------------------------------------------------

/**
 * One human statement about one member, in force over a range of business dates.
 *
 * EFFECTIVE-DATED, because the alternative rewrites history. If a campaign's
 * webhook is attached on 2026-08-19, a declaration of EXPECTED from that date
 * leaves 2026-08-05 resolving NOT_CONFIGURED — which is what was true then. A
 * single current-state flag would retroactively convert every prior day into a
 * delivery failure that nobody could have prevented.
 */
export interface MemberExpectationDeclaration extends EffectiveDateRange {
  /** Which population dimension the member belongs to. See `dimensionSupported`. */
  dimension: BindingDimension;
  /** The provider's own id for the member. Identity is the id, never the label. */
  memberExternalId: string;
  state: MemberExpectationState;
  /** Required for EXCLUDED, and forbidden otherwise. */
  exclusionReason: MemberExclusionReason | null;
  basis: MemberExpectationBasis;
}

/**
 * The dimensions v1 accepts declarations over.
 *
 * CAMPAIGN ONLY, and this is evidence rather than caution. Campaign is the only
 * dimension proven to gate delivery — CallGrid attaches a webhook per campaign,
 * confirmed in production on 2026-07-03 — and the only attribution id present on
 * every record of the 2026-08-05 provider population, where vendorId, sourceId,
 * buyerId and destinationId were absent on all 974. Widening this is a contract
 * change made when a provider gives us a reason, not before.
 */
export const EXPECTATION_DIMENSIONS: readonly BindingDimension[] = ['CAMPAIGN'];

export function dimensionSupported(dimension: string): dimension is BindingDimension {
  return isBindingDimension(dimension) && EXPECTATION_DIMENSIONS.includes(dimension);
}

/** Why a declaration is not well formed. Empty means it is. */
export function declarationProblems(d: MemberExpectationDeclaration): string[] {
  const problems: string[] = [];
  if (!dimensionSupported(d.dimension)) {
    problems.push(`dimension ${d.dimension} is not declarable in this version`);
  }
  if (typeof d.memberExternalId !== 'string' || d.memberExternalId.trim() === '') {
    problems.push('memberExternalId is required — a declaration keyed on a label is not identity');
  }
  if (d.state === 'EXCLUDED' && d.exclusionReason === null) {
    problems.push('EXCLUDED requires a named reason');
  }
  if (d.state !== 'EXCLUDED' && d.exclusionReason !== null) {
    problems.push(`exclusionReason is only meaningful on EXCLUDED, not ${d.state}`);
  }
  if (!isEffectiveRangeValid(d)) {
    problems.push('effective range is empty, inverted or malformed');
  }
  return problems;
}

export function isDeclarationValid(d: MemberExpectationDeclaration): boolean {
  return declarationProblems(d).length === 0;
}

// --- Resolution ---------------------------------------------------------------

/** What was in force for one member on one date, and how confidently. */
export interface ExpectationResolution {
  state: ResolvedExpectation;
  /** The declaration that applied, or null when none did or more than one did. */
  declaration: MemberExpectationDeclaration | null;
  /** How many declarations matched. More than one is a configuration defect. */
  matches: number;
}

/**
 * Resolve what was expected of one member on one business date.
 *
 * FAILS CLOSED IN BOTH DIRECTIONS, the rule `assessWindowObservation` already
 * follows. No declaration resolves UNKNOWN. MORE THAN ONE also resolves UNKNOWN,
 * because overlapping ranges mean the organization has said two things and no
 * tie-break exists that would not be invented here. `matches` is reported so a
 * surface can tell an operator which of the two problems they have.
 *
 * Malformed declarations are ignored rather than trusted — a declaration that
 * cannot be checked cannot be relied on.
 */
export function resolveExpectation(
  declarations: readonly MemberExpectationDeclaration[],
  dimension: BindingDimension,
  memberExternalId: string,
  on: BusinessDate,
): ExpectationResolution {
  const matching = declarations.filter(
    (d) =>
      isDeclarationValid(d) &&
      d.dimension === dimension &&
      d.memberExternalId === memberExternalId &&
      isEffectiveOn(d, on),
  );

  const only = matching.length === 1 ? matching[0] : undefined;
  if (!only) return { state: 'UNKNOWN', declaration: null, matches: matching.length };
  return { state: only.state, declaration: only, matches: 1 };
}

/**
 * Whether an absent record from a member of this expectation is a DEFECT.
 *
 * True for EXPECTED alone. NOT_CONFIGURED and EXCLUDED records were never going
 * to arrive or were never going to count; UNKNOWN is not an answer and is
 * handled by its own reason code rather than being folded in here.
 */
export function absenceIsDefect(state: ResolvedExpectation): boolean {
  return state === 'EXPECTED';
}
