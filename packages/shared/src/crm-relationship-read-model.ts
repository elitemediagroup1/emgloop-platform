// What a reader may learn about a Relationship. Slice R3-A3, a pure contract.
//
// The write side (crm-relationship.ts) says what may be asserted. This says what a
// screen is given, and the two differ in one way that matters: a READ resolves a
// superseded Party forward and says so, while a WRITE refuses it. Both behaviours
// come from the one Party Reference contract, and neither rewrites a stored id.
//
// A PARTY REFERENCE IS REPORTED, NOT REPAIRED. Four things can be true of a side or
// a participant, and the view says which:
//   ESTABLISHED      the Party the record names, and it is current.
//   SUPERSEDED       the record still names the id it was written with; the reader is
//                    also told the canonical id. Nothing is rewritten, ever.
//   NOT_ESTABLISHED  a Party-typed record no governed basis has established. It
//                    happens -- an establishing user can be deleted -- and it is shown.
//   UNAVAILABLE      the chain cannot be followed safely: a cycle, more than eight
//                    hops, a change of Party type, or another organization. The
//                    Relationship stays readable with that side unavailable, and
//                    nothing is guessed.
//
// A DUPLICATE IS A DIAGNOSTIC, NEVER A MERGE. Two non-voided Relationships of one
// kind can end up resolving to the same canonical sides after a supersession. The
// database cannot see it, because the stored ids differ. So the read model reports
// it and a person decides -- by ending or voiding one, with a reason. Merging them
// automatically would be identity resolution performed by a list view.
//
// CAPABILITIES ARE SERVER-DECIDED. A view carries what this viewer may do, so a UI
// renders actions instead of re-deriving authorization rules it cannot be trusted
// with. Hiding a button is not authorization; every act is authorized again anyway.
//
// PURE. No clock, no I/O.

import type { PartyType } from './party';
import type { CrmParticipantRole, CrmParticipantRoleFamily, CrmParticipantState } from './crm-participant';
import type { CrmRelationshipSide, CrmRelationshipState, CrmRelationshipStructure } from './crm-relationship';

export const CRM_RELATIONSHIP_READ_MODEL_VERSION = 'crm-relationship-read-model.v1' as const;

/** A page of Relationships. Bounded, and never "everything". */
export const CRM_RELATIONSHIP_LIST_LIMIT_DEFAULT = 25;
export const CRM_RELATIONSHIP_LIST_LIMIT_MAX = 100;

export function crmRelationshipListLimit(requested?: number | null): number {
  if (typeof requested !== 'number' || !Number.isInteger(requested) || requested < 1) return CRM_RELATIONSHIP_LIST_LIMIT_DEFAULT;
  return Math.min(requested, CRM_RELATIONSHIP_LIST_LIMIT_MAX);
}

export const CRM_PARTY_REFERENCE_VIEW_STATES = ['ESTABLISHED', 'SUPERSEDED', 'NOT_ESTABLISHED', 'UNAVAILABLE'] as const;
export type CrmPartyReferenceViewState = (typeof CRM_PARTY_REFERENCE_VIEW_STATES)[number];

export type CrmPartyReferenceViewV1 =
  | { readonly state: 'ESTABLISHED'; readonly partyId: string; readonly partyType: PartyType; readonly archived: boolean }
  | {
      readonly state: 'SUPERSEDED';
      /** The id the record was written with. It is never rewritten. */
      readonly partyId: string;
      readonly canonicalPartyId: string;
      readonly partyType: PartyType;
      readonly canonicalArchived: boolean;
    }
  | { readonly state: 'NOT_ESTABLISHED'; readonly partyId: string; readonly partyType: PartyType; readonly archived: boolean }
  /** The stored id is kept so an operator can investigate; nothing about it is asserted. */
  | { readonly state: 'UNAVAILABLE'; readonly partyId: string };

/** The canonical id a reference points at, when it points at one that can be used. */
export function crmCanonicalPartyId(view: CrmPartyReferenceViewV1): string | null {
  if (view.state === 'ESTABLISHED') return view.partyId;
  if (view.state === 'SUPERSEDED') return view.canonicalPartyId;
  return null;
}

export interface CrmRelationshipSideViewV1 {
  readonly side: CrmRelationshipSide;
  /** How the side reads, from the governed kind definition. */
  readonly label: string;
  readonly party: CrmPartyReferenceViewV1;
  readonly role: CrmParticipantRole;
}

export interface CrmRelationshipParticipantViewV1 {
  readonly participantId: string;
  readonly party: CrmPartyReferenceViewV1;
  readonly role: CrmParticipantRole;
  readonly roleFamily: CrmParticipantRoleFamily;
  readonly side: CrmRelationshipSide | null;
  readonly actsForSide: CrmRelationshipSide | null;
  readonly state: CrmParticipantState;
  readonly effectiveFrom: string | null;
  readonly effectiveTo: string | null;
  /** That a reason was recorded, not the words: they can name a person. */
  readonly reasonRecorded: boolean;
}

export interface CrmRelationshipHistoryEntryV1 {
  readonly sequence: number;
  readonly type: string;
  readonly occurredAt: string;
  readonly occurredAtBasis: string;
  readonly recordedAt: string;
  readonly actorUserId: string | null;
  readonly participantId: string | null;
  readonly fromState: string | null;
  readonly toState: string | null;
  readonly reasonRecorded: boolean;
}

export interface CrmRelationshipListItemV1 {
  readonly relationshipId: string;
  readonly kind: string;
  readonly kindLabel: string;
  readonly structure: CrmRelationshipStructure;
  readonly state: CrmRelationshipState;
  readonly sides: readonly CrmRelationshipSideViewV1[];
  readonly label: string | null;
  readonly ownerUserId: string | null;
  readonly businessStartDate: string | null;
  readonly businessEndDate: string | null;
  readonly createdAt: string;
  readonly activeParticipantCount: number;
}

export interface CrmRelationshipListPageV1 {
  readonly contractVersion: typeof CRM_RELATIONSHIP_READ_MODEL_VERSION;
  readonly items: readonly CrmRelationshipListItemV1[];
  readonly nextCursor: string | null;
}

/** Another non-voided Relationship of the same kind resolving to the same canonical sides. */
export interface CrmRelationshipDuplicateV1 {
  readonly relationshipId: string;
  readonly state: CrmRelationshipState;
  readonly reason: 'SAME_CANONICAL_SIDES';
}

export interface CrmRelationshipRecordV1 extends CrmRelationshipListItemV1 {
  readonly description: string | null;
  readonly participants: readonly CrmRelationshipParticipantViewV1[];
  readonly history: readonly CrmRelationshipHistoryEntryV1[];
  /** Reported for a person to resolve. Never merged automatically. */
  readonly duplicates: readonly CrmRelationshipDuplicateV1[];
}

/**
 * What this viewer may do, decided by the server from the approved act table. A UI
 * renders these; it never re-derives them, and every act is authorized again when
 * it is performed.
 */
export interface CrmRelationshipCapabilitiesV1 {
  readonly create: boolean;
  readonly updateDetails: boolean;
  readonly addParticipant: boolean;
  readonly changeParticipant: boolean;
  readonly endRelationship: boolean;
  readonly reactivateRelationship: boolean;
  readonly endParticipant: boolean;
  readonly voidRelationship: boolean;
  readonly voidParticipant: boolean;
}

/**
 * Two Relationships are the same commercial connection when they are the same kind
 * and their sides resolve to the same canonical Parties. A side that cannot be
 * resolved makes them NOT comparable -- an unavailable chain is not evidence of
 * sameness, and treating it as such is how a diagnostic becomes a false accusation.
 */
export function crmRelationshipsResolveAlike(
  a: { kind: string; sides: readonly CrmRelationshipSideViewV1[] },
  b: { kind: string; sides: readonly CrmRelationshipSideViewV1[] },
): boolean {
  if (a.kind !== b.kind || a.sides.length !== b.sides.length || a.sides.length === 0) return false;
  const key = (sides: readonly CrmRelationshipSideViewV1[]): string | null => {
    const parts: string[] = [];
    for (const side of [...sides].sort((x, y) => (x.side < y.side ? -1 : 1))) {
      const canonical = crmCanonicalPartyId(side.party);
      if (canonical === null) return null;
      parts.push(`${side.side}:${canonical}`);
    }
    return parts.join('|');
  };
  const ka = key(a.sides);
  const kb = key(b.sides);
  return ka !== null && ka === kb;
}
