// Identity evidence -- what a fact can say about who it is about, and how little.
//
// Identity Slice 2.0, a pure contract. The decision record is
// docs/architecture/identity-evidence-resolution.md (sections 4, 5, 8 and 11a);
// this file is its evidence vocabulary and policy matrix, and nothing else.
//
// EVIDENCE IS NOT IDENTITY. A caller number, a typed email or a visitor key is an
// observation a fact carries. It may say something about who the fact is about. It
// never makes anyone a Person, never attaches a fact to a Party and never
// establishes one. Attribution, establishment, same-Party and contextual links are
// human acts, governed in `identity-authority.ts`; nothing here performs one.
//
// NOT COMMERCIAL INTELLIGENCE'S EVIDENCE CLASS. `evidence-class.ts` (MEASURED /
// HUMAN_REPORTED) says how evidence entered a Case. An identity evidence class is
// a kind plus an assertion mode. The two share an English word and nothing else,
// so every name here says `Identity`.
//
// TIERS ARE ORDERED LABELS, NEVER NUMBERS. ANONYMOUS < WEAK < MODERATE < STRONG,
// plus CONFLICTING. No confidence, score, percentage or probability is accepted,
// computed or returned (Product C-05): the product's "identity confidence" is
// governed identity posture, never a number.
//
// FREQUENCY NEVER RAISES A TIER. Twenty calls from one number are twenty WEAK
// observations; `occurrences` is accepted only so the tests can prove it is
// ignored. CONFLICT OVERRIDES A MATCH: evidence that points at two Parties, at a
// flagged identifier, or at a recorded contradiction is CONFLICTING and suggests
// nothing, however strong it would otherwise be.
//
// ONLY THE APPROVED MATRIX EXISTS. A kind and mode the matrix does not name is not
// an identity evidence class: it contributes no tier, suggests nothing and can
// have no use policy. VERIFIED and AUTHENTICATED classes are named because the
// architecture needs them, and are UNAVAILABLE: no verification writer and no
// end-customer authentication exist, so they contribute nothing and establish
// nothing until that authority does.
//
// NO MACHINE ATTRIBUTION AT LAUNCH. A machine may compute a read-time,
// non-persistent suggestion. It may never record that evidence is about a Party.
//
// PURE. No clock, no I/O.

import { type PartyConfirmingMethod, type PartyType } from './party';

// --- Vocabulary ------------------------------------------------------------------

export const IDENTITY_EVIDENCE_KINDS = [
  'PHONE',
  'EMAIL',
  'NAME',
  'VISITOR',
  'SESSION',
  'AUTH_ACCOUNT',
  'FORM_SUBMISSION',
  'OPERATOR_IDENTIFICATION',
] as const;
export type IdentityEvidenceKind = (typeof IDENTITY_EVIDENCE_KINDS)[number];

/**
 * How a value was asserted. Declared by a source identity policy, never inferred
 * from the value.
 */
export const IDENTITY_ASSERTION_MODES = [
  /** A first-party visitor or session key. */
  'CONTINUITY',
  /** Supplied by the phone network: caller ID. Spoofable. */
  'NETWORK_ASSERTED',
  /** Typed by the subject into a form or lead. Unverified. */
  'SUBJECT_PROVIDED',
  /** An authorized user heard or saw it. */
  'OPERATOR_RECORDED',
  /** A verification of this value was recorded. No writer exists. */
  'VERIFIED',
  /** The subject's own authenticated act. No end-customer authentication exists. */
  'AUTHENTICATED',
] as const;
export type IdentityAssertionMode = (typeof IDENTITY_ASSERTION_MODES)[number];

export interface IdentityEvidenceClass {
  readonly kind: IdentityEvidenceKind;
  readonly mode: IdentityAssertionMode;
}

/** Ordered weakest to strongest. CONFLICTING sits outside the order. */
export const IDENTITY_EVIDENCE_TIER_ORDER = ['ANONYMOUS', 'WEAK', 'MODERATE', 'STRONG'] as const;
export type IdentityEvidenceOrderedTier = (typeof IDENTITY_EVIDENCE_TIER_ORDER)[number];

export const IDENTITY_EVIDENCE_TIERS = [...IDENTITY_EVIDENCE_TIER_ORDER, 'CONFLICTING'] as const;
export type IdentityEvidenceTier = (typeof IDENTITY_EVIDENCE_TIERS)[number];

export const IDENTIFIER_FLAGS = ['SHARED', 'BUSINESS_LINE', 'SUSPECT', 'RECYCLED'] as const;
export type IdentifierFlag = (typeof IDENTIFIER_FLAGS)[number];

export const IDENTIFIER_FLAG_STATES = ['PROPOSED', 'ACTIVE', 'DISMISSED', 'REVOKED'] as const;
export type IdentifierFlagState = (typeof IDENTIFIER_FLAG_STATES)[number];

export interface IdentifierFlagFact {
  readonly flag: IdentifierFlag;
  readonly state: IdentifierFlagState;
}

// --- The approved policy matrix ------------------------------------------------

/**
 * One row of the approved evidence policy (decision record section 5).
 *
 * `tier` is what the class contributes on its own:
 *   - PER_FIELD: a container. A form submission is judged by the contact
 *     fields it carries, each its own observation.
 *   - STRONG_ONCE_CONFIRMED: STRONG after an authorized human confirmed it,
 *     WEAK until then.
 *
 * `suggestion` is the only read-time match the class may produce:
 *   - VERIFIED_CONTACT_POINT: against exactly one established Party's
 *     verified contact point of the same kind.
 *   - NEVER: no match at all.
 *
 * `establishes` names the Party confirming methods the class could be the sole
 * basis for. Establishing is still an `approve` act by an authorized person.
 */
export interface IdentityEvidenceClassRule extends IdentityEvidenceClass {
  readonly tier: IdentityEvidenceOrderedTier | 'PER_FIELD' | 'STRONG_ONCE_CONFIRMED';
  readonly suggestion: 'VERIFIED_CONTACT_POINT' | 'NEVER';
  readonly establishes: readonly PartyConfirmingMethod[];
  /** Authority to produce this class exists today. */
  readonly available: boolean;
}

const RULES: readonly IdentityEvidenceClassRule[] = [
  // Caller ID alone, at any frequency.
  { kind: 'PHONE', mode: 'NETWORK_ASSERTED', tier: 'WEAK', suggestion: 'VERIFIED_CONTACT_POINT', establishes: [], available: true },
  { kind: 'PHONE', mode: 'SUBJECT_PROVIDED', tier: 'MODERATE', suggestion: 'VERIFIED_CONTACT_POINT', establishes: [], available: true },
  { kind: 'PHONE', mode: 'VERIFIED', tier: 'STRONG', suggestion: 'VERIFIED_CONTACT_POINT', establishes: ['VERIFIED_PHONE'], available: false },
  { kind: 'EMAIL', mode: 'SUBJECT_PROVIDED', tier: 'MODERATE', suggestion: 'VERIFIED_CONTACT_POINT', establishes: [], available: true },
  { kind: 'EMAIL', mode: 'VERIFIED', tier: 'STRONG', suggestion: 'VERIFIED_CONTACT_POINT', establishes: ['VERIFIED_EMAIL'], available: false },
  // A name never strengthens a contact value or a suggestion. Alone it is the
  // lowest identifying tier, so it can grant nothing.
  { kind: 'NAME', mode: 'SUBJECT_PROVIDED', tier: 'WEAK', suggestion: 'NEVER', establishes: [], available: true },
  { kind: 'FORM_SUBMISSION', mode: 'SUBJECT_PROVIDED', tier: 'PER_FIELD', suggestion: 'NEVER', establishes: [], available: true },
  // Continuity is never a match to a Person; history attribution is a human act.
  { kind: 'VISITOR', mode: 'CONTINUITY', tier: 'ANONYMOUS', suggestion: 'NEVER', establishes: [], available: true },
  { kind: 'SESSION', mode: 'CONTINUITY', tier: 'ANONYMOUS', suggestion: 'NEVER', establishes: [], available: true },
  { kind: 'AUTH_ACCOUNT', mode: 'AUTHENTICATED', tier: 'STRONG', suggestion: 'NEVER', establishes: ['AUTHENTICATED'], available: false },
  // Explicit human identification: recorded or proposed by EMPLOYEE+, confirmed
  // by MANAGER+, and a MANUAL or EXPLICIT_LINK basis only for OWNER/ADMIN.
  { kind: 'OPERATOR_IDENTIFICATION', mode: 'OPERATOR_RECORDED', tier: 'STRONG_ONCE_CONFIRMED', suggestion: 'NEVER', establishes: ['MANUAL', 'EXPLICIT_LINK'], available: true },
];

export const IDENTITY_EVIDENCE_CLASS_RULES: readonly IdentityEvidenceClassRule[] = Object.freeze(
  RULES.map((rule) => Object.freeze({ ...rule, establishes: Object.freeze([...rule.establishes]) })),
);

/** The approved rule for a kind and mode, or null: anything unlisted is not a class. */
export function identityEvidenceClassRule(value: { kind: unknown; mode: unknown }): IdentityEvidenceClassRule | null {
  return IDENTITY_EVIDENCE_CLASS_RULES.find((r) => r.kind === value.kind && r.mode === value.mode) ?? null;
}

/** Fails closed: only an approved kind and mode pair is an identity evidence class. */
export function isIdentityEvidenceClass(value: unknown): value is IdentityEvidenceClass {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as { kind?: unknown; mode?: unknown };
  return identityEvidenceClassRule({ kind: v.kind, mode: v.mode }) !== null;
}

/** An approved class whose producing authority exists today. */
export function isAvailableIdentityEvidenceClass(value: unknown): value is IdentityEvidenceClass {
  if (!isIdentityEvidenceClass(value)) return false;
  return identityEvidenceClassRule(value)?.available === true;
}

// --- Conflict ------------------------------------------------------------------

/** Active flags that contradict any attribution of the identifier. */
const CONFLICTING_FLAGS: readonly IdentifierFlag[] = ['SHARED', 'SUSPECT', 'RECYCLED'];

export const IDENTITY_CONFLICT_REASONS = [
  /** The evidence points at more than one established Party. */
  'MULTIPLE_PARTIES',
  /** A person recorded that the evidence contradicts itself or the Party. */
  'CONTRADICTION_RECORDED',
  /** The identifier carries an ACTIVE SHARED, SUSPECT or RECYCLED flag. */
  'FLAGGED_IDENTIFIER',
  /** A business line is evidence for a Company, never for a Person. */
  'BUSINESS_LINE_FOR_PERSON',
  /** The facts cannot be read (a Party count that is not a whole number). Fails closed. */
  'INVALID_FACTS',
] as const;
export type IdentityConflictReason = (typeof IDENTITY_CONFLICT_REASONS)[number];

export interface IdentityConflictFacts {
  /** Distinct established, non-superseded Parties this evidence points at. */
  readonly pointsAtParties: number;
  /** Flags on the identifiers involved, in any state. Only ACTIVE flags count. */
  readonly flags: readonly IdentifierFlagFact[];
  /** The type of the one Party in view, when there is one. */
  readonly partyType: PartyType | null;
  readonly contradictionRecorded: boolean;
}

/** Why the evidence is CONFLICTING, or null. Machine-PROPOSED flags change nothing. */
export function identityEvidenceConflict(facts: IdentityConflictFacts): IdentityConflictReason | null {
  if (!Number.isInteger(facts.pointsAtParties) || facts.pointsAtParties < 0) return 'INVALID_FACTS';
  if (facts.contradictionRecorded) return 'CONTRADICTION_RECORDED';
  if (facts.pointsAtParties > 1) return 'MULTIPLE_PARTIES';
  const active = facts.flags.filter((f) => f.state === 'ACTIVE').map((f) => f.flag);
  if (active.some((f) => CONFLICTING_FLAGS.includes(f))) return 'FLAGGED_IDENTIFIER';
  if (active.includes('BUSINESS_LINE') && facts.partyType === 'PERSON') return 'BUSINESS_LINE_FOR_PERSON';
  return null;
}

// --- Tier ----------------------------------------------------------------------

export interface IdentityEvidenceObservation extends IdentityEvidenceClass {
  /** OPERATOR_IDENTIFICATION only: an authorized person confirmed it. */
  readonly confirmed?: boolean;
}

export interface IdentityEvidenceTierFacts extends IdentityConflictFacts {
  readonly observations: readonly IdentityEvidenceObservation[];
  /** How many times the identifier was seen. Never raises a tier. */
  readonly occurrences?: number;
}

function contribution(o: IdentityEvidenceObservation): IdentityEvidenceOrderedTier | null {
  const rule = identityEvidenceClassRule(o);
  if (!rule || !rule.available) return null;
  if (rule.tier === 'PER_FIELD') return null;
  if (rule.tier === 'STRONG_ONCE_CONFIRMED') return o.confirmed === true ? 'STRONG' : 'WEAK';
  return rule.tier;
}

/**
 * The tier of a body of evidence. Conflict first; otherwise the strongest
 * contribution of an available, approved class; ANONYMOUS when nothing identifies.
 */
export function identityEvidenceTier(facts: IdentityEvidenceTierFacts): IdentityEvidenceTier {
  if (identityEvidenceConflict(facts) !== null) return 'CONFLICTING';
  let best = 0;
  for (const o of facts.observations) {
    const tier = contribution(o);
    if (tier !== null) best = Math.max(best, IDENTITY_EVIDENCE_TIER_ORDER.indexOf(tier));
  }
  return IDENTITY_EVIDENCE_TIER_ORDER[best] ?? 'ANONYMOUS';
}

// --- Read-time suggestion --------------------------------------------------------

export interface IdentitySuggestionFacts {
  /** The observation being matched. */
  readonly candidate: IdentityEvidenceClass;
  /**
   * Distinct established, non-superseded Parties holding a verified contact point
   * of the candidate's kind with the candidate's value. None exist until
   * verification is built.
   */
  readonly partiesWithVerifiedMatch: number;
  readonly flags: readonly IdentifierFlagFact[];
  /** The matched Party's type, when exactly one matched. */
  readonly partyType: PartyType | null;
  readonly contradictionRecorded: boolean;
  /** Never strengthens a suggestion. */
  readonly occurrences?: number;
}

/**
 * Whether Loop may SHOW a read-time, non-persistent suggestion that this evidence
 * is about one Party. Showing is all it permits: a suggestion records nothing,
 * attributes nothing and establishes nothing.
 */
export function suggestionAllowed(facts: IdentitySuggestionFacts): boolean {
  const rule = identityEvidenceClassRule(facts.candidate);
  if (!rule || !rule.available || rule.suggestion !== 'VERIFIED_CONTACT_POINT') return false;
  if (facts.partiesWithVerifiedMatch !== 1) return false;
  return (
    identityEvidenceConflict({
      pointsAtParties: facts.partiesWithVerifiedMatch,
      flags: facts.flags,
      partyType: facts.partyType,
      contradictionRecorded: facts.contradictionRecorded,
    }) === null
  );
}

// --- Attribution and establishment ---------------------------------------------

/**
 * Whether a machine may record an identity attribution. Not at launch (Product,
 * 2026-09-15). The return type is the literal `false`, so enabling machine
 * attribution is a deliberate contract change, not a configuration value.
 */
export function machineMayAttribute(): false {
  return false;
}

/** The confirming methods a class could be the sole basis for, available or not. */
export function identityEvidenceEstablishingMethods(value: IdentityEvidenceClass): readonly PartyConfirmingMethod[] {
  return identityEvidenceClassRule(value)?.establishes ?? [];
}

/**
 * Whether an available class may be the sole basis on which an authorized person
 * (`identityResolution:approve`) establishes a Party. Evidence never establishes
 * by itself, and no machine or AI establishes anything.
 */
export function mayEstablishAlone(value: IdentityEvidenceClass): boolean {
  const rule = identityEvidenceClassRule(value);
  return rule !== null && rule.available && rule.establishes.length > 0;
}

/**
 * The establishment bases available today. The union of every available class's
 * methods, so it cannot drift from the matrix. It must equal what
 * `PartyService.establish` accepts: MANUAL and EXPLICIT_LINK.
 */
export const IDENTITY_ESTABLISHMENT_METHODS_AVAILABLE_NOW: readonly PartyConfirmingMethod[] = Object.freeze([
  ...new Set(IDENTITY_EVIDENCE_CLASS_RULES.filter((r) => r.available).flatMap((r) => r.establishes)),
]);

// --- Identifier flags --------------------------------------------------------------

/**
 * The flag lifecycle.
 * - A machine rule may only PROPOSE.
 * - An authorized person sets (ACTIVE), dismisses a proposal or revokes an active
 *   flag.
 * - DISMISSED and REVOKED are final. A new flag is a new row, so history is never
 *   rewritten.
 */
export function identifierFlagTransitionAllowed(
  from: IdentifierFlagState | null,
  to: IdentifierFlagState,
): boolean {
  switch (from) {
    case null:
      return to === 'PROPOSED' || to === 'ACTIVE';
    case 'PROPOSED':
      return to === 'ACTIVE' || to === 'DISMISSED';
    case 'ACTIVE':
      return to === 'REVOKED';
    default:
      return false;
  }
}
