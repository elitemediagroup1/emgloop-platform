// Party read models -- what People, Companies and a Party record show, and what they refuse to.
//
// Identity slice P1 (docs/architecture/relationship-participant.md §10,
// docs/product/foundation-handoff.md §2.1-2.2). A pure contract: the shapes the UI
// designs against, served by `PartyReadModelRepository` and authorized by
// `PartyRecordService`.
//
// PEOPLE ARE IDENTIFIED PARTIES, NOTHING ELSE. People lists established,
// non-superseded, non-archived PERSON Parties; Companies the same for COMPANY
// (C-04). An Intake Record (legacy Customer) is never in either list, an
// unestablished Party record is only in the establishment review queue, and a
// Company is never the tenant Workspace Organization. Zero is a correct answer.
//
// IDENTITY POSTURE, NEVER A NUMBER (C-05, identity record §11a). The posture says
// whether the record is established and on what basis, whether any same-Party
// link exists, and what Loop cannot yet know. Evidence tiers are NOT_AVAILABLE
// until identity evidence is collected (slices 2.1b-2.3); that is stated, not
// hidden.
//
// NO CONTACT VALUES. No phone, email or address is part of a Party read model:
// contact points have no authority yet (PD-F-05). A UI may show contact data only
// from a linked Intake Record, labeled as Intake-derived.
//
// ACTIONS ARE SERVER-DECIDED. `capabilities` tells the UI what the viewer may do;
// every act is authorized again, server-side, when it is attempted.
//
// PURE. No clock, no I/O.

import { type PartyConfirmingMethod, type PartyResolutionPosture, type PartyType } from './party';

export const PARTY_READ_MODEL_VERSION = 'party-read-model.v1' as const;

export const PARTY_LIST_DEFAULT_LIMIT = 25;
export const PARTY_LIST_MAX_LIMIT = 100;

/** Clamp a requested page size into the allowed range. Non-numbers use the default. */
export function partyListLimit(requested: unknown): number {
  if (typeof requested !== 'number' || !Number.isFinite(requested)) return PARTY_LIST_DEFAULT_LIMIT;
  return Math.min(PARTY_LIST_MAX_LIMIT, Math.max(1, Math.trunc(requested)));
}

export interface UserRefV1 {
  readonly userId: string;
  /** The member's display name in this organization, or null when it cannot be shown. */
  readonly displayName: string | null;
}

export interface PartyEstablishmentViewV1 {
  readonly established: boolean;
  readonly basis: PartyConfirmingMethod | null;
  readonly establishedAt: string | null;
  readonly establishedBy: UserRefV1 | null;
}

/** What Loop cannot yet say about a Party, stated rather than implied. */
export const PARTY_POSTURE_LIMITATIONS = [
  /** No identity evidence is collected yet (identity slices 2.1b-2.3). */
  'EVIDENCE_NOT_COLLECTED',
  /** No contact value has a recorded verification; verification is not built. */
  'VERIFICATION_NOT_AVAILABLE',
] as const;
export type PartyPostureLimitation = (typeof PARTY_POSTURE_LIMITATIONS)[number];

export interface PartyIdentityPostureV1 {
  readonly establishment: 'ESTABLISHED' | 'NOT_ESTABLISHED';
  readonly basis: PartyConfirmingMethod | null;
  /** Across every recorded link touching this Party; UNRESOLVED when there are none. */
  readonly sameParty: PartyResolutionPosture;
  /** Identity evidence tiers exist only once evidence is collected. */
  readonly evidenceTier: 'NOT_AVAILABLE';
  readonly limitations: readonly PartyPostureLimitation[];
}

export interface PartyListItemV1 {
  readonly contractVersion: typeof PARTY_READ_MODEL_VERSION;
  readonly partyId: string;
  readonly partyType: PartyType;
  readonly displayName: string | null;
  readonly establishment: PartyEstablishmentViewV1;
  readonly createdAt: string;
}

export interface PartyListPageV1 {
  readonly items: readonly PartyListItemV1[];
  /** Opaque; pass back to get the next page. Null on the last page. */
  readonly nextCursor: string | null;
}

export interface LinkedIntakeRecordRefV1 {
  readonly linkId: string;
  /** The Intake Record (legacy Customer). Its own read model is the only source of its contents. */
  readonly customerId: string;
  readonly state: 'ACTIVE' | 'REVERSED';
  readonly basis: string;
  readonly linkedAt: string;
  readonly linkedBy: UserRefV1 | null;
  readonly reversedAt: string | null;
  readonly reversedBy: UserRefV1 | null;
  readonly reversalReason: string | null;
}

export interface PartyRecordV1 {
  readonly contractVersion: typeof PARTY_READ_MODEL_VERSION;
  readonly partyId: string;
  readonly partyType: PartyType;
  readonly displayName: string | null;
  /** SUPERSEDED names the current record; the UI links to it rather than substituting it. */
  readonly reference:
    | { readonly state: 'ESTABLISHED' | 'NOT_ESTABLISHED'; readonly canonicalPartyId: null }
    | { readonly state: 'SUPERSEDED'; readonly canonicalPartyId: string };
  readonly archived: boolean;
  readonly establishment: PartyEstablishmentViewV1;
  readonly posture: PartyIdentityPostureV1;
  /** Newest first: active links, then reversed history. */
  readonly linkedIntakeRecords: readonly LinkedIntakeRecordRefV1[];
  readonly createdAt: string;
}

export interface PartyViewerCapabilitiesV1 {
  /** identityResolution:create. */
  readonly createParty: boolean;
  /** identityResolution:approve. */
  readonly establishParty: boolean;
}
