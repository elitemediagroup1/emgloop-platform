// Party -- Loop's canonical identity contract, over CognitiveIdentity.
//
// ONE IDENTITY AUTHORITY, NOT TWO. A Party is a governed reading of an existing
// `CognitiveIdentity` row. There is no Party table and there must never be one
// beside it: the Prisma model and the `cognitive_identities` table keep their
// names, and "Party" is the product contract over them -- the same arrangement
// as TenantOrganization over `Organization`. A second identity table would give
// Loop three identity systems (User/Customer, CognitiveIdentity, Party), which is
// the failure this contract exists to prevent.
//
// TWO TYPES. `PERSON` and `COMPANY`. `CognitiveEntityType` has twenty members
// because the cognitive layer names every subject it reasons about -- calls,
// campaigns, documents, work items. Those are not Parties and nothing here makes
// them one. `HOUSEHOLD` is deferred, not rejected. And five members name a
// CAPACITY rather than a kind of thing -- a buyer, a vendor, a source, a creator,
// an employee. A company is not a buyer; it holds a buyer role, in a context, for
// a time, alongside other roles. Party type never decides commercial role and a
// commercial role never decides Party type.
//
// A PARTY-TYPED ROW IS NOT YET AN ESTABLISHED PARTY. The dormant cognitive
// pipeline resolves event subjects by session continuity, pseudonymous keys and
// anonymous stable keys, and it types a website visitor `PERSON`. That row is a
// cognitive subject Loop can remember things about. It is not canonical identity,
// and it becomes canonical only when a governed basis establishes it. Session
// continuity, a pseudonymous key, an anonymous key, household inference, name
// similarity, a matching unverified email or phone, and a confidence number are
// never governed bases -- however many of them agree.
//
// WHAT MAKES A BASIS GOVERNED IS PROVENANCE, NOT THE METHOD'S NAME. A link row
// that says `MANUAL` is a claim that somebody linked two records; it becomes a
// basis only when Loop can show that an authorized person did it under
// identity-resolution authority. `VERIFIED_EMAIL` is a claim that a value was
// verified; it becomes a basis only when the verification was recorded, not when
// a caller passed `verified: true`. `AUTHENTICATED` is a basis only when the
// existing authentication system established that the actor IS the Party -- the
// person's own act.
//
// NO CONFIDENCE. Nothing in this file accepts, reads or returns a number. The
// cognitive resolver still writes 1.0 / 0.9 / 0.7 / 0.6 / 0.3 into dormant
// columns; those values are quarantined from every Party decision here, and a
// reader that promotes one to identity authority has invented a standard this
// contract refuses to state.
//
// ORGANIZATION-SCOPED TODAY. Every Party read is (organizationId, partyId) and a
// miss in another organization is not-found. One Party participating across
// organizations is locked Product doctrine, reached later and only through the
// Party's own authenticated act; it is never a tenant-visible lookup, and no
// organization may learn from resolution that a Party exists in another.
//
// PURE. No clock, no I/O.

export const PARTY_TYPES = ['PERSON', 'COMPANY'] as const;
export type PartyType = (typeof PARTY_TYPES)[number];

/** Fails closed: anything that is not exactly a Party type is not one. */
export function isPartyType(value: unknown): value is PartyType {
  return typeof value === 'string' && (PARTY_TYPES as readonly string[]).includes(value);
}

/**
 * `CognitiveEntityType` members that name a capacity someone holds, not a kind of
 * Party. Listed so the exclusion is a stated decision rather than an omission:
 * each of these belongs to a Relationship, Participant or Campaign authority.
 */
export const CONTEXTUAL_ROLE_ENTITY_TYPES = [
  'EMPLOYEE',
  'CREATOR',
  'BUYER',
  'VENDOR',
  'SOURCE',
] as const;

/** Real, and not a Party type yet. Deferred by Product, not rejected. */
export const DEFERRED_PARTY_TYPES = ['HOUSEHOLD'] as const;

// --- Resolution posture ----------------------------------------------------

/**
 * What Loop may say about whether two Party records are the same Party.
 *
 * UNRESOLVED is a legal, permanent, non-alarming state -- most records will stay
 * there, and that is correct. The stored `IdentityResolutionLink.status` keeps
 * its own meaning: `REJECTED` and `REVERSED` are history, preserved, and simply
 * contribute nothing toward sameness.
 */
export const PARTY_RESOLUTION_POSTURES = [
  'CONFIRMED_SAME_PARTY',
  'POSSIBLE_MATCH',
  'UNRESOLVED',
] as const;
export type PartyResolutionPosture = (typeof PARTY_RESOLUTION_POSTURES)[number];

/**
 * The resolution methods that MAY confirm a Party -- each only with the
 * provenance `isGovernedPartyBasis` requires. Being on this list is necessary,
 * never sufficient.
 */
export const PARTY_CONFIRMING_METHODS = [
  'AUTHENTICATED',
  'EXPLICIT_LINK',
  'MANUAL',
  'VERIFIED_EMAIL',
  'VERIFIED_PHONE',
] as const;
export type PartyConfirmingMethod = (typeof PARTY_CONFIRMING_METHODS)[number];

/** Methods that never confirm a Party, with any provenance at all. */
export const PARTY_NEVER_CONFIRMING_METHODS = [
  'SESSION_CONTINUITY',
  'PSEUDONYMOUS',
  'HOUSEHOLD',
  'OTHER',
] as const;

/**
 * The facts that turn a method's name into a governed basis. Each is established
 * server-side by an existing authority -- never taken from a client payload.
 */
export interface PartyBasisProvenance {
  /** The existing authentication system established that the actor IS this Party. */
  readonly subjectAuthenticated: boolean;
  /** The User who acted under identity-resolution authority, established from the session. */
  readonly authorizedActorUserId: string | null;
  /** Verification of the contact value was recorded -- not claimed by a caller. */
  readonly verificationRecorded: boolean;
}

/**
 * The provenance every identity row written before governed identity resolution
 * existed actually has. True of all of them: no column records an authorized
 * actor, a recorded verification or a Party's own authenticated act, and
 * `IdentityResolutionLink.establishedBy` is free text any caller could write.
 */
export const NO_GOVERNED_PROVENANCE: PartyBasisProvenance = Object.freeze({
  subjectAuthenticated: false,
  authorizedActorUserId: null,
  verificationRecorded: false,
});

export interface PartyBasis {
  readonly method: string;
  readonly provenance: PartyBasisProvenance;
}

function isConfirmingMethod(method: string): method is PartyConfirmingMethod {
  return (PARTY_CONFIRMING_METHODS as readonly string[]).includes(method);
}

/** Whether a basis may establish or confirm a Party. Unknown methods fail closed. */
export function isGovernedPartyBasis(basis: PartyBasis): boolean {
  const p = basis.provenance;
  switch (basis.method) {
    case 'AUTHENTICATED':
      return p.subjectAuthenticated === true;
    case 'EXPLICIT_LINK':
    case 'MANUAL':
      return typeof p.authorizedActorUserId === 'string' && p.authorizedActorUserId.trim().length > 0;
    case 'VERIFIED_EMAIL':
    case 'VERIFIED_PHONE':
      return p.verificationRecorded === true;
    default:
      return false;
  }
}

// --- Establishment ---------------------------------------------------------

export interface PartyEstablishmentFacts {
  readonly entityType: string;
  readonly bases: readonly PartyBasis[];
}

export interface PartyEstablishment {
  /** The record's type is a Party type. Says nothing about whether it is canonical. */
  readonly partyTyped: boolean;
  /** A governed basis establishes this record as canonical Party identity. */
  readonly established: boolean;
  /** The first governed basis found, in `PARTY_CONFIRMING_METHODS` order. */
  readonly basis: PartyConfirmingMethod | null;
}

export function partyEstablishment(facts: PartyEstablishmentFacts): PartyEstablishment {
  if (!isPartyType(facts.entityType)) {
    return { partyTyped: false, established: false, basis: null };
  }
  for (const method of PARTY_CONFIRMING_METHODS) {
    const governed = facts.bases.some((b) => b.method === method && isGovernedPartyBasis(b));
    if (governed) return { partyTyped: true, established: true, basis: method };
  }
  return { partyTyped: true, established: false, basis: null };
}

// --- Same-Party posture ----------------------------------------------------

export interface PartyLinkFacts {
  /** The stored `IdentityResolutionStatus`. */
  readonly status: string;
  readonly method: string;
  readonly provenance: PartyBasisProvenance;
}

/**
 * Posture across every link recorded between two Party records.
 *
 * A CONFIRMED link counts as CONFIRMED_SAME_PARTY only on a governed basis. A
 * CONFIRMED link without one is not erased or reclassified -- its stored status
 * stays exactly as written -- but the Party contract reads it as what it can
 * actually show: somebody thought these match.
 */
export function partyLinkPosture(links: readonly PartyLinkFacts[]): PartyResolutionPosture {
  const confirmed = links.filter((l) => l.status === 'CONFIRMED');
  if (confirmed.some((l) => isConfirmingMethod(l.method) && isGovernedPartyBasis(l))) {
    return 'CONFIRMED_SAME_PARTY';
  }
  if (confirmed.length > 0 || links.some((l) => l.status === 'PROPOSED')) {
    return 'POSSIBLE_MATCH';
  }
  return 'UNRESOLVED';
}
