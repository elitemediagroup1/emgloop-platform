// CRM Participant -- the contextual role a Party holds within a CRM subject.
//
// Slice R1 (docs/architecture/relationship-participant.md §5-6; PD-F-03, PD-F-04).
// One CRM Participant authority for every CRM subject: a Relationship now, an
// Opportunity or Campaign when those authorities exist. Activity participants
// (who was on a call) are NOT Participants -- they come from source authorities
// and governed attribution. `CaseParticipant`, Work assignment and Decision owners
// are User participation, not Party participation. Nothing here reads or writes
// the dormant `IdentityRole`.
//
// A ROLE IS CONTEXTUAL, NEVER A PARTY TYPE. Commercial capacities (Brand, Agency,
// Creator…) and engagement roles (primary contact…) are held by an established
// Party, in one subject, for a time. A role may CONSTRAIN which Party types may
// hold it; it never DETERMINES a Party's type, and a Party type never implies a
// role. One Party may hold several roles in the same subject.
//
// ON A RELATIONSHIP, a Participant either IS a side (it fills a side the kind
// declares) or ACTS FOR a side. Engagement roles only ever act for a side.
//
// A PARTICIPANT IS NEVER A CREDENTIAL. It grants no access in this release.
//
// PURE. No clock, no I/O.

import type { PartyType } from './party';
import { PARTY_CAPACITIES, type PartyCapacity } from './party-reference';
import { CRM_RELATIONSHIP_ACTS, crmRelationshipKind, type CrmRelationshipAct, type CrmRelationshipSide } from './crm-relationship';

export const CRM_PARTICIPANT_SUBJECT_KINDS = ['RELATIONSHIP'] as const;
export type CrmParticipantSubjectKind = (typeof CRM_PARTICIPANT_SUBJECT_KINDS)[number];

/** Subjects named for the future; a Participant cannot reference them until their authority exists. */
export const CRM_PARTICIPANT_RESERVED_SUBJECT_KINDS = ['OPPORTUNITY', 'CAMPAIGN'] as const;

export const CRM_PARTICIPANT_ENGAGEMENT_ROLES = ['PRIMARY_CONTACT', 'DECISION_MAKER', 'BILLING_CONTACT'] as const;
export type CrmParticipantEngagementRole = (typeof CRM_PARTICIPANT_ENGAGEMENT_ROLES)[number];

export type CrmParticipantRole = PartyCapacity | CrmParticipantEngagementRole;
export type CrmParticipantRoleFamily = 'CAPACITY' | 'ENGAGEMENT';

export interface CrmParticipantRoleDefinition {
  readonly role: CrmParticipantRole;
  readonly family: CrmParticipantRoleFamily;
  /** The Party types that may hold the role. A constraint, never a classification. */
  readonly partyTypes: readonly PartyType[];
}

const PERSON_ONLY_CAPACITIES: readonly PartyCapacity[] = ['CREATOR', 'EMPLOYEE'];

export const CRM_PARTICIPANT_ROLE_DEFINITIONS: readonly CrmParticipantRoleDefinition[] = Object.freeze([
  ...PARTY_CAPACITIES.map((role) =>
    Object.freeze({
      role,
      family: 'CAPACITY' as const,
      partyTypes: Object.freeze(PERSON_ONLY_CAPACITIES.includes(role) ? (['PERSON'] as PartyType[]) : (['PERSON', 'COMPANY'] as PartyType[])),
    }),
  ),
  ...CRM_PARTICIPANT_ENGAGEMENT_ROLES.map((role) =>
    Object.freeze({ role, family: 'ENGAGEMENT' as const, partyTypes: Object.freeze(['PERSON'] as PartyType[]) }),
  ),
]);

export const CRM_PARTICIPANT_ROLES: readonly CrmParticipantRole[] = Object.freeze(
  CRM_PARTICIPANT_ROLE_DEFINITIONS.map((r) => r.role),
);

export function crmParticipantRole(role: unknown): CrmParticipantRoleDefinition | null {
  return CRM_PARTICIPANT_ROLE_DEFINITIONS.find((r) => r.role === role) ?? null;
}

export const CRM_PARTICIPANT_STATES = ['ACTIVE', 'ENDED', 'VOIDED'] as const;
export type CrmParticipantState = (typeof CRM_PARTICIPANT_STATES)[number];

export interface CrmParticipantAssertion {
  readonly subjectKind: string;
  /** For a Relationship subject: its kind. */
  readonly relationshipKind: string | null;
  readonly role: string;
  readonly partyType: PartyType;
  /** The side this Participant fills, or null. */
  readonly side: CrmRelationshipSide | null;
  /** The side this Participant acts for, or null. */
  readonly actsForSide: CrmRelationshipSide | null;
}

export const CRM_PARTICIPANT_VIOLATIONS = [
  'SUBJECT_KIND_NOT_AVAILABLE',
  'UNKNOWN_ROLE',
  'PARTY_TYPE_NOT_PERMITTED_FOR_ROLE',
  'UNKNOWN_RELATIONSHIP_KIND',
  'SIDE_NOT_IN_KIND',
  'PARTY_TYPE_NOT_PERMITTED_FOR_SIDE',
  'ENGAGEMENT_ROLE_CANNOT_BE_A_SIDE',
  'MUST_BE_OR_ACT_FOR_A_SIDE',
  'BOTH_SIDE_AND_ACTS_FOR',
] as const;
export type CrmParticipantViolation = (typeof CRM_PARTICIPANT_VIOLATIONS)[number];

/**
 * What is wrong with a Participant assertion. The Party has already been resolved
 * through the Party Reference contract (established, current, same organization);
 * this checks only role, type and side.
 */
export function validateCrmParticipant(a: CrmParticipantAssertion): CrmParticipantViolation[] {
  const out: CrmParticipantViolation[] = [];
  if (!(CRM_PARTICIPANT_SUBJECT_KINDS as readonly string[]).includes(a.subjectKind)) return ['SUBJECT_KIND_NOT_AVAILABLE'];
  const role = crmParticipantRole(a.role);
  if (!role) out.push('UNKNOWN_ROLE');
  else if (!role.partyTypes.includes(a.partyType)) out.push('PARTY_TYPE_NOT_PERMITTED_FOR_ROLE');

  const kind = crmRelationshipKind(a.relationshipKind);
  if (!kind) return [...out, 'UNKNOWN_RELATIONSHIP_KIND'];
  if (a.side !== null && a.actsForSide !== null) out.push('BOTH_SIDE_AND_ACTS_FOR');
  if (a.side === null && a.actsForSide === null) out.push('MUST_BE_OR_ACT_FOR_A_SIDE');
  const named = a.side ?? a.actsForSide;
  if (named !== null && !kind.sides.some((s) => s.side === named)) out.push('SIDE_NOT_IN_KIND');
  if (a.side !== null) {
    if (role?.family === 'ENGAGEMENT') out.push('ENGAGEMENT_ROLE_CANNOT_BE_A_SIDE');
    const sideDef = kind.sides.find((s) => s.side === a.side);
    if (sideDef && !sideDef.partyTypes.includes(a.partyType)) out.push('PARTY_TYPE_NOT_PERMITTED_FOR_SIDE');
  }
  return out;
}

/**
 * Acts a Participant that FILLS a side may not undergo on its own. A side Party is
 * immutable after creation (section 3.3) and a Relationship without its side is not a
 * fact, so a wrong side is corrected by voiding the Relationship and creating it
 * again. Participants that merely act for a side end and void normally.
 */
export const CRM_PARTICIPANT_SIDE_FORBIDDEN_ACTS: readonly CrmRelationshipAct[] = Object.freeze([
  'END_PARTICIPANT',
  'VOID_PARTICIPANT',
]);

/** Fails closed: an act nobody named is not available to a side Participant. */
export function crmParticipantSideActAllowed(act: string): boolean {
  if ((CRM_PARTICIPANT_SIDE_FORBIDDEN_ACTS as readonly string[]).includes(act)) return false;
  return (CRM_RELATIONSHIP_ACTS as readonly string[]).includes(act);
}

/** At most one ACTIVE Participant per subject, Party and role. The active-key column holds this; null otherwise. */
export function crmParticipantActiveKey(
  subjectKind: CrmParticipantSubjectKind,
  subjectId: string,
  partyId: string,
  role: CrmParticipantRole,
  state: CrmParticipantState,
): string | null {
  return state === 'ACTIVE' ? `${subjectKind}:${subjectId}:${partyId}:${role}` : null;
}
