// Party Reference -- how every other domain points at a Party, and what it may learn.
//
// Identity Slice 2.0b, a pure contract. The decision record is
// docs/architecture/identity-evidence-resolution.md, section 12. Relationship,
// Participant, Opportunity, Campaign and UI composition refer to a Party only
// through this contract.
//
// BY ID, INSIDE ONE ORGANIZATION, AND NOTHING ELSE. A reference is
// (organizationId, partyId). There is no lookup by name, email, phone, canonical
// key or evidence value. A reference to a record in another organization, to an
// unknown id or to something that is not a Party is NOT_FOUND, and the three are
// indistinguishable: no tenant learns from a reference that a Party exists
// somewhere it cannot see.
//
// FOUR STATES.
//   ESTABLISHED      canonical identity.
//   NOT_ESTABLISHED  a Party-typed record no governed basis has established.
//   SUPERSEDED       found to be the same Party as another. Reads resolve forward
//                    to the canonical record. Nothing that points at the
//                    superseded record is rewritten.
//   NOT_FOUND        missing, another organization's, not a Party, or a
//                    supersession chain that cannot be followed safely (a cycle,
//                    a chain deeper than PARTY_REFERENCE_MAX_DEPTH, a change of
//                    Party type, or a link out of the organization).
//
// WRITES REFERENCE ESTABLISHED PARTIES ONLY. A new reference names an
// ESTABLISHED, non-superseded, non-archived Party:
//   - Participant never references an unestablished Party.
//   - A superseded id is refused with its canonical id, not silently swapped,
//     so the writer chooses.
//   - An archived Party stays readable but takes no new references, as
//     `PartyService` refuses to establish one.
//
// REFERENCING GRANTS NOTHING. Resolving a reference never creates, establishes,
// links or supersedes a Party, and never reads evidence to decide anything.
//
// A CAPACITY IS NOT A PARTY TYPE. A Party holds a capacity in a context, for a
// time. The set is Product's approved commercial capacities (PD-F-03, 2026-09-15);
// where a capacity is held, and which Party types may hold it, is the CRM
// Participant contract (`crm-participant.ts`). A capacity never decides Party type,
// a Party type never implies a capacity, and resolution never consults one.
//
// PURE. No clock, no I/O. The repository loads one record at a time and asks
// `partyReferenceStep` what to do next, so the walk has exactly one definition.

import type { PartyType } from './party';

export const PARTY_REFERENCE_STATES = ['ESTABLISHED', 'NOT_ESTABLISHED', 'SUPERSEDED', 'NOT_FOUND'] as const;
export type PartyReferenceState = (typeof PARTY_REFERENCE_STATES)[number];

/** Supersession hops a read follows before failing closed. */
export const PARTY_REFERENCE_MAX_DEPTH = 8;

export interface PartyReference {
  readonly organizationId: string;
  readonly partyId: string;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Fails closed: both parts must be non-blank strings. */
export function isPartyReference(value: unknown): value is PartyReference {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as { organizationId?: unknown; partyId?: unknown };
  return nonEmpty(v.organizationId) && nonEmpty(v.partyId);
}

/**
 * One Party record as the organization-scoped reader sees it. The loader returns
 * null for a miss of any kind, so the kind of miss never reaches this contract.
 */
export interface PartyReferenceNode {
  readonly id: string;
  readonly partyType: PartyType;
  readonly established: boolean;
  readonly archived: boolean;
  readonly supersededByPartyId: string | null;
}

export type PartyReferenceResolution =
  | {
      readonly state: 'ESTABLISHED' | 'NOT_ESTABLISHED';
      readonly partyId: string;
      readonly partyType: PartyType;
      readonly archived: boolean;
    }
  | {
      readonly state: 'SUPERSEDED';
      /** The id that was asked for. */
      readonly partyId: string;
      readonly canonicalPartyId: string;
      readonly partyType: PartyType;
      readonly canonicalEstablished: boolean;
      readonly canonicalArchived: boolean;
    }
  | { readonly state: 'NOT_FOUND' };

export const PARTY_REFERENCE_NOT_FOUND: PartyReferenceResolution = Object.freeze({ state: 'NOT_FOUND' });

export type PartyReferenceStep =
  | { readonly resolved: PartyReferenceResolution }
  | { readonly next: string };

/**
 * One step of the walk.
 * @param requestedId the id the reference names.
 * @param walked the records already followed, starting with the requested one.
 * @param node the record just loaded for the requested id, or for the last
 *   walked record's `supersededByPartyId`.
 */
export function partyReferenceStep(
  requestedId: string,
  walked: readonly PartyReferenceNode[],
  node: PartyReferenceNode | null,
): PartyReferenceStep {
  const notFound = { resolved: PARTY_REFERENCE_NOT_FOUND };
  if (node === null || !nonEmpty(node.id)) return notFound;

  const first = walked[0];
  if (first === undefined) {
    if (node.id !== requestedId) return notFound;
  } else {
    const previous = walked[walked.length - 1];
    if (previous === undefined || previous.supersededByPartyId !== node.id) return notFound;
    // Same-Party supersession never changes what kind of Party it is.
    if (node.partyType !== first.partyType) return notFound;
  }

  if (node.supersededByPartyId === null) {
    if (first === undefined) {
      return {
        resolved: {
          state: node.established ? 'ESTABLISHED' : 'NOT_ESTABLISHED',
          partyId: node.id,
          partyType: node.partyType,
          archived: node.archived,
        },
      };
    }
    return {
      resolved: {
        state: 'SUPERSEDED',
        partyId: first.id,
        canonicalPartyId: node.id,
        partyType: node.partyType,
        canonicalEstablished: node.established,
        canonicalArchived: node.archived,
      },
    };
  }

  const next = node.supersededByPartyId;
  if (!nonEmpty(next)) return notFound;
  if (next === node.id || walked.some((w) => w.id === next)) return notFound;
  if (walked.length + 1 > PARTY_REFERENCE_MAX_DEPTH) return notFound;
  return { next };
}

/** Whether a new reference may be written to the resolved Party. */
export function partyReferenceWritable(resolution: PartyReferenceResolution): boolean {
  return resolution.state === 'ESTABLISHED' && resolution.archived === false;
}

export const PARTY_WRITE_REFUSALS = ['NOT_FOUND', 'NOT_ESTABLISHED', 'SUPERSEDED', 'ARCHIVED'] as const;
export type PartyWriteRefusal = (typeof PARTY_WRITE_REFUSALS)[number];

export type PartyReferenceForWrite =
  | { readonly ok: true; readonly partyId: string; readonly partyType: PartyType }
  | {
      readonly ok: false;
      readonly refusal: PartyWriteRefusal;
      /**
       * Present only for SUPERSEDED: the id the writer may retry with, having
       * decided to. Naming it is not using it.
       */
      readonly canonicalPartyId?: string;
    };

/**
 * What a writer may do with a resolved reference. REFUSAL, NEVER SUBSTITUTION: a
 * superseded id comes back refused, carrying its canonical id so the caller can
 * retry explicitly (approved reading, 2026-09-15). An archived or unestablished
 * Party takes no new reference. Writability itself stays defined in exactly one
 * place, `partyReferenceWritable`, so this classifies a refusal and never widens
 * what is allowed.
 */
export function partyReferenceForWrite(resolution: PartyReferenceResolution): PartyReferenceForWrite {
  if (partyReferenceWritable(resolution) && resolution.state === 'ESTABLISHED') {
    return { ok: true, partyId: resolution.partyId, partyType: resolution.partyType };
  }
  if (resolution.state === 'SUPERSEDED') {
    return { ok: false, refusal: 'SUPERSEDED', canonicalPartyId: resolution.canonicalPartyId };
  }
  if (resolution.state === 'NOT_ESTABLISHED') return { ok: false, refusal: 'NOT_ESTABLISHED' };
  if (resolution.state === 'ESTABLISHED') return { ok: false, refusal: 'ARCHIVED' };
  return { ok: false, refusal: 'NOT_FOUND' };
}

// --- Capacity --------------------------------------------------------------------

/**
 * The commercial capacities a Party may hold in a context (PD-F-03). Deliberately
 * not `party.ts`'s CONTEXTUAL_ROLE_ENTITY_TYPES: that list states which cognitive
 * entity types are not Party types, and a capacity vocabulary must not be tied to
 * a Prisma enum's names.
 */
export const PARTY_CAPACITIES = [
  'CREATOR',
  'EMPLOYEE',
  'BRAND',
  'AGENCY',
  'PUBLISHER',
  'BUYER',
  'VENDOR',
  'SOURCE',
  'PARTNER',
] as const;
export type PartyCapacity = (typeof PARTY_CAPACITIES)[number];

export function isPartyCapacity(value: unknown): value is PartyCapacity {
  return typeof value === 'string' && (PARTY_CAPACITIES as readonly string[]).includes(value);
}
