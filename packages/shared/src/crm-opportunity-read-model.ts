// CRM Opportunities, as staff read them (CRM slice 4, 2026-10-06).
//
// A PROJECTION, NEVER AN AUTHORITY. Every value here is read from the authority that owns it:
//   - the Opportunity's own fields (`CrmOpportunity`) and its transition log;
//   - its Participants (`crm_participants`, the one participation table);
//   - its creator reference (`creatorPartyId`) and owner (`ownerUserId`);
//   - the Party Reference contract (who a Party is, and whether it is current);
// CRM Contact Points are NOT part of this model: a record page asks the Contact Point authority
// itself (`CrmContactPointService.listForParty`), which alone decides whether a value is revealed.
// Nothing is written, derived into a fact, guessed, or stored back.
//
// UNKNOWN STAYS UNKNOWN. No owner is `owner: null`; no BRAND is an empty list. A UI may say
// "Unassigned" or "No brand recorded", but that wording is presentation, never a value here.
//
// MANY IS NOT ONE. More than one active BRAND or PRIMARY_CONTACT is legal today, so both are
// lists. Nothing here picks a "primary" one.
//
// NAMES FOLLOW THE PARTY GATE. A Party's name is shown only to a viewer who may read Party
// records (`identityResolution:view`), the same rule People and Relationships use; otherwise
// `name` is null and `namesReadable` says why. Contact values never appear here at all.
//
// NO NOTE TEXT. `internalNotes` and transition notes are free text with no governed Opportunity-note
// authority, so this model carries only THAT a note was recorded.
//
// PURE. No clock, no I/O.

import type { PartyType } from './party';

export const CRM_OPPORTUNITY_READ_MODEL_VERSION = 'crm-opportunity-read-model.v1' as const;

export const CRM_OPPORTUNITY_LIST_DEFAULT_LIMIT = 25;
export const CRM_OPPORTUNITY_LIST_MAX_LIMIT = 100;

/** Clamp a requested page size. Non-numbers use the default. */
export function crmOpportunityListLimit(requested: unknown): number {
  if (typeof requested !== 'number' || !Number.isFinite(requested)) return CRM_OPPORTUNITY_LIST_DEFAULT_LIMIT;
  return Math.min(CRM_OPPORTUNITY_LIST_MAX_LIMIT, Math.max(1, Math.trunc(requested)));
}

export const CRM_OPPORTUNITY_CATEGORIES = ['OPEN', 'CLOSED_WON', 'CLOSED_LOST'] as const;
export type CrmOpportunityCategory = (typeof CRM_OPPORTUNITY_CATEGORIES)[number];

/** The longest search text accepted. Longer input is cut, never rejected. */
export const CRM_OPPORTUNITY_SEARCH_MAX = 100;

// --- References ----------------------------------------------------------------------

/**
 * A Party an Opportunity names, as the Party Reference contract resolved it. A superseded record
 * keeps the id it was written with and names the current one; a reference that cannot be
 * followed (another tenant's id, a broken chain) is UNAVAILABLE, never guessed.
 */
export type CrmOpportunityPartyRefV1 =
  | {
      readonly state: 'ESTABLISHED' | 'NOT_ESTABLISHED';
      readonly partyId: string;
      readonly partyType: PartyType;
      readonly archived: boolean;
      /** The Party's recorded name when the viewer may read names; otherwise null. */
      readonly name: string | null;
    }
  | {
      readonly state: 'SUPERSEDED';
      /** The id the Opportunity carries, exactly as written. */
      readonly partyId: string;
      readonly canonicalPartyId: string;
      readonly partyType: PartyType;
      readonly name: string | null;
    }
  | { readonly state: 'UNAVAILABLE'; readonly partyId: string; readonly name: null };

/** A member named on the record (owner, actor). Resolved only within the Opportunity's organization. */
export type CrmOpportunityUserRefV1 =
  | { readonly state: 'MEMBER'; readonly userId: string; readonly displayName: string | null }
  /** The id is recorded but no member of this organization has it. Never resolved elsewhere. */
  | { readonly state: 'UNAVAILABLE'; readonly userId: string; readonly displayName: null };

/** Missing context a person can see at a glance. Facts about absence, never a priority score. */
export const CRM_OPPORTUNITY_GAPS = ['NO_OWNER', 'NO_BRAND', 'NO_PRIMARY_CONTACT'] as const;
export type CrmOpportunityGap = (typeof CRM_OPPORTUNITY_GAPS)[number];

// --- List ------------------------------------------------------------------------------

export interface CrmOpportunityListItemV1 {
  readonly opportunityId: string;
  readonly title: string;
  readonly category: string;
  /** The organization's own stage label, exactly as recorded (a free string today). */
  readonly stage: string;
  readonly creator: CrmOpportunityPartyRefV1;
  /** The Creator Hub profile for this creator, when one exists in this organization. */
  readonly creatorProfileId: string | null;
  /** ACTIVE BRAND Participants only. Ended and voided ones are history, shown on the record. */
  readonly brands: readonly CrmOpportunityPartyRefV1[];
  /** ACTIVE PRIMARY_CONTACT Participants only. Never their contact values. */
  readonly primaryContacts: readonly CrmOpportunityPartyRefV1[];
  readonly owner: CrmOpportunityUserRefV1 | null;
  readonly gaps: readonly CrmOpportunityGap[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CrmOpportunityListFiltersV1 {
  /** Discovery text: title, an exact Opportunity id, and -- when names are readable -- creator, brand, contact or owner names. */
  readonly q?: string | null;
  /** 'ME', 'NONE' (unassigned) or a member's user id. */
  readonly owner?: string | null;
  readonly category?: string | null;
  readonly stage?: string | null;
  readonly creatorPartyId?: string | null;
  readonly brand?: 'PRESENT' | 'MISSING' | null;
  readonly primaryContact?: 'PRESENT' | 'MISSING' | null;
}

export interface CrmOpportunityListPageV1 {
  readonly contractVersion: typeof CRM_OPPORTUNITY_READ_MODEL_VERSION;
  readonly items: readonly CrmOpportunityListItemV1[];
  /** Opaque; null on the last page. Keyset over (createdAt, id), newest first. */
  readonly nextCursor: string | null;
  /** Whether Party names were readable to this viewer. When false, every `name` is null. */
  readonly namesReadable: boolean;
  /** The stage labels recorded in this organization, for the stage filter. */
  readonly stageOptions: readonly string[];
  /** The members who own at least one Opportunity here, for the owner filter. */
  readonly ownerOptions: readonly CrmOpportunityUserRefV1[];
}

// --- Record ----------------------------------------------------------------------------

export interface CrmOpportunityParticipantViewV1 {
  readonly participantId: string;
  readonly role: string;
  readonly party: CrmOpportunityPartyRefV1;
  readonly state: 'ACTIVE' | 'ENDED' | 'VOIDED';
  readonly addedAt: string;
  readonly addedBy: CrmOpportunityUserRefV1 | null;
  readonly endedAt: string | null;
  readonly voidedAt: string | null;
  /** THAT a reason was recorded, never its words (they can name a person). */
  readonly reasonRecorded: boolean;
}

export interface CrmOpportunityTransitionViewV1 {
  readonly sequence: number;
  readonly fromCategory: string | null;
  readonly fromStage: string | null;
  readonly toCategory: string;
  readonly toStage: string;
  readonly actor: CrmOpportunityUserRefV1 | null;
  readonly occurredAt: string;
  /** THAT a note was recorded on this move, never its words: no Opportunity-note authority exists yet. */
  readonly noteRecorded: boolean;
  readonly creatorVisible: boolean;
}

/**
 * Whether the Opportunity's `internalNotes` holds text -- never the text. It is one free-text field
 * with no author or history, and no governed Opportunity-note authority decides who may read it,
 * so this surface does not borrow another domain's grant to show it (Creator Hub keeps its own view).
 */
export type CrmOpportunityNotesV1 = { readonly state: 'RECORDED' } | { readonly state: 'EMPTY' };

export interface CrmOpportunityRecordV1 extends CrmOpportunityListItemV1 {
  readonly createdBy: CrmOpportunityUserRefV1 | null;
  readonly participants: readonly CrmOpportunityParticipantViewV1[];
  readonly transitions: readonly CrmOpportunityTransitionViewV1[];
  readonly forecast: {
    readonly probability: number | null;
    readonly authoredBy: CrmOpportunityUserRefV1 | null;
    readonly authoredAt: string | null;
    readonly amountMinor: number | null;
    readonly currency: string | null;
    readonly expectedCloseDate: string | null;
  };
  readonly outcome: string | null;
  readonly lossReason: string | null;
  readonly relationship: { readonly relationshipId: string; readonly kind: string } | null;
  readonly campaigns: readonly { readonly campaignId: string; readonly name: string; readonly state: string }[];
  /** What EMG designated a creator may see. Shown to staff as it stands; never changed here. */
  readonly creatorDesignation: {
    readonly creatorVisibleState: string | null;
    readonly brandVisibleToCreator: boolean;
    readonly summaryForCreator: string | null;
  };
  readonly notes: CrmOpportunityNotesV1;
}

/** What the viewer may do, from the PD-F-11 act table. A UI renders these; it never re-derives them. */
export interface CrmOpportunityCapabilitiesV1 {
  readonly changeOwner: boolean;
  readonly addParticipant: boolean;
  readonly endParticipant: boolean;
  readonly voidParticipant: boolean;
  readonly update: boolean;
}

/** Which of an item's facts are missing. Pure; the facts are already on the item. */
export function crmOpportunityGaps(item: {
  readonly owner: unknown | null;
  readonly brands: readonly unknown[];
  readonly primaryContacts: readonly unknown[];
}): CrmOpportunityGap[] {
  const gaps: CrmOpportunityGap[] = [];
  if (item.owner === null) gaps.push('NO_OWNER');
  if (item.brands.length === 0) gaps.push('NO_BRAND');
  if (item.primaryContacts.length === 0) gaps.push('NO_PRIMARY_CONTACT');
  return gaps;
}
